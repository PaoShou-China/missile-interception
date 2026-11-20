"""File-integrity regressions using synthetic files, never the simulation."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from tools import provenance as P


@pytest.fixture
def snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "_git_snapshot", lambda root: {
        "status": "unavailable", "reason": "synthetic test tree"})
    (tmp_path / "module.py").write_text("VALUE = 1\n", encoding="utf-8")
    (tmp_path / "settings.json").write_text('{"seed": 3}', encoding="utf-8")
    (tmp_path / "报告.txt").write_text("synthetic artifact\n", encoding="utf-8")
    manifest = P.create_manifest(tmp_path, ["报告.txt"], ["settings.json"], "test")
    path = P.write_manifest(manifest, "provenance.json", tmp_path)
    return tmp_path, path, manifest


def test_round_trip_and_scope(snapshot):
    root, path, manifest = snapshot
    result = P.verify_manifest(path, root)
    assert result["valid"], result
    assert result["artifact_paths"] == ["报告.txt"]
    assert result["capture_kind"] == "posthoc_snapshot"
    assert "original execution" in result["scope"]
    assert manifest["git_at_capture"]["status"] == "unavailable"
    assert manifest["source_files"][0]["path"] == "module.py"
    assert "environment_at_capture" in manifest
    assert not any("seed" in key for key in manifest)


@pytest.mark.parametrize("filename", ["报告.txt", "settings.json", "module.py"])
def test_detects_changed_artifact_input_and_source(snapshot, filename):
    root, path, _ = snapshot
    (root / filename).write_text("changed", encoding="utf-8")
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "file_changed" and i["path"] == filename
               for i in result["issues"])


def test_detects_new_source(snapshot):
    root, path, _ = snapshot
    (root / "extra.py").write_text("# added source\n", encoding="utf-8")
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "source_added" for i in result["issues"])


def test_ignores_generated_cache_and_output(snapshot):
    root, path, _ = snapshot
    for directory in ("__pycache__", "output", ".venv"):
        (root / directory).mkdir()
        (root / directory / "generated.py").write_text("ignored", encoding="utf-8")
    assert P.verify_manifest(path, root)["valid"]


def test_detects_deleted_artifact(snapshot):
    root, path, _ = snapshot
    (root / "报告.txt").unlink()
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "file_unavailable" for i in result["issues"])


def test_metadata_changes_invalidate_digest(snapshot):
    root, path, manifest = snapshot
    manifest["label"] = "silently edited"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "manifest_digest_mismatch" for i in result["issues"])


@pytest.mark.parametrize("content", ["[]", "null", "{", '{"a":1,"a":2}',
                                       '{"a":NaN}', '{"schema":"future"}'])
def test_malformed_manifests_return_failure(tmp_path, content):
    path = tmp_path / "provenance.json"
    path.write_text(content, encoding="utf-8")
    result = P.verify_manifest(path, tmp_path)
    assert not result["valid"]
    assert result["issues"][0]["code"] == "invalid_manifest"


def test_capture_rejects_outside_paths(snapshot):
    root, _, _ = snapshot
    with pytest.raises(ValueError, match="escapes"):
        P.create_manifest(root, [root.parent / "outside.txt"])


def test_verify_rejects_manifest_outside_root(snapshot):
    root, _, _ = snapshot
    result = P.verify_manifest(root.parent / "outside.json", root)
    assert not result["valid"]
    assert "escapes" in result["issues"][0]["message"]


def test_verify_rejects_traversal_even_with_recomputed_digest(snapshot):
    root, path, manifest = snapshot
    manifest["artifacts"][0]["path"] = "../outside.txt"
    manifest.pop("snapshot_id")
    manifest["snapshot_id"] = P._digest(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "invalid_manifest" and "escapes" in i["message"]
               for i in result["issues"])


def test_refuses_overwrite_and_overlap(snapshot):
    root, path, manifest = snapshot
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        P.write_manifest(manifest, path, root)
    assert path.read_bytes() == before
    with pytest.raises(ValueError, match="overlaps"):
        P.write_manifest(manifest, "settings.json", root)
    assert (root / "settings.json").read_text(encoding="utf-8") == '{"seed": 3}'


def test_snapshot_rejects_duplicates_and_empty_artifacts(snapshot):
    root, _, _ = snapshot
    with pytest.raises(ValueError, match="duplicate"):
        P.create_manifest(root, ["报告.txt", "./报告.txt"])
    with pytest.raises(ValueError, match="at least one"):
        P.create_manifest(root, [])


def test_root_can_move_without_invalidating_snapshot(snapshot, tmp_path_factory):
    import shutil

    root, _, _ = snapshot
    destination = tmp_path_factory.mktemp("relocated") / "copy"
    shutil.copytree(root, destination)
    assert P.verify_manifest("provenance.json", destination)["valid"]


def test_cli_reports_failure_exit_code_for_changed_artifact(snapshot):
    root, path, _ = snapshot
    (root / "报告.txt").write_text("changed", encoding="utf-8")
    command = [sys.executable, "-m", "tools.provenance", "verify", "--root", str(root),
               "--manifest", str(path)]
    completed = subprocess.run(command, cwd=Path(__file__).resolve().parents[1],
                               capture_output=True, text=True, encoding="utf-8")
    assert completed.returncode == 1, completed.stderr
    result = json.loads(completed.stdout)
    assert not result["valid"]


def test_git_does_not_attribute_a_parent_checkout(tmp_path, monkeypatch):
    class Completed:
        stdout = str(tmp_path.parent)

    monkeypatch.setattr(P.subprocess, "run", lambda *a, **k: Completed())
    assert P._git_snapshot(tmp_path)["status"] == "unavailable"


def test_source_traversal_permission_error_is_not_silently_omitted(tmp_path, monkeypatch):
    def denied_walk(root, *, followlinks, onerror):
        onerror(PermissionError("cannot inventory source directory"))
        return iter(())

    monkeypatch.setattr(P.os, "walk", denied_walk)
    with pytest.raises(PermissionError, match="cannot inventory"):
        P.source_paths(tmp_path)


@pytest.mark.parametrize("field,value", [
    ("captured_at_utc", "2026-01-01T12:00:00"),
    ("environment_at_capture", []),
    ("git_at_capture", {"status": "available", "commit": "invented", "dirty": False}),
    ("label", 5),
])
def test_recomputed_digest_does_not_bypass_metadata_validation(snapshot, field, value):
    root, path, manifest = snapshot
    manifest[field] = value
    manifest.pop("snapshot_id")
    manifest["snapshot_id"] = P._digest(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    result = P.verify_manifest(path, root)
    assert not result["valid"]
    assert any(i["code"] == "invalid_manifest" for i in result["issues"])


def test_missing_environment_is_rejected_even_with_recomputed_digest(snapshot):
    root, path, manifest = snapshot
    del manifest["environment_at_capture"]
    del manifest["snapshot_id"]
    manifest["snapshot_id"] = P._digest(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")
    assert not P.verify_manifest(path, root)["valid"]
