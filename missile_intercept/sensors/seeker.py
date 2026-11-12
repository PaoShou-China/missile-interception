"""Dual-mode (radar + imaging-IR) seeker: 3D LOS measurements with FOV and blind zone.

Noise model
-----------
- Gaussian angle white noise;
- RCS glint noise (DTIC: sigma_glint ~ k * L_target / R);
- FOV +/-20 deg and a 200 m blind range.

Acquisition
-----------
The radar channel range scales with target RCS as sigma^(1/4), so a stealth
target is acquired late; the passive IIR channel does not depend on RCS and
restores a usable terminal window.  Lock is declared at the longer of the two.

Ref: DTIC-Glint (glint error versus target size and range).
"""

import math
import numpy as np
import config as C
import fastcore as FC
import math_utils as MU


class Seeker:
    def __init__(self, fov=C.SEEKER_FOV, blind=C.SEEKER_BLIND_RANGE,
                 sigma_angle=C.SEEKER_SIGMA_ANGLE, seed=1, noise_scale=1.0,
                 lock_range=None, ir_lock_range=None,
                 swerling=C.SEEKER_SWERLING,
                 dropout_rate=C.SEEKER_DROPOUT_RATE,
                 false_lock_rate=C.SEEKER_FALSE_LOCK_RATE):
        self.fov = float(fov)
        self.blind = float(blind)
        self.sigma_angle = float(sigma_angle)
        self.noise_scale = float(noise_scale)
        self.swerling = bool(swerling)
        self.dropout_rate = float(dropout_rate)
        self.false_lock_rate = float(false_lock_rate)
        # Radar range equation: R ~ sigma^(1/4) around the reference point.
        self.radar_lock_range = float(C.SEEKER_LOCK_RANGE_REF * (
            max(C.TARGET_RCS, 1e-9) / C.SEEKER_REF_RCS) ** 0.25)
        self.ir_lock_range = float(
            C.SEEKER_IR_LOCK_RANGE if ir_lock_range is None else ir_lock_range)
        # Dual-mode: either channel can acquire; the longer one sets the gate.
        if lock_range is None:
            lock_range = max(self.radar_lock_range, self.ir_lock_range)
        self.lock_range = float(lock_range)
        self.rng = np.random.RandomState(seed)
        self._rng_state = FC.make_rng_state(seed)
        self._rate = np.zeros(3)
        self.rate_filtered = np.zeros(3)
        self.fov_angle = math.pi
        self.initialized = False
        self._t_last = 0.0
        # False detections must persist for several consecutive scans before
        # they are reported as a lock; a physical detection is trusted at once.
        self._false_streak = 0
        self._was_physical = False
        self.is_confirmed = False
        self._los_filt = None

    # --------------------------------------------------------
    def _scan_lock_range(self):
        """Per-scan lock range with Swerling-I RCS fluctuation."""
        if not self.swerling or self.noise_scale <= 0.0:
            return self.lock_range
        u = float(self.rng.uniform(1e-9, 1.0))
        rcs = C.TARGET_RCS * (-math.log(u))      # exponential, mean TARGET_RCS
        radar = C.SEEKER_LOCK_RANGE_REF * (
            max(rcs, 1e-12) / C.SEEKER_REF_RCS) ** 0.25
        return max(radar, self.ir_lock_range)

    def _smooth_los(self, u):
        """First-order smoothing of the measured LOS to suppress glint.

        The filter is reset whenever a physical lock is (re)acquired so it
        cannot carry a stale or false LOS into the new track.
        """
        if self.noise_scale <= 0.0:
            return u
        u = MU.normalize(np.asarray(u, dtype=float))
        if self._los_filt is None:
            self._los_filt = u.copy()
        else:
            alpha = float(np.clip(C.DT_SEEKER / max(C.SEEKER_LOS_TAU, 1e-6),
                                  0.0, 1.0))
            self._los_filt = MU.normalize(
                self._los_filt + alpha * (u - self._los_filt))
        return self._los_filt.copy()

    # --------------------------------------------------------
    def _detection_events(self, meas, dt):
        """Apply dropouts and false detections as Poisson events."""
        physical = bool(meas.is_locked)
        if physical and not self._was_physical:
            self._los_filt = None
        self._was_physical = physical

        if self.noise_scale <= 0.0:
            self._false_streak = 0
            self.is_confirmed = physical
            meas.is_locked = physical
            meas.confirmed = physical
            return meas

        dt = max(float(dt), C.DT_SEEKER)
        locked = physical
        if physical:
            self._false_streak = 0
            if self.dropout_rate > 0.0:
                p = 1.0 - math.exp(-self.dropout_rate * dt)
                if self.rng.rand() < p:
                    locked = False
        else:
            p = 1.0 - math.exp(-self.false_lock_rate * dt)
            if self.false_lock_rate > 0.0 and self.rng.rand() < p:
                self._false_streak += 1
            else:
                self._false_streak = 0
            # Only a *sustained* false return is allowed to report a lock.
            if self._false_streak >= C.SEEKER_FALSE_LOCK_CONFIRM:
                locked = True
                # False detection: rotate the reported LOS away from truth.
                u = MU.normalize(np.asarray(meas.los_angle, dtype=float))
                e1 = MU.normalize(MU.perpendicular(np.array([0.0, 0.0, 1.0]), u))
                e2 = MU.cross3(u, e1)
                ang = 0.35 * self.fov
                rot = e1 * math.cos(ang) + e2 * math.sin(ang)
                meas.los_angle = MU.normalize(u + 0.5 * rot)

        meas.is_locked = locked
        meas.confirmed = bool(locked)
        self.is_confirmed = bool(locked)
        meas.los_angle = self._smooth_los(meas.los_angle)
        return meas

    # --------------------------------------------------------
    def measure(self, t, r_m, v_m, q, r_t, v_t, body_x=None):
        """Return a noisy, FOV/blind-zone constrained SeekerMeasurement.

        Only the current body X axis is needed for the FOV test; it is taken
        directly from the attitude quaternion (``q``) instead of a cached
        DCM, so the boresight always matches the state at sample time.
        """
        if body_x is None:
            body_x = MU.quat_rotate(q, np.array([1.0, 0.0, 0.0]))
        lock_range = self._scan_lock_range()

        if FC.NUMBA_AVAILABLE:
            (u_meas, rate, range_meas, range_rate_meas, locked,
             fov_angle, _true_range, t_last, _) = FC.seeker_measure(
                float(t),
                np.ascontiguousarray(np.asarray(r_m, dtype=float).reshape(3)),
                np.ascontiguousarray(np.asarray(v_m, dtype=float).reshape(3)),
                np.ascontiguousarray(np.asarray(body_x, dtype=float).reshape(3)),
                np.ascontiguousarray(np.asarray(r_t, dtype=float).reshape(3)),
                np.ascontiguousarray(np.asarray(v_t, dtype=float).reshape(3)),
                self.fov, self.blind, lock_range, self.sigma_angle,
                self._rate, self._rng_state, self._t_last,
                1.0 if self.initialized else 0.0, self.noise_scale)
            self.rate_filtered = rate
            self.fov_angle = float(fov_angle)
            self.initialized = True
            self._t_last = float(t_last)
            meas = C.SeekerMeasurement(
                los_angle=u_meas,
                los_rate=rate.copy(),
                range=float(range_meas),
                range_rate=float(range_rate_meas),
                is_locked=bool(locked),
                fov_angle=float(fov_angle),
            )
            return self._detection_events(meas, C.DT_SEEKER)

        geo = MU.los_geometry(r_m, v_m, r_t, v_t)
        R = geo["range"]
        u = geo["u"]
        omega = geo["omega"]
        range_rate = geo["range_rate"]

        u_body_x = (body_x[0] * u[0] + body_x[1] * u[1]
                    + body_x[2] * u[2])
        self.fov_angle = float(math.acos(min(max(u_body_x, -1.0), 1.0)))

        # Angle glint grows as range decreases.
        sigma_glint = C.SEEKER_GLINT_K * C.TARGET_LENGTH / max(R, 1.0)
        sigma_tot = float(math.sqrt(self.sigma_angle ** 2 + sigma_glint ** 2)
                          * self.noise_scale)

        # e1 = u x z_axis = (u_y, -u_x, 0); e2 = u x e1.
        e1 = np.array([u[1], -u[0], 0.0])
        n1 = math.sqrt(e1[0] * e1[0] + e1[1] * e1[1])
        if n1 < 1e-9:
            e1 = np.array([1.0, 0.0, 0.0])
        else:
            e1 = e1 / n1
        e2 = np.array([
            u[1] * e1[2] - u[2] * e1[1],
            u[2] * e1[0] - u[0] * e1[2],
            u[0] * e1[1] - u[1] * e1[0],
        ])
        n1, n2 = self.rng.normal(0.0, sigma_tot, 2)
        u_meas = MU.normalize(u + n1 * e1 + n2 * e2)

        # LOS-rate first-order filter (tau ~ 20 ms) suppresses noise.
        omega_meas = omega + self.rng.normal(0.0, sigma_tot / 0.02, 3)
        dt = max(t - self._t_last, C.DT_SEEKER) if self.initialized else C.DT_SEEKER
        alpha = float(np.clip(dt / 0.02, 0.0, 1.0))
        if not self.initialized:
            self.rate_filtered = omega_meas.copy()
            self.initialized = True
        else:
            self.rate_filtered = self.rate_filtered + alpha * (omega_meas - self.rate_filtered)
        self._t_last = float(t)

        rng_noisy = max(R + self.rng.normal(0.0, C.SEEKER_RANGE_SIGMA
                                            * self.noise_scale), 0.0)
        rr_noisy = range_rate + self.rng.normal(
            0.0, C.SEEKER_RANGE_RATE_SIGMA * self.noise_scale)

        is_locked = bool(self.fov_angle <= self.fov
                         and self.blind < R <= lock_range)
        meas = C.SeekerMeasurement(
            los_angle=u_meas,
            los_rate=self.rate_filtered.copy(),
            range=float(rng_noisy),
            range_rate=float(rr_noisy),
            is_locked=is_locked,
            fov_angle=self.fov_angle,
        )
        return self._detection_events(meas, C.DT_SEEKER)
