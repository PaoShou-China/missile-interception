"""Rate gyro + attitude propagation (no truth leakage into the control loop).

The gyro measurement is the true body rate plus a Gauss-Markov bias, white
noise, a scale-factor error and quantisation.  The attitude used by the
autopilot and the seeker boresight is propagated from this measurement with
``q <- q (x) exp(0.5 (w_meas) dt)``; the integrated truth quaternion is only
used by the dynamics and by telemetry.

Set ``SimConfig.ideal_attitude=True`` to bypass this module and reproduce the
previous truth-attitude loop.
"""

import math
import numpy as np

import config as C
import math_utils as MU


class IMU(object):
    def __init__(self, seed=C.IMU_SEED, noise_scale=1.0,
                 sigma=C.GYRO_SIGMA, bias=C.GYRO_BIAS,
                 bias_walk=C.GYRO_BIAS_WALK, bias_tau=C.GYRO_BIAS_TAU,
                 scale_err=C.GYRO_SCALE_ERR, quant=C.GYRO_QUANT):
        self.scale = float(noise_scale)
        self.sigma = float(sigma) * self.scale
        self.bias_walk = float(bias_walk) * self.scale
        self.bias_tau = max(float(bias_tau), 1e-6)
        self.scale_err = float(scale_err) * self.scale
        self.quant = float(quant)
        self.rng = np.random.RandomState(int(seed))
        self.b_gyro = self.rng.normal(0.0, float(bias) * self.scale, 3)
        self.scale_axis = 1.0 + self.rng.normal(
            0.0, self.scale_err, 3) if self.scale > 0.0 else np.ones(3)
        self.t_last = None

    # --------------------------------------------------------
    def gyro(self, omega_true, dt):
        """Measured body rate for one sample interval."""
        omega_true = np.asarray(omega_true, dtype=float).reshape(3)
        dt = float(min(max(dt, 0.0), 0.5))
        if dt > 0.0:
            phi = math.exp(-dt / self.bias_tau)
            self.b_gyro = (phi * self.b_gyro
                           + self.rng.normal(
                               0.0,
                               self.bias_walk * math.sqrt(max(1.0 - phi * phi, 0.0)),
                               3))
        w = omega_true * self.scale_axis + self.b_gyro
        if self.scale > 0.0:
            w = w + self.rng.normal(0.0, self.sigma, 3)
            if self.quant > 0.0:
                w = np.round(w / self.quant) * self.quant
        return w


class StarTracker(object):
    """Absolute attitude fix with a small alignment noise and occasional dropouts."""

    def __init__(self, sigma=C.STAR_ANGLE_SIGMA, seed=C.STAR_SEED,
                 noise_scale=1.0, dropout_rate=C.STAR_DROPOUT_RATE):
        self.sigma = float(sigma) * float(noise_scale)
        self.dropout_rate = float(dropout_rate)
        self.rng = np.random.RandomState(int(seed))

    def measure(self, q_true):
        """Return a noisy attitude fix, or ``None`` when the tracker is blinded."""
        if self._dropout():
            return None
        q = MU.quat_normalize(q_true)
        if self.sigma <= 0.0:
            return q
        err = self.rng.normal(0.0, self.sigma, 3)   # ECI small rotation
        return MU.quat_normalize(MU.quat_mul(MU.quat_exp(err, 1.0), q))

    def _dropout(self):
        if self.dropout_rate <= 0.0:
            return False
        return self.rng.rand() < self.dropout_rate


class AttitudeEstimator(object):
    """Gyro-propagated attitude with star and GNSS-velocity aiding.

    The star fix corrects the attitude and drives a PI estimate of the gyro
    bias; the GNSS course correction removes the heading component of the
    residual error.  The truth quaternion never enters the estimate except as
    the physical input of the star-tracker measurement model.
    """

    def __init__(self, q0, tau=C.ATT_AID_TAU, ki=C.ATT_BIAS_KI,
                 bias_max=C.ATT_BIAS_MAX):
        self.q = MU.quat_normalize(q0)
        self.b_g = np.zeros(3)
        self.tau = max(float(tau), 1e-3)
        self.ki = float(ki)
        self.bias_max = float(bias_max)

    def propagate(self, omega_meas, dt):
        """Advance the attitude with the bias-corrected measured rate."""
        self.q = MU.quat_propagate(self.q, omega_meas - self.b_g, dt)

    def star_update(self, q_meas, dt):
        """Absolute attitude correction plus gyro-bias integral."""
        qm = MU.quat_hemisphere(q_meas, self.q)
        dq = MU.quat_mul(qm, MU.quat_conj(self.q))
        if dq[0] < 0.0:
            dq = -dq
        e_eci = 2.0 * dq[1:4]
        e_body = MU.quat_rotate_inv(self.q, e_eci)
        k = 1.0 - math.exp(-float(dt) / self.tau)
        self.q = MU.quat_propagate(self.q, k * e_body, 1.0)
        self.b_g = np.clip(self.b_g - self.ki * e_body * float(dt),
                           -self.bias_max, self.bias_max)

    def course_update(self, v_eci, up_eci, beta, gain, beta_max):
        """Correct heading from the GNSS ground-track (small-sideslip only)."""
        if abs(float(beta)) > beta_max:
            return
        bx = MU.quat_rotate(self.q, np.array([1.0, 0.0, 0.0]))
        bh = MU.perpendicular(bx, up_eci)
        vh = MU.perpendicular(v_eci, up_eci)
        if MU.norm3(bh) < 1e-3 or MU.norm3(vh) < 1e-3:
            return
        bh = MU.normalize(bh)
        vh = MU.normalize(vh)
        err = math.atan2(MU.dot3(MU.cross3(bh, vh), up_eci),
                         MU.dot3(bh, vh))
        self.q = MU.quat_normalize(MU.quat_mul(
            MU.quat_exp(up_eci, gain * err), self.q))

