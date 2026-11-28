"""Cruciform fin mixer: virtual (P, Y, R) -> four physical fins.

Mapping (positive-definition used elsewhere in the project):
    delta_right = delta_P + delta_R
    delta_left  = delta_P - delta_R
    delta_up    = delta_Y
    delta_down  = delta_Y

Actuator model
--------------
Second-order electromechanical servo (``wn = 2*pi*24 rad/s``, ``zeta = 0.7``)
integrated with 4 semi-implicit substeps per autopilot tick, enforcing slew-rate
saturation (150 deg/s) and high-dynamic-pressure hinge-moment deflection torque
derating above ``q_dyn > 400 kPa``.  ``is_saturated`` is fed back to the
autopilot anti-windup logic.

Ref: cruciform fin mixing; second-order electromechanical actuator + hinge
moment saturation engineering model.
"""

import math
import numpy as np
import config as C
import fastcore as FC
from config import ActuatorCommand


class FinMixer:
    def __init__(self, dt=C.DT_AUTOPILOT, tau=C.FIN_TAU,
                 rate_max=C.FIN_RATE_MAX, pos_max=C.FIN_MAX,
                 omega_n=C.FIN_OMEGA_N, zeta=C.FIN_ZETA):
        self.dt = float(dt)
        self.tau = float(tau)
        self.rate_max = float(rate_max)
        self.pos_max = float(pos_max)
        self.omega_n = float(omega_n)
        self.zeta = float(zeta)
        self.fins = np.zeros(4)
        self.fin_rates = np.zeros(4)
        self.saturated = False

    # --------------------------------------------------------
    def reset(self):
        self.fins = np.zeros(4)
        self.fin_rates = np.zeros(4)
        self.saturated = False

    # --------------------------------------------------------
    def effective_pos_max(self, q_dyn=0.0):
        """Hinge-moment limited maximum deflection at dynamic pressure ``q_dyn``."""
        if q_dyn > C.FIN_HINGE_Q_REF:
            scale = (C.FIN_HINGE_Q_REF / float(q_dyn)) ** C.FIN_HINGE_EXP
            if scale < C.FIN_HINGE_MIN_SCALE:
                scale = C.FIN_HINGE_MIN_SCALE
            return float(self.pos_max * scale)
        return float(self.pos_max)

    # --------------------------------------------------------
    def mix(self, virtual, dt=None, q_dyn=0.0):
        """Map virtual [delta_P, delta_Y, delta_R] (rad) to four physical fins."""
        dt = self.dt if dt is None else float(np.clip(dt, 1e-5, 0.05))
        d_p, d_y, d_r = np.asarray(virtual, dtype=float).reshape(3)
        q_val = float(q_dyn)

        if FC.NUMBA_AVAILABLE:
            v3 = np.ascontiguousarray(np.array([d_p, d_y, d_r], dtype=float))
            self.saturated = bool(FC.fin_mixer_mix(
                v3, self.fins, self.fin_rates, dt,
                self.omega_n, self.zeta, self.rate_max, self.pos_max, q_val))
            return ActuatorCommand(delta_fins=self.fins.copy(),
                                   is_saturated=self.saturated)

        target = np.array([
            d_y,            # up
            d_y,            # down
            d_p - d_r,      # left
            d_p + d_r,      # right
        ], dtype=float)

        pos_eff = self.effective_pos_max(q_val)
        h = dt * 0.25
        wn2 = self.omega_n * self.omega_n
        two_z_wn = 2.0 * self.zeta * self.omega_n
        rate_limited = False
        pos_limited = False

        for i in range(4):
            x = float(self.fins[i])
            v = float(self.fin_rates[i])
            tgt = float(target[i])
            for _ in range(4):
                acc = wn2 * (tgt - x) - two_z_wn * v
                v_raw = v + acc * h
                if abs(v_raw) > self.rate_max + 1e-12:
                    rate_limited = True
                if v_raw > self.rate_max:
                    v = self.rate_max
                elif v_raw < -self.rate_max:
                    v = -self.rate_max
                else:
                    v = v_raw
                x_raw = x + v * h
                if abs(x_raw) > pos_eff + 1e-12:
                    pos_limited = True
                if x_raw > pos_eff:
                    x = pos_eff
                    if v > 0.0:
                        v = 0.0
                elif x_raw < -pos_eff:
                    x = -pos_eff
                    if v < 0.0:
                        v = 0.0
                else:
                    x = x_raw
            self.fins[i] = x
            self.fin_rates[i] = v

        self.saturated = bool(rate_limited or pos_limited)
        return ActuatorCommand(delta_fins=self.fins.copy(),
                               is_saturated=self.saturated)
