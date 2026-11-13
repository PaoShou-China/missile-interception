"""Control law tests: second-order low-pass, fin mixing limits, anti-windup.

# Ref: Hacettepe-3loop; TU-Delft-AW
"""

import numpy as np
import pytest

import config as C
import fastcore as FC
from control.autopilot import Autopilot, SecondOrderFilter
from control.fin_mixer import FinMixer
from control.thrust_controller import ThrustController


def test_second_order_filter_no_high_freq_oscillation():
    """5Hz/zeta=0.707 second-order low-pass: step overshoot <25%, and it finally converges to the command."""
    filt = SecondOrderFilter(5.0, 0.707)
    filt.reset(0.0)
    values = []
    for _ in range(400):
        values.append(filt.update(1.0, 0.005))
    values = np.array(values)
    overshoot = values.max() - 1.0
    assert 0.0 <= overshoot < 0.25
    assert abs(values[-1] - 1.0) < 1e-3
    # No high-frequency jitter between adjacent samples (small ripple outside the monotonic segment)
    assert np.max(np.abs(np.diff(values[-100:]))) < 1e-3


def test_fin_mixer_rate_and_position_limits():
    """Rate limit 100deg/s + position limit 25deg, with saturation reported correctly."""
    mixer = FinMixer()
    dt = 0.005
    cmd = mixer.mix(np.array([1.0, 1.0, 1.0]), dt)   # far beyond the limit
    max_step = C.FIN_RATE_MAX * dt
    assert np.all(np.abs(cmd.delta_fins) <= max_step + 1e-9)
    assert cmd.is_saturated

    for _ in range(2000):
        cmd = mixer.mix(np.array([1.0, 1.0, 1.0]), dt)
    assert np.all(np.abs(cmd.delta_fins) <= C.FIN_MAX + 1e-12)
    assert cmd.is_saturated


def test_anti_windup_freezes_integral():
    """The integrator stops accumulating while saturated."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    a_cmd = np.array([0.0, 0.0, -30.0])
    for _ in range(50):
        ap.update(0.0, q, np.zeros(3), a_cmd, 2000.0, 50000.0, 1.8,
                  alpha_trim=0.0, is_saturated=True, dt=0.005)
    assert ap.int_angle_p == pytest.approx(0.0)
    assert ap.int_rate_p == pytest.approx(0.0)


def test_low_dynamic_pressure_protection():
    """At q<100Pa integration is disabled and the fin deflection output stays bounded."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    out = ap.update(0.0, q, np.zeros(3), np.array([0.0, 0.0, -10.0]),
                    2000.0, 50.0, 1.5, alpha_trim=0.0, dt=0.005)
    assert np.all(np.isfinite(out))
    assert np.all(np.abs(out) <= C.FIN_MAX + 1e-12)
    assert ap.int_rate_p == 0.0


def test_gain_schedule_bounded():
    """Gain-schedule factors stay bounded at both the low and high dynamic pressure ends."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    lo = ap.update(0.0, q, np.zeros(3), np.array([5.0, 0.0, -5.0]),
                   2000.0, 1000.0, 1.5, alpha_trim=0.1, dt=0.005)
    hi = ap.update(0.01, q, np.zeros(3), np.array([5.0, 0.0, -5.0]),
                   2000.0, 1e6, 1.5, alpha_trim=0.1, dt=0.005)
    assert np.all(np.isfinite(lo)) and np.all(np.isfinite(hi))
    assert np.all(np.abs(lo) <= C.FIN_MAX)
    assert np.all(np.abs(hi) <= C.FIN_MAX)


def test_prefilter_and_accel_limit_follow_dynamic_pressure():
    """Prefilter bandwidth and available angular acceleration authority both
    increase monotonically with dynamic pressure."""
    ap = Autopilot()
    assert ap._filter_hz(1.0e3) < ap._filter_hz(2.0e4)
    assert ap._filter_hz(1.0e6) == pytest.approx(C.AP_PREFILTER_HZ)
    assert ap._filter_hz(10.0) == pytest.approx(C.AP_PREFILTER_HZ_MIN)
    low = ap._accel_limit(2000.0, 1.0e4, 3.0)
    high = ap._accel_limit(2000.0, 1.0e5, 3.0)
    assert low > 0.0
    assert high == pytest.approx(10.0 * low, rel=1e-9)


def test_reference_governor_limits_alpha_acceleration():
    """The reference-model angular acceleration per step stays within the authority limit."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    dt = 0.005
    limit = ap._accel_limit(2000.0, 4442.0, 3.0)
    a_cmd = np.array([0.0, 0.0, -500.0])
    previous = 0.0
    for k in range(120):
        ap.update(k * dt, q, np.zeros(3), a_cmd, 2000.0, 4442.0, 3.0,
                  alpha_trim=0.0, dt=dt)
        if k == 0:
            previous = ap.alpha_f.xd
            continue
        accel = (ap.alpha_f.xd - previous) / dt
        assert abs(accel) <= limit * (1.0 + 1e-9)
        previous = ap.alpha_f.xd


def test_back_calculation_bounds_rate_integral():
    """Back-calculation anti-windup under position saturation keeps the rate-loop
    integral from reaching the +/-5 limit."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    a_cmd = np.array([0.0, 0.0, -500.0])
    for k in range(300):
        ap.update(k * 0.005, q, np.zeros(3), a_cmd, 2000.0, 2.0e5, 10.0,
                  alpha_trim=0.0, is_saturated=False, dt=0.005)
    assert abs(ap.int_rate_p) < 2.0


# ============================================================
# Sideslip envelope (cruciform bank-to-turn)
# ============================================================
def _beta_reference(ap):
    """Current beta reference, whichever path (compiled or Python) is active."""
    if FC.NUMBA_AVAILABLE:
        return float(ap._state[3])
    return float(ap.beta_f.x)


def test_sideslip_reference_is_limited():
    """A strong lateral demand must not saturate the sideslip reference.

    The side-force channel is ~3x weaker than the lift channel, so without the
    limit a small lateral demand drives beta to alpha_max and parks both fin
    pairs on their stops.
    """
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    a_cmd = np.array([0.0, 60.0, -10.0])
    for k in range(600):
        ap.update(k * 0.005, q, np.zeros(3), a_cmd, 2000.0, 60000.0, 5.0,
                  alpha_trim=0.0, dt=0.005)
    assert abs(_beta_reference(ap)) <= C.AP_BETA_MAX * 1.05
    assert C.AP_BETA_MAX < C.AP_BETA_ENV


def test_sideslip_envelope_recovers():
    """Beyond the envelope the reference is driven to the opposite side."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    beta_trim = 20.0 * C.DEG
    for k in range(800):
        ap.update(k * 0.005, q, np.zeros(3), np.zeros(3), 2000.0, 60000.0, 5.0,
                  alpha_trim=0.0, beta_trim=beta_trim, dt=0.005)
    assert _beta_reference(ap) < -0.5 * C.AP_BETA_MAX


def test_roll_rate_tapered_at_high_alpha():
    """The roll command is reduced at high alpha (alpha*p sideslip coupling)."""
    q = np.array([1.0, 0.0, 0.0, 0.0])
    a_cmd = np.array([0.0, 3.0, -10.0])
    args = (0.0, q, np.zeros(3), a_cmd, 2000.0, 60000.0, 5.0)
    lo = Autopilot().update(*args, alpha_trim=0.0, dt=0.005)
    hi = Autopilot().update(*args, alpha_trim=25.0 * C.DEG, dt=0.005)
    assert abs(hi[2]) < 0.75 * abs(lo[2])


def test_alpha_envelope_limits_reference():
    """A guidance demand beyond the envelope must not hold alpha past it."""
    ap = Autopilot()
    q = np.array([1.0, 0.0, 0.0, 0.0])
    a_cmd = np.array([0.0, 0.0, -300.0])
    for k in range(400):
        ap.update(k * 0.005, q, np.zeros(3), a_cmd, 2000.0, 60000.0, 5.0,
                  alpha_trim=25.0 * C.DEG, dt=0.005)
    assert ap._state[0] <= C.AP_ALPHA_ENV * 1.02


# ============================================================
# Ramjet thrust control law (Mach-hold PI)
# ============================================================
def test_thrust_controller_mach_hold():
    """Full throttle below the reference Mach; above it the throttle is reduced
    and stays within bounds."""
    ctrl = ThrustController(mach_ref=8.0)
    ctrl.reset()
    for _ in range(100):
        thr = ctrl.update(0.01, 5.0, 20000.0, 1.0e5, "midcourse")
    assert thr == pytest.approx(1.0)

    for _ in range(1500):
        thr = ctrl.update(0.01, 10.0, 20000.0, 1.0e5, "midcourse")
    assert 0.0 <= thr < 0.2


def test_thrust_controller_boost_and_envelope_cutoff():
    """No throttle authority during boost (full thrust held); the throttle drops
    to zero above the atmosphere cutoff altitude."""
    ctrl = ThrustController(mach_ref=8.0)
    ctrl.reset()
    assert ctrl.update(0.01, 1.0, 0.0, 1.0e5, "boost") == pytest.approx(1.0)

    for _ in range(400):
        thr = ctrl.update(0.01, 8.0, C.RAMJET_ALT_CUTOFF + 1000.0,
                          1.0e5, "midcourse")
    assert thr == pytest.approx(0.0, abs=1e-3)


def test_thrust_controller_slew_rate():
    """The throttle command is rate-limited."""
    ctrl = ThrustController(mach_ref=8.0, tau=1e-9)
    ctrl.reset()
    prev = ctrl.throttle
    for _ in range(50):
        thr = ctrl.update(0.01, 8.0, C.RAMJET_ALT_CUTOFF + 1000.0,
                          1.0e5, "midcourse")
        assert prev - thr <= C.THROTTLE_RATE_MAX * 0.01 + 1e-6
        assert prev - thr >= -C.THROTTLE_RATE_MAX * 0.01 - 1e-6
        prev = thr


def test_thrust_controller_closed_loop_settles_with_droop():
    """With P control on a first-order Mach plant the loop settles with a bounded
    steady-state offset."""
    ctrl = ThrustController(mach_ref=8.0)
    ctrl.reset()
    mach = 6.0
    dt = 0.01
    for _ in range(3000):
        thr = ctrl.update(dt, mach, 20000.0, 1.0e5, "midcourse")
        mach += dt * (3.0 * thr - 0.25 * mach)
    droop = 8.0 - mach
    assert 0.0 < droop < 1.2          # inherent steady-state offset of pure P control
    assert 0.0 < thr < 1.0
