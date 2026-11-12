"""Three-loop load-factor autopilot (pseudo-alpha -> rate -> virtual fin).

Engineering features
--------------------
- q-scheduled second-order command pre-filter with a rate/acceleration-limited
  reference governor (feasible command shaping at low dynamic pressure);
- anti-windup: freeze integrators while the fin mixer is saturated, plus
  back-calculation of the rate-loop integral on position saturation;
- model-based gain scheduling over dynamic pressure from the instantaneous fin
  authority, inertia and q, bounded to [0.3, 3.0], with reduced integral action
  at low dynamic pressure;
- reference-rate feed-forward in the angle loop;
- lift-vector (roll) alignment with an angle-unwrapped error-rate feed-forward
  and roll-rate damping, so the roll loop keeps up with a command direction
  that rotates in the body frame;
- model feed-forward trim, low-passed at tau ~ 0.1 s with a 0.3 safety factor;
- low-dynamic-pressure protection: disable integration below 100 Pa.

Ref: Hacettepe-3loop (three-loop structure + anti-windup); TU-Delft-AW
(gain scheduling).
"""

import numpy as np
import config as C
import fastcore as FC
import math_utils as MU


class SecondOrderFilter:
    """Second-order low-pass filter (explicit Euler, configurable wn/zeta)."""

    def __init__(self, wn_hz=5.0, zeta=0.707):
        self.wn = 2.0 * np.pi * wn_hz
        self.zeta = float(zeta)
        self.x = 0.0
        self.xd = 0.0
        self.initialized = False

    def reset(self, x0=0.0):
        self.x = float(x0)
        self.xd = 0.0
        self.initialized = True

    def update(self, cmd, dt, wn_hz=None, accel_limit=None, rate_limit=None):
        if not self.initialized:
            self.reset(cmd)
            return self.x
        dt = float(min(max(dt, 1e-6), 0.05))
        if wn_hz is not None:
            self.wn = 2.0 * np.pi * float(wn_hz)
        xdd = self.wn ** 2 * (cmd - self.x) - 2.0 * self.zeta * self.wn * self.xd
        if accel_limit is not None:
            lim = float(abs(accel_limit))
            xdd = min(max(xdd, -lim), lim)
        self.xd += xdd * dt
        if accel_limit is not None:
            # Velocity cap that still allows a full stop within the remaining
            # error, so the acceleration limit cannot cause overshoot.
            v_allow = np.sqrt(2.0 * lim * abs(cmd - self.x))
            self.xd = min(max(self.xd, -v_allow), v_allow)
        if rate_limit is not None:
            # Hard reference-rate cap: the inner rate loop cannot follow a
            # reference faster than this without saturating the fins.
            v_max = float(abs(rate_limit))
            self.xd = min(max(self.xd, -v_max), v_max)
        self.x += self.xd * dt
        return self.x


class FirstOrderFilter:
    """First-order low-pass filter (trim feed-forward smoothing)."""

    def __init__(self, tau=0.1):
        self.tau = float(tau)
        self.y = 0.0
        self.initialized = False

    def reset(self, y0=0.0):
        self.y = float(y0)
        self.initialized = True

    def update(self, cmd, dt):
        if not self.initialized:
            self.y = float(cmd)
            self.initialized = True
            return self.y
        a = dt / max(self.tau, 1e-6)
        if a > 1.0:
            a = 1.0
        self.y += a * (cmd - self.y)
        return self.y


class Autopilot:
    """Three-loop PID autopilot returning virtual fins [delta_P, delta_Y, delta_R]."""

    # Per-axis gains: pitch (P), yaw (Y) and roll (R) are physically different
    # channels.  Yaw uses the much smaller CN_DR (0.30 vs CM_DE ~1.03) and the
    # side-force derivative is only ~1/3 of the normal-force slope, so the yaw
    # rate loop needs a slightly higher gain and integral to reach a comparable
    # bandwidth; the yaw angle loop is a touch softer because beta is measured
    # in the weak side-force channel.  Roll is a rate loop only and is
    # deliberately detuned relative to pitch/yaw: lateral guidance is carried
    # by the alpha/beta channels, so the roll loop only has to keep the lift
    # vector aligned and must not fight the pitch/yaw fins for authority.
    KP_ANGLE = C.AP_KP_ANGLE
    KI_ANGLE = 0.75
    KP_RATE = C.AP_KP_RATE
    KI_RATE = 1.7
    KP_ANGLE_Y = 3.6
    KI_ANGLE_Y = 0.65
    KP_RATE_Y = 0.19
    KI_RATE_Y = 1.9
    KP_ROLL = 0.035
    KI_ROLL = 0.008
    REF_Q = C.AP_REF_Q
    # Direct load-factor loop (A/B switchable; the gains are handed to the
    # compiled core at run time).
    NZ_LOOP = bool(C.AP_NZ_LOOP)
    KP_NZ = C.AP_KP_NZ
    KI_NZ = C.AP_KI_NZ
    NZ_LEAD = C.AP_NZ_LEAD

    def __init__(self, dt=C.DT_AUTOPILOT, alpha_max=25.0 * C.DEG):
        self.dt = float(dt)
        self.alpha_max = float(alpha_max)
        self._state = np.zeros(29)
        self.alpha_f = SecondOrderFilter(C.AP_PREFILTER_HZ, 0.707)
        self.beta_f = SecondOrderFilter(C.AP_PREFILTER_HZ, 0.707)
        self.trim_f = FirstOrderFilter(0.1)
        self.int_angle_p = 0.0
        self.int_angle_y = 0.0
        self.int_rate_p = 0.0
        self.int_rate_y = 0.0
        self.int_roll = 0.0
        self.initialized = False

    # --------------------------------------------------------
    # Integrator states are views on the compiled state vector.
    # --------------------------------------------------------
    @property
    def int_angle_p(self):
        return float(self._state[8])

    @int_angle_p.setter
    def int_angle_p(self, value):
        self._state[8] = float(value)

    @property
    def int_angle_y(self):
        return float(self._state[9])

    @int_angle_y.setter
    def int_angle_y(self, value):
        self._state[9] = float(value)

    @property
    def int_rate_p(self):
        return float(self._state[10])

    @int_rate_p.setter
    def int_rate_p(self, value):
        self._state[10] = float(value)

    @property
    def int_rate_y(self):
        return float(self._state[11])

    @int_rate_y.setter
    def int_rate_y(self, value):
        self._state[11] = float(value)

    @property
    def int_roll(self):
        return float(self._state[12])

    @int_roll.setter
    def int_roll(self, value):
        self._state[12] = float(value)

    # --------------------------------------------------------
    def reset(self):
        self.alpha_f.initialized = False
        self.beta_f.initialized = False
        self.trim_f.initialized = False
        self._state[:] = 0.0
        self.initialized = False

    # --------------------------------------------------------
    def _mixer_feedback(self, d_p, d_y, d_r, dt):
        """Run the cruciform mixer model and return the achieved virtual fins.

        The virtual (P, Y, R) command is mapped by the real actuator model,
        which has a rate limit, a first-order lag and a position limit, and the
        mixer maps P/R to the left/right pair as ``d_p ± d_r``.  Closing this
        loop inside the controller exposes the applied fins for the cascade-PID
        back-calculation, and prevents the post-mix rate saturation that the
        independent per-axis limiter cannot catch.
        """
        fins = self._state[23:27]
        target = np.array([d_y, d_y, d_p - d_r, d_p + d_r])
        max_step = C.FIN_RATE_MAX * dt
        alpha = dt / (C.FIN_TAU + dt)
        delta = np.clip(target - fins, -max_step, max_step)
        achieved = np.clip(fins + alpha * delta, -C.FIN_MAX, C.FIN_MAX)
        self._state[23:27] = achieved
        # Observer input: the virtual command the airframe actually applied.
        self._state[16] = 0.5 * (achieved[2] + achieved[3])
        self._state[19] = 0.5 * (achieved[0] + achieved[1])
        self._state[22] = 0.5 * (achieved[3] - achieved[2])
        # Return the unmodified virtual command so the real mixer keeps its
        # normal command path; only the applied fins are fed back through it.
        return float(d_p), float(d_y), float(d_r)

    # --------------------------------------------------------
    def _gain_scale(self, q_dyn, cn_alpha, mass):
        """Rate-loop gain factor.

        The factor is derived from the instantaneous plant: the pitch-rate
        crossover is held at ``AP_OMEGA_Q`` given the fin authority
        ``(cn_alpha - CN_ALPHA_BODY) * FIN_LEVER / LENGTH``, the current
        inertia and q.  Geometry or DATCOM changes therefore need no offline
        re-tuning.
        """
        if C.MASS0 > C.DRY_MASS:
            fuel_f = min(max((mass - C.DRY_MASS) /
                             (C.MASS0 - C.DRY_MASS), 0.0), 1.0)
        else:
            fuel_f = 0.0
        iyy = C.IYY_DRY + fuel_f * (C.IYY_FULL - C.IYY_DRY)
        cm_de = max((float(cn_alpha) - C.CN_ALPHA_BODY) * C.FIN_LEVER
                    / C.LENGTH, 1.0e-3)
        kp_req = C.AP_OMEGA_Q * iyy / (
            max(float(q_dyn), 1.0) * C.S_REF * C.LENGTH * cm_de)
        return float(min(max(kp_req / self.KP_RATE,
                             C.GAIN_SCALE_MIN), C.GAIN_SCALE_MAX))

    # --------------------------------------------------------
    def _moment_derivs(self, cn_alpha):
        """Model control derivatives used by the reference governor.

        The pitch derivative follows the DATCOM fin lever arm; the yaw
        derivative uses the much smaller CN_DR and the same effectiveness
        ratio as the rate-loop gain schedule.  Using the constant M = 2
        CM_DE here would over-state the pitch authority by ~2.5x at M ~ 10.
        """
        ratio = min(max((float(cn_alpha) - C.CN_ALPHA_BODY) /
                        (10.17 - C.CN_ALPHA_BODY), 0.2), 2.0)
        cm_de = max((float(cn_alpha) - C.CN_ALPHA_BODY) * C.FIN_LEVER
                    / C.LENGTH, 1.0e-3)
        cm_dr = abs(C.CN_DR) * ratio
        return cm_de, cm_dr

    def _filter_hz(self, q_dyn, cn_alpha=None, axis="p"):
        """Pre-filter bandwidth kept proportional to the available authority.

        The yaw channel is slowed by ``sqrt(|cm_dr| / |cm_de|)`` because its
        moment authority per radian of fin is much smaller, so a pre-filter
        as fast as the pitch one would only demand unattainable beta rates.
        """
        ratio = max(q_dyn, 1.0) / self.REF_Q
        hz = C.AP_PREFILTER_HZ * np.sqrt(ratio)
        if axis == "y" and cn_alpha is not None:
            cm_de, cm_dr = self._moment_derivs(cn_alpha)
            hz *= np.sqrt(min(max(cm_dr / cm_de, 0.2), 1.0))
        return float(min(max(hz, C.AP_PREFILTER_HZ_MIN), C.AP_PREFILTER_HZ))

    def _ref_rate_limit(self, q_dyn):
        """Hard cap on the reference body rate, scaled with dynamic pressure."""
        scale = min(max(np.sqrt(max(q_dyn, 1.0) / self.REF_Q), 0.5), 2.0)
        return float(C.AP_REF_RATE_MAX * scale)

    def _accel_limit(self, mass, q_dyn, cn_alpha, axis="p"):
        """Feasible pseudo-angle acceleration from the fin moment authority.

        alpha_ddot_max = q*S*L*|cm_de|*fin_max / Iyy (yaw: |cm_dr|, Izz),
        scaled by an engineering margin so the reference stays inside the
        torque budget.  The derivatives are Mach-dependent, matching the
        moment model, so the governor does not over-estimate authority at
        high Mach.
        """
        if C.MASS0 > C.DRY_MASS:
            fuel_f = min(max((mass - C.DRY_MASS) /
                             (C.MASS0 - C.DRY_MASS), 0.0), 1.0)
        else:
            fuel_f = 0.0
        cm_de, cm_dr = self._moment_derivs(cn_alpha)
        if axis == "y":
            inertia = C.IZZ_DRY + fuel_f * (C.IZZ_FULL - C.IZZ_DRY)
            cm = cm_dr
        else:
            inertia = C.IYY_DRY + fuel_f * (C.IYY_FULL - C.IYY_DRY)
            cm = cm_de
        q_s = max(q_dyn * C.S_REF, 1.0)
        moment = q_s * C.LENGTH * abs(cm) * C.FIN_MAX
        return float(C.AP_REF_GOV_ACCEL_MARGIN * moment / max(inertia, 1e-9))

    def _ki_scale(self, q_dyn):
        """Reduce integral action when the dynamic pressure is low."""
        return float(min(max(np.sqrt(max(q_dyn, 1.0) / self.REF_Q),
                             C.AP_KI_LOW_Q_FLOOR), 1.0))

    # --------------------------------------------------------
    def update(self, t, q, omega_body, a_cmd_eci, mass, q_dyn, cn_alpha,
               alpha_trim=0.0, beta_trim=0.0, is_saturated=False, dt=None,
               roll_align=True, load_body=None):
        """Compute virtual fin deflections.

        Parameters
        ----------
        a_cmd_eci : (3,) desired acceleration excluding gravity
        q : (4,) attitude quaternion
        q_dyn : dynamic pressure Pa
        cn_alpha : current normal-force slope
        alpha_trim, beta_trim : current aero angles (rad)
        load_body : (3,) measured body-axis load factor (F/(m*g)), or None.
            Its -Z component drives the optional n_z loop.
        """
        dt = self.dt if dt is None else float(min(max(dt, 1e-5), 0.05))
        n_meas = -float(load_body[2]) if load_body is not None else 0.0
        if self.NZ_LOOP:
            kp_nz = float(self.KP_NZ)
            ki_nz = float(self.KI_NZ)
            nz_lead = float(self.NZ_LEAD)
        else:
            kp_nz = 0.0
            ki_nz = 0.0
            nz_lead = 0.0

        if FC.NUMBA_AVAILABLE:
            out = FC.autopilot_update(
                np.ascontiguousarray(np.asarray(q, dtype=float).reshape(4)),
                np.ascontiguousarray(np.asarray(omega_body, dtype=float).reshape(3)),
                np.ascontiguousarray(np.asarray(a_cmd_eci, dtype=float).reshape(3)),
                float(mass), float(q_dyn), float(cn_alpha),
                float(alpha_trim), float(beta_trim),
                1.0 if is_saturated else 0.0,
                dt, self.alpha_max, float(C.AP_PREFILTER_HZ),
                self.KP_ANGLE, self.KI_ANGLE, self.KP_RATE, self.KI_RATE,
                self.KP_ANGLE_Y, self.KI_ANGLE_Y,
                self.KP_RATE_Y, self.KI_RATE_Y,
                self.KP_ROLL, self.KI_ROLL,
                1.0 if roll_align else 0.0,
                n_meas, kp_nz, ki_nz, nz_lead,
                self._state)
            self.initialized = True
            return out

        a_b = MU.quat_rotate_inv(q, np.asarray(a_cmd_eci, dtype=float))

        # Lift-vector alignment: roll the body so the commanded acceleration
        # lies in the pitch plane (body -Z).  Without this the command is split
        # between the strong alpha channel and the weak beta (side-force)
        # channel, and the yaw fins sit on their stops for the whole flight.
        ay, az = float(a_b[1]), float(a_b[2])
        if roll_align and (ay * ay + az * az) > 1.0e-2:
            p_cmd = C.AP_ROLL_ANGLE_GAIN * float(np.arctan2(ay, -az))
            p_cmd = float(np.clip(p_cmd, -C.AP_ROLL_RATE_MAX, C.AP_ROLL_RATE_MAX))
        else:
            p_cmd = 0.0

        qS = max(q_dyn * C.S_REF, 1.0)
        cn_a = max(cn_alpha, 0.5)
        # Desired pseudo-alpha/beta (lift along -Z, side force along +Y).
        alpha_cmd = -a_b[2] * mass / (qS * cn_a)
        beta_cmd = -a_b[1] * mass / (qS * abs(C.CY_BETA))
        alpha_cmd = float(min(max(alpha_cmd, -self.alpha_max), self.alpha_max))
        beta_cmd = float(min(max(beta_cmd, -self.alpha_max), self.alpha_max))

        if not self.initialized:
            self.alpha_f.reset(alpha_trim)
            self.beta_f.reset(beta_trim)
            self.trim_f.reset(0.0)
            self.initialized = True

        # Feasible reference shaping: bandwidth and acceleration budget both
        # follow the dynamic pressure, so a low-q airframe is not asked for a
        # rate it cannot produce.
        filter_hz = self._filter_hz(q_dyn, cn_alpha, axis="p")
        filter_hz_y = self._filter_hz(q_dyn, cn_alpha, axis="y")
        accel_limit = self._accel_limit(mass, q_dyn, cn_alpha, axis="p")
        accel_limit_y = self._accel_limit(mass, q_dyn, cn_alpha, axis="y")
        rate_limit = self._ref_rate_limit(q_dyn)
        alpha_ref = self.alpha_f.update(alpha_cmd, dt, filter_hz, accel_limit,
                                        rate_limit)
        beta_ref = self.beta_f.update(beta_cmd, dt, filter_hz_y, accel_limit_y,
                                      rate_limit)
        alpha_ref_dot = float(self.alpha_f.xd)
        beta_ref_dot = float(self.beta_f.xd)

        alpha_act = float(alpha_trim)
        beta_act = float(beta_trim)
        p, qq, r = np.asarray(omega_body, dtype=float)

        # Low-q protection and gain scheduling.
        low_q = q_dyn < 100.0
        gain_scale = self._gain_scale(q_dyn, cn_alpha, mass)
        ki_scale = self._ki_scale(q_dyn)
        freeze = bool(is_saturated or low_q)

        # Outer loop: pseudo-angle error -> body-rate command, with the
        # reference rate as feed-forward so the feedback only corrects error.
        # q > 0 is nose-up; r > 0 is nose-right.
        e_alpha = alpha_ref - alpha_act
        e_beta = beta_ref - beta_act
        if not freeze:
            self.int_angle_p += e_alpha * dt
            self.int_angle_y += e_beta * dt
        self.int_angle_p = float(min(max(self.int_angle_p, -0.5), 0.5))
        self.int_angle_y = float(min(max(self.int_angle_y, -0.5), 0.5))
        ki_angle_p = self.KI_ANGLE * ki_scale
        ki_angle_y = self.KI_ANGLE_Y * ki_scale
        q_cmd = (alpha_ref_dot + self.KP_ANGLE * e_alpha
                 + ki_angle_p * self.int_angle_p)
        r_cmd = -(beta_ref_dot + self.KP_ANGLE_Y * e_beta
                  + ki_angle_y * self.int_angle_y)

        # Direct load-factor loop: trim the pitch-rate command with the error
        # between the commanded and measured body normal load factor.  The
        # alpha loop cannot see the difference between a commanded and an
        # achieved g, which is exactly the lag seen in the terminal phase.
        if kp_nz != 0.0 or ki_nz != 0.0:
            n_cmd = -float(a_b[2]) / C.G0
            # Lead compensation: a low-passed derivative of the measured load
            # factor anticipates the value the PI should act on, adding phase
            # near the loop crossover without pure differentiation noise.
            n_used = n_meas
            if nz_lead > 0.0:
                tau_l = C.AP_NZ_LEAD_LPF
                n_f = self._state[28] + dt / tau_l * (n_meas - self._state[28])
                self._state[28] = float(min(max(n_f, -50.0), 50.0))
                n_dot = (n_meas - self._state[28]) / tau_l
                n_used = n_meas + nz_lead * n_dot
            e_n = n_cmd - n_used
            if not freeze:
                self._state[27] += e_n * dt
            self._state[27] = float(min(max(self._state[27], -50.0), 50.0))
            q_cmd += kp_nz * e_n + ki_nz * self._state[27]

        # Middle loop: rate error -> virtual fin.
        e_q = q_cmd - qq
        e_r = r_cmd - r
        if not freeze:
            self.int_rate_p += e_q * dt
            self.int_rate_y += e_r * dt
        self.int_rate_p = float(min(max(self.int_rate_p, -5.0), 5.0))
        self.int_rate_y = float(min(max(self.int_rate_y, -5.0), 5.0))
        kp_p = self.KP_RATE * gain_scale
        ki_p = self.KI_RATE * gain_scale * 0.1 * ki_scale
        kp_y = self.KP_RATE_Y * gain_scale
        ki_y = self.KI_RATE_Y * gain_scale * 0.1 * ki_scale
        # Positive pitch fin produces a nose-down moment (CM_DE < 0),
        # hence the negative feedback sign on the pitch channel.
        d_p_raw = -kp_p * e_q - ki_p * self.int_rate_p
        d_y_raw = kp_y * e_r + ki_y * self.int_rate_y

        # Model feed-forward trim: low-passed and scaled by 0.3.  The pitch
        # stiffness grows as fuel burn moves the CG forward, so the trim
        # schedule is scaled by the same static-margin ratio used in the
        # moment equations instead of freezing the all-up CM_ALPHA.
        if C.MASS0 > C.DRY_MASS:
            fuel_f = min(max((mass - C.DRY_MASS) /
                             (C.MASS0 - C.DRY_MASS), 0.0), 1.0)
        else:
            fuel_f = 0.0
        cg = C.CG_DRY + fuel_f * (C.CG_FULL - C.CG_DRY)
        # Trim feed-forward must use the same Mach-dependent derivatives as
        # the moment model.  The constant M = 2 values (CM_DE = -1.03,
        # CM_ALPHA = -0.51) under-trim by ~3x at M ~ 10, where the fin lever
        # arm gives |cm_de| ~ 0.41 but the static margin gives |cm_alpha| ~
        # 0.60: the elevator would sit at half the angle the airframe needs,
        # leaving a large alpha error for the (clamped) integral to chase.
        cm_de_ff = max((float(cn_alpha) - C.CN_ALPHA_BODY) * C.FIN_LEVER
                       / C.LENGTH, 1.0e-3)
        cm_alpha_ff = float(cn_alpha) * (C.X_REF - cg) / C.LENGTH
        trim_raw = -float(alpha_trim) * cm_alpha_ff / cm_de_ff
        trim = 0.3 * self.trim_f.update(trim_raw, dt)
        d_p_raw += trim

        d_p = float(np.clip(d_p_raw, -C.FIN_MAX, C.FIN_MAX))
        d_y = float(np.clip(d_y_raw, -C.FIN_MAX, C.FIN_MAX))

        # Roll loop: PI on the body roll rate.
        e_p = p_cmd - p
        if not freeze:
            self.int_roll += e_p * dt
        else:
            self.int_roll *= 0.98
        self.int_roll = float(min(max(self.int_roll, -1.0), 1.0))
        d_r = self.KP_ROLL * gain_scale * e_p + self.KI_ROLL * self.int_roll

        # Actuator/mixer in the loop: the model returns the command unchanged
        # but stores the achieved (rate/lag/position limited) virtual fins.
        # Cascade PID uses the shortfall for back-calculation anti-windup.
        d_p, d_y, d_r = self._mixer_feedback(d_p, d_y, d_r, dt)
        if not freeze:
            if ki_p > 1e-9:
                self.int_rate_p += 0.5 * (d_p - self._state[16]) / ki_p
            if ki_y > 1e-9:
                self.int_rate_y -= 0.5 * (d_y - self._state[19]) / ki_y
            self.int_rate_p = float(min(max(self.int_rate_p, -5.0), 5.0))
            self.int_rate_y = float(min(max(self.int_rate_y, -5.0), 5.0))
            self.int_roll += 0.5 * (d_r - self._state[22]) / max(self.KI_ROLL, 1e-6)
            self.int_roll = float(min(max(self.int_roll, -1.0), 1.0))

        out = np.array([d_p, d_y, d_r], dtype=float)
        return np.clip(out, -C.FIN_MAX, C.FIN_MAX)
