"""Read-only inventory of static report assets and post-hoc snapshot integrity.

This tool does not run a simulation or validate the origin or meaning of results.
Run from the repository root with ``python -m tools.audit_reports``.
"""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from typing import Callable
from urllib.parse import unquote, urlsplit


REPORTS = (
    "intercept-report/intercept-report.html",
    "missile-intercept-overview/missile-intercept-overview.html",
    "test-report/missile_interceptor_test_report.html",
)

LIMITATIONS = [
    "A verified snapshot establishes file integrity since capture, not the original run provenance.",
    "Experiment dates, configuration, seeds, model validity and numerical claims are not inferred.",
    "External URLs, JavaScript-generated references and CSS generated at runtime are not checked.",
]


class AssetParser(HTMLParser):
    """Collect explicit runtime assets; navigation links are not dependencies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.references: list[str] = []
        self.unsupported: list[str] = []
        self.inline_styles: list[str] = []
        self.in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "style":
            self.in_style = True
        if values.get("style"):
            self.inline_styles.append(values["style"])
        if tag == "base" and values.get("href"):
            self.unsupported.append("base href changes URL resolution and needs manual review")
        if values.get("srcset"):
            self.unsupported.append("srcset requires manual dependency review")
        if tag in {"script", "img", "iframe", "source", "video", "audio", "embed", "input"}:
            if values.get("src"):
                self.references.append(values["src"])
        if tag == "video" and values.get("poster"):
            self.references.append(values["poster"])
        if tag == "object" and values.get("data"):
            self.references.append(values["data"])
        if tag == "link" and values.get("href"):
            rel = set((values.get("rel") or "").lower().split())
            if rel & {"stylesheet", "icon", "preload", "modulepreload", "manifest"}:
                self.references.append(values["href"])

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag: str) -> None:
        if tag == "style":
            self.in_style = False

    def handle_data(self, data: str) -> None:
        if self.in_style:
            self.inline_styles.append(data)


_CSS_URL = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE | re.DOTALL)
_CSS_IMPORT = re.compile(r"@import\s+(['\"])(.*?)\1", re.IGNORECASE)


def _css_references(content: str) -> list[str]:
    content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    references = [m.group(2).strip() for m in _CSS_URL.finditer(content)]
    references.extend(m.group(2) for m in _CSS_IMPORT.finditer(content))
    return references


def _inside(path: Path, root: Path) -> bool:
    return path.is_relative_to(root)


def _name(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _local_target(reference: str, source: Path, root: Path) -> Path | None:
    url = urlsplit(reference.strip())
    if url.scheme or url.netloc or not url.path:
        return None
    decoded = unquote(url.path).replace("\\", "/")
    return ((root / decoded.lstrip("/")) if decoded.startswith("/")
            else (source.parent / decoded)).resolve()


def _inventory(entrypoint: Path, root: Path) -> tuple[list[str], list[dict]]:
    pending = [entrypoint]
    issues: list[dict] = []
    # Include packaged data and libraries even when the HTML loads them indirectly.
    directories = [entrypoint.parent / "assets", entrypoint.parent / "_shared"]
    listed: set[Path] = set()
    while directories:
        directory = directories.pop().resolve()
        if not _inside(directory, root):
            issues.append({"code": "outside_repository", "message": "Asset directory resolves outside repository"})
            continue
        if directory in listed:
            continue
        listed.add(directory)
        if not directory.is_dir():
            continue
        try:
            children = list(directory.iterdir())
        except OSError as exc:
            issues.append({"code": "unreadable_asset_directory", "path": _name(directory, root),
                           "message": str(exc)})
            continue
        for child in children:
            resolved = child.resolve()
            if not _inside(resolved, root):
                issues.append({"code": "outside_repository", "path": _name(child, root),
                               "message": "Packaged asset resolves outside repository"})
            elif resolved.is_dir():
                directories.append(resolved)
            else:
                pending.append(resolved)
    visited: set[Path] = set()
    present: set[str] = set()
    while pending:
        candidate = pending.pop().resolve()
        if candidate in visited:
            continue
        visited.add(candidate)
        if not _inside(candidate, root):
            issues.append({"code": "outside_repository", "message": "Asset resolves outside repository"})
            continue
        name = _name(candidate, root)
        if not candidate.is_file():
            issues.append({"code": "missing_asset", "path": name, "message": "Local asset is missing"})
            continue
        present.add(name)
        if candidate.suffix.lower() not in {".html", ".htm", ".css"}:
            continue
        try:
            content = candidate.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeError) as exc:
            issues.append({"code": "unreadable_asset", "path": name, "message": str(exc)})
            continue
        if candidate.suffix.lower() == ".css":
            references = _css_references(content)
        else:
            parser = AssetParser()
            parser.feed(content)
            parser.close()
            references = parser.references
            for style in parser.inline_styles:
                references.extend(_css_references(style))
            issues.extend({"code": "manual_dependency_review", "path": name, "message": reason}
                          for reason in parser.unsupported)
        for reference in references:
            try:
                target = _local_target(reference, candidate, root)
            except ValueError as exc:
                issues.append({"code": "invalid_reference", "path": name, "message": str(exc)})
                continue
            if target is not None:
                pending.append(target)
    return sorted(present), issues


def _verify(manifest: Path, root: Path) -> dict:
    if __package__ in (None, ""):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from tools.provenance import verify_manifest
    return verify_manifest(manifest, root)


def audit_reports(root: Path, *, verifier: Callable[[Path, Path], dict] | None = None,
                  reports: tuple[str, ...] = REPORTS) -> dict:
    """Audit known reports without modifying them or trusting absent metadata."""
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError(f"Repository directory does not exist: {root}")
    results = []
    for relative in reports:
        entrypoint = (root / relative).resolve()
        if not _inside(entrypoint, root):
            raise ValueError("Report entrypoint must stay inside repository")
        artifacts, issues = _inventory(entrypoint, root)
        manifest = entrypoint.parent / "provenance.json"
        status = "legacy_unverified"
        if manifest.is_file():
            try:
                verification = (verifier or _verify)(manifest, root)
            except (OSError, ValueError, TypeError, KeyError) as exc:
                verification = {"valid": False, "issues": [
                    {"code": "invalid_manifest", "message": str(exc)}]}
            issues.extend(verification.get("issues", []))
            covered = set(verification.get("artifact_paths", []))
            uncovered = sorted(set(artifacts) - covered)
            if uncovered:
                issues.append({"code": "incomplete_manifest_coverage", "paths": uncovered,
                               "message": "Manifest does not cover every inventoried report asset"})
            status = ("snapshot_verified" if verification.get("valid") and not issues
                      else "integrity_failed")
        results.append({
            "entrypoint": relative,
            "status": status,
            "manifest": _name(manifest, root) if manifest.is_file() else None,
            "artifacts": artifacts,
            "issues": issues,
        })
    return {"schema_version": 1, "scope": "static_report_snapshot_integrity",
            "limitations": LIMITATIONS.copy(), "reports": results}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="Write JSON here; default is stdout")
    parser.add_argument("--strict", action="store_true",
                        help="Fail unless all reports have complete, valid snapshot manifests")
    args = parser.parse_args(argv)
    try:
        result = audit_reports(args.root)
        encoded = json.dumps(result, ensure_ascii=not bool(args.output), indent=2) + "\n"
        if args.output:
            # Exclusive create keeps an audit from overwriting an existing artifact.
            with args.output.open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(encoded)
        else:
            print(encoded, end="")
    except (OSError, ValueError) as exc:
        parser.exit(2, f"audit_reports: {exc}\n")
    return int(args.strict and any(report["status"] != "snapshot_verified"
                                   or report["issues"] for report in result["reports"]))


if __name__ == "__main__":
    raise SystemExit(main())
