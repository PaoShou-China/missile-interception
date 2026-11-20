"""Check the delivered PDF and its independently compiled source ZIP."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

import pdfplumber
from pypdf import PdfReader

PAPER = Path(__file__).resolve().parents[1]


def main():
    reader = PdfReader(PAPER / "paper.pdf")
    extracted = PdfReader(PAPER / "build/zip-check-v3/main.pdf")
    texts = [page.extract_text() or "" for page in reader.pages]
    zip_texts = [page.extract_text() or "" for page in extracted.pages]
    issues = []
    if texts != zip_texts:
        issues.append("independent source-ZIP compilation has different extracted text")
    if reader.metadata.get("/Author") != "Anonymous Authors":
        issues.append("unexpected PDF author metadata")
    if any(len(text.strip()) < 100 for text in texts):
        issues.append("empty or near-empty page")
    if any(token in "\n".join(texts) for token in ("TODO", "TBD", "??")):
        issues.append("unresolved text marker")
    command = "python verification.py --json ../arxiv-paper/evidence/numerical_verification.json"
    if command not in "\n".join(texts):
        issues.append("appendix command not preserved literally")
    font_run = subprocess.run(["pdffonts", str(PAPER / "paper.pdf")], capture_output=True, text=True)
    font_rows = [row for row in font_run.stdout.splitlines()[2:] if row.strip()]
    unembedded = [row.split()[0] for row in font_rows if row.split()[-5] != "yes"]
    if font_run.returncode or unembedded:
        issues.append("font embedding check failed")
    overflow = []
    with pdfplumber.open(PAPER / "paper.pdf") as pdf:
        for i, page in enumerate(pdf.pages, 1):
            for char in page.chars:
                if char["x0"] < 0 or char["x1"] > page.width + 0.2 or char["top"] < 0 or char["bottom"] > page.height + 0.2:
                    overflow.append(i)
                    break
    if overflow:
        issues.append("text outside physical page boundary")
    with zipfile.ZipFile(PAPER / "arxiv-source.zip") as bundle:
        members = bundle.namelist()
    disallowed = [p for p in members if Path(p).suffix in {".aux", ".log", ".out", ".blg"} or p == "paper.pdf"]
    if disallowed:
        issues.append("source ZIP contains generated document/intermediate files")
    inventory = json.loads((PAPER / "evidence/source_inventory.json").read_text())
    for row in inventory["copied_generic_tooling"]:
        path = PAPER / "reproducibility" / row["path"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
            issues.append("copied generic source differs: " + row["path"])
    software = json.loads((PAPER / "evidence/software_probes.json").read_text())
    original = {row["path"]: row["sha256"] for row in inventory["files"]}
    for selection in software["class_extraction"]:
        name = "missile_intercept/" + selection["source"]
        if selection["source_sha256"] != original.get(name):
            issues.append("class-extraction source differs from archive inventory: " + name)
    figure_members = [name for name in members if name.startswith("figures/") and name.endswith(".pdf")]
    if len(figure_members) != 4:
        issues.append("source ZIP does not contain the four current figures")
    build = json.loads((PAPER / "evidence/build_check.json").read_text())
    if build["latex_warnings"]:
        issues.append("final LaTeX warnings remain")
    result = {
        "valid": not issues, "pages": len(reader.pages),
        "pdf_author": reader.metadata.get("/Author"),
        "all_fonts_embedded": not unembedded and font_run.returncode == 0,
        "unembedded_fonts": unembedded, "page_boundary_overflow": overflow,
        "source_zip_compiles_to_same_text": texts == zip_texts,
        "source_zip_member_count": len(members),
        "source_zip_current_figure_count": len(figure_members),
        "generic_class_source_hashes_match_inventory": len(software["class_extraction"]),
        "copied_generic_files_match_original_inventory": len(inventory["copied_generic_tooling"]),
        "appendix_command_preserved": command in "\n".join(texts),
        "issues": issues,
        "scope": "Local PDF text/metadata/font/boundary checks plus source-ZIP comparison; manual page-image inspection is separate.",
    }
    (PAPER / "evidence/pdf_check.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return int(bool(issues))


if __name__ == "__main__":
    raise SystemExit(main())
