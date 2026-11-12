"""Tune the pitch outer-loop gain, rate-loop gain and command pre-filter.

The terminal diagnostic showed the guidance command sitting almost entirely
in the body -Z (pitch) channel while alpha stayed at 4-5 deg and the pitch
rate at 0.03-0.15 rad/s.  The fins were far from their limits, so the pitch
loop, not the fin authority, was the bottleneck.

This tool sweeps:

  * Autopilot.KP_ANGLE   (outer alpha loop)
  * Autopilot.KP_RATE    (pitch rate loop; model schedule uses it as the
                          low-q gain floor)
  * AP_PREFILTER_HZ      (second-order command filter bandwidth)

over the baseline scenarios and ranks the configurations by pass rate, then
worst-case miss, then mean miss.  Fin-saturation and peak-alpha are reported
so a faster loop that simply saturates the fins is not selected blindly.

Usage
-----
    python tools/tune_autopilot.py --seeds 4 --workers 8
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
from control.autopilot import Autopilot  # noqa: E402


def _run_one(payload):
    label, case_id, scenario, cfg_values = payload
    Autopilot.KP_ANGLE = cfg_values["kp_angle"]
    Autopilot.KP_RATE = cfg_values["kp_rate"]
    C.AP_PREFILTER_HZ = cfg_values["prefilter"]
    cfg = replace(
        C.SimConfig(),
        verbose=False,
        enable_plot=False,
        telemetry_profile="basic",
        max_steps=max(int(round(C.SimConfig().t_end / C.DT_LOG)) + 1000, 1000),
    )
    return label, batch.run_case((case_id, cfg, scenario))


def _aggregate(results, threshold):
    miss = np.array([r["miss_distance"] for r in results], dtype=float)
    miss = miss[np.isfinite(miss)]
    ok = miss <= threshold
    return {
        "n": int(miss.size),
        "pass": int(np.sum(ok)),
        "pass_rate": float(np.mean(ok)) if miss.size else 0.0,
        "mean": float(np.mean(miss)) if miss.size else float("nan"),
        "median": float(np.median(miss)) if miss.size else float("nan"),
        "max": float(np.max(miss)) if miss.size else float("nan"),
        "peak_act": float(np.nanmedian(
            [r.get("terminal_peak_act_g", float("nan")) for r in results])),
        "peak_alpha": float(np.nanmedian(
            [r.get("terminal_peak_alpha_deg", float("nan")) for r in results])),
        "fin_sat": float(np.nanmedian(
            [r.get("terminal_fin_sat_pct", float("nan")) for r in results])),
        "lock_loss": float(np.nanmedian(
            [r.get("terminal_lock_loss_pct", float("nan")) for r in results])),
    }


def main():
    ap = argparse.ArgumentParser(description="Tune pitch autopilot gains")
    ap.add_argument("--seeds", type=int, default=4)
    ap.add_argument("--base-seed", type=int, default=2026)
    ap.add_argument("--suite", default="baseline")
    ap.add_argument("--workers", type=int, default=min(os.cpu_count() or 1, 8))
    ap.add_argument("--threshold", type=float, default=15.0)
    ap.add_argument("--out", default=os.path.join("output", "autopilot_tuning"))
    args = ap.parse_args()

    keys = {s.strip() for s in args.suite.split(",") if s.strip()}
    suites = [s for s in V.build_suites() if s.key in keys]
    if not suites:
        raise SystemExit("no suites matched: %s" % args.suite)
    base_cfg = replace(C.SimConfig(), verbose=False, enable_plot=False,
                       telemetry_profile="basic")
    payloads, _ = V._make_payloads(suites, args.seeds, args.base_seed, base_cfg)
    scenarios = [(p[0], p[2]) for p in payloads]
    os.makedirs(args.out, exist_ok=True)

    configs = []
    for kp_angle in (6.0,):
        for kp_rate in (0.14, 0.16, 0.18):
            for prefilter in (10.0, 15.0, 20.0):
                label = "kpA=%.1f kpR=%.2f f=%.0f" % (kp_angle, kp_rate, prefilter)
                configs.append((label, {
                    "kp_angle": kp_angle, "kp_rate": kp_rate,
                    "prefilter": prefilter,
                }))

    jobs = []
    for label, cfg_values in configs:
        for case_id, scenario in scenarios:
            jobs.append((label, case_id, scenario, cfg_values))
    print("Autopilot tuning: %d configs x %d scenarios = %d cases"
          % (len(configs), len(scenarios), len(jobs)))

    results = {label: [] for label, _ in configs}
    done = 0
    with ProcessPoolExecutor(max_workers=max(1, min(args.workers, len(jobs)))) as pool:
        futures = {pool.submit(_run_one, p): p[0] for p in jobs}
        for fut in as_completed(futures):
            label = futures[fut]
            _, r = fut.result()
            results[label].append(r)
            done += 1
            print("  [%2d/%2d] %-26s miss %8.2f m"
                  % (done, len(jobs), label, r["miss_distance"]), flush=True)

    rows = []
    for label, rs in results.items():
        a = _aggregate(rs, args.threshold)
        a["config"] = label
        rows.append(a)
    rows.sort(key=lambda x: (-x["pass_rate"], x["max"], x["mean"]))

    print("\nRanking (pass rate, worst case, mean):")
    for r in rows:
        print("  %-26s pass %d/%d  mean %7.2f  median %7.2f  max %7.2f  "
              "alpha %5.1f  act %5.1f g  finSat %5.1f%%  loss %4.1f%%"
              % (r["config"], r["pass"], r["n"], r["mean"], r["median"],
                 r["max"], r["peak_alpha"], r["peak_act"], r["fin_sat"],
                 r["lock_loss"]))

    best = rows[0]
    print("\nBEST: " + best["config"])

    csv_path = os.path.join(args.out, "autopilot_tuning.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    json_path = os.path.join(args.out, "autopilot_tuning_summary.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"best": best, "ranking": rows, "threshold": args.threshold},
                  f, ensure_ascii=False, indent=2)
    print("CSV:  " + csv_path)
    print("JSON: " + json_path)


if __name__ == "__main__":
    main()
