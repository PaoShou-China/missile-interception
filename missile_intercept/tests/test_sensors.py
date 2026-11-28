"""Sensor tests: navigation KF convergence, seeker FOV/blind zone/glint.

# Ref: gnss-ins-sim; DTIC-Glint
"""

import numpy as np
import pytest

import config as C
import math_utils as MU
from sensors.navigation import NavigationSystem
from sensors.seeker import Seeker


def test_navigation_kf_converges():
    """The GNSS/INS combined filter error should be much smaller than the initial error (around the 100m level)."""
    nav = NavigationSystem(seed=3)
    r_true = MU.llh_to_eci(40.0, 110.0, 20000.0, 0.0)
    v_true = np.array([1200.0, 400.0, 50.0])
    r_true = r_true.copy()

    est = None
    for k in range(0, 2001):
        t = k * 0.01
        r_true = r_true + v_true * 0.01     # ground truth of uniform linear motion
        est = nav.step(t, r_true, v_true, np.zeros(3))
    err = np.linalg.norm(est.r_eci - r_true)
    assert err < 100.0
    assert est.timestamp == pytest.approx(20.0 - C.NAV_DELAY, abs=0.02)


def test_seeker_fov_rejects_target_behind():
    """Target behind the missile body -> outside the FOV, is_locked=False."""
    seeker = Seeker(seed=0)
    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    q = MU.quat_from_body_x(np.array([0.0, -1.0, 0.0]), np.array([0.0, 0.0, 1.0]))
    r_t = r_m + np.array([200000.0, 0.0, 0.0])   # missile body -Y direction
    meas = seeker.measure(0.0, r_m, np.zeros(3), q, r_t, np.zeros(3))
    assert not meas.is_locked
    assert meas.fov_angle > C.SEEKER_FOV


def test_seeker_lock_and_blind_zone():
    """Locked ahead at long range; lock is lost after entering the <200m blind zone."""
    seeker = Seeker(seed=1)
    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    up = MU.normalize(r_m)
    q = MU.quat_from_body_x(up, np.array([0.0, 1.0, 0.0]))
    r_t = r_m + up * 5000.0
    meas = seeker.measure(0.0, r_m, np.zeros(3), q, r_t, np.zeros(3))
    assert meas.is_locked

    r_t2 = r_m + up * 100.0
    meas2 = seeker.measure(0.01, r_m, np.zeros(3), q, r_t2, np.zeros(3))
    assert not meas2.is_locked


def test_glint_noise_scales_with_range():
    """Glint angle noise grows as range decreases (variance magnitude check)."""
    seeker = Seeker(seed=2)
    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    up = MU.normalize(r_m)
    q = MU.quat_from_body_x(up, np.array([0.0, 1.0, 0.0]))

    errs_far, errs_near = [], []
    for k in range(200):
        t = k * C.DT_SEEKER
        r_far = r_m + up * 100000.0
        r_near = r_m + up * 2000.0
        m_far = seeker.measure(t, r_m, np.zeros(3), q, r_far, np.zeros(3))
        errs_far.append(MU.angle_between(m_far.los_angle, up))
        m_near = seeker.measure(t, r_m, np.zeros(3), q, r_near, np.zeros(3))
        errs_near.append(MU.angle_between(m_near.los_angle, up))

    assert np.std(errs_near) > np.std(errs_far)
    assert np.std(errs_near) > 0.0


def test_navigation_zero_noise_and_strapdown_body_force():
    """Zero-noise GNSS update must stay non-singular, and body-frame strapdown
    mechanisation must propagate velocity from rotated specific force."""
    nav = NavigationSystem(seed=7, noise_scale=0.0)
    r_true = MU.llh_to_eci(40.0, 110.0, 20000.0, 0.0)
    v_true = np.array([1000.0, 200.0, 0.0])
    q_est = np.array([1.0, 0.0, 0.0, 0.0])
    f_body = np.array([25.0, 0.0, -9.8])
    for k in range(250):
        t = k * 0.01
        r_true = r_true + v_true * 0.01
        est = nav.step(t, r_true, v_true, np.zeros(3),
                       f_body_true=f_body, q_est=q_est,
                       omega_true=np.array([0.0, 0.1, 0.0]), cg_pos=4.2)
    assert np.all(np.isfinite(est.r_eci))
    assert np.all(np.isfinite(nav.P))
    assert np.all(np.isfinite(nav.last_accel_body_meas))


def test_singer_tracker_fuses_doppler_range_rate_and_latency():
    """Singer tracker fuses Doppler range-rate and compensates datalink latency."""
    from sensors.target_tracker import TargetTracker

    r_t = np.array([10000.0, 0.0, 0.0])
    v_t = np.array([-400.0, 50.0, 0.0])
    trk = TargetTracker(np.concatenate([r_t + np.array([200.0, 0.0, 0.0]),
                                        v_t + np.array([30.0, 0.0, 0.0])]),
                        noise_scale=0.5)
    trk.predict(0.0)
    trk.predict(0.2)
    # Compensated delayed datalink fix must pull position close to truth at t=0.2.
    trk.update_position_velocity(r_t, v_t, 50.0, 2.0, latency=0.2)
    err_pos = np.linalg.norm(trk.position() - (r_t + v_t * 0.2))
    assert err_pos < 80.0

    # Doppler range-rate update reduces radial velocity error.
    meas = C.SeekerMeasurement(
        los_angle=np.array([1.0, 0.0, 0.0]),
        los_rate=np.zeros(3),
        range=float(np.linalg.norm(r_t + v_t * 0.2)),
        range_rate=-1400.0,
        is_locked=True,
        fov_angle=0.05,
    )
    ok = trk.update(meas, np.zeros(3), v_missile=np.array([1000.0, 0.0, 0.0]))
    assert ok
    assert abs(trk.velocity()[0] - (-400.0)) < 15.0


def test_aspect_rcs_radar_ir_snr_and_aerothermal():
    """Aspect RCS peaks broadside, Radar/IR SNR obey R^-4 / R^-2 & Doppler notch,
    and Sutton-Graves aerothermal stays physically bounded."""
    from sensors.seeker import aspect_rcs, radar_snr_db, ir_snr_db
    from vehicle.missile import aerothermal_state

    # VLO fighter RCS pattern: lowest nose-on, peak broadside, moderate rear.
    r0 = aspect_rcs(0.0)
    r90 = aspect_rcs(90.0)
    r180 = aspect_rcs(180.0)
    assert r0 == pytest.approx(C.TARGET_RCS_FRONT, rel=1e-3)
    assert r90 > r180 > r0 * 5.0

    # Radar SNR scales ~12 dB per halving of range (R^-4) and drops in Doppler notch.
    s_far = radar_snr_db(20000.0, r90, alt_m=20000.0, alt_t=15000.0, target_radial_vel=400.0)
    s_near = radar_snr_db(10000.0, r90, alt_m=20000.0, alt_t=15000.0, target_radial_vel=400.0)
    s_notch = radar_snr_db(10000.0, r90, alt_m=20000.0, alt_t=15000.0, target_radial_vel=0.0)
    assert (s_near - s_far) == pytest.approx(12.04, abs=0.4)
    assert s_notch < s_near - 4.0

    # IR SNR scales ~6 dB per halving (R^-2) plus tail-aspect plume boost.
    ir_front = ir_snr_db(20000.0, aspect_deg=0.0, alt_m=20000.0, alt_t=15240.0, mach_m=7.0, mach_t=1.6)
    ir_tail = ir_snr_db(20000.0, aspect_deg=180.0, alt_m=20000.0, alt_t=15240.0, mach_m=7.0, mach_t=1.6)
    ir_close = ir_snr_db(10000.0, aspect_deg=0.0, alt_m=20000.0, alt_t=15240.0, mach_m=7.0, mach_t=1.6)
    assert ir_tail > ir_front + 4.0
    assert ir_close > ir_front + 5.5

    # Sutton-Graves aerothermal: ~2-5 MW/m^2 and 1700-2500 K at M=9, h=26 km.
    q_mw, tw, tr = aerothermal_state(26000.0, 2700.0, 9.0)
    assert 1.5 < q_mw < 6.0
    assert 1500.0 < tw < tr < 4000.0
    q0, tw0, _ = aerothermal_state(0.0, 0.0, 0.0)
    assert q0 == 0.0 and tw0 == pytest.approx(288.15, abs=0.5)


def test_imm_tracker_mode_probabilities_and_3d_turn():
    """3-model IMM (CV + CA + 3D-CT) shifts probability toward CT/CA during a turn."""
    from sensors.target_tracker import TargetTracker

    # Sustained 6g circular turn at 450 m/s -> turn rate ~ 0.13 rad/s.
    v0 = 450.0
    w = 0.13
    R_turn = v0 / w
    r_m = np.array([-8000.0, 0.0, 0.0])
    v_m = np.array([2200.0, 0.0, 0.0])
    r0 = np.array([R_turn, 0.0, 0.0])
    v_init = np.array([0.0, v0, 0.0])
    trk = TargetTracker(np.concatenate([r0, v_init]), noise_scale=0.3)

    # First fly straight (CV should stay high).
    dt = 0.02
    r_cur = r0.copy()
    v_cur = v_init.copy()
    for k in range(1, 60):
        t = k * dt
        r_cur = r_cur + v_cur * dt
        trk.predict(t)
        u = MU.normalize(r_cur - r_m)
        rng = float(np.linalg.norm(r_cur - r_m))
        rr = float(np.dot(v_cur - v_m, u))
        meas = C.SeekerMeasurement(los_angle=u, los_rate=np.zeros(3),
                                   range=rng, range_rate=rr, is_locked=True)
        trk.update(meas, r_m, v_missile=v_m)
    p_cv_cruise = float(trk.mode_probs[0])
    assert p_cv_cruise > 0.35
    assert np.sum(trk.mode_probs) == pytest.approx(1.0, abs=1e-9)

    # Now execute a sustained 6g coordinated turn: maneuver models (CA + 3D-CT) dominate.
    theta = 0.0
    for k in range(60, 220):
        t = k * dt
        theta += w * dt
        v_cur = np.array([-v0 * np.sin(theta), v0 * np.cos(theta), 0.0])
        r_cur = r_cur + v_cur * dt
        trk.predict(t)
        u = MU.normalize(r_cur - r_m)
        rng = float(np.linalg.norm(r_cur - r_m))
        rr = float(np.dot(v_cur - v_m, u))
        meas = C.SeekerMeasurement(los_angle=u, los_rate=np.zeros(3),
                                   range=rng, range_rate=rr, is_locked=True)
        trk.update(meas, r_m, v_missile=v_m)
    assert float(trk.mode_probs[1] + trk.mode_probs[2]) > float(trk.mode_probs[0])
    assert np.linalg.norm(trk.position() - r_cur) < 60.0


def test_countermeasure_decoy_and_anti_decoy_gate():
    """Target ejects drag-decelerated flare/chaff inside 14 km and seeker gate rejects it."""
    from vehicle.target import Target

    tgt = Target(evade_g=9.0)
    x_t = tgt.initial_state()
    r_t, v_t = x_t[0:3], x_t[3:6]
    v_hat = MU.normalize(v_t)
    # Place missile 8 km ahead looking directly at target.
    r_m = r_t + v_hat * 8000.0
    v_m = -v_hat * 2400.0
    q = MU.quat_align_body_x(MU.normalize(r_t - r_m), MU.local_up(r_m))

    d0 = tgt.decoy_state(100.0, r_t, v_t, r_m)
    d1 = tgt.decoy_state(100.8, r_t, v_t, r_m)
    assert d0 is not None and d1 is not None and d1["active"]
    # Aerodynamic drag separates decoy velocity significantly from target.
    assert np.linalg.norm(d1["vel"] - v_t) > 100.0

    seeker = Seeker(seed=5, noise_scale=0.5)
    meas = seeker.measure(100.8, r_m, v_m, q, r_t, v_t,
                          decoy_state=d1, tracked_vel=v_t)
    assert meas.is_locked
    assert meas.decoy_active
    assert meas.decoy_rejected
    # True target LOS remains tightly locked despite decoy presence.
    assert MU.angle_between(meas.los_angle, MU.normalize(r_t - r_m)) < 0.01


def test_proximity_fuze_lethality_monotonic_and_physical():
    """Directed-fragmentation proximity fuze Pk decreases with miss distance & saturates lead."""
    from vehicle.warhead import proximity_fuze_lethality

    r_m = np.array([0.0, 0.0, 0.0])
    v_m = np.array([2400.0, 0.0, 0.0])
    q_m = np.array([1.0, 0.0, 0.0, 0.0])
    v_t = np.array([-450.0, 0.0, 0.0])

    rep_2 = proximity_fuze_lethality(r_m, v_m, q_m, np.array([0.0, 2.0, 0.0]), v_t)
    rep_5 = proximity_fuze_lethality(r_m, v_m, q_m, np.array([0.0, 5.0, 0.0]), v_t)
    rep_10 = proximity_fuze_lethality(r_m, v_m, q_m, np.array([0.0, 10.0, 0.0]), v_t)
    rep_20 = proximity_fuze_lethality(r_m, v_m, q_m, np.array([0.0, 20.0, 0.0]), v_t)

    assert 2.0 <= rep_5["tau_fuze_ms"] <= 5.0
    assert rep_20["tau_fuze_ms"] == pytest.approx(5.0)
    assert rep_2["pk_fuze"] > rep_5["pk_fuze"] > rep_10["pk_fuze"] > rep_20["pk_fuze"]
    assert rep_2["pk_fuze"] > 0.95
    assert rep_20["pk_fuze"] < 0.15
