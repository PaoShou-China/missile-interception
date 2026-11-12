"""Aerodynamic anchor regression tests.

Locks in the DATCOM calibration values for M<=5 and their continuity with the
M>5 modified-Newton model, so later changes cannot drift.
Ref: tools/datcom_aero.py -> output/datcom_aero.csv (USAF Digital DATCOM).
"""

import numpy as np
import pytest

import config as C
from vehicle.missile import (
    Missile, cn_alpha, cd0, static_margin, cm_de,
    friction_delta, cm_gain, fin_lever,
)

DEG = np.pi / 180.0


def _coeff(mach, alpha_deg):
    m = Missile()
    return m.aero_coefficients(float(mach), alpha_deg * DEG, 0.0,
                               np.zeros(4), cg=C.CG_FULL)


@pytest.mark.parametrize("mach,cn,cm,cd", [
    (2.0, 0.900, -0.0873, 0.349),
    (3.0, 0.911, -0.1085, 0.265),
    (5.0, 0.684, -0.0550, 0.182),
])
def test_datcom_anchor_at_four_degrees(mach, cn, cm, cd):
    """At M=2/3/5 and alpha=4 deg the DATCOM CN/CM/CD values must be reproduced."""
    c = _coeff(mach, 4.0)
    cd_model = c["CA"] * np.cos(4 * DEG) + c["CN"] * np.sin(4 * DEG)
    assert c["CN"] == pytest.approx(cn, rel=0.02)
    assert c["CM"] == pytest.approx(cm, rel=0.03)
    assert cd_model == pytest.approx(cd, rel=0.03)


def test_cn_alpha_table_and_hypersonic_continuity():
    """The M<=5 table values and the M>5 shock-expansion trend must be continuous
    and monotonically decreasing."""
    assert cn_alpha(2.0) == pytest.approx(12.89, rel=0.02)
    assert cn_alpha(5.0) == pytest.approx(9.80, rel=0.02)
    assert cn_alpha(5.0 + 1e-6) == pytest.approx(cn_alpha(5.0), rel=1e-4)
    assert cn_alpha(8.0) == pytest.approx(5.940, rel=0.02)
    assert cn_alpha(10.0) < cn_alpha(8.0) < cn_alpha(5.0) < cn_alpha(3.0)


def test_transonic_bridge_is_conservative():
    """Inside the transonic bridge band the lift is revised down and the drag up."""
    m = 1.05
    nominal = np.interp(m, C.AERO_MACH, C.AERO_CN_ALPHA)
    assert cn_alpha(m) < nominal
    nominal_cd = np.interp(m, C.AERO_MACH, C.AERO_CD0)
    assert cd0(m) > nominal_cd


def test_static_margin_and_control_authority():
    """The static stability margin is positive; control effectiveness and lever arm
    follow from the geometry."""
    assert 0.3 < static_margin(2.0) < 0.8
    assert static_margin(2.0, cg=C.CG_DRY) > static_margin(2.0)
    assert fin_lever() > 0.5
    assert -1.6 < cm_de(2.0) < -1.0


def test_high_alpha_moment_gain():
    """The high-alpha moment gain only engages at large angles of attack."""
    assert cm_gain(5.0, 4 * DEG) == pytest.approx(1.0)
    assert cm_gain(2.0, 20 * DEG) > 1.5


def test_friction_grows_with_altitude():
    """Higher altitude -> lower Reynolds number -> larger friction CD0 increment."""
    assert friction_delta(0.0, 1500.0) == pytest.approx(0.0, abs=1e-6)
    assert friction_delta(25000.0, 1500.0) > friction_delta(10000.0, 1500.0) > 0.0


def test_lift_to_drag_band():
    """The M=5 maximum L/D must match the DATCOM table (about 3.8 at 4 deg, peak ~5)."""
    m = Missile()
    best = 0.0
    for a in np.linspace(0.5, 20.0, 60):
        c = m.aero_coefficients(5.0, a * DEG, 0.0, np.zeros(4), cg=C.CG_FULL)
        cl = c["CN"] * np.cos(a * DEG) - c["CA"] * np.sin(a * DEG)
        cd = c["CA"] * np.cos(a * DEG) + c["CN"] * np.sin(a * DEG)
        best = max(best, cl / max(cd, 1e-6))
    c4 = m.aero_coefficients(5.0, 4 * DEG, 0.0, np.zeros(4), cg=C.CG_FULL)
    ld4 = (c4["CN"] * np.cos(4 * DEG) - c4["CA"] * np.sin(4 * DEG)) / (
        c4["CA"] * np.cos(4 * DEG) + c4["CN"] * np.sin(4 * DEG))
    assert 3.5 < ld4 < 3.9
    assert 4.4 < best < 5.0
