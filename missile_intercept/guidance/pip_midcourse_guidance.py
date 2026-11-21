"""Classical midcourse: q-hold cruise + direct PN to the predicted intercept.

Structure
---------
1. **Cruise** (range > ``PIP_MIDCOURSE_DESCENT_RANGE``): hold the design
   dynamic pressure with the same first-order q-hold law used by the reference
   midcourse, so both laws share the same energy-management physics.
2. **Descent** (inside that range): a proportional flight-path-angle command
   drives the missile from cruise altitude to the handover altitude above the
   target.  This is the textbook cruise-then-descend profile.
3. **Lateral channel**: PN toward the live predicted intercept point with the
   handover altitude offset (``MIDCOURSE_HANDOVER_DH``).

What is deliberately absent (this is the baseline): Bezier path shaping, the
loft-then-dive profile, the impact-angle/coplanar handover constraint, the
predictive terminal-error (ZEM) feedback and the feasibility-preview PN
stiffening.  The comparison therefore isolates *trajectory shaping and
terminal-error prediction*, not the basic energy management.

Ref: classical predicted-intercept-point midcourse guidance (Zarchan);
phugoid-damped q-hold cruise; proportional descent.
"""

import math
import numpy as np
import config as C
import math_utils as MU
from guidance.base_guidance import BaseGuidance
from config import GuidanceCommand
from vehicle.atmosphere import get_atmosphere


class PipMidcourseGuidance(BaseGuidance):
    """q-hold cruise + PN to the predicted intercept, no path shaping."""

    name = "midcourse_pip"

    def __init__(self, pn_gain=C.PIP_MIDCOURSE_PN_GAIN,
                 blend_time=C.PIP_MIDCOURSE_BLEND,
                 descent_range=C.PIP_MIDCOURSE_DESCENT_RANGE):
        self.pn_gain = float(pn_gain)
        self.blend_time = float(blend_time)
        self.descent_range = float(descent_range)
        self.a_prev = None
        self.t_prev = None

    def reset(self):
        self.a_prev = None
        self.t_prev = None

    # --------------------------------------------------------
    def compute(self, t, nav, target_state, q=None, seeker=None):
        r = np.asarray(nav.r_eci, dtype=float)
        v = np.asarray(nav.v_eci, dtype=float)
        r_t = self.target_position(target_state)
        v_t = self.target_velocity(target_state)

        # Lateral: PN toward the live predicted intercept point.
        pip, _ = self.handover_point(nav, target_state,
                                     C.MIDCOURSE_HANDOVER_DH)
        geo = MU.los_geometry(r, v, pip, v_t)
        u = geo["u"]
        vc = max(-float(geo["range_rate"]), 100.0)
        a_pn = self.pn_gain * vc * MU.cross3(geo["omega"], u)

        # Vertical: conventional cruise-then-descend channel.
        up = MU.local_up(r)
        v_air = MU.atmosphere_relative_velocity(r, v)
        V = max(MU.norm3(v_air), 100.0)
        alt = MU.altitude(r)
        alt_t = MU.altitude(r_t)
        gamma = float(np.arcsin(np.clip(float(np.dot(v_air, up)) / V,
                                        -1.0, 1.0)))
        R_los = MU.norm3(r_t - r)

        if R_los > self.descent_range:
            # Energy-optimal cruise: q error -> flight-path-angle command.
            atm = get_atmosphere(alt)
            q_dyn = 0.5 * atm.density * V * V
            q_err = q_dyn / max(C.MIDCOURSE_Q_CRUISE, 1.0) - 1.0
            gamma_des = float(np.clip(
                C.MIDCOURSE_Q_GAMMA_GAIN * q_err,
                -C.MIDCOURSE_GAMMA_LIMIT, C.MIDCOURSE_GAMMA_LIMIT))
            vz_ref = 0.0
            if alt < 15000.0:
                # Post-boost climb-out: do not dive before cruise altitude.
                gamma_des = max(gamma_des, 0.06)
        else:
            # Proportional descent to the handover altitude, slope-limited.
            dh_hand = max(C.MIDCOURSE_HANDOVER_DH,
                          C.MIDCOURSE_DESCENT_DH_TARGET)
            alt_err = (alt_t + dh_hand) - alt
            gamma_des = math.atan2(alt_err, max(R_los - C.HANDOVER_RANGE,
                                                2000.0))
            gamma_des = float(np.clip(gamma_des,
                                      -C.MIDCOURSE_DESCENT_GAMMA, 0.12))
            vz_ref = V * math.sin(gamma_des)

        a_net = float(np.clip(
            0.5 * V * (gamma_des - gamma)
            - C.MIDCOURSE_GAMMA_DAMP * (float(np.dot(v_air, up)) - vz_ref),
            -C.MIDCOURSE_DESCENT_ACC_MAX, 1.5 * C.G0))
        a_vert = a_net + C.G0 * math.cos(gamma)

        # Keep the PN lateral component; the vertical channel owns altitude.
        a_h = MU.perpendicular(a_pn, up)
        a_cmd = a_h + up * a_vert

        if self.a_prev is not None:
            w = float(np.clip((float(t) - self.t_prev)
                              / max(self.blend_time, 1e-6), 0.0, 1.0))
            a_cmd = w * a_cmd + (1.0 - w) * self.a_prev
        self.a_prev = a_cmd.copy()
        self.t_prev = float(t)

        a_cmd = MU.clip_norm(a_cmd, C.PIP_MIDCOURSE_ACC_MAX)
        return GuidanceCommand(a_cmd_eci=a_cmd, phase="midcourse")
