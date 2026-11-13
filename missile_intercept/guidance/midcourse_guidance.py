"""Midcourse guidance: 3D Bezier trajectory shaping with a loft-dive handover.

Key points
----------
1. Cubic Bezier: P0 = current position, P3 = handover point, P1 is tangent
   to the current velocity vector;
2. Re-plan online every 10 s, frozen inside the terminal approach range so
   the curve cannot degenerate as t_go shrinks;
3. A new path is cross-faded over tau ~ 2 s to avoid command chattering;
4. The handover point is defined by an altitude advantage the airframe can
   actually hold (MIDCOURSE_HANDOVER_DH above the predicted intercept);
5. Loft-then-dive shaping: the pre-handover altitude profile first pulls up
   above the descent-entry altitude, then follows a cubic Hermite dive whose
   terminal slope equals the desired handover flight-path angle.  This gives
   the terminal loop an already-established dive angle instead of asking PN
   to pitch the airframe over inside the seeker field of view;
6. Angle-constrained guidance: an impact-angle style feedback term drives the
   flight-path-angle error to zero at handover, on top of the profile;
7. Predictive terminal-error feedback: both vehicles are propagated to the
   predicted handover, the terminal ZEM is evaluated there, and a fraction of
   it is removed during midcourse.

Ref: JAST-Bezier (Mohamadifard & Naghash, JAST Vol.8 No.2); impact-angle
guidance (double-integrator terminal profile).
"""

import math
import numpy as np
import config as C
import math_utils as MU
from guidance.base_guidance import BaseGuidance
from config import GuidanceCommand
from vehicle.atmosphere import get_atmosphere


class BezierPath:
    """Cubic Bezier curve with analytic first and second derivatives."""

    def __init__(self, p0, p1, p2, p3, duration):
        self.p = [np.asarray(x, dtype=float) for x in (p0, p1, p2, p3)]
        self.duration = max(float(duration), 1e-6)

    def evaluate(self, s):
        s = float(np.clip(s, 0.0, 1.0))
        p0, p1, p2, p3 = self.p
        a = (1.0 - s) ** 3
        b = 3.0 * (1.0 - s) ** 2 * s
        c = 3.0 * (1.0 - s) * s ** 2
        d = s ** 3
        pos = a * p0 + b * p1 + c * p2 + d * p3
        d1 = 3.0 * (1.0 - s) ** 2 * (p1 - p0) + 6.0 * (1.0 - s) * s * (p2 - p1) \
            + 3.0 * s ** 2 * (p3 - p2)
        d2 = 6.0 * (1.0 - s) * (p2 - 2.0 * p1 + p0) + 6.0 * s * (p3 - 2.0 * p2 + p1)
        return pos, d1, d2


class MidcourseGuidance(BaseGuidance):
    name = "midcourse"

    def __init__(self, replan_period=10.0, blend_time=2.0, k1=0.0002, k2=0.06):
        self.replan_period = float(replan_period)
        self.blend_time = float(blend_time)
        self.k1 = float(k1)
        self.k2 = float(k2)
        self.path = None
        self.t_path0 = 0.0
        self.t_replan = -1e9
        self.a_prev = None
        self.descent_active = False
        self.descent_ref = None

    def reset(self):
        self.path = None
        self.t_replan = -1e9
        self.a_prev = None
        self.descent_active = False
        self.descent_ref = None

    # --------------------------------------------------------
    def _build_path(self, nav, target_state):
        r = np.asarray(nav.r_eci, dtype=float)
        v = np.asarray(nav.v_eci, dtype=float)
        # The handover point is offset by the look-down advantage the vehicle
        # can actually hold (MIDCOURSE_HANDOVER_DH).  The Bezier arrival
        # tangent then points down at the target, so the path itself carries
        # the terminal flight-path-angle lead instead of arriving flat.
        p3, t_go = self.lead_point(nav, target_state)
        duration = float(np.clip(t_go, 30.0, 900.0))

        # P1 is tangent to the current velocity (C1 continuity).  The initial
        # climb angle is limited to 10 deg to preserve kinetic energy.
        v_hat = MU.normalize(v, fallback=np.array([1.0, 0.0, 0.0]))
        up = MU.local_up(r)
        vert = float(np.dot(v_hat, up))
        if vert > np.sin(10.0 * C.DEG):
            horiz = MU.normalize(MU.perpendicular(v_hat, up))
            v_hat = MU.normalize(horiz * np.cos(10.0 * C.DEG) + up * np.sin(10.0 * C.DEG))

        seg_len = min(0.25 * duration * max(MU.norm3(v), 1.0), 40000.0)
        p1 = r + seg_len * v_hat
        # P2 is placed so that the arrival velocity points at the target.
        r_t = self.target_position(target_state)
        v_arr = MU.normalize(r_t - p3, fallback=MU.normalize(-v))
        p2 = p3 - seg_len * v_arr
        return BezierPath(r, p1, p2, p3, duration), duration

    # --------------------------------------------------------
    def lead_point(self, nav, target_state):
        """Predictive handover point: the target's future position.

        The aim point is the predicted intercept advanced along the target
        velocity by the current time-to-go, plus the look-down advantage.  It
        is re-evaluated every guidance cycle, so the midcourse command keeps
        a live lead angle instead of chasing a frozen endpoint.
        """
        return self.handover_point(nav, target_state,
                                   C.MIDCOURSE_HANDOVER_DH)

    # --------------------------------------------------------
    @staticmethod
    def handover_gamma():
        """Desired flight-path angle at handover (negative = descending).

        By default it is derived from the look-down advantage and the handover
        range, so the velocity is aligned with the LOS the terminal seeker
        will use.  An explicit ``MIDCOURSE_HANDOVER_GAMMA`` overrides it,
        bounded by the descending gradient the airframe can fly.
        """
        if C.MIDCOURSE_HANDOVER_GAMMA is not None:
            return max(float(C.MIDCOURSE_HANDOVER_GAMMA),
                       -C.MIDCOURSE_DESCENT_GAMMA)
        dh = max(C.MIDCOURSE_HANDOVER_DH, C.MIDCOURSE_DESCENT_DH_TARGET)
        return -min(math.atan2(dh, C.HANDOVER_RANGE),
                    C.MIDCOURSE_DESCENT_GAMMA)


    # --------------------------------------------------------
    @staticmethod
    def plane_normal(target_state):
        """Unit normal of the target's ground-track vertical plane."""
        r_t = BaseGuidance.target_position(target_state)
        v_t = BaseGuidance.target_velocity(target_state)
        v_t_air = MU.atmosphere_relative_velocity(r_t, v_t)
        n = MU.cross3(r_t, v_t_air)
        n_norm = MU.norm3(n)
        if n_norm < 1e-6:
            return None
        return n / n_norm

    # --------------------------------------------------------
    @staticmethod
    def coplanar_bias(r, v, target_state):
        """Terminal guidance in the cross-plane channel.

        The target's ground-track vertical plane has normal
        ``n = r_t x v_t_air``.  Both velocity vectors lie in that plane iff
        the missile's cross-plane offset ``x`` and rate ``xdot`` are zero at
        handover, i.e. the impact-angle law with a zero terminal relative
        heading in this channel.  Both are driven to zero by the standard
        double-integrator terminal profile

            ``a_n = -(6 x + 4 xdot t_go) / t_go^2``

        along ``n``.  A pure ZEM term only nulls the offset and leaves a
        residual rate that turns into a lateral miss in the last seconds.
        The term is ramped in from ``MIDCOURSE_COPLANAR_RANGE`` and capped.
        """
        r_t = BaseGuidance.target_position(target_state)
        v_t = BaseGuidance.target_velocity(target_state)
        v_m = MU.atmosphere_relative_velocity(r, v)
        v_t_air = MU.atmosphere_relative_velocity(r_t, v_t)

        n = MidcourseGuidance.plane_normal(target_state)
        if n is None:
            return np.zeros(3)

        rho = r_t - r
        R = MU.norm3(rho)
        if R < 1.0:
            return np.zeros(3)
        v_rel = v_m - v_t_air
        Vc = max(float(np.dot(v_rel, rho)) / R, 100.0)
        # Handover happens at HANDOVER_RANGE, i.e. earlier than impact, so
        # the cross-plane state is driven to zero at *handover*:
        # t_go_h = t_go_impact - R_handover / Vc.
        t_go = max(R / Vc - C.HANDOVER_RANGE / Vc,
                   C.MIDCOURSE_COPLANAR_TGO_MIN)

        x = float(np.dot(r - r_t, n))
        xdot = float(np.dot(v_rel, n))

        span = max(C.MIDCOURSE_COPLANAR_RANGE - C.HANDOVER_RANGE, 1.0)
        w = float(np.clip((C.MIDCOURSE_COPLANAR_RANGE - R) / span, 0.0, 1.0))
        if w <= 0.0:
            return np.zeros(3)

        # Terminal second-order profile: both the cross-plane offset and its
        # rate must reach zero at handover.  The characteristic polynomial
        # s^2 + 4/T s + 6/T^2 = 0 is the standard double-integrator terminal
        # solution (ZEM alone only nulls the offset, leaving a residual rate
        # that turns into a lateral miss during the last seconds).
        a_n = -C.MIDCOURSE_COPLANAR_GAIN * w * \
            (6.0 * x + 4.0 * xdot * t_go) / (t_go * t_go)
        a_n = float(np.clip(a_n, -C.MIDCOURSE_COPLANAR_ACC_MAX,
                            C.MIDCOURSE_COPLANAR_ACC_MAX))
        return a_n * n

    # --------------------------------------------------------
    def _loft_dive_profile(self, R_los):
        """Range-to-go altitude reference: pull up, then dive.

        The profile is a two-segment cubic Hermite in range-to-go:
        entry -> apex is a level-in/level-out pull-up of ``LOFT_DH``, and
        apex -> handover is a dive that starts level and ends with the
        handover flight-path angle.  Zero slope at the apex keeps the
        pull-over smooth; the terminal slope is the angle constraint that the
        terminal seeker inherits.
        """
        r_entry, dh_entry = self.descent_ref
        r_h = C.HANDOVER_RANGE + C.MIDCOURSE_LEVEL_LEAD
        dh_hand = max(C.MIDCOURSE_HANDOVER_DH,
                      C.MIDCOURSE_DESCENT_DH_TARGET)
        gamma_h = self.handover_gamma()
        span = max(r_entry - r_h, 1000.0)
        frac = float(np.clip((R_los - r_h) / span, 0.0, 1.0))
        f_apex = float(np.clip(C.MIDCOURSE_LOFT_FRAC, 0.05, 0.95))
        dh_apex = dh_entry + C.MIDCOURSE_LOFT_DH

        if frac >= f_apex:
            # Climb segment: level at the entry and level at the apex.
            u = (frac - f_apex) / max(1.0 - f_apex, 1e-6)
            u2, u3 = u * u, u * u * u
            dh_des = (2.0 * u3 - 3.0 * u2 + 1.0) * dh_apex \
                + (-2.0 * u3 + 3.0 * u2) * dh_entry
            dd_dfrac = (6.0 * u2 - 6.0 * u) * (dh_apex - dh_entry) \
                / max(1.0 - f_apex, 1e-6)
        else:
            # Dive segment: level at the apex, terminal slope tan(-gamma_h).
            u = frac / f_apex
            u2, u3 = u * u, u * u * u
            m0 = f_apex * span * math.tan(-gamma_h)
            dh_des = (2.0 * u3 - 3.0 * u2 + 1.0) * dh_hand \
                + (u3 - 2.0 * u2 + u) * m0 \
                + (-2.0 * u3 + 3.0 * u2) * dh_apex
            dd_dfrac = ((6.0 * u2 - 6.0 * u) * (dh_hand - dh_apex)
                        + (3.0 * u2 - 4.0 * u + 1.0) * m0) / f_apex

        slope = float(np.clip(dd_dfrac / span, 0.0,
                              math.tan(C.MIDCOURSE_DESCENT_GAMMA)))
        return dh_des, -math.atan(slope)

    # --------------------------------------------------------
    @staticmethod
    def angle_constraint_bias(r, v, target_state, gamma_ref, t_h):
        """Flight-path-angle constraint feedback in the vertical plane.

        The angle error relative to the reference profile is turned into a
        lift-direction acceleration weighted by ``V / t_go``, i.e. the terminal
        angle loop.  It is ramped in from ``MIDCOURSE_ANGLE_RANGE`` and capped
        so it only refines, never overrides, the profile.
        """
        r_t = BaseGuidance.target_position(target_state)
        R = MU.norm3(r_t - r)
        span = max(C.MIDCOURSE_ANGLE_RANGE - C.HANDOVER_RANGE, 1.0)
        w = float(np.clip((C.MIDCOURSE_ANGLE_RANGE - R) / span, 0.0, 1.0))
        if w <= 0.0:
            return np.zeros(3)

        up = MU.local_up(r)
        v_air = MU.atmosphere_relative_velocity(r, v)
        V = max(MU.norm3(v_air), 100.0)
        v_hat = MU.normalize(v_air, fallback=up)
        gamma = float(np.arcsin(np.clip(np.dot(v_air, up) / V, -1.0, 1.0)))
        # Lift direction: local up made perpendicular to the velocity.
        u_lift = MU.perpendicular(up, v_hat)
        if MU.norm3(u_lift) < 1e-6:
            return np.zeros(3)
        u_lift = MU.normalize(u_lift)

        a = -C.MIDCOURSE_ANGLE_GAIN * w * \
            (V / max(t_h, C.HANDOVER_TGO_MIN)) * (gamma - gamma_ref)
        a = float(np.clip(a, -C.MIDCOURSE_ANGLE_ACC_MAX,
                          C.MIDCOURSE_ANGLE_ACC_MAX))
        return a * u_lift

    # --------------------------------------------------------
    @staticmethod
    def predictive_terminal_error(r, v, target_state):
        """Lateral terminal ZEM predicted at the handover point.

        Both vehicles are propagated to the predicted handover (missile with
        gravity, target at constant velocity), the terminal guidance ZEM is
        evaluated there, and a fraction of the acceleration needed to remove
        it is applied now.  Only the horizontal component is used: the
        vertical terminal error is owned by the loft-dive profile, so the two
        channels do not fight.  The term is faded out inside a few handover
        ranges, where its 1/t_h^2 gain would saturate and fight the terminal
        PN.
        """
        r_t = BaseGuidance.target_position(target_state)
        v_t = BaseGuidance.target_velocity(target_state)
        R = MU.norm3(r_t - r)
        span = max(C.MIDCOURSE_PREDICT_RANGE - C.HANDOVER_RANGE, 1.0)
        w = float(np.clip((C.MIDCOURSE_PREDICT_RANGE - R) / span, 0.0, 1.0))
        # Fade out before the terminal loop takes over: inside a few handover
        # ranges the 1/t_h^2 gain would saturate and fight PN.
        w *= float(np.clip((R - 2.0 * C.HANDOVER_RANGE)
                           / max(C.HANDOVER_RANGE, 1.0), 0.0, 1.0))
        if w <= 0.0 or R < 1.0:
            return np.zeros(3)

        _, t_go = MU.predict_intercept(r, v, r_t, v_t)
        geo = MU.los_geometry(r, v, r_t, v_t)
        vc = max(-float(geo["range_rate"]), 100.0)
        t_h = max(float(t_go) - C.HANDOVER_RANGE / vc, 10.0)

        g = MU.gravity_eci(r)
        r_m_h = r + v * t_h + 0.5 * g * t_h * t_h
        v_m_h = v + g * t_h
        rho = (r_t + v_t * t_h) - r_m_h
        R_h = MU.norm3(rho)
        if R_h < 1.0:
            return np.zeros(3)
        u = rho / R_h
        v_rel = v_t - v_m_h
        t_go_h = max(R_h / max(-float(np.dot(v_rel, u)), 100.0), 0.0)
        zem = rho + v_rel * t_go_h
        zem_perp = MU.perpendicular(zem, u)

        a = -C.MIDCOURSE_PREDICT_GAIN * 2.0 * w * zem_perp / (t_h * t_h)
        a = MU.perpendicular(a, MU.local_up(r))
        return MU.clip_norm(a, C.MIDCOURSE_PREDICT_ACC_MAX)

    # --------------------------------------------------------
    @staticmethod
    def handover_feasibility(nav, target_state):
        """Predict the geometry at handover to warn of an infeasible endgame.

        Both vehicles are propagated at constant velocity to the handover
        point; the result is a preview, not a re-plan.  A large predicted lead
        angle or an altitude advantage that cannot be removed at the feasible
        descent gradient means the dive must start earlier.
        """
        r = np.asarray(nav.r_eci, dtype=float)
        v = np.asarray(nav.v_eci, dtype=float)
        r_t = BaseGuidance.target_position(target_state)
        v_t = BaseGuidance.target_velocity(target_state)
        r_p, t_go = MU.predict_intercept(r, v, r_t, v_t)
        geo = MU.los_geometry(r, v, r_t, v_t)
        vc = max(-float(geo["range_rate"]), 100.0)
        t_h = max(float(t_go) - C.HANDOVER_RANGE / vc, 0.0)
        r_m_h = r + v * t_h
        r_t_h = r_t + v_t * t_h
        rho = r_t_h - r_m_h
        R_h = MU.norm3(rho)
        lead = MU.angle_between(v, MU.normalize(rho)) if R_h > 1.0 else 0.0
        dh = MU.altitude(r_m_h) - MU.altitude(r_t_h)
        need = max(dh - C.MIDCOURSE_HANDOVER_DH, 0.0)
        feasible_speed = max(MU.norm3(v), 100.0) * math.tan(
            C.MIDCOURSE_DESCENT_GAMMA)
        return {
            "t_go": float(t_go),
            "t_handover": float(t_h),
            "range": float(R_h),
            "lead_angle": float(lead),
            "dh": float(dh),
            "descent_feasible": bool(need <= feasible_speed * max(t_h, 1.0)),
            "speed": float(MU.norm3(v)),
        }

    # --------------------------------------------------------
    def compute(self, t, nav, target_state, q=None, seeker=None):
        r = np.asarray(nav.r_eci, dtype=float)
        v = np.asarray(nav.v_eci, dtype=float)

        # Online re-planning every replan_period seconds, but frozen inside
        # the final approach range: rebuilding the Bezier on a shrinking
        # time-to-go makes the curve degenerate and its curvature term blow
        # up just before handover.  Before that range the target is on a
        # straight cruise course, so the frozen path stays valid.
        r_t_now = self.target_position(target_state)
        R_now = MU.norm3(r_t_now - r)
        need_replan = self.path is None or (
            (t - self.t_replan) >= self.replan_period
            and R_now > C.MIDCOURSE_FREEZE_RANGE)
        if need_replan:
            new_path, _ = self._build_path(nav, target_state)
            self.path = new_path
            self.t_path0 = float(t)
            self.t_replan = float(t)

        duration = self.path.duration
        s = float(np.clip((t - self.t_path0) / duration, 0.0, 1.0))

        # Look-ahead point ~30 km along the curve to avoid chasing the current point.
        path_span = max(MU.norm3(self.path.p[3] - self.path.p[0]), 1.0)
        s_look = float(np.clip(s + 30000.0 / path_span, 0.0, 1.0))
        pos_ref, tangent, acc_ref = self.path.evaluate(s_look)
        tangent = MU.normalize(tangent, fallback=MU.normalize(nav.v_eci))

        # PD tracking: position error plus velocity-direction error.  The
        # velocity reference uses the current speed so the missile is not
        # forced to accelerate instantaneously.
        w_vec = np.array([0.0, 0.0, C.OMEGA_EARTH])
        v_transport = MU.cross3(w_vec, r)
        speed = max(MU.norm3(v - v_transport), 300.0)
        vel_ref = v_transport + tangent * speed
        acc_ref = acc_ref / (duration ** 2)
        # The second Bezier derivative is scaled by 1/duration^2.  Near the
        # end of the run t_go shrinks, so an unclipped acc_ref would demand
        # tens of g and saturate alpha right before handover.  The curvature
        # feed-forward is a shaping term, not a hard constraint: bound it.
        acc_ref = MU.clip_norm(acc_ref, 1.5 * C.G0)
        a_bez = self.k1 * (pos_ref - r) + self.k2 * (vel_ref - v) + acc_ref
        a_cmd = a_bez.copy()

        # PN is applied towards a continuously re-predicted handover point,
        # not the frozen Bezier endpoint: the target keeps moving after the
        # path was planned, so aiming at p3 alone would slowly lose the lead
        # angle.  Using the live predicted intercept gives the midcourse a
        # lead angle and also makes the relative velocity in the PN
        # term physically consistent (the aim point moves with the target).
        pip, _ = self.lead_point(nav, target_state)
        rho = pip - r
        R_pip = MU.norm3(rho)
        # Preview the handover geometry: if the predicted lead angle is close
        # to the gate limit the PN term is stiffened slightly so the heading
        # is corrected while there is still range (not in the last 20 km).
        feas = self.handover_feasibility(nav, target_state)
        lead_frac = feas["lead_angle"] / max(C.HANDOVER_ANGLE_MAX, 1e-6)
        lead_excess = float(np.clip(
            (lead_frac - C.MIDCOURSE_FEASIBILITY_LEAD)
            / max(1.0 - C.MIDCOURSE_FEASIBILITY_LEAD, 1e-6), 0.0, 1.0))
        pn_gain = C.MIDCOURSE_PN_GAIN * (1.0 + 0.5 * lead_excess)
        if R_pip > 1.0:
            u_pip = rho / R_pip
            v_t = self.target_velocity(target_state)
            v_rel = v_t - v
            vc = max(-float(np.dot(v_rel, u_pip)), 100.0)
            omega = MU.cross3(rho, v_rel) / (R_pip * R_pip)
            a_cmd = a_cmd + pn_gain * vc * MU.cross3(omega, u_pip)

        # Energy management: decouple vertical and horizontal channels.  The
        # vertical channel follows a range-to-go altitude profile; the
        # horizontal channel keeps the Bezier/PN lateral term.
        up = MU.local_up(r)
        v_rel = MU.atmosphere_relative_velocity(r, v)
        V_air = max(MU.norm3(v_rel), 100.0)
        alt = MU.altitude(r)
        gamma = float(np.arcsin(np.clip(np.dot(v_rel, up) / V_air, -1.0, 1.0)))

        # Range-to-go altitude profile.  The airframe is lift-limited above
        # ~26 km at M10, so the cruise is q-held; at the descent entry range
        # the advantage actually held is captured, then the missile pulls up
        # (loft) and trades that height in a shaped dive.  The dive ends with
        # the desired handover flight-path angle, so the terminal loop starts
        # with the LOS already inside its lead-angle budget.
        r_t = self.target_position(target_state)
        R_los = MU.norm3(r_t - r)
        alt_t = MU.altitude(r_t)
        r_h = C.HANDOVER_RANGE
        dh_hand = max(C.MIDCOURSE_HANDOVER_DH,
                      C.MIDCOURSE_DESCENT_DH_TARGET)
        dh_now = alt - alt_t
        tan_desc = math.tan(C.MIDCOURSE_DESCENT_GAMMA)

        # Descent entry is derived from the altitude that actually has to be
        # removed (including the loft bump) at the feasible gradient.  Only a
        # fraction of the maximum slope is budgeted: the flight-path angle has
        # to be built up and the airframe does not use the full geometric
        # gradient on average.
        need_h = max(dh_now + C.MIDCOURSE_LOFT_DH - dh_hand, 0.0) \
            / max(0.35 * tan_desc, 1e-6)
        entry_range = min(
            C.MIDCOURSE_DESCENT_RANGE,
            max(C.HANDOVER_RANGE + need_h + C.MIDCOURSE_DESCENT_MARGIN,
                C.HANDOVER_RANGE + 20000.0))
        if self.descent_ref is None and R_los <= entry_range:
            self.descent_ref = (float(R_los), float(dh_now))
            self.descent_active = True

        if self.descent_active:
            dh_des, gamma_ff = self._loft_dive_profile(R_los)
            alt_err = (alt_t + dh_des) - alt
            gamma_corr = math.atan2(alt_err, max(R_los - r_h, 2000.0))
            gamma_des = gamma_ff + gamma_corr
        else:
            # Energy-optimal cruise: hold the dynamic pressure at which the
            # airframe sits near its best L/D (q ~ 75 kPa puts alpha at
            # 3-5 deg instead of the low-alpha/high-q corner).  A q error is
            # turned into a flight-path-angle command; the vertical-velocity
            # term below damps the resulting phugoid.
            atm = get_atmosphere(alt)
            q_dyn = 0.5 * atm.density * V_air * V_air
            q_err = q_dyn / max(C.MIDCOURSE_Q_CRUISE, 1.0) - 1.0
            gamma_des = float(np.clip(
                C.MIDCOURSE_Q_GAMMA_GAIN * q_err,
                -C.MIDCOURSE_GAMMA_LIMIT, C.MIDCOURSE_GAMMA_LIMIT))

        gamma_des = float(np.clip(gamma_des, -C.MIDCOURSE_DESCENT_GAMMA, 0.12))
        if alt < 15000.0 and not self.descent_active:
            # Post-boost climb-out: do not let the cruise profile pull the
            # missile down before it has reached cruise altitude.  The
            # restriction is disabled once the terminal descent has started.
            gamma_des = max(gamma_des, 0.06)
        vz_up = float(np.dot(v_rel, up))
        a_max = C.MIDCOURSE_DESCENT_ACC_MAX if self.descent_active else 1.5 * C.G0
        # In cruise the vertical-velocity damping reference is zero (it damps
        # the phugoid).  In the dive it is the profile's own climb rate:
        # damping towards zero there would fight a steady -9 deg glide (the
        # bias is >10 g) and the dive would never follow the command.
        vz_ref = V_air * math.sin(gamma_des) if self.descent_active else 0.0
        a_net = float(np.clip(0.5 * V_air * (gamma_des - gamma)
                              - C.MIDCOURSE_GAMMA_DAMP * (vz_up - vz_ref),
                              -a_max, a_max))
        a_vert = a_net + C.G0 * float(np.cos(gamma))
        a_h = MU.perpendicular(a_cmd, up)
        a_cmd = a_h + up * a_vert

        # Coplanar-handover constraint: the cross-plane channel is owned by
        # the ZEM controller, i.e. the Bezier/PN cross-plane component is
        # replaced (not augmented) so the two do not fight each other.  The
        # in-plane component keeps the normal range-closing guidance.
        a_cross = self.coplanar_bias(r, v, target_state)
        n_pl = self.plane_normal(target_state)
        if n_pl is not None:
            a_cmd = a_cmd - MU.dot3(a_cmd, n_pl) * n_pl
        a_cmd = a_cmd + a_cross

        # Angle-constrained guidance: track the profile's flight-path angle
        # with a terminal-time weighting, so the handover gamma is enforced
        # (not merely scheduled) despite autopilot lag and the q-hold
        # transient.  The gain grows as the handover approaches.
        v_t_now = self.target_velocity(target_state)
        u_los = MU.normalize(r_t - r)
        vc_los = max(-float(np.dot(v_t_now - v, u_los)), 100.0)
        t_h = max((R_los - r_h) / vc_los, C.HANDOVER_TGO_MIN)
        a_cmd = a_cmd + self.angle_constraint_bias(
            r, v, target_state, gamma_des, t_h)

        # Predictive terminal-error feedback: propagate both vehicles to the
        # predicted handover, evaluate the terminal ZEM there and remove part
        # of it now.  The lateral channel is used so it does not fight the
        # vertical loft-dive profile.
        a_cmd = a_cmd + self.predictive_terminal_error(r, v, target_state)

        # Cross-fade from the previous command over blend_time after a replan;
        # the first command of the run has no predecessor to fade from.
        if self.a_prev is not None:
            w = float(np.clip((t - self.t_replan) / max(self.blend_time, 1e-6),
                              0.0, 1.0))
            a_cmd = w * a_cmd + (1.0 - w) * self.a_prev
        self.a_prev = a_cmd.copy()

        a_cmd = MU.clip_norm(a_cmd, 5.0 * C.G0)
        return GuidanceCommand(a_cmd_eci=a_cmd, phase="midcourse")
