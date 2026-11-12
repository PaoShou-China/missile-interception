"""Build the Apple-style HTML report dataset from output/telemetry.csv.

Run:
    python tools/build_report_data.py
"""

import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C          # noqa: E402
import math_utils as MU     # noqa: E402

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "output", "telemetry.csv")
OUT_DIR = os.path.join(os.path.dirname(ROOT), "intercept-report", "assets")
N_SAMPLES = 900


def main():
    with open(CSV_PATH, "r") as f:
        header = f.readline().strip().split(",")
    data = np.loadtxt(CSV_PATH, delimiter=",", skiprows=1)
    col = {name: i for i, name in enumerate(header)}
    n = data.shape[0]

    def c(name):
        return data[:, col[name]]

    t = c("time")
    r = np.column_stack([c("m_rx"), c("m_ry"), c("m_rz")])
    v = np.column_stack([c("m_vx"), c("m_vy"), c("m_vz")])
    rt = np.column_stack([c("t_rx"), c("t_ry"), c("t_rz")])
    speed = np.linalg.norm(v, axis=1)
    a_cmd = np.column_stack([c("a_cmd_x"), c("a_cmd_y"), c("a_cmd_z")])
    a_act = np.column_stack([c("a_act_x"), c("a_act_y"), c("a_act_z")])
    load_cmd = np.linalg.norm(a_cmd, axis=1) / C.G0
    load_act = np.linalg.norm(a_act, axis=1) / C.G0
    rng = c("range")
    imin = int(np.argmin(rng))

    # ENU ground track (launch site)
    r0 = MU.llh_to_eci(C.LAUNCH_LAT, C.LAUNCH_LON, C.LAUNCH_ALT, 0.0)
    enu = MU.local_enu_dcm(C.LAUNCH_LAT, C.LAUNCH_LON, 0.0)
    miss_enu = (r - r0).dot(enu) / 1000.0
    tgt_enu = (rt - r0).dot(enu) / 1000.0
    downrange = np.linalg.norm(miss_enu[:, :2], axis=1)

    handover_idx = np.where(c("handover") > 0.5)[0]
    phase = c("phase")
    p2 = np.where(phase >= 2)[0]

    def phase_segments():
        segs = []
        labels = {0: "Boost", 1: "Midcourse", 2: "Terminal"}
        start = 0
        for i in range(1, n):
            if phase[i] != phase[i - 1]:
                segs.append({"name": labels.get(int(phase[i - 1]), "?"),
                             "start": float(t[start]), "end": float(t[i])})
                start = i
        segs.append({"name": labels.get(int(phase[-1]), "?"),
                     "start": float(t[start]), "end": float(t[-1])})
        return segs

    lock = c("seeker_lock")
    fov = np.degrees(c("fov_angle"))

    metrics = {
        "miss_distance_m": float(rng[imin]),
        "impact_time_s": float(t[imin]),
        "max_speed_ms": float(speed.max()),
        "max_mach": float(c("mach").max()),
        "max_q_kpa": float(c("q_dyn").max() / 1000.0),
        "max_load_g": float(max(load_cmd.max(), load_act.max())),
        "max_alt_km": float(c("alt").max() / 1000.0),
        "fuel_used_kg": float(C.MASS0 - c("mass")[-1]),
        "downrange_km": float(downrange.max()),
        "handover_time_s": float(t[handover_idx[0]]) if handover_idx.size else None,
        "handover_downrange_km": float(downrange[handover_idx[0]]) if handover_idx.size else None,
        "terminal_phase": bool(p2.size),
        "fov_exceed_ratio": float(np.mean(fov > np.degrees(C.SEEKER_FOV))),
        "samples": int(n),
        "duration_s": float(t[-1]),
        "phase_segments": phase_segments(),
        "miss_point": {"east_km": float(miss_enu[imin, 0]),
                        "north_km": float(miss_enu[imin, 1]),
                        "alt_km": float(c("alt")[imin] / 1000.0)},
        "launch": {"lat": C.LAUNCH_LAT, "lon": C.LAUNCH_LON},
        "target": {"lat": C.TARGET_LAT, "lon": C.TARGET_LON,
                   "alt_km": C.TARGET_ALT / 1000.0},
        "config": {"max_step_s": C.DEFAULT_MAX_STEP,
                   "boost_end_s": 20.0,
                   "integration": "native RK4"},
        "downsample": N_SAMPLES,
    }

    idx = np.linspace(0, n - 1, min(N_SAMPLES, n)).astype(int)

    def s(arr, nd=2):
        return [round(float(x), nd) for x in np.asarray(arr)[idx]]

    payload = {
        "meta": metrics,
        "series": {
            "time": s(t, 2),
            "alt_km": s(c("alt") / 1000.0, 2),
            "speed": s(speed, 1),
            "mach": s(c("mach"), 2),
            "q_kpa": s(c("q_dyn") / 1000.0, 1),
            "load_cmd": s(load_cmd, 2),
            "load_act": s(load_act, 2),
            "range_km": s(rng / 1000.0, 1),
            "downrange_km": s(downrange, 1),
            "fin_up": s(np.degrees(c("fin_up")), 2),
            "fin_down": s(np.degrees(c("fin_down")), 2),
            "fin_left": s(np.degrees(c("fin_left")), 2),
            "fin_right": s(np.degrees(c("fin_right")), 2),
            "nav_err": s(c("nav_err"), 2),
            "fov_deg": s(fov, 2),
            "dh_km": s(c("dh") / 1000.0, 2),
            "lead_deg": s(np.degrees(c("lead_angle")), 2),
            "lock": s(lock, 0),
            "handover": s(c("handover"), 0),
            "phase": s(phase, 0),
            "miss_east_km": s(miss_enu[:, 0], 2),
            "miss_north_km": s(miss_enu[:, 1], 2),
            "tgt_east_km": s(tgt_enu[:, 0], 2),
            "tgt_north_km": s(tgt_enu[:, 1], 2),
            "miss_alt_km": s(c("alt") / 1000.0, 2),
            "tgt_alt_km": s(np.array([MU.altitude(r) for r in rt]) / 1000.0, 2),
        },
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    out_js = os.path.join(OUT_DIR, "data.js")
    with open(out_js, "w") as f:
        f.write("window.REPORT_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    with open(os.path.join(OUT_DIR, "metrics.json"), "w") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)

    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("written:", out_js, os.path.getsize(out_js), "bytes")


if __name__ == "__main__":
    main()
