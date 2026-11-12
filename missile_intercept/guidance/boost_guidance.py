"""Boost guidance: cold-launch vertical rise -> gravity-turn pitch programme.

The booster is a non-throttleable solid motor (T/W ~ 5) followed by the
ramjet take-over, so the boost phase is flown as a gravity turn:

- the pitch programme is a flight-path-angle reference that is *rate-limited
  by the normal force the airframe can actually produce* at the current
  dynamic pressure (q*S*CN_alpha*alpha_max) plus the thrust-vector term
  T*sin(alpha_max).  A fixed pitch-rate programme is not feasible at low q
  and saturates the fins for the whole ascent;
- the programme stops at BOOST_GAMMA_HAND, the flight-path angle handed to
  the midcourse, instead of driving the missile horizontal at low altitude
  (that would spend the boost energy on drag and leave a long climb);
- the normal-acceleration command includes the gravity compensation
  V*gamma_dot + g*cos(gamma), and the aero part is derated by the thrust
  normal component T/(q*S*CN_alpha) so the thrust vector is not double
  counted;
- azimuth is held on the target bearing with a separate lateral term.

Ref: gravity-turn ascent practice for tactical boosters; DTIC-ThrustAlt
altitude correction; USSA1976 atmosphere.
"""

import numpy as np
import config as C
import math_utils as MU
from guidance.base_guidance import BaseGuidance
from config import GuidanceCommand
from vehicle.atmosphere import get_atmosphere
from vehicle.missile import boost_thrust_scale, cn_alpha, ramjet_efficiency


class BoostGuidance(BaseGuidance):
    name = "boost"

    def __init__(self, t_vertical=C.BOOST_VERTICAL_TIME,
                 gamma_hand=C.BOOST_GAMMA_HAND,
                 alpha_max=C.BOOST_ALPHA_MAX,
                 pitch_rate_max=C.BOOST_PITCH_RATE_MAX,
                 gamma_gain=C.BOOST_GAMMA_GAIN,
                 heading_gain=C.BOOST_HEADING_GAIN,
                 accel_limit=C.BOOST_ACCEL_LIMIT):
        self.t_vertical = float(t_vertical)
        self.gamma_hand = float(gamma_hand)
        self.alpha_max = float(alpha_max)
        self.pitch_rate_max = float(pitch_rate_max)
        self.gamma_gain = float(gamma_gain)
        self.heading_gain = float(heading_gain)
        self.accel_limit = float(accel_limit)
        self.reset()

    def reset(self):
        self.t0 = None
        self.t_prev = None
        self.gamma_ref = 0.5 * np.pi
        self.gamma_dot_ref = 0.0

    # --------------------------------------------------------
    @staticmethod
    def _mass(t):
        """Propellant burn estimate: booster flow, then the ramjet take-over."""
        mdot_b = C.BOOST_FUEL / C.BOOST_BURN_TIME
        if t < C.BOOST_BURN_TIME:
            m = C.MASS0 - mdot_b * float(t)
        else:
            m = C.MASS0 - C.BOOST_FUEL - C.RAMJET_MDOT_MAX * (float(t) - C.BOOST_BURN_TIME)
        return max(m, C.DRY_MASS)

    @staticmethod
    def _thrust(t, mach, alt, q_dyn, atm):
        """Full-throttle thrust at the guidance instant (booster or ramjet)."""
        if t < C.BOOST_BURN_TIME:
            return (C.BOOST_THRUST_SL * boost_thrust_scale(t)
                    + C.NOZZLE_EXIT_AREA * (C.P_SL - atm.pressure))
        if (C.RAMJET_MACH_MIN <= mach <= C.RAMJET_MACH_MAX
                and q_dyn > C.RAMJET_Q_MIN and alt < C.RAMJET_ALT_CUTOFF):
            eta_m, eta_h = ramjet_efficiency(mach, alt)
            return min(C.RAMJET_COEFF * q_dyn * C.RAMJET_A_INLET * eta_m * eta_h,
                       C.RAMJET_THRUST_MAX)
        return 0.0

    # --------------------------------------------------------
    def compute(self, t, nav, target_state, q=None, seeker=None):
        if self.t0 is None:
            self.t0 = float(t)
            self.t_prev = float(t)
        elapsed = float(t) - self.t0
        dt = float(np.clip(float(t) - self.t_prev, C.DT_GUIDANCE, 0.05))
        self.t_prev = float(t)

        r = np.asarray(nav.r_eci, dtype=float)
        v = np.asarray(nav.v_eci, dtype=float)
        up = MU.local_up(r)
        alt = MU.altitude(r)

        # Vertical cold-launch rise: the autopilot holds the initial attitude.
        if elapsed < self.t_vertical:
            return GuidanceCommand(a_cmd_eci=np.zeros(3), phase="boost")

        # Air-relative flight path and heading (Earth rotation removed, as in
        # the midcourse energy management).
        v_rel = MU.atmosphere_relative_velocity(r, v)
        V = max(MU.norm3(v_rel), 1.0)
        gamma = float(np.arcsin(np.clip(np.dot(v_rel, up) / V, -1.0, 1.0)))
        h_hat = MU.normalize(MU.perpendicular(v_rel, up),
                             fallback=np.array([1.0, 0.0, 0.0]))

        # Target bearing in the local horizontal plane.
        r_t = self.target_position(target_state)
        h_dir = MU.normalize(MU.perpendicular(r_t - r, up), fallback=h_hat)

        # Current flight condition and full-throttle thrust.  The thrust
        # estimate only sizes the control budget; it is not a plant model.
        atm = get_atmosphere(alt)
        mach = V / max(atm.sound_speed, 1e-6)
        q_dyn = max(0.5 * atm.density * V * V, 1.0)
        mass = self._mass(elapsed)
        thrust = self._thrust(elapsed, mach, alt, q_dyn, atm)

        # Feasible lateral acceleration: aero normal force at the alpha budget
        # plus the thrust-vector component.  The pitch programme is limited to
        # this rate so the ascent never asks for a turn the missile cannot fly.
        cna = max(cn_alpha(mach), 0.5)
        a_alpha = q_dyn * C.S_REF * cna * self.alpha_max / mass
        a_thrust = thrust * float(np.sin(self.alpha_max)) / mass
        a_feasible = max(C.BOOST_TURN_MARGIN * (a_alpha + a_thrust), 1.0)

        rate_max = min(self.pitch_rate_max, a_feasible / V)
        gamma_prev = self.gamma_ref
        self.gamma_ref = max(self.gamma_hand, self.gamma_ref - rate_max * dt)
        self.gamma_dot_ref = (self.gamma_ref - gamma_prev) / dt

        # Required non-gravity normal acceleration: the centripetal term plus
        # the gravity component, so a zero command follows a gravity turn.
        e_gamma = self.gamma_ref - gamma
        a_perp = V * (self.gamma_dot_ref + self.gamma_gain * e_gamma) \
            + C.G0 * np.cos(gamma)

        # Azimuth hold (zero on the nominal great circle, so the ascent stays
        # in the vertical plane that contains the target).
        e_head = float(np.arctan2(np.dot(MU.cross3(h_hat, h_dir), up),
                                  np.clip(np.dot(h_hat, h_dir), -1.0, 1.0)))
        a_head = V * self.heading_gain * e_head

        # One lateral budget for both channels.
        a_mag = float(np.hypot(a_perp, a_head))
        if a_mag > a_feasible:
            scale = a_feasible / a_mag
            a_perp *= scale
            a_head *= scale

        # The autopilot produces the aero part only; the thrust has an equal
        # normal component T*sin(alpha) at the same alpha, so derate the aero
        # command to avoid double counting the turn.
        denom = 1.0 + thrust / max(q_dyn * C.S_REF * cna, 1.0)
        a_perp /= denom
        a_head /= denom

        # Climb direction (in the vertical plane) and heading direction.
        e_climb = -np.sin(gamma) * h_hat + np.cos(gamma) * up
        e_head_dir = MU.cross3(up, h_hat)
        a_cmd = a_perp * e_climb + a_head * e_head_dir

        # Low-altitude safety pull-up.
        if alt < 500.0:
            a_cmd = a_cmd + 1.5 * C.G0 * up

        a_cmd = MU.clip_norm(a_cmd, self.accel_limit)
        return GuidanceCommand(a_cmd_eci=a_cmd, phase="boost")
