"""Target-state tracker: 3-model Interacting Multiple Model (IMM) Kalman filter.

Models
------
0. **CV (Constant Velocity / low-manoeuvre)** — fast acceleration decay
   (``tau = 0.5 s``, ``sigma_a = 1.5 m/s^2``); optimal during level ingress
   cruise and non-manoeuvring segments.
1. **CA / Singer (Correlated Acceleration)** — standard Gauss-Markov target
   acceleration (``tau = 2.2 s``, ``sigma_a = 14 m/s^2``); optimal during rapid
   oscillatory terminal weaves and reversals.
2. **3D CT (3D Coordinated Turn)** — estimates the instantaneous 3D angular
   turn-rate vector ``omega = (v x a) / ||v||^2`` and propagates velocity and
   acceleration by exact Rodrigues rotation; optimal during the 60 km defensive
   beaming turn and sustained banked evasion.

Between measurements, continuous-time Markov transition probabilities
``Pi(dt)`` mix the three hypotheses without step-size dependence.  On seeker
LOS/range + Doppler updates or midcourse datalink fixes, each model executes a
Joseph-form Kalman update and scores its Gaussian innovation log-likelihood to
update ``mode_probs = [p_cv, p_ca, p_ct]``, followed by moment-matched state
and covariance combination.  Mahalanobis outlier gating rejects measurements
only when all three models reject them, preserving responsiveness to abrupt
manoeuvres while blocking decoys and false locks.
"""

import math
import numpy as np

import config as C
import fastcore as FC
import math_utils as MU


def _rodrigues_matrix(axis, angle):
    """3x3 rotation matrix for rotation by ``angle`` (rad) about unit ``axis``."""
    kx, ky, kz = float(axis[0]), float(axis[1]), float(axis[2])
    c = math.cos(angle)
    s = math.sin(angle)
    omc = 1.0 - c
    return np.array([
        [c + kx * kx * omc,      kx * ky * omc - kz * s, kx * kz * omc + ky * s],
        [ky * kx * omc + kz * s, c + ky * ky * omc,      ky * kz * omc - kx * s],
        [kz * kx * omc - ky * s, kz * ky * omc + kx * s, c + kz * kz * omc],
    ], dtype=float)


def _singer_predict(x, P, dt, tau, sigma_a):
    """Exact 9-state Singer correlated-acceleration prediction step."""
    a_s = 1.0 / max(tau, 0.05)
    adt = a_s * dt
    e = math.exp(-adt)
    if adt > 1e-4:
        f_ra = (adt - 1.0 + e) / (a_s * a_s)
        f_va = (1.0 - e) / a_s
    else:
        f_ra = 0.5 * dt * dt * (1.0 - adt / 3.0)
        f_va = dt * (1.0 - 0.5 * adt)

    # Fast 3-block state propagation without constructing dense 9x9 zero entries.
    xn = np.empty(9, dtype=float)
    r = x[0:3]
    v = x[3:6]
    a = x[6:9]
    xn[0:3] = r + dt * v + f_ra * a
    xn[3:6] = v + f_va * a
    xn[6:9] = e * a

    F = np.eye(9)
    F[0, 3] = F[1, 4] = F[2, 5] = dt
    F[0, 6] = F[1, 7] = F[2, 8] = f_ra
    F[3, 6] = F[4, 7] = F[5, 8] = f_va
    F[6, 6] = F[7, 7] = F[8, 8] = e

    Pn = F.dot(P).dot(F.T)

    q_psd = 2.0 * a_s * (sigma_a * sigma_a)
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    dt5 = dt4 * dt
    q_rr = q_psd * dt5 / 20.0
    q_rv = q_psd * dt4 / 8.0
    q_ra = q_psd * dt3 / 6.0
    q_vv = q_psd * dt3 / 3.0
    q_va = q_psd * dt2 / 2.0
    q_aa = (sigma_a * sigma_a) * max(1.0 - e * e, 0.0)
    for i in range(3):
        Pn[i, i] += q_rr
        Pn[i, i + 3] += q_rv
        Pn[i + 3, i] += q_rv
        Pn[i, i + 6] += q_ra
        Pn[i + 6, i] += q_ra
        Pn[i + 3, i + 3] += q_vv
        Pn[i + 3, i + 6] += q_va
        Pn[i + 6, i + 3] += q_va
        Pn[i + 6, i + 6] += q_aa
    return xn, Pn


def _ct3d_predict(x, P, dt, sigma_a=9.0):
    """9-state 3D Coordinated Turn (CT) prediction via Rodrigues rotation."""
    r = x[0:3]
    v = x[3:6]
    a = x[6:9]
    v2 = float(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    # Instantaneous turn angular velocity vector omega = (v x a) / ||v||^2.
    w_vec = np.array([
        v[1] * a[2] - v[2] * a[1],
        v[2] * a[0] - v[0] * a[2],
        v[0] * a[1] - v[1] * a[0],
    ], dtype=float) / max(v2, 100.0)
    w_norm = math.sqrt(float(w_vec[0] * w_vec[0] + w_vec[1] * w_vec[1]
                             + w_vec[2] * w_vec[2]))
    # Cap unphysical turn rates (~0.5 rad/s ~ 25 g at M=1.6).
    if w_norm > 0.5:
        w_vec *= (0.5 / w_norm)
        w_norm = 0.5

    theta = w_norm * dt
    if theta <= 1e-4:
        return _singer_predict(x, P, dt, tau=5.5, sigma_a=sigma_a)

    axis = w_vec / w_norm
    R_rot = _rodrigues_matrix(axis, theta)
    # Mild turn-rate damping so coasting doesn't spiral indefinitely.
    damp = math.exp(-dt / 6.0)
    R_half = _rodrigues_matrix(axis, 0.5 * theta)

    xn = np.empty(9, dtype=float)
    v_mid = R_half.dot(v)
    xn[0:3] = r + v_mid * dt
    xn[3:6] = R_rot.dot(v)
    xn[6:9] = damp * R_rot.dot(a)

    # Consistent 9x9 transition block matrix.
    F = np.eye(9)
    F[0:3, 3:6] = R_half * dt
    F[0:3, 6:9] = 0.5 * dt * dt * np.eye(3)
    F[3:6, 3:6] = R_rot
    F[3:6, 6:9] = dt * R_half
    F[6:9, 6:9] = damp * R_rot

    Pn = F.dot(P).dot(F.T)
    a_s = 1.0 / 5.5
    q_psd = 2.0 * a_s * (sigma_a * sigma_a)
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    dt5 = dt4 * dt
    q_rr = q_psd * dt5 / 20.0
    q_rv = q_psd * dt4 / 8.0
    q_ra = q_psd * dt3 / 6.0
    q_vv = q_psd * dt3 / 3.0
    q_va = q_psd * dt2 / 2.0
    q_aa = (sigma_a * sigma_a) * max(1.0 - math.exp(-2.0 * a_s * dt), 0.0)
    for i in range(3):
        Pn[i, i] += q_rr
        Pn[i, i + 3] += q_rv
        Pn[i + 3, i] += q_rv
        Pn[i, i + 6] += q_ra
        Pn[i + 6, i] += q_ra
        Pn[i + 3, i + 3] += q_vv
        Pn[i + 3, i + 6] += q_va
        Pn[i + 6, i + 3] += q_va
        Pn[i + 6, i + 6] += q_aa
    return xn, Pn


class TargetTracker(object):
    """3-model IMM target tracker (CV + CA/Singer + 3D Coordinated Turn)."""

    _N_MODELS = 3
    _PROB_FLOOR = 0.02

    def __init__(self, initial_state, pos_sigma=C.TGT_TRACK_CUE_POS_SIGMA,
                 vel_sigma=C.TGT_TRACK_CUE_VEL_SIGMA,
                 acc_sigma=C.TGT_TRACK_CUE_ACC_SIGMA,
                 jerk_psd=C.TGT_TRACK_JERK_PSD,
                 maneuver_tau=C.TGT_TRACK_MANEUVER_TAU,
                 sigma_a=C.TGT_TRACK_SIGMA_A,
                 noise_scale=1.0):
        x6 = np.asarray(initial_state, dtype=float).reshape(6)
        x0 = np.concatenate((x6, np.zeros(3)))
        P0 = np.diag([pos_sigma ** 2] * 3 + [vel_sigma ** 2] * 3
                     + [acc_sigma ** 2] * 3)
        self._x = x0.copy()
        self.P = P0.copy()
        self._xs_buf = np.empty((self._N_MODELS, 9), dtype=np.float64)
        self._Ps_buf = np.empty((self._N_MODELS, 9, 9), dtype=np.float64)
        for j in range(self._N_MODELS):
            self._xs_buf[j] = x0
            self._Ps_buf[j] = P0
        self._xs = [self._xs_buf[j] for j in range(self._N_MODELS)]
        self._Ps = [self._Ps_buf[j] for j in range(self._N_MODELS)]
        self._imm_F = np.empty((9, 9), dtype=np.float64)
        self._imm_tmp = np.empty((9, 9), dtype=np.float64)
        self._imm_R = np.empty((3, 3), dtype=np.float64)
        self._imm_Rh = np.empty((3, 3), dtype=np.float64)
        # Initial prior: [CV, CA/Singer, 3D-CT] — start cruise-biased.
        self.mode_probs = np.array([0.50, 0.30, 0.20], dtype=float)
        self.jerk_psd = float(jerk_psd)
        self.maneuver_tau = max(float(maneuver_tau), 0.1)
        self.sigma_a = float(sigma_a)
        self.noise_scale = float(noise_scale)
        self.t_last = None
        self.seeker_updates = 0
        # Blom & Bar-Shalom IMM order: interact/mix BEFORE model prediction
        # after each measurement update, never right before likelihood scoring.
        self._need_mix = False
        self._mix_dt = 0.02

    # --------------------------------------------------------
    @property
    def x(self):
        """Combined position/velocity state ``[r(3), v(3)]``."""
        return self._x[0:6]

    # --------------------------------------------------------
    def _transition_matrix(self, dt):
        """Continuous-time Markov mode transition matrix over ``dt``."""
        # Asymmetric sojourn rates: cruise (CV) transitions readily into
        # manoeuvre (CA/CT) while active manoeuvre modes resist drifting back
        # into CV between seeker scans, preserving high-g acceleration lock.
        dt_c = max(float(dt), 0.0)
        p_out_cv = min(0.30 * dt_c, 0.14)
        p_out_man = min(0.18 * dt_c, 0.10)
        return np.array([
            [1.0 - p_out_cv,  0.55 * p_out_cv,  0.45 * p_out_cv],
            [0.30 * p_out_man, 1.0 - p_out_man, 0.70 * p_out_man],
            [0.30 * p_out_man, 0.70 * p_out_man, 1.0 - p_out_man],
        ], dtype=float)

    def _interact_mix(self, dt):
        """IMM interaction / hypothesis mixing step."""
        pi = self._transition_matrix(dt)
        mu = self.mode_probs
        c_bar = pi.T.dot(mu)
        c_bar = np.maximum(c_bar, 1e-12)
        c_bar /= np.sum(c_bar)

        x_mix = []
        P_mix = []
        for j in range(self._N_MODELS):
            w = (pi[:, j] * mu) / c_bar[j]
            xj = w[0] * self._xs[0] + w[1] * self._xs[1] + w[2] * self._xs[2]
            Pj = np.zeros((9, 9), dtype=float)
            for i in range(self._N_MODELS):
                dx = self._xs[i] - xj
                Pj += w[i] * (self._Ps[i] + np.outer(dx, dx))
            x_mix.append(xj)
            P_mix.append(0.5 * (Pj + Pj.T))
        self._xs = x_mix
        self._Ps = P_mix
        self.mode_probs = c_bar

    def _combine(self):
        """Moment-matched fusion of the 3 IMM hypotheses into ``(_x, P)``."""
        mu = self.mode_probs
        x_bar = mu[0] * self._xs[0] + mu[1] * self._xs[1] + mu[2] * self._xs[2]
        P_bar = np.zeros((9, 9), dtype=float)
        for j in range(self._N_MODELS):
            dx = self._xs[j] - x_bar
            P_bar += mu[j] * (self._Ps[j] + np.outer(dx, dx))
        self._x = x_bar
        self.P = self._stabilise_mat(P_bar)

    @staticmethod
    def _stabilise_mat(P):
        P = 0.5 * (P + P.T)
        floor = C.TGT_TRACK_COV_FLOOR
        for i in range(9):
            if P[i, i] < floor:
                P[i, i] = floor
        return P

    def _stabilise(self):
        self.P = self._stabilise_mat(self.P)

    def _update_mode_probs(self, log_liks):
        """Bayes update of mode probabilities with floor to prevent model death."""
        ll = np.asarray(log_liks, dtype=float)
        ll = ll - np.max(ll)
        # Temper extreme single-step log-likelihood ratios for smooth switching.
        ll = np.clip(ll, -12.0, 0.0)
        raw = self.mode_probs * np.exp(ll)
        s = float(np.sum(raw))
        if not np.isfinite(s) or s <= 1e-30:
            return
        mu = raw / s
        mu = np.maximum(mu, self._PROB_FLOOR)
        self.mode_probs = mu / float(np.sum(mu))

    # --------------------------------------------------------
    def predict(self, t):
        """Propagate all 3 IMM hypotheses (CV, CA/Singer, 3D-CT) to epoch ``t``.

        Per textbook Blom & Bar-Shalom IMM, hypothesis mixing executes once per
        measurement update cycle (inside ``update`` / ``update_position_velocity``)
        rather than repeatedly during open-loop coasting, preventing the CV
        hypothesis from diluting high-g acceleration estimates between scans.
        """
        t = float(t)
        if self.t_last is None:
            self.t_last = t
            return
        dt = t - self.t_last
        if dt <= 0.0:
            return

        if self._need_mix:
            self._interact_mix(self._mix_dt)
            self._need_mix = False
            self._mix_dt = 0.0
        self._mix_dt += dt

        if FC.NUMBA_AVAILABLE:
            for j in range(self._N_MODELS):
                if self._xs[j] is not self._xs_buf[j]:
                    self._xs_buf[j] = self._xs[j]
                    self._xs[j] = self._xs_buf[j]
                if self._Ps[j] is not self._Ps_buf[j]:
                    self._Ps_buf[j] = self._Ps[j]
                    self._Ps[j] = self._Ps_buf[j]
            FC.imm_predict_all(
                self._xs_buf, self._Ps_buf, self.mode_probs, float(dt),
                self.maneuver_tau, self.sigma_a, C.TGT_TRACK_COV_FLOOR,
                self._x, self.P,
                self._imm_F, self._imm_tmp, self._imm_R, self._imm_Rh)
            self.t_last = t
            return

        # Model 0: CV (fast acceleration decay, low process noise).
        self._xs[0], self._Ps[0] = _singer_predict(
            self._xs[0], self._Ps[0], dt, tau=0.6, sigma_a=2.0)
        # Model 1: CA / Singer (aggressive weave/jink acceleration model).
        self._xs[1], self._Ps[1] = _singer_predict(
            self._xs[1], self._Ps[1], dt,
            tau=self.maneuver_tau, sigma_a=self.sigma_a)
        # Model 2: 3D Coordinated Turn (Rodrigues turn propagation).
        self._xs[2], self._Ps[2] = _ct3d_predict(
            self._xs[2], self._Ps[2], dt, sigma_a=max(0.80 * self.sigma_a, 9.0))

        self._combine()
        self.t_last = t

    # --------------------------------------------------------
    def update(self, measurement, r_missile, v_missile=None):
        """Fuse seeker LOS + range (plus Doppler range-rate) across all 3 IMM models."""
        if measurement is None or not measurement.is_locked:
            return False
        R = float(measurement.range)
        u = np.asarray(measurement.los_angle, dtype=float).reshape(3)
        if R <= 0.0 or not np.all(np.isfinite(u)):
            return False
        u = MU.normalize(u)
        r_m = np.asarray(r_missile, dtype=float).reshape(3)
        z = r_m + R * u

        sigma_r = C.SEEKER_RANGE_SIGMA * self.noise_scale
        sigma_glint = C.SEEKER_GLINT_K * C.TARGET_LENGTH / max(R, 1.0)
        sigma_radome = C.SEEKER_RADOME_SLOPE * abs(
            float(getattr(measurement, "fov_angle", 0.0)))
        sigma_ang = math.sqrt(C.SEEKER_SIGMA_ANGLE ** 2
                              + sigma_glint ** 2
                              + sigma_radome ** 2) * self.noise_scale
        sigma_lat = R * sigma_ang

        uu = np.outer(u, u)
        floor = C.TGT_TRACK_COV_FLOOR
        Rm = sigma_r ** 2 * uu + sigma_lat ** 2 * (np.eye(3) - uu) + floor * np.eye(3)

        # Evaluate per-model innovations & Mahalanobis distances first.
        maha_list = []
        S_list = []
        innov_list = []
        for j in range(self._N_MODELS):
            Sj = self._Ps[j][0:3, 0:3] + Rm
            innov_j = z - self._xs[j][0:3]
            try:
                m2 = float(innov_j.dot(np.linalg.solve(Sj, innov_j)))
            except np.linalg.LinAlgError:
                m2 = 0.0
            maha_list.append(m2)
            S_list.append(Sj)
            innov_list.append(innov_j)

        # Reject outlier only if EVERY model rejects it (decoy/false-lock spike).
        if (self.noise_scale > 0.0 and self.seeker_updates >= 10
                and min(maha_list) > C.TGT_TRACK_GATE_CHI2):
            return False

        log_liks = np.zeros(self._N_MODELS, dtype=float)
        rr = getattr(measurement, "range_rate", None)
        use_rr = (v_missile is not None and rr is not None and np.isfinite(rr))
        if use_rr:
            v_m = np.asarray(v_missile, dtype=float).reshape(3)
            z_rr = float(rr) + float(np.dot(u, v_m))
            h_rr = np.zeros(9, dtype=float)
            h_rr[3:6] = u
            r_rr = (C.SEEKER_RANGE_RATE_SIGMA * self.noise_scale) ** 2 + floor

        for j in range(self._N_MODELS):
            Pj = self._Ps[j]
            xj = self._xs[j]
            Sj = Pj[0:3, 0:3] + Rm
            innov_j = z - xj[0:3]
            sign, logdet = np.linalg.slogdet(Sj)
            try:
                S_inv_innov = np.linalg.solve(Sj, innov_j)
                m2 = float(innov_j.dot(S_inv_innov))
            except np.linalg.LinAlgError:
                m2 = 0.0
            ll_j = -0.5 * (max(logdet, -50.0) + m2) if sign > 0 else -10.0

            Kj = np.linalg.solve(Sj, Pj[:, 0:3].T).T
            xj = xj + Kj.dot(innov_j)
            IKH = np.eye(9)
            IKH[:, 0:3] -= Kj
            Pj = self._stabilise_mat(IKH.dot(Pj).dot(IKH.T) + Kj.dot(Rm).dot(Kj.T))

            if use_rr:
                Ph = Pj.dot(h_rr)
                s_rr = float(h_rr.dot(Ph)) + r_rr
                if s_rr > 1e-12:
                    innov_rr = z_rr - float(h_rr.dot(xj))
                    m2_rr = (innov_rr * innov_rr) / s_rr
                    ll_j += -0.5 * (math.log(s_rr) + min(m2_rr, 25.0))
                    if (self.noise_scale <= 0.0 or self.seeker_updates < 10
                            or m2_rr <= C.TGT_TRACK_GATE_CHI2):
                        k_rr = Ph / s_rr
                        xj = xj + k_rr * innov_rr
                        ikh = np.eye(9) - np.outer(k_rr, h_rr)
                        Pj = self._stabilise_mat(
                            ikh.dot(Pj).dot(ikh.T) + r_rr * np.outer(k_rr, k_rr))

            self._xs[j] = xj
            self._Ps[j] = Pj
            log_liks[j] = ll_j

        self.seeker_updates += 1
        self._update_mode_probs(log_liks)
        self._combine()
        self._need_mix = True
        return True

    # --------------------------------------------------------
    def update_position_velocity(self, r_meas, v_meas, sigma_pos, sigma_vel,
                                 latency=0.0):
        """Six-state Cartesian update (midcourse datalink / offboard track)."""
        r_m = np.asarray(r_meas, dtype=float).reshape(3)
        v_m = np.asarray(v_meas, dtype=float).reshape(3)
        lat = max(float(latency), 0.0)
        if lat > 0.0:
            r_m = r_m + v_m * lat
            sp_eff = math.hypot(float(sigma_pos),
                                float(sigma_vel) * lat + 0.5 * 20.0 * lat * lat)
        else:
            sp_eff = float(sigma_pos)
        sv_eff = float(sigma_vel)
        z = np.concatenate((r_m, v_m))
        Rm = np.diag([sp_eff ** 2] * 3 + [sv_eff ** 2] * 3)
        Rm = Rm + C.TGT_TRACK_COV_FLOOR * np.eye(6)

        log_liks = np.zeros(self._N_MODELS, dtype=float)
        for j in range(self._N_MODELS):
            Pj = self._Ps[j]
            xj = self._xs[j]
            Sj = Pj[0:6, 0:6] + Rm
            innov_j = z - xj[0:6]
            sign, logdet = np.linalg.slogdet(Sj)
            try:
                m2 = float(innov_j.dot(np.linalg.solve(Sj, innov_j)))
            except np.linalg.LinAlgError:
                m2 = 0.0
            log_liks[j] = -0.5 * (max(logdet, -50.0) + m2) if sign > 0 else -10.0

            Kj = np.linalg.solve(Sj, Pj[:, 0:6].T).T
            xj = xj + Kj.dot(innov_j)
            IKH = np.eye(9)
            IKH[:, 0:6] -= Kj
            Pj = self._stabilise_mat(IKH.dot(Pj).dot(IKH.T) + Kj.dot(Rm).dot(Kj.T))
            self._xs[j] = xj
            self._Ps[j] = Pj

        self._update_mode_probs(log_liks)
        self._combine()
        self._need_mix = True
        return True

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
