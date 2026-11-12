"""Formal verification suite smoke test: every built-in case must pass."""

from verification import run_builtin_verification


def test_builtin_verification_passes():
    report = run_builtin_verification()
    failed = [c.name for c in report.cases if not c.passed]
    assert report.failed == 0, "failed verification cases: %s" % failed
