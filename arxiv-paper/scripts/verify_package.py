"""Write or verify hashes of delivered paper artifacts, excluding build/cache."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

PAPER = Path(__file__).resolve().parents[1]
MANIFEST = PAPER / "package_manifest.json"


def selected():
    return sorted(p for p in PAPER.rglob("*") if p.is_file() and p.name != MANIFEST.name
                  and not any(x in {"build", "__pycache__", ".pytest_cache"} for x in p.relative_to(PAPER).parts))


def records():
    return [{"path": p.relative_to(PAPER).as_posix(), "size_bytes": p.stat().st_size,
             "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in selected()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Create/refresh the current delivery snapshot")
    parser.add_argument("--source-root", type=Path, help="Also compare the selected original archive bytes")
    args = parser.parse_args()
    if args.write:
        MANIFEST.write_text(json.dumps({"schema": "paper-package-snapshot/v1",
            "captured_at_utc": datetime.now(timezone.utc).isoformat(),
            "scope": "Current delivered bytes, excluding build/cache and this manifest; unsigned snapshot, not historical provenance.",
            "files": records()}, indent=2) + "\n", encoding="utf-8")
    expected = json.loads(MANIFEST.read_text(encoding="utf-8"))["files"]
    actual = records()
    issues = []
    old = {x["path"]: x for x in expected}
    now = {x["path"]: x for x in actual}
    for name in sorted(set(old) | set(now)):
        if old.get(name) != now.get(name):
            issues.append({"path": name, "issue": "changed, missing, or added"})
    original_checked = 0
    if args.source_root:
        root = args.source_root.resolve(strict=True)
        inventory = json.loads((PAPER / "evidence/source_inventory.json").read_text())
        encoded = json.dumps(inventory["files"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if hashlib.sha256(encoded).hexdigest() != inventory["file_list_sha256"]:
            issues.append({"issue": "source inventory digest mismatch"})
        for row in inventory["files"]:
            path = (root / row["path"]).resolve()
            path.relative_to(root)
            content = path.read_bytes()
            if len(content) != row["size_bytes"] or hashlib.sha256(content).hexdigest() != row["sha256"]:
                issues.append({"path": row["path"], "issue": "original source changed"})
            original_checked += 1
    print(json.dumps({"valid": not issues, "package_files": len(actual), "original_files_checked": original_checked, "issues": issues}, indent=2))
    return int(bool(issues))


if __name__ == "__main__":
    raise SystemExit(main())
