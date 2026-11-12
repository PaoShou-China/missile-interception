"""Target-state tracker: converted-measurement Kalman filter.

The filter carries ``[r_t, v_t]`` in ECI.  Between seeker updates it propagates
a constant-velocity model with white-acceleration process noise.  On a valid
dual-mode lock, the seeker LOS unit vector and range are converted to a
Cartesian position measurement at the navigation-reported missile position;
the measurement covariance is anisotropic (range error along the LOS, angular
error growing with range across it).

This replaces the previous "guidance sees the target truth state" assumption:
midcourse/terminal/handover consume only ``estimate()``.
"""

import math
import numpy as np
import config as C
import math_utils as MU


class TargetTracker(object):
    def __init__(self, initial_state, pos_sigma=C.TGT_TRACK_CUE_POS_SIGMA,
                 vel_sigma=C.TGT_TRACK_CUE_VEL_SIGMA,
                 acc_psd=C.TGT_TRACK_ACC_PSD,
                 noise_scale=1.0):
        self.x = np.asarray(initial_state, dtype=float).reshape(6).copy()
        self.P = np.diag([pos_sigma ** 2] * 3 + [vel_sigma ** 2] * 3)
        self.acc_psd = float(acc_psd)
        self.noise_scale = float(noise_scale)
        self.t_last = None
        self.updates = 0

    # --------------------------------------------------------
    def predict(self, t):
        """Coordinated level-flight propagation with process noise.

        A pure constant-velocity model ignores the centripetal acceleration of
        a cruising aircraft and drifts kilometres over a several-minute
        midcourse.  The mean therefore follows the same level-flight motion
        model used by air-traffic tracking (lift balances gravity); the
        covariance still uses a linear constant-velocity transition plus
        white-acceleration noise, which is conservative for the manoeuvre
        uncertainty.
        """
        t = float(t)
        if self.t_last is None:
            self.t_last = t
            return
        dt = t - self.t_last
        if dt <= 0.0:
            return

        r = self.x[0:3]
        v = self.x[3:6]
        rn = max(math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]), 1.0)
        # Level flight: centripetal acceleration uses the inertial speed.
        a_scale = -(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) / (rn * rn)
        self.x[0:3] = r + v * dt + 0.5 * dt * dt * a_scale * r
        self.x[3:6] = v + dt * a_scale * r

        # Block propagation of the 6x6 covariance (no dense 6x6 products).
        P = self.P
        P00 = P[0:3, 0:3]
        P01 = P[0:3, 3:6]
        P11 = P[3:6, 3:6]
        q = self.acc_psd ** 2
        P00n = P00 + dt * (P01 + P01.T) + (dt * dt) * P11
        P01n = P01 + dt * P11
        P11n = P11.copy()
        qc = q * dt * dt / 2.0
        for i in range(3):
            P00n[i, i] += q * dt ** 3 / 3.0
            P01n[i, i] += qc
            P11n[i, i] += q * dt
        P[0:3, 0:3] = P00n
        P[0:3, 3:6] = P01n
        P[3:6, 0:3] = P01n.T
        P[3:6, 3:6] = P11n
        self.t_last = t

    # --------------------------------------------------------
    def update(self, measurement, r_missile):
        """Convert LOS + range to a Cartesian position fix and update."""
        if measurement is None or not measurement.is_locked:
            return False
        R = float(measurement.range)
        u = np.asarray(measurement.los_angle, dtype=float).reshape(3)
        if R <= 0.0 or not np.all(np.isfinite(u)):
            return False
        u = MU.normalize(u)
        z = np.asarray(r_missile, dtype=float).reshape(3) + R * u

        sigma_r = C.SEEKER_RANGE_SIGMA * self.noise_scale
        sigma_glint = C.SEEKER_GLINT_K * C.TARGET_LENGTH / max(R, 1.0)
        sigma_ang = math.sqrt(C.SEEKER_SIGMA_ANGLE ** 2 + sigma_glint ** 2) \
            * self.noise_scale
        sigma_lat = R * sigma_ang

        uu = np.outer(u, u)
        Rm = sigma_r ** 2 * uu + sigma_lat ** 2 * (np.eye(3) - uu)
        # With sensor noise disabled Rm is exactly zero; the covariance then
        # shrinks to zero over repeated perfect fixes and S becomes singular.
        # A tiny floor keeps the solve well-posed without biasing the update.
        floor = C.TGT_TRACK_COV_FLOOR
        Rm = Rm + floor * np.eye(3)

        H = np.zeros((3, 6))
        H[:, 0:3] = np.eye(3)
        S = H.dot(self.P).dot(H.T) + Rm
        K = np.linalg.solve(S, H.dot(self.P)).T
        self.x = self.x + K.dot(z - H.dot(self.x))
        # Joseph form: numerically stable and keeps P positive semidefinite.
        A = np.eye(6) - K.dot(H)
        self.P = A.dot(self.P).dot(A.T) + K.dot(Rm).dot(K.T)
        self._stabilise()
        self.updates += 1
        return True

    # --------------------------------------------------------
    def update_position_velocity(self, r_meas, v_meas, sigma_pos, sigma_vel):
        """Six-state Cartesian update (midcourse datalink / offboard track)."""
        z = np.concatenate((np.asarray(r_meas, dtype=float).reshape(3),
                            np.asarray(v_meas, dtype=float).reshape(3)))
        Rm = np.diag([sigma_pos ** 2] * 3 + [sigma_vel ** 2] * 3)
        # Same degenerate case as the LOS update when the noise scale is 0.
        Rm = Rm + C.TGT_TRACK_COV_FLOOR * np.eye(6)
        S = self.P + Rm
        K = np.linalg.solve(S, self.P).T
        self.x = self.x + K.dot(z - self.x)
        A = np.eye(6) - K
        self.P = A.dot(self.P).dot(A.T) + K.dot(Rm).dot(K.T)
        self._stabilise()
        self.updates += 1
        return True

    # --------------------------------------------------------
    def _stabilise(self):
        """Symmetrise and floor the covariance so it can never go singular."""
        P = 0.5 * (self.P + self.P.T)
        floor = C.TGT_TRACK_COV_FLOOR
        for i in range(6):
            if P[i, i] < floor:
                P[i, i] = floor
        self.P = P

    # --------------------------------------------------------
    def estimate(self):
        """Current six-state estimate ``[r(3), v(3)]`` in ECI."""
        return self.x.copy()

    def position(self):
        return self.x[0:3].copy()

    def velocity(self):
        return self.x[3:6].copy()
