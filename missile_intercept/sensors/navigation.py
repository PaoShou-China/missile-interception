"""GNSS/INS navigation: six-state linear Kalman filter (position + velocity).

- 1 s: GNSS measurement update (white position/velocity noise);
- one IMU prediction per outer simulation step (default 5 ms);
- output is delayed by about 50 ms to model datalink / processing latency.

The covariance propagation uses explicit 3x3 blocks instead of dense 6x6
matrix products; this is the same linear model with roughly one third of the
arithmetic.

Ref: gnss-ins-sim IMU bias / angle random-walk order of magnitude.
"""

from collections import deque
import numpy as np
import config as C
import fastcore as FC


class NavigationSystem:
    def __init__(self, dt_gnss=C.DT_GNSS, delay=C.NAV_DELAY,
                 sigma_pos=C.GNSS_SIGMA_POS, sigma_vel=C.GNSS_SIGMA_VEL,
                 sigma_acc=C.IMU_SIGMA_ACC, seed=0, noise_scale=1.0,
                 ins_error_states=True):
        self.dt_gnss = float(dt_gnss)
        self.delay = float(delay)
        scale = float(noise_scale)
        self.sigma_pos = float(sigma_pos) * scale
        self.sigma_vel = float(sigma_vel) * scale
        self.sigma_acc = float(sigma_acc) * scale
        self.sigma_acc_q = max(float(sigma_acc), C.NAV_PROCESS_ACC)
        self.sigma_bias = float(C.IMU_BIAS_ACC) * scale
        self.sigma_bias_walk = float(C.IMU_BIAS_WALK) * scale
        self.bias_tau = max(float(C.IMU_BIAS_TAU), 1e-6)
        self.gyro_bias_tau = max(float(C.GYRO_BIAS_TAU), 1e-6)
        self.sigma_gbias = float(C.GYRO_BIAS) * scale
        self.sigma_gbias_walk = float(C.GYRO_BIAS_WALK) * scale
        self.ins = bool(ins_error_states)
        self.rng = np.random.RandomState(seed)
        self._rng_state = FC.make_rng_state(seed)

        n = 12 if self.ins else 6
        self.x = np.zeros(n)       # [r, v, b_a, b_g]
        self.P = np.eye(n) * 1e4
        self.b_acc = np.zeros(3)   # raw (true) accelerometer bias
        self.t_last = 0.0
        self.next_gnss = 0.0
        self.history = deque(maxlen=4000)   # (t, x) delay buffer
        self.initialized = False
        self.truth_meas = np.zeros(6)

    # --------------------------------------------------------
    def reset(self, t, r, v):
        # The INS is aligned from a GNSS fix, not from the simulation truth:
        # the initial position/velocity therefore carry receiver noise and the
        # covariance starts at the GNSS noise level rather than near zero.
        r = np.asarray(r, dtype=float)
        v = np.asarray(v, dtype=float)
        rn = r + self.rng.normal(0.0, self.sigma_pos, 3)
        vn = v + self.rng.normal(0.0, self.sigma_vel, 3)
        if self.ins:
            self.x = np.concatenate([rn, vn, np.zeros(3), np.zeros(3)])
            self.P = np.diag([self.sigma_pos ** 2] * 3
                             + [self.sigma_vel ** 2] * 3
                             + [self.sigma_bias ** 2] * 3
                             + [self.sigma_gbias ** 2] * 3)
        else:
            self.x = np.concatenate([rn, vn])
            self.P = np.diag([self.sigma_pos ** 2] * 3
                             + [self.sigma_vel ** 2] * 3)
        self.b_acc = self.rng.normal(0.0, self.sigma_bias, 3)
        self.t_last = float(t)
        self.next_gnss = float(t)
        self.history.clear()
        self.history.append((float(t), self.x.copy()))
        self.initialized = True

    # --------------------------------------------------------
    def _predict(self, dt, a_eci):
        """State and covariance prediction with a constant-acceleration model."""
        dt = float(min(max(dt, 0.0), 0.5))
        a = np.asarray(a_eci, dtype=float)

        self.x[0:3] += dt * self.x[3:6] + (0.5 * dt * dt) * a
        self.x[3:6] += dt * a

        P = self.P
        P00 = P[0:3, 0:3]
        P01 = P[0:3, 3:6]
        P10 = P[3:6, 0:3]
        P11 = P[3:6, 3:6]

        q_pos = (self.sigma_acc_q * dt * dt) ** 2 * 0.25
        q_vel = (self.sigma_acc_q * dt) ** 2

        P00_new = P00 + dt * (P01 + P10) + (dt * dt) * P11
        P01_new = P01 + dt * P11
        P11_new = P11.copy()

        P00_new[0, 0] += q_pos
        P00_new[1, 1] += q_pos
        P00_new[2, 2] += q_pos
        P11_new[0, 0] += q_vel
        P11_new[1, 1] += q_vel
        P11_new[2, 2] += q_vel

        P[0:3, 0:3] = P00_new
        P[0:3, 3:6] = P01_new
        P[3:6, 0:3] = P01_new.T
        P[3:6, 3:6] = P11_new

    def _update_gnss(self):
        """GNSS position/velocity update; H is the 6x6 identity."""
        S = self.P.copy()
        sp2 = self.sigma_pos ** 2
        sv2 = self.sigma_vel ** 2
        S[0, 0] += sp2
        S[1, 1] += sp2
        S[2, 2] += sp2
        S[3, 3] += sv2
        S[4, 4] += sv2
        S[5, 5] += sv2

        y = self.truth_meas - self.x
        # S is symmetric positive definite; solve(S, P).T == P @ inv(S).
        K = np.linalg.solve(S, self.P).T
        self.x = self.x + K.dot(y)
        self.P = self.P - K.dot(self.P)
        self.P = 0.5 * (self.P + self.P.T)

    def _predict9(self, dt, a_eci, phi, q_bias):
        """Twelve-state prediction fallback (r, v, b_a, b_g)."""
        dt = float(min(max(dt, 0.0), 0.5))
        a = np.asarray(a_eci, dtype=float) - self.x[6:9]
        phi_g = float(np.exp(-dt / self.gyro_bias_tau))

        self.x[0:3] += dt * self.x[3:6] + (0.5 * dt * dt) * a
        self.x[3:6] += dt * a
        self.x[6:9] *= phi
        self.x[9:12] *= phi_g

        F = np.eye(12)
        for i in range(3):
            F[i, 3 + i] = dt
            F[i, 6 + i] = -0.5 * dt * dt
            F[3 + i, 6 + i] = -dt
            F[6 + i, 6 + i] = phi
            F[9 + i, 9 + i] = phi_g
        Pn = F.dot(self.P).dot(F.T)
        q_pos = (self.sigma_acc_q * dt * dt) ** 2 * 0.25
        q_vel = (self.sigma_acc_q * dt) ** 2
        q_gb = (self.sigma_gbias_walk
                * np.sqrt(max(1.0 - phi_g * phi_g, 0.0))) ** 2
        for i in range(3):
            Pn[i, i] += q_pos
            Pn[3 + i, 3 + i] += q_vel
            Pn[6 + i, 6 + i] += q_bias
            Pn[9 + i, 9 + i] += q_gb
        self.P = 0.5 * (Pn + Pn.T)

    def _update_gnss9(self):
        """GNSS update with H = [I6 0 0] for the twelve-state filter."""
        R = np.zeros((6, 6))
        R[0:3, 0:3] = np.eye(3) * self.sigma_pos ** 2
        R[3:6, 3:6] = np.eye(3) * self.sigma_vel ** 2
        S = self.P[0:6, 0:6] + R
        K = np.linalg.solve(S, self.P[:, 0:6].T).T
        self.x = self.x + K.dot(self.truth_meas - self.x[0:6])
        self.P = self.P - K.dot(self.P[0:6, :])
        self.P = 0.5 * (self.P + self.P.T)

    def set_gyro_bias(self, b_meas):
        """Inject the star-aided gyro-bias estimate as a KF pseudo-measurement."""
        if not self.ins:
            return
        b = np.ascontiguousarray(np.asarray(b_meas, dtype=float).reshape(3))
        if FC.NUMBA_AVAILABLE:
            FC.nav_bias_update_ins(self.x, self.P, b, C.ATT_BIAS_SIGMA)
        else:
            R = np.eye(3) * C.ATT_BIAS_SIGMA ** 2
            S = self.P[9:12, 9:12] + R
            K = np.linalg.solve(S, self.P[:, 9:12].T).T
            self.x = self.x + K.dot(b - self.x[9:12])
            self.P = self.P - K.dot(self.P[9:12, :])
            self.P = 0.5 * (self.P + self.P.T)

    # --------------------------------------------------------
    def step(self, t, r_true, v_true, a_true_eci):
        """One outer-step call: predict, optional GNSS update, delayed output."""
        if not self.initialized:
            self.reset(t, r_true, v_true)

        dt = float(t - self.t_last)
        if dt > 0.0:
            # Correlated accelerometer bias: first-order Gauss-Markov with the
            # in-run stability as its stationary standard deviation.
            phi = float(np.exp(-dt / self.bias_tau))
            self.b_acc = (phi * self.b_acc
                          + self.rng.normal(0.0, self.sigma_bias_walk
                                            * np.sqrt(max(1.0 - phi * phi, 0.0)), 3))
            a_vec = np.ascontiguousarray(
                np.asarray(a_true_eci, dtype=float).reshape(3))
            if self.ins:
                phi_g = float(np.exp(-dt / self.gyro_bias_tau))
                q_bias = (self.sigma_bias_walk
                          * np.sqrt(max(1.0 - phi * phi, 0.0))) ** 2
                q_gb = (self.sigma_gbias_walk
                        * np.sqrt(max(1.0 - phi_g * phi_g, 0.0))) ** 2
                if FC.NUMBA_AVAILABLE:
                    FC.nav_predict_ins(self.x, self.P, dt, a_vec, self.b_acc,
                                       self.sigma_acc, self.sigma_acc_q,
                                       phi, phi_g, q_bias, q_gb,
                                       self._rng_state)
                else:
                    self._predict9(dt, a_vec + self.b_acc
                                   + self.rng.normal(0.0, self.sigma_acc, 3),
                                   phi, q_bias)
            elif FC.NUMBA_AVAILABLE:
                FC.nav_predict(
                    self.x, self.P, dt, a_vec,
                    self.sigma_acc, self.b_acc, self.sigma_acc_q,
                    self._rng_state)
            else:
                a_meas = (np.asarray(a_true_eci, dtype=float)
                          + self.rng.normal(0.0, self.sigma_acc, 3)
                          + self.b_acc)
                self._predict(dt, a_meas)
            self.t_last = float(t)

            if t + 1e-12 >= self.next_gnss:
                r_a = np.ascontiguousarray(
                    np.asarray(r_true, dtype=float).reshape(3))
                v_a = np.ascontiguousarray(
                    np.asarray(v_true, dtype=float).reshape(3))
                if self.ins:
                    if FC.NUMBA_AVAILABLE:
                        self.truth_meas = FC.nav_gnss_update_ins(
                            self.x, self.P, r_a, v_a,
                            self.sigma_pos, self.sigma_vel, self._rng_state)
                    else:
                        self.truth_meas = np.concatenate([
                            np.asarray(r_true, dtype=float)
                            + self.rng.normal(0.0, self.sigma_pos, 3),
                            np.asarray(v_true, dtype=float)
                            + self.rng.normal(0.0, self.sigma_vel, 3),
                        ])
                        self._update_gnss9()
                elif FC.NUMBA_AVAILABLE:
                    self.truth_meas = FC.nav_gnss_update(
                        self.x, self.P, r_a, v_a,
                        self.sigma_pos, self.sigma_vel, self._rng_state)
                else:
                    self.truth_meas = np.concatenate([
                        np.asarray(r_true, dtype=float) + self.rng.normal(0.0, self.sigma_pos, 3),
                        np.asarray(v_true, dtype=float) + self.rng.normal(0.0, self.sigma_vel, 3),
                    ])
                    self._update_gnss()
                self.next_gnss += self.dt_gnss
                if self.next_gnss < t:
                    self.next_gnss = t + self.dt_gnss

            self.history.append((float(t), self.x.copy()))

        # Delayed output: newest buffered state at or before t - delay.
        target_t = t - self.delay
        est = self.history[0][1]
        for th, xh in reversed(self.history):
            if th <= target_t + 1e-12:
                est = xh
                break

        return C.NavEstimate(
            r_eci=np.asarray(est[0:3], dtype=float).copy(),
            v_eci=np.asarray(est[3:6], dtype=float).copy(),
            timestamp=float(max(target_t, 0.0)),
        )
