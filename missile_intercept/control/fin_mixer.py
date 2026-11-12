"""Cruciform fin mixer: virtual (P, Y, R) -> four physical fins.

Mapping (positive-definition used elsewhere in the project):
    delta_right = delta_P + delta_R
    delta_left  = delta_P - delta_R
    delta_up    = delta_Y
    delta_down  = delta_Y

Processing order: rate limit -> first-order lag (tau ~ 0.02 s) -> position
limit.  ``is_saturated`` is fed back to the autopilot anti-windup logic.

Ref: cruciform fin mixing; fin rate/position saturation engineering model.
"""

import numpy as np
import config as C
import fastcore as FC
from config import ActuatorCommand


class FinMixer:
    def __init__(self, dt=C.DT_AUTOPILOT, tau=C.FIN_TAU,
                 rate_max=C.FIN_RATE_MAX, pos_max=C.FIN_MAX):
        self.dt = float(dt)
        self.tau = float(tau)
        self.rate_max = float(rate_max)
        self.pos_max = float(pos_max)
        self.fins = np.zeros(4)
        self.saturated = False

    # --------------------------------------------------------
    def reset(self):
        self.fins = np.zeros(4)
        self.saturated = False

    # --------------------------------------------------------
    def mix(self, virtual, dt=None):
        """Map virtual [delta_P, delta_Y, delta_R] (rad) to four physical fins."""
        dt = self.dt if dt is None else float(np.clip(dt, 1e-5, 0.05))
        d_p, d_y, d_r = np.asarray(virtual, dtype=float).reshape(3)

        if FC.NUMBA_AVAILABLE:
            v3 = np.ascontiguousarray(np.array([d_p, d_y, d_r], dtype=float))
            self.saturated = bool(FC.fin_mixer_mix(
                v3, self.fins, dt, self.tau, self.rate_max, self.pos_max))
            return ActuatorCommand(delta_fins=self.fins.copy(),
                                   is_saturated=self.saturated)

        # 1) Virtual -> physical target.
        target = np.array([
            d_y,            # up
            d_y,            # down
            d_p - d_r,      # left
            d_p + d_r,      # right
        ])

        # 2) Rate limit (100 deg/s).
        max_step = self.rate_max * dt
        delta = np.clip(target - self.fins, -max_step, max_step)
        rate_limited = bool(np.any(np.abs(target - self.fins) > max_step + 1e-12))

        # 3) First-order actuator lag (tau = 0.02 s).
        alpha = dt / (self.tau + dt)
        fins = self.fins + alpha * delta

        # 4) Position limit (25 deg).
        pos_limited = bool(np.any(np.abs(fins) > self.pos_max + 1e-12))
        fins = np.clip(fins, -self.pos_max, self.pos_max)

        self.fins = fins
        self.saturated = bool(rate_limited or pos_limited)
        return ActuatorCommand(delta_fins=fins.copy(), is_saturated=self.saturated)
