"""Terminal guidance: 3D ZEM/APN with gravity compensation and a soft FOV limit.

Law
---
    t_go = max(R / Vc, t_go_min)
    ZEM  = rho + v_rel * t_go + 0.5 * a_T * t_go^2
    a    = N * ZEM_perp / t_go^2 - g_perp

- ZEM reduces to classic proportional navigation for a non-manoeuvring
  target; the target-acceleration term makes it augmented PN (APN), which is
  the optimal linear law for a constant-manoeuvring target.
- a_T is estimated by finite-differencing the tracked target velocity and
  low-pass filtering it.
- Only the gravity component normal to the velocity is compensated: the
  command is aerodynamic acceleration, and lift cannot act along the body axis.
- The navigation solution is delayed by NAV_DELAY; it is extrapolated to the
  current guidance tick before use, removing the range/velocity time skew.
- A seeker-FOV guard only acts near the FOV edge; no separate sliding-mode or
  blind-range switching term is used, so the PN command is not fought by a
  second law.

Ref: ZEM/APN survey (Evduzen, 2026); APN form from standard PN literature.
"""

import numpy as np
import config as C
import math_utils as MU
from guidance.base_guidance import BaseGuidance
from config import GuidanceCommand


class TerminalGuidance(BaseGuidance):
    name = "terminal"

    def __init__(self, n=4.0, n_max_g=40.0, fov_margin=0.80,
                 fov_gain=2.0, tau_at=C.TERMINAL_AT_TAU, alpha=0.75,
                 t_go_min=0.05):
        self.n = float(n)
        self.n_max_g = float(n_max_g)
        self.fov_margin = float(fov_margin)
        self.fov_gain = float(fov_gain)
        self.tau_at = float(tau_at)
        self.alpha = float(alpha)
        self.t_go_min = float(t_go_min)
        self.a_prev = np.zeros(3)
        self.a_T = np.zeros(3)
        self.t_prev = None
        self.v_t_prev = None

    def reset(self):
        self.a_prev = np.zeros(3)
        self.a_T = np.zeros(3)
        self.t_prev = None
        self.v_t_prev = None

    # --------------------------------------------------------
    def _target_acceleration(self, t, v_t):
        """Target acceleration estimate: bounded finite difference + LPF.

        The tracker already propagates the level-flight baseline, so the
        difference measures the manoeuvre itself.  The raw difference of a
        noisy estimate can still spike by tens of g, so it is smoothed over a
        manoeuvre-scale window and clamped before entering the APN feed-forward.
        """
        if self.t_prev is not None:
            dt = max(float(t) - self.t_prev, 1e-4)
            raw = (v_t - self.v_t_prev) / dt
            w = min(dt / max(self.tau_at, 1e-6), 1.0)
            self.a_T = self.a_T + w * (raw - self.a_T)
        self.a_T = MU.clip_norm(self.a_T, C.TERMINAL_AT_MAX_G * C.G0)
        self.t_prev = float(t)
        self.v_t_prev = np.asarray(v_t, dtype=float).copy()
        return self.a_T

    # --------------------------------------------------------
    def compute(self, t, nav, target_state, q=None, seeker=None):
        # Time-align the delayed navigation estimate with the current tick.
        # Both position and velocity are propagated, using the last guidance
        # command plus gravity as the inertial acceleration estimate, so the
        # 50 ms transport delay does not show up as a range/velocity skew.
        dt_nav = max(float(t) - float(nav.timestamp), 0.0)
        r_nav = np.asarray(nav.r_eci, dtype=float)
        v_nav = np.asarray(nav.v_eci, dtype=float)
        a_est = MU.clip_norm(self.a_prev + MU.gravity_eci(r_nav),
                             30.0 * C.G0)
        r = r_nav + v_nav * dt_nav + 0.5 * a_est * dt_nav * dt_nav
        v = v_nav + a_est * dt_nav
        r_t = self.target_position(target_state)
        v_t = self.target_velocity(target_state)

        # Seeker-direct relative geometry: once locked, the seeker supplies
        # the target bearing/range/range-rate at the current tick, so the
        # 50 ms navigation transport delay no longer corrupts the relative
        # state.  It is used only when it agrees with the fused track, which
        # rejects a residual false lock.
        if (seeker is not None and getattr(seeker, "is_locked", False)
                and float(seeker.range) > C.SEEKER_BLIND_RANGE):
            u_s = MU.normalize(np.asarray(seeker.los_angle, dtype=float))
            R_s = float(seeker.range)
            r_t_s = r + R_s * u_s
            err = MU.norm3(r_t_s - r_t)
            tol = max(C.TERMINAL_SEEKER_MIN_ERROR,
                      C.TERMINAL_SEEKER_CONSISTENCY * R_s)
            if err <= tol:
                # Use the fresh seeker position, but keep the filtered tracker
                # velocity: R * LOS-rate is dominated by angle noise (kilometres
                # per second at 20+ km), so reconstructing velocity from it
                # saturates the fins.  Only the low-noise range-rate is applied
                # along the LOS to correct the closing speed.
                v_rel_track = v_t - v
                rr = float(seeker.range_rate)
                if np.isfinite(rr):
                    v_t = v_t + (rr - float(np.dot(v_rel_track, u_s))) * u_s
                r_t = r_t_s

        # Aim at the engine/heat source rather than the geometric centre; the
        # offset is small but it shapes the final approach angle.
        if C.TERMINAL_AIMPOINT_OFFSET > 0.0 and MU.norm3(v_t) > 1.0:
            r_t = r_t - C.TERMINAL_AIMPOINT_OFFSET * MU.normalize(v_t)

        a_T = self._target_acceleration(t, v_t)

        geo = MU.los_geometry(r, v, r_t, v_t)
        R = geo["range"]
        u = geo["u"]
        v_rel = geo["v_rel"]
        vc = max(-geo["range_rate"], 50.0)
        t_go = max(R / vc, self.t_go_min)

        # Zero-effort miss with the APN target-acceleration feed-forward.
        zem = geo["rho"] + v_rel * t_go + 0.5 * a_T * t_go * t_go
        # Adaptive navigation constant: the finite-horizon optimal gain grows
        # as t_go shrinks (a constant N is optimal only for an infinite
        # horizon).  The boost is bounded so the endgame stays inside the
        # fin authority.
        n_eff = self.n
        if C.TERMINAL_PN_BOOST > 0.0:
            ramp = float(np.clip(1.0 - t_go / max(C.TERMINAL_PN_TGO_REF, 1e-3),
                                 0.0, 1.0))
            n_eff = max(C.TERMINAL_PN_MIN,
                        self.n * (1.0 + C.TERMINAL_PN_BOOST * ramp))
        a_cmd = n_eff * MU.perpendicular(zem, u) / (t_go * t_go)

        # Soft FOV guard: extrapolate the off-boresight angle over the predict
        # horizon and start correcting before the target actually reaches the
        # edge, instead of reacting only once it is already there.
        if seeker is not None and q is not None:
            # The LOS-rate measurement is very noisy in linear units at long
            # range, so cap both the prediction rate and the guard authority;
            # otherwise this term alone commands tens of g.
            rate = min(MU.norm3(np.asarray(seeker.los_rate, dtype=float)),
                       C.TERMINAL_FOV_RATE_MAX)
            fov_pred = float(seeker.fov_angle) + rate * C.TERMINAL_FOV_PREDICT
            if fov_pred > self.fov_margin * C.SEEKER_FOV:
                excess = min((fov_pred - self.fov_margin * C.SEEKER_FOV)
                             / max((1.0 - self.fov_margin) * C.SEEKER_FOV,
                                   1e-6), 1.0)
                guard = min(self.fov_gain * (1.0 + excess) * vc,
                            C.TERMINAL_FOV_ACC_MAX)
                v_hat = MU.normalize(v)
                a_cmd = a_cmd + guard * MU.perpendicular(u, v_hat)

        # Gravity compensation, normal to the velocity only.
        a_cmd = a_cmd - MU.perpendicular(MU.gravity_eci(r), MU.normalize(v))

        # Light smoothing; the autopilot already has a 5 Hz pre-filter.
        a_cmd = self.alpha * a_cmd + (1.0 - self.alpha) * self.a_prev
        self.a_prev = a_cmd.copy()

        a_cmd = MU.clip_norm(a_cmd, self.n_max_g * C.G0)
        return GuidanceCommand(a_cmd_eci=a_cmd, phase="terminal")
