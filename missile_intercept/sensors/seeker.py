"""Dual-mode (X-band pulse-Doppler radar + MWIR imaging-IR) seeker.

Physics & Noise Model
---------------------
- Aspect-dependent VLO fighter (F-35A class) RCS polar curve ``sigma(aspect)``:
  -23 dBsm head-on, planform leading-edge spikes (~36/144 deg), -7.4 dBsm
  broadside peak near 90 deg, and -12.2 dBsm tail nozzle cavity;
- X-band radar link budget (R^-4) with look-down ground clutter and pulse-Doppler
  zero-radial-velocity notch attenuation when the target beams;
- MWIR (3.7-4.8 um) passive IIR link budget (R^-2) combining aerodynamic skin
  heating + aspect-dependent engine exhaust plume, altitude-dependent Beer-Lambert
  atmospheric transmittance, and hypersonic seeker dome aerothermal background;
- Colored Gauss-Markov RCS glint noise (DTIC: sigma_glint ~ k * L_target / R),
  Gaussian white angle noise, radome refraction slope error, FOV +/-20 deg, and
  200 m blind range.

Ref: DTIC-Glint (glint error versus target size and range).
"""

import math
import numpy as np
import config as C
import fastcore as FC
import math_utils as MU
from vehicle.atmosphere import get_atmosphere
from vehicle.missile import aerothermal_state

_RHO_REF_16500 = get_atmosphere(16500.0).density / C.RHO_SL
_TAU_REF_IR = math.exp(-C.SEEKER_IR_EXTINCTION_SL * _RHO_REF_16500
                       * (C.SEEKER_IR_LOCK_RANGE * 1e-3))


def _atm_fast(alt):
    """Fast atmosphere tuple (T, P, rho, a) using compiled Numba kernel when available."""
    h = float(alt)
    if h < 0.0:
        h = 0.0
    if FC.NUMBA_AVAILABLE:
        return FC.atmosphere(h)
    a = get_atmosphere(h)
    return a.temperature, a.pressure, a.density, a.sound_speed


def target_aspect_angle(r_m, r_t, v_t):
    """Target aspect angle in degrees as seen from the missile.

    0 deg = nose-on (head-on), 90 deg = broadside/beaming, 180 deg = tail-on.
    Falls back to 0 deg when target velocity is near zero (e.g. static tests).
    """
    v_norm = MU.norm3(v_t)
    if v_norm < 1.0:
        return 0.0
    t_to_m = r_m - r_t
    r_norm = MU.norm3(t_to_m)
    if r_norm < 1e-6:
        return 0.0
    cos_a = float(np.dot(v_t, t_to_m) / (v_norm * r_norm))
    cos_a = min(max(cos_a, -1.0), 1.0)
    return float(math.degrees(math.acos(cos_a)))


def aspect_rcs(aspect_deg):
    """Monostatic X-band RCS (m^2) of an F-35A-class VLO fighter vs aspect angle."""
    th = abs(float(aspect_deg)) % 360.0
    if th > 180.0:
        th = 360.0 - th
    db_front = 10.0 * math.log10(max(C.TARGET_RCS_FRONT, 1e-9))  # -23.0 dBsm
    db_side = 10.0 * math.log10(max(C.TARGET_RCS_SIDE, 1e-9))    # -7.45 dBsm
    db_rear = 10.0 * math.log10(max(C.TARGET_RCS_REAR, 1e-9))    # -12.2 dBsm
    c_rear = 0.5 * (1.0 - math.cos(th * C.DEG))
    base_db = db_front * (1.0 - c_rear) + db_rear * c_rear
    # Broadside fuselage/vertical-tail specular lobe around 90 deg.
    mid_base = 0.5 * (db_front + db_rear)
    lobe_90 = max(db_side - mid_base, 0.0) * math.exp(-((th - 90.0) / 16.0) ** 2)
    # Diamond-planform leading/trailing-edge diffraction spikes (~36 & 144 deg).
    lobe_edge = (5.5 * math.exp(-((th - 36.0) / 6.0) ** 2)
                 + 4.5 * math.exp(-((th - 144.0) / 7.0) ** 2))
    rcs_db = base_db + lobe_90 + lobe_edge
    return float(max(10.0 ** (rcs_db / 10.0), 1e-6))


def radar_snr_db(slant_range, rcs_m2, alt_m=15000.0, alt_t=15000.0,
                 target_radial_vel=450.0):
    """X-band pulse-Doppler radar SNR (dB) with clutter & Doppler notch.

    Calibrated so ``rcs = SEEKER_REF_RCS`` at ``R = SEEKER_LOCK_RANGE_REF`` in
    free space gives ``SEEKER_SNR_DETECT_DB`` (13 dB CFAR threshold).
    """
    R = max(float(slant_range), 1.0)
    sigma = max(float(rcs_m2), 1e-9)
    snr_fs = (C.SEEKER_SNR_DETECT_DB
              + 10.0 * math.log10(sigma / C.SEEKER_REF_RCS)
              + 40.0 * math.log10(C.SEEKER_LOCK_RANGE_REF / R))

    # Two-way X-band clear-air atmospheric attenuation (~0.015 dB/km SL).
    h_avg = max(0.5 * (float(alt_m) + float(alt_t)), 0.0)
    _, _, rho_avg, _ = _atm_fast(h_avg)
    rho_ratio = rho_avg / C.RHO_SL
    atm_loss_db = 2.0 * 0.015 * rho_ratio * (R * 1e-3)

    # Look-down ground/sea clutter penalty (strongest when looking steeply down
    # at a low-altitude target).
    dh = max(float(alt_m) - float(alt_t), 0.0)
    dep_sin = min(dh / R, 1.0)
    low_alt_fac = math.exp(-max(float(alt_t), 0.0) / 6000.0)
    clutter_loss_db = 4.5 * dep_sin * low_alt_fac

    # Pulse-Doppler mainlobe-clutter notch attenuation when target radial speed
    # relative to Earth approaches zero (beaming/notching tactic).
    notch_w = max(C.SEEKER_DOPPLER_NOTCH_MS, 5.0)
    notch_loss_db = 6.0 * math.exp(-((float(target_radial_vel) / notch_w) ** 2))

    val = snr_fs - atm_loss_db - clutter_loss_db - notch_loss_db
    return -80.0 if val < -80.0 else (95.0 if val > 95.0 else val)


def ir_snr_db(slant_range, aspect_deg=0.0, alt_m=15000.0, alt_t=15000.0,
              mach_m=6.0, mach_t=1.6, wall_temp_k=None):
    """MWIR (3.7-4.8 um) passive imaging-IR SNR (dB).

    Combines target aerodynamic skin + aspect-dependent engine plume emission,
    Beer-Lambert atmospheric transmittance, sapphire window thermal
    transmittance decay, and hypersonic dome background radiation driven by the
    1D transient wall temperature ``wall_temp_k`` (falls back to steady-state
    aerothermal equilibrium when omitted).
    """
    R = max(float(slant_range), 1.0)
    r_km = R * 1e-3

    # Target skin temperature & Wien-band radiant intensity (lambda ~ 4.2 um).
    t_atm_t, _, _, _ = _atm_fast(alt_t)
    mt = max(float(mach_t), 0.0)
    t_skin = t_atm_t * (1.0 + 0.88 * 0.2 * mt * mt)
    t_skin_ref = 216.65 * (1.0 + 0.88 * 0.2 * 1.6 * 1.6)  # ~314 K
    # Wien factor exp(-c2/(lambda*T)), c2/4.2um = 3425 K.
    skin_rel = math.exp(-3425.0 * (1.0 / max(t_skin, 180.0) - 1.0 / t_skin_ref))
    skin_rel = min(max(skin_rel, 0.20), 6.0)

    # Aspect-dependent exhaust plume visibility (0 deg head-on -> 180 deg tail).
    th = abs(float(aspect_deg)) % 360.0
    if th > 180.0:
        th = 360.0 - th
    c_tail = 0.5 * (1.0 - math.cos(th * C.DEG))
    plume_vis = 0.15 + 1.15 * (c_tail ** 1.3) + 3.2 * (c_tail ** 4.0)
    # Throttle/Mach scaling of engine exhaust (zero-speed test keeps baseline 1).
    plume_scale = 1.0 if mt < 0.05 else min(max((mt / 1.6) ** 1.4, 0.35), 1.5)
    sig_rel = (0.85 * skin_rel + plume_vis * plume_scale) / (0.85 + 0.15)

    # Beer-Lambert atmospheric transmittance along slant path.
    h_avg = max(0.5 * (float(alt_m) + float(alt_t)), 0.0)
    _, _, rho_avg, _ = _atm_fast(h_avg)
    rho_ratio = rho_avg / C.RHO_SL
    tau_atm = math.exp(-C.SEEKER_IR_EXTINCTION_SL * rho_ratio * r_km)
    tau_ref = _TAU_REF_IR

    # Hypersonic actively-cooled sapphire IR window thermal transmittance decay
    # and in-band thermal background radiation driven by transient wall temp.
    t_atm_m, _, _, a_atm_m = _atm_fast(alt_m)
    if wall_temp_k is None:
        speed_m = max(float(mach_m), 0.0) * a_atm_m
        _, t_wall, _ = aerothermal_state(max(float(alt_m), 0.0), speed_m, mach_m)
    else:
        t_wall = float(wall_temp_k)
    t_dome = t_atm_m + 0.22 * max(t_wall - t_atm_m, 0.0)
    # Sapphire MWIR transmittance rolls off smoothly above DOME_WINDOW_T_DEGRADE.
    over_win = max(t_dome - C.DOME_WINDOW_T_DEGRADE, 0.0) / 400.0
    tau_win_ratio = max(math.exp(-0.55 * over_win * over_win), 0.45)
    dome_bg = 1.0 + 0.35 * (max(t_dome - 450.0, 0.0) / 300.0) ** 2

    ratio = max((sig_rel * tau_atm * tau_win_ratio) / max(tau_ref * dome_bg, 1e-9), 1e-9)
    snr = (C.SEEKER_SNR_DETECT_DB
           + 10.0 * math.log10(ratio)
           + 20.0 * math.log10(C.SEEKER_IR_LOCK_RANGE / R))
    return -80.0 if snr < -80.0 else (95.0 if snr > 95.0 else snr)


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
        self._explicit_lock_range = lock_range is not None
        if lock_range is None:
            lock_range = max(self.radar_lock_range, self.ir_lock_range)
        self.lock_range = float(lock_range)
        self.last_lock_range = self.lock_range
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
        self._drop_streak = 0
        self._was_physical = False
        self._los_filt = None
        # Colored Gauss-Markov glint state (dimensionless unit-variance pair).
        self._glint_state = np.zeros(2)

    # --------------------------------------------------------
    def _scan_lock_range(self, rcs_mean=None, ir_scale=1.0):
        """Per-scan lock range with aspect-dependent RCS + Swerling-I."""
        if self._explicit_lock_range:
            return self.lock_range, self.radar_lock_range, self.ir_lock_range
        rcs_base = C.TARGET_RCS if rcs_mean is None else max(float(rcs_mean), 1e-9)
        ir_eff = self.ir_lock_range * min(max(float(ir_scale), 0.82), 1.30)
        if not self.swerling or self.noise_scale <= 0.0:
            radar = C.SEEKER_LOCK_RANGE_REF * (rcs_base / C.SEEKER_REF_RCS) ** 0.25
            return max(radar, ir_eff), radar, ir_eff
        u = float(self.rng.uniform(1e-9, 1.0))
        rcs = rcs_base * (-math.log(u))          # exponential, mean rcs_base
        radar = C.SEEKER_LOCK_RANGE_REF * (
            max(rcs, 1e-12) / C.SEEKER_REF_RCS) ** 0.25
        return max(radar, ir_eff), radar, ir_eff

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
    def _detection_events(self, meas, dt, true_range=None):
        """Apply SNR-scaled dropouts and false detections as Poisson events."""
        physical = bool(meas.is_locked)
        if physical and not self._was_physical and self._drop_streak >= 3:
            self._los_filt = None
        self._was_physical = physical

        if self.noise_scale <= 0.0:
            self._false_streak = 0
            self._drop_streak = 0
            meas.is_locked = physical
            meas.confirmed = physical
            return meas

        dt = max(float(dt), C.DT_SEEKER)
        locked = physical
        if physical:
            self._false_streak = 0
            # High-SNR near-range tracks are far less prone to random fades
            # than threshold-range detections (SNR scales ~ 1/R^2..1/R^4).
            rng_eff = float(meas.range if true_range is None else true_range)
            snr_factor = min((rng_eff / 15000.0) ** 2, 1.0)
            eff_dropout = self.dropout_rate * snr_factor
            if eff_dropout > 0.0:
                p = 1.0 - math.exp(-eff_dropout * dt)
                if self.rng.rand() < p:
                    locked = False
                    self._drop_streak += 1
                else:
                    self._drop_streak = 0
            else:
                self._drop_streak = 0
        else:
            self._drop_streak += 1
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
        meas.los_angle = self._smooth_los(meas.los_angle)
        return meas

    # --------------------------------------------------------
    def _apply_colored_glint_and_radome(self, u, body_x, R, dt):
        """Apply physical colored-Markov glint, white thermal angle noise and
        radome refraction slope error to the true LOS unit vector."""
        if self.noise_scale <= 0.0:
            return u.copy(), 0.0
        # Orthonormal basis perpendicular to LOS.
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
        # Colored Gauss-Markov glint (bandwidth 1 / SEEKER_GLINT_TAU).
        tau_g = max(C.SEEKER_GLINT_TAU, 1e-4)
        phi_g = math.exp(-max(dt, C.DT_SEEKER) / tau_g)
        self._glint_state = (phi_g * self._glint_state
                             + math.sqrt(max(1.0 - phi_g * phi_g, 0.0))
                             * self.rng.normal(0.0, 1.0, 2))
        sigma_glint = C.SEEKER_GLINT_K * C.TARGET_LENGTH / max(R, 1.0) * self.noise_scale
        sigma_white = self.sigma_angle * self.noise_scale
        ang1 = self._glint_state[0] * sigma_glint + self.rng.normal(0.0, sigma_white)
        ang2 = self._glint_state[1] * sigma_glint + self.rng.normal(0.0, sigma_white)

        # Radome refraction error proportional to off-boresight angle.
        u_perp_bx = MU.perpendicular(body_x, u)
        radome_vec = np.zeros(3)
        if MU.norm3(u_perp_bx) > 1e-9:
            radome_vec = (-C.SEEKER_RADOME_SLOPE * self.fov_angle
                          * MU.normalize(u_perp_bx) * self.noise_scale)
        u_meas = MU.normalize(u + ang1 * e1 + ang2 * e2 + radome_vec)
        sigma_tot = math.sqrt(sigma_white * sigma_white + sigma_glint * sigma_glint)
        return u_meas, sigma_tot

    # --------------------------------------------------------
    def measure(self, t, r_m, v_m, q, r_t, v_t, body_x=None, wall_temp_k=None,
                decoy_state=None, tracked_vel=None):
        """Return a noisy, FOV/blind-zone constrained SeekerMeasurement."""
        if body_x is None:
            body_x = MU.quat_rotate(q, np.array([1.0, 0.0, 0.0]))

        geo = MU.los_geometry(r_m, v_m, r_t, v_t)
        R = geo["range"]
        u = geo["u"]
        omega = geo["omega"]
        range_rate = geo["range_rate"]

        # Aspect-dependent target RCS, pulse-Doppler radar SNR and MWIR IIR SNR.
        aspect_deg = target_aspect_angle(r_m, r_t, v_t)
        rcs_val = aspect_rcs(aspect_deg)
        rm_norm = MU.norm3(r_m)
        rt_norm = MU.norm3(r_t)
        vt_norm = MU.norm3(v_t)
        alt_m = max(MU.altitude(r_m), 0.0) if rm_norm > 1e6 else 15000.0
        alt_t = max(MU.altitude(r_t), 0.0) if rt_norm > 1e6 else 15000.0
        _, _, _, a_snd_m = _atm_fast(alt_m)
        _, _, _, a_snd_t = _atm_fast(alt_t)
        v_air_m = (MU.atmosphere_relative_velocity(r_m, v_m)
                   if rm_norm > 1e6 else v_m)
        v_air_t = (MU.atmosphere_relative_velocity(r_t, v_t)
                   if rt_norm > 1e6 else v_t)
        mach_m = MU.norm3(v_air_m) / max(a_snd_m, 1e-6)
        mach_t = MU.norm3(v_air_t) / max(a_snd_t, 1e-6)
        tgt_rad_vel = MU.dot3(v_air_t, u) if vt_norm >= 1.0 else 450.0

        r_snr = radar_snr_db(R, rcs_val, alt_m, alt_t, tgt_rad_vel)
        i_snr = ir_snr_db(R, aspect_deg, alt_m, alt_t, mach_m, mach_t,
                          wall_temp_k=wall_temp_k)
        # Convert physical IR SNR back to an effective lock-range scale factor.
        ir_margin_db = (i_snr - C.SEEKER_SNR_DETECT_DB
                        - 20.0 * math.log10(C.SEEKER_IR_LOCK_RANGE / max(R, 1.0)))
        ir_scale = (10.0 ** (ir_margin_db / 20.0)) if vt_norm >= 1.0 else 1.0
        lock_range, radar_rng_scan, ir_rng_scan = self._scan_lock_range(
            rcs_mean=rcs_val, ir_scale=ir_scale)
        self.last_lock_range = float(lock_range)

        u_body_x = (body_x[0] * u[0] + body_x[1] * u[1]
                    + body_x[2] * u[2])
        self.fov_angle = float(math.acos(min(max(u_body_x, -1.0), 1.0)))

        dt = max(t - self._t_last, C.DT_SEEKER) if self.initialized else C.DT_SEEKER
        u_meas, sigma_tot = self._apply_colored_glint_and_radome(u, body_x, R, dt)

        # LOS-rate first-order filter (tau = 40 ms): uses realistic rate noise
        # scaled by thermal + colored glint bandwidth (not white/20ms explosion).
        sigma_rate = math.sqrt((self.sigma_angle * self.noise_scale / 0.04) ** 2
                               + (C.SEEKER_GLINT_K * C.TARGET_LENGTH
                                  / max(R, 1.0) * self.noise_scale
                                  / max(C.SEEKER_GLINT_TAU, 0.05)) ** 2)
        omega_meas = omega + (self.rng.normal(0.0, sigma_rate, 3)
                              if sigma_rate > 0.0 else 0.0)
        alpha = dt / 0.04
        if alpha < 0.0:
            alpha = 0.0
        elif alpha > 1.0:
            alpha = 1.0
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

        in_fov = self.fov_angle <= self.fov and R > self.blind
        radar_locked = bool(in_fov and R <= radar_rng_scan)
        ir_locked = bool(in_fov and R <= ir_rng_scan)
        is_locked = bool(radar_locked or ir_locked)
        active_mode = (3 if (radar_locked and ir_locked)
                       else (2 if radar_locked else (1 if ir_locked else 0)))

        # Countermeasure (IR flare + radar chaff) kinematics & dual-band/Doppler
        # anti-decoy gating association.
        decoy_active = False
        decoy_rejected = False
        decoy_az_body = 0.0
        decoy_el_body = 0.0
        if decoy_state is not None and decoy_state.get("active", False) and R > self.blind:
            r_dec = np.asarray(decoy_state["pos"], dtype=float).reshape(3)
            v_dec = np.asarray(decoy_state["vel"], dtype=float).reshape(3)
            u_dec = MU.normalize(r_dec - r_m)
            dec_fov = float(math.acos(min(max(float(np.dot(body_x, u_dec)), -1.0), 1.0)))
            if dec_fov <= self.fov:
                decoy_active = True
                u_db = MU.quat_rotate_inv(q, u_dec)
                decoy_az_body = float(math.atan2(u_db[1], max(u_db[0], 1e-9)))
                decoy_el_body = float(math.atan2(
                    -u_db[2], max(math.hypot(u_db[0], u_db[1]), 1e-9)))
                # Kinematic Doppler range-rate comparison vs tracked target velocity.
                v_ref = (np.asarray(tracked_vel, dtype=float).reshape(3)
                         if tracked_vel is not None else v_t)
                rr_trk = float(np.dot(v_ref - v_m, u))
                rr_dec = float(np.dot(v_dec - v_m, u_dec))
                dv_doppler = abs(rr_dec - rr_trk)
                ang_sep = MU.angle_between(u, u_dec)
                # Dual-mode cross-band consistency (radar chaff has no IR plume;
                # flares have no matching metallic RCS/Doppler) tightens gate.
                gate_ms = (C.DECOY_DUAL_GATE_MS if active_mode == 3
                           else C.DECOY_DOPPLER_GATE_MS)
                if dv_doppler > gate_ms or ang_sep > 0.008:
                    decoy_rejected = True
                elif self.noise_scale > 0.0 and is_locked:
                    # Brief pre-separation centroid pull (< 1.5 mrad) before
                    # Doppler/two-color discrimination resolves the decoy.
                    ir_w = float(decoy_state.get("ir_ratio", 1.0))
                    pull = min(ang_sep * (ir_w / (1.0 + ir_w)) * 0.45, 0.0015)
                    perp_d = MU.perpendicular(u_dec - u, u_meas)
                    if MU.norm3(perp_d) > 1e-12:
                        u_meas = MU.normalize(u_meas + pull * MU.normalize(perp_d))

        # Body-frame LOS azimuth (+right/+Y) and elevation (+up/-Z).
        u_b = MU.quat_rotate_inv(q, u_meas)
        az_body = float(math.atan2(u_b[1], max(u_b[0], 1e-9)))
        el_body = float(math.atan2(-u_b[2], max(math.hypot(u_b[0], u_b[1]), 1e-9)))

        meas = C.SeekerMeasurement(
            los_angle=u_meas,
            los_rate=self.rate_filtered.copy(),
            range=float(rng_noisy),
            range_rate=float(rr_noisy),
            is_locked=is_locked,
            fov_angle=self.fov_angle,
            aspect_deg=float(aspect_deg),
            target_rcs=float(rcs_val),
            radar_snr_db=float(r_snr),
            ir_snr_db=float(i_snr),
            az_body=az_body,
            el_body=el_body,
            active_mode=int(active_mode),
            decoy_active=decoy_active,
            decoy_rejected=decoy_rejected,
            decoy_az_body=decoy_az_body,
            decoy_el_body=decoy_el_body,
        )
        out = self._detection_events(meas, dt, true_range=R)
        if not out.is_locked:
            out.active_mode = 0
        else:
            # Refresh body-frame az/el after LOS smoothing / false-lock shift.
            u_b2 = MU.quat_rotate_inv(q, out.los_angle)
            out.az_body = float(math.atan2(u_b2[1], max(u_b2[0], 1e-9)))
            out.el_body = float(math.atan2(-u_b2[2], max(math.hypot(u_b2[0], u_b2[1]), 1e-9)))
        return out
