"""Paired architecture comparison: reference vs classical baseline.

A: feasible boost programme + scheduled three-loop autopilot
B: fixed-rate boost programme + classical fixed-gain PID

Both use the same paired case ids, dispersions, sensor seeds, guidance laws
(Bezier midcourse, ZEM/APN terminal) and target manoeuvre level, so the paired
difference isolates the boost/attitude-control architecture.

Usage (from ``missile_intercept/``):
    python tools/architecture_comparison.py --cases 24 --seed 2026
"""
import argparse
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

import config as C  # noqa: E402
from batch import Dispersion, run_batch  # noqa: E402
from guidance_comparison import _aggregate  # noqa: E402

ARMS = {
    "reference": {"boost_law": "feasible", "control_law": "scheduled"},
    "classic": {"boost_law": "fixed_rate", "control_law": "classic_pid"},
}


def _cfg(arm):
    cfg = C.SimConfig()
    cfg.midcourse_law = "bezier"
    cfg.terminal_law = "zem_apn"
    for key, value in ARMS[arm].items():
        setattr(cfg, key, value)
    return cfg


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=24)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--level", type=float, default=0.0)
    ap.add_argument("--workers", type=int, default=None)
    ap.add_argument("--out", default=os.path.join(
        REPO, "docs", "experiments", "architecture_comparison"))
    args = ap.parse_args(argv)

    dispersion = Dispersion(
        launch_cep_m=500.0, target_cep_m=2000.0,
        target_alt_sigma_m=500.0, target_mach_sigma=0.05,
        evade_g_sigma=0.0, evade_g_nominal=float(args.level),
    )
    os.makedirs(args.out, exist_ok=True)
    stats = {}
    all_rows = []
    for arm in ARMS:
        results = run_batch(
            args.cases, workers=args.workers, base_seed=args.seed,
            cfg=_cfg(arm), dispersion=dispersion,
            lethal_radius=C.WARHEAD_LETHAL_RADIUS,
            output_dir=os.path.join(args.out, "raw", arm),
            plot=False,
            checkpoint=os.path.join(args.out, "raw", arm, "cases.jsonl"),
            resume=True,
        )
        stats["architecture|%s|%g" % (arm, args.level)] = _aggregate(
            results, C.WARHEAD_LETHAL_RADIUS)
        for row in results:
            row = dict(row)
            row["experiment"] = "architecture"
            row["arm"] = arm
            row["sweep_level_g"] = args.level
            all_rows.append(row)

    summary = {
        "meta": {
            "experiment": "architecture",
            "cases_per_arm": args.cases,
            "seed": args.seed,
            "level_g": [args.level],
            "lethal_radius_m": C.WARHEAD_LETHAL_RADIUS,
            "arms": ARMS,
        },
        "stats": stats,
    }
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    if all_rows:
        with open(os.path.join(args.out, "all_runs.csv"), "w",
                  newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
            writer.writeheader()
            writer.writerows(all_rows)
    print(json.dumps({k: {kk: v[kk] for kk in ("n_valid", "hit_rate", "miss_median", "miss_p90")}
                      for k, v in stats.items()}, indent=2))
    return summary


if __name__ == "__main__":
    main()
