"""Discrete Mach-hold thrust controller for the ramjet sustainer (P law).

Control law
-----------
The solid booster is not throttleable, so the only control input is the
ramjet fuel-flow throttle ``u in [0, 1]``.  At the guidance rate the law is

    e = M_ref - M
    u = clip(Kp * e, 0, 1)

A proportional law leaves a small steady-state Mach droop because the
throttle has to balance drag at a non-zero error.  That static error is
accepted for this sustainer: it is bounded, and the droop is small for the
Mach errors encountered in cruise.

Additional elements:
- slew limit ``THROTTLE_RATE_MAX`` and a first-order fuel-system lag
  ``THROTTLE_TAU``, so the throttle cannot step instantaneously;
- envelope gating: outside the ramjet light-off/altitude envelope the
  throttle is driven to zero, giving a clean hand-off to unpowered glide;
- terminal override: once handover occurs the throttle opens fully so the
  endgame keeps as much energy as the remaining fuel allows;
- boost: the solid motor is full-on, so the ramjet throttle is held at 1.

The controller is sampled at the guidance rate and held (ZOH) between
updates; the 6DOF right-hand side only receives the resulting throttle.

Ref: Hacettepe-3loop (gain scheduling), Mach-hold proportional control.
"""

import config as C


class ThrustController:
    """Mach-hold proportional throttle law for the ramjet sustainer."""

    def __init__(self, mach_ref=None, kp=None, tau=None, rate_max=None):
        self.mach_ref = float(C.THRUST_MACH_REF if mach_ref is None else mach_ref)
        self.kp = float(C.THRUST_KP if kp is None else kp)
        self.tau = float(C.THROTTLE_TAU if tau is None else tau)
        self.rate_max = float(C.THROTTLE_RATE_MAX if rate_max is None else rate_max)
        self.reset()

    def reset(self):
        self.throttle = 1.0

    # --------------------------------------------------------
    @staticmethod
    def _ramjet_envelope(mach, altitude, q_dyn):
        return (C.RAMJET_MACH_MIN <= mach <= C.RAMJET_MACH_MAX
                and altitude < C.RAMJET_ALT_CUTOFF
                and q_dyn > C.RAMJET_Q_MIN)

    def update(self, dt, mach, altitude, q_dyn, phase, heat_flux_mw=0.0):
        """Return the throttle command in [0, 1].

        ``phase`` is the mission phase string ('boost' | 'midcourse' |
        'terminal').  During boost the solid motor is full-on.  During
        midcourse/terminal flight, a joint dynamic-pressure & aerothermal
        corridor smoothly throttles back the ramjet before structural/thermal
        limits (``CORRIDOR_Q_MAX`` / ``CORRIDOR_QDOT_MAX``) are exceeded.
        """
        dt = float(min(max(dt, 1e-5), 0.05))
        mach = float(mach)
        altitude = float(altitude)
        q_dyn = float(q_dyn)
        q_dot = max(float(heat_flux_mw), 0.0)

        if phase == "boost":
            self.throttle = 1.0
            return self.throttle

        if not self._ramjet_envelope(mach, altitude, q_dyn):
            target = 0.0
        else:
            if phase == "terminal":
                # Terminal phase prioritises energy unless corridor limits bind.
                target = 1.0
            else:
                err = self.mach_ref - mach
                target = min(max(self.kp * err, 0.0), 1.0)

            # Joint q_max / q_dot_max corridor cap: linearly tapers throttle
            # from 1 at SOFT onset to 0 at MAX ceiling so the vehicle does not
            # push full ramjet thrust into dense low-altitude air during dives.
            q_cap = 1.0
            if q_dyn > C.CORRIDOR_Q_SOFT:
                q_cap = max(
                    0.0,
                    (C.CORRIDOR_Q_MAX - q_dyn)
                    / max(C.CORRIDOR_Q_MAX - C.CORRIDOR_Q_SOFT, 1.0),
                )
            h_cap = 1.0
            if q_dot > C.CORRIDOR_QDOT_SOFT:
                h_cap = max(
                    0.0,
                    (C.CORRIDOR_QDOT_MAX - q_dot)
                    / max(C.CORRIDOR_QDOT_MAX - C.CORRIDOR_QDOT_SOFT, 1e-6),
                )
            target = min(target, q_cap, h_cap)

        # Fuel-system lag first, then slew-rate limit on the actual throttle.
        lagged = self.throttle + (dt / (self.tau + dt)) * (target - self.throttle)
        max_step = self.rate_max * dt
        step = min(max(lagged - self.throttle, -max_step), max_step)
        self.throttle += step
        self.throttle = min(max(self.throttle, 0.0), 1.0)
        return self.throttle
