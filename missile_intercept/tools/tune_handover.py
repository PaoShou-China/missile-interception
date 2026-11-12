"""Sweep the handover conditions and rank the configurations.

The handover gates decide when the 23-25 km seeker lock is converted into a
terminal command.  With the current F-35A scenario the gates all pass at first
lock, so the two effective knobs are:

  * HANDOVER_BLEND_TIME - how long midcourse retains authority after trigger;
  * HANDOVER_DWELL      - how long the gates must hold before trigger.

This tool runs the baseline scenarios for a grid of those two parameters,
reports miss statistics and handover metrics, and writes a ranking.  It is
deliberately a tuning aid: the selected values must still be checked with the
full validation suite.

Usage
-----
    python tools/tune_handover.py --seeds 4 --workers 8
    python tools/tune_handover.py --suite baseline --threshold 15
"""

import argparse
import csv
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import replace

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import batch  # noqa: E402
import config as C  # noqa: E402
import validate_performance as V  # noqa: E402


def _run_one(payload):
    """Worker: apply overrides, run one case, return the batch result."""
    case_id, scenario, overrides = payload
    for key, value in overrides.items():
        setattr(C, key, value)
    cfg = replace(
        C.SimConfig(),
        verbose=False,
        enable_plot=False,
        telemetry_profile="basic",
        max_steps=max(int(round(C.SimConfig().t_end / C.DT_LOG)) + 1000, 1000),
    )
    return case_id, batch.run_case((case_id, cfg, scenario))


def _aggregate(results, threshold):
    miss = np.array([r["miss_distance"] for r in results], dtype=float)
    good = np.isfinite(miss)
    miss = miss[good]
    if miss.size == 0:
        return {"n": 0, "pass": 0, "pass_rate": 0.0, "mean": float("nan"),
                "median": float("nan"), "max": float("nan")}
    return {
        "n": int(miss.size),
        "pass": int(np.sum(miss <= threshold)),
        "pass_rate": float(np.mean(miss <= threshold)),
        "mean": float(np.mean(miss)),
        "median": float(np.median(miss)),
        "max": float(np.max(miss)),
    }


def _fmt_config(blend, dwell):
    return {"HANDOVER_BLEND_TIME": float(blend),
            "HANDOVER_DWELL": float(dwell)}


def main():
    ap = argparse.ArgumentParser(description="Tune handover conditions")
    ap.add_argument("--seeds", type=int, default=4)
    ap.add_argument("--base-seed", type=int, default=2026)
    ap.add_argument("--suite", default="baseline")
    ap.add_argument("--workers", type=int, default=min(os.cpu_count() or 1, 8))
    ap.add_argument("--threshold", type=float, default=15.0)
    ap.add_argument("--out", default=os.path.join("output", "handover_tuning"))
    args = ap.parse_args()

    keys = {s.strip() for s in args.suite.split(",") if s.strip()}
    suites = [s for s in V.build_suites() if s.key in keys]
    if not suites:
        raise SystemExit("no suites matched: %s" % args.suite)

    base_cfg = replace(C.SimConfig(), verbose=False, enable_plot=False,
                       telemetry_profile="basic")
    payloads, meta = V._make_payloads(suites, args.seeds, args.base_seed, base_cfg)
    scenarios = [(p[0], p[2]) for p in payloads]
    os.makedirs(args.out, exist_ok=True)
    print("Handover tuning: %d scenarios, grids blend x dwell" % len(scenarios))

    def run_grid(configs):
        jobs = []
        for label, overrides in configs:
            for case_id, scenario in scenarios:
                jobs.append((label, case_id, scenario, overrides))
        results = {label: [] for label, _ in configs}
        done = 0
        with ProcessPoolExecutor(max_workers=max(1, min(args.workers, len(jobs)))) as pool:
            futures = {pool.submit(_run_one, (cid, sc, ov)): label
                       for label, cid, sc, ov in jobs}
            for fut in as_completed(futures):
                label = futures[fut]
                _, r = fut.result()
                results[label].append(r)
                done += 1
                print("  [%2d/%2d] %-24s miss %8.1f m"
                      % (done, len(jobs), label, r["miss_distance"]), flush=True)
        return results

    blend_grid = [("blend=%.2f" % b, _fmt_config(b, C.HANDOVER_DWELL))
                  for b in (0.0, 0.10, 0.25, 0.50, 0.75, 1.00)]
    print("\nStage 1: blend time (dwell=%.2f)" % C.HANDOVER_DWELL)
    res1 = run_grid(blend_grid)

    def rank(res):
        rows = []
        for name, rs in res.items():
            a = _aggregate(rs, args.threshold)
            a["name"] = name
            rows.append(a)
        rows.sort(key=lambda x: (-x["pass_rate"], x["max"], x["mean"]))
        return rows

    rank1 = rank(res1)
    print("\nStage 1 ranking:")
    for r in rank1:
        print("  %-12s pass %d/%d  mean %7.2f  median %7.2f  max %7.2f"
              % (r["name"], r["pass"], r["n"], r["mean"], r["median"], r["max"]))
    best_blend = float(rank1[0]["name"].split("=")[1])

    dwell_grid = [("dwell=%.2f" % d, _fmt_config(best_blend, d))
                  for d in (0.0, 0.10, 0.20, 0.30, 0.50)]
    print("\nStage 2: dwell (blend=%.2f)" % best_blend)
    res2 = run_grid(dwell_grid)
    rank2 = rank(res2)
    print("\nStage 2 ranking:")
    for r in rank2:
        print("  %-12s pass %d/%d  mean %7.2f  median %7.2f  max %7.2f"
              % (r["name"], r["pass"], r["n"], r["mean"], r["median"], r["max"]))

    best_dwell = float(rank2[0]["name"].split("=")[1])
    all_rows = []
    for stage, res, grid in (("blend", res1, blend_grid), ("dwell", res2, dwell_grid)):
        config_values = {label: ov for label, ov in grid}
        for label, rs in res.items():
            for r in rs:
                all_rows.append({
                    "stage": stage, "config": label,
                    "blend": config_values[label]["HANDOVER_BLEND_TIME"],
                    "dwell": config_values[label]["HANDOVER_DWELL"],
                    "miss_m": r["miss_distance"],
                    "final_phase": r["final_phase"],
                    "handover_km": r["handover_range"] / 1000.0,
                    "handover_tgo": r["handover_tgo"],
                    "handover_fov_deg": r["handover_fov_deg"],
                    "handover_lead_deg": r["handover_lead_deg"],
                    "terminal_peak_cmd_g": r["terminal_peak_cmd_g"],
                    "terminal_peak_act_g": r["terminal_peak_act_g"],
                })
    csv_path = os.path.join(args.out, "handover_tuning.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
        w.writeheader()
        w.writerows(all_rows)

    summary = {
        "best": {"HANDOVER_BLEND_TIME": best_blend,
                 "HANDOVER_DWELL": best_dwell},
        "stage1": rank1,
        "stage2": rank2,
        "threshold": args.threshold,
        "csv": csv_path,
    }
    json_path = os.path.join(args.out, "handover_tuning_summary.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("\nBEST: HANDOVER_BLEND_TIME=%.2f  HANDOVER_DWELL=%.2f"
          % (best_blend, best_dwell))
    print("CSV:  " + csv_path)
    print("JSON: " + json_path)


if __name__ == "__main__":
    main()
