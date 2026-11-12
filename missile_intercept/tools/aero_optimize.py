"""Aero configuration screening with the Digital DATCOM executable.

Runs a small design of experiments over the exposed fin planform and reports
the quantities that decide the interceptor's drag budget:

    CN_alpha, CM_alpha, CD0 (M = 2/3/5), L/D at the lift needed for level
    flight, static margin, and the fin deflection required to trim it.

Usage:
    python tools/aero_optimize.py
"""

import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import config as C  # noqa: E402
import datcom_aero as DA  # noqa: E402

Q_REF = 100000.0
MASS = C.MASS0
LOAD_G = 5.0


def run_case(root_chord, tip_chord, span, tovc=0.05):
    """Run DATCOM for one planform; return metrics at M = 2/3/5."""
    old = (C.ROOT_CHORD, C.TIP_CHORD, C.WING_SPAN)
    C.ROOT_CHORD, C.TIP_CHORD, C.WING_SPAN = root_chord, tip_chord, span
    try:
        deck = DA.build_deck().replace("TOVC=0.05", "TOVC=%.3f" % tovc)
        run_dir = os.path.join(tempfile.gettempdir(), "mdopt")
        if os.path.isdir(run_dir):
            shutil.rmtree(run_dir)
        os.makedirs(run_dir)
        with open(os.path.join(run_dir, "m.inp"), "w", encoding="ascii") as fh:
            fh.write(deck)
        subprocess.run([os.path.join(ROOT, "tools", "datcom", "datcom.exe"),
                        "m.inp"], cwd=run_dir, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        blocks = DA.parse_output(os.path.join(run_dir, "output.dat"))
    finally:
        C.ROOT_CHORD, C.TIP_CHORD, C.WING_SPAN = old

    out = {}
    for mach, rows in blocks:
        zero = next((r for r in rows if r[0] == 0.0), None)
        four = next((r for r in rows if r[0] == 4.0), None)
        if zero is None or four is None or not np.isfinite(four[4]):
            continue
        cn4, cm4, cd4 = four[4], four[3], four[1]
        cn_a = cn4 / math.radians(4.0)
        cm_a = cm4 / math.radians(4.0)
        out[mach] = dict(cn_a=cn_a, cm_a=cm_a, cd0=zero[1], cd4=cd4)
    return out


def metrics(case, root_chord, tip_chord, span):
    cr, ct, b = root_chord, tip_chord, span
    mac = (2.0 / 3.0) * (cr + ct - cr * ct / (cr + ct))
    y_mac = (b / 3.0) * (cr + 2.0 * ct) / (cr + ct)
    sweep = math.atan((cr - ct) / (b + 0.5 * C.DIAMETER))
    lever = (C.LENGTH - cr) + y_mac * math.tan(sweep) + 0.25 * mac - C.CG_FULL
    rows = {}
    for mach in (2.0, 3.0, 5.0):
        if mach not in case:
            continue
        v = case[mach]
        cn_req = LOAD_G * MASS * C.G0 / (Q_REF * C.S_REF)
        alpha = cn_req / max(v["cn_a"], 1e-6)
        cn = v["cn_a"] * alpha
        cd = v["cd0"] + 0.06 * cn * cn
        margin = -v["cm_a"] * C.LENGTH / v["cn_a"]
        cm_de = (v["cn_a"] - C.CN_ALPHA_BODY) * lever / C.LENGTH
        delta = abs(v["cm_a"]) * alpha / max(abs(cm_de), 1e-6)
        rows[mach] = dict(ld=cn / max(cd, 1e-6), margin=margin,
                          alpha=math.degrees(alpha), delta=math.degrees(delta),
                          cd0=v["cd0"], cn_a=v["cn_a"])
    return rows


def main():
    print("baseline geometry: root %.2f tip %.2f span %.2f m"
          % (C.ROOT_CHORD, C.TIP_CHORD, C.WING_SPAN))
    print("\n%-22s %6s %6s %6s %7s %7s %7s %7s"
          % ("case", "M", "CNa", "CD0", "L/D", "margin", "alpha", "delta"))
    candidates = []
    for scale in (1.00, 0.85, 0.70, 0.55):
        for span_s in (1.0, 1.25):
            candidates.append(("chord x%.2f span x%.2f" % (scale, span_s),
                               C.ROOT_CHORD * scale, C.TIP_CHORD * scale,
                               C.WING_SPAN * span_s, 0.05))
    candidates.append(("thin t/c 3%", C.ROOT_CHORD, C.TIP_CHORD,
                       C.WING_SPAN, 0.03))

    best = None
    for name, cr, ct, b, tovc in candidates:
        case = run_case(cr, ct, b, tovc)
        if not case:
            print("%-22s  no DATCOM result" % name)
            continue
        m5 = metrics(case, cr, ct, b).get(5.0)
        if m5 is None:
            continue
        print("%-22s %6.1f %6.2f %6.3f %7.2f %7.3f %7.1f %7.1f"
              % (name, 5.0, m5["cn_a"], m5["cd0"], m5["ld"], m5["margin"],
                 m5["alpha"], m5["delta"]))
        score = m5["ld"]
        if 0.25 <= m5["margin"] <= 0.75 and m5["delta"] <= 20.0:
            if best is None or score > best[0]:
                best = (score, name, cr, ct, b, tovc)
    if best:
        print("\nrecommended: %s (L/D %.2f at M=5, 5 g trim)" % (best[1], best[0]))
        print("  ROOT_CHORD=%.2f  TIP_CHORD=%.2f  WING_SPAN=%.2f  t/c=%.2f"
              % (best[2], best[3], best[4], best[5]))


if __name__ == "__main__":
    main()
