"""Record runtime metadata without importing scientific packages.

This is an inventory, not a dependency resolver or a compatibility test.  It
does not execute the simulation and does not inspect environment variables.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib import metadata
import json
from pathlib import Path
import platform
import re
import sys
from typing import Iterable


DEFAULT_PACKAGES = (
    "numpy", "numba", "scipy", "matplotlib", "pyyaml", "pytest", "pytest-xdist",
)


def collect_environment(packages: Iterable[str] | None = None) -> dict:
    """Return JSON-safe runtime and distribution metadata.

    Only distribution metadata is read; package modules are never imported.
    A missing distribution has an explicit status instead of a guessed version.
    Unexpected metadata read errors propagate rather than being labelled missing.
    """
    names = set()
    for name in DEFAULT_PACKAGES if packages is None else packages:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("distribution names must be nonempty strings")
        names.add(re.sub(r"[-_.]+", "-", name.strip()).lower())

    distributions = {}
    for name in sorted(names):
        try:
            version = metadata.version(name)
        except metadata.PackageNotFoundError:
            distributions[name] = {"status": "missing", "version": None}
        else:
            distributions[name] = {"status": "installed", "version": version}

    return {
        "schema_version": 1,
        "recorded_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "Runtime and installed-distribution inventory only; dependency "
                 "compatibility and numerical results have not been validated.",
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "distributions": distributions,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--package", action="append", dest="packages", metavar="DISTRIBUTION",
        help="distribution to inventory (repeatable; replaces the default list)",
    )
    parser.add_argument("--output", type=Path, help="write JSON to this new file")
    parser.add_argument(
        "--overwrite", action="store_true",
        help="allow replacing an existing --output file",
    )
    args = parser.parse_args(argv)
    if args.overwrite and args.output is None:
        parser.error("--overwrite requires --output")
    try:
        payload = json.dumps(collect_environment(args.packages), indent=2,
                             ensure_ascii=True, allow_nan=False) + "\n"
        if args.output is None:
            sys.stdout.write(payload)
        else:
            with args.output.open("w" if args.overwrite else "x", encoding="utf-8") as stream:
                stream.write(payload)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"environment snapshot failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
