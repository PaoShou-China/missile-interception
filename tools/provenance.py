"""Capture and verify file snapshots without executing project code.

A post-hoc snapshot records the current files and capture environment. It is
not an execution record, a signature, or evidence of model validity.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timedelta, timezone


SCHEMA = "artifact-provenance/v1"
CAPTURE_KIND = "posthoc_snapshot"
SCOPE = (
    "Current file integrity and capture environment only; original execution, "
    "configuration values, seeds, result correctness and physical validity "
    "are not established by this snapshot."
)
EXCLUDED_DIRS = {
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    "output", ".mypy_cache", ".ruff_cache",
}


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value):
    return hashlib.sha256(_canonical(value)).hexdigest()


def _within(root, path):
    """Resolve a path and disallow escaping the explicitly selected root."""
    root = Path(root).resolve(strict=True)
    supplied = Path(path)
    target = supplied if supplied.is_absolute() else root / supplied
    target = target.resolve()
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes repository root: %s" % path) from exc
    if relative == Path("."):
        raise ValueError("expected a file, not the repository root")
    return target, relative.as_posix()


def _record(root, path):
    target, relative = _within(root, path)
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        before = os.fstat(stream.fileno())
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
        after = os.fstat(stream.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("file changed while hashing: %s" % relative)
    return {"path": relative, "size_bytes": after.st_size,
            "sha256": digest.hexdigest()}


def source_paths(root):
    """Inventory code/configuration *files*, without importing or evaluating them."""
    root = Path(root).resolve(strict=True)
    selected = []

    def raise_walk_error(error):
        raise error

    for directory, folders, files in os.walk(root, followlinks=False, onerror=raise_walk_error):
        folders[:] = sorted(name for name in folders if name not in EXCLUDED_DIRS)
        for name in folders:
            if (Path(directory) / name).is_symlink():
                raise ValueError("symlink directory in source inventory: %s" %
                                 (Path(directory) / name))
        for name in sorted(files):
            path = Path(directory) / name
            if (path.suffix in {".py", ".toml", ".yml", ".yaml"}
                    or (name.startswith("requirements") and path.suffix == ".txt")
                    or name in {"uv.lock", "poetry.lock", "Pipfile.lock"}):
                # File symlinks can otherwise silently read outside the source tree.
                if path.is_symlink():
                    raise ValueError("symlink in source inventory: %s" % path)
                selected.append(path.relative_to(root).as_posix())
    return sorted(selected)


def _utc_timestamp(value):
    if not isinstance(value, str):
        raise ValueError("capture timestamps must be UTC strings")
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() != timedelta(0):
        raise ValueError("capture timestamps must specify UTC")


def _validate_metadata(payload):
    """Check capture metadata structure without claiming historical authenticity."""
    required = {
        "schema", "capture_kind", "scope", "captured_at_utc", "label",
        "source_selection", "source_files", "inputs", "artifacts",
        "git_at_capture", "environment_at_capture", "source_sha256", "snapshot_id",
    }
    if set(payload) != required:
        raise ValueError("manifest has missing or unknown fields")
    _utc_timestamp(payload["captured_at_utc"])
    if payload["label"] is not None and not isinstance(payload["label"], str):
        raise ValueError("manifest label must be a string or null")
    git = payload["git_at_capture"]
    if not isinstance(git, dict):
        raise ValueError("invalid Git capture metadata")
    if git.get("status") == "unavailable":
        if set(git) != {"status", "reason"} or not isinstance(git["reason"], str):
            raise ValueError("unavailable Git metadata needs an explicit reason")
    elif git.get("status") == "available":
        commit = git.get("commit")
        if (set(git) != {"status", "commit", "dirty"} or type(git["dirty"]) is not bool
                or not isinstance(commit, str) or len(commit) not in {40, 64}
                or any(c not in "0123456789abcdef" for c in commit)):
            raise ValueError("invalid Git commit or workspace metadata")
    else:
        raise ValueError("unknown Git metadata status")
    env = payload["environment_at_capture"]
    if not isinstance(env, dict) or env.get("schema_version") != 1:
        raise ValueError("invalid capture environment")
    _utc_timestamp(env.get("recorded_at_utc"))
    if not isinstance(env.get("scope"), str) or not env["scope"]:
        raise ValueError("capture environment needs an explicit scope")
    for group, fields in (("python", ("version", "implementation", "executable")),
                          ("platform", ("system", "release", "machine"))):
        if (not isinstance(env.get(group), dict)
                or any(not isinstance(env[group].get(key), str) for key in fields)):
            raise ValueError("invalid capture environment %s metadata" % group)
    distributions = env.get("distributions")
    if not isinstance(distributions, dict):
        raise ValueError("invalid distribution inventory")
    for name, record in distributions.items():
        if (not isinstance(name, str) or not name or not isinstance(record, dict)
                or set(record) != {"status", "version"}):
            raise ValueError("invalid distribution metadata")
        if record["status"] == "installed":
            if not isinstance(record["version"], str) or not record["version"]:
                raise ValueError("installed distribution requires a version")
        elif record["status"] != "missing" or record["version"] is not None:
            raise ValueError("invalid distribution status")


def _git_snapshot(root):
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], check=True,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=10).stdout.strip()
    try:
        top = Path(git("rev-parse", "--show-toplevel")).resolve()
        if top != Path(root).resolve():
            return {"status": "unavailable", "reason": "root is not a Git checkout"}
        return {"status": "available", "commit": git("rev-parse", "HEAD"),
                "dirty": bool(git("status", "--porcelain", "--untracked-files=all"))}
    except (OSError, subprocess.SubprocessError):
        return {"status": "unavailable", "reason": "Git metadata unavailable"}


def create_manifest(root, artifacts, inputs=(), label=None):
    """Describe existing bytes; never run a command or infer historical metadata."""
    from tools.environment_snapshot import collect_environment

    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("repository root must be a directory")
    if not artifacts:
        raise ValueError("at least one artifact is required")

    def records(paths):
        result = [_record(root, path) for path in paths]
        names = [item["path"] for item in result]
        if len(names) != len(set(names)):
            raise ValueError("duplicate file path")
        return sorted(result, key=lambda item: item["path"])

    payload = {
        "schema": SCHEMA,
        "capture_kind": CAPTURE_KIND,
        "scope": SCOPE,
        "captured_at_utc": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "source_selection": "code-config-files/v1",
        "source_files": records(source_paths(root)),
        "inputs": records(inputs),
        "artifacts": records(artifacts),
        "git_at_capture": _git_snapshot(root),
        "environment_at_capture": collect_environment(),
    }
    payload["source_sha256"] = _digest(payload["source_files"])
    payload["snapshot_id"] = _digest(payload)
    _validate_metadata(payload)
    return payload


def write_manifest(manifest, output, root):
    """Create a new manifest, refusing to overwrite artifacts or existing files."""
    target, relative = _within(root, output)
    protected = {entry["path"] for key in ("artifacts", "inputs", "source_files")
                 for entry in manifest[key]}
    if relative in protected:
        raise ValueError("manifest output overlaps an inventoried file: %s" % relative)
    if target.suffix.lower() != ".json":
        raise ValueError("manifest output must have a .json extension")
    serialized = json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(serialized)
    return target


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: %s" % key)
        result[key] = value
    return result


def verify_manifest(manifest_path, root):
    """Verify current source/input/artifact bytes, returning structured failures."""
    result = {"valid": False, "issues": [], "capture_kind": None,
              "scope": SCOPE, "artifact_paths": [], "snapshot_id": None}

    def issue(code, message, path=None):
        entry = {"code": code, "message": message}
        if path is not None:
            entry["path"] = str(path)
        result["issues"].append(entry)

    try:
        path, _ = _within(root, manifest_path)
        with path.open(encoding="utf-8") as stream:
            payload = json.load(stream, object_pairs_hook=_no_duplicate_keys,
                                parse_constant=lambda value: (_ for _ in ()).throw(
                                    ValueError("non-finite JSON value: " + value)))
        if not isinstance(payload, dict):
            raise ValueError("manifest must be a JSON object")
        if payload.get("schema") != SCHEMA or payload.get("capture_kind") != CAPTURE_KIND:
            raise ValueError("unsupported manifest schema or capture kind")
        if payload.get("source_selection") != "code-config-files/v1":
            raise ValueError("unsupported source selection")
        if payload.get("scope") != SCOPE:
            raise ValueError("unexpected snapshot scope")
        _validate_metadata(payload)
        result["capture_kind"] = payload["capture_kind"]
        result["snapshot_id"] = payload.get("snapshot_id")
        without_id = {key: value for key, value in payload.items() if key != "snapshot_id"}
        if payload.get("snapshot_id") != _digest(without_id):
            issue("manifest_digest_mismatch", "manifest metadata changed or digest is invalid")

        for group in ("source_files", "inputs", "artifacts"):
            entries = payload.get(group)
            if not isinstance(entries, list) or (group == "artifacts" and not entries):
                raise ValueError("invalid or missing %s list" % group)
            seen = set()
            for entry in entries:
                if not isinstance(entry, dict) or set(entry) != {"path", "size_bytes", "sha256"}:
                    raise ValueError("invalid file entry in %s" % group)
                name, size, digest = entry["path"], entry["size_bytes"], entry["sha256"]
                if (not isinstance(name, str) or type(size) is not int or size < 0
                        or not isinstance(digest, str) or len(digest) != 64
                        or any(c not in "0123456789abcdef" for c in digest)):
                    raise ValueError("invalid file metadata in %s" % group)
                target, relative = _within(root, name)
                if name != relative or name in seen:
                    raise ValueError("noncanonical or duplicate path: %s" % name)
                seen.add(name)
                if group == "artifacts":
                    result["artifact_paths"].append(name)
                try:
                    current = _record(root, target)
                    if current != entry:
                        issue("file_changed", "%s content differs from snapshot" % group, name)
                except (OSError, ValueError) as exc:
                    issue("file_unavailable", str(exc), name)
            if group == "source_files":
                current_sources = set(source_paths(root))
                for name in sorted(current_sources - seen):
                    issue("source_added", "new code/configuration file since capture", name)
        if payload.get("source_sha256") != _digest(payload["source_files"]):
            issue("source_digest_mismatch", "source inventory digest is invalid")
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
        issue("invalid_manifest", str(exc))
    result["valid"] = not result["issues"]
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    capture = commands.add_parser("capture", help="snapshot existing files; no execution")
    capture.add_argument("--root", type=Path, default=Path.cwd())
    capture.add_argument("--artifact", action="append", required=True)
    capture.add_argument("--input", action="append", default=[])
    capture.add_argument("--label")
    capture.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify", help="check current bytes against a snapshot")
    verify.add_argument("--root", type=Path, default=Path.cwd())
    verify.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.action == "verify":
        result = verify_manifest(args.manifest, args.root)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if result["valid"] else 1
    try:
        manifest = create_manifest(args.root, args.artifact, args.input, args.label)
        path = write_manifest(manifest, args.output, args.root)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps({"manifest": str(path), "snapshot_id": manifest["snapshot_id"],
                      "capture_kind": CAPTURE_KIND, "scope": SCOPE},
                     ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
