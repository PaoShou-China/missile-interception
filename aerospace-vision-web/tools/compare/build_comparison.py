"""Build the read-only comparison manifest from the current validated payload.

No simulation is run here. Run B is intentionally absent because the repository
currently holds only one comparable experiment; the reader can import one.
"""

import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCENARIO = os.path.join(ROOT, "public", "data", "missile-intercept", "scenario.json")
OUT_DIR = os.path.join(ROOT, "public", "data", "compare")
OUT = os.path.join(OUT_DIR, "comparison.json")


def main() -> int:
    with open(SCENARIO, "rb") as f:
        raw = f.read()
    data = json.loads(raw.decode("utf-8"))
    scenario_hash = hashlib.sha256(raw).hexdigest()

    run_a = {
        "run_id": "run-a",
        "display_name": "Baseline — validated 6-DoF telemetry",
        "algorithm_id": "missile-interception-6dof",
        "algorithm_version": "workspace",
        "source_commit": data["source"].get("commit", "workspace"),
        "scenario_id": data["id"],
        "configuration_hash": scenario_hash[:16],
        "seed": None,
        "trajectory_file": "data/missile-intercept/scenario.json",
        "metrics_file": None,
        "data_hash": scenario_hash,
        "time_start": data["time"]["startS"],
        "time_end": data["time"]["endS"],
        "reference_frame": "WGS84 ECEF",
        "units": "SI",
        "validation_status": data["validation"]["status"],
        "availability": "available",
        "is_synthetic": False,
        "notes": [
            "Single deterministic shot from a dirty working tree (commit=workspace).",
            "Provenance and audit: docs/scientific/RESULT_PROVENANCE.md.",
        ],
    }
    run_b = {
        "run_id": "run-b",
        "display_name": "Awaiting comparable experiment",
        "algorithm_id": "unknown",
        "algorithm_version": "—",
        "source_commit": "—",
        "scenario_id": data["id"],
        "configuration_hash": "—",
        "seed": None,
        "trajectory_file": "",
        "metrics_file": None,
        "data_hash": "",
        "time_start": 0,
        "time_end": 0,
        "reference_frame": "WGS84 ECEF",
        "units": "SI",
        "validation_status": "NOT RUN",
        "availability": "awaiting-import",
        "is_synthetic": False,
        "notes": [
            "No second independent run exists in the current repository.",
            "Import a scenario payload produced under the same scenario/protocol.",
            "Synthetic demo data is excluded from scientific claims.",
        ],
    }

    manifest = {
        "comparison_id": "cmp-nominal-pending-b",
        "title": "Nominal intercept — algorithm comparison",
        "description": (
            "Read-only comparison of already-generated experiment records. "
            "Run A is the validated workspace telemetry; Run B is awaiting a "
            "comparable import because no second independent run exists."
        ),
        "schemaVersion": "1.0.0",
        "comparison_protocol": {
            "name": "Same-scenario, same-protocol absolute-time comparison",
            "matching_criteria": [
                "Same scenario id",
                "Same launch and target datums",
                "Same Earth model",
                "Same simulation start time",
                "Same units and reference frame",
            ],
            "statistical_scope": "Single completed run per algorithm; no paired campaign is present.",
            "notes": [
                "Differences in scenario or initial conditions must be treated as Level C.",
                "Synthetic UI demo data must never be used for performance conclusions.",
            ],
        },
        "runs": [run_a, run_b],
        "alignment_mode": "absolute",
        "common_scenario_id": data["id"],
        "matching_status": "C",
        "validation_status": "NOT RUN",
        "source_links": [
            {"label": "Data audit", "href": "https://github.com/PaoShou-China/missile-interception/blob/main/aerospace-vision-web/docs/scientific/DATA_AUDIT.md"},
            {"label": "Result provenance", "href": "https://github.com/PaoShou-China/missile-interception/blob/main/aerospace-vision-web/docs/scientific/RESULT_PROVENANCE.md"},
        ],
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
