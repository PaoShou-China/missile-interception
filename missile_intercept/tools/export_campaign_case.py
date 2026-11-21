"""Export one paired case from the guidance-comparison campaign with telemetry.

The campaign (`tools/guidance_comparison.py`) stores only scalar metrics, so the
web comparison studio cannot replay it.  This driver rebuilds the *exact* paired
case with `batch.build_case` (same seed, same dispersion, same law) and writes
the full telemetry CSV.  It does not change the campaign results and does not
re-tune anything; it only makes the representative trajectory reproducible.

Usage (from ``missile_intercept/``):
    python tools/export_campaign_case.py --law bezier_zem_apn --out output/experiments/campaign_bezier_zem
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C  # noqa: E402
from batch import Dispersion, build_case  # noqa: E402
from main import Simulation  # noqa: E402

LAWS = {
    "bezier_zem_apn": ("bezier", "zem_apn"),
    "bezier_pn": ("bezier", "pn"),
    "pip_zem_apn": ("pip_pn", "zem_apn"),
    "pip_pn": ("pip_pn", "pn"),
}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--law", required=True, choices=sorted(LAWS))
    ap.add_argument("--boost-law", default="feasible", choices=["feasible", "fixed_rate"])
    ap.add_argument("--control-law", default="scheduled", choices=["scheduled", "classic_pid"])
    ap.add_argument("--case", type=int, default=0)
    ap.add_argument("--level", type=float, default=0.0, help="fixed target evasion g")
    ap.add_argument("--target-alt-km", type=float, default=None,
                    help="boost-arm sweep: fixed nominal target altitude (km)")
    ap.add_argument("--evade-sigma", type=float, default=0.0,
                    help="target evasion dispersion (boost arm uses 1.0)")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    midcourse, terminal = LAWS[args.law]
    cfg = C.SimConfig()
    cfg.boost_law = args.boost_law
    cfg.midcourse_law = midcourse
    cfg.terminal_law = terminal
    cfg.control_law = args.control_law
    cfg.enable_plot = False
    cfg.verbose = True

    dispersion = Dispersion(
        launch_cep_m=500.0, target_cep_m=2000.0,
        target_alt_sigma_m=500.0, target_mach_sigma=0.05,
        evade_g_sigma=float(args.evade_sigma),
        evade_g_nominal=float(args.level) if args.target_alt_km is None else None,
        target_alt_nominal=(float(args.target_alt_km) * 1000.0
                            if args.target_alt_km is not None else None),
    )
    # Full profile is required by the web adapter; the dynamics are unchanged
    # (the campaign itself used the basic profile only to keep the CSV small).
    cfg.telemetry_profile = "full"
    case_id, case_cfg, scenario = build_case(args.case, args.seed, cfg, dispersion)

    sim = Simulation(case_cfg, scenario)
    sim.run()
    path = sim.save(out_dir=args.out)
    meta = {
        "campaign": "guidance_comparison",
        "law": args.law,
        "boost_law": args.boost_law,
        "midcourse_law": midcourse,
        "terminal_law": terminal,
        "control_law": args.control_law,
        "case_id": int(case_id),
        "base_seed": int(args.seed),
        "level_g": float(args.level),
        "scenario": {
            "launch_lat": scenario.launch_lat,
            "launch_lon": scenario.launch_lon,
            "target_lat": scenario.target_lat,
            "target_lon": scenario.target_lon,
            "target_alt": scenario.target_alt,
            "target_mach": scenario.target_mach,
            "target_evade_g": scenario.target_evade_g,
            "target_evade_phase": scenario.target_evade_phase,
            "nav_seed": scenario.nav_seed,
            "seeker_seed": scenario.seeker_seed,
        },
        "miss_distance_m": float(sim.miss_distance),
        "miss_time_s": float(sim.miss_time),
        "telemetry_csv": os.path.abspath(path),
    }
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "case.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("case metadata:", os.path.join(args.out, "case.json"))
    return meta


if __name__ == "__main__":
    main()
