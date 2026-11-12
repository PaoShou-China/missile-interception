"""Target: 3DOF point-mass model with level cruise and terminal evasion.

Manoeuvres are defined in the local horizontal / wing plane and then mapped
to ECI, instead of applying sin(t) directly in a fixed ECI plane.

Ref: 3DOF point-mass target; local-horizontal manoeuvre decomposition.
"""

import math
import numpy as np
import config as C
import fastcore as FC
import math_utils as MU
from vehicle.atmosphere import get_atmosphere


class Target:
    def __init__(self, lat=C.TARGET_LAT, lon=C.TARGET_LON, alt=C.TARGET_ALT,
                 mach=C.TARGET_MACH, t0=0.0,
                 launch_lat=C.LAUNCH_LAT, launch_lon=C.LAUNCH_LON,
                 launch_alt=C.LAUNCH_ALT, evade_g=C.TARGET_EVADE_G,
                 evade_phase=C.TARGET_EVADE_PHASE,
                 maneuver_dist=C.TARGET_MANEUVER_DIST):
        self.evade_g = float(evade_g)
        self.evade_phase = float(evade_phase)
        self.maneuver_dist = float(maneuver_dist)
        atm = get_atmosphere(alt)
        # Flight-envelope ceiling: the airframe cannot exceed TARGET_MACH_MAX,
        # so any higher commanded cruise Mach is clamped instead of silently
        # producing an unattainable target.
        self.mach = min(max(float(mach), 0.0), C.TARGET_MACH_MAX)
        self.speed = self.mach * atm.sound_speed

        r0 = MU.llh_to_eci(lat, lon, alt, t0)
        # Head-on course: great-circle direction towards the launch site.
        r_launch = MU.llh_to_eci(launch_lat, launch_lon, launch_alt, t0)
        up0 = MU.local_up(r0)
        direction = MU.normalize(MU.perpendicular(r_launch - r0, up0))
        self.r0 = r0
        # Air-relative speed plus Earth transport velocity.
        w = np.array([0.0, 0.0, C.OMEGA_EARTH])
        self.v0 = self.speed * direction + np.cross(w, r0)

    # --------------------------------------------------------
    def initial_state(self):
        """Initial 6-state ``[r(3), v(3)]``."""
        return np.concatenate([self.r0, self.v0])

    # --------------------------------------------------------
    def _available_g(self, r, v):
        """Lift-limited load factor the wing can produce at the current q/Mach."""
        r = MU.as_vec3(r)
        v = MU.as_vec3(v)
        alt = max(MU.altitude(r), 0.0)
        atm = get_atmosphere(alt)
        w = np.array([0.0, 0.0, C.OMEGA_EARTH])
        v_air = MU.norm3(v - np.cross(w, r))
        mach = v_air / max(atm.sound_speed, 1e-6)
        if mach <= C.TARGET_CL_MACH_LO:
            cl_max = C.TARGET_CL_MAX_SUB
        elif mach >= C.TARGET_CL_MACH_HI:
            cl_max = C.TARGET_CL_MAX_SUP
        else:
            bw = ((mach - C.TARGET_CL_MACH_LO)
                  / (C.TARGET_CL_MACH_HI - C.TARGET_CL_MACH_LO))
            cl_max = (C.TARGET_CL_MAX_SUB
                      + bw * (C.TARGET_CL_MAX_SUP - C.TARGET_CL_MAX_SUB))
        q = 0.5 * atm.density * v_air * v_air
        return float(q * C.TARGET_WING_AREA * cl_max / (C.TARGET_MASS * C.G0))

    def _lift_limited_g(self, r, v):
        """Commanded evasion load factor capped by available wing lift.

        A 9 g design limit cannot be pulled at 15 km / Ma 1.6 (~21 kPa), where
        the wing only produces ~2-3 g.  The cap is Mach- and q-dependent, so
        the design limit is still available at low altitude / high Mach.
        """
        return float(min(max(self.evade_g, 0.0), self._available_g(r, v)))

    # --------------------------------------------------------
    def acceleration(self, t, r, v, missile_pos):
        """Target acceleration in ECI.

        Mission behaviour, driven by the current range to the missile:

        - beyond 60 km: level ingress cruise on the great-circle course;
        - 60 km .. 15 km: defensive reaction.  The fighter beams the incoming
          missile (turns to put it on the wing line) and dives to build energy;
          the turn authority fades once the threat is beamed, and the dive
          stops at ``TARGET_DESCENT_GAMMA`` below the horizon;
        - inside 15 km: terminal 0.25 Hz jink, lift-limited and lagged by the
          manoeuvre-onset time constant.

        Every manoeuvre costs induced drag, so the target bleeds speed instead
        of cruising at a constant Mach.
        """
        r = MU.as_vec3(r)
        v = MU.as_vec3(v)
        up = MU.local_up(r)
        # Constant-altitude flight follows a curved ECI path; the required
        # centripetal acceleration is based on the inertial speed, not the
        # air-relative speed.
        speed = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
        rn = math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
        a = -up * (speed * speed / max(rn, 1.0))
        # Gravity along the flight path: a dive trades altitude for speed, a
        # climb costs it.  Applied along the air-relative velocity (the air
        # frame is what the wing flies in), zero in level cruise.
        w_rot = np.array([0.0, 0.0, C.OMEGA_EARTH])
        v_air_vec = v - np.cross(w_rot, r)
        v_air_n = MU.norm3(v_air_vec)
        if v_air_n > 1e-9:
            sin_gamma = float(np.dot(v_air_vec, up)) / v_air_n
            a = a - C.G0 * sin_gamma * (v_air_vec / v_air_n)
        # Maneuver directions are built from the air-relative velocity: the
        # wing flies in the air frame, and using the inertial heading would
        # change the airspeed purely through Earth-transport geometry.
        v_hat = MU.normalize(
            v_air_vec, fallback=MU.normalize(MU.cross3(up, np.array([0.0, 0.0, 1.0]))))

        r_m = MU.as_vec3(missile_pos)
        dist = MU.norm3(r_m - r)
        n_man = 0.0
        a_man = np.zeros(3)
        if dist < self.maneuver_dist:
            e_cross = MU.normalize(MU.cross3(up, v_hat))
            n_cmd = self._lift_limited_g(r, v)
            amp = n_cmd * C.G0
            # Steady-state first-order onset lag on the weave (no extra state).
            w1 = 2.0 * math.pi * 0.25
            w2 = 2.0 * math.pi * 0.5
            tau = C.TARGET_MANEUVER_TAU
            h1 = 1.0 / math.sqrt(1.0 + (w1 * tau) ** 2)
            h2 = 1.0 / math.sqrt(1.0 + (w2 * tau) ** 2)
            ph1 = math.atan(w1 * tau)
            ph2 = math.atan(w2 * tau)
            a_man = amp * h1 * math.sin(w1 * t - ph1 + self.evade_phase) * e_cross
            a_man += 0.25 * amp * h2 * math.sin(
                w2 * t + 1.0 - ph2 + self.evade_phase) * -up
            n_man = n_cmd * math.sqrt(1.0 + 0.25 * 0.25)
        elif dist < C.TARGET_DEFEND_DIST:
            los = MU.normalize(r_m - r)
            # 1 = still flying at the threat, 0 = beamed / egressing.
            cos_head = float(np.dot(v_hat, los))
            gain = (cos_head - C.TARGET_BEAM_COS_LO) / (
                C.TARGET_BEAM_COS_HI - C.TARGET_BEAM_COS_LO)
            gain = min(max(gain, 0.0), 1.0)
            n_avail = self._available_g(r, v)
            # ``evade_g`` scales the whole defensive reaction, so 0 g means a
            # cooperative straight run (used by the 0 g suite case).
            frac = min(max(self.evade_g, 0.0), C.TARGET_DEFEND_G) / max(
                C.TARGET_DEFEND_G, 1e-9)
            n_turn = min(self.evade_g, C.TARGET_DEFEND_G, n_avail) * gain
            # Dive only until the flight-path angle reaches the limit.
            gamma = math.asin(min(max(float(np.dot(v_hat, up)), -1.0), 1.0))
            ramp = ((gamma + C.TARGET_DESCENT_GAMMA)
                    / (0.5 * C.TARGET_DESCENT_GAMMA))
            ramp = min(max(ramp, 0.0), 1.0)
            n_desc = min(C.TARGET_DESCENT_G, n_avail) * ramp * frac
            n_tot = math.hypot(n_turn, n_desc)
            if n_tot > n_avail and n_tot > 1e-9:
                s = n_avail / n_tot
                n_turn *= s
                n_desc *= s
                n_tot = n_avail
            e_notch = MU.normalize(MU.cross3(up, los))
            a_man = (n_turn * C.G0 * e_notch - n_desc * C.G0 * up)
            n_man = n_tot
        if n_man > 0.0:
            # Lift is perpendicular to the relative wind: remove any
            # along-track component so the manoeuvre cannot pump airspeed.
            a_man = a_man - float(np.dot(a_man, v_hat)) * v_hat
            a = a + a_man + self._induced_drag(r, v, n_man)
        return a

    # --------------------------------------------------------
    def _induced_drag(self, r, v, n_man):
        """Deceleration along the flight path from the manoeuvre's induced drag.

        ``n_man`` is the total manoeuvre load factor already being flown
        (weave, or defensive turn plus dive).  Thrust is trimmed for 1 g level
        flight, so only the increment ``k*(CL^2 - CL_trim^2)`` acts on speed.
        """
        r = MU.as_vec3(r)
        v = MU.as_vec3(v)
        alt = max(MU.altitude(r), 0.0)
        atm = get_atmosphere(alt)
        w = np.array([0.0, 0.0, C.OMEGA_EARTH])
        v_rel = v - np.cross(w, r)
        v_air = MU.norm3(v_rel)
        q_s = 0.5 * atm.density * v_air * v_air * C.TARGET_WING_AREA
        if q_s <= 1.0 or v_air <= 1e-6:
            return np.zeros(3)
        w_load = C.TARGET_MASS * C.G0 / q_s
        # CL_total^2 = 1 (weight support) + n_man^2 (manoeuvre), so the drag
        # increment over 1 g level flight is k*n_man^2*CL_trim^2.
        cl_trim = w_load
        ar = C.TARGET_SPAN * C.TARGET_SPAN / C.TARGET_WING_AREA
        k_ind = 1.0 / (math.pi * ar * C.TARGET_OSWALD_E)
        dcd = k_ind * (n_man * n_man) * cl_trim * cl_trim
        if dcd <= 0.0:
            return np.zeros(3)
        a_bleed = q_s * dcd / C.TARGET_MASS
        return -a_bleed * v_rel / v_air

    # --------------------------------------------------------
    def derivatives(self, t, state6, missile_pos, use_fast=None):
        """Six-state target derivative."""
        x = np.asarray(state6, dtype=float).reshape(6)
        if FC.NUMBA_AVAILABLE and use_fast is not False:
            out = FC.target_derivatives(
                float(t), np.ascontiguousarray(x),
                np.ascontiguousarray(np.asarray(missile_pos, dtype=float).reshape(3)),
                self.evade_g, self.maneuver_dist, self.evade_phase)
            if not np.all(np.isfinite(out)):
                raise FloatingPointError("Target derivative contains NaN/Inf at t=%.4f" % t)
            return out

        r = x[0:3]
        v = x[3:6]
        a = self.acceleration(t, r, v, missile_pos)
        out = np.concatenate([v, a])
        if not np.all(np.isfinite(out)):
            raise FloatingPointError("Target derivative contains NaN/Inf at t=%.4f" % t)
        return out
