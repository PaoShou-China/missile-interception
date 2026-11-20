"""Compile the LaTeX manuscript and make a clean arXiv source archive."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

PAPER = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-zip", action="store_true", help="Also compile an extracted copy of the final source ZIP")
    args = parser.parse_args()
    build = PAPER / "build" / "latex"
    build.mkdir(parents=True, exist_ok=True)
    (build / "figures").mkdir(exist_ok=True)
    source_files = ["main.tex", "references.bib", "verification_numbers.tex"]
    text = (PAPER / "main.tex").read_text(encoding="utf-8")
    figure_paths = re.findall(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}", text)
    source_files += sorted(set(figure_paths))
    for name in source_files:
        shutil.copyfile(PAPER / name, build / name)
    logs = []

    def run(argv, cwd):
        result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        logs.append("$ " + " ".join(argv) + "\n" + result.stdout + result.stderr)
        (PAPER / "build/compile.log").write_text("\n\n".join(logs), encoding="utf-8")
        if result.returncode:
            raise RuntimeError("Compilation failed; see build/compile.log\n" + result.stdout[-2500:])

    latex = ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "main.tex"]
    run(latex, build)
    run(["bibtex", "main"], build)
    run(latex, build)
    run(latex, build)
    shutil.copyfile(build / "main.pdf", PAPER / "paper.pdf")
    shutil.copyfile(build / "main.bbl", PAPER / "main.bbl")
    source_files.append("main.bbl")
    with zipfile.ZipFile(PAPER / "arxiv-source.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(source_files):
            bundle.write(PAPER / name, name)
    zip_check = None
    if args.verify_zip:
        extracted = PAPER / "build" / "zip-check-v3"
        extracted.mkdir(exist_ok=True)
        with zipfile.ZipFile(PAPER / "arxiv-source.zip") as bundle:
            bundle.extractall(extracted)
        run(latex, extracted)
        run(latex, extracted)
        zip_check = "compiled successfully using bundled bibliography"
    log = (build / "main.log").read_text(encoding="utf-8", errors="replace")
    problems = [line for line in log.splitlines() if any(token in line for token in (
        "Overfull", "undefined", "multiply defined", "LaTeX Warning", "Package natbib Warning"))]
    result = {"pdf": "paper.pdf", "source_zip": "arxiv-source.zip", "source_files": sorted(source_files),
              "latex_warnings": problems, "zip_compile_check": zip_check}
    (PAPER / "evidence/build_check.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
