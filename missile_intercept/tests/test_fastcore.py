"""Equivalence tests between the Numba numerical kernels and the pure Python implementation."""

import numpy as np
import pytest

import config as C
import fastcore as FC
import math_utils as MU
from vehicle.atmosphere import get_atmosphere
from vehicle.missile import Missile
from vehicle.target import Target

pytestmark = pytest.mark.skipif(not FC.NUMBA_AVAILABLE, reason="numba is not installed")


def test_atmosphere_matches_python():
    """The compiled atmosphere model matches get_atmosphere exactly."""
    for alt in np.linspace(0.0, 200000.0, 41):
        t, p, rho, a = FC.atmosphere(float(alt))
        atm = get_atmosphere(float(alt))
        assert t == pytest.approx(atm.temperature, rel=1e-12)
        assert p == pytest.approx(atm.pressure, rel=1e-12)
        assert rho == pytest.approx(atm.density, rel=1e-12)
        assert a == pytest.approx(atm.sound_speed, rel=1e-12)


def test_missile_derivatives_match_python():
    """For random states, the 14-dimensional derivatives and info fields match the pure Python path."""
    rng = np.random.RandomState(7)
    m = Missile()
    for _ in range(25):
        r = MU.llh_to_eci(40.0, 110.0, float(rng.uniform(0.0, 60000.0)), 0.0)
        v = rng.normal(0.0, 800.0, 3)
        q = MU.quat_normalize(rng.normal(size=4))
        state = np.concatenate([
            r, v, q, rng.normal(0.0, 0.1, 3),
            [rng.uniform(C.DRY_MASS, C.MASS0)]])
        fins = rng.uniform(-0.2, 0.2, 4)
        t = float(rng.uniform(0.0, 30.0))
        unstart = bool(rng.rand() < 0.3)

        dy_fast, info_fast = m.derivatives(t, state, fins, use_fast=True, unstart=unstart)
        dy_py, info_py = m.derivatives(t, state, fins, use_fast=False, unstart=unstart)

        assert np.allclose(dy_fast, dy_py, rtol=1e-10, atol=1e-9)
        assert info_fast["alpha"] == pytest.approx(info_py["alpha"], abs=1e-12)
        assert info_fast["beta"] == pytest.approx(info_py["beta"], abs=1e-12)
        assert info_fast["q_dyn"] == pytest.approx(info_py["q_dyn"], rel=1e-11)
        assert info_fast["mach"] == pytest.approx(info_py["mach"], rel=1e-12)
        assert info_fast["thrust"] == pytest.approx(info_py["thrust"], rel=1e-12)
        assert info_fast["phase"] == info_py["phase"]
        assert np.allclose(info_fast["F_body"], info_py["F_body"], atol=1e-9)


def test_target_derivatives_match_python():
    """The target's 6-dimensional derivatives match pure Python in both the evasive and cruise segments."""
    target = Target()
    r_t = target.initial_state()
    for scale in (0.0, 5000.0, 12000.0):
        r_m = r_t[0:3] - np.array([scale, 0.0, 1000.0])
        for t in (0.0, 7.5, 21.0):
            f_fast = target.derivatives(t, r_t, r_m, use_fast=True)
            f_py = target.derivatives(t, r_t, r_m, use_fast=False)
            assert np.allclose(f_fast, f_py, rtol=1e-12, atol=1e-12)


def test_autopilot_and_fin_mixer_match_python(monkeypatch):
    """The compiled and pure Python paths of attitude control and fin mixing agree sample by sample."""
    from control.autopilot import Autopilot
    from control.fin_mixer import FinMixer

    rng = np.random.RandomState(3)
    ap_fast, ap_py = Autopilot(), Autopilot()
    fm_fast, fm_py = FinMixer(), FinMixer()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    for k in range(300):
        q = MU.quat_normalize(q + 1e-3 * rng.normal(size=4))
        omega = rng.normal(0.0, 0.05, 3)
        a_cmd = rng.normal(0.0, 20.0, 3)
        args = (q, omega, a_cmd, 2000.0, 30000.0, 1.8, 0.02, -0.01,
                k % 7 == 0, 0.005)
        out_fast = ap_fast.update(float(k) * 0.005, *args)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", False)
        out_py = ap_py.update(float(k) * 0.005, *args)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", True)

        assert np.allclose(out_fast, out_py, rtol=1e-10, atol=1e-10)
        assert ap_fast.int_angle_p == pytest.approx(ap_py.int_angle_p, abs=1e-12)
        assert ap_fast.int_rate_p == pytest.approx(ap_py.int_rate_p, abs=1e-12)
        assert ap_fast.int_roll == pytest.approx(ap_py.int_roll, abs=1e-12)

        q_mix = 650000.0 if k >= 150 else 30000.0
        cmd_fast = fm_fast.mix(out_fast, 0.005, q_dyn=q_mix)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", False)
        cmd_py = fm_py.mix(out_py, 0.005, q_dyn=q_mix)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", True)
        assert np.allclose(cmd_fast.delta_fins, cmd_py.delta_fins, atol=1e-12)
        assert np.allclose(fm_fast.fin_rates, fm_py.fin_rates, atol=1e-12)
        assert cmd_fast.is_saturated == cmd_py.is_saturated


def test_noise_streams_are_reproducible():
    """Seeker/navigation use independent seed streams: the same seed reproduces exactly, different seeds differ."""
    from sensors.navigation import NavigationSystem
    from sensors.seeker import Seeker

    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    up = MU.normalize(r_m)
    q = MU.quat_from_body_x(up, np.array([0.0, 1.0, 0.0]))
    r_t = r_m + up * 5000.0

    def run(seed):
        seeker = Seeker(seed=seed)
        vals = []
        for k in range(5):
            m = seeker.measure(k * C.DT_SEEKER, r_m, np.zeros(3), q, r_t, np.zeros(3))
            vals.append(m.los_angle.copy())
        return np.array(vals)

    assert np.allclose(run(21), run(21), atol=0.0)
    assert not np.allclose(run(21), run(22))

    def nav_run(seed):
        nav = NavigationSystem(seed=seed)
        est = None
        for k in range(101):
            est = nav.step(k * 0.01, r_m + k * 1.0, np.array([100.0, 0.0, 0.0]),
                           np.zeros(3))
        return est.r_eci.copy()

    assert np.allclose(nav_run(5), nav_run(5), atol=0.0)
    assert not np.allclose(nav_run(5), nav_run(6), rtol=0.0, atol=1e-6)


def test_rk4_multi_step_system_into_matches_python_rk4():
    """Fused nogil rk4_multi_step_system_into matches Python rk4_step to 1e-11."""
    import integrator as INT

    rng = np.random.RandomState(42)
    m = Missile()
    tgt = Target()
    r = MU.llh_to_eci(40.0, 110.0, 32000.0, 0.0)
    v = np.array([1200.0, 1800.0, -300.0])
    q = MU.quat_normalize(rng.normal(size=4))
    y_m = np.concatenate([r, v, q, [0.02, -0.01, 0.005], [0.5 * (C.DRY_MASS + C.MASS0)]])
    y_t = tgt.initial_state()
    y0 = np.concatenate([y_m, y_t])
    fins = np.array([0.04, -0.02, 0.05, 0.03], dtype=np.float64)
    wind = np.array([10.0, -15.0, 2.0], dtype=np.float64)
    throttle = 0.85
    t0 = 18.0
    h = 0.020

    def rhs_py(t, y):
        dm, _ = m.derivatives(t, y[0:14], fins, throttle=throttle, wind=wind,
                              use_fast=False, unstart=False)
        dt_vec = tgt.derivatives(t, y[14:20], y[0:3], use_fast=False)
        return np.concatenate((dm, dt_vec))

    # Reference: two 10 ms Python RK4 steps
    y_mid, _, _, _ = INT.rk4_step(rhs_py, t0, y0, 0.5 * h)
    y_ref, _, _, _ = INT.rk4_step(rhs_py, t0 + 0.5 * h, y_mid, 0.5 * h)
    favg_ref = (y_ref - y0) / h

    y_out = np.empty(20)
    f_avg = np.empty(20)
    k1 = np.empty(20)
    k2 = np.empty(20)
    k3 = np.empty(20)
    k4 = np.empty(20)
    ytmp = np.empty(20)
    Fb = np.empty(3)
    Mb = np.empty(3)
    dcm = np.empty((3, 3))
    FC.rk4_multi_step_system_into(
        t0, y0, h, 2, fins, m.mass0, m.dry_mass, m.fuel0, m.S, m.L,
        throttle, wind[0], wind[1], wind[2],
        float(tgt.evade_g), float(tgt.maneuver_dist), float(tgt.evade_phase),
        0, y_out, f_avg, k1, k2, k3, k4, ytmp, Fb, Mb, dcm)

    assert np.allclose(y_out, y_ref, rtol=1e-11, atol=1e-9)
    assert np.allclose(f_avg, favg_ref, rtol=1e-10, atol=1e-8)


def test_telemetry_npz_roundtrip_and_zero_alloc_mode(tmp_path):
    """Binary NPZ save/load round-trips bit-identically and enabled=False allocates nothing."""
    from telemetry import TelemetryLogger

    disabled = TelemetryLogger(100000, C.TELEMETRY_BASIC_COLUMNS, enabled=False)
    assert disabled.data.shape == (0, len(C.TELEMETRY_BASIC_COLUMNS))
    assert not disabled.send(0.0, np.zeros(len(C.TELEMETRY_BASIC_COLUMNS) - 1))
    assert disabled.n == 0

    logger = TelemetryLogger(10, ["time", "a", "b"], enabled=True)
    for k in range(5):
        assert logger.send(k * 0.1, np.array([float(k), float(k) * 2.5]))
    npz_path = str(tmp_path / "test_telemetry.npz")
    logger.save_npz(npz_path)
    cols, data = TelemetryLogger.load_npz(npz_path)
    assert cols == ["time", "a", "b"]
    assert data.shape == (5, 3)
    assert np.array_equal(data, logger.data[:5])


def test_imm_predict_all_matches_python(monkeypatch):
    """Compiled nogil IMM 3-model prediction + fusion matches pure Python."""
    from sensors.target_tracker import TargetTracker

    x0 = np.array([1.0e6, 2.0e6, 5.0e6, -400.0, 220.0, -50.0])
    tr_fast = TargetTracker(x0)
    tr_py = TargetTracker(x0)
    # Seed non-zero target acceleration so 3D-CT Rodrigues branch executes too.
    for j in range(3):
        tr_fast._xs[j][6:9] = np.array([12.0, -25.0, 8.0])
        tr_py._xs[j][6:9] = np.array([12.0, -25.0, 8.0])

    tr_fast.predict(0.0)
    monkeypatch.setattr(FC, "NUMBA_AVAILABLE", False)
    tr_py.predict(0.0)
    monkeypatch.setattr(FC, "NUMBA_AVAILABLE", True)

    for k in range(1, 30):
        t = k * 0.02
        tr_fast.predict(t)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", False)
        tr_py.predict(t)
        monkeypatch.setattr(FC, "NUMBA_AVAILABLE", True)

    assert np.allclose(tr_fast._x, tr_py._x, rtol=1e-11, atol=1e-9)
    assert np.allclose(tr_fast.P, tr_py.P, rtol=1e-10, atol=1e-8)
