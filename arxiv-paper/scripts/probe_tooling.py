"""Exercise generic file-integrity behavior using synthetic, nonphysical files."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sys
import tempfile

PAPER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PAPER / "reproducibility"))
from tools.audit_reports import audit_reports, main as audit_main
from tools.provenance import create_manifest, verify_manifest

REPORT = "report/index.html"


def dump(path, obj):
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def scenario(name, change, expected_valid):
    with tempfile.TemporaryDirectory(prefix="paper-integrity-") as name_tmp:
        root = Path(name_tmp)
        (root / "report" / "assets").mkdir(parents=True)
        (root / "module.py").write_text("LABEL = 'synthetic'\n", encoding="utf-8")
        (root / REPORT).write_text('<script src="assets/data.js"></script>', encoding="utf-8")
        (root / "report/assets/data.js").write_text("const values = [1, 2, 3];\n", encoding="utf-8")
        path = root / "snapshot.json"
        manifest = create_manifest(root, [REPORT, "report/assets/data.js"], label="synthetic-integrity-probe")
        dump(path, manifest)
        change(root, path, manifest)
        result = verify_manifest(path, root)
        return {"scenario": name, "expected_valid": expected_valid, "observed_valid": result["valid"],
                "expectation_met": result["valid"] == expected_valid, "issue_codes": sorted({x["code"] for x in result["issues"]})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=PAPER.parent,
                        help="Original archive for an optional strict static report audit")
    args = parser.parse_args()
    rows = []
    rows.append(scenario("unchanged_snapshot", lambda *_: None, True))
    rows.append(scenario("modified_report_asset", lambda r, *_: (r / "report/assets/data.js").write_text("changed\n"), False))
    rows.append(scenario("deleted_report_asset", lambda r, *_: (r / "report/assets/data.js").unlink(), False))
    rows.append(scenario("modified_source_file", lambda r, *_: (r / "module.py").write_text("LABEL = 'new'\n"), False))
    rows.append(scenario("added_selected_source", lambda r, *_: (r / "extra.py").write_text("VALUE = 1\n"), False))

    def change_metadata(root, path, manifest):
        manifest["label"] = "edited-after-capture"
        dump(path, manifest)
    rows.append(scenario("edited_manifest_metadata", change_metadata, False))

    def add_output(root, *_):
        (root / "output").mkdir()
        (root / "output/generated.py").write_text("TEMP = True\n")
    rows.append(scenario("generated_output_outside_selection", add_output, True))

    with tempfile.TemporaryDirectory(prefix="paper-coverage-") as tmp:
        root = Path(tmp)
        (root / "report/assets").mkdir(parents=True)
        (root / REPORT).write_text('<script src="assets/data.js"></script>', encoding="utf-8")
        (root / "report/assets/data.js").write_text("const x = 1;", encoding="utf-8")
        legacy = audit_reports(root, reports=(REPORT,))["reports"][0]
        rows.append({"scenario": "absent_report_manifest", "expected_status": "legacy_unverified", "observed_status": legacy["status"], "expectation_met": legacy["status"] == "legacy_unverified", "issue_codes": [x["code"] for x in legacy["issues"]]})
        manifest = create_manifest(root, [REPORT], label="incomplete-coverage")
        dump(root / "report/provenance.json", manifest)
        partial = audit_reports(root, reports=(REPORT,))["reports"][0]
        rows.append({"scenario": "incomplete_report_asset_coverage", "expected_status": "integrity_failed", "observed_status": partial["status"], "expectation_met": partial["status"] == "integrity_failed", "issue_codes": [x["code"] for x in partial["issues"]]})
        manifest = create_manifest(root, [REPORT, "report/assets/data.js"], label="complete-coverage")
        dump(root / "report/provenance.json", manifest)
        complete = audit_reports(root, reports=(REPORT,))["reports"][0]
        rows.append({"scenario": "complete_report_asset_coverage", "expected_status": "snapshot_verified", "observed_status": complete["status"], "expectation_met": complete["status"] == "snapshot_verified", "issue_codes": [x["code"] for x in complete["issues"]]})

    archive = args.source_root.resolve()
    archive_available = all((archive / name).is_file() for name in (
        "intercept-report/intercept-report.html",
        "missile-intercept-overview/missile-intercept-overview.html",
        "test-report/missile_interceptor_test_report.html"))
    strict_exit = None
    if archive_available:
        with redirect_stdout(io.StringIO()):
            strict_exit = audit_main(["--root", str(archive), "--strict"])
    # This last observation uses only static files in the original source archive.
    payload = {"schema": "paper-integrity-probes/v1", "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
               "scope": "Synthetic general file-integrity and asset-coverage checks; no simulation execution.",
               "scenarios": rows, "expectations_met": sum(r["expectation_met"] for r in rows),
               "scenario_count": len(rows), "original_report_strict_exit": strict_exit,
               "original_archive_available": archive_available,
               "limitation": "Small explicit scenarios, not exhaustive coverage, attack resistance, or physical validation."}
    dump(PAPER / "evidence/integrity_probes.json", payload)
    print(json.dumps({"expectations_met": payload["expectations_met"], "scenario_count": len(rows), "original_report_strict_exit": strict_exit}))
    return int(not all(r["expectation_met"] for r in rows) or strict_exit not in (None, 1))


if __name__ == "__main__":
    raise SystemExit(main())
