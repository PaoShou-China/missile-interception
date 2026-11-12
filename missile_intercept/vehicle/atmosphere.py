"""US Standard Atmosphere 1976 (0-86 km layers + exponential extension).

Interface: ``get_atmosphere(altitude) -> AtmosphereState``.

The 0-86 km region uses the tabulated geometric layers with linear lapse
rates.  Above 86 km an isothermal exponential tail is used.  The tail is
anchored exactly at the 86 km value, so there is no density/pressure jump at
the table top.

Ref: USSA1976 (NASA-TM-X-74335), layers 0-84.852 km plus 86 km extension.
"""

import math
from bisect import bisect_right
from dataclasses import dataclass
import config as C

# 0-86 km layers: base height (m), base temperature (K), lapse rate (K/m)
_LAYERS = [
    (0.0, 288.15, -0.0065),
    (11000.0, 216.65, 0.0),
    (20000.0, 216.65, 0.0010),
    (32000.0, 228.65, 0.0028),
    (47000.0, 270.65, 0.0),
    (51000.0, 270.65, -0.0028),
    (71000.0, 214.65, -0.0020),
    (84852.0, 186.946, 0.0),
]
_LAYER_HEIGHTS = [layer[0] for layer in _LAYERS]
_TABLE_TOP = 86000.0
_H_SCALE = 6000.0      # Exponential scale height above 86 km, m


@dataclass
class AtmosphereState:
    """Local atmospheric state (SI units)."""
    altitude: float
    temperature: float   # K
    pressure: float      # Pa
    density: float       # kg/m^3
    sound_speed: float   # m/s


def _layer_base_state():
    """Pre-compute pressure and density at each layer base."""
    bases = []
    p = C.P_SL
    for i, (h, t, lapse) in enumerate(_LAYERS):
        if i > 0:
            hp, tp, lp = _LAYERS[i - 1]
            dh = h - hp
            if abs(lp) < 1e-12:
                p *= math.exp(-C.G0 * dh / (C.R_AIR * tp))
            else:
                t_new = tp + lp * dh
                p *= (t_new / tp) ** (-C.G0 / (C.R_AIR * lp))
        bases.append(p)
    return bases


_BASE_PRESSURE = _layer_base_state()

# Anchor the exponential tail at exactly 86 km (no seam discontinuity).
_T86 = _LAYERS[-1][1]
_P84 = _BASE_PRESSURE[-1]
_P86 = _P84 * math.exp(-C.G0 * (_TABLE_TOP - _LAYERS[-1][0]) / (C.R_AIR * _T86))
_RHO86 = _P86 / (C.R_AIR * _T86)


def get_atmosphere(altitude):
    """Return the atmospheric state at ``altitude`` (clipped to 0-200 km)."""
    h = float(altitude)
    if h < 0.0:
        h = 0.0
    elif h > 200000.0:
        h = 200000.0

    if h <= _TABLE_TOP:
        idx = bisect_right(_LAYER_HEIGHTS, h) - 1
        if idx < 0:
            idx = 0
        hb, tb, lapse = _LAYERS[idx]
        pb = _BASE_PRESSURE[idx]
        dh = h - hb
        if abs(lapse) < 1e-12:
            t = tb
            p = pb * math.exp(-C.G0 * dh / (C.R_AIR * tb))
        else:
            t = tb + lapse * dh
            p = pb * (t / tb) ** (-C.G0 / (C.R_AIR * lapse))
        rho = p / (C.R_AIR * max(t, 1.0))
    else:
        # Isothermal exponential extension above the table top.
        t = _T86
        decay = math.exp(-(h - _TABLE_TOP) / _H_SCALE)
        p = _P86 * decay
        rho = _RHO86 * decay

    if not (math.isfinite(t) and math.isfinite(p) and math.isfinite(rho)):
        raise FloatingPointError("Atmosphere model produced NaN/Inf at h=%.1f" % h)
    if t <= 0.0 or p <= 0.0 or rho <= 0.0:
        raise FloatingPointError("Atmosphere model produced non-positive state at h=%.1f" % h)

    a = math.sqrt(C.GAMMA_AIR * C.R_AIR * t)
    return AtmosphereState(altitude=h, temperature=t, pressure=p,
                           density=rho, sound_speed=a)
