"""Tests for generic metadata capture; no scientific runtimes are imported."""

from importlib import metadata
import json
from pathlib import Path
import subprocess
import sys

import pytest

from tools import environment_snapshot as snapshot


def test_inventory_records_missing_and_normalizes_names(monkeypatch):
    queried = []

    def fake_version(name):
        queried.append(name)
        if name == "missing-dist":
            raise metadata.PackageNotFoundError(name)
        return "1.2.3"

    monkeypatch.setattr(snapshot.metadata, "version", fake_version)
    result = snapshot.collect_environment([" Missing_Dist ", "Example.Pkg", "example-pkg"])
    assert queried == ["example-pkg", "missing-dist"]
    assert result["distributions"] == {
        "example-pkg": {"status": "installed", "version": "1.2.3"},
        "missing-dist": {"status": "missing", "version": None},
    }
    assert "have not been validated" in result["scope"]
    assert result["python"]["version"]
    assert result["recorded_at_utc"].endswith("+00:00")


def test_empty_inventory_does_not_query_metadata(monkeypatch):
    def unexpected(_):
        pytest.fail("no packages should have been queried")

    monkeypatch.setattr(snapshot.metadata, "version", unexpected)
    assert snapshot.collect_environment([])["distributions"] == {}


def test_metadata_errors_are_not_misreported_as_missing(monkeypatch):
    def unreadable(_):
        raise OSError("unreadable metadata")

    monkeypatch.setattr(snapshot.metadata, "version", unreadable)
    with pytest.raises(OSError, match="unreadable"):
        snapshot.collect_environment(["example"])


@pytest.mark.parametrize("name", ["", "  ", None])
def test_invalid_distribution_name_is_rejected(name):
    with pytest.raises(ValueError, match="nonempty"):
        snapshot.collect_environment([name])


def test_cli_stdout_and_output_protection(tmp_path, capsys):
    assert snapshot.main(["--package", "provenance-test-nonexistent-package-94182"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["distributions"]["provenance-test-nonexistent-package-94182"]["status"] == "missing"

    target = tmp_path / "environment.json"
    assert snapshot.main(["--output", str(target), "--package", "pytest"]) == 0
    original = target.read_bytes()
    with pytest.raises(SystemExit) as error:
        snapshot.main(["--output", str(target)])
    assert error.value.code == 1
    assert target.read_bytes() == original
    assert snapshot.main(["--output", str(target), "--overwrite", "--package", "pytest"]) == 0
    assert json.loads(target.read_text(encoding="utf-8"))["distributions"]["pytest"]["status"] == "installed"


def test_cli_does_not_import_scientific_runtime_modules():
    root = Path(__file__).resolve().parents[1]
    code = (
        "import sys; from tools.environment_snapshot import collect_environment; "
        "collect_environment(); "
        "assert not ({'numpy', 'numba', 'scipy', 'matplotlib', 'yaml'} & set(sys.modules))"
    )
    result = subprocess.run([sys.executable, "-c", code], cwd=root,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
