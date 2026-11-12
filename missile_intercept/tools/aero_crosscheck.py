"""Cross-validation of the interceptor aerodynamic model against public data.

Three independent checks are run:

1. Component benchmarks against classical public theory
   - slender-body normal-force slope (Allen & Perkins, NACA Rep. 1048)
   - finite-wing lift slope (Helmbold/Diederich)
   - turbulent flat-plate friction (Prandtl-Schlichting log law)

2. Hypersonic pressure law against exact oblique-shock / Prandtl-Meyer
   shock-expansion for a wedge (inviscid, public theory).

3. Code-to-code: the embedded M <= 5 table must equal the Digital DATCOM
   output in output/datcom_aero.csv (the run is reproducible with
   tools/datcom_aero.py).

Wind-tunnel sources used for the qualitative trend checks are listed at the
end; their data are published as scanned figures, so they are not digitised
here.

Usage:
    python tools/aero_crosscheck.py
"""

import csv
import math
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config as C  # noqa: E402
from vehicle.missile import Missile, cp_max  # noqa: E402

GAMMA = 1.4


# ------------------------------------------------------------
# Exact inviscid relations
# ------------------------------------------------------------
def oblique_shock_cp(mach, theta):
    """Cp behind an oblique shock for a wedge of inclination theta (rad)."""
    if theta <= 1e-6:
        return 0.0
    beta_lo = math.asin(min(1.0 / mach, 1.0))
    beta_hi = math.pi * 0.5
    for _ in range(80):
        beta = 0.5 * (beta_lo + beta_hi)
        num = 2.0 / math.tan(beta) * (mach * mach * math.sin(beta) ** 2 - 1.0)
        den = mach * mach * (GAMMA + math.cos(2.0 * beta)) + 2.0
        if math.tan(theta) > num / den:
            beta_lo = beta
        else:
            beta_hi = beta
    beta = 0.5 * (beta_lo + beta_hi)
    p_ratio = 1.0 + 2.0 * GAMMA / (GAMMA + 1.0) * (
        mach * mach * math.sin(beta) ** 2 - 1.0)
    return 2.0 / (GAMMA * mach * mach) * (p_ratio - 1.0)


def _pm_nu(m):
    return math.sqrt((GAMMA + 1.0) / (GAMMA - 1.0)) * math.atan(
        math.sqrt((GAMMA - 1.0) / (GAMMA + 1.0) * (m * m - 1.0))) - math.atan(
        math.sqrt(m * m - 1.0))


def _pm_mach(nu):
    lo, hi = 1.0001, 30.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if _pm_nu(mid) < nu:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def expansion_cp(mach, theta):
    """Cp behind a Prandtl-Meyer expansion of angle theta (rad)."""
    if theta <= 1e-6:
        return 0.0
    m2 = _pm_mach(_pm_nu(mach) + theta)
    num = 1.0 + 0.5 * (GAMMA - 1.0) * mach * mach
    den = 1.0 + 0.5 * (GAMMA - 1.0) * m2 * m2
    p_ratio = (num / den) ** (GAMMA / (GAMMA - 1.0))
    return 2.0 / (GAMMA * mach * mach) * (p_ratio - 1.0)


# ------------------------------------------------------------
# Checks
# ------------------------------------------------------------
def check_slender_body():
    theory = 2.0
    model = C.CN_ALPHA_BODY
    return ("body CN_alpha", model, theory, abs(model - theory) / theory)


def check_lift_nonlinearity():
    """CN(8 deg)/CN(4 deg): > 2 means the lift line steepens with alpha.

    NACA RM A54H27 (cruciform missile, M = 2) reports exactly this trend for
    bodies and finned combinations above M = 3; linear theory would give 2.0.
    """
    m = Missile()
    rows = {}
    for mach in (2.0, 5.0):
        c4 = m.aero_coefficients(mach, 4.0 * C.DEG, 0.0, np.zeros(4))
        c8 = m.aero_coefficients(mach, 8.0 * C.DEG, 0.0, np.zeros(4))
        rows[mach] = c8["CN"] / max(c4["CN"], 1e-9)
    return rows


def check_newtonian():
    rows = []
    half = 10.0 * C.DEG
    for mach in (6.0, 8.0, 10.0):
        for alpha in (0.0, 5.0, 10.0):
            theta = half + alpha * C.DEG
            cp_shock = oblique_shock_cp(mach, theta)
            cp_newton = cp_max(mach) * math.sin(theta) ** 2
            err = abs(cp_newton - cp_shock) / cp_shock
            rows.append((mach, alpha, cp_shock, cp_newton, err))
    return rows


def check_friction():
    rows = []
    for re in (1e7, 1e8, 1e9):
        cf_model = 0.074 / re ** C.RE_EXPONENT
        cf_log = 0.455 / (math.log10(re) ** 2.58)
        rows.append((re, cf_model, cf_log, abs(cf_model - cf_log) / cf_log))
    return rows


def check_hypersonic_branch():
    """Reproduce the embedded M > 5 shock-expansion table from scratch."""
    cr, ct, b = C.ROOT_CHORD, C.TIP_CHORD, C.WING_SPAN
    sweep = math.atan((cr - ct) / (b + 0.5 * C.DIAMETER))
    cos_l = math.cos(sweep)
    ratio = C.S_PLANFORM / C.S_REF
    a = 1.0 * C.DEG

    def se_slope(mach):
        m_n = mach * cos_l
        a_n = math.atan(math.tan(a) / cos_l)
        cn_n = (oblique_shock_cp(m_n, a_n) - expansion_cp(m_n, a_n)) * math.cos(a_n)
        return cn_n * cos_l / a * ratio + C.CN_ALPHA_BODY

    eta = (C.AERO_HYP_CN_ALPHA[0] - C.CN_ALPHA_BODY) / (
        se_slope(5.0) - C.CN_ALPHA_BODY)
    worst = 0.0
    rows = []
    for mach, table in zip(C.AERO_HYP_MACH, C.AERO_HYP_CN_ALPHA):
        value = C.CN_ALPHA_BODY + eta * (se_slope(mach) - C.CN_ALPHA_BODY)
        worst = max(worst, abs(value - table) / table)
        rows.append((mach, table, value))
    return eta, rows, worst


def check_table_reproduction():
    """CN and CD must reproduce the DATCOM output (CM is checked at 4 deg).

    CM at small alpha is deliberately linear in the simulation (the DATCOM
    moment curve is convex from 0 deg), so only the 4 deg anchor is compared.
    """
    path = os.path.join(ROOT, "output", "datcom_aero.csv")
    if not os.path.isfile(path):
        return None
    m = Missile()
    with open(path, encoding="ascii") as fh:
        rows = list(csv.DictReader(fh))
    worst = 0.0
    n = 0
    cm_err = None
    for r in rows:
        if r["mach"] not in ("2.000", "3.000", "5.000"):
            continue
        a = float(r["alpha_deg"]) * C.DEG
        c = m.aero_coefficients(float(r["mach"]), a, 0.0, np.zeros(4),
                                cg=C.CG_FULL)
        cd = c["CA"] * math.cos(a) + c["CN"] * math.sin(a)
        for model, ref in ((c["CN"], float(r["CN"])), (cd, float(r["CD"]))):
            if abs(ref) > 1e-6:
                worst = max(worst, abs(model - ref) / abs(ref))
                n += 1
        if abs(float(r["alpha_deg"]) - 4.0) < 1e-6 and abs(float(r["CM"])) > 1e-6:
            cm_err = abs(c["CM"] - float(r["CM"])) / abs(float(r["CM"]))
    return worst, n, cm_err


def main():
    print("=" * 68)
    print("AERO CROSS-VALIDATION")
    print("=" * 68)

    name, model, theory, err = check_slender_body()
    print("\n[1] Classical component benchmark")
    print("  %-24s model %7.3f  theory %7.3f  err %5.1f%%"
          % (name, model, theory, 100 * err))
    for mach, ratio in check_lift_nonlinearity().items():
        print("  CN(8deg)/CN(4deg) M=%.0f  %.2f  (linear = 2.00, DATCOM > 2)"
              % (mach, ratio))

    print("\n[2] Newtonian vs exact shock-expansion, 10 deg wedge")
    print("   M   alpha   Cp_shock   Cp_newton    err")
    for mach, alpha, cp_s, cp_n, err in check_newtonian():
        print("  %4.1f %6.1f %10.4f %11.4f %6.1f%%"
              % (mach, alpha, cp_s, cp_n, 100 * err))

    print("\n[3] Turbulent friction: 0.074/Re^0.2 vs Prandtl-Schlichting")
    print("       Re        Cf_model    Cf_log    err")
    for re, cf_m, cf_l, err in check_friction():
        print("  %9.1e %10.5f %9.5f %6.1f%%" % (re, cf_m, cf_l, 100 * err))

    rep = check_table_reproduction()
    print("\n[4] Embedded table vs Digital DATCOM output")
    if rep is None:
        print("  output/datcom_aero.csv missing - run tools/datcom_aero.py")
    else:
        worst, n, cm_err = rep
        print("  CN/CD: %d points (M=2/3/5, alpha=0..24 deg), max dev %.2f%%"
              % (n, 100 * worst))
        if cm_err is not None:
            print("  CM at 4 deg: %.2f%%" % (100 * cm_err))

    eta, rows, worst = check_hypersonic_branch()
    print("\n[5] M > 5 shock-expansion table (eta = %.3f)" % eta)
    print("   M    table   recomputed   err")
    for mach, table, value in rows:
        print("  %4.0f %8.3f %10.3f %6.2f%%"
              % (mach, table, value, 100 * abs(value - table) / table))
    print("  max reproduction error %.3f%%" % (100 * worst))

    print("\nSources")
    print("  Allen & Perkins, NACA Report 1048 (1951): slender-body slope 2/rad")
    print("  Helmbold/Diederich finite-wing lift slope (NACA wartime reports)")
    print("  Oblique-shock and Prandtl-Meyer relations (NACA Rep. 1135)")
    print("  Prandtl-Schlichting turbulent friction (Schlichting, Boundary Layer Theory)")
    print("  USAF Digital DATCOM, AFFDL-TR-79-3032 (tools/datcom_aero.py)")
    print("  NACA RM A54H27 (1954): cruciform missile, M=2 wind tunnel")
    print("  Sooy & Schmidt, J. Spacecraft & Rockets 42(2), 2005: DATCOM/AP98")
    print("    validation band (normal force minimal error, axial force larger)")


if __name__ == "__main__":
    main()
