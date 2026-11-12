"""Handover manager: acquisition + energy + geometry gates, then a short blend.

Rationale
---------
The midcourse/terminal handover is the most sensitive event in the intercept:
before it the missile is flown by the (noisy) navigation solution, after it by
the seeker.  A handover that is too early hands the seeker an out-of-FOV
target; one that is too late leaves no time for the terminal transient.  The
gates therefore encode what each downstream element actually requires:

- ``range``      : target inside reliable seeker tracking range (40 km);
- ``fov``        : the seeker is not at the edge of its FOV (90 % of the half-
                   angle), otherwise lock is lost as the missile manoeuvres;
- ``lead_angle`` : the velocity vector is already close to the LOS, so the
                   terminal PN does not have to spend its energy on a large
                   heading correction right after handover;
- ``t_go``       : enough time remains that the short midcourse->terminal
                   cross-fade finishes before impact;
- ``overload``   : the airframe still has enough available lateral authority
                   at the handover altitude/Mach.  The instantaneous PN
                   demand is reported as a diagnostic, but it is not a hard
                   gate: before handover that expression can exceed the
                   airframe limit even when the endgame is feasible;
- ``altitude_diff``: a look-down advantage is kept, but bounded: too little
                   means no energy for the dive, too much means an excessive
                   depression angle and ground clutter for a sea-skimming
                   target;
- ``speed`` and ``seeker_lock`` are hard acquisition/energy gates.

A 0.2 s dwell prevents a single noisy sample from triggering handover.  A
range floor forces handover if the elevation gate cannot be met (e.g. a
target that has climbed above the missile), so the missile never runs past
the seeker into the blind zone while still in midcourse mode.
"""

import math
import numpy as np
import config as C
import math_utils as MU


class HandoverManager:
    def __init__(self, blend_time=None, dwell=None):
        # Resolve at call time so a tuning script can change C.HANDOVER_*
        # between cases without re-importing the module.
        self.blend_time = float(C.HANDOVER_BLEND_TIME
                                if blend_time is None else blend_time)
        self.dwell = float(C.HANDOVER_DWELL if dwell is None else dwell)
        self.triggered = False
        self.t_trigger = None
        self.t_gates_ok = None

    def reset(self):
        self.triggered = False
        self.t_trigger = None
        self.t_gates_ok = None

    # --------------------------------------------------------
    def check(self, t, missile_state, target_state, seeker, aero):
        """Return ``(is_ok, info)``; info holds every gate value for telemetry."""
        r_m = np.asarray(missile_state.r_eci, dtype=float)
        v_m = np.asarray(missile_state.v_eci, dtype=float)
        r_t = np.asarray(target_state[0:3], dtype=float)
        v_t = np.asarray(target_state[3:6], dtype=float)

        rho = r_t - r_m
        dist = MU.norm3(rho)
        u = MU.normalize(rho)
        alt_m = MU.altitude(r_m)
        alt_t = MU.altitude(r_t)
        dh = alt_m - alt_t
        speed = MU.norm3(v_m)
        lead_angle = MU.angle_between(v_m, u) if speed > 1.0 else np.pi
        range_rate = float(np.dot(v_t - v_m, u))
        t_go = dist / max(-range_rate, 1.0) if range_rate < 0.0 else np.inf

        q_dyn = float(aero.get("q_dyn", 0.0))
        cn_a = float(aero.get("CN_ALPHA", 2.0))
        alpha_max = 25.0 * C.DEG
        n_avail = q_dyn * C.S_REF * cn_a * alpha_max / \
            max(missile_state.mass * C.G0, 1e-6)
        # Required terminal load factor is reported for diagnostics but is
        # NOT used as a hard gate: before handover the PN expression is
        # evaluated on a geometry the terminal loop was never sized for, and
        # its instantaneous value (N*Vc*omega) can exceed the airframe limit
        # even when the terminal phase would be perfectly feasible.  The
        # practical gate is an absolute available-load floor: the airframe
        # must still have enough lateral authority left at the handover
        # altitude/Mach.
        geo = MU.los_geometry(r_m, v_m, r_t, v_t)
        vc_h = max(-float(geo["range_rate"]), 100.0)
        n_req = C.HANDOVER_N_PN * vc_h * \
            MU.norm3(geo["omega"]) / C.G0
        n_floor = C.HANDOVER_N_AVAIL_MIN

        fov_angle = float(seeker.fov_angle) if seeker is not None else np.pi
        locked = bool(seeker is not None and seeker.is_locked)
        confirmed = bool(getattr(seeker, "confirmed", locked))
        # A false detection rotates the reported LOS away from the tracked
        # bearing (and reports a range that may not match).  Both consistency
        # tests are only meaningful while a lock is claimed.
        los_err = np.pi
        range_err = 1.0
        if locked and seeker is not None:
            u_s = MU.normalize(np.asarray(seeker.los_angle, dtype=float))
            los_err = MU.angle_between(u_s, u)
            if dist > 1.0:
                range_err = abs(float(seeker.range) - dist) / dist
        consistent = (los_err <= C.HANDOVER_LOS_CONSISTENCY
                      and range_err <= C.HANDOVER_RANGE_CONSISTENCY)
        # Extrapolate the off-boresight angle over the forced-handover horizon
        # so the trigger can fire while the target is still inside the FOV
        # instead of exactly when the lock is lost.
        if seeker is not None and getattr(seeker, "los_rate", None) is not None:
            fov_rate = float(MU.norm3(np.asarray(seeker.los_rate, dtype=float)))
        else:
            fov_rate = 0.0
        fov_pred = fov_angle + fov_rate * C.HANDOVER_FOV_PREDICT_TIME

        # Look-down gate: a fixed altitude advantage is replaced by a
        # depression-angle limit whose allowed height grows with range.  A low
        # target still above the descent profile at long range is therefore
        # not rejected for its height alone.
        dh_allow = max(C.HANDOVER_DH_MAX,
                       dist * math.tan(C.HANDOVER_DEPRESSION_MAX))

        gates = {
            "range": dist <= C.HANDOVER_RANGE,
            "fov": fov_angle <= C.HANDOVER_FOV_MARGIN * C.SEEKER_FOV,
            "lead_angle": lead_angle <= C.HANDOVER_ANGLE_MAX,
            "t_go": t_go >= C.HANDOVER_TGO_MIN,
            "overload": n_avail >= n_floor,
            "altitude_diff": C.HANDOVER_DH_MIN <= dh <= dh_allow,
            "speed": speed >= C.HANDOVER_SPEED_MIN,
            "seeker_lock": locked,
            "seeker_confirmed": confirmed,
            "los_consistency": consistent,
        }
        all_ok = bool(all(gates.values()))

        # Forced handover: if the nominal gates cannot be met but the missile
        # is already deep inside the acquisition range with a valid seeker
        # lock, hand over before the FOV grows past the seeker limit.  Speed,
        # lead angle and lock remain mandatory; the FOV gate accepts a target
        # that is currently inside the FOV or predicted to stay inside it for
        # the extrapolation horizon.
        # The forced path relaxes only the geometry/altitude gates; it must
        # never bypass the time, control-authority or lock-authenticity checks
        # (doing so allowed a false lock at 35 km to trigger handover).
        force = bool(
            not all_ok
            and dist <= C.HANDOVER_RANGE_FLOOR
            and gates["speed"] and gates["lead_angle"]
            and (gates["fov"] or fov_pred <= C.SEEKER_FOV)
            and gates["seeker_lock"] and gates["seeker_confirmed"]
            and gates["los_consistency"]
            and gates["t_go"] and gates["overload"]
            and (-5000.0 <= dh <= dh_allow + 5000.0))

        # Dwell: the nominal gates must hold continuously for HANDOVER_DWELL.
        if all_ok:
            if self.t_gates_ok is None:
                self.t_gates_ok = float(t)
            dwell_ok = (float(t) - self.t_gates_ok) >= self.dwell
        else:
            self.t_gates_ok = None
            dwell_ok = False

        is_ok = bool(dwell_ok or force)
        info = {
            "range": dist,
            "dh": dh,
            "speed": speed,
            "lead_angle": lead_angle,
            "fov_angle": fov_angle,
            "t_go": t_go,
            "n_avail": n_avail,
            "n_req": n_req,
            "gates": gates,
            "forced": force,
            "is_ok": is_ok,
            "los_err": float(los_err),
            "range_err": float(range_err),
            "confirmed": confirmed,
        }
        return is_ok, info

    # --------------------------------------------------------
    def update(self, t, is_ok, a_mid, a_term):
        """State-machine blend: after the gates pass, w falls from 1 to 0 over
        ``blend_time`` (0.5 s by default)."""
        if is_ok and not self.triggered:
            self.triggered = True
            self.t_trigger = float(t)

        if not self.triggered:
            return np.asarray(a_mid, dtype=float), False, 0.0

        elapsed = t - self.t_trigger
        w = float(np.clip(1.0 - elapsed / max(self.blend_time, 1e-6), 0.0, 1.0))
        a_cmd = w * np.asarray(a_mid, dtype=float) + (1.0 - w) * np.asarray(a_term, dtype=float)
        return a_cmd, True, w
