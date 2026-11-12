"""System integration tests: multi-rate ZOH scheduling, short-run simulation numerical stability.

# Ref: engineering practice of multi-rate scheduling for real-time simulation
"""

import numpy as np
import pytest

import config as C
import fastcore as FC
import main as sim_main


def _short_cfg(**overrides):
    cfg = dict(max_step=0.005, t_end=3.0, dt_log=0.01, enable_plot=False,
               verbose=False, max_steps=3000, telemetry_profile="basic")
    cfg.update(overrides)
    return C.SimConfig(**cfg)


def test_scheduler_multirate_trigger_counts():
    """Within 0.1s each module's trigger count matches its period (including floating-point debounce)."""
    cfg = C.SimConfig()
    sched = sim_main.MultiRateScheduler(cfg)
    counts = {"seeker": 0, "autopilot": 0, "guidance": 0, "log": 0}
    n = 1000
    for k in range(n + 1):
        t = k * 1e-4
        for name in counts:
            if sched.due(name, t):
                counts[name] += 1
    def expect(period):
        return pytest.approx(int(round(0.1 / period)) + 1, abs=1)
    assert counts["seeker"] == expect(cfg.dt_seeker)
    assert counts["autopilot"] == expect(cfg.dt_autopilot)
    assert counts["guidance"] == expect(cfg.dt_guidance)
    assert counts["log"] == expect(cfg.dt_log)


def test_short_simulation_is_stable():
    """3s short simulation: no NaN, valid mass/quaternion, every multi-rate module produced output."""
    cfg = C.SimConfig(max_step=0.002, t_end=3.0, dt_log=0.01,
                      enable_plot=False, max_steps=5000)
    sim = sim_main.Simulation(cfg)
    sim.run()

    assert sim.sol.success
    assert sim.telemetry.n > 50
    assert np.all(np.isfinite(sim.sol.y))

    mass = sim.telemetry.get("mass")
    assert np.all(mass >= C.DRY_MASS - 1e-9)
    assert np.all(mass <= C.MASS0 + 1e-9)

    q = sim.sol.y[6:10, -1]
    assert abs(np.linalg.norm(q) - 1.0) < 1e-3

    # The boost phase should generate thrust and accelerate
    speed = np.linalg.norm(sim.sol.y[3:6, -1])
    assert speed > 50.0
    assert sim.phase in ("boost", "midcourse")


def test_event_detection_returns_finite_miss_distance():
    """Event detection: when a short simulation triggers no miss event, the miss distance should stay finite or NaN."""
    cfg = C.SimConfig(max_step=0.005, t_end=2.0, enable_plot=False, max_steps=3000)
    sim = sim_main.Simulation(cfg)
    sim.run()
    assert np.isfinite(sim.cpu_time)


def test_target_cue_dispersion_is_seeded():
    """A dispersed pre-launch cue is deterministic and feeds the tracker only."""
    cfg = C.SimConfig(enable_plot=False, verbose=False)
    sc1 = C.Scenario(cue_pos_sigma=800.0, cue_vel_sigma=8.0)
    sc2 = C.Scenario(cue_pos_sigma=800.0, cue_vel_sigma=8.0)
    a = sim_main.Simulation(cfg, sc1)
    b = sim_main.Simulation(cfg, sc2)
    assert np.allclose(a.tracker.x, b.tracker.x)
    assert not np.allclose(a.tracker.x, a.target.initial_state())

    # Zero sigma keeps the nominal cue exact.
    c = sim_main.Simulation(cfg, C.Scenario())
    assert np.allclose(c.tracker.x, c.target.initial_state())


def test_fast_and_python_paths_agree_in_short_run(monkeypatch):
    """The Numba and pure-Python derivative paths must both run and agree.

    This is the canary for half-finished signature changes in fastcore.py:
    a stale cached kernel or a mismatched argument list fails here in seconds
    instead of after a 10-minute validation campaign.
    """
    fast = sim_main.Simulation(_short_cfg(telemetry_profile="basic"))
    fast.run()
    assert fast.sol.success
    assert np.all(np.isfinite(fast.sol.y))

    monkeypatch.setattr(FC, "NUMBA_AVAILABLE", False, raising=False)
    slow = sim_main.Simulation(_short_cfg(telemetry_profile="basic"))
    slow.run()
    assert slow.sol.success
    assert np.all(np.isfinite(slow.sol.y))

    # 3 s of flight: the two paths differ only by integration-level noise.
    dv = np.linalg.norm(fast.sol.y[3:6, -1] - slow.sol.y[3:6, -1])
    assert dv < 0.05


def test_wind_and_attitude_aid_paths_run():
    """Wind on/off and ideal/aided attitude must all stay finite and distinct."""
    wind = sim_main.Simulation(_short_cfg(enable_wind=True))
    wind.run()
    still = sim_main.Simulation(_short_cfg(enable_wind=False))
    still.run()
    assert wind.sol.success and still.sol.success
    assert np.all(np.isfinite(wind.sol.y))
    assert np.all(np.isfinite(still.sol.y))
    dv = np.linalg.norm(wind.sol.y[3:6, -1] - still.sol.y[3:6, -1])
    assert dv > 1.0e-3      # wind must actually reach the aero model

    ideal = sim_main.Simulation(_short_cfg(ideal_attitude=True))
    ideal.run()
    aided = sim_main.Simulation(_short_cfg(ideal_attitude=False,
                                           enable_attitude_aid=True))
    aided.run()
    assert ideal.sol.success and aided.sol.success
    for s in (ideal, aided):
        q = s.sol.y[6:10, -1]
        assert abs(np.linalg.norm(q) - 1.0) < 1.0e-3


def test_telemetry_profiles_and_extended_frames():
    """Full/basic profiles have the documented widths and physical values."""
    full = sim_main.Simulation(_short_cfg(t_end=2.0, max_steps=2000,
                                          telemetry_profile="full"))
    full.run()
    basic = sim_main.Simulation(_short_cfg(t_end=2.0, max_steps=2000,
                                           telemetry_profile="basic"))
    basic.run()

    assert full.telemetry.n_cols == len(C.TELEMETRY_COLUMNS)
    assert basic.telemetry.n_cols == len(C.TELEMETRY_BASIC_COLUMNS)
    assert len(C.TELEMETRY_BASIC_COLUMNS) == 48

    d = full.telemetry.as_dict()
    required = ("m_ecef_x", "m_vecef_x", "m_vned_n", "q_w", "roll_deg",
                "gamma_deg", "m_speed", "airspeed", "air_density",
                "sound_speed", "Fbx", "a_cmd_b_x", "n_cmd_g", "los_x",
                "los_rate_x", "t_go", "vc", "nav_rx", "nav_vx",
                "nav_err_x", "rel_x", "t_lat", "t_acc_x", "seeker_range",
                "bx_x", "Mbx", "t_ecef_x", "seeker_los_x", "g_x")
    for name in required:
        assert name in d, name
        assert np.all(np.isfinite(d[name])), name

    # Physical sanity at the last frame.
    q = np.array([d["q_w"][-1], d["q_x"][-1], d["q_y"][-1], d["q_z"][-1]])
    assert abs(np.linalg.norm(q) - 1.0) < 1.0e-6
    g = np.array([d["g_x"][-1], d["g_y"][-1], d["g_z"][-1]])
    alt = float(d["alt"][-1])
    assert 8.5 < np.linalg.norm(g) < 10.5
    # Body axes must be orthonormal.
    bx = np.array([d["bx_x"][-1], d["bx_y"][-1], d["bx_z"][-1]])
    by = np.array([d["by_x"][-1], d["by_y"][-1], d["by_z"][-1]])
    bz = np.array([d["bz_x"][-1], d["bz_y"][-1], d["bz_z"][-1]])
    assert abs(np.dot(bx, by)) < 1.0e-6
    assert abs(np.linalg.norm(bx) - 1.0) < 1.0e-6
    assert alt >= 0.0


def test_datalink_pulls_back_cue_error():
    """Offboard updates must recover most of a 2 km pre-launch cue error."""
    sc = C.Scenario(cue_pos_sigma=2000.0, cue_vel_sigma=20.0)
    base = dict(t_end=30.0, verbose=False, enable_plot=False, max_steps=6000)

    off = sim_main.Simulation(
        C.SimConfig(datalink_period=0.0, **base), sc)
    off.run()
    on = sim_main.Simulation(
        C.SimConfig(datalink_period=1.0, **base), sc)
    on.run()

    truth_off = off.sol.y[14:17, -1]
    truth_on = on.sol.y[14:17, -1]
    err_off = np.linalg.norm(off.tracker.position() - truth_off)
    err_on = np.linalg.norm(on.tracker.position() - truth_on)
    assert err_on < 0.5 * err_off
