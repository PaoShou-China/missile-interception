"""Lifting-body / waverider interceptor: aero, propulsion, mass and 6DOF.

Frame convention: ECI is the propagation frame; body axes are X forward,
Y right and Z down.  M <= 5 coefficients come from an embedded Digital
DATCOM table (body + cruciform fins, see tools/datcom_aero.py); above M = 5
the lift slope follows a shock-expansion trend anchored at the DATCOM M = 5
value, with a modified-Newtonian cap at high alpha.

Moment convention
-----------------
The pitching moment is built from the normal force acting at the aerodynamic
centre, CM = -(x_ac - x_cg)/L * CN + CM_de * delta.  The Mach-dependent
static margin therefore enters once and only once; it reproduces the DATCOM
CM_alpha = -0.51 1/rad at M = 2 and follows the table up to M = 5.  There is
no separate cp-cg force lever arm, so double counting cannot reappear.

References
----------
- PyDATCOM / datcom-parser axis conventions and cruciform symmetry
- DTIC-ThrustAlt altitude thrust correction F = F_sl + A_e (P_sl - P_a)
- METU-VarMass linear mass/inertia decay and CG migration
- KAIST-FlightData load-factor / fin-saturation order of magnitude
"""

import math
import numpy as np
import config as C
import fastcore as FC
import math_utils as MU
from vehicle.atmosphere import get_atmosphere


# ------------------------------------------------------------
# Mach-dependent aerodynamic coefficients
#
# Four layers, from lowest to highest fidelity:
#   1. M <= 5 : DATCOM-style analytic trends (subsonic plateau, transonic
#      peak, supersonic decay) used as the engineering baseline;
#   2. M > 5  : lift slope decays with a slope-continuous exponent instead of
#      a linear extrapolation;
#   3. M > 5  : modified-Newtonian saturation of the normal force with
#      sin^2(alpha), valid once the small-disturbance assumptions fail;
#   4. all M  : aerodynamic-centre migration (CR-2835 trend) enters the
#      pitching moment through a force-based lever arm.
# ------------------------------------------------------------
def cp_max(mach):
    """Modified-Newtonian stagnation pressure coefficient Cp_max(M).

    Cp_max = 2/(gamma*M^2) * (p02/p1 - 1), with p02/p1 taken from the normal
    shock (Rayleigh pitot) relation.  Cp_max -> 1.84 as M -> infinity for
    gamma = 1.4, which is the correct Newtonian asymptote.
    """
    g = C.GAMMA_AIR - C.GAMMA_HYP_DROP * min(max((float(mach) - 5.0) / 5.0, 0.0), 1.0)
    m2 = max(float(mach) * float(mach), 1.0)
    p02 = ((g + 1.0) ** 2 * m2 / (4.0 * g * m2 - 2.0 * (g - 1.0))) ** (g / (g - 1.0))
    p02 *= (1.0 - g + 2.0 * g * m2) / (g + 1.0)
    return 2.0 / (g * m2) * (p02 - 1.0)


def _table(mach, xs, ys):
    """Linear interpolation of a monotone Mach/alpha table."""
    m = float(mach)
    if m <= xs[0]:
        return float(ys[0])
    if m >= xs[-1]:
        return float(ys[-1])
    for i in range(1, xs.size):
        if m <= xs[i]:
            w = (m - xs[i - 1]) / (xs[i] - xs[i - 1])
            return float((1.0 - w) * ys[i - 1] + w * ys[i])
    return float(ys[-1])


def _bridge_bump(mach):
    """Unit bump over the DATCOM transonic gap (0 outside, 1 at centre)."""
    m = float(mach)
    if m <= C.AERO_BRIDGE_LO or m >= C.AERO_BRIDGE_HI:
        return 0.0
    w = (m - C.AERO_BRIDGE_LO) / (C.AERO_BRIDGE_HI - C.AERO_BRIDGE_LO)
    return 4.0 * w * (1.0 - w)


def cn_alpha(mach):
    """Normal-force slope CN_alpha(M), 1/rad, referenced to S_REF.

    DATCOM table for M <= 5 with the conservative transonic derate; above
    M = 5 the shock-expansion trend of the swept fin (anchored at the DATCOM
    M = 5 value) replaces the previous empirical power law.
    """
    m = float(mach)
    if m <= 5.0:
        base = _table(m, C.AERO_MACH, C.AERO_CN_ALPHA)
        return base * (1.0 - C.AERO_BRIDGE_CN_DERATE * _bridge_bump(m))
    return _table(m, C.AERO_HYP_MACH, C.AERO_HYP_CN_ALPHA)


def static_margin(mach, cg=None):
    """Aerodynamic-centre offset from the instantaneous CG, m (stable > 0).

    The M = 2 DATCOM value is 0.61 m (CM_alpha/CN_alpha lever arm); the
    table below rebuilds it for every Mach up to M = 5, and the fuel-burn CG
    migration adds (CG_FULL - cg).
    """
    m = min(float(mach), 5.0)
    cna = _table(m, C.AERO_MACH, C.AERO_CN_ALPHA)
    cma = _table(m, C.AERO_MACH, C.AERO_CM_ALPHA)
    margin = -cma * C.LENGTH / cna
    if cg is None:
        cg = C.CG_FULL
    return margin + (C.CG_FULL - float(cg))


def cm_gain(mach, alpha):
    """Extra high-alpha moment growth measured from DATCOM CM(alpha)."""
    m = min(max(float(mach), C.AERO_CM_GAIN_MACH[0]), C.AERO_CM_GAIN_MACH[-1])
    g = _table(m, C.AERO_CM_GAIN_MACH, C.AERO_CM_GAIN)
    w = (abs(float(alpha)) / C.DEG - C.AERO_CM_GAIN_ALPHA[0]) / (
        C.AERO_CM_GAIN_ALPHA[1] - C.AERO_CM_GAIN_ALPHA[0])
    w = min(max(w, 0.0), 1.0)
    return 1.0 + (g - 1.0) * w


def fin_lever():
    """Longitudinal arm from the CG to the fin quarter-MAC, m."""
    cr, ct = C.ROOT_CHORD, C.TIP_CHORD
    b = C.WING_SPAN
    mac = (2.0 / 3.0) * (cr + ct - cr * ct / (cr + ct))
    y_mac = (b / 3.0) * (cr + 2.0 * ct) / (cr + ct)
    sweep = math.atan((cr - ct) / (b + 0.5 * C.DIAMETER))
    x_ac = (C.LENGTH - cr) + y_mac * math.tan(sweep) + 0.25 * mac
    return float(x_ac - C.CG_FULL)


def cm_de(mach):
    """Fin pitch effectiveness from the DATCOM fin lift slope and lever arm."""
    lever = fin_lever()
    return -(cn_alpha(mach) - C.CN_ALPHA_BODY) * lever / C.LENGTH


def fin_effective(delta):
    """Fin deflection with the DATCOM-calibrated effectiveness roll-off."""
    d = float(delta)
    return d * (1.0 - C.FIN_EFF_DROP * (abs(d) / C.FIN_MAX) ** 2)


def _viscosity(t):
    """Sutherland dynamic viscosity, Pa*s."""
    t = max(float(t), 1.0)
    return 1.458e-6 * t ** 1.5 / (t + 110.4)


def friction_delta(alt, speed):
    """CD0 increment from the Reynolds-number change with altitude.

    DATCOM tabulated the polar at sea-level Reynolds number; the turbulent
    flat-plate friction coefficient rises as Re falls, so CD0 must be
    corrected by (Cf(Re) - Cf(Re_ref)) * S_wet / S_ref.
    """
    if alt is None or speed is None:
        return 0.0
    atm = get_atmosphere(max(float(alt), 0.0))
    v = max(float(speed), 1.0)
    re = atm.density * v * C.LENGTH / _viscosity(atm.temperature)
    re_ref = C.RHO_SL * v * C.LENGTH / C.MU_SL
    cf = 0.074 / max(re, 1.0) ** C.RE_EXPONENT
    cf_ref = 0.074 / max(re_ref, 1.0) ** C.RE_EXPONENT
    return float(np.clip((cf - cf_ref) * C.S_WET_RATIO, -0.03, 0.20))


def _alpha_shape(alpha, table):
    """Interpolate an |alpha|-indexed shape table (degrees)."""
    a = abs(float(alpha)) / C.DEG
    xs = C.AERO_ALPHA_DEG
    if a <= xs[0]:
        return float(table[0])
    if a >= xs[-1]:
        return float(table[-1])
    for i in range(1, xs.size):
        if a <= xs[i]:
            w = (a - xs[i - 1]) / (xs[i] - xs[i - 1])
            return float((1.0 - w) * table[i - 1] + w * table[i])
    return float(table[-1])


def cn_shape(alpha):
    """Crossflow lift-line shape factor CN / (CN_alpha * alpha), DATCOM fit."""
    return _alpha_shape(alpha, C.AERO_CN_SHAPE)


def k_shape(alpha):
    """Large-angle efficiency factor applied to the induced-drag factor."""
    return _alpha_shape(alpha, C.AERO_K_SHAPE)


def induced_k(mach):
    """Lift-dependent drag factor CD_i = k(M) * CN^2."""
    return _table(mach, C.AERO_MACH, C.AERO_INDUCED_K)


def fin_slope_ratio(mach):
    """Fin/control effectiveness relative to the M = 2 DATCOM reference."""
    return (cn_alpha(mach) - C.CN_ALPHA_BODY) / (10.17 - C.CN_ALPHA_BODY)


def cd0(mach):
    """Zero-lift drag coefficient CD0(M), DATCOM table.

    Above M = 5 the Newtonian pressure-drag trend takes over: CD0 scales with
    the stagnation pressure coefficient instead of falling like a friction
    curve, because wave drag dominates.  The transonic bridge carries a
    conservative +10 % margin.
    """
    m = float(mach)
    if m <= 5.0:
        base = _table(m, C.AERO_MACH, C.AERO_CD0)
        return base * (1.0 + C.AERO_BRIDGE_CD_MARGIN * _bridge_bump(m))
    return float(C.AERO_CD0[-1]) * cp_max(m) / cp_max(5.0)


def boost_thrust_scale(t):
    """Normalised sea-level thrust profile of the solid booster.

    Piecewise-linear interpolation of ``BOOST_THRUST_T/F`` against burn-time
    fraction, so the booster has an ignition transient and a tail-off ramp
    instead of a constant thrust.  The profile is normalised to unit mean.
    """
    tn = float(t) / C.BOOST_BURN_TIME
    if tn <= C.BOOST_THRUST_T[0]:
        return float(C.BOOST_THRUST_F[0])
    for i in range(1, C.BOOST_THRUST_T.size):
        if tn <= C.BOOST_THRUST_T[i]:
            t0 = C.BOOST_THRUST_T[i - 1]
            t1 = C.BOOST_THRUST_T[i]
            w = (tn - t0) / max(t1 - t0, 1e-12)
            return float(C.BOOST_THRUST_F[i - 1] +
                         w * (C.BOOST_THRUST_F[i] - C.BOOST_THRUST_F[i - 1]))
    return float(C.BOOST_THRUST_F[-1])


def ramjet_efficiency(mach, altitude):
    """Air-breathing efficiency factors ``(eta_mach, eta_alt)``, each in [0, 1].

    Thrust is proportional to ``q * A_inlet * eta_mach * eta_alt * cos(alpha)``
    and the fuel flow follows from the resulting thrust and Isp.  The Mach
    term reproduces the published roll-off of thrust coefficient and Isp with
    increasing Mach; the altitude term keeps full efficiency through the
    stratosphere and falls linearly to zero at ``RAMJET_ALT_CUTOFF``, so the
    motor is starved and the vehicle transitions to unpowered glide.
    """
    m = float(mach)
    if m <= C.RAMJET_MACH_REF:
        eta_m = 1.0
    else:
        eta_m = max(1.0 - C.RAMJET_MACH_DECAY * (m - C.RAMJET_MACH_REF),
                    C.RAMJET_ETA_MIN)

    h = float(altitude)
    if h <= C.RAMJET_ALT_FULL:
        eta_h = 1.0
    elif h >= C.RAMJET_ALT_CUTOFF:
        eta_h = 0.0
    else:
        eta_h = 1.0 - (h - C.RAMJET_ALT_FULL) / (
            C.RAMJET_ALT_CUTOFF - C.RAMJET_ALT_FULL)
    return eta_m, eta_h


class Missile:
    """Interceptor model (stateless: every output depends on the inputs)."""

    def __init__(self, mass0=C.MASS0, dry_mass=C.DRY_MASS):
        self.mass0 = float(mass0)
        self.dry_mass = float(dry_mass)
        self.fuel0 = max(self.mass0 - self.dry_mass, 0.0)
        self.S = C.S_REF
        self.L = C.LENGTH

    # --------------------------------------------------------
    # Mass properties
    # --------------------------------------------------------
    def fuel_fraction(self, mass):
        if self.fuel0 <= 0.0:
            return 0.0
        f = (mass - self.dry_mass) / self.fuel0
        if f < 0.0:
            return 0.0
        if f > 1.0:
            return 1.0
        return f

    def inertia_diag(self, mass):
        """Principal inertia vector (kg*m^2), linear with fuel fraction."""
        f = self.fuel_fraction(mass)
        return np.array([
            C.IXX_DRY + f * (C.IXX_FULL - C.IXX_DRY),
            C.IYY_DRY + f * (C.IYY_FULL - C.IYY_DRY),
            C.IZZ_DRY + f * (C.IZZ_FULL - C.IZZ_DRY),
        ])

    def inertia(self, mass):
        """Principal inertia matrix for the state contract."""
        return np.diag(self.inertia_diag(mass))

    def cg_position(self, mass):
        """Centre of mass from the nose (m); fuel burn moves it forward."""
        f = self.fuel_fraction(mass)
        return C.CG_DRY + f * (C.CG_FULL - C.CG_DRY)

    def state_at(self, r_eci, v_eci, q, omega, mass):
        """Pack the inputs into the MissileState contract."""
        from config import MissileState
        return MissileState(
            r_eci=np.asarray(r_eci, dtype=float),
            v_eci=np.asarray(v_eci, dtype=float),
            q=np.asarray(q, dtype=float),
            omega_body=np.asarray(omega, dtype=float),
            mass=float(mass),
            inertia=self.inertia(mass),
            cg_pos=self.cg_position(mass),
        )

    # --------------------------------------------------------
    # Propulsion
    # --------------------------------------------------------
    def propulsion(self, t, mass, mach, altitude, q_dyn, alpha, atm=None,
                   throttle=1.0):
        """Combined-cycle thrust model.

        Returns ``(thrust, mdot, phase)``.
        - Solid booster: F = F_sl + A_e (P_sl - P_a), never a constant and
          not throttleable (``throttle`` is ignored during boost).
        - Ramjet: sensitive to Mach, altitude, dynamic pressure and alpha;
          ``throttle`` in [0, 1] scales the available thrust and therefore
          the fuel flow.  ``throttle=1`` is the open-loop full-thrust law.
        """
        fuel = max(mass - self.dry_mass, 0.0)
        if fuel <= 1e-6:
            return 0.0, 0.0, "coast"

        consumed = max(self.fuel0 - fuel, 0.0)
        if t < C.BOOST_BURN_TIME and consumed < C.BOOST_FUEL - 1e-6:
            if atm is None:
                atm = get_atmosphere(altitude)
            f_sl = C.BOOST_THRUST_SL * boost_thrust_scale(t)
            thrust = f_sl + C.NOZZLE_EXIT_AREA * (C.P_SL - atm.pressure)
            mdot = C.BOOST_FUEL / C.BOOST_BURN_TIME
            return max(float(thrust), 0.0), float(mdot), "boost"

        if (C.RAMJET_MACH_MIN <= mach <= C.RAMJET_MACH_MAX) and q_dyn > C.RAMJET_Q_MIN:
            eta_m, eta_h = ramjet_efficiency(mach, altitude)
            eta = eta_m * eta_h
            thr = min(max(float(throttle), 0.0), 1.0)
            if eta <= 1e-3 or thr <= 1e-6:
                return 0.0, 0.0, "coast"
            cos_alpha = min(max(math.cos(min(max(alpha, -0.6), 0.6)), 0.55), 1.0)
            t_avail = (C.RAMJET_COEFF * q_dyn * C.RAMJET_A_INLET
                       * eta * cos_alpha * thr)
            mdot = min(t_avail / (C.G0 * C.RAMJET_ISP), C.RAMJET_MDOT_MAX)
            mdot = min(mdot, fuel / 1e-3)   # never draw more than the remaining fuel
            thrust = min(mdot * C.G0 * C.RAMJET_ISP, C.RAMJET_THRUST_MAX)
            return max(float(thrust), 0.0), float(mdot), "ramjet"

        return 0.0, 0.0, "coast"

    # --------------------------------------------------------
    # Aerodynamics
    # --------------------------------------------------------
    def _virtual_fins(self, fins):
        """Map four physical fins to virtual (pitch, yaw, roll) deflections."""
        up, down, left, right = np.asarray(fins, dtype=float)
        d_p = 0.5 * (right + left)
        d_r = 0.5 * (right - left)
        d_y = 0.5 * (up + down)
        return d_p, d_y, d_r

    def aero_coefficients(self, mach, alpha, beta, fins, cg=None,
                          alt=None, speed=None):
        """Aerodynamic coefficients (body axes, S_REF reference area).

        ``cg`` is the instantaneous centre-of-mass station; it enters the
        pitching/yawing moment through the static-margin lever arm, so a
        burning booster (CG moving forward) becomes progressively more
        stable instead of keeping the all-up value frozen.  ``alt`` and
        ``speed`` enable the Reynolds-number correction of CD0.
        """
        cn_a = cn_alpha(mach)
        cn_body = cn_a * alpha * cn_shape(alpha)

        # Modified-Newtonian branch switch: above M = 5 the small-disturbance
        # lift line is replaced by the Newtonian sin^2(alpha) branch wherever
        # that branch carries more normal force, i.e. where linear theory has
        # lost validity.  Nothing is extrapolated beyond the two anchors.
        blend_m = (mach - C.MACH_NL_START) / (C.MACH_NL_FULL - C.MACH_NL_START)
        blend_m = min(max(blend_m, 0.0), 1.0)
        if blend_m > 0.0:
            cn_newton = (C.CN_NEWTON_SHAPE * cp_max(mach)
                         * math.sin(alpha) ** 2 * math.cos(alpha))
            if abs(cn_newton) > abs(cn_body):
                cn_body += blend_m * (math.copysign(abs(cn_newton), alpha) - cn_body)

        ratio = fin_slope_ratio(mach)
        d_p, d_y, d_r = self._virtual_fins(fins)
        d_pe = fin_effective(d_p)
        d_ye = fin_effective(d_y)
        d_re = fin_effective(d_r)
        cn = cn_body + 0.25 * d_pe
        cy = C.CY_BETA * ratio * beta + 0.25 * d_ye

        # Drag is defined in the velocity frame as CD = CD0 + k*CN^2 (DATCOM
        # polar).  The solver applies CA along the body axis, so rotate the
        # polar back: CD = CA*cos(alpha) + CN*sin(alpha).  Putting k*CN^2
        # directly into CA would count the lift-induced drag twice.
        cn_sin = cn * math.sin(alpha)
        denom = max(math.cos(alpha), 0.2)
        ca = (cd0(mach) + friction_delta(alt, speed)
              + induced_k(mach) * k_shape(alpha) * (cn * cn + cy * cy)
              - cn_sin) / denom
        ca = max(ca, 0.0)
        for d in (d_p, d_y, d_r):
            ca += C.FIN_CD * (abs(d) + C.FIN_CD_QUAD * d * d / C.FIN_MAX)

        # Force-based pitching moment: the normal force acts at the (Mach
        # dependent) aerodynamic centre taken from the DATCOM table.  The
        # lever arm is measured from the current CG, so fuel burn changes the
        # static margin.  cm_gain reproduces the DATCOM moment convexity
        # beyond ~6 deg, where the fixed lever arm alone is too weak.
        margin = static_margin(mach, cg)
        cm = (-margin / C.LENGTH * cn_body * cm_gain(mach, alpha)
              + cm_de(mach) * d_pe)
        cn_beta = C.CN_BETA * ratio * (margin / (C.X_REF - C.CG_FULL))

        # Secant slope CN/alpha is what the autopilot inverts; it equals
        # CN_ALPHA in the linear range and softens with Newtonian saturation.
        cn_a_eff = cn_body / alpha if abs(alpha) > 1e-4 else cn_a

        return {
            "CA": float(min(max(ca, 0.0), 3.0)),
            "CN": float(cn),
            "CY": float(cy),
            "CN_ALPHA": float(cn_a_eff),
            "CM": float(cm),
            "CN_YAW": float(-cn_beta * beta + C.CN_DR * ratio * d_ye),
            "CL": float(C.CL_DA * ratio * d_re),
            "d_p": d_p, "d_y": d_y, "d_r": d_r,
        }

    def freestream(self, r_eci, v_eci, wind=None):
        """Freestream state: altitude, Mach, dynamic pressure and air-relative V."""
        r = np.asarray(r_eci, dtype=float)
        v = np.asarray(v_eci, dtype=float)
        alt = MU.altitude(r)
        if alt < 0.0:
            alt = 0.0
        atm = get_atmosphere(alt)

        # Air-relative velocity: v - omega x r - wind.
        w = C.OMEGA_EARTH
        vx = v[0] + w * r[1]
        vy = v[1] - w * r[0]
        vz = v[2]
        if wind is not None:
            vx -= float(wind[0])
            vy -= float(wind[1])
            vz -= float(wind[2])
        speed = math.sqrt(vx * vx + vy * vy + vz * vz)
        mach = min(speed / max(atm.sound_speed, 1e-6), 30.0)
        q_dyn = max(0.5 * atm.density * speed * speed, 0.0)
        return {
            "alt": float(alt), "atm": atm,
            "v_rel": np.array([vx, vy, vz]),
            "speed": float(speed), "mach": float(mach), "q_dyn": float(q_dyn),
        }

    def body_angles_from_dcm(self, dcm, v_rel):
        """Angle of attack and sideslip from body-to-ECI DCM and relative V."""
        vx, vy, vz = v_rel
        # v_body = R^T v_rel
        u = dcm[0, 0] * vx + dcm[1, 0] * vy + dcm[2, 0] * vz
        vb = dcm[0, 1] * vx + dcm[1, 1] * vy + dcm[2, 1] * vz
        w = dcm[0, 2] * vx + dcm[1, 2] * vy + dcm[2, 2] * vz
        alpha = math.atan2(w, max(u, 1e-6))
        beta = math.atan2(vb, max(math.hypot(u, w), 1e-6))
        lim = 35.0 * C.DEG
        return (min(max(alpha, -lim), lim),
                min(max(beta, -lim), lim),
                np.array([u, vb, w]))

    # --------------------------------------------------------
    # Forces and moments
    # --------------------------------------------------------
    def forces_moments(self, r_eci, v_eci, q, omega_body, mass, fins, t,
                       fs=None, dcm=None, angles=None, throttle=1.0,
                       wind=None):
        """Return ``(F_eci, M_body, info)``; gravity is included in F_eci.

        ``throttle`` is the ZOH ramjet fuel-flow command in [0, 1]; the
        solid booster ignores it.  ``wind`` is the ZOH ECI wind vector.
        """
        mass = max(float(mass), self.dry_mass)
        if fs is None:
            fs = self.freestream(r_eci, v_eci, wind=wind)
        if dcm is None:
            dcm = MU.quat_to_dcm(q)
        if angles is None:
            angles = self.body_angles_from_dcm(dcm, fs["v_rel"])
        alpha, beta, vb = angles

        cg = self.cg_position(mass)
        coeff = self.aero_coefficients(
            fs["mach"], alpha, beta, fins, cg=cg,
            alt=fs["alt"], speed=fs["speed"])
        thrust, mdot, phase = self.propulsion(
            t, mass, fs["mach"], fs["alt"], fs["q_dyn"], alpha, fs["atm"],
            throttle=throttle)

        qS = fs["q_dyn"] * self.S
        # Body-axis force: drag aft (-X), side force (+Y), lift up (-Z).
        # The plume raises the base pressure while the motor is running, so a
        # small part of the DATCOM base drag is relieved with thrust on.
        base_relief = C.CD_BASE_PLUME * qS if thrust > 0.0 else 0.0
        Fb = np.array([
            -coeff["CA"] * qS + thrust + base_relief,
            coeff["CY"] * qS,
            -coeff["CN"] * qS,
        ])

        qSL = qS * self.L
        V = max(fs["speed"], 1.0)
        p, qq, r = omega_body
        q_hat = qq * self.L / (2.0 * V)
        r_hat = r * self.L / (2.0 * V)
        p_hat = p * self.L / (2.0 * V)

        # Static derivatives already include the cp-cg offset; only damping is
        # added here.
        Cm = coeff["CM"] + C.CM_Q * q_hat
        Cn = coeff["CN_YAW"] + C.CN_R * r_hat
        Cl = coeff["CL"] + C.CL_P * p_hat
        Mb = np.array([Cl, Cm, Cn]) * qSL

        # Gravity (central field + J2 in WGS84 mode).
        F_eci = dcm.dot(Fb) + mass * MU.gravity_eci(r_eci)

        info = {
            "alt": fs["alt"],
            "mach": fs["mach"],
            "q_dyn": fs["q_dyn"],
            "alpha": alpha,
            "beta": beta,
            "thrust": thrust,
            "mdot": mdot,
            "throttle": float(throttle),
            "phase": phase,
            "F_body": Fb,
            "M_body": Mb,
            "v_body": vb,
            "coeff": coeff,
            "CN_ALPHA": coeff["CN_ALPHA"],
            "cg": cg,
            "static_margin": static_margin(fs["mach"], cg),
            "dcm_be": dcm,
        }
        return F_eci, Mb, info

    # --------------------------------------------------------
    # 14-state derivative
    # --------------------------------------------------------
    def derivatives(self, t, state14, fins, fs=None, dcm=None, angles=None,
                    use_fast=None, throttle=1.0, wind=None):
        """Derivative of ``[r(3), v(3), q(4), omega(3), mass(1)]``.

        ``use_fast=None`` auto-selects the compiled core when only the raw
        state is supplied; cached intermediates force the pure Python path.
        ``throttle`` is the ramjet fuel-flow command held over the step
        (1.0 reproduces the open-loop full-thrust law).  ``wind`` is the ZOH
        ECI wind vector.
        """
        y = np.asarray(state14, dtype=float).reshape(14)

        if use_fast is None:
            use_fast = FC.NUMBA_AVAILABLE and fs is None and dcm is None and angles is None
        if use_fast:
            fins4 = np.ascontiguousarray(np.asarray(fins, dtype=float).reshape(4))
            w = np.zeros(3) if wind is None else np.asarray(wind, dtype=float).reshape(3)
            (dy, alpha, beta, mach, q_dyn, alt, cn_a, Fb, Mb,
             dcm_be, mdot, thrust, phase_code) = FC.missile_derivatives(
                float(t), np.ascontiguousarray(y), fins4,
                self.mass0, self.dry_mass, self.fuel0, self.S, self.L,
                float(throttle), float(w[0]), float(w[1]), float(w[2]))
            phase = {-1: "coast", 0: "boost", 1: "ramjet"}[int(phase_code)]
            cg = self.cg_position(float(y[13]))
            info = {
                "alt": float(alt),
                "mach": float(mach),
                "q_dyn": float(q_dyn),
                "alpha": float(alpha),
                "beta": float(beta),
                "thrust": float(thrust),
                "mdot": float(mdot),
                "throttle": float(throttle),
                "phase": phase,
                "F_body": Fb,
                "M_body": Mb,
                "coeff": {"CN_ALPHA": float(cn_a)},
                "CN_ALPHA": float(cn_a),
                "cg": cg,
                "static_margin": static_margin(float(mach), cg),
                "dcm_be": dcm_be,
            }
            return dy, info

        r = y[0:3]
        v = y[3:6]
        q = MU.quat_normalize(y[6:10])
        omega = y[10:13]
        mass = float(min(max(y[13], self.dry_mass), self.mass0))

        if dcm is None:
            dcm = MU.quat_to_dcm(q)
        F_eci, Mb, info = self.forces_moments(
            r, v, q, omega, mass, fins, t, fs=fs, dcm=dcm, angles=angles,
            throttle=throttle, wind=wind)
        inertia = self.inertia_diag(mass)
        acc = F_eci / max(mass, 1e-6)

        # Euler rigid-body equation (uniflight RigidBody6DOFDynamics form):
        #   I * wdot = M - I_dot * w - w x (I w)
        # The inertia is mass dependent, so fuel burn contributes I_dot * w.
        ix, iy, iz = inertia
        p, qq, r = omega
        gyro = np.array([
            qq * (iz * r) - r * (iy * qq),
            r * (ix * p) - p * (iz * r),
            p * (iy * qq) - qq * (ix * p),
        ])
        if self.fuel0 > 0.0:
            mdot = float(info["mdot"])
            idot = np.array([
                C.IXX_FULL - C.IXX_DRY,
                C.IYY_FULL - C.IYY_DRY,
                C.IZZ_FULL - C.IZZ_DRY,
            ]) / self.fuel0 * (-mdot)
        else:
            idot = np.zeros(3)
        omega_dot = (Mb - gyro - idot * omega) / inertia

        qdot = MU.quat_derivative(q, omega)
        dy = np.empty(14)
        dy[0:3] = v
        dy[3:6] = acc
        dy[6:10] = qdot
        dy[10:13] = omega_dot
        dy[13] = -info["mdot"]
        return dy, info
