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

The shared pipeline (``_aligned_state`` / ``compute``) is also used by the
classical pure-PN baseline in ``guidance/pure_pn_guidance.py``; only the
acceleration law (``_command_accel``) differs, which keeps a guidance-law
comparison free of implementation confounds.

Ref: ZEM/APN survey (Evduzen, 2026); APN form from standard PN literature.
"""

import math
import numpy as np
import config as C
import math_utils as MU
from guidance.base_guidance import BaseGuidance
from config import GuidanceCommand


class TerminalGuidance(BaseGuidance):
    name = "terminal"

    def __init__(self, n=4.0, n_max_g=C.MAX_LOAD_TERMINAL_G, fov_margin=0.80,
                 fov_gain=2.0, tau_at=C.TERMINAL_AT_TAU, alpha=0.60,
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
    def _target_acceleration(self, t, v_t, target_acc=None):
        """Target acceleration estimate: light smoothing for KF state, LPF for FD.

        When the Singer tracker supplies ``target_acc`` it is already optimally
        filtered; applying a heavy 0.25 s secondary LPF on top adds severe
        phase lag during 0.25 Hz weaves and degrades APN below pure PN.  Only a
        light 40 ms guard filter is applied to KF acceleration.
        """
        if self.t_prev is not None:
            dt = max(float(t) - self.t_prev, 1e-4)
            if target_acc is not None:
                tau_eff = min(self.tau_at, 0.04)
                raw = np.asarray(target_acc, dtype=float).reshape(3)
            else:
                tau_eff = self.tau_at
                raw = (v_t - self.v_t_prev) / dt
            w = min(dt / max(tau_eff, 1e-6), 1.0)
            self.a_T = self.a_T + w * (raw - self.a_T)
        elif target_acc is not None:
            self.a_T = np.asarray(target_acc, dtype=float).reshape(3).copy()
        self.a_T = MU.clip_norm(self.a_T, C.TERMINAL_AT_MAX_G * C.G0)
        self.t_prev = float(t)
        self.v_t_prev = np.asarray(v_t, dtype=float).copy()
        return self.a_T

    # --------------------------------------------------------
    def _aligned_state(self, t, nav, target_state, seeker, target_acc=None):
        """Time-align nav/seeker and return ``(r, v, r_t, v_t, a_T)``.

        Shared by every terminal law so the comparison between laws only
        changes the acceleration law, not the sensor/time-alignment pipeline.
        """
        # Time-align the delayed navigation estimate with the current tick.
        dt_nav = max(float(t) - float(nav.timestamp), 0.0)
        r_nav = np.asarray(nav.r_eci, dtype=float)
        v_nav = np.asarray(nav.v_eci, dtype=float)
        a_est = MU.clip_norm(self.a_prev + MU.gravity_eci(r_nav),
                             30.0 * C.G0)
        r = r_nav + v_nav * dt_nav + 0.5 * a_est * dt_nav * dt_nav
        v = v_nav + a_est * dt_nav
        r_t = self.target_position(target_state)
        v_t = self.target_velocity(target_state)

        # Range-gated seeker blending: at longer ranges (> 1.5 km) blend fresh
        # seeker geometry when it agrees with the tracker; inside 1.5 km trust
        # the Singer+Doppler Kalman track instead of injecting raw target glint
        # directly into ZEM / t_go^2.
        if (seeker is not None and getattr(seeker, "is_locked", False)
                and float(seeker.range) > C.SEEKER_BLIND_RANGE):
            u_s = MU.normalize(np.asarray(seeker.los_angle, dtype=float))
            R_s = float(seeker.range)
            r_t_s = r + R_s * u_s
            err = MU.norm3(r_t_s - r_t)
            tol = max(C.TERMINAL_SEEKER_MIN_ERROR,
                      C.TERMINAL_SEEKER_CONSISTENCY * R_s)
            if err <= tol:
                v_rel_track = v_t - v
                rr = float(seeker.range_rate)
                if np.isfinite(rr):
                    v_t = v_t + 0.5 * (rr - float(np.dot(v_rel_track, u_s))) * u_s
                # Smoothly fade out raw seeker position injection inside 4 km
                # so endgame guidance relies on the low-noise Singer+Doppler KF.
                w_raw = float(np.clip((R_s - 4000.0) / 6000.0, 0.0, 0.18))
                if w_raw > 0.0:
                    r_t = (1.0 - w_raw) * r_t + w_raw * r_t_s

        # Aim point offset (0 = target centre).
        if C.TERMINAL_AIMPOINT_OFFSET > 0.0 and MU.norm3(v_t) > 1.0:
            r_t = r_t - C.TERMINAL_AIMPOINT_OFFSET * MU.normalize(v_t)

        a_T = self._target_acceleration(t, v_t, target_acc)
        return r, v, r_t, v_t, a_T

    # --------------------------------------------------------
    def _command_accel(self, geo, vc, t_go, a_T):
        """Acceleration law: Singer-OGL ZEM/APN with endgame glint protection.

        - Uses the Singer correlated-manoeuvre zero-effort-miss weight
          ``phi(t_go) = tau_m^2 * (exp(-t_go/tau_m) + t_go/tau_m - 1)``
          instead of assuming constant acceleration over long horizons;
        - Applies finite-horizon optimal navigation gain with first-order
          autopilot lag shaping;
        - Floors ``t_go`` in the final glint-dominated coast window so residual
          measurement noise cannot blow up via ``1 / t_go^2``.
        """
        u = geo["u"]
        v_rel = geo["v_rel"]
        tau_m = max(C.TGT_TRACK_MANEUVER_TAU, 0.1)
        theta = t_go / tau_m
        phi_singer = tau_m * tau_m * (math.exp(-theta) + theta - 1.0)
        zem = geo["rho"] + v_rel * t_go + phi_singer * a_T

        # Adaptive finite-horizon OGL gain with endgame glint/lag roll-off:
        # follows Zarchan Ch. 8 optimal guidance shape — boosts N_eff across
        # mid-terminal (xi ~ 5..15) and tapers back down inside xi < 4.5 so
        # colored RCS glint + NMP tail-fin lag cannot whip a +/-40 g reversal.
        tau_tot = max(C.TERMINAL_TAU_AP + C.TERMINAL_NMP_TAU, 1e-3)
        xi = t_go / tau_tot
        n_eff = self.n
        if C.TERMINAL_PN_BOOST > 0.0:
            ramp = float(np.clip(1.0 - t_go / max(C.TERMINAL_PN_TGO_REF, 1e-3),
                                 0.0, 1.0))
            end_taper = float(np.clip((xi - 1.5) / 3.5, 0.0, 1.0))
            n_eff = max(C.TERMINAL_PN_MIN,
                        self.n * (1.0 + C.TERMINAL_PN_BOOST * ramp * end_taper))
        if 2.5 <= xi <= 25.0:
            n_eff *= (1.0 + 0.14 * math.exp(-0.20 * abs(xi - 6.0)))

        if 0.30 < t_go < 3.50 and C.TERMINAL_NMP_GAIN > 0.0:
            w_lo = min(max((t_go - 0.30) / 0.35, 0.0), 1.0)
            w_hi = min(max((3.50 - t_go) / 0.80, 0.0), 1.0)
            lead_fac = 1.0 + 0.5 * C.TERMINAL_NMP_GAIN * (C.TERMINAL_NMP_TAU / max(t_go, 0.30)) * w_lo * w_hi
            zem = geo["rho"] + v_rel * t_go + (phi_singer * lead_fac) * a_T

        t_go_eff = max(t_go, C.TERMINAL_GLINT_FREEZE_TGO)
        return n_eff * MU.perpendicular(zem, u) / (t_go_eff * t_go_eff)

    # --------------------------------------------------------
    def compute(self, t, nav, target_state, q=None, seeker=None,
                target_acc=None):
        r, v, r_t, v_t, a_T = self._aligned_state(
            t, nav, target_state, seeker, target_acc)

        geo = MU.los_geometry(r, v, r_t, v_t)
        R = geo["range"]
        u = geo["u"]
        vc = max(-geo["range_rate"], 50.0)
        t_go = max(R / vc, self.t_go_min)
        a_cmd = self._command_accel(geo, vc, t_go, a_T)

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
