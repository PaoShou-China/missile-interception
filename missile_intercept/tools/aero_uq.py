"""Aerodynamic uncertainty quantification for the DATCOM-calibrated model.

Perturbs the calibrated inputs (CN_alpha, CM_alpha, CD0 scales and the CG
station) and reports the resulting spread of the handling quantities that
matter for guidance: static margin, fin authority, trim deflection at 5 g and
the lift-to-drag ratio.  No simulation is run; this is a fast sensitivity
study on top of the calibrated tables.

Usage:
    python tools/aero_uq.py [samples]
"""

import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C  # noqa: E402
from vehicle.missile import fin_lever, induced_k  # noqa: E402

RNG = np.random.default_rng(2026)
MACH = 5.0
ALPHA = 4.0 * C.DEG
Q_DYN = 100000.0
LOAD_G = 5.0


def _interp(mach, table):
    return float(np.interp(mach, C.AERO_MACH, table))


def sample(n):
    # 10 % one-sigma on the coefficients, 0.05 m one-sigma on the CG.
    cn_scale = RNG.normal(1.0, 0.10, n)
    cm_scale = RNG.normal(1.0, 0.10, n)
    cd_scale = RNG.normal(1.0, 0.10, n)
    cg = RNG.normal(C.CG_FULL, 0.05, n)

    cn_a = cn_scale * _interp(MACH, C.AERO_CN_ALPHA)
    cm_a = cm_scale * _interp(MACH, C.AERO_CM_ALPHA)
    cd0 = cd_scale * _interp(MACH, C.AERO_CD0)
    margin = -cm_a * C.LENGTH / cn_a + (C.CG_FULL - cg)
    cm_de = -(cn_a - C.CN_ALPHA_BODY) * fin_lever() / C.LENGTH

    # Trim angle for a 5 g demand, then the fin needed to hold it.
    mass = C.MASS0
    cn_req = LOAD_G * mass * C.G0 / (Q_DYN * C.S_REF)
    alpha_req = np.clip(cn_req / cn_a, 0.0, 30.0 * C.DEG)
    delta_trim = np.abs(cm_a) * alpha_req / np.maximum(np.abs(cm_de), 1e-6)

    cn = cn_a * ALPHA
    cd = cd0 + induced_k(MACH) * cn * cn
    ld = (cn * np.cos(ALPHA) - cd * np.sin(ALPHA)) / \
        np.maximum(cd * np.cos(ALPHA) + cn * np.sin(ALPHA), 1e-6)

    return {
        "static margin [m]": margin,
        "fin authority [1/rad]": np.abs(cm_de),
        "trim fin at 5 g [deg]": np.degrees(delta_trim),
        "L/D at 4 deg": ld,
    }


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    data = sample(n)
    print("Aero UQ: N=%d, M=%.1f, q=%.0f kPa, Gaussian 10%% coefficient / 0.05 m CG"
          % (n, MACH, Q_DYN / 1e3))
    print("%-26s %8s %8s %8s" % ("quantity", "P5", "P50", "P95"))
    for name, values in data.items():
        lo, mid, hi = np.percentile(values, [5, 50, 95])
        print("%-26s %8.3f %8.3f %8.3f" % (name, lo, mid, hi))
    return data


if __name__ == "__main__":
    main()
