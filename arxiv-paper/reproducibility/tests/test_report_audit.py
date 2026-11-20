"""General static artifact auditing; no model imports or execution."""

import json

import pytest

from tools.audit_reports import audit_reports, main


REPORT = ("report/index.html",)


def write(root, relative, content="asset"):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_legacy_metadata_never_inferred_from_dates(tmp_path):
    write(tmp_path, REPORT[0], '<p>Run date: 2020-01-01</p><script src="assets/data.js"></script>')
    write(tmp_path, "report/assets/data.js")
    report = audit_reports(tmp_path, reports=REPORT)["reports"][0]
    assert report["status"] == "legacy_unverified"
    assert report["manifest"] is None
    assert report["artifacts"] == ["report/assets/data.js", "report/index.html"]
    assert not report["issues"]


def test_missing_local_assets_and_css_dependencies(tmp_path):
    write(tmp_path, REPORT[0], '<link rel="stylesheet" href="assets/style.css">'
          '<script src="missing.js?v=1#anchor"></script>')
    write(tmp_path, "report/assets/style.css", '@import "other.css"; p {background:url("bg.png")}')
    write(tmp_path, "report/assets/other.css", "p {color: blue}")
    report = audit_reports(tmp_path, reports=REPORT)["reports"][0]
    missing = {i["path"] for i in report["issues"] if i["code"] == "missing_asset"}
    assert missing == {"report/missing.js", "report/assets/bg.png"}


def test_external_embedded_navigation_and_query_references(tmp_path):
    write(tmp_path, REPORT[0], '<img src="data:image/png;base64,AA">'
          '<script src="https://cdn.invalid/lib.js"></script>'
          '<img src="//cdn.invalid/image.png"><a href="not-an-asset.html">next</a>'
          '<img src="assets/my%20image.png?q=2#x">')
    write(tmp_path, "report/assets/my image.png")
    report = audit_reports(tmp_path, reports=REPORT)["reports"][0]
    assert not report["issues"]
    assert len(report["artifacts"]) == 2


def test_inline_style_dependencies_are_checked(tmp_path):
    write(tmp_path, REPORT[0], '<style>body {background:url("missing.png")}</style>'
          '<p style="background:url(other.png)">example</p>')
    write(tmp_path, "report/provenance.json", "{}")
    complete = lambda *_: {"valid": True, "issues": [], "artifact_paths": list(REPORT)}
    report = audit_reports(tmp_path, reports=REPORT, verifier=complete)["reports"][0]
    assert report["status"] == "integrity_failed"
    assert {issue["path"] for issue in report["issues"]} == {
        "report/missing.png", "report/other.png"}


def test_manifest_needs_valid_hashes_and_full_coverage(tmp_path):
    write(tmp_path, REPORT[0], '<script src="assets/data.js"></script>')
    write(tmp_path, "report/assets/data.js")
    write(tmp_path, "report/provenance.json", "{}")
    incomplete = lambda *_: {"valid": True, "issues": [], "artifact_paths": [REPORT[0]]}
    report = audit_reports(tmp_path, reports=REPORT, verifier=incomplete)["reports"][0]
    assert report["status"] == "integrity_failed"
    assert report["issues"][0]["code"] == "incomplete_manifest_coverage"
    complete = lambda *_: {"valid": True, "issues": [], "artifact_paths": [
        REPORT[0], "report/assets/data.js"]}
    report = audit_reports(tmp_path, reports=REPORT, verifier=complete)["reports"][0]
    assert report["status"] == "snapshot_verified"
    assert not report["issues"]
    invalid = lambda *_: {"valid": False, "issues": [{"code": "hash_mismatch"}],
                          "artifact_paths": [REPORT[0], "report/assets/data.js"]}
    assert audit_reports(tmp_path, reports=REPORT, verifier=invalid)["reports"][0]["status"] == "integrity_failed"


def test_outside_references_are_not_read(tmp_path):
    write(tmp_path, REPORT[0], '<script src="../../private.js"></script>')
    report = audit_reports(tmp_path, reports=REPORT)["reports"][0]
    assert report["issues"][0]["code"] == "outside_repository"
    assert report["artifacts"] == [REPORT[0]]
    with pytest.raises(ValueError):
        audit_reports(tmp_path, reports=("../private.html",))


def test_unhandled_resolution_never_gets_verified(tmp_path):
    write(tmp_path, REPORT[0], '<base href="https://invalid.example/"><img srcset="a.png 1x,b.png 2x">')
    write(tmp_path, "report/provenance.json", "{}")
    complete = lambda *_: {"valid": True, "issues": [], "artifact_paths": list(REPORT)}
    report = audit_reports(tmp_path, reports=REPORT, verifier=complete)["reports"][0]
    assert report["status"] == "integrity_failed"
    assert all(i["code"] == "manual_dependency_review" for i in report["issues"])


def test_cli_stdout_and_strict_legacy_exit(tmp_path, capsys):
    assert main(["--root", str(tmp_path)]) == 0
    data = json.loads(capsys.readouterr().out)
    assert len(data["reports"]) == 3
    assert all(r["status"] == "legacy_unverified" for r in data["reports"])
    assert main(["--root", str(tmp_path), "--strict"]) == 1


def test_output_does_not_overwrite_existing_file(tmp_path):
    output = write(tmp_path, "audit.json", "original")
    with pytest.raises(SystemExit) as exc:
        main(["--root", str(tmp_path), "--output", str(output)])
    assert exc.value.code == 2
    assert output.read_text() == "original"


def test_stdout_json_is_ascii_safe_on_windows(tmp_path, capsys):
    write(tmp_path, "intercept-report/intercept-report.html", '<script src="数据.js"></script>')
    assert main(["--root", str(tmp_path)]) == 0
    output = capsys.readouterr().out
    output.encode("ascii")
    report = json.loads(output)["reports"][0]
    assert report["issues"][0]["path"] == "intercept-report/数据.js"


def test_broken_manifest_is_audited_without_crashing(tmp_path):
    write(tmp_path, REPORT[0], "<p>report</p>")
    write(tmp_path, "report/provenance.json", "{")
    def malformed(*_):
        raise ValueError("malformed json")
    report = audit_reports(tmp_path, reports=REPORT, verifier=malformed)["reports"][0]
    assert report["status"] == "integrity_failed"
    assert report["issues"][0]["code"] == "invalid_manifest"


def test_real_manifest_integration_detects_changed_data(tmp_path):
    from tools.provenance import create_manifest, write_manifest

    write(tmp_path, REPORT[0], '<script src="assets/data.js"></script>')
    data = write(tmp_path, "report/assets/data.js", "const data = [1];")
    manifest = create_manifest(tmp_path, [REPORT[0], "report/assets/data.js"])
    write_manifest(manifest, "report/provenance.json", tmp_path)
    assert audit_reports(tmp_path, reports=REPORT)["reports"][0]["status"] == "snapshot_verified"
    data.write_text("const data = [2];", encoding="utf-8")
    report = audit_reports(tmp_path, reports=REPORT)["reports"][0]
    assert report["status"] == "integrity_failed"
    assert any(issue["code"] == "file_changed" for issue in report["issues"])


def test_packaged_asset_symlinks_cannot_escape_root(tmp_path):
    root = tmp_path / "repo"
    write(root, REPORT[0], "<p>report</p>")
    outside = tmp_path / "external"
    write(outside, "private.html", '<img src="sensitive.png">')
    symlink = root / "report/assets"
    try:
        symlink.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Directory symlinks unavailable in this environment")
    report = audit_reports(root, reports=REPORT)["reports"][0]
    assert report["artifacts"] == list(REPORT)
    assert [issue["code"] for issue in report["issues"]] == ["outside_repository"]
