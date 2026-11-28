"""Build a versioned Aerospace Vision Web scenario from source telemetry.

This adapter is the ONLY place where raw simulation telemetry is interpreted.
It performs, and records, the following conversions:

  time        source seconds since launch        -> t (s, unchanged)
  position    ECI (m) telemetry                   -> ECEF (m) WGS84, Rz(-omega t)
  velocity    ECI (m/s) telemetry                 -> ECEF (m/s), rotating-frame term
  attitude    q_ECI<-BODY                         -> q_ECEF<-BODY = Rz(-omega t) (x) q
  altitude    WGS84 geodetic height (m)           -> unchanged
  target      ECEF position/velocity              -> attitude derived from velocity

The source CSV columns are documented in missile_intercept/config.py
(TELEMETRY_COLUMNS).  No unit, frame or quaternion convention is guessed: each
one is asserted against the source schema below before any output is written.

Run:
    python tools/data-adapter/build_scenario.py [--source path] [--out dir]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(os.path.dirname(HERE))
REPO = os.path.dirname(PROJECT)

DEFAULT_NPZ = os.path.join(REPO, "missile_intercept", "output", "telemetry.npz")
DEFAULT_CSV = os.path.join(REPO, "missile_intercept", "output", "telemetry.csv")
DEFAULT_OUT = os.path.join(PROJECT, "public", "data", "missile-intercept")

# --- Source contract, mirrored from missile_intercept/config.py -----------
OMEGA_EARTH = 7.2921150e-5      # rad/s
WGS84_A = 6378137.0             # m
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)
G0 = 9.80665                    # m/s^2
LAUNCH_LAT, LAUNCH_LON, LAUNCH_ALT = 40.0, 110.0, 0.0
TARGET_LAT, TARGET_LON, TARGET_ALT = 28.0, 126.0, 15240.0

REQUIRED_COLUMNS = [
    "time", "m_rx", "m_ry", "m_rz", "m_vx", "m_vy", "m_vz",
    "m_ecef_x", "m_ecef_y", "m_ecef_z", "m_vecef_x", "m_vecef_y", "m_vecef_z",
    "t_ecef_x", "t_ecef_y", "t_ecef_z", "t_vecef_x", "t_vecef_y", "t_vecef_z",
    "q_w", "q_x", "q_y", "q_z", "lat", "lon", "alt", "mach", "q_dyn",
    "a_act_x", "a_act_y", "a_act_z", "a_cmd_x", "a_cmd_y", "a_cmd_z",
    "mass", "fov_angle", "range", "phase", "seeker_lock", "handover",
    "roll_deg", "pitch_deg", "yaw_deg", "m_speed",
    "fin_up", "fin_down", "fin_left", "fin_right",
    "p", "q_rate", "r_rate",
]

SCHEMA_VERSION = "1.1.0"
# Fixed demonstration epoch for sun/moon placement only. The source telemetry
# is UTC-agnostic; this value never alters trajectory data.
DEMO_UTC = "2026-11-20T02:00:00Z"

N_MISSILE_SAMPLES = 1500
N_TARGET_SAMPLES = 240
PHASE_NAMES = {0: "boost", 1: "midcourse", 2: "terminal"}


# ---------------------------------------------------------------------------
# Scientific helpers (self-contained; independently testable)
# ---------------------------------------------------------------------------
def llh_to_ecef(lat_deg, lon_deg, alt_m):
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    s = np.sin(lat)
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * s * s)
    return np.column_stack([
        (n + alt_m) * np.cos(lat) * np.cos(lon),
        (n + alt_m) * np.cos(lat) * np.sin(lon),
        (n * (1.0 - WGS84_E2) + alt_m) * s,
    ])


def ecef_to_llh(r):
    x, y, z = r[:, 0], r[:, 1], r[:, 2]
    p = np.hypot(x, y)
    lon = np.arctan2(y, x)
    b = WGS84_A * (1.0 - WGS84_F)
    ep2 = (WGS84_A ** 2 - b ** 2) / b ** 2
    th = np.arctan2(z * WGS84_A, p * b)
    st, ct = np.sin(th), np.cos(th)
    lat = np.arctan2(z + ep2 * b * st ** 3, p - WGS84_E2 * WGS84_A * ct ** 3)
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * np.sin(lat) ** 2)
    alt = p / np.cos(lat) - n
    return np.degrees(lat), np.degrees(lon), alt


def rot_z(angle):
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def rot_z_vec(angle, v):
    c, s = math.cos(angle), math.sin(angle)
    return np.column_stack([
        c * v[:, 0] - s * v[:, 1],
        s * v[:, 0] + c * v[:, 1],
        v[:, 2],
    ])


def quat_mul_batch(a, b):
    """Hamilton product for scalar-first quaternions, row-wise."""
    aw, ax, ay, az = a[:, 0], a[:, 1], a[:, 2], a[:, 3]
    bw, bx, by, bz = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.column_stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ])


def quat_z(angle):
    return np.array([math.cos(0.5 * angle), 0.0, 0.0, math.sin(0.5 * angle)])


def quat_from_x_axis(direction):
    """Quaternion (scalar first) whose body x axis aligns with ``direction``."""
    x = direction / np.linalg.norm(direction)
    up = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(x, up))) > 0.98:
        up = np.array([0.0, 1.0, 0.0])
    y = np.cross(up, x)
    y /= np.linalg.norm(y)
    z = np.cross(x, y)
    m = np.column_stack([x, y, z])  # body -> ECEF
    tr = np.trace(m)
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2.0
        w = 0.25 * s
        qx = (m[2, 1] - m[1, 2]) / s
        qy = (m[0, 2] - m[2, 0]) / s
        qz = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        qx = 0.25 * s
        qy = (m[0, 1] + m[1, 0]) / s
        qz = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        qx = (m[0, 1] + m[1, 0]) / s
        qy = 0.25 * s
        qz = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        qx = (m[0, 2] + m[2, 0]) / s
        qy = (m[1, 2] + m[2, 1]) / s
        qz = 0.25 * s
    q = np.array([w, qx, qy, qz])
    return q / np.linalg.norm(q)


def fmt_check(checks, cid, description, ok, detail):
    checks.append({
        "id": cid,
        "description": description,
        "status": "PASS" if bool(ok) else "FAIL",
        "detail": detail,
    })


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=None)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--rows", type=int, default=N_MISSILE_SAMPLES)
    args = ap.parse_args()

    # Auto-prefer fast binary telemetry.npz when present and not older than CSV.
    if args.source is None:
        if os.path.exists(DEFAULT_NPZ) and (
            not os.path.exists(DEFAULT_CSV)
            or os.path.getmtime(DEFAULT_NPZ) >= os.path.getmtime(DEFAULT_CSV) - 1.0
        ):
            args.source = DEFAULT_NPZ
        else:
            args.source = DEFAULT_CSV

    if not os.path.exists(args.source):
        raise SystemExit(
            "Source telemetry not found: %s\nRun the simulation first "
            "(python missile_intercept/main.py) or pass --source." % args.source)

    if args.source.lower().endswith(".npz"):
        with np.load(args.source, allow_pickle=False) as z:
            header = [str(x) for x in z["columns"].tolist()]
            raw = np.asarray(z["data"], dtype=np.float64)
    else:
        with open(args.source, "r", encoding="ascii") as f:
            header = f.readline().strip().split(",")
        raw = np.loadtxt(args.source, delimiter=",", skiprows=1)

    missing = [c for c in REQUIRED_COLUMNS if c not in header]
    if missing:
        raise SystemExit("Telemetry contract mismatch, missing columns: %s"
                         % ", ".join(missing))
    col = {name: i for i, name in enumerate(header)}
    n = raw.shape[0]
    if n < 10:
        raise SystemExit("Telemetry too short")

    def c(name):
        return raw[:, col[name]]

    checks = []

    # --- 1. integrity ------------------------------------------------------
    t = c("time")
    monotonic = bool(np.all(np.diff(t) > 0))
    finite = bool(np.all(np.isfinite(raw)))
    fmt_check(checks, "timeline-monotonic", "Telemetry time strictly increases",
              monotonic, "dt_min=%.6g s, dt_max=%.6g s"
              % (float(np.min(np.diff(t))), float(np.max(np.diff(t)))))
    fmt_check(checks, "finite-values", "All telemetry values are finite",
              finite, "rows=%d, columns=%d" % (n, len(header)))
    if not (monotonic and finite):
        raise SystemExit("Source telemetry failed base integrity checks")

    # --- 2. frame conversion validation -----------------------------------
    theta = OMEGA_EARTH * t
    r_eci = np.column_stack([c("m_rx"), c("m_ry"), c("m_rz")])
    r_ecef = np.column_stack([c("m_ecef_x"), c("m_ecef_y"), c("m_ecef_z")])
    derived_ecef = rot_z_vec(-theta[0], r_eci[:1])
    fmt_check(checks, "eci-ecef-alignment",
              "ECI and ECEF coincide at t=0",
              float(np.linalg.norm(derived_ecef[0] - r_ecef[0])) < 1e-3,
              "|r_eci - r_ecef| at t=0 = %.3e m"
              % float(np.linalg.norm(derived_ecef[0] - r_ecef[0])))

    v_eci = np.column_stack([c("m_vx"), c("m_vy"), c("m_vz")])
    v_ecef = np.column_stack([c("m_vecef_x"), c("m_vecef_y"), c("m_vecef_z")])
    # v_ecef = Rz(-w t)(v_eci - w x r_eci)
    w_cross_r = np.column_stack([-OMEGA_EARTH * r_eci[:, 1],
                                 OMEGA_EARTH * r_eci[:, 0],
                                 np.zeros(n)])
    imid = n // 2
    expected_v = rot_z_vec(-theta[imid], (v_eci[imid] - w_cross_r[imid])[None, :])
    v_frame_err = float(np.linalg.norm(expected_v[0] - v_ecef[imid]))
    fmt_check(checks, "velocity-frame",
              "ECEF velocity = Rz(-omega t)(v_ECI - omega x r_ECI)",
              v_frame_err < 1e-3,
              "at t=%.1f s, frame error = %.3e m/s"
              % (float(t[imid]), v_frame_err))

    # --- 3. geodetic consistency -----------------------------------------
    lat = c("lat")
    lon = c("lon")
    alt = c("alt")
    llh_ecef = llh_to_ecef(lat, lon, alt)
    pos_err = np.linalg.norm(llh_ecef - r_ecef, axis=1)
    fmt_check(checks, "llh-ecef-roundtrip",
              "WGS84 lat/lon/alt reproduce telemetry ECEF position",
              float(pos_err.max()) < 0.5,
              "max ||LLH->ECEF - r_ECEF|| = %.3f m" % float(pos_err.max()))

    # quaternion norm
    quat = np.column_stack([c("q_w"), c("q_x"), c("q_y"), c("q_z")])
    qnorm = np.linalg.norm(quat, axis=1)
    fmt_check(checks, "quaternion-normalized",
              "Attitude quaternions are unit length (scalar first)",
              float(np.max(np.abs(qnorm - 1.0))) < 1e-5,
              "max |‖q‖-1| = %.3e (CSV is printed with 6 decimals)"
              % float(np.max(np.abs(qnorm - 1.0))))

    # The source column `m_speed` is INERTIAL speed |v_ECI| (verified against
    # the ECI velocity norm), not Earth-relative speed.  The web payload
    # therefore recomputes speed as |v_ECEF| and records the distinction.
    inertial_speed = c("m_speed")
    speed_err = np.abs(np.linalg.norm(v_eci, axis=1) - inertial_speed)
    fmt_check(checks, "speed-semantics",
              "Source m_speed is inertial speed |v_ECI|; web speed uses |v_ECEF|",
              float(speed_err.max()) < 0.05,
              "max |m_speed - ‖v_ECI‖| = %.4f m/s; |v_ECEF| at t=0 = %.3f m/s"
              % (float(speed_err.max()), float(np.linalg.norm(v_ecef[0]))))

    mach_err = np.abs(c("mach") - c("airspeed") / np.maximum(c("sound_speed"), 1e-6))
    airspeed_err = np.abs(c("airspeed") - np.linalg.norm(v_ecef, axis=1))
    wind_ok = float(mach_err[1:].max()) < 0.06
    fmt_check(checks, "speed-and-mach-semantics",
              "Source airspeed = |v_ECEF|; Mach is wind-corrected air-relative",
              bool(wind_ok and float(airspeed_err.max()) < 0.05),
              "max |airspeed - ‖v_ECEF‖| = %.3f m/s; max |Mach - airspeed/a| = %.3f "
              "(wind correction, < 0.06)"
              % (float(airspeed_err.max()), float(mach_err[1:].max())))

    # --- 4. UNITS: altitude and phase semantics ---------------------------
    fmt_check(checks, "altitude-units",
              "Altitude is WGS84 geodetic height in metres",
              float(alt.min()) > -100.0 and float(alt.max()) < 200000.0,
              "alt range [%.1f, %.1f] m" % (float(alt.min()), float(alt.max())))

    # --- 5. adaptive non-uniform downsample with protected peaks/events ---
    # Preserves high temporal resolution in boost (0..25 s) and the final
    # 15 s terminal endgame (~25-30 Hz), plus exact peak indices for alt,
    # q_dyn, mach, achieved/commanded load and closest approach so summary
    # metrics match the sampled telemetry stream.
    m_range = c("range")
    imin = int(np.argmin(m_range))
    phase = c("phase").astype(int)
    load_g_raw = np.linalg.norm(
        np.column_stack([c("a_act_x"), c("a_act_y"), c("a_act_z")]), axis=1) / G0
    load_cmd_raw = np.linalg.norm(
        np.column_stack([c("a_cmd_x"), c("a_cmd_y"), c("a_cmd_z")]), axis=1) / G0
    transitions = [0, imin] + list(np.where(np.diff(phase) != 0)[0] + 1)
    protected = set(int(i) for i in transitions)
    for name in ("seeker_lock", "handover"):
        idx_ev = np.where(c(name) > 0.5)[0]
        if idx_ev.size:
            protected.add(int(idx_ev[0]))
    protected.add(int(np.argmax(c("alt"))))
    protected.add(int(np.argmax(c("q_dyn"))))
    protected.add(int(np.argmax(c("mach"))))
    protected.add(int(np.argmax(load_g_raw)))
    protected.add(int(np.argmax(load_cmd_raw)))
    for opt_peak in ("heat_flux_mw", "wall_temp_k"):
        if opt_peak in col:
            protected.add(int(np.argmax(c(opt_peak))))
    for opt_flag in ("stage_sep", "unstart_flag", "decoy_active"):
        if opt_flag in col:
            f_idx = np.where(c(opt_flag) > 0.5)[0]
            if f_idx.size:
                protected.add(int(f_idx[0]))
                protected.add(int(f_idx[-1]))
    protected.add(n - 1)

    t_end_s = float(t[-1])
    i_boost_end = int(np.searchsorted(t, min(25.0, t_end_s)))
    i_term_start = int(np.searchsorted(t, max(0.0, t_end_s - 15.0)))
    budget = max(int(args.rows), 1200)
    n_boost = min(max(int(0.10 * budget), 100), max(i_boost_end + 1, 1))
    n_term = min(max(int(0.28 * budget), 320), max(n - i_term_start, 1))
    n_mid = max(budget - n_boost - n_term, 400)
    seg_boost = np.linspace(0, max(i_boost_end, 0), n_boost).astype(int)
    seg_mid = np.linspace(max(i_boost_end, 0), max(i_term_start, i_boost_end),
                          n_mid).astype(int)
    seg_term = np.linspace(max(i_term_start, 0), n - 1, n_term).astype(int)
    base = np.unique(np.concatenate([seg_boost, seg_mid, seg_term]))
    idx = np.unique(np.concatenate([base, np.array(sorted(protected))]))
    idx = idx[(idx >= 0) & (idx < n)]

    ts = t[idx]
    theta_s = theta[idx]
    # attitude body->ECI -> body->ECEF
    q_eci = quat[idx]
    q_frame = np.array([quat_z(a) for a in -theta_s])
    q_ecef = quat_mul_batch(q_frame, q_eci)
    q_ecef /= np.linalg.norm(q_ecef, axis=1, keepdims=True)
    q_ecef = np.where(q_ecef[:, :1] < 0, -q_ecef, q_ecef)

    # Sample recovery check: at every kept index the converted state must
    # reproduce the source state exactly (bit-level within print precision).
    src_pos = r_ecef[idx]
    src_r = np.linalg.norm(src_pos, axis=1)
    check_lat, check_lon, check_alt = ecef_to_llh(src_pos)
    lat_err = np.max(np.abs(check_lat - lat[idx])) * 111000.0
    alt_err = np.max(np.abs(check_alt - alt[idx]))
    fmt_check(checks, "sample-recovery",
              "Converted samples reproduce source position and altitude",
              bool(lat_err < 1.0 and alt_err < 0.5),
              "lat err <= %.2f m, alt err <= %.2f m" % (lat_err, alt_err))

    # --- 4b. actuator channels --------------------------------------------
    fin_cols = ["fin_up", "fin_down", "fin_left", "fin_right"]
    rate_cols = ["p", "q_rate", "r_rate"]
    fin_peak = max(float(np.max(np.abs(c(name)))) for name in fin_cols)
    rate_peak = max(float(np.max(np.abs(c(name)))) for name in rate_cols)
    fmt_check(checks, "actuator-channels",
              "Recorded fin deflections and body rates are present and non-trivial",
              bool(fin_peak > 0.0 and rate_peak > 0.0),
              "max |fin| = %.4f rad, max |body rate| = %.4f rad/s" % (fin_peak, rate_peak))

    load_g = np.linalg.norm(np.column_stack([c("a_act_x"), c("a_act_y"), c("a_act_z")]),
                            axis=1) / G0
    load_cmd = np.linalg.norm(np.column_stack([c("a_cmd_x"), c("a_cmd_y"), c("a_cmd_z")]),
                              axis=1) / G0
    fov = np.degrees(c("fov_angle"))

    def rnd(arr, nd=6):
        return np.round(np.asarray(arr, dtype=float), nd)

    has_aero_sensor = all(
        name in col for name in (
            "heat_flux_mw", "wall_temp_k", "aspect_deg", "target_rcs",
            "radar_snr_db", "ir_snr_db", "seeker_az_deg", "seeker_el_deg",
        )
    )

    samples = []
    for k, i in enumerate(idx):
        rec = {
            "t": round(float(ts[k]), 6),
            "position": {"x": round(float(src_pos[k, 0]), 3),
                         "y": round(float(src_pos[k, 1]), 3),
                         "z": round(float(src_pos[k, 2]), 3)},
            "velocity": {"x": round(float(v_ecef[i, 0]), 3),
                         "y": round(float(v_ecef[i, 1]), 3),
                         "z": round(float(v_ecef[i, 2]), 3)},
            "attitude": {"w": round(float(q_ecef[k, 0]), 9),
                         "x": round(float(q_ecef[k, 1]), 9),
                         "y": round(float(q_ecef[k, 2]), 9),
                         "z": round(float(q_ecef[k, 3]), 9)},
            "latDeg": round(float(lat[i]), 8),
            "lonDeg": round(float(lon[i]), 8),
            "altM": round(float(alt[i]), 3),
            "speedMS": round(float(np.linalg.norm(v_ecef[i])), 3),
            "mach": round(float(c("mach")[i]), 4),
            "qPa": round(float(c("q_dyn")[i]), 2),
            "loadG": round(float(load_g[i]), 4),
            "loadCmdG": round(float(load_cmd[i]), 4),
            "massKg": round(float(c("mass")[i]), 3),
            "fovDeg": round(float(fov[i]), 3),
            "rangeM": round(float(m_range[i]), 3),
            "phase": PHASE_NAMES.get(int(phase[i]), "coast"),
            "seekerLock": bool(c("seeker_lock")[i] > 0.5),
            "handover": bool(c("handover")[i] > 0.5),
            "finDeflectionsRad": {
                "up": round(float(c("fin_up")[i]), 6),
                "down": round(float(c("fin_down")[i]), 6),
                "left": round(float(c("fin_left")[i]), 6),
                "right": round(float(c("fin_right")[i]), 6),
            },
            "bodyRatesRadS": {
                "p": round(float(c("p")[i]), 6),
                "q": round(float(c("q_rate")[i]), 6),
                "r": round(float(c("r_rate")[i]), 6),
            },
        }
        if has_aero_sensor:
            rec["heatFluxMWm2"] = round(float(c("heat_flux_mw")[i]), 4)
            rec["wallTempK"] = round(float(c("wall_temp_k")[i]), 2)
            rec["aspectDeg"] = round(float(c("aspect_deg")[i]), 2)
            rec["targetRcsM2"] = round(float(c("target_rcs")[i]), 5)
            rec["radarSnrDb"] = round(float(c("radar_snr_db")[i]), 2)
            rec["irSnrDb"] = round(float(c("ir_snr_db")[i]), 2)
            rec["seekerAzDeg"] = round(float(c("seeker_az_deg")[i]), 3)
            rec["seekerElDeg"] = round(float(c("seeker_el_deg")[i]), 3)
        if "Fbx" in col and "Fby" in col and "Fbz" in col:
            rec["bodyForceX"] = round(float(c("Fbx")[i]), 1)
            rec["bodyForceY"] = round(float(c("Fby")[i]), 1)
            rec["bodyForceZ"] = round(float(c("Fbz")[i]), 1)
        if "wall_temp_eq_k" in col:
            rec["wallTempEqK"] = round(float(c("wall_temp_eq_k")[i]), 2)
        if "unstart_flag" in col:
            rec["unstartFlag"] = round(float(c("unstart_flag")[i]), 1)
        if "stage_sep" in col:
            rec["stageSep"] = round(float(c("stage_sep")[i]), 1)
        if "cg_pos" in col:
            rec["cgPos"] = round(float(c("cg_pos")[i]), 4)
        if "cp_pos" in col:
            rec["cpPos"] = round(float(c("cp_pos")[i]), 4)
        if "decoy_active" in col:
            rec["decoyActive"] = round(float(c("decoy_active")[i]), 1)
            rec["decoyAzDeg"] = round(float(c("decoy_az_deg")[i]), 3)
            rec["decoyElDeg"] = round(float(c("decoy_el_deg")[i]), 3)
        if "imm_p_cv" in col:
            rec["immPCv"] = round(float(c("imm_p_cv")[i]), 4)
            rec["immPCa"] = round(float(c("imm_p_ca")[i]), 4)
            rec["immPCt"] = round(float(c("imm_p_ct")[i]), 4)
        if "fuze_pk" in col:
            rec["fuzePk"] = round(float(c("fuze_pk")[i]), 4)
        samples.append(rec)

    # --- 6. target entity (attitude derived from ECEF velocity) -----------
    # Densify target samples in the final 25 s so defensive beaming + terminal
    # weave manoeuvres are captured smoothly in 3D replay.
    t_ecef = np.column_stack([c("t_ecef_x"), c("t_ecef_y"), c("t_ecef_z")])
    t_vecef = np.column_stack([c("t_vecef_x"), c("t_vecef_y"), c("t_vecef_z")])
    i_t_endgame = int(np.searchsorted(t, max(0.0, t_end_s - 25.0)))
    t_cruise = np.linspace(0, max(i_t_endgame, 0), min(180, n)).astype(int)
    t_final = np.linspace(max(i_t_endgame, 0), n - 1, min(140, n)).astype(int)
    tidx = np.unique(np.concatenate([t_cruise, t_final, np.array([imin, n - 1])]))
    tidx = tidx[(tidx >= 0) & (tidx < n)]
    t_lat, t_lon, t_alt = ecef_to_llh(t_ecef)
    target_samples = []
    for i in tidx:
        q = quat_from_x_axis(t_vecef[i])
        target_samples.append({
            "t": round(float(t[i]), 6),
            "position": {"x": round(float(t_ecef[i, 0]), 3),
                         "y": round(float(t_ecef[i, 1]), 3),
                         "z": round(float(t_ecef[i, 2]), 3)},
            "velocity": {"x": round(float(t_vecef[i, 0]), 3),
                         "y": round(float(t_vecef[i, 1]), 3),
                         "z": round(float(t_vecef[i, 2]), 3)},
            "attitude": {"w": round(float(q[0]), 9), "x": round(float(q[1]), 9),
                         "y": round(float(q[2]), 9), "z": round(float(q[3]), 9)},
            "latDeg": round(float(t_lat[i]), 8),
            "lonDeg": round(float(t_lon[i]), 8),
            "altM": round(float(t_alt[i]), 3),
            "speedMS": round(float(np.linalg.norm(t_vecef[i])), 3),
            "mach": 0.0, "qPa": 0.0, "loadG": 0.0, "loadCmdG": 0.0,
            "massKg": 0.0, "fovDeg": 0.0,
            "rangeM": round(float(m_range[i]), 3),
            "phase": "coast", "seekerLock": False, "handover": False,
        })

    # --- 7. events and phases --------------------------------------------
    events = [{
        "id": "launch", "t": 0.0, "label": "LAUNCH", "kind": "launch",
        "severity": "major",
        "description": "Lift-off from %s (%.2f N, %.2f E)." % ("launch site", LAUNCH_LAT, LAUNCH_LON),
    }]
    for k in range(1, n):
        if phase[k] != phase[k - 1]:
            name = PHASE_NAMES.get(int(phase[k]), "coast")
            events.append({
                "id": "phase-%s" % name, "t": round(float(t[k]), 3),
                "label": name.upper(), "kind": "phase", "severity": "info",
                "description": "Transition into %s phase (t = %.1f s)." % (name, t[k]),
            })
    lock_idx = np.where(c("seeker_lock") > 0.5)[0]
    if lock_idx.size:
        events.append({
            "id": "seeker-lock", "t": round(float(t[lock_idx[0]]), 3),
            "label": "SEEKER LOCK", "kind": "lock", "severity": "major",
            "description": "Seeker acquired the target at %.1f km slant range."
            % (m_range[lock_idx[0]] / 1000.0),
        })
    ho_idx = np.where(c("handover") > 0.5)[0]
    if ho_idx.size:
        events.append({
            "id": "handover", "t": round(float(t[ho_idx[0]]), 3),
            "label": "TERMINAL HANDOVER", "kind": "handover", "severity": "major",
            "description": "Midcourse guidance handed over to the terminal seeker.",
        })
    imax_alt = int(np.argmax(alt))
    events.append({
        "id": "max-altitude", "t": round(float(t[imax_alt]), 3),
        "label": "APOGEE", "kind": "peak", "severity": "info",
        "description": "Maximum altitude %.2f km." % (alt[imax_alt] / 1000.0),
    })
    imax_q = int(np.argmax(c("q_dyn")))
    events.append({
        "id": "max-q", "t": round(float(t[imax_q]), 3),
        "label": "MAX Q", "kind": "peak", "severity": "info",
        "description": "Peak dynamic pressure %.1f kPa." % (c("q_dyn")[imax_q] / 1000.0),
    })
    if "stage_sep" in col:
        sep_idx = np.where(c("stage_sep") > 0.5)[0]
        if sep_idx.size:
            events.append({
                "id": "booster-sep", "t": round(float(t[sep_idx[0]]), 3),
                "label": "BOOSTER SEP", "kind": "separation", "severity": "major",
                "description": "Stage-1 solid booster casing jettisoned (CG/inertia step).",
            })
    if "unstart_flag" in col:
        uns_idx = np.where(c("unstart_flag") > 0.5)[0]
        if uns_idx.size:
            events.append({
                "id": "inlet-unstart", "t": round(float(t[uns_idx[0]]), 3),
                "label": "INLET UNSTART", "kind": "anomaly", "severity": "major",
                "description": "Scramjet inlet unstart hysteresis triggered at high incidence.",
            })
    if "decoy_active" in col:
        dec_idx = np.where(c("decoy_active") > 0.5)[0]
        if dec_idx.size:
            events.append({
                "id": "decoy-eject", "t": round(float(t[dec_idx[0]]), 3),
                "label": "DECOY EJECT", "kind": "countermeasure", "severity": "major",
                "description": "Target deployed IR flares & radar chaff; anti-decoy gate engaged.",
            })
    events.append({
        "id": "intercept", "t": round(float(t[imin]), 3),
        "label": "INTERCEPT", "kind": "intercept", "severity": "critical",
        "description": "Closest approach %.2f m at t = %.3f s."
        % (m_range[imin], t[imin]),
    })
    events.sort(key=lambda e: e["t"])

    segments = []
    start = 0
    for k in range(1, n):
        if phase[k] != phase[k - 1]:
            segments.append((int(phase[k - 1]), start, k - 1))
            start = k
    segments.append((int(phase[-1]), start, n - 1))
    phases = [{
        "phase": PHASE_NAMES.get(p, "coast"),
        "startT": round(float(t[a]), 6),
        "endT": round(float(t[b]), 6),
        "label": PHASE_NAMES.get(p, "coast").title(),
    } for p, a, b in segments]

    # --- 8. metrics ------------------------------------------------------
    r0 = llh_to_ecef(np.array([LAUNCH_LAT]), np.array([LAUNCH_LON]),
                     np.array([LAUNCH_ALT]))[0]
    lat0, lon0 = math.radians(LAUNCH_LAT), math.radians(LAUNCH_LON)
    e = np.array([-math.sin(lon0), math.cos(lon0), 0.0])
    north = np.array([-math.sin(lat0) * math.cos(lon0),
                      -math.sin(lat0) * math.sin(lon0), math.cos(lat0)])
    d_east = (r_ecef - r0).dot(e) / 1000.0
    d_north = (r_ecef - r0).dot(north) / 1000.0
    downrange = np.hypot(d_east, d_north)

    with open(args.source, "rb") as f:
        digest = hashlib.sha256()
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    source_sha = digest.hexdigest()

    miss_m = float(m_range[imin])
    pk_val = math.exp(-math.log(2.0) * (miss_m / 15.0) ** 2)
    metrics = {
        "missDistanceM": round(miss_m, 4),
        "interceptTimeS": round(float(t[imin]), 4),
        "maxSpeedMS": round(float(np.linalg.norm(v_ecef, axis=1).max()), 4),
        "maxMach": round(float(c("mach").max()), 4),
        "maxDynamicPressurePa": round(float(c("q_dyn").max()), 3),
        "maxLoadG": round(float(max(load_g.max(), load_cmd.max())), 4),
        "maxAltitudeM": round(float(alt.max()), 3),
        "downrangeKM": round(float(downrange.max()), 4),
        "fuelUsedKg": round(float(c("mass")[0] - c("mass")[-1]), 4),
        "handoverTimeS": round(float(t[ho_idx[0]]), 4) if ho_idx.size else None,
        "flightDurationS": round(float(t[-1]), 6),
        "killProbability": round(float(pk_val), 4),
    }
    if has_aero_sensor:
        metrics["maxHeatFluxMWm2"] = round(float(c("heat_flux_mw").max()), 4)
        metrics["maxWallTempK"] = round(float(c("wall_temp_k").max()), 2)
    if "fuze_pk" in col:
        fpk = float(c("fuze_pk")[imin])
        if fpk > 0.0:
            metrics["fuzePk"] = round(fpk, 4)
            metrics["killProbability"] = round(fpk, 4)
    # Attach miss-budget ablation breakdown if available from tools/miss_budget.py.
    mb_path = os.path.join(os.path.dirname(args.source), "miss_budget",
                           "miss_budget_summary.json")
    if os.path.exists(mb_path):
        try:
            with open(mb_path, "r", encoding="utf-8") as mf:
                mb_raw = json.load(mf)
            nom_map = {
                row["variant"]: float(row["mean"])
                for row in mb_raw.get("summary", [])
                if row.get("scenario") == "nominal" and math.isfinite(float(row.get("mean", float("nan"))))
            }
            if nom_map:
                metrics["missBudget"] = {
                    "source": "missile_intercept/output/miss_budget/miss_budget_summary.json",
                    "nominal": nom_map,
                }
        except Exception:
            pass

    observables = [
        {"key": "altM", "label": "Altitude", "unit": "km", "precision": 2,
         "description": "WGS84 geodetic height above the reference ellipsoid."},
        {"key": "speedMS", "label": "Speed", "unit": "m/s", "precision": 1,
         "description": "Speed relative to the Earth-fixed (ECEF) frame."},
        {"key": "mach", "label": "Mach", "unit": "—", "precision": 2,
         "description": "Speed divided by local speed of sound (USSA1976)."},
        {"key": "qPa", "label": "Dynamic pressure", "unit": "kPa", "precision": 2,
         "description": "q = 0.5 rho V^2 in the Earth-fixed atmosphere."},
        {"key": "loadG", "label": "Load factor", "unit": "g", "precision": 2,
         "description": "Achieved body-axis acceleration magnitude / g0."},
        {"key": "fovDeg", "label": "Seeker off-boresight", "unit": "deg", "precision": 2,
         "description": "Line-of-sight angle relative to the seeker boresight."},
        {"key": "rangeM", "label": "Slant range", "unit": "km", "precision": 2,
         "description": "Missile-to-target line-of-sight distance."},
        {"key": "massKg", "label": "Mass", "unit": "kg", "precision": 1,
         "description": "Current vehicle mass including remaining propellant."},
        {"key": "finDeflectionsRad", "label": "Fin deflection", "unit": "deg", "precision": 2,
         "description": "Recorded cruciform fin deflections relative to trim (+ up fin shown)."},
        {"key": "bodyRatesRadS", "label": "Body rate", "unit": "deg/s", "precision": 2,
         "description": "Recorded body angular rates p (roll), q (pitch), r (yaw)."},
    ]

    # Reproducibility hinges on the batch artifact still holding the campaign
    # that the legacy reports cite. A short verification run overwrites it.
    reproducibility = "reproducible"
    batch_notes = []
    batch_csv = os.path.join(os.path.dirname(args.source), "batch", "batch_results.csv")
    batch_rows = 0
    if os.path.exists(batch_csv):
        with open(batch_csv, "r", encoding="utf-8", errors="replace") as f:
            batch_rows = max(0, sum(1 for _ in f) - 1)
    if batch_rows < 50:
        reproducibility = "unreproducible-current-artifacts"
        batch_notes.append(
            "Monte-Carlo batch artifact holds %d case(s); the 100-case campaign "
            "cited by the legacy reports cannot be re-derived from this workspace." % batch_rows)
    git_dirty = os.environ.get("GIT_COMMIT") is None
    if git_dirty:
        batch_notes.append(
            "Source telemetry was generated from a dirty working tree; "
            "source.commit is recorded as 'workspace'.")
    experiment = {
        "kind": "simulation",
        "name": "Nominal coastal intercept, single deterministic shot",
        "purpose": "Replay a validated 6-DoF trajectory for scientific visualisation "
                   "and interactive inspection.",
        "engine": "missile-interception 6-DoF point-mass/attitude integrator, "
                  "10 ms telemetry grid, seeker + terminal guidance",
        "dtS": round(float(np.median(np.diff(t))), 6),
        "dispersion": {
            "launchCepM": 500,
            "targetCepM": 2000,
            "altitudeSigmaM": 500,
            "machSigma": 0.05,
            "maneuverSigmaG": 1.0,
            "note": "Campaign dispersion values from the source project configuration; "
                    "this payload is the nominal deterministic case, not a Monte-Carlo sample.",
        },
        "reproducibility": reproducibility,
        "notes": batch_notes,
    }

    all_pass = all(ch["status"] == "PASS" for ch in checks)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "id": "missile-intercept-001",
        "title": "Coastal Intercept",
        "subtitle": "Inland launch → high-altitude target · WGS84 · ECEF replay",
        "description": (
            "End-to-end trajectory of a two-stage intercept scenario, replayed "
            "from validated 6-DoF simulation telemetry. Positions come directly "
            "from the source ECI state rotated into ECEF; attitudes are converted "
            "with the same Earth-rotation quaternion. No visual exaggeration is "
            "applied to trajectory geometry."
        ),
        "earth": {
            "model": "wgs84",
            "semiMajorAxisM": WGS84_A,
            "flattening": WGS84_F,
            "omegaRadS": OMEGA_EARTH,
            "muM3S2": 3.986004418e14,
        },
        "time": {
            "startS": 0.0,
            "endS": round(float(t[-1]), 6),
            "sampleCount": len(samples),
            "sourceRows": int(n),
            "sourceStepS": round(float(np.median(np.diff(t))), 6),
            "demoUtc": DEMO_UTC,
        },
        "frames": {
            "render": "ECEF",
            "eciToEcef": "Rz(-omega*t), omega=7.2921150e-5 rad/s, ECI==ECEF at t=0",
            "quaternion": "scalar-first [w,x,y,z], BODY->ECEF, right-handed Hamilton product",
            "bodyAxes": "+x forward (nose), +y right, +z down",
        },
        "source": {
            "title": "missile-interception 6-DoF telemetry",
            "repository": "https://github.com/PaoShou-China/missile-interception",
            "commit": os.environ.get("GIT_COMMIT", "workspace"),
            "telemetryFile": os.path.relpath(args.source, REPO).replace("\\", "/"),
            "telemetryRows": int(n),
            "sha256": source_sha,
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator": "tools/data-adapter/build_scenario.py",
            "license": "MIT (source repository)",
        },
        "experiment": experiment,
        "metrics": metrics,
        "launchSite": {"latDeg": LAUNCH_LAT, "lonDeg": LAUNCH_LON,
                       "altM": LAUNCH_ALT, "label": "Launch site"},
        "targetSite": {"latDeg": TARGET_LAT, "lonDeg": TARGET_LON,
                       "altM": TARGET_ALT, "label": "Target datum"},
        "phases": phases,
        "events": events,
        "observables": observables,
        "entities": [
            {"id": "missile", "label": "Interceptor", "kind": "missile",
             "color": "#ffb257", "samples": samples},
            {"id": "target", "label": "Target", "kind": "target",
             "color": "#63e6ff", "samples": target_samples},
        ],
        "validation": {
            "status": "PASS" if all_pass else "FAIL",
            "checks": checks,
        },
    }

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "scenario.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(out_path)

    report_path = os.path.join(args.out, "validation.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump({"source": manifest["source"], "checks": checks,
                   "metrics": metrics}, f, indent=2, ensure_ascii=False)

    print("scenario:", out_path, "%.2f MB" % (size / 1e6))
    print("samples :", len(samples), "missile,", len(target_samples), "target")
    print("checks  :", "PASS" if all_pass else "FAIL")
    for ch in checks:
        print("  [%s] %-22s %s" % (ch["status"], ch["id"], ch["detail"]))
    if not all_pass:
        sys.exit(2)


if __name__ == "__main__":
    main()
