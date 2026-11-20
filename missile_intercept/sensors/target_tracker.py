"""Target-state tracker: 9-state constant-acceleration Kalman filter.

The filter carries ``[r_t, v_t, a_t]`` in ECI.  Between measurements it
propagates the continuous white-noise-jerk constant-acceleration model, whose
discretised covariance terms are exact for the actual step (dt^5/20 ...
dt), so position, velocity and acceleration noise keep consistent units.  The
acceleration state is what the terminal APN feed-forward consumes, replacing a
noisy finite difference of the tracked velocity.

On a valid dual-mode lock, the seeker LOS unit vector and range are converted
to a Cartesian position measurement at the navigation-reported missile
position; the measurement covariance is anisotropic (range error along the
LOS, angular error growing with range across it).  Datalink fixes update
position and velocity directly.  Both updates use the Joseph form, which keeps
P symmetric and positive semi-definite under repeated floating-point updates.

This replaces the previous "guidance sees the target truth state" assumption:
midcourse/terminal/handover consume only ``estimate()``.
"""

import numpy as np

import config as C
import math_utils as MU


class TargetTracker(object):
    def __init__(self, initial_state, pos_sigma=C.TGT_TRACK_CUE_POS_SIGMA,
                 vel_sigma=C.TGT_TRACK_CUE_VEL_SIGMA,
                 acc_sigma=C.TGT_TRACK_CUE_ACC_SIGMA,
                 jerk_psd=C.TGT_TRACK_JERK_PSD,
                 noise_scale=1.0):
        x6 = np.asarray(initial_state, dtype=float).reshape(6)
        # Acceleration starts at zero with the full cue uncertainty; the first
        # measurements decide whether the target is in a manoeuvre.
        self._x = np.concatenate((x6, np.zeros(3)))
        self.P = np.diag([pos_sigma ** 2] * 3 + [vel_sigma ** 2] * 3
                         + [acc_sigma ** 2] * 3)
        self.jerk_psd = float(jerk_psd)
        self.noise_scale = float(noise_scale)
        self.t_last = None

    # --------------------------------------------------------
    @property
    def x(self):
        """Position/velocity state ``[r(3), v(3)]`` (acceleration excluded)."""
        return self._x[0:6]

    # --------------------------------------------------------
    def predict(self, t):
        """Propagate the CA mean and covariance with white-jerk noise.

        F is the position/velocity/acceleration transition of the continuous
        CA model; Q is its exact discretisation for the actual step, so the
        process noise enters with consistent units instead of being added to
        every state variance indiscriminately.
        """
        t = float(t)
        if self.t_last is None:
            self.t_last = t
            return
        dt = t - self.t_last
        if dt <= 0.0:
            return

        F = np.eye(9)
        dt2 = dt * dt
        for i in range(3):
            F[i, i + 3] = dt
            F[i, i + 6] = 0.5 * dt2
            F[i + 3, i + 6] = dt

        self._x = F.dot(self._x)
        self.P = F.dot(self.P).dot(F.T)

        # Continuous white-jerk (CA) process noise, discretised for dt.
        q = self.jerk_psd
        dt3 = dt2 * dt
        dt4 = dt3 * dt
        dt5 = dt4 * dt
        for i in range(3):
            self.P[i, i] += q * dt5 / 20.0
            self.P[i, i + 3] += q * dt4 / 8.0
            self.P[i + 3, i] += q * dt4 / 8.0
            self.P[i, i + 6] += q * dt3 / 6.0
            self.P[i + 6, i] += q * dt3 / 6.0
            self.P[i + 3, i + 3] += q * dt3 / 3.0
            self.P[i + 3, i + 6] += q * dt2 / 2.0
            self.P[i + 6, i + 3] += q * dt2 / 2.0
            self.P[i + 6, i + 6] += q * dt
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
        sigma_ang = np.sqrt(C.SEEKER_SIGMA_ANGLE ** 2 + sigma_glint ** 2) \
            * self.noise_scale
        sigma_lat = R * sigma_ang

        uu = np.outer(u, u)
        Rm = sigma_r ** 2 * uu + sigma_lat ** 2 * (np.eye(3) - uu)
        # With sensor noise disabled Rm is exactly zero; the covariance then
        # shrinks to zero over repeated perfect fixes and S becomes singular.
        # A tiny floor keeps the solve well-posed without biasing the update.
        floor = C.TGT_TRACK_COV_FLOOR
        Rm = Rm + floor * np.eye(3)

        # H selects position only, so H P H' = P[0:3, 0:3] and P H' = P[:, 0:3].
        P03 = self.P[:, 0:3]
        S = self.P[0:3, 0:3] + Rm
        K = np.linalg.solve(S, P03.T).T
        self._x = self._x + K.dot(z - self._x[0:3])

        IKH = np.eye(9)
        IKH[:, 0:3] -= K
        self.P = IKH.dot(self.P).dot(IKH.T) + K.dot(Rm).dot(K.T)
        self._stabilise()
        return True

    # --------------------------------------------------------
    def update_position_velocity(self, r_meas, v_meas, sigma_pos, sigma_vel):
        """Six-state Cartesian update (midcourse datalink / offboard track)."""
        z = np.concatenate((np.asarray(r_meas, dtype=float).reshape(3),
                            np.asarray(v_meas, dtype=float).reshape(3)))
        Rm = np.diag([sigma_pos ** 2] * 3 + [sigma_vel ** 2] * 3)
        # Same degenerate case as the LOS update when the noise scale is 0.
        Rm = Rm + C.TGT_TRACK_COV_FLOOR * np.eye(6)

        P06 = self.P[:, 0:6]
        S = self.P[0:6, 0:6] + Rm
        K = np.linalg.solve(S, P06.T).T
        self._x = self._x + K.dot(z - self._x[0:6])

        IKH = np.eye(9)
        IKH[:, 0:6] -= K
        self.P = IKH.dot(self.P).dot(IKH.T) + K.dot(Rm).dot(K.T)
        self._stabilise()
        return True

    # --------------------------------------------------------
    def _stabilise(self):
        """Symmetrise and floor the covariance so it can never go singular."""
        P = 0.5 * (self.P + self.P.T)
        floor = C.TGT_TRACK_COV_FLOOR
        for i in range(9):
            if P[i, i] < floor:
                P[i, i] = floor
        self.P = P

    # --------------------------------------------------------
    def estimate(self):
        """Current six-state estimate ``[r(3), v(3)]`` in ECI."""
        return self._x[0:6].copy()

    def position(self):
        return self._x[0:3].copy()

    def velocity(self):
        return self._x[3:6].copy()

    def acceleration(self):
        """Estimated target acceleration ``a(3)`` in ECI."""
        return self._x[6:9].copy()
