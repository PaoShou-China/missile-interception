"""Per-case handover diagnostics.

Runs the validation suites (or a selected subset) and reports, for every case:

  * first seeker-lock range/time and FOV at first lock,
  * handover range/time, whether it was forced,
  * FOV angle and remaining FOV margin at handover,
  * time-to-go, lead angle, available and required load factor,
  * failed handover gates,
  * miss distance and a coarse verdict.

The output is a CSV plus a console summary.  It is meant to answer one
question before touching any guidance model: is the endgame limited by the
seeker lock range, by the handover geometry, or by the terminal law itself?

Usage
-----
    python tools/handover_diagnostics.py --seeds 4 --suite baseline
    python tools/handover_diagnostics.py --seeds 4 --suite baseline,altitude \
        --workers 8 --out output/handover_diagnostics
"""

import argparse
import csv
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import replace

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import batch  # noqa: E402
import config as C  # noqa: E402
import validate_performance as V  # noqa: E402


FIELDS = [
    "case_id", "suite", "condition", "nav_seed", "seeker_seed",
    "miss_m", "miss_t", "final_phase",
    "first_lock_time", "first_lock_km", "first_lock_fov_deg",
    "ho_time", "ho_km", "forced",
    "ho_fov_deg", "fov_margin_deg",
    "ho_tgo", "ho_lead_deg", "ho_n_avail_g", "ho_n_req_g",
    "gates_failed",
    "terminal_peak_cmd_g", "terminal_peak_act_g", "terminal_fov_max_deg",
    "terminal_lock_loss_pct", "terminal_min_range_km",
    "terminal_peak_alpha_deg", "terminal_peak_beta_deg",
    "verdict",
]


def _finite(x):
    return isinstance(x, (int, float)) and math.isfinite(float(x))


def _verdict(r, threshold):
    lock = r.get("first_lock_range", float("nan"))
    ho = r.get("handover_range", float("nan"))
    tgo = r.get("handover_tgo", float("nan"))
    lead = r.get("handover_lead_deg", float("nan"))
    n_av = r.get("handover_n_avail_g", float("nan"))
    fov_m = r.get("handover_fov_margin_deg", float("nan"))
    gates = str(r.get("handover_gates", "") or "")
    forced = bool(r.get("handover_forced", False))

    if not _finite(lock):
        return "no lock"
    if not _finite(ho):
        return "no handover" + (" [" + gates + "]" if gates else "")
    if forced:
        return "forced" + (" [" + gates + "]" if gates else "")
    if _finite(fov_m) and fov_m < 5.0:
        return "FOV margin < 5 deg"
    if _finite(tgo) and tgo < C.HANDOVER_TGO_MIN:
        return "t_go insufficient"
    if _finite(lead) and lead > math.degrees(C.HANDOVER_ANGLE_MAX):
        return "lead angle excessive"
    if _finite(n_av) and n_av < C.HANDOVER_N_AVAIL_MIN:
        return "n_avail insufficient"
    if _finite(r.get("miss_distance", float("nan"))) and \
            r["miss_distance"] > threshold:
        return "handover OK, terminal miss"
    return "pass"


def _row(r, suite, condition, nav_seed, seeker_seed, threshold):
    lock_m = r.get("first_lock_range", float("nan"))
    ho_m = r.get("handover_range", float("nan"))
    return {
        "case_id": r.get("case_id"),
        "suite": suite,
        "condition": condition,
        "nav_seed": nav_seed,
        "seeker_seed": seeker_seed,
        "miss_m": r.get("miss_distance", float("nan")),
        "miss_t": r.get("miss_time", float("nan")),
        "final_phase": r.get("final_phase", ""),
        "first_lock_time": r.get("first_lock_time", float("nan")),
        "first_lock_km": lock_m / 1000.0 if _finite(lock_m) else float("nan"),
        "first_lock_fov_deg": r.get("first_lock_fov_deg", float("nan")),
        "ho_time": r.get("handover_time", float("nan")),
        "ho_km": ho_m / 1000.0 if _finite(ho_m) else float("nan"),
        "forced": bool(r.get("handover_forced", False)),
        "ho_fov_deg": r.get("handover_fov_deg", float("nan")),
        "fov_margin_deg": r.get("handover_fov_margin_deg", float("nan")),
        "ho_tgo": r.get("handover_tgo", float("nan")),
        "ho_lead_deg": r.get("handover_lead_deg", float("nan")),
        "ho_n_avail_g": r.get("handover_n_avail_g", float("nan")),
        "ho_n_req_g": r.get("handover_n_req_g", float("nan")),
        "gates_failed": r.get("handover_gates", ""),
        "terminal_peak_cmd_g": r.get("terminal_peak_cmd_g", float("nan")),
        "terminal_peak_act_g": r.get("terminal_peak_act_g", float("nan")),
        "terminal_fov_max_deg": r.get("terminal_fov_max_deg", float("nan")),
        "terminal_lock_loss_pct": r.get("terminal_lock_loss_pct", float("nan")),
        "terminal_min_range_km": r.get("terminal_min_range_km", float("nan")),
        "terminal_peak_alpha_deg": r.get("terminal_peak_alpha_deg", float("nan")),
        "terminal_peak_beta_deg": r.get("terminal_peak_beta_deg", float("nan")),
        "verdict": _verdict(r, threshold),
    }


def _summary(rows, threshold):
    def median(key, pred):
        vals = [float(r[key]) for r in rows
                if pred(r) and _finite(r[key])]
        return float(np.median(vals)) if vals else float("nan")

    failed = [r for r in rows if r["verdict"] != "pass"]
    no_lock = [r for r in failed if "no lock" in r["verdict"]]
    forced = [r for r in failed if r["forced"]]
    gate_fail = [r for r in failed if r["gates_failed"]]
    terminal = [r for r in failed
                if "terminal miss" in r["verdict"]]

    def gates_of(r):
        return set(str(r.get("gates_failed", "") or "").split(","))

    lock_gate_names = {"range", "fov", "seeker_lock"}
    lock_limited = list(no_lock)
    for r in failed:
        g = gates_of(r)
        tgo_bad = _finite(r["ho_tgo"]) and r["ho_tgo"] < C.HANDOVER_TGO_MIN
        fov_bad = _finite(r["fov_margin_deg"]) and r["fov_margin_deg"] < 5.0
        if tgo_bad or fov_bad or (r["forced"] and (g & lock_gate_names)):
            lock_limited.append(r)
    geometry_limited = [r for r in failed
                        if r["forced"] and (gates_of(r) &
                                            {"altitude_diff", "lead_angle", "speed"})]

    counts = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    print("\n" + "=" * 78)
    print("Handover diagnostics summary")
    print("=" * 78)
    print("cases: %d, pass: %d, fail: %d, threshold %.1f m"
          % (len(rows), len(rows) - len(failed), len(failed), threshold))
    for k in sorted(counts):
        print("  %-42s %d" % (k, counts[k]))
    print("\nfailed-case medians:")
    print("  first lock range       %8.2f km" % median("first_lock_km", lambda r: True))
    print("  handover range         %8.2f km" % median("ho_km", lambda r: True))
    print("  handover t_go          %8.2f s" % median("ho_tgo", lambda r: True))
    print("  handover FOV margin    %8.2f deg" % median("fov_margin_deg", lambda r: True))
    print("  handover lead angle    %8.2f deg" % median("ho_lead_deg", lambda r: True))
    print("  handover n_avail       %8.2f g" % median("ho_n_avail_g", lambda r: True))
    print("  handover n_req         %8.2f g" % median("ho_n_req_g", lambda r: True))
    print("  terminal peak command  %8.2f g" % median("terminal_peak_cmd_g", lambda r: True))
    print("  terminal peak actual   %8.2f g" % median("terminal_peak_act_g", lambda r: True))
    print("  terminal lock loss     %8.2f %%" % median("terminal_lock_loss_pct", lambda r: True))
    print("  terminal peak alpha    %8.2f deg" % median("terminal_peak_alpha_deg", lambda r: True))
    print("  terminal peak beta     %8.2f deg" % median("terminal_peak_beta_deg", lambda r: True))
    print("\nclassification counts:")
    print("  no lock                %d" % len(no_lock))
    print("  lock/tgo/fov limited   %d" % len(lock_limited))
    print("  forced handover        %d" % len(forced))
    print("  geometry/lead gate     %d" % len(geometry_limited))
    print("  any failed gate        %d" % len(gate_fail))
    print("  handover OK, miss high %d" % len(terminal))

    if len(lock_limited) > len(geometry_limited) + len(terminal):
        rec = ("Lock model or earlier handover first: lock/t_go/FOV is the binding "
               "constraint. Check TARGET_RCS, SEEKER_LOCK_RANGE_REF, "
               "SEEKER_IR_LOCK_RANGE and HANDOVER_TGO_MIN.")
    elif geometry_limited and len(geometry_limited) >= len(terminal):
        rec = ("Handover geometry or midcourse sink first: the lock is not late, "
               "but the altitude/lead/speed gates force handover. Check HANDOVER_* "
               "and the midcourse terminal sink.")
    elif terminal:
        rec = ("Handover entry is nominal; the problem is in terminal guidance or "
               "attitude tracking: check terminal_peak_cmd vs terminal_peak_act, "
               "lock loss and roll alignment.")
    else:
        rec = "All cases pass."
    print("\nRecommendation: " + rec)
    return {
        "cases": len(rows),
        "pass": len(rows) - len(failed),
        "fail": len(failed),
        "verdict_counts": counts,
        "no_lock": len(no_lock),
        "lock_limited": len(lock_limited),
        "geometry_limited": len(geometry_limited),
        "forced": len(forced),
        "gate_fail": len(gate_fail),
        "terminal_miss": len(terminal),
        "recommendation": rec,
    }


def main():
    ap = argparse.ArgumentParser(description="Handover diagnostics")
    ap.add_argument("--seeds", type=int, default=4)
    ap.add_argument("--base-seed", type=int, default=2026)
    ap.add_argument("--suite", default="baseline",
                    help="comma-separated suite keys: baseline,altitude,...")
    ap.add_argument("--workers", type=int, default=min(os.cpu_count() or 1, 8))
    ap.add_argument("--threshold", type=float, default=15.0)
    ap.add_argument("--duration", type=float, default=None)
    ap.add_argument("--out", default=os.path.join("output", "handover_diagnostics"))
    args = ap.parse_args()

    keys = {s.strip() for s in args.suite.split(",") if s.strip()}
    suites = [s for s in V.build_suites() if s.key in keys]
    if not suites:
        raise SystemExit("no suites matched: %s" % args.suite)

    cfg = C.SimConfig()
    if args.duration is not None:
        cfg = replace(cfg, t_end=float(args.duration))
    case_cfg = replace(
        cfg, verbose=False, enable_plot=False, telemetry_profile="basic",
        max_steps=max(int(round(cfg.t_end / max(cfg.dt_log, 1e-6))) + 1000, 1000))
    payloads, meta = V._make_payloads(suites, args.seeds, args.base_seed, case_cfg)
    workers = max(1, min(args.workers, len(payloads)))
    os.makedirs(args.out, exist_ok=True)

    print("Handover diagnostics: %d suites, %d cases, %d workers"
          % (len(suites), len(payloads), workers))
    t0 = time.time()
    rows = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(batch.run_case, p): p for p in payloads}
        for k, fut in enumerate(as_completed(futures), 1):
            payload = futures[fut]
            case_id, _, scenario = payload
            suite, name, cond = meta[case_id]
            r = fut.result()
            row = _row(r, suite + " / " + name, cond,
                       scenario.nav_seed, scenario.seeker_seed, args.threshold)
            rows.append(row)
            print("  [%2d/%2d] %-28s lock %6.2f km  HO %6.2f km  tgo %5.2f s  "
                  "fovM %5.1f deg  lead %5.1f deg  nAv %5.1f g  "
                  "cmd/act %5.1f/%5.1f g  loss %4.1f%%  miss %8.1f m  %s"
                  % (k, len(payloads), row["condition"],
                     row["first_lock_km"], row["ho_km"], row["ho_tgo"],
                     row["fov_margin_deg"], row["ho_lead_deg"],
                     row["ho_n_avail_g"], row["terminal_peak_cmd_g"],
                     row["terminal_peak_act_g"], row["terminal_lock_loss_pct"],
                     row["miss_m"], row["verdict"]),
                  flush=True)

    rows.sort(key=lambda x: x["case_id"])
    csv_path = os.path.join(args.out, "handover_diagnostics.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    summary = _summary(rows, args.threshold)
    summary["wall_time_s"] = time.time() - t0
    summary["csv"] = csv_path
    summary_path = os.path.join(args.out, "handover_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("\nCSV:  " + csv_path)
    print("JSON: " + summary_path)


if __name__ == "__main__":
    main()
