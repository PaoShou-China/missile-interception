"""Data consistency / atmosphere / mass properties / telemetry tests.

# Ref: USSA1976; DTIC-ThrustAlt; METU-VarMass
"""

import numpy as np
import pytest

import config as C
import math_utils as MU
from telemetry import TelemetryLogger
from vehicle.atmosphere import get_atmosphere
from vehicle.missile import Missile, boost_thrust_scale, static_margin


def test_atmosphere_monotonic():
    """Density/pressure decrease monotonically with altitude; speed of sound is reasonable."""
    heights = np.linspace(0, 80000, 50)
    density = [get_atmosphere(h).density for h in heights]
    pressure = [get_atmosphere(h).pressure for h in heights]
    assert np.all(np.diff(density) < 0)
    assert np.all(np.diff(pressure) < 0)
    assert 300.0 < get_atmosphere(0).sound_speed < 360.0
    assert get_atmosphere(0).pressure == pytest.approx(C.P_SL, rel=1e-6)


def test_thrust_increases_with_altitude():
    """F = F_sl + A_e*(P_sl - P_a): the higher the altitude, the lower the ambient pressure, the greater the thrust."""
    m = Missile()
    f0, _, _ = m.propulsion(0.5, C.MASS0, 0.5, 0.0, 50000.0, 0.0)
    f20, _, _ = m.propulsion(0.5, C.MASS0, 2.0, 20000.0, 30000.0, 0.0)
    assert f20 > f0 > 0.0


def test_boost_thrust_profile_is_not_constant():
    """The boost phase uses a normalized thrust curve: ignition ramp-up, mid-section plateau, tail decay."""
    m = Missile()
    t_mid = 0.5 * C.BOOST_BURN_TIME
    t_tail = 0.96 * C.BOOST_BURN_TIME
    assert boost_thrust_scale(0.0) < boost_thrust_scale(t_mid)
    assert boost_thrust_scale(t_mid) > boost_thrust_scale(t_tail)
    f_mid, mdot_mid, phase = m.propulsion(t_mid, C.MASS0, 0.8, 5000.0, 40000.0, 0.0)
    f_tail, mdot_tail, _ = m.propulsion(t_tail, C.MASS0, 0.8, 5000.0, 40000.0, 0.0)
    assert phase == "boost"
    assert f_mid > f_tail > 0.0
    assert mdot_mid == pytest.approx(mdot_tail)   # mass flow rate is constant


def test_propulsion_throttle_scales_ramjet_flow():
    """Ramjet thrust and fuel flow scale linearly with throttle; zero throttle enters coast."""
    m = Missile()
    mass = C.MASS0 - C.BOOST_FUEL
    f1, md1, p1 = m.propulsion(30.0, mass, 5.0, 10000.0, 10000.0, 0.0,
                               throttle=1.0)
    fh, mdh, ph = m.propulsion(30.0, mass, 5.0, 10000.0, 10000.0, 0.0,
                               throttle=0.5)
    f0, md0, p0 = m.propulsion(30.0, mass, 5.0, 10000.0, 10000.0, 0.0,
                               throttle=0.0)
    assert p1 == "ramjet" and f1 > 0.0
    assert fh == pytest.approx(0.5 * f1, rel=1e-6)
    assert mdh == pytest.approx(0.5 * md1, rel=1e-6)
    assert f0 == 0.0 and md0 == 0.0 and p0 == "coast"


def test_ramjet_altitude_and_mach_envelope():
    """Ramjet thrust decays with altitude and Mach number, and drops to zero at the density cutoff altitude."""
    m = Missile()
    mass = C.MASS0 - C.BOOST_FUEL      # booster propellant exhausted, only ramjet fuel left
    f18, _, p18 = m.propulsion(30.0, mass, 5.0, C.RAMJET_ALT_FULL, 50000.0, 0.0)
    f30, _, p30 = m.propulsion(30.0, mass, 5.0, 30000.0, 50000.0, 0.0)
    f40, _, p40 = m.propulsion(30.0, mass, 5.0, 40000.0, 50000.0, 0.0)
    assert p18 == "ramjet" and f18 > 0.0
    assert p30 == "ramjet" and 0.0 < f30 < f18
    assert p40 == "coast" and f40 == 0.0

    # At the same dynamic pressure, higher Mach number is less efficient (avoids hitting the flow/thrust limit)
    f3, _, _ = m.propulsion(30.0, mass, 3.0, 10000.0, 10000.0, 0.0)
    f9, _, _ = m.propulsion(30.0, mass, 9.0, 10000.0, 10000.0, 0.0)
    assert f3 > f9 > 0.0


def test_cg_migration_enters_static_moment():
    """The center of mass moves forward as fuel is consumed; static margin and pitch restoring moment grow together."""
    m = Missile()
    zeros = np.zeros(4)
    cm_full = m.aero_coefficients(2.0, 0.1, 0.0, zeros, cg=C.CG_FULL)["CM"]
    cm_dry = m.aero_coefficients(2.0, 0.1, 0.0, zeros, cg=C.CG_DRY)["CM"]
    assert cm_full < 0.0
    assert cm_dry < cm_full                       # the dry-mass state is more stable
    assert static_margin(2.0, C.CG_DRY) > static_margin(2.0, C.CG_FULL)

    # In the dry-mass state the moment must reflect the current center of mass via the forces_moments info fields
    r = MU.llh_to_eci(C.LAUNCH_LAT, C.LAUNCH_LON, 20000.0, 0.0)
    up = MU.normalize(r)
    q = MU.quat_from_body_x(up, np.array([0.0, 1.0, 0.0]))
    state = np.concatenate([r, np.zeros(3), q, np.zeros(3), [C.DRY_MASS]])
    _, info = m.derivatives(20.0, state, zeros)
    assert info["cg"] == pytest.approx(C.CG_DRY, abs=1e-9)


def test_validate_data_boost_sanity():
    """THAAD-order anchor: combined-cycle boost burnout speed should exceed the ramjet light-off speed."""
    data = C.validate_data()
    assert 0.9 < data["boost_curve_mean"] < 1.1
    assert data["boost_ideal_dv"] > data["boost_lightoff_speed"]
    assert data["boost_ideal_dv"] < 2600.0    # below the THAAD single-stage solid anchor
    assert data["cg_shift_m"] > 0.0
    assert data["static_margin_dry_m"] > data["static_margin_m"]


def test_mass_and_inertia_decay():
    """Mass/inertia/center of mass change monotonically with fuel consumption."""
    m = Missile()
    i_full = m.inertia(C.MASS0)
    i_dry = m.inertia(C.DRY_MASS)
    assert i_full[1, 1] > i_dry[1, 1]
    assert keep_positive(i_full)
    assert m.cg_position(C.MASS0) > m.cg_position(C.DRY_MASS)


def keep_positive(mat):
    return bool(np.all(np.diag(mat) > 0))


def test_dry_mass_protection():
    """Dry-mass floor: no thrust is produced and the mass derivative is not greater than 0."""
    m = Missile()
    r = MU.llh_to_eci(C.LAUNCH_LAT, C.LAUNCH_LON, 30000.0, 0.0)
    up = MU.normalize(r)
    q = MU.quat_from_body_x(up, np.array([0.0, 1.0, 0.0]))
    state = np.concatenate([r, np.zeros(3), q, np.zeros(3), [C.DRY_MASS]])
    dy, info = m.derivatives(30.0, state, np.zeros(4))
    assert info["thrust"] == 0.0
    assert dy[13] <= 1e-12
    # Mass will not be integrated below the dry mass
    assert state[13] >= C.DRY_MASS


def test_quaternion_roundtrip():
    """Quaternion -> DCM -> quaternion round trip stays consistent."""
    rng = np.random.RandomState(0)
    for _ in range(10):
        q = MU.quat_normalize(rng.normal(size=4))
        dcm = MU.quat_to_dcm(q)
        q2 = MU.dcm_to_quat(dcm)
        assert abs(abs(np.dot(q, q2)) - 1.0) < 1e-8


def test_lla_eci_roundtrip():
    """WGS84 lat/lon/alt -> ECI -> lat/lon/alt."""
    for lat, lon, alt in [(40.0, 110.0, 0.0), (28.0, 126.0, 15000.0), (-30.0, -60.0, 8000.0)]:
        r = MU.llh_to_eci(lat, lon, alt, 0.0)
        la, lo, al = MU.eci_to_llh(r, 0.0)
        assert la == pytest.approx(lat, abs=1e-6)
        assert lo == pytest.approx(lon, abs=1e-6)
        assert al == pytest.approx(alt, abs=1e-3)


def test_telemetry_preallocated_and_ordered():
    """Telemetry pre-allocation, duplicate-time rejection, capacity protection."""
    logger = TelemetryLogger(max_steps=3, columns=["time", "a", "b"])
    assert logger.data.shape == (3, 3)
    assert logger.send(0.0, [1.0, 2.0])
    assert not logger.send(0.0, [9.0, 9.0])   # duplicate time is rejected
    assert logger.send(0.1, [3.0, 4.0])
    assert logger.send(0.2, [5.0, 6.0])
    assert not logger.send(0.3, [7.0, 8.0])   # capacity full
    assert logger.n == 3
    assert logger.overflow_count == 1
    assert logger.get("a")[1] == 3.0


def test_telemetry_rejects_nan():
    logger = TelemetryLogger(max_steps=5)
    with pytest.raises(FloatingPointError):
        logger.send(0.0, [np.nan] * (len(C.TELEMETRY_COLUMNS) - 1))
