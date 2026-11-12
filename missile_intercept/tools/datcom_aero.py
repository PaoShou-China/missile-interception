"""Generate the M <= 5 DATCOM coefficient table for this interceptor.

Runs the original USAF Digital DATCOM (Jan 96) executable on a deck built
from config.py geometry (tangent-ogive body + cruciform fin pair modelled as
the horizontal wing and the vertical tail), parses the output tables and
writes ``output/datcom_aero.csv``.

Usage
-----
    python tools/datcom_aero.py

The executable is expected at ``tools/datcom/datcom.exe``.  The aircraft
DATCOM sources can be rebuilt with:

    gfortran -std=legacy -ffixed-line-length-72 -finit-local-zero -O1 \
             <src/*.f except dplot.f> -o tools/datcom/datcom.exe

Reference: AFFDL-TR-79-3032, USAF Stability and Control Digital DATCOM.
"""

import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C  # noqa: E402

FT = 3.280839895            # m -> ft
NOSE_LEN = 2.0              # tangent-ogive nose length, m
MACH_LIST = [0.20, 0.50, 0.80, 0.95, 1.05, 1.20, 2.00, 3.00, 4.00, 5.00]
ALPHA_LIST = [0.0, 2.0, 4.0, 6.0, 8.0, 12.0, 16.0, 20.0, 24.0]


# ------------------------------------------------------------
# Deck construction
# ------------------------------------------------------------
def body_stations(n=11):
    """Tangent-ogive nose + cylinder; returns X, S, P, R in feet."""
    length = C.LENGTH * FT
    radius = C.DIAMETER * 0.5 * FT
    ln = NOSE_LEN * FT
    rho = (radius * radius + ln * ln) / (2.0 * radius)
    xs, ss, ps, rs = [], [], [], []
    for frac in np.linspace(0.0, 1.0, n):
        x = frac * length
        if x <= ln:
            r = max(math.sqrt(max(rho * rho - (ln - x) ** 2, 0.0)) + radius - rho, 0.0)
        else:
            r = radius
        xs.append(x)
        ss.append(math.pi * r * r)
        ps.append(2.0 * math.pi * r)
        rs.append(r)
    return xs, ss, ps, rs


def _f(values):
    return ",".join("%.6g" % v for v in values)


def build_deck():
    xs, ss, ps, rs = body_stations()
    length = C.LENGTH * FT
    sref = C.S_REF * FT ** 2
    span = (C.WING_SPAN + C.DIAMETER * 0.5) * FT
    exposed = C.WING_SPAN * FT
    sweep = math.degrees(math.atan((C.ROOT_CHORD - C.TIP_CHORD) / (span / FT)))
    root, tip = C.ROOT_CHORD * FT, C.TIP_CHORD * FT
    nose_ft = NOSE_LEN * FT
    after = length - nose_ft
    x_fin = (C.LENGTH - C.ROOT_CHORD) * FT

    lines = [
        " $FLTCON NMACH=%.1f, MACH(1)=%s," % (len(MACH_LIST), _f(MACH_LIST)),
        "   NALPHA=%.1f, ALSCHD(1)=%s," % (len(ALPHA_LIST), _f(ALPHA_LIST)),
        "   NALT=%.1f, ALT(1)=%s, LOOP=1.0$"
        % (len(MACH_LIST), _f([0.0] * len(MACH_LIST))),
        " $OPTINS SREF=%.3f, CBARR=%.3f, BLREF=%.3f$"
        % (sref, length, 2.0 * span),
        " $SYNTHS XCG=%.3f, ZCG=0.0, XW=%.3f, ZW=0.0, ALIW=0.0,"
        % (C.CG_FULL * FT, x_fin),
        "   XV=%.3f, ZV=0.0, VERTUP=.TRUE.$" % x_fin,
        " $BODY NX=%.1f, BNOSE=1.0, BTAIL=0.0, BLN=%.3f, BLA=%.3f,"
        % (len(xs), nose_ft, after),
        "   X(1)=%s," % _f(xs[:6]),
        "     %s," % _f(xs[6:]),
        "   S(1)=%s," % _f(ss[:6]),
        "     %s," % _f(ss[6:]),
        "   P(1)=%s," % _f(ps[:6]),
        "     %s," % _f(ps[6:]),
        "   R(1)=%s," % _f(rs[:6]),
        "     %s$" % _f(rs[6:]),
        " $WGPLNF CHRDR=%.3f, CHRDTP=%.3f, SSPN=%.3f, SSPNE=%.3f,"
        % (root, tip, span, exposed),
        "   SAVSI=%.2f, CHSTAT=0.0, TWISTA=0.0, TYPE=1.0$" % sweep,
        " $WGSCHR TOVC=0.05, XOVC=0.40, LERI=0.004, CLI=0.0, ALPHAI=0.0,",
        "   CLALPA=0.10, CLMAX(1)=1.0, CMO=0.0, CAMBER=.FALSE., TCEFF=0.05$",
        " $VTPLNF CHRDR=%.3f, CHRDTP=%.3f, SSPN=%.3f, SSPNE=%.3f,"
        % (root, tip, span, exposed),
        "   SAVSI=%.2f, CHSTAT=0.0, TWISTA=0.0, TYPE=0.0$" % sweep,
        " $VTSCHR TOVC=0.05, XOVC=0.40, LERI=0.004, CLI=0.0, ALPHAI=0.0,",
        "   CLALPA=0.10, CLMAX(1)=1.0, CMO=0.0, CAMBER=.FALSE., TCEFF=0.05$",
        "CASEID MISSILE CRUCIFORM FINS",
        "NEXT CASE",
    ]

    return "\n".join(lines) + "\n"


# ------------------------------------------------------------
# Output parsing
# ------------------------------------------------------------
_ROW = re.compile(r"^\s*(-?\d+\.\d)\s+(.*)$")
_MACH = re.compile(r"^0\s+(\d\.\d{3})\s")
_NCOLS = 12   # alpha CD CL CM CN CA XCP CLA CMA CYB CNB CLB


def _num(text):
    try:
        return float(text)
    except ValueError:
        return float("nan")


def parse_output(path):
    """Return [(mach, [(alpha, CD, CL, CM, CN, CA, ..., CYB, CNB, CLB)]), ...]."""
    blocks = []
    mach = None
    with open(path, encoding="latin-1") as fh:
        for line in fh:
            line = line.rstrip("\n")
            mm = _MACH.match(line)
            if mm:
                mach = float(mm.group(1))
            if "ALPHA" in line and "CLA" in line:
                blocks.append((mach, []))
                continue
            if not blocks:
                continue
            rm = _ROW.match(line)
            if not rm:
                continue
            parts = rm.group(2).split()
            vals = [_num(p) for p in parts]
            if len(vals) < _NCOLS:
                vals += [float("nan")] * (_NCOLS - len(vals))
            blocks[-1][1].append(tuple([float(rm.group(1))] + vals[:_NCOLS - 1]))
    return [(m, rows) for m, rows in blocks if rows]


# ------------------------------------------------------------
def main():
    exe = os.path.join(ROOT, "tools", "datcom", "datcom.exe")
    if not os.path.isfile(exe):
        raise SystemExit("datcom.exe not found: %s" % exe)

    run_dir = os.path.join(tempfile.gettempdir(), "mdrun")
    if os.path.isdir(run_dir):
        shutil.rmtree(run_dir)
    os.makedirs(run_dir)
    deck = build_deck()
    with open(os.path.join(run_dir, "md.inp"), "w", encoding="ascii") as fh:
        fh.write(deck)

    # DATCOM truncates argv to 32 characters, so pass a bare file name and
    # run inside the short temporary working directory.
    subprocess.run([exe, "md.inp"], cwd=run_dir, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    blocks = parse_output(os.path.join(run_dir, "output.dat"))
    if not blocks:
        raise SystemExit("DATCOM produced no coefficient tables")

    out_dir = os.path.join(ROOT, "output")
    os.makedirs(out_dir, exist_ok=True)
    csv = os.path.join(out_dir, "datcom_aero.csv")
    gaps = []
    summary_mach, fit_cna, fit_cma, fit_cd0, fit_k = [], [], [], [], []
    with open(csv, "w", encoding="ascii") as fh:
        fh.write("mach,alpha_deg,CD,CL,CM,CN,CA,CN_alpha,CM_alpha,"
                 "CYB,CNB,CLB\n")
        summary = []
        for mach, rows in blocks:
            valid = [r for r in rows if all(np.isfinite(r[k]) for k in (1, 2, 3, 4))]
            if len(valid) < len(rows):
                gaps.append(mach)
            zero = next((r for r in valid if r[0] == 0.0), None)
            for r in valid:
                alpha, cd, cl, cm, cn, ca = r[0], r[1], r[2], r[3], r[4], r[5]
                cna = cn / math.radians(alpha) if alpha else float("nan")
                cma = (cm - zero[3]) / math.radians(alpha) if alpha and zero else float("nan")
                fh.write("%.3f,%.2f,%.5f,%.5f,%.5f,%.5f,%.5f,%.4f,%.4f,"
                         "%.5f,%.5f,%.5f\n"
                         % (mach, alpha, cd, cl, cm, cn, ca, cna, cma,
                            r[9], r[10], r[11]))
            sec = [r for r in valid if r[0] == 4.0]
            if zero is not None and sec:
                summary.append((mach, zero[1], sec[0][4], sec[0][3], sec[0][5]))
            # Calibration values used by config.py: 4 deg secant slopes (the
            # small-angle operating point) and the induced-drag factor.
            pts = [r for r in valid if 0.0 < r[0] <= 8.0]
            if zero is not None and sec:
                ks = [(r[1] - zero[1]) / (r[4] ** 2) for r in pts if abs(r[4]) > 0.2]
                summary_mach.append(mach)
                fit_cna.append(sec[0][4] / math.radians(4.0))
                fit_cma.append(sec[0][3] / math.radians(4.0))
                fit_cd0.append(zero[1])
                fit_k.append(float(np.mean(ks)) if ks else float("nan"))

    print("DATCOM table: %s  (%d Mach x %d alpha)"
          % (csv, len(blocks), len(blocks[0][1])))
    if gaps:
        print("No DATCOM method / non-finite at M = %s"
              % ", ".join("%.2f" % m for m in gaps))
    print(" M     CD0    CN(4)  CM(4)   CN_a/rad  CM_a/rad  margin_m")
    for mach, cd0, cn4, cm4, _ca in summary:
        cna = cn4 / math.radians(4.0)
        cma = cm4 / math.radians(4.0)
        margin = -cma * C.LENGTH / cna if cna else float("nan")
        print("%4.2f  %6.4f  %6.3f %7.4f  %8.2f  %8.2f  %8.2f"
              % (mach, cd0, cn4, cm4, cna, cma, margin))

    # Paste-ready calibration (M values that DATCOM actually solved); the
    # transonic bridge in config.py fills the NDM band between them.
    print("\n# fitted from %s" % os.path.basename(csv))
    print("MACH  =", [round(m, 2) for m in summary_mach])
    print("CN_A  =", [round(v, 2) for v in fit_cna])
    print("CM_A  =", [round(v, 3) for v in fit_cma])
    print("CD0   =", [round(v, 3) for v in fit_cd0])
    print("K     =", [round(v, 3) for v in fit_k])
    print("\n# lateral at alpha = 0 (per deg): CYB, CNB, CLB")
    for mach, rows in blocks:
        zero = next((r for r in rows if r[0] == 0.0), None)
        if zero is not None and np.isfinite(zero[10]):
            print("  M=%4.2f  CYB=%7.4f  CNB=%7.4f  CLB=%7.4f"
                  % (mach, zero[9], zero[10], zero[11]))
    print("# note: CNB is positive (yaw-unstable) for this cruciform at "
          "M = 2..4,\n#       so the simulation keeps its conservative "
          "lateral derivatives.")
    return csv


if __name__ == "__main__":
    main()
