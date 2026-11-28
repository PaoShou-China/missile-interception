"""Numba-compiled numeric core for the 6DOF interceptor and target.

The functions here are the hot-path equivalent of ``vehicle.missile`` and
``vehicle.target``.  They are compiled with ``numba.njit`` when Numba is
available and fall back to plain Python otherwise, so the simulation always
runs.  Calling code keeps the original class API; only the inner ODE
evaluation is redirected here.

Only scalars and numpy arrays cross the JIT boundary; no Python objects,
dataclasses or dict are passed, which keeps the compiled call cheap.

Ref: numba nopython mode, fixed-step RK4 RHS (see integrator.py).
"""

import math
import numpy as np

import config as C
from vehicle.atmosphere import (
    _LAYERS, _BASE_PRESSURE, _TABLE_TOP, _H_SCALE, _T86, _P86, _RHO86,
)


def _configure_numba_cache():
    """Point Numba's disk cache at a directory keyed by tunable inputs.

    ``@njit(cache=True)`` hashes only the function source, not the module
    constants read from ``config``.  Without this, editing an aerodynamic or
    propulsion constant would silently reuse the previously compiled kernel.
    """
    try:
        import hashlib
        import os
        import pathlib

        root = pathlib.Path(__file__).resolve().parent
        digest = hashlib.sha256()
        for rel in ("config.py", "fastcore.py",
                    "vehicle/atmosphere.py", "vehicle/missile.py"):
            digest.update((root / rel).read_bytes())
        cache_dir = root / "__pycache__" / ("numba_" + digest.hexdigest()[:12])
        os.environ["NUMBA_CACHE_DIR"] = str(cache_dir)
    except Exception:  # noqa: BLE001 - cache hints must never break imports
        pass


_configure_numba_cache()

# Numba availability is probed by actually compiling a trivial kernel instead
# of comparing NumPy versions: recent Numba releases do support NumPy 2.x, so
# a version test would needlessly disable the compiled core on a valid setup.
try:  # pragma: no cover - environment dependent
    from numba import njit

    def _probe(x):
        return x + 1.0

    njit(_probe)(1.0)
    NUMBA_AVAILABLE = True
except Exception:  # noqa: BLE001
    NUMBA_AVAILABLE = False

    def njit(*args, **kwargs):
        """Identity decorator used when Numba is not available."""
        if args and callable(args[0]):
            return args[0]

        def _deco(func):
            return func
        return _deco


# ============================================================
# Atmosphere (USSA1976, identical to vehicle.atmosphere)
# ============================================================
_HB = [float(layer[0]) for layer in _LAYERS]
_TB = [float(layer[1]) for layer in _LAYERS]
_LR = [float(layer[2]) for layer in _LAYERS]
_PB = [float(p) for p in _BASE_PRESSURE]

_H1, _H2, _H3 = _HB[1], _HB[2], _HB[3]
_H4, _H5, _H6, _H7 = _HB[4], _HB[5], _HB[6], _HB[7]
_TB0, _TB1, _TB2, _TB3 = _TB[0], _TB[1], _TB[2], _TB[3]
_TB4, _TB5, _TB6, _TB7 = _TB[4], _TB[5], _TB[6], _TB[7]
_LR0, _LR1, _LR2, _LR3 = _LR[0], _LR[1], _LR[2], _LR[3]
_LR4, _LR5, _LR6, _LR7 = _LR[4], _LR[5], _LR[6], _LR[7]
_PB0, _PB1, _PB2, _PB3 = _PB[0], _PB[1], _PB[2], _PB[3]
_PB4, _PB5, _PB6, _PB7 = _PB[4], _PB[5], _PB[6], _PB[7]

_G0 = C.G0
_R_AIR = C.R_AIR
_GAMMA_AIR = C.GAMMA_AIR


@njit(cache=True)
def atmosphere(alt):
    """Return ``(temperature, pressure, density, sound_speed)``."""
    h = alt
    if h < 0.0:
        h = 0.0
    elif h > 200000.0:
        h = 200000.0

    if h <= _TABLE_TOP:
        if h < _H1:
            hb, tb, lapse, pb = 0.0, _TB0, _LR0, _PB0
        elif h < _H2:
            hb, tb, lapse, pb = _H1, _TB1, _LR1, _PB1
        elif h < _H3:
            hb, tb, lapse, pb = _H2, _TB2, _LR2, _PB2
        elif h < _H4:
            hb, tb, lapse, pb = _H3, _TB3, _LR3, _PB3
        elif h < _H5:
            hb, tb, lapse, pb = _H4, _TB4, _LR4, _PB4
        elif h < _H6:
            hb, tb, lapse, pb = _H5, _TB5, _LR5, _PB5
        elif h < _H7:
            hb, tb, lapse, pb = _H6, _TB6, _LR6, _PB6
        else:
            hb, tb, lapse, pb = _H7, _TB7, _LR7, _PB7

        dh = h - hb
        if abs(lapse) < 1e-12:
            t = tb
            p = pb * math.exp(-_G0 * dh / (_R_AIR * tb))
        else:
            t = tb + lapse * dh
            p = pb * (t / tb) ** (-_G0 / (_R_AIR * lapse))
        rho = p / (_R_AIR * max(t, 1.0))
    else:
        t = _T86
        decay = math.exp(-(h - _TABLE_TOP) / _H_SCALE)
        p = _P86 * decay
        rho = _RHO86 * decay

    a = math.sqrt(_GAMMA_AIR * _R_AIR * t)
    return t, p, rho, a


@njit(cache=True)
def geodetic_alt(rx, ry, rz):
    """Geodetic altitude (Bowring) or spherical fallback."""
    if C.EARTH_MODEL_CODE == 0:
        return math.sqrt(rx * rx + ry * ry + rz * rz) - C.RE
    p = math.sqrt(rx * rx + ry * ry)
    if p < 1e-9:
        return abs(rz) - C.WGS84_B
    a = C.WGS84_A
    b = C.WGS84_B
    e2 = C.WGS84_E2
    ep2 = (a * a - b * b) / (b * b)
    th = math.atan2(rz * a, p * b)
    st = math.sin(th)
    ct = math.cos(th)
    phi = math.atan2(rz + ep2 * b * st * st * st,
                     p - e2 * a * ct * ct * ct)
    n = a / math.sqrt(1.0 - e2 * math.sin(phi) ** 2)
    return p / math.cos(phi) - n


@njit(cache=True)
def geodetic_up(rx, ry, rz):
    """Unit local vertical (ellipsoid normal) in ECI; radial in sphere mode.

    Must match ``math_utils.local_up`` exactly so the compiled target model
    and the Python reference fly the same "level" reference.
    """
    if C.EARTH_MODEL_CODE == 0:
        rn = math.sqrt(rx * rx + ry * ry + rz * rz)
        if rn < 1e-12:
            rn = 1e-12
        return rx / rn, ry / rn, rz / rn
    p = math.sqrt(rx * rx + ry * ry)
    a = C.WGS84_A
    b = C.WGS84_B
    e2 = C.WGS84_E2
    if p < 1e-9:
        if rz >= 0.0:
            lat = 0.5 * math.pi
        else:
            lat = -0.5 * math.pi
    else:
        ep2 = (a * a - b * b) / (b * b)
        th = math.atan2(rz * a, p * b)
        st = math.sin(th)
        ct = math.cos(th)
        lat = math.atan2(rz + ep2 * b * st * st * st, p - e2 * a * ct * ct * ct)
    lon = math.atan2(ry, rx)
    cl = math.cos(lat)
    return cl * math.cos(lon), cl * math.sin(lon), math.sin(lat)


@njit(cache=True, nogil=True)
def gravity_xyz(rx, ry, rz):
    """Scalar ECI gravity acceleration (central + optional J2), zero allocation."""
    r2 = rx * rx + ry * ry + rz * rz
    rad = math.sqrt(r2)
    if rad < 1e-12:
        rad = 1e-12
    r3 = rad * rad * rad
    gx = -C.MU * rx / r3
    gy = -C.MU * ry / r3
    gz = -C.MU * rz / r3
    if C.EARTH_MODEL_CODE != 0:
        z2 = rz * rz
        r5 = r3 * r2
        k = -1.5 * C.J2 * C.MU * C.WGS84_A * C.WGS84_A / r5
        zf = 5.0 * z2 / r2
        gx += k * rx * (1.0 - zf)
        gy += k * ry * (1.0 - zf)
        gz += k * rz * (3.0 - zf)
    return gx, gy, gz


@njit(cache=True, nogil=True)
def gravity_accel(rx, ry, rz):
    """ECI gravity acceleration (central + optional J2), m/s^2."""
    gx, gy, gz = gravity_xyz(rx, ry, rz)
    out = np.empty(3)
    out[0] = gx
    out[1] = gy
    out[2] = gz
    return out


# ============================================================
# Aerodynamic coefficient trends
# ============================================================
@njit(cache=True)
def cp_max(mach):
    """Modified-Newtonian stagnation pressure coefficient Cp_max(M)."""
    g = C.GAMMA_AIR - C.GAMMA_HYP_DROP * min(max((mach - 5.0) / 5.0, 0.0), 1.0)
    m2 = max(mach * mach, 1.0)
    p02 = ((g + 1.0) ** 2 * m2 / (4.0 * g * m2 - 2.0 * (g - 1.0))) ** (g / (g - 1.0))
    p02 *= (1.0 - g + 2.0 * g * m2) / (g + 1.0)
    return 2.0 / (g * m2) * (p02 - 1.0)


@njit(cache=True)
def _table(m, xs, ys):
    """Linear interpolation of a Mach-indexed table (DATCOM anchors)."""
    n = xs.shape[0]
    if m <= xs[0]:
        return ys[0]
    if m >= xs[n - 1]:
        return ys[n - 1]
    for i in range(1, n):
        if m <= xs[i]:
            w = (m - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + w * (ys[i] - ys[i - 1])
    return ys[n - 1]


@njit(cache=True)
def _bridge_bump(mach):
    if mach <= C.AERO_BRIDGE_LO or mach >= C.AERO_BRIDGE_HI:
        return 0.0
    w = (mach - C.AERO_BRIDGE_LO) / (C.AERO_BRIDGE_HI - C.AERO_BRIDGE_LO)
    return 4.0 * w * (1.0 - w)


@njit(cache=True)
def cn_alpha(mach):
    if mach <= 5.0:
        base = _table(mach, C.AERO_MACH, C.AERO_CN_ALPHA)
        return base * (1.0 - C.AERO_BRIDGE_CN_DERATE * _bridge_bump(mach))
    return _table(mach, C.AERO_HYP_MACH, C.AERO_HYP_CN_ALPHA)


@njit(cache=True)
def static_margin(mach, cg):
    """Aerodynamic-centre offset from the current CG, m (positive = stable)."""
    m = min(mach, 5.0)
    cna = _table(m, C.AERO_MACH, C.AERO_CN_ALPHA)
    cma = _table(m, C.AERO_MACH, C.AERO_CM_ALPHA)
    margin = -cma * C.LENGTH / cna
    if mach > 5.0:
        shift = C.AERO_HYP_CP_SHIFT_MAX * min((mach - 5.0) / 5.0, 1.0)
        margin = max(margin - shift, 0.25)
    return margin + (C.CG_FULL - cg)


@njit(cache=True)
def cn_shape(alpha):
    """Crossflow lift-line shape factor from the DATCOM CN/alpha fit."""
    a = abs(alpha) / C.DEG
    xs = C.AERO_ALPHA_DEG
    ys = C.AERO_CN_SHAPE
    n = xs.shape[0]
    if a <= xs[0]:
        return ys[0]
    if a >= xs[n - 1]:
        return ys[n - 1]
    for i in range(1, n):
        if a <= xs[i]:
            w = (a - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + w * (ys[i] - ys[i - 1])
    return ys[n - 1]


@njit(cache=True)
def k_shape(alpha):
    """Large-angle efficiency factor on the induced-drag factor."""
    a = abs(alpha) / C.DEG
    xs = C.AERO_ALPHA_DEG
    ys = C.AERO_K_SHAPE
    n = xs.shape[0]
    if a <= xs[0]:
        return ys[0]
    if a >= xs[n - 1]:
        return ys[n - 1]
    for i in range(1, n):
        if a <= xs[i]:
            w = (a - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + w * (ys[i] - ys[i - 1])
    return ys[n - 1]


@njit(cache=True)
def induced_k(mach):
    if mach <= 5.0:
        return _table(mach, C.AERO_MACH, C.AERO_INDUCED_K)
    ratio = C.AERO_HYP_CN_ALPHA[0] / max(cn_alpha(mach), 2.5)
    if ratio > 1.45:
        ratio = 1.45
    return C.AERO_INDUCED_K[-1] * ratio


@njit(cache=True)
def fin_slope_ratio(mach):
    return (cn_alpha(mach) - C.CN_ALPHA_BODY) / (10.17 - C.CN_ALPHA_BODY)


@njit(cache=True)
def boost_thrust_scale(t):
    """Normalised sea-level thrust profile (piecewise linear)."""
    tn = t / C.BOOST_BURN_TIME
    if tn <= C.BOOST_THRUST_T[0]:
        return C.BOOST_THRUST_F[0]
    n = C.BOOST_THRUST_T.shape[0]
    for i in range(1, n):
        if tn <= C.BOOST_THRUST_T[i]:
            t0 = C.BOOST_THRUST_T[i - 1]
            t1 = C.BOOST_THRUST_T[i]
            w = (tn - t0) / max(t1 - t0, 1e-12)
            return C.BOOST_THRUST_F[i - 1] + w * (
                C.BOOST_THRUST_F[i] - C.BOOST_THRUST_F[i - 1])
    return C.BOOST_THRUST_F[n - 1]


@njit(cache=True)
def ramjet_efficiency(mach, altitude):
    """Air-breathing efficiency factors ``(eta_mach, eta_alt)``."""
    if mach <= C.RAMJET_MACH_REF:
        eta_m = 1.0
    else:
        eta_m = max(1.0 - C.RAMJET_MACH_DECAY * (mach - C.RAMJET_MACH_REF),
                    C.RAMJET_ETA_MIN)
    if altitude <= C.RAMJET_ALT_FULL:
        eta_h = 1.0
    elif altitude >= C.RAMJET_ALT_CUTOFF:
        eta_h = 0.0
    else:
        eta_h = 1.0 - (altitude - C.RAMJET_ALT_FULL) / (
            C.RAMJET_ALT_CUTOFF - C.RAMJET_ALT_FULL)
    return eta_m, eta_h


@njit(cache=True)
def cd0(mach):
    if mach <= 5.0:
        base = _table(mach, C.AERO_MACH, C.AERO_CD0)
        return base * (1.0 + C.AERO_BRIDGE_CD_MARGIN * _bridge_bump(mach))
    return C.AERO_CD0[-1] * cp_max(mach) / cp_max(5.0)


@njit(cache=True)
def cm_gain(mach, alpha):
    """Extra high-alpha moment growth measured from DATCOM CM(alpha)."""
    m = min(max(mach, C.AERO_CM_GAIN_MACH[0]), C.AERO_CM_GAIN_MACH[-1])
    g = _table(m, C.AERO_CM_GAIN_MACH, C.AERO_CM_GAIN)
    w = (abs(alpha) / C.DEG - C.AERO_CM_GAIN_ALPHA[0]) / (
        C.AERO_CM_GAIN_ALPHA[1] - C.AERO_CM_GAIN_ALPHA[0])
    w = min(max(w, 0.0), 1.0)
    return 1.0 + (g - 1.0) * w


@njit(cache=True)
def fin_lever(cg=C.CG_FULL):
    cr = C.ROOT_CHORD
    ct = C.TIP_CHORD
    b = C.WING_SPAN
    mac = (2.0 / 3.0) * (cr + ct - cr * ct / (cr + ct))
    y_mac = (b / 3.0) * (cr + 2.0 * ct) / (cr + ct)
    sweep = math.atan((cr - ct) / (b + 0.5 * C.DIAMETER))
    x_ac = (C.LENGTH - cr) + y_mac * math.tan(sweep) + 0.25 * mac
    return x_ac - cg


@njit(cache=True)
def cm_de(mach, cg=C.CG_FULL):
    return -(cn_alpha(mach) - C.CN_ALPHA_BODY) * fin_lever(cg) / C.LENGTH


@njit(cache=True)
def ramjet_isp(mach):
    if mach <= 3.5:
        return C.RAMJET_ISP
    frac = (mach - 3.5) / max(C.RAMJET_MACH_MAX - 3.5, 1e-6)
    if frac < 0.0:
        frac = 0.0
    elif frac > 1.0:
        frac = 1.0
    s = frac * (1.30 - 0.30 * frac)
    return C.RAMJET_ISP - s * (C.RAMJET_ISP - C.RAMJET_ISP_MIN)


@njit(cache=True)
def fin_effective(d):
    return d * (1.0 - C.FIN_EFF_DROP * (abs(d) / C.FIN_MAX) ** 2)


@njit(cache=True)
def _eckert_cf_factor(mach, t_inf):
    m = max(mach, 0.0)
    ti = max(t_inf, 100.0)
    tr_ratio = 1.0 + 0.89 * 0.2 * m * m
    tw_ratio = 1.0 + 0.55 * (tr_ratio - 1.0)
    t_star_ratio = 0.5 + 0.5 * tw_ratio + 0.039 * m * m
    t_star = ti * t_star_ratio
    mu_star = 1.458e-6 * t_star ** 1.5 / (t_star + 110.4)
    mu_inf = 1.458e-6 * ti ** 1.5 / (ti + 110.4)
    mu_ratio = mu_star / mu_inf
    return (t_star_ratio ** -0.65) * (mu_ratio ** 0.20)


@njit(cache=True)
def friction_delta(alt, speed, mach=-1.0):
    t, _p, rho, a = atmosphere(alt)
    tt = max(t, 1.0)
    mu = 1.458e-6 * tt ** 1.5 / (tt + 110.4)
    v = max(speed, 1.0)
    m = (v / max(a, 1e-6)) if mach < 0.0 else mach
    re = rho * v * C.LENGTH / mu
    re_ref = C.RHO_SL * v * C.LENGTH / C.MU_SL
    cf = (0.074 / max(re, 1.0) ** C.RE_EXPONENT) * _eckert_cf_factor(m, tt)
    cf_ref = (0.074 / max(re_ref, 1.0) ** C.RE_EXPONENT) * _eckert_cf_factor(
        min(m, 5.0), 288.15)
    return min(max((cf - cf_ref) * C.S_WET_RATIO, -0.04), 0.18)


@njit(cache=True)
def inlet_pressure_recovery(mach, alpha, beta):
    """Scramjet inlet total-pressure recovery factor (matches vehicle.missile)."""
    theta = math.hypot(alpha, beta)
    ang_factor = math.exp(-1.8 * theta * theta)
    m_over = mach - 5.0
    if m_over < 0.0:
        m_over = 0.0
    mach_factor = 1.0 - 0.025 * m_over
    if mach_factor < 0.78:
        mach_factor = 0.78
    val = ang_factor * mach_factor
    if val < 0.20:
        val = 0.20
    elif val > 1.0:
        val = 1.0
    return val


# ============================================================
# Missile 14-state derivative (zero-alloc scalar hot path)
# ============================================================
@njit(cache=True, nogil=True)
def _missile_deriv_into(t, state, fins, mass0, dry_mass, fuel0, S, L,
                        throttle, wx, wy, wz, unstart_flag,
                        dy_out, Fb_out, Mb_out, dcm_out):
    """Zero-allocation compiled 14-state missile RHS writing into caller buffers."""
    rx, ry, rz = state[0], state[1], state[2]
    vx, vy, vz = state[3], state[4], state[5]

    # ---- quaternion normalization (scalar first) ----
    qw, qx, qy, qz = state[6], state[7], state[8], state[9]
    qn = math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
    if qn < 1e-12:
        qw, qx, qy, qz = 1.0, 0.0, 0.0, 0.0
    else:
        qw, qx, qy, qz = qw / qn, qx / qn, qy / qn, qz / qn

    p, qq, r = state[10], state[11], state[12]
    mass = state[13]
    if mass < dry_mass:
        mass = dry_mass
    elif mass > mass0:
        mass = mass0

    # ---- mass properties (fuel fraction drives inertia and CG migration) ----
    if fuel0 > 0.0:
        f = (mass - dry_mass) / fuel0
        if f < 0.0:
            f = 0.0
        elif f > 1.0:
            f = 1.0
    else:
        f = 0.0
    separated = t >= C.BOOST_SEP_TIME
    cg = C.CG_DRY + f * (C.CG_FULL - C.CG_DRY)
    if not separated:
        cg += C.STAGE1_CG_SHIFT

    # ---- freestream ----
    alt = geodetic_alt(rx, ry, rz)
    if alt < 0.0:
        alt = 0.0
    temp, pressure, rho, sound = atmosphere(alt)

    w = C.OMEGA_EARTH
    wrx = vx + w * ry - wx
    wry = vy - w * rx - wy
    wrz = vz - wz
    speed = math.sqrt(wrx * wrx + wry * wry + wrz * wrz)
    mach = min(speed / max(sound, 1e-6), 30.0)
    q_dyn = max(0.5 * rho * speed * speed, 0.0)

    # ---- body->ECI DCM (pure scalar write) ----
    d00 = 1.0 - 2.0 * (qy * qy + qz * qz)
    d01 = 2.0 * (qx * qy - qw * qz)
    d02 = 2.0 * (qx * qz + qw * qy)
    d10 = 2.0 * (qx * qy + qw * qz)
    d11 = 1.0 - 2.0 * (qx * qx + qz * qz)
    d12 = 2.0 * (qy * qz - qw * qx)
    d20 = 2.0 * (qx * qz - qw * qy)
    d21 = 2.0 * (qy * qz + qw * qx)
    d22 = 1.0 - 2.0 * (qx * qx + qy * qy)
    dcm_out[0, 0], dcm_out[0, 1], dcm_out[0, 2] = d00, d01, d02
    dcm_out[1, 0], dcm_out[1, 1], dcm_out[1, 2] = d10, d11, d12
    dcm_out[2, 0], dcm_out[2, 1], dcm_out[2, 2] = d20, d21, d22

    # v_body = R^T v_rel
    u = d00 * wrx + d10 * wry + d20 * wrz
    vb = d01 * wrx + d11 * wry + d21 * wrz
    wb = d02 * wrx + d12 * wry + d22 * wrz
    alpha = math.atan2(wb, max(u, 1e-6))
    beta = math.atan2(vb, max(math.hypot(u, wb), 1e-6))
    lim = 35.0 * C.DEG
    if alpha > lim:
        alpha = lim
    elif alpha < -lim:
        alpha = -lim
    if beta > lim:
        beta = lim
    elif beta < -lim:
        beta = -lim

    # ---- aero coefficients ----
    cn_a = cn_alpha(mach)
    cn_body = cn_a * alpha * cn_shape(alpha)
    blend_m = (mach - C.MACH_NL_START) / (C.MACH_NL_FULL - C.MACH_NL_START)
    blend_m = min(max(blend_m, 0.0), 1.0)
    if blend_m > 0.0:
        cn_newton = (C.CN_NEWTON_SHAPE * cp_max(mach)
                     * math.sin(alpha) ** 2 * math.cos(alpha))
        if abs(cn_newton) > abs(cn_body):
            if alpha < 0.0:
                cn_body += blend_m * (-abs(cn_newton) - cn_body)
            else:
                cn_body += blend_m * (abs(cn_newton) - cn_body)

    ratio = fin_slope_ratio(mach)
    d_p = 0.5 * (fins[3] + fins[2])
    d_r = 0.5 * (fins[3] - fins[2])
    d_y = 0.5 * (fins[0] + fins[1])
    d_pe = fin_effective(d_p)
    d_ye = fin_effective(d_y)
    d_re = fin_effective(d_r)
    cn_de_lift = C.FIN_LIFT_FRAC * max(cn_a - C.CN_ALPHA_BODY, 0.0)
    cn = cn_body + cn_de_lift * d_pe
    cy = C.CY_BETA * ratio * beta + 0.4 * cn_de_lift * d_ye

    cn_sin = cn * math.sin(alpha)
    denom = max(math.cos(alpha), 0.2)
    ca = (cd0(mach) + friction_delta(alt, speed, mach)
          + induced_k(mach) * k_shape(alpha) * (cn * cn + cy * cy)
          - cn_sin) / denom
    if ca < 0.0:
        ca = 0.0
    ca += C.FIN_CD * (abs(d_p) + C.FIN_CD_QUAD * d_p * d_p / C.FIN_MAX)
    ca += C.FIN_CD * (abs(d_y) + C.FIN_CD_QUAD * d_y * d_y / C.FIN_MAX)
    ca += C.FIN_CD * (abs(d_r) + C.FIN_CD_QUAD * d_r * d_r / C.FIN_MAX)
    if ca > 3.0:
        ca = 3.0
    margin = static_margin(mach, cg)
    cm = -margin / L * cn_body * cm_gain(mach, alpha) + cm_de(mach, cg) * d_pe
    cn_yaw = -C.CN_BETA * ratio * (margin / (C.X_REF - C.CG_FULL)) * beta \
        + C.CN_DR * ratio * d_ye
    cl = C.CL_DA * ratio * d_re + C.CL_ALPHA_BETA * ratio * alpha * beta
    if abs(alpha) > 1e-4:
        cn_a_eff = cn_body / alpha
    else:
        cn_a_eff = cn_a

    # ---- propulsion ----
    fuel = mass - dry_mass
    if fuel < 0.0:
        fuel = 0.0
    mdot = 0.0
    thrust = 0.0
    phase_code = -1
    if fuel > 1e-6:
        consumed = fuel0 - fuel
        if consumed < 0.0:
            consumed = 0.0
        if t < C.BOOST_BURN_TIME and consumed < C.BOOST_FUEL - 1e-6:
            f_sl = C.BOOST_THRUST_SL * boost_thrust_scale(t)
            thrust = f_sl + C.NOZZLE_EXIT_AREA * (C.P_SL - pressure)
            mdot = C.BOOST_FUEL / C.BOOST_BURN_TIME
            if thrust < 0.0:
                thrust = 0.0
            phase_code = 0
        elif (C.RAMJET_MACH_MIN <= mach <= C.RAMJET_MACH_MAX) and q_dyn > C.RAMJET_Q_MIN:
            eta_m, eta_h = ramjet_efficiency(mach, alt)
            eta_in = inlet_pressure_recovery(mach, alpha, beta)
            eta = eta_m * eta_h * eta_in
            thr = throttle
            if thr < 0.0:
                thr = 0.0
            elif thr > 1.0:
                thr = 1.0
            if eta <= 1e-3 or thr <= 1e-6:
                thrust = 0.0
                mdot = 0.0
            else:
                a_clip = alpha
                if a_clip > 0.6:
                    a_clip = 0.6
                elif a_clip < -0.6:
                    a_clip = -0.6
                cos_alpha = min(max(math.cos(a_clip), 0.55), 1.0)
                unstart_scale = C.INLET_UNSTART_THRUST_FRAC if unstart_flag != 0 else 1.0
                t_avail_full = (C.RAMJET_COEFF * q_dyn * C.RAMJET_A_INLET
                                * eta * cos_alpha)
                isp_now = ramjet_isp(mach)
                mdot_air = (math.sqrt(max(2.0 * rho * q_dyn, 0.0))
                            * C.RAMJET_A_INLET * C.RAMJET_CAPTURE_GAIN * eta_in * cos_alpha)
                mdot_stoich = C.RAMJET_PHI_MAX * C.RAMJET_F_STOICH * mdot_air
                mdot_cap = min(t_avail_full / (C.G0 * isp_now),
                               min(mdot_stoich, C.RAMJET_MDOT_MAX))
                mdot = min(mdot_cap * thr * unstart_scale, fuel / 1e-3)
                thrust = min(mdot * C.G0 * isp_now, C.RAMJET_THRUST_MAX)
                if thrust < 0.0:
                    thrust = 0.0
                phase_code = 1

    # ---- forces and moments (pure scalar) ----
    qS = q_dyn * S
    base_relief = (0.065 / (1.0 + 0.35 * mach * mach)) * qS if thrust > 0.0 else 0.0
    if separated and mach >= 1.2:
        if unstart_flag != 0:
            spill_drag = C.CD_INLET_UNSTART * qS
        elif thrust <= 0.0:
            spill_drag = C.CD_INLET_SPILL_COAST * qS
        else:
            spill_drag = 0.0
    else:
        spill_drag = 0.0
    fb0 = -ca * qS + thrust + base_relief - spill_drag
    fb1 = cy * qS
    fb2 = -cn * qS
    Fb_out[0] = fb0
    Fb_out[1] = fb1
    Fb_out[2] = fb2

    qSL = qS * L
    V = max(speed, 1.0)
    inv_half = L / (2.0 * V)
    lever_ratio = fin_lever(cg) / max(C.FIN_LEVER, 0.2)
    lever_eff = 0.5 + 0.5 * lever_ratio * lever_ratio
    damp_trans = min(max(ratio * lever_eff, 0.70), 1.55)
    damp_roll = min(max(ratio, 0.70), 1.50)
    cm += C.CM_Q * damp_trans * (qq * inv_half)
    cn_yaw += C.CN_R * damp_trans * (r * inv_half)
    cl += C.CL_P * damp_roll * (p * inv_half)
    mb0 = cl * qSL
    mb1 = cm * qSL
    mb2 = cn_yaw * qSL
    Mb_out[0] = mb0
    Mb_out[1] = mb1
    Mb_out[2] = mb2

    gx, gy, gz = gravity_xyz(rx, ry, rz)
    fe0 = d00 * fb0 + d01 * fb1 + d02 * fb2 + mass * gx
    fe1 = d10 * fb0 + d11 * fb1 + d12 * fb2 + mass * gy
    fe2 = d20 * fb0 + d21 * fb1 + d22 * fb2 + mass * gz

    # ---- mass properties ----
    ix = C.IXX_DRY + f * (C.IXX_FULL - C.IXX_DRY)
    iy = C.IYY_DRY + f * (C.IYY_FULL - C.IYY_DRY)
    iz = C.IZZ_DRY + f * (C.IZZ_FULL - C.IZZ_DRY)
    if not separated:
        ix += C.STAGE1_IXX_DROP
        iy += C.STAGE1_IYY_DROP
        iz += C.STAGE1_IYY_DROP
    if fuel0 > 0.0:
        dix = (C.IXX_FULL - C.IXX_DRY) / fuel0 * (-mdot)
        diy = (C.IYY_FULL - C.IYY_DRY) / fuel0 * (-mdot)
        diz = (C.IZZ_FULL - C.IZZ_DRY) / fuel0 * (-mdot)
    else:
        dix = 0.0
        diy = 0.0
        diz = 0.0

    inv_m = 1.0 / max(mass, 1e-6)
    dy_out[0] = vx
    dy_out[1] = vy
    dy_out[2] = vz
    dy_out[3] = fe0 * inv_m
    dy_out[4] = fe1 * inv_m
    dy_out[5] = fe2 * inv_m
    dy_out[6] = 0.5 * (-qx * p - qy * qq - qz * r)
    dy_out[7] = 0.5 * (qw * p + qy * r - qz * qq)
    dy_out[8] = 0.5 * (qw * qq - qx * r + qz * p)
    dy_out[9] = 0.5 * (qw * r + qx * qq - qy * p)
    gyro0 = qq * (iz * r) - r * (iy * qq)
    gyro1 = r * (ix * p) - p * (iz * r)
    gyro2 = p * (iy * qq) - qq * (ix * p)
    r_noz = max(C.LENGTH - cg, 0.0)
    jet_trans = mdot * r_noz * r_noz
    jet_roll = 0.5 * mdot * (C.NOZZLE_EXIT_AREA / math.pi)
    dy_out[10] = (mb0 - gyro0 - dix * p - jet_roll * p) / ix
    dy_out[11] = (mb1 - gyro1 - diy * qq - jet_trans * qq) / iy
    dy_out[12] = (mb2 - gyro2 - diz * r - jet_trans * r) / iz
    dy_out[13] = -mdot

    return alpha, beta, mach, q_dyn, alt, cn_a_eff, mdot, thrust, phase_code


@njit(cache=True, nogil=True)
def missile_derivatives(t, state14, fins, mass0, dry_mass, fuel0, S, L,
                        throttle, wx, wy, wz, unstart_flag=0):
    """Compiled equivalent of ``Missile.derivatives``."""
    dy = np.empty(14)
    Fb = np.empty(3)
    Mb = np.empty(3)
    dcm = np.empty((3, 3))
    (alpha, beta, mach, q_dyn, alt, cn_a_eff, mdot, thrust,
     phase_code) = _missile_deriv_into(
        t, state14, fins, mass0, dry_mass, fuel0, S, L, throttle,
        wx, wy, wz, unstart_flag, dy, Fb, Mb, dcm)
    return (dy, alpha, beta, mach, q_dyn, alt, cn_a_eff, Fb, Mb,
            dcm, mdot, thrust, phase_code)


# ============================================================
# Target 6-state derivative (zero-alloc scalar hot path)
# ============================================================
@njit(cache=True, nogil=True)
def _target_deriv_into(t, state, t_off, mx, my, mz, evade_g, maneuver_dist,
                       evade_phase, dy_out, dy_off):
    """Zero-allocation compiled 6-state target RHS writing into caller buffer."""
    rx = state[t_off]
    ry = state[t_off + 1]
    rz = state[t_off + 2]
    vx = state[t_off + 3]
    vy = state[t_off + 4]
    vz = state[t_off + 5]

    rn = math.sqrt(rx * rx + ry * ry + rz * rz)
    if rn < 1e-12:
        rn = 1e-12
    upx, upy, upz = geodetic_up(rx, ry, rz)

    speed = math.sqrt(vx * vx + vy * vy + vz * vz)
    scale = speed * speed / max(rn, 1.0)
    ax = -upx * scale
    ay = -upy * scale
    az = -upz * scale

    dx = mx - rx
    dy = my - ry
    dz = mz - rz
    dist = math.sqrt(dx * dx + dy * dy + dz * dz)

    w = C.OMEGA_EARTH
    wrx = vx + w * ry
    wry = vy - w * rx
    wrz = vz
    v_air = math.sqrt(wrx * wrx + wry * wry + wrz * wrz)
    if v_air > 1e-9:
        sin_gamma = (wrx * upx + wry * upy + wrz * upz) / v_air
        ax -= C.G0 * sin_gamma * wrx / v_air
        ay -= C.G0 * sin_gamma * wry / v_air
        az -= C.G0 * sin_gamma * wrz / v_air
    alt = geodetic_alt(rx, ry, rz)
    if alt < 0.0:
        alt = 0.0
    temp, pressure, rho, sound = atmosphere(alt)
    mach = v_air / max(sound, 1e-6)
    if v_air > 1e-12:
        vhx, vhy, vhz = wrx / v_air, wry / v_air, wrz / v_air
    else:
        vhx, vhy, vhz = 1.0, 0.0, 0.0
    if mach <= C.TARGET_CL_MACH_LO:
        cl_max = C.TARGET_CL_MAX_SUB
    elif mach >= C.TARGET_CL_MACH_HI:
        cl_max = C.TARGET_CL_MAX_SUP
    else:
        bw = ((mach - C.TARGET_CL_MACH_LO)
              / (C.TARGET_CL_MACH_HI - C.TARGET_CL_MACH_LO))
        cl_max = (C.TARGET_CL_MAX_SUB
                  + bw * (C.TARGET_CL_MAX_SUP - C.TARGET_CL_MAX_SUB))
    q_t = 0.5 * rho * v_air * v_air
    n_avail = q_t * C.TARGET_WING_AREA * cl_max / (C.TARGET_MASS * C.G0)

    n_man = 0.0
    max_ = 0.0
    may_ = 0.0
    maz_ = 0.0
    if dist < maneuver_dist:
        ex = upy * vhz - upz * vhy
        ey = upz * vhx - upx * vhz
        ez = upx * vhy - upy * vhx
        en = math.sqrt(ex * ex + ey * ey + ez * ez)
        if en < 1e-12:
            ex, ey, ez = 1.0, 0.0, 0.0
        else:
            ex, ey, ez = ex / en, ey / en, ez / en

        n_cmd = evade_g
        if n_cmd > n_avail:
            n_cmd = n_avail
        if n_cmd < 0.0:
            n_cmd = 0.0
        amp = n_cmd * C.G0
        w1 = 2.0 * math.pi * 0.25
        w2 = 2.0 * math.pi * 0.5
        tau = C.TARGET_MANEUVER_TAU
        h1 = 1.0 / math.sqrt(1.0 + (w1 * tau) * (w1 * tau))
        h2 = 1.0 / math.sqrt(1.0 + (w2 * tau) * (w2 * tau))
        ph1 = math.atan(w1 * tau)
        ph2 = math.atan(w2 * tau)
        s1 = h1 * math.sin(w1 * t - ph1 + evade_phase)
        s2 = h2 * math.sin(w2 * t + 1.0 - ph2 + evade_phase)
        max_ = amp * s1 * ex - 0.25 * amp * s2 * upx
        may_ = amp * s1 * ey - 0.25 * amp * s2 * upy
        maz_ = amp * s1 * ez - 0.25 * amp * s2 * upz
        n_man = n_cmd * math.sqrt(1.0 + 0.25 * 0.25)
    elif dist < C.TARGET_DEFEND_DIST:
        ln = math.sqrt(dx * dx + dy * dy + dz * dz)
        if ln < 1e-9:
            lhx, lhy, lhz = 1.0, 0.0, 0.0
        else:
            lhx, lhy, lhz = dx / ln, dy / ln, dz / ln
        cos_head = vhx * lhx + vhy * lhy + vhz * lhz
        gain = ((cos_head - C.TARGET_BEAM_COS_LO)
                / (C.TARGET_BEAM_COS_HI - C.TARGET_BEAM_COS_LO))
        if gain < 0.0:
            gain = 0.0
        elif gain > 1.0:
            gain = 1.0
        n_turn = C.TARGET_DEFEND_G
        if n_turn > n_avail:
            n_turn = n_avail
        if n_turn > evade_g:
            n_turn = evade_g
        if n_turn < 0.0:
            n_turn = 0.0
        n_turn *= gain
        frac = evade_g
        if frac > C.TARGET_DEFEND_G:
            frac = C.TARGET_DEFEND_G
        if frac < 0.0:
            frac = 0.0
        frac = frac / C.TARGET_DEFEND_G
        gamma = vhx * upx + vhy * upy + vhz * upz
        if gamma > 1.0:
            gamma = 1.0
        elif gamma < -1.0:
            gamma = -1.0
        gamma = math.asin(gamma)
        ramp = ((gamma + C.TARGET_DESCENT_GAMMA)
                / (0.5 * C.TARGET_DESCENT_GAMMA))
        if ramp < 0.0:
            ramp = 0.0
        elif ramp > 1.0:
            ramp = 1.0
        n_desc = C.TARGET_DESCENT_G
        if n_desc > n_avail:
            n_desc = n_avail
        n_desc *= ramp * frac
        n_tot = math.sqrt(n_turn * n_turn + n_desc * n_desc)
        if n_tot > n_avail and n_tot > 1e-9:
            sc = n_avail / n_tot
            n_turn *= sc
            n_desc *= sc
            n_tot = n_avail
        nx = upy * lhz - upz * lhy
        ny = upz * lhx - upx * lhz
        nz = upx * lhy - upy * lhx
        nn = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nn < 1e-12:
            nx, ny, nz = 1.0, 0.0, 0.0
        else:
            nx, ny, nz = nx / nn, ny / nn, nz / nn
        max_ = n_turn * C.G0 * nx - n_desc * C.G0 * upx
        may_ = n_turn * C.G0 * ny - n_desc * C.G0 * upy
        maz_ = n_turn * C.G0 * nz - n_desc * C.G0 * upz
        n_man = n_tot

    if n_man > 0.0:
        along = max_ * vhx + may_ * vhy + maz_ * vhz
        ax += max_ - along * vhx
        ay += may_ - along * vhy
        az += maz_ - along * vhz
        q_s = q_t * C.TARGET_WING_AREA
        if q_s > 1.0:
            w_load = C.TARGET_MASS * C.G0 / q_s
            ar = C.TARGET_SPAN * C.TARGET_SPAN / C.TARGET_WING_AREA
            k_ind = 1.0 / (math.pi * ar * C.TARGET_OSWALD_E)
            dcd = k_ind * (n_man * n_man) * w_load * w_load
            if dcd > 0.0:
                a_bleed = q_s * dcd / C.TARGET_MASS
                if v_air > 1e-6:
                    ax -= a_bleed * wrx / v_air
                    ay -= a_bleed * wry / v_air
                    az -= a_bleed * wrz / v_air

    dy_out[dy_off] = vx
    dy_out[dy_off + 1] = vy
    dy_out[dy_off + 2] = vz
    dy_out[dy_off + 3] = ax
    dy_out[dy_off + 4] = ay
    dy_out[dy_off + 5] = az


@njit(cache=True, nogil=True)
def target_derivatives(t, state6, missile_pos, evade_g, maneuver_dist,
                       evade_phase):
    """Compiled equivalent of ``Target.derivatives``."""
    out = np.empty(6)
    _target_deriv_into(
        t, state6, 0, missile_pos[0], missile_pos[1], missile_pos[2],
        evade_g, maneuver_dist, evade_phase, out, 0)
    return out


@njit(cache=True, nogil=True)
def system_derivatives(t, state20, fins, mass0, dry_mass, fuel0, S, L,
                       throttle, wx, wy, wz, evade_g, maneuver_dist,
                       evade_phase, unstart_flag=0):
    """Combined missile+target 20-state RHS in a single JIT call."""
    dy = np.empty(20)
    Fb = np.empty(3)
    Mb = np.empty(3)
    dcm = np.empty((3, 3))
    (alpha, beta, mach, q_dyn, alt, cn_a, mdot, thrust,
     phase_code) = _missile_deriv_into(
        t, state20, fins, mass0, dry_mass, fuel0, S, L, throttle,
        wx, wy, wz, unstart_flag, dy, Fb, Mb, dcm)
    _target_deriv_into(
        t, state20, 14, state20[0], state20[1], state20[2],
        evade_g, maneuver_dist, evade_phase, dy, 14)
    return (dy, alpha, beta, mach, q_dyn, alt, cn_a, Fb, Mb, dcm, mdot,
            thrust, phase_code)


@njit(cache=True, nogil=True)
def rk4_multi_step_system_into(t0, y_in, h_total, n_sub, fins,
                               mass0, dry_mass, fuel0, S, L,
                               throttle, wx, wy, wz,
                               evade_g, maneuver_dist, evade_phase,
                               unstart_flag,
                               y_out, f_avg, k1, k2, k3, k4, ytmp,
                               Fb, Mb, dcm):
    """Fused zero-allocation RK4 (1 or more substeps) inside one nogil JIT call.

    Eliminates 4*n_sub Python<->Numba transitions, temporary NumPy array
    allocations, and Python dict builds per outer ZOH step.
    """
    for i in range(20):
        y_out[i] = y_in[i]

    h = h_total / n_sub
    hh = 0.5 * h
    t = t0

    alpha = 0.0
    beta = 0.0
    mach = 0.0
    q_dyn = 0.0
    alt = 0.0
    cn_a = 0.0
    mdot = 0.0
    thrust = 0.0
    phase_code = -1

    for _s in range(n_sub):
        # Stage 1
        _missile_deriv_into(t, y_out, fins, mass0, dry_mass, fuel0, S, L,
                            throttle, wx, wy, wz, unstart_flag, k1, Fb, Mb, dcm)
        _target_deriv_into(t, y_out, 14, y_out[0], y_out[1], y_out[2],
                           evade_g, maneuver_dist, evade_phase, k1, 14)

        # Stage 2
        for i in range(20):
            ytmp[i] = y_out[i] + hh * k1[i]
        _missile_deriv_into(t + hh, ytmp, fins, mass0, dry_mass, fuel0, S, L,
                            throttle, wx, wy, wz, unstart_flag, k2, Fb, Mb, dcm)
        _target_deriv_into(t + hh, ytmp, 14, ytmp[0], ytmp[1], ytmp[2],
                           evade_g, maneuver_dist, evade_phase, k2, 14)

        # Stage 3
        for i in range(20):
            ytmp[i] = y_out[i] + hh * k2[i]
        _missile_deriv_into(t + hh, ytmp, fins, mass0, dry_mass, fuel0, S, L,
                            throttle, wx, wy, wz, unstart_flag, k3, Fb, Mb, dcm)
        _target_deriv_into(t + hh, ytmp, 14, ytmp[0], ytmp[1], ytmp[2],
                           evade_g, maneuver_dist, evade_phase, k3, 14)

        # Stage 4 (final-stage diagnostics populate Fb, Mb, dcm and scalars)
        for i in range(20):
            ytmp[i] = y_out[i] + h * k3[i]
        (alpha, beta, mach, q_dyn, alt, cn_a, mdot, thrust,
         phase_code) = _missile_deriv_into(
            t + h, ytmp, fins, mass0, dry_mass, fuel0, S, L,
            throttle, wx, wy, wz, unstart_flag, k4, Fb, Mb, dcm)
        _target_deriv_into(t + h, ytmp, 14, ytmp[0], ytmp[1], ytmp[2],
                           evade_g, maneuver_dist, evade_phase, k4, 14)

        h6 = h / 6.0
        for i in range(20):
            y_out[i] += h6 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])
        t += h

    if n_sub == 1:
        inv6 = 1.0 / 6.0
        for i in range(20):
            f_avg[i] = inv6 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])
    else:
        inv_ht = 1.0 / max(h_total, 1e-15)
        for i in range(20):
            f_avg[i] = (y_out[i] - y_in[i]) * inv_ht

    return alpha, beta, mach, q_dyn, alt, cn_a, mdot, thrust, phase_code


# ============================================================
# Deterministic 64-bit LCG + Box-Muller normal draws
# ============================================================
def make_rng_state(seed):
    """Initialise a per-module RNG state (uint64[1]) from an integer seed."""
    v = (int(seed) * 2654435761 + 12345) & 0xFFFFFFFFFFFFFFFF
    if v == 0:
        v = 88172645463325252
    return np.array([v], dtype=np.uint64)


@njit(cache=True, nogil=True)
def rng_uniform(state):
    """Uniform double in [0, 1) from a 64-bit LCG."""
    v = state[0] * np.uint64(6364136223846793005) + np.uint64(1442695040888963407)
    state[0] = v
    return np.float64(v >> np.uint64(11)) * (1.0 / 9007199254740992.0)


@njit(cache=True, nogil=True)
def rng_normal(state):
    """Standard normal via Box-Muller (two uniforms per sample)."""
    u1 = rng_uniform(state)
    u2 = rng_uniform(state)
    if u1 < 1e-12:
        u1 = 1e-12
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


@njit(cache=True, nogil=True)
def quat_to_dcm(q):
    """Quaternion (scalar first) to body->ECI DCM."""
    w, x, y, z = q[0], q[1], q[2], q[3]
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        w, x, y, z = 1.0, 0.0, 0.0, 0.0
    else:
        w, x, y, z = w / n, x / n, y / n, z / n
    dcm = np.empty((3, 3))
    dcm[0, 0] = 1.0 - 2.0 * (y * y + z * z)
    dcm[0, 1] = 2.0 * (x * y - w * z)
    dcm[0, 2] = 2.0 * (x * z + w * y)
    dcm[1, 0] = 2.0 * (x * y + w * z)
    dcm[1, 1] = 1.0 - 2.0 * (x * x + z * z)
    dcm[1, 2] = 2.0 * (y * z - w * x)
    dcm[2, 0] = 2.0 * (x * z - w * y)
    dcm[2, 1] = 2.0 * (y * z + w * x)
    dcm[2, 2] = 1.0 - 2.0 * (x * x + y * y)
    return dcm


@njit(cache=True, nogil=True)
def quat_rotate_inv(q, v):
    """Rotate an ECI vector into the body frame (conjugate quaternion).

    Equivalent to ``R^T v`` but expressed with the quaternion directly, so no
    3x3 DCM has to be built and no attitude angle is ever formed.
    """
    w, x, y, z = q[0], -q[1], -q[2], -q[3]
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        w, x, y, z = 1.0, 0.0, 0.0, 0.0
    else:
        w, x, y, z = w / n, x / n, y / n, z / n
    tx = 2.0 * (y * v[2] - z * v[1])
    ty = 2.0 * (z * v[0] - x * v[2])
    tz = 2.0 * (x * v[1] - y * v[0])
    out = np.empty(3)
    out[0] = v[0] + w * tx + (y * tz - z * ty)
    out[1] = v[1] + w * ty + (z * tx - x * tz)
    out[2] = v[2] + w * tz + (x * ty - y * tx)
    return out


# ============================================================
# Seeker: LOS geometry + noise + rate filter
# ============================================================
@njit(cache=True, nogil=True)
def seeker_measure(t, r_m, v_m, body_x, r_t, v_t, fov, blind, lock_range,
                   sigma_angle, rate_state, rng_state, t_last, initialized,
                   noise_scale):
    """Compiled equivalent of ``Seeker.measure``.

    ``body_x`` is the current body X axis in ECI (from the attitude
    quaternion), which is all the FOV test needs; passing the boresight
    instead of a full 3x3 DCM avoids a matrix/vector product per sample.
    ``noise_scale`` = 0 removes every random draw (deterministic limit).

    Returns ``(u_meas, rate_filtered, range_meas, range_rate_meas,
    locked, fov_angle, true_range, t_last, initialized)``.
    """
    # ---- LOS geometry ----
    rx = r_t[0] - r_m[0]
    ry = r_t[1] - r_m[1]
    rz = r_t[2] - r_m[2]
    R = math.sqrt(rx * rx + ry * ry + rz * rz)
    if R < 1e-12:
        R = 1e-12
    ux, uy, uz = rx / R, ry / R, rz / R
    vrx = v_t[0] - v_m[0]
    vry = v_t[1] - v_m[1]
    vrz = v_t[2] - v_m[2]
    range_rate = ux * vrx + uy * vry + uz * vrz
    inv_r2 = 1.0 / (R * R)
    ox = (ry * vrz - rz * vry) * inv_r2
    oy = (rz * vrx - rx * vrz) * inv_r2
    oz = (rx * vry - ry * vrx) * inv_r2

    # ---- FOV (LOS angle off body X) ----
    ubx = body_x[0] * ux + body_x[1] * uy + body_x[2] * uz
    fov_angle = math.acos(min(max(ubx, -1.0), 1.0))

    # ---- noise amplitudes ----
    sigma_glint = C.SEEKER_GLINT_K * C.TARGET_LENGTH / max(R, 1.0)
    sigma_tot = math.sqrt(sigma_angle * sigma_angle
                          + sigma_glint * sigma_glint) * noise_scale

    # e1 = u x z_axis, e2 = u x e1
    e1x, e1y, e1z = uy, -ux, 0.0
    n1 = math.sqrt(e1x * e1x + e1y * e1y)
    if n1 < 1e-9:
        e1x, e1y, e1z = 1.0, 0.0, 0.0
    else:
        e1x, e1y, e1z = e1x / n1, e1y / n1, 0.0
    e2x = uy * e1z - uz * e1y
    e2y = uz * e1x - ux * e1z
    e2z = ux * e1y - uy * e1x

    n_a = rng_normal(rng_state) * sigma_tot
    n_b = rng_normal(rng_state) * sigma_tot
    mx = ux + n_a * e1x + n_b * e2x
    my = uy + n_a * e1y + n_b * e2y
    mz = uz + n_a * e1z + n_b * e2z
    mn = math.sqrt(mx * mx + my * my + mz * mz)
    if mn < 1e-12:
        mx, my, mz = 1.0, 0.0, 0.0
    else:
        mx, my, mz = mx / mn, my / mn, mz / mn

    # ---- LOS-rate filter (tau ~ 20 ms) ----
    sx = sigma_tot / 0.02
    ox += rng_normal(rng_state) * sx
    oy += rng_normal(rng_state) * sx
    oz += rng_normal(rng_state) * sx
    if initialized:
        dt = max(t - t_last, C.DT_SEEKER)
    else:
        dt = C.DT_SEEKER
    a_f = dt / 0.02
    if a_f < 0.0:
        a_f = 0.0
    elif a_f > 1.0:
        a_f = 1.0
    if initialized:
        rate_state[0] += a_f * (ox - rate_state[0])
        rate_state[1] += a_f * (oy - rate_state[1])
        rate_state[2] += a_f * (oz - rate_state[2])
    else:
        rate_state[0], rate_state[1], rate_state[2] = ox, oy, oz

    range_meas = R + rng_normal(rng_state) * C.SEEKER_RANGE_SIGMA * noise_scale
    if range_meas < 0.0:
        range_meas = 0.0
    range_rate_meas = range_rate + rng_normal(rng_state) * C.SEEKER_RANGE_RATE_SIGMA * noise_scale

    locked = (fov_angle <= fov) and (R > blind) and (R <= lock_range)
    u_meas = np.empty(3)
    u_meas[0], u_meas[1], u_meas[2] = mx, my, mz
    rate_out = rate_state.copy()
    return (u_meas, rate_out, range_meas, range_rate_meas, locked,
            fov_angle, R, t, 1.0)


# ============================================================
# Navigation: KF predict / GNSS update
# ============================================================
@njit(cache=True, nogil=True)
def nav_predict_ins(x, P, dt, a_true, b_true, sigma_acc, sigma_acc_q, phi_a,
                    phi_g, q_bias_a, q_bias_g, rng_state):
    """Twelve-state INS prediction ``[r, v, b_a, b_g]`` (mutates x and P).

    The accelerometer measures ``a_true + noise + b_true``; the filter
    estimates ``b_a`` and subtracts it.  Both bias vectors follow first-order
    Gauss-Markov dynamics.  ``b_g`` is observed through the star-aided
    attitude loop (a pseudo-measurement applied by the caller).
    """
    if dt < 0.0:
        dt = 0.0
    elif dt > 0.5:
        dt = 0.5

    a0 = a_true[0] + rng_normal(rng_state) * sigma_acc + b_true[0] - x[6]
    a1 = a_true[1] + rng_normal(rng_state) * sigma_acc + b_true[1] - x[7]
    a2 = a_true[2] + rng_normal(rng_state) * sigma_acc + b_true[2] - x[8]

    x[0] += dt * x[3] + 0.5 * dt * dt * a0
    x[1] += dt * x[4] + 0.5 * dt * dt * a1
    x[2] += dt * x[5] + 0.5 * dt * dt * a2
    x[3] += dt * a0
    x[4] += dt * a1
    x[5] += dt * a2
    for i in range(3):
        x[6 + i] *= phi_a
        x[9 + i] *= phi_g

    F = np.eye(12)
    for i in range(3):
        F[i, 3 + i] = dt
        F[i, 6 + i] = -0.5 * dt * dt
        F[3 + i, 6 + i] = -dt
        F[6 + i, 6 + i] = phi_a
        F[9 + i, 9 + i] = phi_g

    Pn = F.dot(P).dot(F.T)
    q_pos = (sigma_acc_q * dt * dt) ** 2 * 0.25
    q_vel = (sigma_acc_q * dt) ** 2
    for i in range(3):
        Pn[i, i] += q_pos
        Pn[3 + i, 3 + i] += q_vel
        Pn[6 + i, 6 + i] += q_bias_a
        Pn[9 + i, 9 + i] += q_bias_g
    for i in range(12):
        for j in range(12):
            P[i, j] = 0.5 * (Pn[i, j] + Pn[j, i])


@njit(cache=True, nogil=True)
def nav_gnss_update_ins(x, P, r_true, v_true, sigma_pos, sigma_vel, rng_state):
    """GNSS position/velocity update with ``H = [I6 0 0]`` (mutates x, P)."""
    z = np.empty(6)
    for i in range(3):
        z[i] = r_true[i] + rng_normal(rng_state) * sigma_pos
        z[3 + i] = v_true[i] + rng_normal(rng_state) * sigma_vel

    S = P[0:6, 0:6].copy()
    sp2 = max(sigma_pos * sigma_pos, 1e-9)
    sv2 = max(sigma_vel * sigma_vel, 1e-9)
    for i in range(3):
        S[i, i] += sp2
        S[3 + i, 3 + i] += sv2

    K = np.linalg.solve(S, P[:, 0:6].T).T
    innov = z - x[0:6]
    x[:] = x + K.dot(innov)
    # Joseph form preserves positive semi-definiteness even at zero noise.
    IKH = np.eye(12)
    for i in range(12):
        for j in range(6):
            IKH[i, j] -= K[i, j]
    Rmat = np.zeros((6, 6))
    for i in range(3):
        Rmat[i, i] = sp2
        Rmat[3 + i, 3 + i] = sv2
    Pn = IKH.dot(P).dot(IKH.T) + K.dot(Rmat).dot(K.T)
    for i in range(12):
        for j in range(12):
            P[i, j] = 0.5 * (Pn[i, j] + Pn[j, i])
    return z


@njit(cache=True, nogil=True)
def nav_bias_update_ins(x, P, b_meas, sigma_b):
    """Gyro-bias pseudo-measurement ``H = [0 0 0 I]`` (mutates x, P)."""
    S = P[9:12, 9:12].copy()
    sb2 = sigma_b * sigma_b
    for i in range(3):
        S[i, i] += sb2
    K = np.linalg.solve(S, P[:, 9:12].T).T
    innov = b_meas - x[9:12]
    x[:] = x + K.dot(innov)
    Pn = P - K.dot(P[9:12, :].copy())
    for i in range(12):
        for j in range(12):
            P[i, j] = 0.5 * (Pn[i, j] + Pn[j, i])



# ============================================================
# Autopilot: three-loop law with anti-windup and gain scheduling
# ============================================================
@njit(cache=True, nogil=True)
def autopilot_update(q, omega, a_cmd, mass, q_dyn, cn_alpha,
                     alpha_trim, beta_trim, is_saturated, dt, alpha_max,
                     prefilter_hz,
                     kp_angle, ki_angle, kp_rate, ki_rate,
                     kp_angle_y, ki_angle_y, kp_rate_y, ki_rate_y,
                     kp_roll, ki_roll,
                     roll_align,
                     n_meas, kp_nz, ki_nz, nz_lead, state):
    """Compiled equivalent of ``Autopilot.update``.

    ``state`` layout: [alpha_x, alpha_xd, alpha_init,
                       beta_x,  beta_xd,  beta_init,
                       trim_y,  trim_init,
                       int_angle_p, int_angle_y, int_rate_p, int_rate_y,
                       int_roll, initialized].
    Returns the three virtual fin commands.
    """
    a_b = quat_rotate_inv(q, a_cmd)
    ab1 = a_b[1]
    ab2 = a_b[2]
    # Lift-vector alignment (symmetric BTT shortest-axis alignment [-pi/2, pi/2]).
    a_lat = math.hypot(ab1, ab2)
    if roll_align > 0.5 and a_lat > 0.1:
        phi_err = math.atan2(ab1, -ab2)
        if phi_err > 0.5 * math.pi:
            phi_err -= math.pi
        elif phi_err < -0.5 * math.pi:
            phi_err += math.pi
        p_cmd = C.AP_ROLL_ANGLE_GAIN * phi_err * min(a_lat / 6.0, 1.0)
        if p_cmd > C.AP_ROLL_RATE_MAX:
            p_cmd = C.AP_ROLL_RATE_MAX
        elif p_cmd < -C.AP_ROLL_RATE_MAX:
            p_cmd = -C.AP_ROLL_RATE_MAX
        # High-alpha roll-rate taper: alpha * p coupling builds sideslip.
        roll_scale = C.AP_ALPHA_ROLL_REF / max(abs(alpha_trim), 1.0e-3)
        if roll_scale > 1.0:
            roll_scale = 1.0
        elif roll_scale < C.AP_ROLL_ALPHA_FLOOR:
            roll_scale = C.AP_ROLL_ALPHA_FLOOR
        p_cmd *= roll_scale
    else:
        p_cmd = 0.0

    qS = max(q_dyn * C.S_REF, 1.0)
    cn_a = max(cn_alpha, 0.5)
    alpha_cmd = -ab2 * mass / (qS * cn_a)
    beta_cmd = -ab1 * mass / (qS * abs(C.CY_BETA))
    if alpha_cmd > alpha_max:
        alpha_cmd = alpha_max
    elif alpha_cmd < -alpha_max:
        alpha_cmd = -alpha_max
    # Angle-of-attack envelope: no guidance demand is allowed to hold the body
    # beyond the usable lift line.  Inside the envelope this is inert.
    if alpha_trim > C.AP_ALPHA_ENV and alpha_cmd > C.AP_ALPHA_ENV:
        alpha_cmd = C.AP_ALPHA_ENV
    elif alpha_trim < -C.AP_ALPHA_ENV and alpha_cmd < -C.AP_ALPHA_ENV:
        alpha_cmd = -C.AP_ALPHA_ENV
    # Sideslip is a trim channel, not a load channel.  The limit grows with
    # dynamic pressure because the yaw channel authority does: at cruise q it
    # is a small value, at terminal q the full airframe envelope is available.
    beta_max = C.AP_BETA_MAX * math.sqrt(max(q_dyn, 1.0) / C.AP_BETA_Q_REF)
    if beta_max > alpha_max:
        beta_max = alpha_max
    elif beta_max < C.AP_BETA_MAX:
        beta_max = C.AP_BETA_MAX
    if beta_cmd > beta_max:
        beta_cmd = beta_max
    elif beta_cmd < -beta_max:
        beta_cmd = -beta_max
    if abs(beta_trim) > C.AP_BETA_ENV:
        if beta_trim > 0.0:
            beta_cmd = -beta_max
        else:
            beta_cmd = beta_max

    # Feasible reference shaping: bandwidth and acceleration budget follow
    # the dynamic pressure so a low-q airframe is never asked for an
    # unattainable angle-of-attack rate.  Pitch and yaw get separate limits
    # because the yaw moment authority (CN_DR) is far smaller and the side
    # force is only ~1/3 of CN_alpha.
    ref_q = C.AP_REF_Q
    ratio_y = (cn_alpha - C.CN_ALPHA_BODY) / (10.17 - C.CN_ALPHA_BODY)
    ratio_y = min(max(ratio_y, 0.2), 2.0)
    cm_de_pf = max((cn_alpha - C.CN_ALPHA_BODY) * C.FIN_LEVER / C.LENGTH,
                   1.0e-3)
    cm_dr_pf = abs(C.CN_DR) * ratio_y
    filter_hz_base = prefilter_hz * math.sqrt(max(q_dyn, 1.0) / ref_q)
    filter_hz = filter_hz_base
    if filter_hz < C.AP_PREFILTER_HZ_MIN:
        filter_hz = C.AP_PREFILTER_HZ_MIN
    elif filter_hz > prefilter_hz:
        filter_hz = prefilter_hz
    # The yaw factor is applied to the unclipped base bandwidth, mirroring the
    # Python path: clipping first would slow the yaw channel by an extra
    # sqrt(q/q_ref) whenever the pitch bandwidth saturates.
    filter_hz_y = filter_hz_base * math.sqrt(
        min(max(cm_dr_pf / cm_de_pf, 0.2), 1.0))
    if filter_hz_y < C.AP_PREFILTER_HZ_MIN:
        filter_hz_y = C.AP_PREFILTER_HZ_MIN
    elif filter_hz_y > prefilter_hz:
        filter_hz_y = prefilter_hz
    wn = 2.0 * math.pi * filter_hz
    wn_y = 2.0 * math.pi * filter_hz_y

    if C.MASS0 > C.DRY_MASS:
        fuel_f = min(max((mass - C.DRY_MASS) / (C.MASS0 - C.DRY_MASS),
                         0.0), 1.0)
    else:
        fuel_f = 0.0
    iyy = C.IYY_DRY + fuel_f * (C.IYY_FULL - C.IYY_DRY)
    izz = C.IZZ_DRY + fuel_f * (C.IZZ_FULL - C.IZZ_DRY)
    accel_limit = (C.AP_REF_GOV_ACCEL_MARGIN * qS * C.LENGTH
                   * cm_de_pf * C.FIN_MAX / max(iyy, 1e-9))
    accel_limit_y = (C.AP_REF_GOV_ACCEL_MARGIN * qS * C.LENGTH
                     * cm_dr_pf * C.FIN_MAX / max(izz, 1e-9))
    rate_scale = math.sqrt(max(q_dyn, 1.0) / ref_q)
    rate_scale = min(max(rate_scale, 0.5), 2.0)
    rate_limit = C.AP_REF_RATE_MAX * rate_scale

    zeta = 0.707
    if state[13] < 0.5:
        state[0], state[1], state[2] = alpha_trim, 0.0, 1.0
        state[3], state[4], state[5] = beta_trim, 0.0, 1.0
        state[6], state[7] = 0.0, 1.0
        state[13] = 1.0

    dt_f = min(max(dt, 1e-6), 0.05)

    # alpha second-order pre-filter with acceleration and rate limiting
    xdd = wn * wn * (alpha_cmd - state[0]) - 2.0 * zeta * wn * state[1]
    if xdd > accel_limit:
        xdd = accel_limit
    elif xdd < -accel_limit:
        xdd = -accel_limit
    state[1] += xdd * dt_f
    v_allow = math.sqrt(2.0 * accel_limit * abs(alpha_cmd - state[0]))
    if v_allow > rate_limit:
        v_allow = rate_limit
    if state[1] > v_allow:
        state[1] = v_allow
    elif state[1] < -v_allow:
        state[1] = -v_allow
    state[0] += state[1] * dt_f
    alpha_ref = state[0]
    alpha_ref_dot = state[1]
    # beta second-order pre-filter with its own (weaker) authority budget
    xdd = wn_y * wn_y * (beta_cmd - state[3]) - 2.0 * zeta * wn_y * state[4]
    if xdd > accel_limit_y:
        xdd = accel_limit_y
    elif xdd < -accel_limit_y:
        xdd = -accel_limit_y
    state[4] += xdd * dt_f
    v_allow = math.sqrt(2.0 * accel_limit_y * abs(beta_cmd - state[3]))
    if v_allow > rate_limit:
        v_allow = rate_limit
    if state[4] > v_allow:
        state[4] = v_allow
    elif state[4] < -v_allow:
        state[4] = -v_allow
    state[3] += state[4] * dt_f
    beta_ref = state[3]
    beta_ref_dot = state[4]

    p, qq, r = omega[0], omega[1], omega[2]
    low_q = q_dyn < 100.0

    # Independent per-axis gain scheduling using live CG, fin lever and inertia.
    if C.MASS0 > C.DRY_MASS:
        ff = (mass - C.DRY_MASS) / (C.MASS0 - C.DRY_MASS)
        if ff < 0.0:
            ff = 0.0
        elif ff > 1.0:
            ff = 1.0
    else:
        ff = 0.0
    ixx = C.IXX_DRY + ff * (C.IXX_FULL - C.IXX_DRY)
    iyy = C.IYY_DRY + ff * (C.IYY_FULL - C.IYY_DRY)
    izz = C.IZZ_DRY + ff * (C.IZZ_FULL - C.IZZ_DRY)
    cg_now = C.CG_DRY + ff * (C.CG_FULL - C.CG_DRY)
    lever_now = fin_lever(cg_now)
    cm_de_val = (cn_alpha - C.CN_ALPHA_BODY) * lever_now / C.LENGTH
    if cm_de_val < 1.0e-3:
        cm_de_val = 1.0e-3
    q_sl = max(q_dyn, 1.0) * C.S_REF * C.LENGTH
    gain_scale_p = (C.AP_OMEGA_Q * iyy / (q_sl * cm_de_val)) / kp_rate
    if gain_scale_p < C.GAIN_SCALE_MIN:
        gain_scale_p = C.GAIN_SCALE_MIN
    elif gain_scale_p > C.GAIN_SCALE_MAX:
        gain_scale_p = C.GAIN_SCALE_MAX

    cm_dr_val = abs(C.CN_DR) * ratio_y
    if cm_dr_val < 1.0e-3:
        cm_dr_val = 1.0e-3
    gain_scale_y = (C.AP_OMEGA_R * izz / (q_sl * cm_dr_val)) / kp_rate_y
    if gain_scale_y < C.GAIN_SCALE_MIN:
        gain_scale_y = C.GAIN_SCALE_MIN
    elif gain_scale_y > C.GAIN_SCALE_MAX:
        gain_scale_y = C.GAIN_SCALE_MAX

    cl_da_val = abs(C.CL_DA) * ratio_y
    if cl_da_val < 1.0e-3:
        cl_da_val = 1.0e-3
    gain_scale_r = (C.AP_OMEGA_P * ixx / (q_sl * cl_da_val)) / kp_roll
    if gain_scale_r < C.GAIN_SCALE_MIN:
        gain_scale_r = C.GAIN_SCALE_MIN
    elif gain_scale_r > C.GAIN_SCALE_MAX:
        gain_scale_r = C.GAIN_SCALE_MAX

    freeze = (is_saturated > 0.5) or low_q
    ki_scale = math.sqrt(max(q_dyn, 1.0) / ref_q)
    if ki_scale > 1.0:
        ki_scale = 1.0
    elif ki_scale < C.AP_KI_LOW_Q_FLOOR:
        ki_scale = C.AP_KI_LOW_Q_FLOOR

    e_alpha = alpha_ref - alpha_trim
    e_beta = beta_ref - beta_trim
    bleed = max(1.0 - dt_f / 0.12, 0.0)
    if not freeze:
        if state[8] * e_alpha < 0.0:
            state[8] *= bleed
        if state[9] * e_beta < 0.0:
            state[9] *= bleed
        state[8] += e_alpha * dt_f
        state[9] += e_beta * dt_f
    state[8] = min(max(state[8], -0.15), 0.15)
    state[9] = min(max(state[9], -0.15), 0.15)
    ki_angle_eff = ki_angle * ki_scale
    ki_angle_y_eff = ki_angle_y * ki_scale
    q_cmd = alpha_ref_dot + kp_angle * e_alpha + ki_angle_eff * state[8]
    r_cmd = -(beta_ref_dot + kp_angle_y * e_beta + ki_angle_y_eff * state[9])

    # Direct load-factor loop on body -Z (q-scheduled to match Python path).
    if kp_nz != 0.0 or ki_nz != 0.0:
        nz_q_scale = (q_dyn - 80000.0) / 140000.0
        if nz_q_scale < 0.25:
            nz_q_scale = 0.25
        elif nz_q_scale > 1.0:
            nz_q_scale = 1.0
        n_used = n_meas
        if nz_lead > 0.0:
            tau_l = C.AP_NZ_LEAD_LPF
            n_f = state[28] + dt_f / tau_l * (n_meas - state[28])
            state[28] = min(max(n_f, -50.0), 50.0)
            n_dot = (n_meas - state[28]) / tau_l
            n_used = n_meas + nz_lead * n_dot
        e_n = -ab2 / C.G0 - n_used
        if not freeze:
            if state[27] * e_n < 0.0:
                state[27] *= bleed
            state[27] += e_n * dt_f
        state[27] = min(max(state[27], -15.0), 15.0)
        q_cmd += nz_q_scale * (kp_nz * e_n + ki_nz * state[27])

    e_q = q_cmd - qq
    e_r = r_cmd - r
    if not freeze:
        if state[10] * e_q < 0.0:
            state[10] *= bleed
        if state[11] * e_r < 0.0:
            state[11] *= bleed
        state[10] += e_q * dt_f
        state[11] += e_r * dt_f
    state[10] = min(max(state[10], -1.5), 1.5)
    state[11] = min(max(state[11], -1.5), 1.5)

    kp_p = kp_rate * gain_scale_p
    ki_p = ki_rate * gain_scale_p * 0.15 * ki_scale
    kp_y = kp_rate_y * gain_scale_y
    ki_y = ki_rate_y * gain_scale_y * 0.15 * ki_scale
    d_p_raw = -kp_p * e_q - ki_p * state[10]
    d_y_raw = kp_y * e_r + ki_y * state[11]

    # Model feed-forward trim using live CG, live fin lever and conservative margin.
    cm_de_ff = max((cn_alpha - C.CN_ALPHA_BODY) * lever_now / C.LENGTH,
                   1.0e-3)
    sm_ff = max(0.58 + (C.CG_FULL - cg_now), 0.25)
    cm_alpha_ff = cn_alpha * sm_ff / C.LENGTH
    trim_raw = -alpha_ref * cm_alpha_ff / cm_de_ff
    if state[7] < 0.5:
        state[6] = trim_raw
        state[7] = 1.0
    else:
        a_f = dt_f / max(C.AP_TRIM_FF_TAU, 1e-6)
        if a_f > 1.0:
            a_f = 1.0
        state[6] += a_f * (trim_raw - state[6])
    d_p_raw += C.AP_TRIM_FF_GAIN * state[6]

    if not freeze:
        state[12] += (p_cmd - p) * dt_f
    else:
        state[12] *= 0.98
    state[12] = min(max(state[12], -1.0), 1.0)
    d_r_raw = kp_roll * gain_scale_r * (p_cmd - p) + ki_roll * gain_scale_r * state[12]
    d_p = min(max(d_p_raw, -C.FIN_MAX), C.FIN_MAX)
    d_y = min(max(d_y_raw, -C.FIN_MAX), C.FIN_MAX)
    d_r = min(max(d_r_raw, -C.FIN_MAX), C.FIN_MAX)

    # Mixer/actuator in the loop: lag -> rate limit -> position limit.
    t0 = d_y
    t1 = d_y
    t2 = d_p - d_r
    t3 = d_p + d_r
    max_step = C.FIN_RATE_MAX * dt_f
    alpha_m = dt_f / (C.FIN_TAU + dt_f)
    for i in range(4):
        if i == 0:
            tgt = t0
        elif i == 1:
            tgt = t1
        elif i == 2:
            tgt = t2
        else:
            tgt = t3
        step_m = alpha_m * (tgt - state[23 + i])
        if step_m > max_step:
            step_m = max_step
        elif step_m < -max_step:
            step_m = -max_step
        f_obs = state[23 + i] + step_m
        if f_obs > C.FIN_MAX:
            f_obs = C.FIN_MAX
        elif f_obs < -C.FIN_MAX:
            f_obs = -C.FIN_MAX
        state[23 + i] = f_obs
    d_y_a = 0.5 * (state[23] + state[24])
    d_p_a = 0.5 * (state[25] + state[26])
    d_r_a = 0.5 * (state[26] - state[25])
    state[16] = d_p_a
    state[19] = d_y_a
    state[22] = d_r_a
    # Cascade-PID back-calculation anti-windup using pre-clip command shortfall.
    if not freeze:
        d_p_lim = min(max(d_p_raw, -2.0 * C.FIN_MAX), 2.0 * C.FIN_MAX)
        d_y_lim = min(max(d_y_raw, -2.0 * C.FIN_MAX), 2.0 * C.FIN_MAX)
        d_r_lim = min(max(d_r_raw, -2.0 * C.FIN_MAX), 2.0 * C.FIN_MAX)
        if ki_p > 1e-9:
            state[10] += 0.5 * (d_p_lim - d_p_a) / ki_p
        if ki_y > 1e-9:
            state[11] -= 0.5 * (d_y_lim - d_y_a) / ki_y
        state[10] = min(max(state[10], -1.5), 1.5)
        state[11] = min(max(state[11], -1.5), 1.5)
        ikr = ki_roll * gain_scale_r
        if ikr < 1e-6:
            ikr = 1e-6
        state[12] += 0.5 * (d_r_lim - d_r_a) / ikr
        state[12] = min(max(state[12], -1.0), 1.0)
    # d_p/d_y/d_r keep the unmodified virtual command (see Python path).

    out = np.empty(3)
    out[0] = min(max(d_p, -C.FIN_MAX), C.FIN_MAX)
    out[1] = min(max(d_y, -C.FIN_MAX), C.FIN_MAX)
    out[2] = min(max(d_r, -C.FIN_MAX), C.FIN_MAX)
    return out


# ============================================================
# Fin mixer: virtual -> four physical fins
# ============================================================
@njit(cache=True, nogil=True)
def fin_mixer_mix(virtual, fins, fin_rates, dt, omega_n, zeta, rate_max,
                  pos_max, q_dyn):
    """Compiled equivalent of ``FinMixer.mix`` (2nd-order servo + hinge torque).

    Mutates ``fins`` and ``fin_rates`` in place with zero heap allocation.
    """
    d_p, d_y, d_r = virtual[0], virtual[1], virtual[2]
    t0 = d_y
    t1 = d_y
    t2 = d_p - d_r
    t3 = d_p + d_r

    pos_eff = pos_max
    if q_dyn > C.FIN_HINGE_Q_REF:
        scale = (C.FIN_HINGE_Q_REF / q_dyn) ** C.FIN_HINGE_EXP
        if scale < C.FIN_HINGE_MIN_SCALE:
            scale = C.FIN_HINGE_MIN_SCALE
        pos_eff = pos_max * scale

    h = dt * 0.25
    wn2 = omega_n * omega_n
    two_z_wn = 2.0 * zeta * omega_n
    rate_limited = False
    pos_limited = False
    for i in range(4):
        x = fins[i]
        v = fin_rates[i]
        if i == 0:
            tgt = t0
        elif i == 1:
            tgt = t1
        elif i == 2:
            tgt = t2
        else:
            tgt = t3
        for _ in range(4):
            acc = wn2 * (tgt - x) - two_z_wn * v
            v_raw = v + acc * h
            if abs(v_raw) > rate_max + 1e-12:
                rate_limited = True
            if v_raw > rate_max:
                v = rate_max
            elif v_raw < -rate_max:
                v = -rate_max
            else:
                v = v_raw
            x_raw = x + v * h
            if abs(x_raw) > pos_eff + 1e-12:
                pos_limited = True
            if x_raw > pos_eff:
                x = pos_eff
                if v > 0.0:
                    v = 0.0
            elif x_raw < -pos_eff:
                x = -pos_eff
                if v < 0.0:
                    v = 0.0
            else:
                x = x_raw
        fins[i] = x
        fin_rates[i] = v
    return rate_limited or pos_limited


# ============================================================
# Telemetry frame write
# ============================================================
@njit(cache=True, nogil=True)
def telemetry_write(data, n, t, vals, last_time):
    """Validate and append one telemetry frame.

    Returns ``(n, last_time, status)`` with status 0=ok, -1=overflow,
    -2=non-finite, -3=non-increasing time.
    """
    m = vals.size
    for i in range(m):
        if not math.isfinite(vals[i]):
            return n, last_time, -2
    if n >= data.shape[0]:
        return n, last_time, -1
    if t <= last_time + 1e-12:
        return n, last_time, -3
    data[n, 0] = t
    for i in range(m):
        data[n, i + 1] = vals[i]
    return n + 1, t, 0


# ============================================================
# 3-Model IMM Target Tracker Prediction + Moment-Matched Fusion
# ============================================================
@njit(cache=True, nogil=True)
def _imm_singer_predict_inplace(x, P, dt, tau, sigma_a, F, tmp):
    """In-place 9-state Singer prediction matching ``_singer_predict``."""
    a_s = 1.0 / (tau if tau > 0.05 else 0.05)
    adt = a_s * dt
    e = math.exp(-adt)
    if adt > 1e-4:
        f_ra = (adt - 1.0 + e) / (a_s * a_s)
        f_va = (1.0 - e) / a_s
    else:
        f_ra = 0.5 * dt * dt * (1.0 - adt / 3.0)
        f_va = dt * (1.0 - 0.5 * adt)

    for i in range(3):
        r_i = x[i]
        v_i = x[i + 3]
        a_i = x[i + 6]
        x[i] = r_i + dt * v_i + f_ra * a_i
        x[i + 3] = v_i + f_va * a_i
        x[i + 6] = e * a_i

    for i in range(9):
        for j in range(9):
            F[i, j] = 1.0 if i == j else 0.0
    for i in range(3):
        F[i, i + 3] = dt
        F[i, i + 6] = f_ra
        F[i + 3, i + 6] = f_va
        F[i + 6, i + 6] = e

    # tmp = F @ P, then P = tmp @ F.T
    for i in range(9):
        for j in range(9):
            s = 0.0
            for k in range(9):
                s += F[i, k] * P[k, j]
            tmp[i, j] = s
    for i in range(9):
        for j in range(9):
            s = 0.0
            for k in range(9):
                s += tmp[i, k] * F[j, k]
            P[i, j] = s

    q_psd = 2.0 * a_s * (sigma_a * sigma_a)
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    dt5 = dt4 * dt
    q_rr = q_psd * dt5 / 20.0
    q_rv = q_psd * dt4 / 8.0
    q_ra = q_psd * dt3 / 6.0
    q_vv = q_psd * dt3 / 3.0
    q_va = q_psd * dt2 / 2.0
    q_aa = (sigma_a * sigma_a) * (1.0 - e * e if 1.0 - e * e > 0.0 else 0.0)
    for i in range(3):
        P[i, i] += q_rr
        P[i, i + 3] += q_rv
        P[i + 3, i] += q_rv
        P[i, i + 6] += q_ra
        P[i + 6, i] += q_ra
        P[i + 3, i + 3] += q_vv
        P[i + 3, i + 6] += q_va
        P[i + 6, i + 3] += q_va
        P[i + 6, i + 6] += q_aa


@njit(cache=True, nogil=True)
def _imm_rodrigues(kx, ky, kz, angle, R):
    c = math.cos(angle)
    s = math.sin(angle)
    omc = 1.0 - c
    R[0, 0] = c + kx * kx * omc
    R[0, 1] = kx * ky * omc - kz * s
    R[0, 2] = kx * kz * omc + ky * s
    R[1, 0] = ky * kx * omc + kz * s
    R[1, 1] = c + ky * ky * omc
    R[1, 2] = ky * kz * omc - kx * s
    R[2, 0] = kz * kx * omc - ky * s
    R[2, 1] = kz * ky * omc + kx * s
    R[2, 2] = c + kz * kz * omc


@njit(cache=True, nogil=True)
def _imm_ct3d_predict_inplace(x, P, dt, sigma_a, F, tmp, R_rot, R_half):
    """In-place 9-state 3D Coordinated Turn prediction matching ``_ct3d_predict``."""
    v0, v1, v2 = x[3], x[4], x[5]
    a0, a1, a2 = x[6], x[7], x[8]
    v2_n = v0 * v0 + v1 * v1 + v2 * v2
    inv_v2 = 1.0 / (v2_n if v2_n > 100.0 else 100.0)
    wx = (v1 * a2 - v2 * a1) * inv_v2
    wy = (v2 * a0 - v0 * a2) * inv_v2
    wz = (v0 * a1 - v1 * a0) * inv_v2
    w_norm = math.sqrt(wx * wx + wy * wy + wz * wz)
    if w_norm > 0.5:
        sc = 0.5 / w_norm
        wx *= sc
        wy *= sc
        wz *= sc
        w_norm = 0.5

    theta = w_norm * dt
    if theta <= 1e-4:
        _imm_singer_predict_inplace(x, P, dt, 5.5, sigma_a, F, tmp)
        return

    inv_w = 1.0 / w_norm
    kx, ky, kz = wx * inv_w, wy * inv_w, wz * inv_w
    _imm_rodrigues(kx, ky, kz, theta, R_rot)
    _imm_rodrigues(kx, ky, kz, 0.5 * theta, R_half)
    damp = math.exp(-dt / 6.0)

    r0, r1, r2 = x[0], x[1], x[2]
    x[0] = r0 + (R_half[0, 0] * v0 + R_half[0, 1] * v1 + R_half[0, 2] * v2) * dt
    x[1] = r1 + (R_half[1, 0] * v0 + R_half[1, 1] * v1 + R_half[1, 2] * v2) * dt
    x[2] = r2 + (R_half[2, 0] * v0 + R_half[2, 1] * v1 + R_half[2, 2] * v2) * dt
    x[3] = R_rot[0, 0] * v0 + R_rot[0, 1] * v1 + R_rot[0, 2] * v2
    x[4] = R_rot[1, 0] * v0 + R_rot[1, 1] * v1 + R_rot[1, 2] * v2
    x[5] = R_rot[2, 0] * v0 + R_rot[2, 1] * v1 + R_rot[2, 2] * v2
    x[6] = damp * (R_rot[0, 0] * a0 + R_rot[0, 1] * a1 + R_rot[0, 2] * a2)
    x[7] = damp * (R_rot[1, 0] * a0 + R_rot[1, 1] * a1 + R_rot[1, 2] * a2)
    x[8] = damp * (R_rot[2, 0] * a0 + R_rot[2, 1] * a1 + R_rot[2, 2] * a2)

    for i in range(9):
        for j in range(9):
            F[i, j] = 1.0 if i == j else 0.0
    half_dt2 = 0.5 * dt * dt
    for i in range(3):
        F[i, i + 6] = half_dt2
        for j in range(3):
            F[i, j + 3] = R_half[i, j] * dt
            F[i + 3, j + 3] = R_rot[i, j]
            F[i + 3, j + 6] = dt * R_half[i, j]
            F[i + 6, j + 6] = damp * R_rot[i, j]

    for i in range(9):
        for j in range(9):
            s = 0.0
            for k in range(9):
                s += F[i, k] * P[k, j]
            tmp[i, j] = s
    for i in range(9):
        for j in range(9):
            s = 0.0
            for k in range(9):
                s += tmp[i, k] * F[j, k]
            P[i, j] = s

    a_s = 1.0 / 5.5
    q_psd = 2.0 * a_s * (sigma_a * sigma_a)
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt3 * dt
    dt5 = dt4 * dt
    q_rr = q_psd * dt5 / 20.0
    q_rv = q_psd * dt4 / 8.0
    q_ra = q_psd * dt3 / 6.0
    q_vv = q_psd * dt3 / 3.0
    q_va = q_psd * dt2 / 2.0
    e2 = math.exp(-2.0 * a_s * dt)
    q_aa = (sigma_a * sigma_a) * (1.0 - e2 if 1.0 - e2 > 0.0 else 0.0)
    for i in range(3):
        P[i, i] += q_rr
        P[i, i + 3] += q_rv
        P[i + 3, i] += q_rv
        P[i, i + 6] += q_ra
        P[i + 6, i] += q_ra
        P[i + 3, i + 3] += q_vv
        P[i + 3, i + 6] += q_va
        P[i + 6, i + 3] += q_va
        P[i + 6, i + 6] += q_aa


@njit(cache=True, nogil=True)
def imm_predict_all(xs, Ps, mode_probs, dt, maneuver_tau, sigma_a, cov_floor,
                    x_out, P_out, F, tmp, R_rot, R_half):
    """Fused 3-model IMM predict (CV + CA + 3D-CT) + moment-matched combination."""
    _imm_singer_predict_inplace(xs[0], Ps[0], dt, 0.6, 2.0, F, tmp)
    _imm_singer_predict_inplace(xs[1], Ps[1], dt, maneuver_tau, sigma_a, F, tmp)
    ct_sig = 0.80 * sigma_a
    if ct_sig < 9.0:
        ct_sig = 9.0
    _imm_ct3d_predict_inplace(xs[2], Ps[2], dt, ct_sig, F, tmp, R_rot, R_half)

    m0, m1, m2 = mode_probs[0], mode_probs[1], mode_probs[2]
    for i in range(9):
        x_out[i] = m0 * xs[0, i] + m1 * xs[1, i] + m2 * xs[2, i]

    for i in range(9):
        for j in range(9):
            P_out[i, j] = 0.0

    for k in range(3):
        mk = mode_probs[k]
        for i in range(9):
            dxi = xs[k, i] - x_out[i]
            for j in range(9):
                dxj = xs[k, j] - x_out[j]
                P_out[i, j] += mk * (Ps[k, i, j] + dxi * dxj)

    for i in range(9):
        for j in range(i, 9):
            v = 0.5 * (P_out[i, j] + P_out[j, i])
            P_out[i, j] = v
            P_out[j, i] = v
        if P_out[i, i] < cov_floor:
            P_out[i, i] = cov_floor

