"""Wind field: mean wind with power-law shear plus Dryden turbulence.

The mean wind is generated in the local ENU frame at the vehicle position and
returned in ECI, so it is subtracted from the air-relative velocity exactly
where the aerodynamics needs it.  Speed follows a power law above
``WIND_REF_ALT``; turbulence is a first-order Gauss-Markov (Dryden-like)
process with separate horizontal and vertical rms values.

The field is sampled once per outer step and held (ZOH), matching how the rest
of the sampled-data loop consumes sensor and actuator data.
"""

import math
import numpy as np

import config as C
import math_utils as MU


class WindModel(object):
    def __init__(self, seed=C.WIND_SEED, enabled=True, noise_scale=1.0):
        self.enabled = bool(enabled)
        self.scale = float(noise_scale)
        self.rng = np.random.RandomState(int(seed))
        self.turb = np.zeros(3)          # local ENU turbulence, m/s
        self.t_last = None
        self._speed_h = float(C.WIND_REF_SPEED)
        self.heading = float(C.WIND_DIR_DEG) * C.DEG

    # --------------------------------------------------------
    def step(self, t, r_eci, dt=None):
        """Return the ECI wind velocity at ``r_eci`` (m/s)."""
        if not self.enabled or self.scale <= 0.0:
            return np.zeros(3)

        if dt is None:
            dt = 0.0 if self.t_last is None else max(float(t) - self.t_last, 0.0)
        dt = float(min(max(dt, 0.0), 0.5))
        self.t_last = float(t)

        lat, lon, alt = MU.eci_to_llh(r_eci, t)
        up = max(alt, 0.0)
        shear = (max(up, 1.0) / C.WIND_REF_ALT) ** C.WIND_SHEAR_EXP
        speed = self._speed_h * shear

        # Gauss-Markov turbulence update.
        phi = math.exp(-dt / max(C.WIND_TURB_TAU, 1e-6))
        sig = math.sqrt(max(1.0 - phi * phi, 0.0)) * self.scale
        self.turb[0] = phi * self.turb[0] + self.rng.normal(
            0.0, C.WIND_TURB_SIGMA_H * sig)
        self.turb[1] = phi * self.turb[1] + self.rng.normal(
            0.0, C.WIND_TURB_SIGMA_H * sig)
        self.turb[2] = phi * self.turb[2] + self.rng.normal(
            0.0, C.WIND_TURB_SIGMA_V * sig)

        enu = MU.local_enu_dcm(lat, lon, t)
        e_h = math.sin(self.heading)
        n_h = math.cos(self.heading)
        w_enu = np.array([
            speed * e_h + self.turb[0],
            speed * n_h + self.turb[1],
            self.turb[2],
        ])
        return enu.dot(w_enu)
