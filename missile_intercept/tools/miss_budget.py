"""Miss-distance error-budget diagnostics for the terminal guidance loop.

Runs a scenario x ablation matrix and reports how much each modelled error
source (navigation transport delay, sensor noise, target manoeuvre) shifts the
miss distance.  Each cell is a full independent simulation executed in a
worker process, so the matrix is reproducible and shares no mutable state.

Usage:
    python tools/miss_budget.py
    python tools/miss_budget.py --quick
    python tools/miss_budget.py --workers 4

Outputs (project-root based, created automatically):
    output/miss_budget/miss_budget.csv
    output/miss_budget/miss_budget_summary.json
"""

import argparse
import csv
import json
import os
import sys
import time

# The RK4 loop is the CPU-bound part and never needs a large BLAS pool; one
# thread per worker keeps the spawn memory footprint small.
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

from concurrent.futures import ProcessPoolExecutor, as_completed  # noqa: E402
from dataclasses import replace  # noqa: E402

import numpy as np  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C  # noqa: E402
from main import Simulation  # noqa: E402

# Scenario overrides (Scenario fields); nominal is the project default.
SCENARIOS = {
    "nominal": {},
    "alt-5km": {"target_alt": 5000.0},
    "mach-2.5": {"target_mach": 2.5},
    "stress": {"target_alt": 8000.0, "target_mach": 2.8, "target_evade_g": 8.0},
}

# Variant = (SimConfig overrides, Scenario overrides).
VARIANTS = {
    "full": ({}, {}),
    "no_nav_delay": ({"nav_delay": 0.0}, {}),
    "no_sensor_noise": ({"sensor_noise_scale": 0.0}, {}),
    "truth_nav": ({"nav_delay": 0.0, "sensor_noise_scale": 0.0}, {}),
    "no_evade": ({}, {"target_evade_g": 0.0}),
}

QUICK_SCENARIOS = ("nominal", "alt-5km")
QUICK_VARIANTS = ("full", "no_sensor_noise", "truth_nav")


# ============================================================
# Case construction / execution
# ============================================================
def _base_cfg():
    """Run configuration with telemetry sized for the full flight."""
    cfg = C.SimConfig()
    return replace(
        cfg,
        enable_plot=False,
        verbose=False,
        max_steps=max(int(round(cfg.t_end / max(cfg.dt_log, 1e-6))) + 1000, 1000),
    )


def build_tasks(quick=False):
    """Return (scenario, variant, cfg_overrides, scenario_overrides) payloads."""
    scenario_names = QUICK_SCENARIOS if quick else tuple(SCENARIOS)
    variant_names = QUICK_VARIANTS if quick else tuple(VARIANTS)
    tasks = []
    for scenario_name in scenario_names:
        for variant_name in variant_names:
            cfg_ovr, scenario_ovr = VARIANTS[variant_name]
            scenario_ovr = dict(SCENARIOS[scenario_name], **scenario_ovr)
            tasks.append((scenario_name, variant_name, dict(cfg_ovr), scenario_ovr))
    return tasks


def run_case(payload):
    """Execute one matrix cell, returning only scalar metrics."""
    scenario_name, variant_name, cfg_overrides, scenario_overrides = payload
    t0 = time.time()
    try:
        cfg = replace(_base_cfg(), **cfg_overrides)
        scenario = C.Scenario(**scenario_overrides)
        sim = Simulation(cfg, scenario)
        sol = sim.run()
        return {
            "scenario": scenario_name,
            "variant": variant_name,
            "miss_distance": float(sim.miss_distance),
            "miss_time": float(sim.miss_time),
            "success": bool(sol.success),
            "final_phase": sim.phase,
            "cpu_time": time.time() - t0,
            "error": "",
        }
    except Exception as exc:  # noqa: BLE001 - one failure must not abort the matrix
        return {
            "scenario": scenario_name,
            "variant": variant_name,
            "miss_distance": float("nan"),
            "miss_time": float("nan"),
            "success": False,
            "final_phase": "",
            "cpu_time": time.time() - t0,
            "error": repr(exc),
        }


# ============================================================
# Statistics / persistence
# ============================================================
def summarize(results, scenarios, variants):
    """Per-cell mean/min/max over valid (error-free, finite) runs."""
    summary = []
    for scenario_name in scenarios:
        for variant_name in variants:
            rows = [r for r in results
                    if r["scenario"] == scenario_name and r["variant"] == variant_name]
            valid = np.array([r["miss_distance"] for r in rows
                              if not r["error"] and np.isfinite(r["miss_distance"])],
                             dtype=float)
            summary.append({
                "scenario": scenario_name,
                "variant": variant_name,
                "cases": len(rows),
                "valid": int(valid.size),
                "failed": len(rows) - int(valid.size),
                "mean": float(np.mean(valid)) if valid.size else float("nan"),
                "min": float(np.min(valid)) if valid.size else float("nan"),
                "max": float(np.max(valid)) if valid.size else float("nan"),
            })
    return summary


def _save_csv(results, output_dir):
    path = os.path.join(output_dir, "miss_budget.csv")
    fields = ["scenario", "variant", "miss_distance", "miss_time", "success",
              "final_phase", "cpu_time", "error"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    return path


def _render_table(summary):
    lines = []
    lines.append("=" * 84)
    lines.append("Miss-distance error budget   scenario x ablation variant "
                 "(mean/min/max, m)")
    lines.append("=" * 84)
    lines.append("%-10s %-16s %4s %4s %12s %12s %12s"
                 % ("Scenario", "Variant", "Valid", "Failed", "Mean", "Min", "Max"))
    for st in summary:
        miss = [st["mean"], st["min"], st["max"]]
        cells = ["%12.3f" % v if np.isfinite(v) else "%12s" % "NaN"
                 for v in miss]
        lines.append("%-10s %-16s %4d %4d %s %s %s"
                     % (st["scenario"], st["variant"], st["valid"],
                        st["failed"], cells[0], cells[1], cells[2]))
    lines.append("=" * 84)
    return "\n".join(lines)


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Miss-distance error budget diagnostics (scenario x ablation variant)")
    parser.add_argument("--quick", action="store_true",
                        help="Quick mode: nominal/alt-5km x full/no_sensor_noise/truth_nav")
    parser.add_argument("--workers", type=int, default=None,
                        help="Number of worker processes; defaults to min(8, CPU count)")
    args = parser.parse_args(argv)

    tasks = build_tasks(quick=args.quick)
    scenarios = list(dict.fromkeys(t[0] for t in tasks))
    variants = list(dict.fromkeys(t[1] for t in tasks))

    workers = args.workers if args.workers is not None else min(8, os.cpu_count() or 1)
    workers = max(1, min(int(workers), len(tasks)))

    print("Error budget: %d scenarios x %d variants = %d simulations | workers %d%s"
          % (len(scenarios), len(variants), len(tasks), workers,
             " (quick mode)" if args.quick else ""))

    t_wall = time.time()
    results = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_case, task) for task in tasks]
        for k, fut in enumerate(as_completed(futures), 1):
            try:
                res = fut.result()
            except Exception as exc:  # noqa: BLE001 - pool-level failure
                res = {"scenario": "?", "variant": "?", "miss_distance": float("nan"),
                       "miss_time": float("nan"), "success": False,
                       "final_phase": "", "cpu_time": 0.0, "error": repr(exc)}
            results.append(res)
            miss = ("%.3f m" % res["miss_distance"]) if np.isfinite(res["miss_distance"]) else "NaN"
            err = (" | failed: " + res["error"]) if res["error"] else ""
            print("  [%2d/%d] %-10s %-16s miss=%-10s %s%s"
                  % (k, len(tasks), res["scenario"], res["variant"], miss,
                     res["final_phase"], err))
    wall = time.time() - t_wall

    order = {(t[0], t[1]): i for i, t in enumerate(tasks)}
    results.sort(key=lambda r: order.get((r["scenario"], r["variant"]), len(order)))
    summary = summarize(results, scenarios, variants)

    output_dir = os.path.join(ROOT, C.SimConfig().output_dir, "miss_budget")
    os.makedirs(output_dir, exist_ok=True)
    csv_path = _save_csv(results, output_dir)
    json_path = os.path.join(output_dir, "miss_budget_summary.json")
    payload = {
        "quick": bool(args.quick),
        "workers": workers,
        "cases": len(tasks),
        "wall_time_s": wall,
        "scenarios": scenarios,
        "variants": variants,
        "summary": summary,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(_render_table(summary))
    print("Total wall clock: %.1f s | results saved to: %s, %s"
          % (wall, csv_path, json_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
