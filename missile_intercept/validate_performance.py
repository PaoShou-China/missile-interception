"""Performance validation: several task suites, each with multiple conditions.

Criterion
---------
A single shot is qualified when the miss distance is within
``--threshold`` metres (default 15 m).  A task suite passes when its
qualified rate is at least ``--min-rate`` (default 0.8).

Suites
------
A. Baseline         nominal engagement, repeated seeds
B. Altitude         target altitude sweep, <= 15 km
C. Speed            target Mach sweep, <= 3.0
D. Maneuver        target evasive-load sweep
E. Geometry        range / cross-range offsets
F. Stress           combined altitude + speed + manoeuvre + geometry

Operating envelope
-------------------
Target altitude <= 15 km and target Mach <= 3.0.  Every condition is kept
inside this envelope; extreme conditions are reported as boundary cases.

Every case is a full independent simulation executed in a worker process;
the aggregated miss distances are written to CSV / JSON / a text report.

Run:
    python validate_performance.py
    python validate_performance.py --workers 16 --seeds 3
    python validate_performance.py --suite baseline,altitude --no-plot
    python validate_performance.py --threshold 15 --min-rate 1.0
"""

import argparse
import csv
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field, replace

# Pin BLAS/OpenMP to one thread before numpy is imported.  The terminal
# endgame is sensitive enough that multi-threaded floating-point reductions
# change the miss distance by metres, and the parallel batch would then not
# be reproducible for the same seeds.
for _k in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_k, "1")

import numpy as np

import config as C
import math_utils as MU
import batch


# ============================================================
# Suite definition
# ============================================================
@dataclass
class Condition:
    """One engagement condition inside a suite (no random seeds)."""
    name: str
    overrides: dict = field(default_factory=dict)
    seeds: int = 0            # 0 -> use the suite / CLI default


@dataclass
class TaskSuite:
    key: str
    name: str
    description: str
    conditions: list


def _bearing_unit_to_launch():
    """Local east/north unit vector pointing from the target to the launch site.

    Evaluated in the target's ENU frame through the ECI model, so the bearing
    matches the same geometry the simulation flies (a flat fixed
    metres-per-degree constant is ~0.4 % off at this latitude and distorts a
    200 km offset).
    """
    r_t = MU.llh_to_eci(C.TARGET_LAT, C.TARGET_LON, 0.0, 0.0)
    r_l = MU.llh_to_eci(C.LAUNCH_LAT, C.LAUNCH_LON, 0.0, 0.0)
    enu = MU.local_enu_dcm(C.TARGET_LAT, C.TARGET_LON, 0.0)
    d = enu.T.dot(r_l - r_t)
    norm = math.hypot(d[0], d[1])
    return d[0] / norm, d[1] / norm


def _offset_target(along_m=0.0, cross_m=0.0):
    """Target latitude/longitude offset along the LOS / perpendicular to it.

    ``along_m`` > 0 moves the target further from the launch site (longer
    engagement), ``cross_m`` > 0 moves it to the left of the incoming LOS.
    """
    e_los, n_los = _bearing_unit_to_launch()
    # toward-launch unit vector is the LOS; along > 0 is away from launch.
    east = -along_m * e_los + cross_m * (-n_los)
    north = -along_m * n_los + cross_m * e_los
    lat, lon = batch._offset_llh(C.TARGET_LAT, C.TARGET_LON, east, north)
    return {"target_lat": lat, "target_lon": lon}


def build_suites():
    """Return the task-suite definitions (deterministic, independent of the CLI)."""
    return [
        TaskSuite(
            key="baseline",
            name="A Baseline",
            description="Nominal engagement: 15.24 km, Ma 1.6, defensive turn/dive after a "
                        "60 km warning + terminal weave",
            conditions=[
                Condition("nominal", {}, seeds=4),
            ],
        ),
        TaskSuite(
            key="altitude",
            name="B Target altitude",
            description="Target cruise altitude 5/8/12/15 km (inside the altitude envelope)",
            conditions=[
                Condition("alt-5km", {"target_alt": 5000.0}),
                Condition("alt-8km", {"target_alt": 8000.0}),
                Condition("alt-12km", {"target_alt": 12000.0}),
                Condition("alt-15km", {"target_alt": 15000.0}),
            ],
        ),
        TaskSuite(
            key="speed",
            name="C Target speed",
            description="Target Mach 0.8-1.6 (target flight envelope upper limit Ma 1.6)",
            conditions=[
                Condition("mach-0.8", {"target_mach": 0.8}),
                Condition("mach-1.0", {"target_mach": 1.0}),
                Condition("mach-1.2", {"target_mach": 1.2}),
                Condition("mach-1.4", {"target_mach": 1.4}),
                Condition("mach-1.6", {"target_mach": 1.6}),
            ],
        ),
        TaskSuite(
            key="maneuver",
            name="D Target maneuver",
            description="Terminal evasive command 0/3/6/9 g (lift-limited, including the "
                        "defensive turn starting at 60 km)",
            conditions=[
                Condition("evade-0g", {"target_evade_g": 0.0}),
                Condition("evade-3g", {"target_evade_g": 3.0}),
                Condition("evade-6g", {"target_evade_g": 6.0}),
                Condition("evade-9g", {"target_evade_g": 9.0}),
            ],
        ),
        TaskSuite(
            key="geometry",
            name="E Engagement geometry",
            description="Range offsets of +/-200 km and cross-range offsets of +/-150 km",
            conditions=[
                Condition("nominal", {}),
                Condition("range-short-200km", _offset_target(along_m=-200000.0)),
                Condition("range-long-200km", _offset_target(along_m=200000.0)),
                Condition("cross-left-150km", _offset_target(cross_m=150000.0)),
                Condition("cross-right-150km", _offset_target(cross_m=-150000.0)),
            ],
        ),
        TaskSuite(
            key="stress",
            name="F Combined stress",
            description="Most adverse combinations with altitude <= 15 km and Ma <= 1.6",
            conditions=[
                Condition("very-low-fast",
                          {"target_alt": 5000.0, "target_mach": 1.6,
                           "target_evade_g": 6.0}),
                Condition("low-fast-hard-evade",
                          {"target_alt": 8000.0, "target_mach": 1.6,
                           "target_evade_g": 9.0}),
                Condition("mid-fast-hard-evade",
                          {"target_alt": 12000.0, "target_mach": 1.6,
                           "target_evade_g": 9.0}),
                Condition("long-range-low-maneuver",
                          dict(_offset_target(along_m=200000.0),
                               target_alt=8000.0, target_mach=1.6,
                               target_evade_g=8.0)),
            ],
        ),
    ]


# ============================================================
# Case construction / execution
# ============================================================
def _make_payloads(suites, default_seeds, base_seed, case_cfg):
    payloads = []
    meta = {}
    case_id = 0
    for suite in suites:
        for cond in suite.conditions:
            n = cond.seeds or default_seeds
            for k in range(n):
                rng = np.random.RandomState(base_seed + case_id * 7919)
                scenario = C.Scenario(
                    **cond.overrides,
                    nav_seed=int(rng.randint(0, 100000)),
                    seeker_seed=int(rng.randint(0, 100000)),
                )
                payloads.append((case_id, case_cfg, scenario))
                meta[case_id] = (suite.key, suite.name, cond.name)
                case_id += 1
    return payloads, meta


def run_validation(suites=None, workers=None, seeds=2, base_seed=2026,
                   threshold=15.0, min_rate=0.8, cfg=None,
                   output_dir=None, plot=True, quiet=False):
    """Run every suite in parallel, aggregate and persist the statistics."""
    suites = suites if suites is not None else build_suites()
    if not suites:
        raise ValueError("No task suites to run")
    cfg = cfg if cfg is not None else C.SimConfig()
    output_dir = output_dir or os.path.join(cfg.output_dir, "validation")
    workers = int(workers) if workers is not None else min(os.cpu_count() or 1, 16)

    case_cfg = replace(
        cfg,
        verbose=False,
        enable_plot=False,
        telemetry_profile="basic",
        max_steps=max(int(round(cfg.t_end / max(cfg.dt_log, 1e-6))) + 1000, 1000),
    )
    payloads, meta = _make_payloads(suites, seeds, base_seed, case_cfg)
    workers = max(1, min(workers, len(payloads)))

    if not quiet:
        print("Performance validation: %d suites | %d cases | workers %d | "
              "criterion miss distance <= %.1f m"
              % (len(suites), len(payloads), workers, threshold))

    t_wall = time.time()
    results = []
    if workers == 1:
        for k, payload in enumerate(payloads, 1):
            results.append(batch.run_case(payload))
            if not quiet:
                _print_progress(k, len(payloads), results[-1], meta)
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(batch.run_case, p): p[0] for p in payloads}
            done = 0
            for fut in as_completed(futures):
                results.append(fut.result())
                done += 1
                if not quiet:
                    _print_progress(done, len(payloads), results[-1], meta)
    wall = time.time() - t_wall
    results.sort(key=lambda r: r["case_id"])

    for row in results:
        suite_key, suite_name, cond_name = meta[row["case_id"]]
        row["suite"] = suite_key
        row["suite_name"] = suite_name
        row["condition"] = cond_name
        row["qualified"] = bool(not row["error"]
                                and np.isfinite(row["miss_distance"])
                                and row["miss_distance"] <= threshold)

    summary = summarize_suites(suites, results, meta, threshold, min_rate)
    summary["wall_time_s"] = wall
    summary["workers"] = workers
    summary["base_seed"] = base_seed
    summary["t_end"] = cfg.t_end

    os.makedirs(output_dir, exist_ok=True)
    csv_path = _save_csv(results, output_dir)
    json_path = os.path.join(output_dir, "validation_summary.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    txt_path = os.path.join(output_dir, "validation_report.txt")
    text = render_report(summary, threshold)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(text)
    if plot:
        _plot_summary(summary, results, threshold, output_dir)

    if not quiet:
        print(text)
        print("Results saved to: %s" % ", ".join(os.path.abspath(p)
                                                 for p in (csv_path, json_path, txt_path)))
    return summary


def _print_progress(k, total, res, meta):
    _, suite_name, cond_name = meta[res["case_id"]]
    miss = ("%.2f m" % res["miss_distance"]) if np.isfinite(res["miss_distance"]) else "NaN"
    err = (" | failed: " + res["error"]) if res["error"] else ""
    print("  [%2d/%d] %-10s %-24s miss=%-9s %s%s"
          % (k, total, suite_name, cond_name, miss, res["final_phase"], err))


# ============================================================
# Statistics
# ============================================================
def _condition_stats(rows, threshold):
    valid = [r for r in rows if not r["error"]
             and np.isfinite(r["miss_distance"])]
    misses = np.array([r["miss_distance"] for r in valid], dtype=float)
    hits = int(np.sum(misses <= threshold))
    return {
        "cases": len(rows),
        "valid": int(misses.size),
        "failed": len(rows) - len(valid),
        "qualified": hits,
        "rate": (hits / misses.size) if misses.size else 0.0,
        "mean": float(np.mean(misses)) if misses.size else float("nan"),
        "median": float(np.median(misses)) if misses.size else float("nan"),
        "min": float(np.min(misses)) if misses.size else float("nan"),
        "max": float(np.max(misses)) if misses.size else float("nan"),
        "cep90": float(np.percentile(misses, 90)) if misses.size else float("nan"),
    }


def summarize_suites(suites, results, meta, threshold=15.0, min_rate=0.8):
    by_case = {r["case_id"]: r for r in results}
    suite_entries = []
    all_qualified = True
    for suite in suites:
        cond_entries = []
        suite_rows = []
        for cond in suite.conditions:
            rows = [by_case[cid] for cid, m in meta.items()
                    if m[0] == suite.key and m[2] == cond.name]
            rows.sort(key=lambda r: r["case_id"])
            st = _condition_stats(rows, threshold)
            st["name"] = cond.name
            cond_entries.append(st)
            suite_rows.extend(rows)
        st = _condition_stats(suite_rows, threshold)
        st["key"] = suite.key
        st["name"] = suite.name
        st["description"] = suite.description
        st["passed"] = bool(st["rate"] >= min_rate)
        all_qualified = all_qualified and st["passed"]
        st["conditions"] = cond_entries
        suite_entries.append(st)
    return {
        "threshold_m": float(threshold),
        "min_rate": float(min_rate),
        "passed": bool(all_qualified),
        "suites": suite_entries,
    }


def render_report(summary, threshold):
    lines = []
    lines.append("=" * 86)
    lines.append("Performance validation report   criterion: per-shot miss distance "
                 "<= %.1f m | suite pass rate >= %.0f%%"
                 % (threshold, 100.0 * summary["min_rate"]))
    lines.append("=" * 86)
    for suite in summary["suites"]:
        verdict = "PASS" if suite["passed"] else "FAIL"
        lines.append("")
        lines.append("[%s] %s  —  %s" % (verdict, suite["name"], suite["description"]))
        lines.append("  %-24s %4s %4s %7s %9s %9s %9s"
                     % ("Condition", "Cases", "Pass", "Pass rate",
                        "Mean(m)", "Median(m)", "Max(m)"))
        for cond in suite["conditions"]:
            lines.append("  %-24s %4d %4d %6.1f%% %9.2f %9.2f %9.2f"
                         % (cond["name"], cond["cases"], cond["qualified"],
                            100.0 * cond["rate"], cond["mean"],
                            cond["median"], cond["max"]))
        lines.append("  %-24s %4d %4d %6.1f%% %9.2f %9.2f %9.2f"
                     % ("Suite total", suite["cases"], suite["qualified"],
                        100.0 * suite["rate"], suite["mean"],
                        suite["median"], suite["max"]))
    lines.append("")
    lines.append("-" * 86)
    lines.append("Overall verdict: %s" % ("PASS" if summary["passed"] else "FAIL"))
    lines.append("Total wall clock: %.1f s (workers %d)"
                 % (summary["wall_time_s"], summary["workers"]))
    lines.append("=" * 86)
    return "\n".join(lines) + "\n"


# ============================================================
# Persistence
# ============================================================
def _save_csv(results, output_dir):
    path = os.path.join(output_dir, "validation_results.csv")
    if not results:
        return path
    fields = ["suite", "suite_name", "condition", "case_id", "qualified",
              "miss_distance", "miss_time", "final_phase", "success",
              "cpu_time", "target_lat", "target_lon", "target_alt",
              "target_mach", "evade_g", "launch_lat", "launch_lon", "error"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    return path


def _plot_summary(summary, results, threshold, output_dir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001 - plotting is optional
        return None
    suites = summary["suites"]
    english = {"baseline": "A baseline", "altitude": "B altitude",
               "speed": "C speed", "maneuver": "D maneuver",
               "geometry": "E geometry", "stress": "F stress"}
    labels = [english.get(s["key"], s["key"]) for s in suites]
    rates = [100.0 * s["rate"] for s in suites]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.8))
    colors = ["#3f8f5f" if s["passed"] else "#b34b4b" for s in suites]
    bars = ax1.bar(range(len(suites)), rates, color=colors, alpha=0.9)
    ax1.axhline(100.0 * summary["min_rate"], color="k", ls="--", lw=1,
                label="Required %.0f%%" % (100.0 * summary["min_rate"]))
    ax1.set_xticks(range(len(suites)))
    ax1.set_xticklabels(labels, rotation=18, ha="right")
    ax1.set_ylim(0, 105)
    ax1.set_ylabel("Qualified rate (%)")
    ax1.set_title("Task suites vs %.0f m criterion" % threshold)
    ax1.grid(True, axis="y", alpha=0.3)
    ax1.legend()
    for bar, rate in zip(bars, rates):
        ax1.text(bar.get_x() + bar.get_width() / 2.0, min(rate + 2.0, 102.0),
                 "%.0f%%" % rate, ha="center", va="bottom", fontsize=8)

    for i, suite in enumerate(suites):
        miss = [r["miss_distance"] for r in results
                if r["suite"] == suite["key"] and not r["error"]
                and np.isfinite(r["miss_distance"])]
        if miss:
            ax2.scatter(np.full(len(miss), i), np.maximum(miss, 1e-2),
                        s=18, alpha=0.75)
    ax2.axhline(threshold, color="r", ls="--", lw=1,
                label="Criterion %.0f m" % threshold)
    ax2.set_yscale("log")
    ax2.set_xticks(range(len(suites)))
    ax2.set_xticklabels(labels, rotation=18, ha="right")
    ax2.set_ylabel("Miss distance (m, log)")
    ax2.set_title("Per-case miss distance")
    ax2.grid(True, axis="y", alpha=0.3, which="both")
    ax2.legend()

    fig.tight_layout()
    path = os.path.join(output_dir, "validation_summary.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return os.path.abspath(path)


# ============================================================
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Multi-suite performance validation (miss-distance criterion)")
    parser.add_argument("--workers", type=int, default=None,
                        help="Number of worker processes; defaults to min(CPU count, 16)")
    parser.add_argument("--seeds", type=int, default=2,
                        help="Random seeds per condition (the baseline suite uses 4)")
    parser.add_argument("--seed", type=int, default=2026,
                        help="Base random seed")
    parser.add_argument("--threshold", type=float, default=15.0,
                        help="Per-shot pass miss distance, m")
    parser.add_argument("--min-rate", type=float, default=0.8,
                        help="Pass rate required for a suite to pass")
    parser.add_argument("--suite", type=str, default=None,
                        help="Run only the given suites, comma-separated: baseline,altitude,...")
    parser.add_argument("--duration", type=float, default=None,
                        help="Total duration of a single simulation, s")
    parser.add_argument("--max-step", type=float, default=None,
                        help="Maximum integration step, s")
    parser.add_argument("--out", type=str, default=None,
                        help="Output directory for results")
    parser.add_argument("--no-plot", action="store_true",
                        help="Do not plot the summary figure")
    args = parser.parse_args(argv)

    suites = build_suites()
    if args.suite:
        wanted = {s.strip() for s in args.suite.split(",") if s.strip()}
        known = {s.key for s in suites}
        unknown = wanted - known
        if unknown:
            parser.error("Unknown task suite(s): %s (available: %s)"
                         % (",".join(sorted(unknown)), ",".join(sorted(known))))
        suites = [s for s in suites if s.key in wanted]

    cfg = C.SimConfig()
    if args.max_step is not None:
        cfg.max_step = args.max_step
    if args.duration is not None:
        cfg.t_end = args.duration
    cfg.enable_plot = not args.no_plot

    summary = run_validation(
        suites=suites, workers=args.workers, seeds=args.seeds,
        base_seed=args.seed, threshold=args.threshold,
        min_rate=args.min_rate, cfg=cfg,
        output_dir=args.out or os.path.join(cfg.output_dir, "validation"),
        plot=cfg.enable_plot)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
