"""Generate manuscript numbers from saved audit and test records."""
from collections import Counter, defaultdict
import json
from pathlib import Path
import xml.etree.ElementTree as ET

PAPER = Path(__file__).resolve().parents[1]
DATA = PAPER / "evidence"


def read(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def main():
    root = ET.parse(DATA / "tooling_tests.xml").getroot()
    counts = defaultdict(Counter)
    for case in root.iter("testcase"):
        state = ("skipped" if case.find("skipped") is not None else
                 "failed" if case.find("failure") is not None or case.find("error") is not None else "passed")
        counts[case.attrib["classname"].split(".")[-1]][state] += 1
    totals = sum(counts.values(), Counter())
    audit, static, probes = read("report_audit.json"), read("static_inventory.json"), read("integrity_probes.json")
    environment, inventory = read("environment.json"), read("source_inventory.json")
    result = {
        "tooling_test_suites": {k: dict(v) for k, v in sorted(counts.items())},
        "tooling_test_totals": dict(totals),
        "reports": [{"entrypoint": r["entrypoint"], "assets": len(r["artifacts"]),
                     "issues": len(r["issues"]), "manifest_present": r["manifest"] is not None, "status": r["status"]} for r in audit["reports"]],
        "unique_report_assets": static["unique_report_assets"],
        "simulation_test_files": static["simulation_test_files"],
        "simulation_test_definitions": static["simulation_test_function_definitions"],
        "simulation_python_files": static["simulation_python_files"],
        "selected_file_count": len(inventory["files"]),
        "source_digest": inventory["file_list_sha256"],
        "probe_scenarios": probes["scenario_count"], "probe_expectations_met": probes["expectations_met"],
        "strict_audit_exit": probes["original_report_strict_exit"],
        "python": environment["python"]["version"],
        "pytest": environment["distributions"]["pytest"]["version"],
        "scope": "Generic tooling execution and static source/report inspection only.",
    }
    (DATA / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    macros = {
        "TestsPassed": totals["passed"], "TestsSkipped": totals["skipped"], "TestsFailed": totals["failed"],
        "TestsTotal": sum(totals.values()), "ReportAssets": static["unique_report_assets"],
        "SimulationTestFiles": static["simulation_test_files"], "SimulationTestDefinitions": static["simulation_test_function_definitions"],
        "SimulationPythonFiles": static["simulation_python_files"], "SelectedFiles": len(inventory["files"]),
        "ProbeCount": probes["scenario_count"], "ProbesMet": probes["expectations_met"],
        "AuditPython": environment["python"]["version"], "AuditPytest": environment["distributions"]["pytest"]["version"],
    }
    text = "% Generated from evidence records by scripts/summarize_evidence.py.\n"
    text += "".join("\\newcommand{\\%s}{%s\\xspace}\n" % (key, value) for key, value in macros.items())
    (PAPER / "evidence_numbers.tex").write_text(text, encoding="ascii")
    print(json.dumps({"tests": dict(totals), "selected_files": len(inventory["files"]), "probes": probes["expectations_met"]}))


if __name__ == "__main__":
    main()
