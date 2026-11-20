"""Collect static evidence; never import or execute the simulation package."""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys

PAPER = Path(__file__).resolve().parents[1]
SAFE = PAPER / "reproducibility"
DATA = PAPER / "evidence"


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def record(root, relative):
    path = (root / relative).resolve(strict=True)
    path.relative_to(root)
    content = path.read_bytes()
    return {"path": relative, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=PAPER.parent)
    args = parser.parse_args()
    root = args.source_root.resolve(strict=True)
    DATA.mkdir(exist_ok=True)
    (SAFE / "tools").mkdir(parents=True, exist_ok=True)
    (SAFE / "tests").mkdir(exist_ok=True)
    copied = []
    for directory in ("tools", "tests"):
        for source in sorted((root / directory).glob("*.py")):
            destination = SAFE / directory / source.name
            shutil.copyfile(source, destination)
            copied.append(record(root, source.relative_to(root).as_posix()))
    shutil.copyfile(root / "LICENSE", SAFE / "LICENSE")
    sys.path.insert(0, str(SAFE))
    from tools.audit_reports import audit_reports
    from tools.environment_snapshot import collect_environment

    audit = audit_reports(root)
    write_json(DATA / "report_audit.json", audit)
    write_json(DATA / "environment.json", collect_environment())
    selected = set()
    for directory in ("missile_intercept", "tools", "tests", ".github"):
        for path in (root / directory).rglob("*"):
            relative = path.relative_to(root)
            if any(part in {"output", "__pycache__", ".pytest_cache"} for part in relative.parts):
                continue
            if path.is_file() and (path.suffix in {".py", ".yml", ".yaml"} or path.name == "requirements.txt"):
                selected.add(relative.as_posix())
    selected.update({"README.md", "docs/REPRODUCIBILITY.md", "LICENSE", "missile_intercept/README.md", "missile_intercept/README.en.md"})
    for report in audit["reports"]:
        selected.update(report["artifacts"])
    files = [record(root, name) for name in sorted(selected)]
    canonical = json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    inventory = {
        "schema": "paper-static-evidence/v1", "capture_kind": "posthoc_snapshot",
        "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "Selected current file bytes only. Original run provenance and physical validity are not established.",
        "git_metadata": "unavailable" if not (root / ".git").exists() else "not_evaluated",
        "selection": "Python/YAML source under four fixed directories excluding generated output/cache; requirements, five documentation/license files, and inventoried report assets.",
        "files": files, "file_list_sha256": hashlib.sha256(canonical).hexdigest(),
        "copied_generic_tooling": copied,
    }
    write_json(DATA / "source_inventory.json", inventory)
    modules = {}
    for directory in ("vehicle", "sensors", "guidance", "control"):
        modules[directory] = len(list((root / "missile_intercept" / directory).glob("*.py")))
    static_tests = {}
    for path in sorted((root / "missile_intercept" / "tests").glob("test_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        static_tests[path.name] = sum(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_") for n in ast.walk(tree))
    write_json(DATA / "static_inventory.json", {
        "module_files_including_init": modules,
        "simulation_python_files": sum(x["path"].startswith("missile_intercept/") and x["path"].endswith(".py") for x in files),
        "simulation_test_files": len(static_tests), "simulation_test_function_definitions": sum(static_tests.values()),
        "simulation_test_definition_counts": static_tests,
        "interpretation": "AST definition counts are neither pytest collected-case counts nor executed tests.",
        "report_count": len(audit["reports"]),
        "unique_report_assets": len({x for r in audit["reports"] for x in r["artifacts"]}),
    })
    print(json.dumps({"report_statuses": [r["status"] for r in audit["reports"]], "source_files": len(files), "source_digest": inventory["file_list_sha256"], "static_tests": sum(static_tests.values())}))


if __name__ == "__main__":
    main()
