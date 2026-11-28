"""Directed fragmentation warhead and radio/laser proximity fuze lethality model.

Computes physical encounter kill probability P_k from the 3D closest-approach
miss vector, relative closing velocity, missile body attitude, optimal
proximity-fuze initiation lead time (2-5 ms), annular fragment beam geometry,
and target vulnerable presented area.
"""

import math
import numpy as np
import config as C
import math_utils as MU


def proximity_fuze_lethality(r_m, v_m, q_m, r_t, v_t):
    """Evaluate 3D directed-fragmentation proximity fuze lethality.

    Parameters
    ----------
    r_m, v_m : (3,) missile ECI position (m) and velocity (m/s)
    q_m : (4,) missile body-to-ECI quaternion (scalar-first)
    r_t, v_t : (3,) target ECI position (m) and velocity (m/s)

    Returns
    -------
    dict
        miss_m, closing_speed_ms, tau_fuze_ms, standoff_m, spray_angle_deg,
        frag_density_m2, expected_hits, pk_fuze, pk_carleton
    """
    r_m = np.asarray(r_m, dtype=float).reshape(3)
    v_m = np.asarray(v_m, dtype=float).reshape(3)
    r_t = np.asarray(r_t, dtype=float).reshape(3)
    v_t = np.asarray(v_t, dtype=float).reshape(3)

    rho = r_t - r_m
    miss_m = float(MU.norm3(rho))
    v_rel = v_m - v_t
    vc = max(float(MU.norm3(v_rel)), 100.0)

    # Optimal initiation lead time so the radially expanding fragment sheet
    # reaches radial distance miss_m right as the missile passes PCA.
    v_frag = float(C.FUZE_FRAG_SPEED)
    tau_ideal = miss_m / max(v_frag, 1.0)
    tau_fuze = float(min(max(tau_ideal, C.FUZE_DELAY_MIN), C.FUZE_DELAY_MAX))
    standoff_m = vc * tau_fuze

    # Dynamic forward-thrown fragment spray angle relative to relative velocity.
    spray_angle_rad = math.atan2(v_frag, vc)

    # Alignment penalty if missile body axis has large incidence vs relative track.
    body_x = MU.quat_rotate(np.asarray(q_m, dtype=float).reshape(4),
                            np.array([1.0, 0.0, 0.0]))
    v_rel_hat = v_rel / vc
    cos_align = abs(float(np.dot(body_x, v_rel_hat)))
    align_factor = 0.70 + 0.30 * min(max(cos_align, 0.0), 1.0)

    # Fragment ring geometry at crossing radius.
    r_ring = max(miss_m, 0.75)
    w_ring = 2.0 * r_ring * math.tan(C.FUZE_SPRAY_HALF_ANGLE)
    area_ring = max(2.0 * math.pi * r_ring * w_ring, 2.0)

    # Axial timing overlap when ideal lead falls outside the [2, 5] ms fuze gate.
    dt_err = abs(tau_fuze - tau_ideal)
    dx_axial = vc * dt_err
    sigma_axial = 0.5 * w_ring + 0.30 * C.TARGET_LENGTH
    eta_axial = math.exp(-0.5 * (dx_axial / max(sigma_axial, 0.5)) ** 2)

    # Aerodynamic fragment velocity decay with stand-off radius.
    drag_decay = math.exp(-miss_m / max(C.FUZE_DRAG_DECAY_M, 1.0))

    frag_density = (C.FUZE_N_FRAGS / area_ring) * eta_axial * align_factor
    expected_hits = frag_density * C.FUZE_VULN_AREA * drag_decay

    # Direct hit-to-kill kinetic regime inside airframe half-fuselage radius.
    if miss_m < 1.8:
        pk_fuze = 0.995
    else:
        pk_fuze = 1.0 - math.exp(-C.FUZE_SINGLE_HIT_PK * expected_hits)
        pk_fuze = float(min(max(pk_fuze, 0.0), 0.995))

    # Reference Carleton Gaussian damage law (sigma_L = 8.5 m).
    sigma_l = 8.5
    pk_carleton = float(math.exp(-(miss_m * miss_m) / (2.0 * sigma_l * sigma_l)))

    return {
        "miss_m": miss_m,
        "closing_speed_ms": vc,
        "tau_fuze_ms": tau_fuze * 1000.0,
        "standoff_m": standoff_m,
        "spray_angle_deg": math.degrees(spray_angle_rad),
        "frag_density_m2": frag_density,
        "expected_hits": expected_hits,
        "pk_fuze": pk_fuze,
        "pk_carleton": pk_carleton,
    }
