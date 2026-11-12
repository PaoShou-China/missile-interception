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
