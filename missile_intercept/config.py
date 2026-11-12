"""Global configuration and data contracts.

Design rules
------------
1. This module has no third-party dependency other than numpy/dataclasses and
   is imported by every other module in one direction only.
2. It stores constants, immutable configuration and data structures only; no
   mutable global state is allowed.
3. All physical quantities are SI (m, kg, s, rad, N, W).

Reference sources
-----------------
- Earth/gravity: WGS84 constants (GM=3.986004418e14, omega=7.292115e-5)
- Atmosphere: USSA1976
- Aerodynamics: original USAF Digital DATCOM (Jan 96) via
  tools/datcom_aero.py -> output/datcom_aero.csv, which is the source of the
  M <= 5 CN/CD/CM tables in section 5; modified Newtonian above M = 5
- Propulsion: DTIC-ThrustAlt altitude correction, public data scaling
- Guidance: JAST-Bezier (midcourse), ZEM/APN (terminal)
- Autopilot: Hacettepe-3loop / TU-Delft-AW
- Navigation: gnss-ins-sim noise levels
- Seeker: DTIC-Glint
- Variable mass: METU-VarMass
- Verification: KAIST-FlightData order-of-magnitude calibration
"""

import math
from dataclasses import dataclass, field
import numpy as np

# ============================================================
# 1. Physical constants (WGS84 / USSA1976)
# ============================================================
G0 = 9.80665                 # Standard gravity m/s^2
RE = 6371000.0               # Spherical Earth radius m (sphere mode only)
MU = 3.986004418e14          # Earth gravitational parameter m^3/s^2
OMEGA_EARTH = 7.2921150e-5   # Earth rotation rate rad/s

# ---- Earth figure ----------------------------------------------------------
# "wgs84" uses the WGS84 ellipsoid for LLH<->ECI and adds the J2 oblateness
# term to gravity; "sphere" reproduces the previous spherical model exactly.
# EARTH_MODEL_CODE is the numeric form read by the compiled core (Numba cannot
# branch on a Python string cheaply).
EARTH_MODEL = "wgs84"
EARTH_MODEL_CODE = 1 if EARTH_MODEL == "wgs84" else 0
WGS84_A = 6378137.0                 # Semi-major axis m
WGS84_F = 1.0 / 298.257223563       # Flattening
WGS84_B = WGS84_A * (1.0 - WGS84_F)  # Semi-minor axis m
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)  # First eccentricity squared
J2 = 1.08262668e-3                  # Second zonal harmonic
P_SL = 101325.0              # Sea-level pressure Pa
RHO_SL = 1.225               # Sea-level density kg/m^3
R_AIR = 287.05287            # Dry-air gas constant J/(kg*K)
GAMMA_AIR = 1.4              # Air specific-heat ratio
DEG = np.pi / 180.0


# ============================================================
# 2. Scenario: inland launch site -> 15 km altitude sea target
# ============================================================
LAUNCH_LAT = 40.0            # deg
LAUNCH_LON = 110.0           # deg
LAUNCH_ALT = 0.0             # m

# Target initial state (F-35A Lightning II as the assumed threat, head-on from
# the sea, ~1990 km great-circle range).  The point-mass target is flown at the
# top of the published envelope so the intercept is sized against the hardest
# representative case:
#   - 1.6 M is the F-35's maximum speed (full internal load, afterburner);
#   - 15 240 m (50 000 ft) is its service ceiling;
#   - 9 g is the F-35A limit load factor (B/C are 7 g / 7.5 g);
#   - 15.7 m is the F-35A overall length (seeker glint scale).
# At 1.6 M and 15.2 km the target closes at ~480 m/s, which is the stressing
# end of a 5th-generation fighter engagement rather than a subsonic cruise.
TARGET_LAT = 28.0            # deg
TARGET_LON = 126.0           # deg
TARGET_ALT = 15240.0         # m (50 000 ft service ceiling)
TARGET_MACH = 1.6            # Max speed, combat configuration
TARGET_MACH_MAX = 1.6        # Flight-envelope ceiling: the airframe cannot go
                             # faster, so the model clamps any commanded Mach
                             # to this value (suites must stay inside it).
TARGET_MANEUVER_DIST = 15000.0   # Evasion trigger range m
TARGET_EVADE_PHASE = 0.0     # Weave phase offset rad (0 reproduces the nominal run)
TARGET_EVADE_G = 9.0         # Commanded load factor ceiling g (design limit);
                             # also scales the whole defensive reaction
                             # (beam turn + dive + terminal jink), so 0 means a
                             # cooperative straight run.
# Mission behaviour.  A fighter does not fly straight until the last 15 km and
# then wiggle: it cruises towards the target area, reacts to the missile
# warning far out, beams/notches the threat while diving to build energy, and
# only jinks in the last few seconds.  Each phase is a function of the current
# range, so the 6-state point-mass model stays unchanged.
TARGET_DEFEND_DIST = 60000.0     # missile-warning reaction range m
TARGET_DEFEND_G = 6.0            # sustained defensive turn load factor g
TARGET_DESCENT_G = 1.0           # dive component during the defensive turn g
TARGET_DESCENT_GAMMA = 25.0 * 3.141592653589793 / 180.0  # dive stops at this
                                 # flight-path angle, so the target does not
                                 # keep accelerating downwards forever
TARGET_BEAM_COS_LO = 0.20        # turn authority ramps out as the target beams
TARGET_BEAM_COS_HI = 0.80        # (cos of the angle to the incoming missile)
# The commanded weave is lift-limited: a 9 g pull is only flown where the wing
# can actually produce it.  At 15.24 km / Ma 1.6 the dynamic pressure is only
# ~21 kPa, so the F-35A-class target can reach ~1.8-3.6 g, not 9 g; the cap
# keeps high-altitude evasion physically attainable while leaving the design
# limit available at low altitude / high Mach.
TARGET_WING_AREA = 42.7      # m^2, F-35A reference wing area
TARGET_MASS = 20000.0        # kg, combat configuration
TARGET_CL_MAX_SUB = 1.2      # usable lift coefficient, subsonic
TARGET_CL_MAX_SUP = 0.8      # usable lift coefficient, supersonic
TARGET_CL_MACH_LO = 0.8      # CL_max blends between these Mach numbers
TARGET_CL_MACH_HI = 1.2
# Evasion is not free: pulling g costs induced drag, so the target bleeds
# speed while weaving instead of cruising at a constant Mach.  Thrust is
# assumed trimmed for 1 g, so only the induced-drag increment acts on the
# speed.  The roll/manoeuvre reversal takes time, modelled as a first-order
# onset lag whose steady-state response is applied analytically (no extra
# target state).
TARGET_SPAN = 10.7           # m, F-35A wing span (aspect ratio b^2/S = 2.68)
TARGET_OSWALD_E = 0.8        # Oswald span efficiency
TARGET_MANEUVER_TAU = 0.6    # roll/manoeuvre onset time constant s

# ============================================================
# 3. Airframe geometry, mass and inertia
# ============================================================
LENGTH = 8.11                # Body length m
DIAMETER = 0.63              # Body diameter m
S_REF = 0.3117               # Aerodynamic reference area m^2 = pi*(D/2)^2
WING_SPAN = 0.364            # Exposed semi-span per side m (fin span +30 %)
ROOT_CHORD = 3.8             # Wing root chord m
TIP_CHORD = 1.6              # Wing tip chord m
# Planform area of the two lifting surfaces (used for the lift-area check).
S_PLANFORM = 2.0 * 0.5 * (ROOT_CHORD + TIP_CHORD) * WING_SPAN
ASPECT_RATIO = (2.0 * WING_SPAN) ** 2 / S_PLANFORM

MASS0 = 2565.0               # Launch mass kg
DRY_MASS = 1000.0            # Dry mass kg (hard lower bound)

# Inertia: linear interpolation between full and dry states.
# Transverse inertia is set from the published 2000 km-class lifting-body
# band (Iyy = Izz ~ 3000-6000 kg*m^2 at launch mass).  6000 kg*m^2 gives a
# radius of gyration of ~1.53 m, i.e. mass concentrated near the mid-body
# (seeker/warhead forward, motor and tanks around the CG) rather than a
# uniformly filled slender cylinder (which would be ~14.1e3 kg*m^2).  The
# dry value is scaled by the mass ratio (6000 * 1000/2565 ~ 2400), so mass
# and inertia decay together; I_roll includes the fin/actuator term.
IXX_FULL, IXX_DRY = 190.0, 90.0        # kg*m^2
IYY_FULL, IYY_DRY = 6000.0, 2400.0     # kg*m^2
IZZ_FULL, IZZ_DRY = 6000.0, 2400.0     # kg*m^2

# Centre of mass measured from the nose tip, m. Fuel burn moves it forward
# (linear in fuel fraction, METU-VarMass sliding-CG form).  CG_DRY is the
# dry-body station, CG_FULL the all-up station.  The running CG enters the
# aerodynamic lever arm (X_REF - cg(t)) and the autopilot trim schedule, so
# the static margin grows as the propellant is consumed.
CG_FULL, CG_DRY = 4.45, 4.10

# Aerodynamic centre (cp) measured from the nose tip, m.  X_REF is the
# effective subsonic aerodynamic centre implied by the Digital DATCOM run in
# tools/datcom_aero.py (static margin 0.79 m at CG_FULL).  At run time
# vehicle.missile.static_margin() combines it with the current CG station,
# and the pitching moment is built from that force lever arm.
X_REF = 5.24

# Effective fin moment arm and model-based gain scheduling.  The rate loop
# crossover is held at AP_OMEGA_Q rad/s using the instantaneous fin authority,
# inertia and dynamic pressure, so geometry or aero changes are absorbed
# automatically instead of requiring an offline re-tune of the gain table.
_MAC = (2.0 / 3.0) * (ROOT_CHORD + TIP_CHORD
                      - ROOT_CHORD * TIP_CHORD / (ROOT_CHORD + TIP_CHORD))
_Y_MAC = (WING_SPAN / 3.0) * (ROOT_CHORD + 2.0 * TIP_CHORD) / (
    ROOT_CHORD + TIP_CHORD)
_SWEEP = math.atan((ROOT_CHORD - TIP_CHORD) / (WING_SPAN + 0.5 * DIAMETER))
FIN_LEVER = ((LENGTH - ROOT_CHORD) + _Y_MAC * math.tan(_SWEEP)
             + 0.25 * _MAC - CG_FULL)
AP_OMEGA_Q = 22.0              # Pitch-rate loop crossover rad/s (best of 14/18/22/25)
GAIN_SCALE_MIN, GAIN_SCALE_MAX = 0.30, 3.0

# ============================================================
# 4. Propulsion (solid booster + supersonic ramjet)
# ============================================================
BOOST_BURN_TIME = 13.0       # Solid burn time s
BOOST_FUEL = 800.0           # Solid propellant kg
BOOST_THRUST_SL = 130000.0   # Sea-level thrust N at curve scale 1.0 (T/W ~ 5.2)
BOOST_ISP = 215.0            # Solid specific impulse s
# Normalised sea-level thrust profile (time fraction, thrust scale).  The
# trapezoidal mean over [0, 1] is ~1.003, so the integrated impulse still
# matches BOOST_ISP and the constant propellant mass flow.  A constant
# thrust is deliberately not used: the booster has an ignition transient
# and a tail-off ramp.
BOOST_THRUST_T = np.array([0.00, 0.10, 0.80, 0.90, 1.00])
BOOST_THRUST_F = np.array([0.85, 1.02, 1.02, 1.00, 0.90])

# Nozzle exit area for the altitude correction F = F_sl + A_e (P_sl - P_a).
# Exit diameter 0.50 m on a 0.63 m body, i.e. A_e / A_body = 0.63, which is
# the upper end of a single-stage solid booster and keeps the high-altitude
# thrust increment physical.  A_e must never exceed the body cross-section.
NOZZLE_EXIT_AREA = 0.196     # m^2 (D_e = 0.50 m)

# ---- Boost-phase guidance (gravity-turn pitch programme) ----
# The booster is not throttleable, so the boost phase is flown as a gravity
# turn: the pitch programme is rate-limited by the normal force the airframe
# can actually produce (q*S*CN_alpha*alpha_max plus the thrust-vector term
# T*sin(alpha_max)), and it stops at the flight-path angle that hands the
# midcourse a usable climb instead of driving the missile horizontal at low
# altitude.  The programme runs through burnout and the ramjet take-over;
# BOOST_END_TIME is the boost->midcourse phase gate in main.py.
BOOST_END_TIME = 20.0            # boost -> midcourse handover time s
BOOST_VERTICAL_TIME = 2.0        # vertical cold-launch rise s
BOOST_GAMMA_HAND = 30.0 * DEG    # flight-path angle held at boost handover rad
BOOST_ALPHA_MAX = 12.0 * DEG     # lateral angle-of-attack budget during boost rad
BOOST_PITCH_RATE_MAX = 8.0 * DEG # pitch-programme rate cap rad/s
BOOST_GAMMA_GAIN = 1.2           # flight-path-angle error feedback 1/s
BOOST_HEADING_GAIN = 0.8         # azimuth error feedback 1/s
BOOST_ACCEL_LIMIT = 4.0 * G0     # total non-gravity command cap m/s^2
BOOST_TURN_MARGIN = 0.85         # fraction of feasible normal acceleration used

RAMJET_ISP = 1500.0          # Ramjet reference specific impulse s
RAMJET_COEFF = 6.0           # Thrust = coeff * q * A_inlet * eta(M, h, alpha)
RAMJET_A_INLET = 0.22        # Inlet capture area m^2
RAMJET_MACH_MIN = 1.6        # Ramjet light-off Mach
RAMJET_MACH_MAX = 10.0       # Ramjet upper Mach limit
RAMJET_Q_MIN = 2500.0        # Minimum light-off dynamic pressure Pa
RAMJET_THRUST_MAX = 60000.0  # Ramjet thrust cap N
RAMJET_MDOT_MAX = 3.0        # Maximum fuel flow kg/s
# Air-breathing efficiency envelope.  Public liquid-ramjet studies show
# thrust coefficient and Isp flatten in the stratosphere and fall with Mach;
# above the density ceiling the motor is starved and thrust goes to zero.
RAMJET_ALT_FULL = 18000.0    # Full combustion efficiency up to this altitude m
RAMJET_ALT_CUTOFF = 32000.0  # Zero ramjet thrust above this altitude m
RAMJET_MACH_REF = 3.0        # Mach where the high-Mach efficiency roll-off starts
RAMJET_MACH_DECAY = 0.05     # Efficiency loss per unit Mach above RAMJET_MACH_REF
RAMJET_ETA_MIN = 0.55        # Lower efficiency floor near RAMJET_MACH_MAX

# ---- Ramjet thrust control (discrete Mach-hold P law at the guidance rate) ----
# The solid booster is not throttleable; only the ramjet fuel flow is
# modulated.  The controller drives the throttle command in [0, 1] from the
# Mach error with a proportional law, a slew limit and a first-order
# fuel-system lag.  The P law leaves a small steady-state Mach droop (thrust
# must balance drag); that static error is acceptable for the sustainer.
THRUST_MACH_REF = 9.5        # Sustain Mach reference (range-optimal at fixed q)
THRUST_KP = 0.80             # Throttle per unit Mach error
THROTTLE_TAU = 0.25          # Fuel-system first-order lag s
THROTTLE_RATE_MAX = 1.5      # Throttle slew limit 1/s

# ============================================================
# 5. Aerodynamic coefficients (referenced to S_REF = body cross-section)
# ============================================================
# ---- DATCOM-anchored coefficient tables (M <= 5) -----------------------
# Source: original USAF Digital DATCOM (Jan 96), body + cruciform fins,
# generated by tools/datcom_aero.py (output/datcom_aero.csv).  M = 0.2 and
# M >= 2 are direct DATCOM results; M = 0.5..1.5 is the monotone transonic
# bridge between those anchors (Digital DATCOM returns NDM for this planform
# in that band, so the bridge follows the Prandtl-Glauert trend of a highly
# swept surface).  Above M = 5 the modified-Newtonian branch continues the
# M = 5 value instead of extrapolating the table.
AERO_MACH = np.array([0.00, 0.20, 0.50, 0.80, 0.95, 1.05, 1.20, 1.50,
                      2.00, 2.50, 3.00, 3.50, 4.00, 4.50, 5.00])
AERO_CN_ALPHA = np.array([9.45, 9.91, 9.63, 10.27, 10.78, 11.16, 11.53, 12.30,
                          12.89, 12.97, 13.05, 12.28, 11.50, 10.65, 9.80])
AERO_CM_ALPHA = np.array([-0.840, -0.920, -0.955, -1.053, -1.127, -1.176,
                          -1.201, -1.225, -1.250, -1.400, -1.550, -1.450,
                          -1.350, -1.070, -0.790])
AERO_CD0 = np.array([0.235, 0.244, 0.270, 0.344, 0.374, 0.385, 0.374, 0.349,
                     0.312, 0.269, 0.226, 0.202, 0.178, 0.162, 0.146])
AERO_INDUCED_K = np.array([0.073, 0.071, 0.061, 0.054, 0.054, 0.054, 0.051,
                           0.048, 0.045, 0.046, 0.046, 0.050, 0.054, 0.064,
                           0.074])

# Lift-line nonlinearity: CN(M, alpha) = CN_alpha(M) * alpha * shape(|alpha|).
# The shape is the mean DATCOM ratio CN / (CN_alpha * alpha) over M = 2..5;
# it captures the crossflow term that makes the finned body exceed the linear
# slope beyond ~6 deg (shape 1.93 at 20 deg, 2.12 at 24 deg).
AERO_ALPHA_DEG = np.array([0.0, 2.0, 4.0, 6.0, 8.0, 12.0, 16.0, 20.0, 24.0])
AERO_CN_SHAPE = np.array([1.000, 0.890, 1.000, 1.117, 1.245, 1.490, 1.720,
                          1.930, 2.120])
# Same alpha grid: the DATCOM drag polar loses efficiency at large alpha
# (finite-span crossflow), so k drops from 1.0 to 0.65 by 24 deg.
AERO_K_SHAPE = np.array([1.000, 1.000, 1.000, 1.000, 1.000, 0.840, 0.770,
                         0.700, 0.650])

# ---- Transonic bridge uncertainty envelope ------------------------------
# Digital DATCOM has no method for this planform between M ~ 0.5 and 1.6.
# The bridge in AERO_* above is the nominal curve; the simulation uses the
# conservative side of the band: lift derated and drag increased.
AERO_BRIDGE_LO = 0.50
AERO_BRIDGE_HI = 1.60
AERO_BRIDGE_CN_DERATE = 0.08   # -8 % CN_alpha at the band centre
AERO_BRIDGE_CD_MARGIN = 0.10   # +10 % CD0 at the band centre

# ---- Friction drag (Reynolds / altitude correction to CD0) --------------
# DATCOM tabulated CD0 at sea level.  At altitude the Reynolds number drops
# and the turbulent flat-plate friction coefficient rises, so CD0 must be
# corrected with dCf * S_wet / S_ref.
S_WET_RATIO = 61.0             # wetted area / S_REF (body + both fin sides)
MU_SL = 1.7894e-5              # sea-level dynamic viscosity Pa*s
RE_EXPONENT = 0.2              # turbulent Cf = 0.074 / Re^0.2

# ---- Base drag / plume interaction --------------------------------------
# The DATCOM deck is a non-jetting configuration.  With the motor running
# the base pressure is raised, so a small part of CD0 is removed.
CD_BASE_PLUME = 0.020          # CD0 relief while thrust is on

# ---- Fin aerodynamics nonlinearity --------------------------------------
FIN_EFF_DROP = 0.25            # effectiveness loss at full deflection
FIN_CD_QUAD = 0.50             # quadratic part of fin drag vs deflection

# ---- Real-gas correction in the Newtonian branch ------------------------
GAMMA_HYP_DROP = 0.04          # gamma 1.40 -> 1.36 by M = 10

# ---- High-alpha pitching-moment shape -----------------------------------
# CM(M, alpha) / [CM_alpha(M) * alpha * CN_shape(alpha)] at large alpha.
# A value of 1 means the fixed-margin lever arm already reproduces DATCOM;
# the subsonic anchor needs more (DATCOM's moment curve is strongly convex).
AERO_CM_GAIN_MACH = np.array([0.20, 2.00, 3.00, 4.00, 5.00])
AERO_CM_GAIN = np.array([1.00, 1.85, 1.35, 1.35, 1.31])
AERO_CM_GAIN_ALPHA = np.array([6.0, 16.0])   # deg: ramp start / full

CN_ALPHA_BODY = 2.0          # Body-alone slender-body slope, 1/rad

# ---- Hypersonic branch (M > 5): shock-expansion, not extrapolation -------
# Lift slope from shock-expansion on the normal section of the 74.9 deg swept
# fin (oblique shock on the windward face, Prandtl-Meyer on the leeward face),
# projected back to the streamwise direction.  The magnitude is anchored to
# the DATCOM M = 5 value (calibration factor eta = 0.334, which absorbs the
# wing-body carryover that the 2-D normal section cannot represent), and the
# M > 5 shape is the shock-expansion trend itself.
AERO_HYP_MACH = np.array([5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 15.0, 20.0])
AERO_HYP_CN_ALPHA = np.array([9.800, 7.767, 6.660, 5.940, 5.040, 4.490,
                              3.970, 3.474])
MACH_NL_START = 5.0          # Newtonian branch switch begins above this Mach
MACH_NL_FULL = 7.0           # Newtonian branch fully active above this Mach
CN_NEWTON_SHAPE = 2.0        # Lifting-body factor: S_PLANFORM/S_REF * 0.41

# Reference derivatives.  The run-time curves are rebuilt from the tables
# above and fin_slope_ratio(M); the values below document the M = 2 anchor.
CN_BETA = -0.30              # Yaw static-stability derivative 1/rad
CN_DR = 0.30                 # Rudder effectiveness 1/rad
CY_BETA = -1.6               # Side-force derivative 1/rad
CL_P = -0.90                 # Roll damping (raised to suppress the roll limit cycle)
CL_DA = 0.270                # Aileron/differential-fin effectiveness (+30 % span)
CM_Q = -25.0                 # Pitch damping
CN_R = -20.0                 # Yaw damping
FIN_CD = 0.08                # Incremental fin drag per rad

FIN_MAX = 25.0 * DEG         # Physical fin position limit rad
FIN_RATE_MAX = 150.0 * DEG   # Physical fin rate limit rad/s
FIN_TAU = 0.010              # Fin actuator first-order time constant s
AP_PREFILTER_HZ = 10.0       # Autopilot command pre-filter bandwidth Hz
# Pitch outer-loop tuning on the F-35A 9 g baseline suite:
#   KP_ANGLE 3.8 -> 6.0: mean miss 21.0 -> 10.6 m, pass 1/4 -> 3/4.
#   Faster pre-filter (15/20 Hz) or higher KP_RATE (0.16/0.18) worsened the
#   tail (max miss 27-48 m), so the command filter and rate gain stay at the
#   values below.  The compiled fastcore path takes the bandwidth at run time.
AP_KP_ANGLE = 6.0            # Outer alpha loop gain
AP_KP_RATE = 0.14            # Pitch rate loop gain / low-q schedule floor
AP_REF_RATE_MAX = 4.0        # Reference body-rate cap at AP_REF_Q rad/s
AP_ROLL_ANGLE_GAIN = 4.0     # Lift-vector/roll-angle alignment gain 1/s
AP_ROLL_RATE_MAX = 6.0       # Roll-rate command limit rad/s
AP_REF_Q = 20000.0           # Reference dynamic pressure for the schedules Pa
AP_PREFILTER_HZ_MIN = 1.0    # Low-q floor of the scheduled pre-filter Hz
AP_REF_GOV_ACCEL_MARGIN = 0.45  # Usable fraction of the moment-limited alpha_ddot
AP_KI_LOW_Q_FLOOR = 0.35     # Minimum integral-gain scale at low dynamic pressure

# Direct normal-load-factor (n_z) feedback.  The outer alpha loop only sees the
# pseudo-angle; the measured body -Z load factor is the quantity the guidance
# command actually asks for, so a dedicated PI on n_z removes the residual lag
# between commanded and achieved acceleration.  It is passed to the compiled
# core at run time so switching it does not require a Numba recompile.
# A/B tested with tools/tune_autopilot.py on the 4-seed baseline suite
# (pass/4, mean, worst miss):
#   no n_z loop                     3/4  17.7 m  39.8 m
#   n_z only                        3/4   9.6 m  23.6 m
#   n_z + lead 0.06 s               4/4   3.3 m   7.1 m   <- adopted
#   n_z + lead 0.09 s               4/4   6.0 m   9.1 m
# The rejected variants (q/mass gain schedule, actuator-lag inversion) were
# removed: both helped alone but never stacked with the lead term.
AP_NZ_LOOP = 1               # 1 = enable n_z PI loop rad/s per g
AP_KP_NZ = 0.02              # n_z proportional gain rad/s per g
AP_KI_NZ = 0.004             # n_z integral gain rad/s per (g*s)
# Lead compensation on the measured load factor: the PI only reacts to the
# present error, while a first-order high-pass term anticipates where n_z is
# heading and adds phase near the loop crossover.
AP_NZ_LEAD = 0.06            # Lead time constant s (0 disables)
AP_NZ_LEAD_LPF = 0.02        # Low-pass time constant of the n_z derivative s

# ============================================================
# 6. Multi-rate scheduling (ZOH)
# ============================================================
DT_SEEKER = 0.005            # Seeker 5 ms (aligned with the outer RK4 step)
DT_AUTOPILOT = 0.005         # Autopilot + fin mixer 5 ms
DT_GUIDANCE = 0.005          # Guidance + handover 5 ms (terminal lag reduction)
DT_GNSS = 1.000              # GNSS measurement update 1 s
DT_LOG = 0.010               # Telemetry 10 ms
NAV_DELAY = 0.050            # Navigation output delay 50 ms

# ============================================================
# 7. Handover gates and seeker
# ============================================================
# Handover is an acquisition + energy + geometry decision, not a single range
# trigger.  The gates below are ordered by what the terminal loop actually
# needs: the seeker must see the target with margin, the airframe must have
# enough control authority left, and enough time must remain for the command
# blend and the terminal transient.
# Handover must happen inside the *real* dual-mode acquisition window, not at
# a nominal 45 km: for this stealth target the radar channel locks near 8 km
# and the IIR backup near 25 km, so a 45 km gate was never satisfiable and was
# the main cause of the un-handovered (km-level miss) population.
HANDOVER_RANGE = 24000.0     # Nominal handover range m (inside IIR acquisition)
HANDOVER_RANGE_FLOOR = 20000.0  # Forced handover range if the elevation gate cannot be met m
HANDOVER_DH_MIN = 0.0        # Minimum look-down advantage at handover m
HANDOVER_DH_MAX = 12000.0    # Base altitude advantage m (extended by the depression limit)
# The altitude gate is a look-down angle, not a fixed height: the allowed
# advantage grows with range, so a low target that is still above the
# descent profile at long range is not rejected purely for its height.
HANDOVER_DEPRESSION_MAX = 22.0 * DEG   # Max look-down angle at handover rad
HANDOVER_FOV_PREDICT_TIME = 1.0        # FOV extrapolation horizon for forced handover s
HANDOVER_DH_NOMINAL = 0.0    # Altitude advantage targeted at the handover point m
# The hold advantage is no longer a constant: it is captured at the descent
# entry range below, so a low target (cruised far above the fixed 14 km band)
# gets a descent slope sized to the advantage it actually has.
MIDCOURSE_DESCENT_RANGE = 220000.0  # Start the pre-handover descent profile m
MIDCOURSE_FREEZE_RANGE = 150000.0   # Freeze the Bezier path inside this range m
# Energy-optimal cruise: holding q near 75 kPa puts the missile at ~30 km and
# alpha ~ 6 deg, near the best L/D of the corrected polar.  q error maps to a
# flight-path-angle command; the vertical-velocity term damps the phugoid.
MIDCOURSE_Q_CRUISE = 75000.0    # Cruise dynamic pressure Pa (~30 km, alpha ~6 deg)
MIDCOURSE_Q_GAMMA_GAIN = 0.45   # gamma command per relative q error
MIDCOURSE_GAMMA_LIMIT = 0.08    # |gamma| limit in cruise rad
MIDCOURSE_GAMMA_DAMP = 0.22     # vertical-velocity damping 1/s
# Pre-handover descent.  The cruise is flown at q-hold, but the altitude
# channel owns the flight-path angle as soon as the remaining range equals
# the distance needed to remove the *current* altitude advantage at this
# gradient.  Using the current advantage (not a fixed hold value) makes the
# entry range adapt to low targets, which cruise much higher above the target
# than the fixed 14 km band.  The q-hold term is disabled in the descent.
MIDCOURSE_DESCENT_GAMMA = 9.0 * DEG   # max descent flight-path angle rad
MIDCOURSE_DESCENT_ACC_MAX = 2.5 * G0  # vertical acceleration budget in the dive m/s^2
MIDCOURSE_DESCENT_DH_TARGET = 800.0   # small positive look-down aimed for at handover m
# The descent entry range is derived from the altitude that must actually be
# removed at the feasible gradient, plus this margin, instead of a fixed 220 km.
MIDCOURSE_DESCENT_MARGIN = 10000.0    # extra range before the dive m
# Preview horizon used to predict handover geometry and start the dive early
# when the lead angle/altitude would otherwise be infeasible.
MIDCOURSE_FEASIBILITY_LEAD = 0.75     # fraction of HANDOVER_ANGLE_MAX allowed
# Coplanar-handover constraint (impact-angle law, cross-plane channel):
# at handover the missile velocity and the target velocity must lie in the
# same vertical plane, i.e. the terminal relative flight-path angle in the
# cross-plane channel must be zero.  The target's ground-track vertical plane
# has normal n = r_t x v_t_air; the missile's cross-plane offset x and rate
# xdot are driven to zero at handover by the terminal double-integrator
# profile
#     a_n = -(6 x + 4 xdot t_go) / t_go^2
# which is the ZEM/a_I + angle-bias behaviour of the referenced impact-angle
# law expressed in the cross-plane channel.  The term ramps in from
# MIDCOURSE_COPLANAR_RANGE and is capped so it cannot override the cruise/PN
# tracking.
# Tuned on the nominal engagement: GAIN 0.8 / TGO_MIN 8 s gives ~9 m miss
# with a 0.05 deg handover azimuth mismatch.
MIDCOURSE_COPLANAR_GAIN = 0.8         # Cross-plane terminal-loop scale
MIDCOURSE_COPLANAR_RANGE = 2100000.0  # Range where the coplanar ramp starts m
MIDCOURSE_COPLANAR_TGO_MIN = 8.0      # Time-to-go floor for the 1/t_go^2 term s
MIDCOURSE_COPLANAR_ACC_MAX = 3.0 * G0 # Cross-plane authority cap m/s^2
MIDCOURSE_PN_GAIN = 2.0               # Tuned PN baseline gain (a_I analogue)
HANDOVER_SPEED_MIN = 1800.0  # Minimum handover speed m/s
HANDOVER_ANGLE_MAX = 12.0 * DEG   # Lead-angle limit rad
HANDOVER_FOV_MARGIN = 0.90   # Fraction of the seeker half-FOV allowed at handover
HANDOVER_TGO_MIN = 4.0       # Minimum time-to-go at handover s (>> command blend)
HANDOVER_N_PN = 4.0          # Terminal PN gain used for the diagnostic n_req
# Adaptive terminal PN: the effective navigation constant grows as time-to-go
# shrinks, which is the shape of the finite-horizon optimal law (a constant N
# is only optimal for an infinite horizon).  The boost is bounded so the
# endgame does not saturate the fins.
TERMINAL_PN_TGO_REF = 20.0   # s, time-to-go where the boost starts to ramp
TERMINAL_PN_BOOST = 0.40      # fractional N increase near impact
TERMINAL_PN_MIN = 3.0         # floor on the effective navigation constant
# Robust target-acceleration estimate: the raw finite difference is bounded
# before it enters the APN feed-forward.
TERMINAL_AT_MAX_G = 9.0       # acceleration estimate clamp g (airframe limit)
TERMINAL_AT_TAU = 0.25        # first-order smoothing time constant s
# Predictive FOV guard: the off-boresight angle is extrapolated over this
# horizon so the terminal loop starts correcting before the target exits.
TERMINAL_FOV_PREDICT = 0.50   # s
TERMINAL_FOV_RATE_MAX = 0.05  # rad/s cap on the LOS rate used for prediction
TERMINAL_FOV_ACC_MAX = 4.0 * G0  # cap on the soft FOV-guard acceleration
# Aim point offset from the target centre along -v_t (engine/heat source).
TERMINAL_AIMPOINT_OFFSET = 3.0  # m
# Cross-check of seeker-derived relative geometry against the tracker; a
# disagreement larger than this fraction of range falls back to the tracker.
TERMINAL_SEEKER_CONSISTENCY = 0.20
TERMINAL_SEEKER_MIN_ERROR = 500.0  # m absolute floor of the consistency test
HANDOVER_N_AVAIL_MIN = 4.0   # Absolute available load factor required at handover g
HANDOVER_DWELL = 0.20        # Gates must hold continuously before handover s
HANDOVER_BLEND_TIME = 0.5    # Midcourse->terminal weight blend time s
# A lock is only accepted for handover if the seeker LOS agrees with the
# tracked target bearing.  A false detection rotates the reported LOS by
# ~0.35*FOV, so this gate rejects it instead of handing over to a ghost.
HANDOVER_LOS_CONSISTENCY = 5.0 * DEG
HANDOVER_RANGE_CONSISTENCY = 0.25   # |seeker range - tracker range| / R

SEEKER_FOV = 20.0 * DEG      # Seeker field of view +/-20 deg
SEEKER_BLIND_RANGE = 120.0   # Seeker blind range m (shorter coast to impact)
# Monopulse angle noise.  Public AIM-120-class data gives < 1 mrad at 10 nmi
# and SNR ~ 15 dB; a fixed 1 mrad is the conservative mid-range value.
SEEKER_SIGMA_ANGLE = 1.0e-3  # Angle white noise rad (1 sigma)
SEEKER_GLINT_K = 0.30        # Glint coefficient (DTIC: L=15 m, beam=0.72 deg)
TARGET_LENGTH = 15.7         # F-35A overall length, glint scale m
SEEKER_RANGE_SIGMA = 5.0     # Range measurement noise m (1 sigma)
SEEKER_RANGE_RATE_SIGMA = 2.0  # Range-rate noise m/s (1 sigma)

# ---- Target-state tracker ---------------------------------------------------
# Converted-measurement Kalman filter used by guidance instead of target truth.
# The cue covariance models pre-launch track quality; the process-noise density
# covers the target's level-flight centripetal acceleration and terminal weave.
TGT_TRACK_CUE_POS_SIGMA = 3000.0   # m
TGT_TRACK_CUE_VEL_SIGMA = 30.0     # m/s
TGT_TRACK_ACC_PSD = 3.0            # m/s^2 (white-acceleration density)
# Covariance floor: with sensor noise disabled the filter covariance collapses
# to zero and the next (noise-free) update solves a singular system.
TGT_TRACK_COV_FLOOR = 1.0e-6       # m^2 / (m/s)^2

# ---- Midcourse datalink -----------------------------------------------------
# Offboard track updates that keep the midcourse aim point from drifting while
# the seeker is still outside its lock range.  Set period <= 0 to disable.
DATALINK_PERIOD = 1.0              # s between cue updates
DATALINK_POS_SIGMA = 200.0         # m (1 sigma, per axis)
DATALINK_VEL_SIGMA = 4.0           # m/s (1 sigma, per axis)
DATALINK_SEED = 31                 # stream offset added to nav_seed
# Transport latency and packet loss of the offboard track.  A fix sampled at
# t is applied at t + latency; each packet is dropped with probability
# DATALINK_LOSS_PROB.  Set latency 0 / loss 0 for the old zero-delay link.
DATALINK_LATENCY = 0.20            # s
DATALINK_LOSS_PROB = 0.02          # per packet

# ---- Gyro / IMU -------------------------------------------------------------
# Tactical-grade quartz MEMS gyro: the attitude is propagated from measured
# body rates, not from the integrated truth quaternion.  Bias is a first-order
# Gauss-Markov process; scale-factor error and quantisation are included.  Set
# SimConfig.ideal_attitude=True to restore the old truth-attitude loop.
GYRO_SIGMA = 2.0e-4                # rad/s white noise per sample (1 sigma)
GYRO_BIAS = 2.0e-4                 # rad/s initial bias (0.011 deg/s)
GYRO_BIAS_WALK = 2.0e-5            # rad/s in-run stability
GYRO_BIAS_TAU = 1000.0             # s bias correlation time
GYRO_SCALE_ERR = 2.0e-3            # scale-factor error (1 sigma)
GYRO_QUANT = 1.0e-6                # rad/s quantisation step
IMU_SEED = 13                      # stream offset added to nav_seed
# Attitude aiding.  A star tracker gives an absolute attitude fix; GNSS
# velocity supplies a heading-only correction (the vertical projection of the
# velocity is insensitive to angle of attack).  The tracker fix also makes the
# gyro bias observable, so the 12-state INS can estimate it.
STAR_PERIOD = 1.0                  # s between star fixes
STAR_ANGLE_SIGMA = 3.5e-4          # rad (0.02 deg) per axis
STAR_SEED = 23                     # stream offset added to nav_seed
STAR_DROPOUT_RATE = 0.003          # per-fix probability of a blinded tracker
ATT_AID_TAU = 1.0                  # s attitude correction time constant
ATT_BIAS_KI = 0.01                 # gyro-bias integral gain 1/s^2
ATT_BIAS_MAX = 1.0e-3              # rad/s bias estimate clamp
ATT_BIAS_SIGMA = 2.0e-4            # rad/s, bias pseudo-measurement sigma
GNSS_ATT_AID = True                # heading correction from GNSS velocity
GNSS_ATT_AID_GAIN = 0.10           # fraction of heading error removed per fix
GNSS_ATT_AID_BETA_MAX = 3.0 * DEG  # only aid while |beta| is small

# ---- Wind / turbulence ------------------------------------------------------
# Mean wind is defined in the local horizontal frame and added to the
# air-relative velocity seen by the aerodynamics.  Speed follows a power-law
# shear above WIND_REF_ALT; Dryden turbulence is a first-order Gauss-Markov
# process per axis.  Set SimConfig.enable_wind=False to fly in still air.
WIND_REF_SPEED = 15.0              # m/s at WIND_REF_ALT
WIND_REF_ALT = 10000.0             # m
WIND_SHEAR_EXP = 0.14              # power-law exponent
WIND_DIR_DEG = 75.0                # heading the wind blows towards, deg from north
WIND_TURB_SIGMA_H = 1.5            # horizontal turbulence rms m/s
WIND_TURB_SIGMA_V = 0.8            # vertical turbulence rms m/s
WIND_TURB_TAU = 2.0                # s correlation time
WIND_SEED = 17                     # stream offset added to nav_seed


# ---- Stealth target: dual-mode acquisition ---------------------------------
# The seeker carries a radar channel and an imaging-IR backup.  The radar
# channel obeys the range equation, R_det ~ sigma^(1/4): the reference point
# is the validated 45 km acquisition range against a conventional 5 m^2
# fighter.  The F-35's frontal RCS is quoted between -30 and -20 dBsm;
# 0.005 m^2 (-23 dBsm) is the mid public estimate, so radar lock-on collapses
# to ~8 km head-on.  Shaping does not reduce the airframe/plume IR signature,
# so the passive IIR channel keeps acquisition at ~25 km in a clear sky and
# the seeker locks at the larger of the two ranges.
TARGET_RCS = 0.005           # m^2, F-35 frontal aspect (mid estimate)
SEEKER_REF_RCS = 5.0         # m^2, conventional fighter reference
SEEKER_LOCK_RANGE_REF = 45000.0  # m, radar lock range at SEEKER_REF_RCS
SEEKER_IR_LOCK_RANGE = 25000.0   # m, IIR backup acquisition (RCS-independent)
# Swerling-I fluctuation: the RCS seen on each scan is exponentially
# distributed about its mean, so the radar lock range flickers scan to scan.
# Seeker dropouts and false detections are Poisson events given as rates.
SEEKER_SWERLING = True
SEEKER_DROPOUT_RATE = 0.05       # loss-of-lock events per second while in track
SEEKER_FALSE_LOCK_RATE = 0.01    # false detections per second while out of track
# A physical detection is trusted immediately; a false detection must repeat
# on consecutive scans before it is reported as a lock.
SEEKER_FALSE_LOCK_CONFIRM = 3
# First-order LOS smoothing suppresses glint without adding much endgame lag.
SEEKER_LOS_TAU = 0.03           # s

# Navigation noise: tactical-grade quartz MEMS IMU (EMCORE SDI-170 class)
# + military PPS GNSS.
# GNSS PPS is quoted at < 3 m SEP and < 0.1 m/s; the values below keep a
# margin for missile dynamics, antenna masking and multipath.
GNSS_SIGMA_POS = 8.0         # m, per-axis 1 sigma
GNSS_SIGMA_VEL = 0.15        # m/s, per-axis 1 sigma
# Accelerometer white noise: 100-120 ug/sqrt(Hz) over a 200 Hz sample rate
# gives 0.012 m/s^2 per sample.
IMU_SIGMA_ACC = 0.012        # m/s^2 per 5 ms sample
# Accelerometer bias: 1-2 mg initial bias (1.5 mg nominal) plus 100-200 ug
# in-run stability, modelled as a first-order Gauss-Markov process.
IMU_BIAS_ACC = 0.0147        # m/s^2 initial bias (1.5 mg)
IMU_BIAS_WALK = 0.0015       # m/s^2 in-run bias stability (150 ug)
IMU_BIAS_TAU = 1000.0        # s bias correlation time
# Process-noise acceleration used by the navigation KF.  It must cover the
# unmodelled manoeuvre/thrust transients not captured by the bias states;
# otherwise the estimate drifts.
NAV_PROCESS_ACC = 0.50       # m/s^2

# ============================================================
# 8. Numerics and tests
# ============================================================
# Warhead/fuze lethality used as the hit criterion in the batch statistics.
# The F-35A is 15.7 m long, so a 15 m lethal radius is a representative
# fragmentation/fuze stand-off rather than the old arbitrary 10 m.
WARHEAD_LETHAL_RADIUS = 15.0  # m

DEFAULT_MAX_STEP = 0.005     # Outer integration step s (boost / terminal)
DEFAULT_MIDCOURSE_MAX_STEP = 0.010  # Midcourse step s (quasi-steady cruise)
DEFAULT_T_END = 1200.0       # Latest simulation stop time s
# Closest-approach event is armed only after the range has closed inside this
# radius; a hard value gate would jump on the boundary and can fake a miss.
MISS_GATE_RADIUS = 300000.0  # m


# ============================================================
# 9. Data contracts (shared by all modules; field semantics are fixed)
# ============================================================
@dataclass
class MissileState:
    """Core missile state (14 integrated states expanded as 3+3+4+3+1)."""
    r_eci: np.ndarray        # (3,) ECI position m
    v_eci: np.ndarray        # (3,) ECI velocity m/s
    q: np.ndarray            # (4,) body-to-ECI quaternion, scalar first
    omega_body: np.ndarray   # (3,) body angular rate p,q,r rad/s
    mass: float              # Current mass kg
    inertia: np.ndarray = field(default_factory=lambda: np.eye(3))  # (3,3)
    cg_pos: float = 0.0      # Centre of mass from nose m


@dataclass
class NavEstimate:
    """Navigation filter output (delayed by about 50 ms)."""
    r_eci: np.ndarray        # (3,)
    v_eci: np.ndarray        # (3,)
    timestamp: float         # Timestamp of this estimate s


@dataclass
class SeekerMeasurement:
    """Seeker measurement (3D vectors, no dimensionality reduction)."""
    los_angle: np.ndarray    # (3,) ECI LOS unit vector
    los_rate: np.ndarray     # (3,) ECI LOS rate vector rad/s
    range: float             # m
    range_rate: float        # m/s
    is_locked: bool          # In FOV and outside the blind range
    fov_angle: float = 0.0   # LOS off-boresight angle rad


@dataclass
class GuidanceCommand:
    """Guidance command: desired ECI acceleration excluding gravity."""
    a_cmd_eci: np.ndarray    # (3,)
    phase: str               # 'boost' | 'midcourse' | 'terminal'


@dataclass
class ActuatorCommand:
    """Actuator command: four physical fins in a cruciform layout."""
    delta_fins: np.ndarray   # (4,) [up, down, left, right] rad
    is_saturated: bool


@dataclass
class Scenario:
    """Single-shot scenario parameters.

    Every field has a default equal to the nominal global scenario, so a
    batch run can pass an independent Scenario instance without mutating
    process-global state.
    """
    launch_lat: float = LAUNCH_LAT
    launch_lon: float = LAUNCH_LON
    launch_alt: float = LAUNCH_ALT
    target_lat: float = TARGET_LAT
    target_lon: float = TARGET_LON
    target_alt: float = TARGET_ALT
    target_mach: float = TARGET_MACH
    target_evade_g: float = TARGET_EVADE_G
    target_evade_phase: float = TARGET_EVADE_PHASE
    target_maneuver_dist: float = TARGET_MANEUVER_DIST
    nav_seed: int = 0
    seeker_seed: int = 1
    # Pre-launch target cue uncertainty (1 sigma).  Defaults are zero so the
    # nominal single-shot result is unchanged; Monte-Carlo dispersions can set
    # them to model an imperfect offboard track.
    cue_pos_sigma: float = 0.0
    cue_vel_sigma: float = 0.0
    cue_seed: int = 7919


@dataclass
class SimConfig:
    """Simulation run configuration (injected by main.py / tests)."""
    max_step: float = DEFAULT_MAX_STEP
    midcourse_max_step: float = DEFAULT_MIDCOURSE_MAX_STEP
    t_end: float = DEFAULT_T_END
    dt_seeker: float = DT_SEEKER
    dt_autopilot: float = DT_AUTOPILOT
    dt_guidance: float = DT_GUIDANCE
    dt_gnss: float = DT_GNSS
    dt_log: float = DT_LOG
    nav_delay: float = NAV_DELAY
    max_steps: int = 200000              # Telemetry buffer capacity
    max_integration_steps: int = 2000000  # Integrator step guard
    sensor_noise_scale: float = 1.0      # 0 disables nav/seeker noise
    telemetry_profile: str = "full"      # "full" or "basic" (Monte-Carlo)
    datalink_period: float = DATALINK_PERIOD
    datalink_pos_sigma: float = DATALINK_POS_SIGMA
    datalink_vel_sigma: float = DATALINK_VEL_SIGMA
    datalink_latency: float = DATALINK_LATENCY
    datalink_loss_prob: float = DATALINK_LOSS_PROB
    # Realism switches.  Defaults are the realistic models; set the flag to the
    # legacy value to reproduce the pre-upgrade nominal result.
    ideal_attitude: bool = False     # True = autopilot/seeker use truth q, omega
    enable_attitude_aid: bool = True # star tracker + GNSS heading correction
    enable_wind: bool = True         # False = still air
    seeker_swerling: bool = True     # False = constant RCS / lock range
    seeker_dropout_rate: float = SEEKER_DROPOUT_RATE
    seeker_false_lock_rate: float = SEEKER_FALSE_LOCK_RATE
    enable_plot: bool = True
    output_dir: str = "output"
    verbose: bool = True


# Telemetry columns (order equals array order; column 0 is always time)
TELEMETRY_COLUMNS = [
    "time", "m_rx", "m_ry", "m_rz", "m_vx", "m_vy", "m_vz",
    "t_rx", "t_ry", "t_rz", "t_vx", "t_vy", "t_vz",
    "mass", "mach", "q_dyn", "alt", "lat", "lon",
    "alpha", "beta", "nx", "ny", "nz",
    "a_cmd_x", "a_cmd_y", "a_cmd_z", "a_act_x", "a_act_y", "a_act_z",
    "fin_up", "fin_down", "fin_left", "fin_right", "fin_sat",
    "nav_err", "range", "range_rate", "seeker_lock", "fov_angle",
    "phase", "handover", "dh", "lead_angle", "p", "q_rate", "r_rate",
    "tgt_est_err",
    # ---- Extended observables (multiple frames / internal states) ----
    # Missile ECEF position and velocity.
    "m_ecef_x", "m_ecef_y", "m_ecef_z",
    "m_vecef_x", "m_vecef_y", "m_vecef_z",
    # Missile velocity in the local NED frame at the missile position.
    "m_vned_n", "m_vned_e", "m_vned_d",
    # Body-to-ECI attitude quaternion (scalar first) and ZYX Euler angles
    # relative to the local NED frame.
    "q_w", "q_x", "q_y", "q_z",
    "roll_deg", "pitch_deg", "yaw_deg",
    # Flight-path angle (positive up) and heading (from north, positive east).
    "gamma_deg", "chi_deg",
    "m_speed", "airspeed",
    # Atmosphere at the missile altitude.
    "air_density", "sound_speed",
    # Body-frame aerodynamic + thrust force.
    "Fbx", "Fby", "Fbz",
    # Guidance command in body axes and its load-factor magnitude.
    "a_cmd_b_x", "a_cmd_b_y", "a_cmd_b_z", "n_cmd_g",
    # Current LOS geometry in ECI and its angular-rate vector.
    "los_x", "los_y", "los_z",
    "los_rate_x", "los_rate_y", "los_rate_z",
    "t_go", "vc",
    # Navigation solution (ECI) and the position error vector vs truth.
    "nav_rx", "nav_ry", "nav_rz",
    "nav_vx", "nav_vy", "nav_vz",
    "nav_err_x", "nav_err_y", "nav_err_z",
    # Missile-to-target relative position in ECI.
    "rel_x", "rel_y", "rel_z",
    # Target geodetic position and inertial acceleration.
    "t_lat", "t_lon", "t_alt",
    "t_acc_x", "t_acc_y", "t_acc_z",
    # Seeker range measurements (noisy, current sample).
    "seeker_range", "seeker_range_rate",
    # Body axes expressed in ECI (columns of the body-to-ECI DCM).
    "bx_x", "bx_y", "bx_z",
    "by_x", "by_y", "by_z",
    "bz_x", "bz_y", "bz_z",
    # Body-frame aerodynamic + thrust moment.
    "Mbx", "Mby", "Mbz",
    # Target ECEF position and velocity.
    "t_ecef_x", "t_ecef_y", "t_ecef_z",
    "t_vecef_x", "t_vecef_y", "t_vecef_z",
    # Seeker LOS unit vector and LOS-rate vector in ECI (measured).
    "seeker_los_x", "seeker_los_y", "seeker_los_z",
    "seeker_los_rate_x", "seeker_los_rate_y", "seeker_los_rate_z",
    # Spherical gravity acceleration in ECI.
    "g_x", "g_y", "g_z",
]

# Lightweight column set for Monte-Carlo / validation runs: the extended rows
# add ~60 columns and would multiply the per-worker telemetry buffer.  Batch
# cases only need the scalar metrics, so they use the original prefix.
TELEMETRY_BASIC_COLUMNS = TELEMETRY_COLUMNS[
    :TELEMETRY_COLUMNS.index("tgt_est_err") + 1]


def validate_data():
    """Check the internal consistency of the engineering data set.

    Raises
    ------
    ValueError
        If a derived quantity (reference area, Isp, inertia, static margin)
        contradicts the published/declared value.  Called by main.py and by
        the data-consistency tests, never at import time.
    """
    # Reference area must equal the body cross-section.
    s_body = math.pi * (DIAMETER * 0.5) ** 2
    if abs(S_REF - s_body) > 1e-4:
        raise ValueError("S_REF %.6f != pi*(D/2)^2 %.6f" % (S_REF, s_body))

    # Solid motor: mean thrust, mass flow and specific impulse must agree.
    # The thrust profile is normalised, so the mean scale is the ratio of the
    # integrated profile to its duration.
    mdot = BOOST_FUEL / BOOST_BURN_TIME
    # numpy 2.x removed np.trapz; keep compatibility with both APIs
    _trapz = getattr(np, "trapezoid", None)
    if _trapz is None:
        _trapz = np.trapz
    curve_mean = float(_trapz(BOOST_THRUST_F, BOOST_THRUST_T) /
                       (BOOST_THRUST_T[-1] - BOOST_THRUST_T[0]))
    if abs(curve_mean - 1.0) > 0.02:
        raise ValueError("Boost thrust curve mean %.4f is not normalised"
                         % curve_mean)
    isp_implied = BOOST_THRUST_SL * curve_mean / (G0 * mdot)
    if abs(isp_implied - BOOST_ISP) > 0.05 * BOOST_ISP:
        raise ValueError("Boost Isp inconsistent: %.1f vs %.1f s"
                         % (isp_implied, BOOST_ISP))

    # Nozzle exit area must be physically compatible with the body: a nozzle
    # wider than the airframe would make the altitude thrust increment bogus.
    if not (0.0 < NOZZLE_EXIT_AREA < S_REF):
        raise ValueError("NOZZLE_EXIT_AREA %.4f m^2 outside (0, S_REF=%.4f)"
                         % (NOZZLE_EXIT_AREA, S_REF))

    # Ramjet efficiency envelope must be non-degenerate.
    if not (RAMJET_ALT_FULL > 0.0 and RAMJET_ALT_CUTOFF > RAMJET_ALT_FULL):
        raise ValueError("RAMJET_ALT_FULL/CUTOFF ordering is invalid")
    if not (0.0 < RAMJET_ETA_MIN <= 1.0):
        raise ValueError("RAMJET_ETA_MIN must be in (0, 1]")

    # Booster sanity anchor (THAAD public data: ~20 s burn, ~2600 m/s at
    # burnout for a pure single-stage solid round).  This vehicle is a
    # combined-cycle design, so the booster only has to hand over to the
    # ramjet above its light-off speed; the ideal delta-v is reported for
    # comparison and must clear that threshold with margin.
    boost_dv = BOOST_ISP * G0 * math.log(MASS0 / max(MASS0 - BOOST_FUEL, 1.0))
    lightoff_speed = RAMJET_MACH_MIN * 340.0
    if boost_dv < 1.2 * lightoff_speed:
        raise ValueError("Boost ideal delta-v %.0f m/s below ramjet light-off "
                         "margin %.0f m/s" % (boost_dv, 1.2 * lightoff_speed))

    # Inertia: positive, pitch/yaw symmetric, pitch larger than roll.  The
    # 0.35 lower bound reflects a lifting body whose mass is concentrated
    # near the CG (the published 3000-6000 kg*m^2 band); an upper bound near
    # unity prevents exceeding a uniformly filled slender cylinder.
    if not (IYY_FULL == IZZ_FULL and IYY_DRY == IZZ_DRY):
        raise ValueError("IYY must equal IZZ for an axisymmetric airframe")
    if not (IYY_FULL > IXX_FULL > 0.0 and IYY_DRY > IXX_DRY > 0.0):
        raise ValueError("Inertia ordering must be Iyy=Izz > Ixx > 0")
    i_uniform_full = MASS0 * (3.0 * (DIAMETER * 0.5) ** 2 + LENGTH ** 2) / 12.0
    i_uniform_dry = DRY_MASS * (3.0 * (DIAMETER * 0.5) ** 2 + LENGTH ** 2) / 12.0
    for value, baseline in ((IYY_FULL, i_uniform_full),
                            (IYY_DRY, i_uniform_dry)):
        ratio = value / baseline
        if not (0.35 <= ratio <= 1.1):
            raise ValueError("Pitch inertia is %.2f of a uniform cylinder" % ratio)

    # Static margin implied by CM_ALPHA (DATCOM M = 2 anchor) and the
    # matching CN_ALPHA table entry must agree with X_REF - CG_FULL.
    cn_alpha_m2 = float(AERO_CN_ALPHA[int(np.argmin(np.abs(AERO_MACH - 2.0)))])
    cm_alpha_m2 = float(AERO_CM_ALPHA[int(np.argmin(np.abs(AERO_MACH - 2.0)))])
    static_margin = -cm_alpha_m2 / cn_alpha_m2 * LENGTH
    if abs(static_margin - (X_REF - CG_FULL)) > 0.10:
        raise ValueError("Static margin %.3f m inconsistent with X_REF-CG %.3f m"
                         % (static_margin, X_REF - CG_FULL))
    if not (0.2 <= static_margin <= 1.2):
        raise ValueError("Static margin %.3f m outside the DATCOM band"
                         % static_margin)
    if not (0.3 * LENGTH < CG_FULL < 0.7 * LENGTH):
        raise ValueError("CG_FULL outside the plausible body range")

    # CG migration: fuel burn moves the CG forward and must leave a positive
    # static margin at dry mass, otherwise the airframe becomes unstable
    # exactly when the moment lever arm is largest.
    if not (CG_DRY < CG_FULL):
        raise ValueError("CG_DRY must be forward of CG_FULL")
    if not (X_REF - CG_DRY > 0.0):
        raise ValueError("Dry static margin X_REF-CG_DRY is not positive")
    cg_shift = CG_FULL - CG_DRY
    if not (0.2 <= cg_shift <= 0.15 * LENGTH):
        raise ValueError("CG migration %.3f m outside the plausible band"
                         % cg_shift)

    return {
        "S_BODY": s_body,
        "S_PLANFORM": S_PLANFORM,
        "ASPECT_RATIO": ASPECT_RATIO,
        "boost_isp_implied": isp_implied,
        "boost_curve_mean": curve_mean,
        "boost_ideal_dv": boost_dv,
        "boost_lightoff_speed": lightoff_speed,
        "static_margin_m": static_margin,
        "static_margin_dry_m": X_REF - CG_DRY,
        "cg_shift_m": cg_shift,
        "pitch_inertia_ratio": IYY_FULL / i_uniform_full,
    }
