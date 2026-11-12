"""Guidance and handover tests: hard gates, ZEM/APN correction, Bezier endpoints/tangents.

# Ref: JAST-Bezier; ZEM/APN
"""

from types import SimpleNamespace
import numpy as np
import pytest

import config as C
import math_utils as MU
from guidance.midcourse_guidance import BezierPath, MidcourseGuidance
from guidance.terminal_guidance import TerminalGuidance
from guidance.handover_manager import HandoverManager


def _make_scene(alt_m=31000.0, dh_km=11.0, speed=2000.0, lead_deg=0.0, fov=0.1):
    r_m = MU.llh_to_eci(40.0, 110.0, alt_m, 0.0)
    up = MU.normalize(r_m)
    # Horizontal direction: local east
    h_dir = MU.normalize(MU.perpendicular(np.array([0.0, 1.0, 0.0]), up))
    r_t = r_m + h_dir * 18000.0 - up * (dh_km * 1000.0)
    los = MU.normalize(r_t - r_m)
    # Velocity direction deviates from the line of sight by lead_deg
    perp = MU.normalize(np.cross(los, up))
    v_dir = MU.normalize(np.cos(lead_deg * C.DEG) * los
                         + np.sin(lead_deg * C.DEG) * perp)
    v_m = v_dir * speed
    v_t = -los * 500.0
    m_state = C.MissileState(
        r_eci=r_m, v_eci=v_m, q=np.array([1.0, 0.0, 0.0, 0.0]),
        omega_body=np.zeros(3), mass=1200.0, inertia=np.eye(3) * 3000.0,
        cg_pos=4.2)
    t_state = np.concatenate([r_t, v_t])
    rng = float(np.linalg.norm(r_t - r_m))
    seeker = SimpleNamespace(is_locked=True, confirmed=True, fov_angle=fov,
                             los_angle=los, los_rate=np.zeros(3),
                             range=rng, range_rate=-2500.0)
    aero = {"q_dyn": 800000.0, "CN_ALPHA": 1.6}
    return m_state, t_state, seeker, aero


def test_handover_all_gates_pass():
    m_state, t_state, seeker, aero = _make_scene()
    mgr = HandoverManager(dwell=0.0)
    ok, info = mgr.check(0.0, m_state, t_state, seeker, aero)
    assert ok, info
    assert info["dh"] > C.HANDOVER_DH_MIN
    assert info["range"] <= C.HANDOVER_RANGE
    assert info["lead_angle"] <= C.HANDOVER_ANGLE_MAX


@pytest.mark.parametrize("kwargs", [
    {"dh_km": -10.0},     # altitude too low even for the diving fallback
    {"dh_km": 35.0},      # altitude difference too large
    {"speed": 1000.0},    # speed insufficient
    {"lead_deg": 30.0},   # head-on angle out of limits
])
def test_handover_rejects_bad_geometry(kwargs):
    m_state, t_state, seeker, aero = _make_scene(**kwargs)
    mgr = HandoverManager(dwell=0.0)
    ok, info = mgr.check(0.0, m_state, t_state, seeker, aero)
    assert not ok


def test_handover_rejects_no_seeker_lock():
    m_state, t_state, seeker, aero = _make_scene()
    seeker.is_locked = False
    mgr = HandoverManager(dwell=0.0)
    ok, info = mgr.check(0.0, m_state, t_state, seeker, aero)
    assert not ok
    assert not info["gates"]["seeker_lock"]


def test_handover_blend_weight_decreases():
    """After handover the weight drops linearly from 1 to 0 over the blend time (0.5 s)."""
    mgr = HandoverManager()
    a_mid = np.array([10.0, 0.0, 0.0])
    a_term = np.array([0.0, 10.0, 0.0])
    _, trig, w0 = mgr.update(100.0, True, a_mid, a_term)
    assert trig and w0 == pytest.approx(1.0)
    _, _, w1 = mgr.update(100.25, False, a_mid, a_term)
    assert 0.4 < w1 < 0.6
    a2, _, w2 = mgr.update(100.6, False, a_mid, a_term)
    assert w2 == 0.0
    assert np.allclose(a2, a_term)


def test_bezier_endpoints_and_tangent():
    p0 = np.array([0.0, 0.0, 0.0])
    p1 = np.array([10.0, 0.0, 0.0])
    p2 = np.array([20.0, 10.0, 0.0])
    p3 = np.array([30.0, 10.0, 0.0])
    path = BezierPath(p0, p1, p2, p3, 10.0)
    pos0, d0, _ = path.evaluate(0.0)
    pos1, d1, _ = path.evaluate(1.0)
    assert np.allclose(pos0, p0)
    assert np.allclose(pos1, p3)
    assert np.dot(d0, p1 - p0) > 0.0
    assert np.dot(d1, p3 - p2) > 0.0


def test_midcourse_lead_point_predicts_target_motion():
    """The midcourse aim point leads a crossing target by ~asin(Vt/Vm)."""
    mid = MidcourseGuidance()
    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    up = MU.normalize(r_m)
    h_dir = MU.normalize(MU.perpendicular(np.array([0.0, 1.0, 0.0]), up))
    r_t = r_m + h_dir * 100000.0 - up * 15000.0
    v_m = MU.normalize(r_t - r_m) * 2000.0
    v_t = MU.normalize(np.cross(up, h_dir)) * 300.0
    nav = SimpleNamespace(r_eci=r_m, v_eci=v_m, timestamp=0.0)
    t_state = np.concatenate([r_t, v_t])

    pip, t_go = mid.lead_point(nav, t_state)
    lead = MU.angle_between(pip - r_m, r_t - r_m)
    expected = np.arcsin(300.0 / 2000.0)
    assert t_go > 0.0
    assert np.dot(pip - r_t, v_t) > 0.0          # aim point is ahead of the target
    assert abs(lead - expected) < 1.5 * C.DEG

    cmd = mid.compute(0.0, nav, t_state)
    assert np.all(np.isfinite(cmd.a_cmd_eci))
    assert np.linalg.norm(cmd.a_cmd_eci) > 0.0


def test_midcourse_coplanar_bias_drives_into_target_plane():
    """The cross-plane ZEM term must push an offset missile back into the
    target's ground-track vertical plane (and do nothing when coplanar)."""
    r_t = np.array([0.0, -100000.0, C.RE + 15000.0])
    v_t = np.array([0.0, 600.0, 0.0])
    t_state = np.concatenate([r_t, v_t])
    up_t = MU.normalize(r_t)
    v_t_air = MU.atmosphere_relative_velocity(r_t, v_t)
    n = MU.normalize(MU.cross3(r_t, v_t_air))
    h = MU.normalize(MU.perpendicular(v_t_air, up_t))

    # Missile laterally offset from the target ground track.
    r_m = np.array([30000.0, 0.0, C.RE + 30000.0])
    v_m = np.array([0.0, -2000.0, 0.0])
    a = MidcourseGuidance.coplanar_bias(r_m, v_m, t_state)
    assert np.dot(r_m - r_t, n) < 0.0
    assert np.dot(a, n) > 0.0                  # towards the target plane
    assert abs(np.dot(a, n)) <= C.MIDCOURSE_COPLANAR_ACC_MAX + 1e-6

    # Missile already in the plane, head-on: no correction.
    a0 = MidcourseGuidance.coplanar_bias(r_t + h * 50000.0, -h * 2000.0, t_state)
    assert np.linalg.norm(a0) < 2.0

    # Beyond the ramp start range the term is disabled.
    r_far = r_t + h * (C.MIDCOURSE_COPLANAR_RANGE + 100000.0)
    a_far = MidcourseGuidance.coplanar_bias(r_far, -h * 2000.0, t_state)
    assert np.allclose(a_far, 0.0)


def test_terminal_guidance_corrects_los_offset():
    """Terminal guidance issues a non-zero correction command for a target off the line of sight, within the load limit."""
    term = TerminalGuidance()
    r_m = MU.llh_to_eci(40.0, 110.0, 30000.0, 0.0)
    up = MU.normalize(r_m)
    h_dir = MU.normalize(np.cross(up, np.array([0.0, 0.0, 1.0])))
    r_t = r_m + h_dir * 8000.0 - up * 3000.0
    nav = SimpleNamespace(
        r_eci=r_m, v_eci=h_dir * 1500.0 + up * 300.0, timestamp=0.0)
    target_state = np.concatenate([r_t, -h_dir * 500.0 + up * 100.0])
    seeker = SimpleNamespace(is_locked=True, fov_angle=0.2,
                             los_angle=MU.normalize(r_t - r_m),
                             los_rate=np.zeros(3), range=8000.0,
                             range_rate=-1500.0)
    cmd = term.compute(0.0, nav, target_state, np.array([1.0, 0.0, 0.0, 0.0]), seeker)
    assert np.all(np.isfinite(cmd.a_cmd_eci))
    assert 0.0 < np.linalg.norm(cmd.a_cmd_eci) <= 40.0 * C.G0 + 1e-6
    assert cmd.phase == "terminal"
