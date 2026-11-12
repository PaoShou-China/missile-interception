# 2000-km-class Lifting-Body Interceptor — 6DOF End-to-End Simulation

> [README.md](README.md) | English

A complete, deterministic 6DOF digital flight of a 2000-km-class lifting-body
interceptor: vertical cold launch, solid boost, supersonic ramjet cruise,
Bezier midcourse, handover gating, and ZEM/APN terminal guidance. The plant,
navigation, seeker, autopilot, actuator and telemetry models all run in one
closed loop at a 5 ms outer step.

This English README mirrors the Chinese [README.md](README.md). It explains how
to run the project, how the modules fit together, the frames and physical
models, the key parameters, the full telemetry dictionary, validation tools,
and the known assumptions and limitations.

---

## Contents

1. [Overview](#1-overview)
2. [Quick start](#2-quick-start)
3. [Repository layout](#3-repository-layout)
4. [Architecture and data flow](#4-architecture-and-data-flow)
5. [Frames, time and Earth model](#5-frames-time-and-earth-model)
6. [6DOF rigid-body dynamics](#6-6dof-rigid-body-dynamics)
7. [Atmosphere](#7-atmosphere)
8. [Aerodynamics](#8-aerodynamics)
9. [Propulsion](#9-propulsion)
10. [Target model](#10-target-model)
11. [GNSS/INS navigation](#11-gnssins-navigation)
12. [Radar seeker](#12-radar-seeker)
13. [Guidance and handover](#13-guidance-and-handover)
14. [Control and actuators](#14-control-and-actuators)
15. [Integration, events and telemetry](#15-integration-events-and-telemetry)
16. [Monte-Carlo campaign](#16-monte-carlo-campaign)
17. [Data files](#17-data-files)
18. [Key parameters](#18-key-parameters)
19. [Tests](#19-tests)
20. [Nominal results](#20-nominal-results)
21. [Assumptions and limitations](#21-assumptions-and-limitations)
22. [References](#22-references)
- [Appendix A: symbols](#appendix-a-symbols)
- [Appendix B: telemetry dictionary](#appendix-b-telemetry-dictionary)
- [Appendix C: troubleshooting](#appendix-c-troubleshooting)

---

## 1. Overview

The simulation answers one question: can a lifting-body interceptor launched
from an inland site intercept a hard-manoeuvring fifth-generation fighter over
the sea, using only onboard navigation, a radar seeker, and a three-loop
autopilot?

The modelled engagement:

- Launch site: 40.0°N, 110.0°E, sea level.
- Threat: F-35A-class point-mass target at 28.0°N, 126.0°E, 15 240 m,
  Mach 1.6, 9 g design limit, head-on.
- Initial range: about 1 990 km.
- Missile: 2 565 kg at launch, 1 000 kg dry, 8.11 m long, 0.63 m diameter.
- Propulsion: 13 s solid booster (130 kN sea-level class) plus a
  Mach-hold supersonic ramjet up to Mach 10.
- Endgame: ZEM/APN terminal guidance with an adaptive navigation constant,
  a ±20° seeker field of view, and a 200 m blind zone.

The code is deliberately modular and deterministic. Every random stream is
seeded, every rate is explicit, and every telemetry column is documented in
[Appendix B](#appendix-b-telemetry-dictionary). The same code path supports a
single run, a Monte-Carlo campaign, and automated validation.

---

## 2. Quick start

### 2.1 Requirements

- Python 3.10 or newer (the project is developed on Python 3.14).
- NumPy and Matplotlib; Numba is optional but strongly recommended.
- On Windows, set thread limits before running a batch or validation:

```powershell
$env:OPENBLAS_NUM_THREADS="1"
$env:OMP_NUM_THREADS="1"
$env:MKL_NUM_THREADS="1"
```

Install dependencies:

```powershell
pip install -r requirements.txt
```

### 2.2 Single end-to-end run

```powershell
python main.py
```

This runs the nominal engagement, writes `output/telemetry.csv`, and generates
the interactive dashboard `output/intercept_dashboard.html`. Use
`python main.py --no-plot` to skip the dashboard.

### 2.3 Monte-Carlo campaign

```powershell
python main.py --batch
# or
python batch.py --runs 50 --out output/mc
```

The batch driver varies navigation/seeker seeds (and optionally target and
launch dispersion), runs cases in parallel processes, and writes
`output/mc/batch_results.csv` plus a summary.

### 2.4 Validation suite

```powershell
$env:OPENBLAS_NUM_THREADS="1"; $env:OMP_NUM_THREADS="1"; $env:MKL_NUM_THREADS="1"
python validate_performance.py --workers 8 --out output/validation
```

The validator runs nominal, altitude, speed, manoeuvre and combined stress
suites, then prints per-suite mean/CEP90 and the pass rate against the 15 m
criterion.

### 2.5 Tests

```powershell
python -m pytest tests -q
```

The suite covers frames, atmosphere, aero interpolation, propulsion, target,
navigation, seeker, guidance, autopilot, integrator, telemetry and data
consistency. If Numba caches a stale signature after a code change, remove
`__pycache__/numba_*` and rerun.

### 2.5b Handover diagnostics

```powershell
python tools/handover_diagnostics.py --suite baseline --workers 4
```

Reports, per case: first-lock range, handover range/time, forced-handover
flag, FOV margin, time-to-go, lead angle, available/required load, terminal
peak command vs actual load, lock-loss fraction and a verdict. Use it before
changing the lock model or the midcourse sink profile.

### 2.6 Output files

| File | Meaning |
|---|---|
| `output/telemetry.csv` | Full per-frame telemetry (132 columns by default) |
| `output/intercept_dashboard.html` | Self-contained bilingual dashboard |
| `output/mc/batch_results.csv` | One row per Monte-Carlo case |
| `output/validation/validation_results.csv` | Per-case validation results |
| `output/validation/validation_metadata.json` | Suite definitions and parameters |
| `output/handover_diagnostics/handover_diagnostics.csv` | Per-case lock/handover/FOV/t_go/lead/load and terminal response |
| `output/handover_diagnostics/handover_summary.json` | Failure classification and next-step recommendation |
| `output/*.png` | Optional static plots |

---

## 3. Repository layout

```
missile_intercept/
├── main.py                  # single-run / batch entry point, phase state machine
├── batch.py                 # parallel Monte-Carlo driver
├── validate_performance.py  # validation suites and pass/fail report
├── visualization.py         # bilingual HTML dashboard generator
├── config.py                # constants, scenario, parameters, telemetry columns
├── state_schema.py          # state-vector layout shared by Python and Numba
├── fastcore.py              # optional Numba kernels (mirror the Python laws)
├── math_utils.py            # frames, quaternions, LOS geometry, atmosphere helper
├── telemetry.py             # ring buffer / CSV writer
├── guidance/
│   ├── boost_guidance.py
│   ├── midcourse_guidance.py
│   ├── terminal_guidance.py # ZEM/APN, adaptive N, gravity compensation
│   ├── handover_manager.py
│   └── base_guidance.py
├── control/
│   ├── autopilot.py         # three-loop + roll alignment + anti-windup
│   └── fin_mixer.py
├── vehicle/
│   ├── missile.py           # mass, inertia, aero, propulsion, derivative
│   ├── target.py            # F-35A point-mass threat and defensive logic
│   ├── atmosphere.py        # USSA1976
│   └── wind.py              # optional wind model
├── sensors/
│   ├── nav_filter.py        # 6-state GNSS/INS Kalman filter
│   ├── imu.py               # IMU error model
│   ├── seeker.py            # radar/IIR seeker, FOV, blind zone, glint
│   └── datalink.py          # midcourse target cue
├── integrator.py            # fixed-step RK4 and event handling
├── tools/                   # DATCOM generator, reports, convergence checks
└── tests/                   # pytest suite
```

The dependency direction is one-way: `config` and `math_utils` are leaves;
vehicle, sensor, guidance and control modules depend on them; `main` wires
everything together. No module mutates global configuration at run time.

---

## 4. Architecture and data flow

### 4.1 State vector

The 20-state vector (see `state_schema.py`) is:

| Slice | Symbol | Meaning | Units |
|---:|---|---|---|
| 0–2 | `r_m` | Missile position, ECI | m |
| 3–5 | `v_m` | Missile velocity, ECI | m/s |
| 6–9 | `q` | Body-to-ECI quaternion (scalar first) | — |
| 10–12 | `ω` | Body angular rate, body frame | rad/s |
| 13 | `m` | Current mass | kg |
| 14–16 | `r_t` | Target position, ECI | m |
| 17–19 | `v_t` | Target velocity, ECI | m/s |

Fuel mass is derived from `m` and `dry_mass`; the centre of mass and inertia
are linear functions of the fuel fraction. The target is a 6-state point mass;
its acceleration is a function of range, geometry and the defensive phase.

### 4.2 Multi-rate sampling

| Loop | Period | Notes |
|---|---:|---|
| Outer RK4 step | 5 ms | Missile + target dynamics |
| Seeker | 5 ms | Measurement at the current step |
| Autopilot + fin mixer | 5 ms | Zero-order hold between updates |
| Guidance + handover | 5 ms | Command updated every step |
| GNSS | 1 s | Kalman measurement update |
| Telemetry | 10 ms | Logged every other outer step |

The navigation solution is delayed by 50 ms (`NAV_DELAY`) to represent the
real output latency. Guidance extrapolates the delayed state to the current
tick before computing the command.

### 4.3 Data contract

`config.py` owns every physical constant and every tunable. The most important
groups are:

- Physical constants and Earth model.
- Scenario and target definition.
- Airframe geometry, mass, inertia and CG travel.
- Propulsion and ramjet limits.
- Aero tables and coefficients.
- Autopilot gains and limits.
- Seeker, navigation and datalink parameters.
- Handover and terminal guidance parameters.
- Telemetry column definitions.

### 4.4 Phase state machine

1. **Boost**: vertical cold launch for 2 s, then a gravity-turn pitch
   programme until 20 s.
2. **Midcourse**: 3D cubic Bezier reference + PN + energy management; target
   cue from the datalink.
3. **Terminal**: entered when all handover gates hold continuously for 0.2 s;
   ZEM/APN until impact or closest approach.
4. **End**: impact, miss, ground impact, or timeout.

### 4.5 Frames

- **ECI**: inertial frame used by the dynamics and navigation.
- **ECEF**: Earth-fixed frame used for telemetry and geodesy.
- **LLH**: WGS84 geodetic latitude, longitude and altitude.
- **Local NED / ENU**: local navigation frames at the missile.
- **Body**: X forward, Y right, Z down; aero and propulsion act here.
- **LOS**: line-of-sight frame for relative geometry and terminal guidance.

---

## 5. Frames, time and Earth model

The default Earth model is WGS84 (`EARTH_MODEL="wgs84"`), with the J2
oblateness term in gravity. `EARTH_MODEL="sphere"` reproduces the older
spherical model exactly.

Key constants:

| Quantity | Value |
|---|---|
| `G0` | 9.80665 m/s² |
| `MU` | 3.986004418 × 10¹⁴ m³/s² |
| `OMEGA_EARTH` | 7.2921150 × 10⁻⁵ rad/s |
| `WGS84_A` | 6 378 137.0 m |
| `WGS84_F` | 1 / 298.257223563 |
| `J2` | 1.08262668 × 10⁻³ |

Functions in `math_utils.py`:

- `llh_to_eci`, `eci_to_llh`: WGS84 geodesy and ECI conversion.
- `local_enu_dcm`: local ENU basis expressed in ECI.
- `gravity_eci`: central gravity plus J2.
- `atmosphere_relative_velocity`: removes Earth-rotation carry-over.
- `los_geometry`: LOS unit vector, range, range rate, angular-rate vector.
- Quaternion helpers: multiply, rotate, inverse rotate, DCM, normalize.

Time is seconds from launch. Earth rotation is applied consistently in the
ECEF telemetry columns and in the air-relative velocity.

---

## 6. 6DOF rigid-body dynamics

### 6.1 Translation

```
r_dot = v
v_dot = (F_aero + F_thrust + F_gravity) / m
```

All forces are summed in ECI; aero and thrust are produced in the body frame
and rotated with the current quaternion.

### 6.2 Quaternion kinematics

```
q_dot = 0.5 * q ⊗ [0, ω]
```

The quaternion is renormalised every step to prevent drift. The body-to-ECI
DCM is `R(q)`; body rates are `p, q, r` about X, Y, Z.

### 6.3 Rotation

```
I ω_dot = M_body - ω × (I ω)
```

The inertia tensor is diagonal and interpolated between the full and dry
states:

| Axis | Full (kg·m²) | Dry (kg·m²) |
|---|---:|---:|
| X (roll) | 190 | 90 |
| Y (pitch) | 6 000 | 2 400 |
| Z (yaw) | 6 000 | 2 400 |

### 6.4 Variable mass and CG travel

- Launch mass 2 565 kg; dry mass 1 000 kg.
- Solid propellant 800 kg, ramjet fuel 765 kg.
- CG moves from 4.45 m to 4.10 m from the nose as fuel is consumed.
- Inertia scales with mass between the full and dry values.
- Thrust is zero when the propellant is exhausted; mass is floored at dry mass.

### 6.5 Stagnation pressure

Above the DATCOM range, the code uses a Newtonian/Rayleigh pitot model to
build the hypersonic normal-force slope and the pressure drag increment. The
blend between the DATCOM and hypersonic tables is smooth in Mach.

---

## 7. Atmosphere

`vehicle/atmosphere.py` implements USSA1976:

- Layered temperature/pressure database up to 86 km.
- Standard lapse-rate formulas inside each layer.
- Exponential tail above 86 km.
- Outputs: density, pressure, temperature, speed of sound.

The aero model uses air-relative velocity, so Earth rotation and (if enabled)
wind are subtracted before Mach and dynamic pressure are computed.

---

## 8. Aerodynamics

### 8.1 Data sources

- M ≤ 5: Digital DATCOM tables in `output/datcom_aero.csv`, generated by
  `tools/datcom_aero.py`.
- M > 5: modified Newtonian / lifting-body correlations.
- Smooth bridge between the two bands (M 0.5–1.6) with a CN derate and a CD
  margin.

### 8.2 Coefficients

The model provides:

- `CN_alpha(M)` normal-force slope.
- `CD0(M)` zero-lift drag.
- `CM_alpha(M)` pitch stiffness (negative, stable).
- Induced-drag factor `K(M)`.
- Large-alpha shape factors.
- Fin effectiveness and nonlinearity.
- Pitch/yaw damping and roll damping.

### 8.3 Forces and moments

```
F_body = q S [CN, CY, -CA] + thrust
M_body = q S L [CM, CN, CR] + damping
```

`q = 0.5 ρ V_air²`, `S = 0.3117 m²`, `L = 8.11 m`. The pitching moment includes
the static margin `X_REF - CG`; the CG moves forward as fuel burns.

### 8.4 Fin nonlinearity

Fin effectiveness saturates near the mechanical limit and is reduced at low
dynamic pressure. The fin mixer maps virtual pitch/yaw/roll commands to the
four physical fins; position and rate limits are enforced.

---

## 9. Propulsion

### 9.1 Solid booster

- Burn time 13 s, propellant 800 kg, sea-level thrust 130 kN, Isp 215 s.
- Thrust profile: ignition transient, steady plateau, tail-off.
- Altitude correction: `F = F_sl + A_e (P_sl - P_a)`, with `A_e = 0.196 m²`.

### 9.2 Supersonic ramjet

- Light-off: Mach 1.6, q ≥ 2.5 kPa.
- Operating range: Mach 1.6–10.
- Reference Isp 1500 s; inlet capture area 0.22 m².
- Thrust cap 60 kN; fuel flow cap 3 kg/s.
- Efficiency falls above 18 km, reaches zero at 32 km, and rolls off with Mach.

### 9.3 Mach-hold control

A PI law trims fuel flow to hold the commanded Mach. The throttle is limited
by the ramjet map, the fuel-flow cap and the available propellant. The
autopilot and guidance see the actual thrust, not the command.

### 9.4 Phase logic

The booster burns from 0 to 13 s; the boost phase ends at 20 s. The ramjet can
light off after the booster if Mach and q are inside the envelope. If the
ramjet cannot light, the missile continues ballistically.

---

## 10. Target model

The target is an F-35A-class point mass:

| Parameter | Value |
|---|---|
| Initial position | 28.0°N, 126.0°E, 15 240 m |
| Speed | Mach 1.6 |
| Design load limit | 9 g (A); 7–7.5 g for B/C |
| Wing area / span | 42.7 m² / 10.7 m |
| Mass | 20 000 kg |
| Reference length | 15.7 m (glint scale) |

Defensive behaviour is range-gated:

1. **Cruise** beyond 60 km.
2. **Defend** at 60 km: beam/notch turn at up to 6 g with a 1 g dive.
3. **Evade** at 15 km: 9 g weave/jink, limited by the available lift at the
   current altitude and Mach.
4. **Terminal jink** in the last few seconds.

The target speed bleeds from induced drag while manoeuvring. A first-order
onset lag models roll/manoeuvre reversal.

---

## 11. GNSS/INS navigation

### 11.1 Filter

A 12-state linear Kalman filter estimates position, velocity, accelerometer
bias and gyro bias in ECI:

```
x = [r, v, b_acc, b_gyro]
F = [[0, I], [0, 0]]
```

- Process noise: continuous acceleration PSD 0.5 m²/s³.
- GNSS update: 1 s, position σ = 8 m per axis, velocity σ = 0.15 m/s.
- Output delay: 50 ms.
- Attitude is propagated by the IMU and corrected by GNSS velocity heading
  when the sideslip is small.

### 11.2 IMU error model

- Acceleration white noise: 0.012 m/s² per 5 ms sample.
- Initial bias: 0.0147 m/s² (1.5 mg).
- Bias instability: 0.0015 m/s² (150 µg).
- Bias correlation time: 1 000 s.
- Optional star tracker / attitude aid.

### 11.3 What guidance sees

Guidance receives the delayed navigation estimate, not truth. The terminal law
extrapolates it to the current tick with the last command plus gravity. The
seeker measurements are separate and are used for lock, FOV and (when
available) LOS-rate diagnostics.

---

## 12. Radar seeker

### 12.1 Measurements

- LOS unit vector in ECI.
- LOS angular-rate vector.
- Range and range rate.
- Lock flag, FOV angle, blind-zone flag.

### 12.2 Noise

| Quantity | 1σ |
|---|---|
| Angle white noise | 1 mrad |
| Glint | 0.30 × target length / range (DTIC form) |
| Range | 5 m |
| Range rate | 2 m/s |

The seeker also models Swerling-like dropouts (0.05/s in track) and false
locks (0.01/s out of track).

### 12.3 Field of view and lock

- Half-FOV: 20°.
- Blind range: 200 m.
- Radar lock range: 45 km at 5 m² RCS, scaled by `(RCS/5)^0.25`.
- IIR backup: 25 km, RCS-independent.
- Lock requires the target inside the FOV and above the detection threshold.

---

## 13. Guidance and handover

### 13.1 Boost

Vertical cold launch for 2 s, then a gravity-turn pitch programme. The pitch
rate is limited by the achievable normal force plus the thrust-vector term.
The programme ends at a 30° flight-path angle at 20 s.

### 13.2 Midcourse

- 3D cubic Bezier reference from the launch point to a predicted intercept
  point (PIP).
- PN correction toward the PIP.
- Energy management: throttle/Mach hold and climb/descent shaping.
- Datalink cue updates the target estimate before handover.

### 13.3 Terminal: ZEM/APN

```
t_go = max(R / Vc, 0.05)
ZEM  = ρ + v_rel t_go + 0.5 a_T t_go²
a    = N_eff ZEM_perp / t_go² - g_perp
```

- `N` base 4.0; adaptive boost up to +40% near impact; floor 3.0.
- `a_T` is the finite-difference target acceleration, low-pass filtered.
- Gravity compensation is applied only normal to the velocity.
- Command limit: 40 g.
- A soft FOV guard acts only near the seeker edge.

### 13.4 Handover

Handover occurs when all gates hold continuously for 0.2 s:

- Range ≤ 45 km (38 km forced floor).
- Altitude advantage within the depression limit (≤ 22° look-down).
- Speed ≥ 1 800 m/s.
- Lead angle ≤ 12°.
- Seeker locked and FOV ≤ 90% of the half-FOV.
- Time-to-go ≥ 4 s.
- Available load ≥ 4 g.

The midcourse and terminal commands are cross-faded over 0.5 s. If the gates
cannot be met, the forced-handover path uses the predicted FOV and geometry.

---

## 14. Control and actuators

### 14.1 Three-loop autopilot

- Outer loop: pseudo-angle of attack / sideslip → body-rate command.
- Middle loop: body-rate → virtual fin command.
- Inner loop: fin actuator dynamics and mixing.
- Command pre-filter: second-order, 10 Hz (scheduled down at low q).
- Pitch-rate crossover: 22 rad/s.
- Roll alignment: lift vector rolled into the pitch plane, gain 4.0 1/s,
  rate limit 6 rad/s.
- Anti-windup, low-q gain floors and fin position/rate limits.

### 14.2 Fin mixer

Four physical fins in a cruciform layout:

```
δ_up    =  δ_pitch + δ_roll
δ_down  = -δ_pitch + δ_roll
δ_left  =  δ_yaw   - δ_roll
δ_right = -δ_yaw   - δ_roll
```

Each fin is limited to ±25° and to the actuator rate limit. Saturation is
reported in telemetry (`fin_sat`).

### 14.3 Gain scheduling

The rate-loop gain is scheduled from the instantaneous fin authority, inertia
and dynamic pressure; no offline table or retuning is required.

---

## 15. Integration, events and telemetry

### 15.1 Integrator

- Fixed-step RK4 with a 5 ms outer step.
- State reconstruction inside the step for guidance/autopilot zero-order hold.
- The optional Numba kernel mirrors the Python laws; tests check equivalence.

### 15.2 Events

- Impact: range-rate zero crossing with range below the gate.
- Ground impact: altitude below zero.
- Seeker blind zone: range below 200 m.
- Timeout: `t_end` (1 200 s default).

The miss distance is the interpolated range at the range-rate zero crossing,
not the last-frame range.

### 15.3 Telemetry

- 132 columns in the full profile.
- 48 columns in the basic profile used by Monte-Carlo/validation.
- CSV writer plus an in-memory ring buffer.
- Column definitions live in `config.py`; the full dictionary is in
  [Appendix B](#appendix-b-telemetry-dictionary).

---

## 16. Monte-Carlo campaign

`batch.py` runs independent cases in parallel processes:

- Navigation seed and seeker seed.
- Optional target altitude, speed, manoeuvre load.
- Optional launch dispersion.
- Optional sensor-noise scale.

Each case returns miss distance, miss time, final phase, peak load, peak
dynamic pressure and pass/fail. Results are written to
`output/mc/batch_results.csv`. Statistics include mean, standard deviation,
CEP50, CEP90, maximum and pass rate.

Reproducibility: each case derives its seeds from a base seed and the case
index; the same base seed reproduces the same campaign.

---

## 17. Data files

| File | Contents |
|---|---|
| `output/datcom_aero.csv` | DATCOM CN/CD/CM tables for M ≤ 5 |
| `data/ussa1976.csv` | USSA1976 layer data (if present) |
| `output/telemetry.csv` | Per-frame telemetry |
| `output/mc/batch_results.csv` | Monte-Carlo results |
| `output/validation/*` | Validation results and metadata |
| `output/handover_diagnostics/*` | Per-case handover diagnostics and summary |

The aero CSV fields are Mach, alpha, CN, CD, CM and the reference area/length
used by the generator. The scenario, geometry and mass data are constants in
`config.py`, not external files, so a run is self-contained.

---

## 18. Key parameters

### 18.1 Scenario and phases

| Parameter | Value |
|---|---|
| Launch | 40.0°N, 110.0°E, 0 m |
| Target | 28.0°N, 126.0°E, 15 240 m |
| Target Mach | 1.6 |
| Target load limit | 9 g |
| Boost end | 20 s |
| Ramjet light-off | Mach 1.6, q ≥ 2.5 kPa |
| Handover range | 45 km (38 km floor) |
| Terminal command limit | 40 g |

### 18.2 Airframe, aero and control

| Parameter | Value |
|---|---|
| Length / diameter | 8.11 m / 0.63 m |
| Reference area | 0.3117 m² |
| Launch / dry mass | 2 565 kg / 1 000 kg |
| CG travel | 4.45 → 4.10 m |
| `CN_alpha` (M 2) | ≈ 10.3 1/rad |
| `CD0` (M 2) | ≈ 0.34 |
| Fin limit | ±25° |
| Pitch-rate crossover | 22 rad/s |
| Pitch outer-loop gain | 6.0 |
| Pitch rate-loop gain | 0.14 |
| Attitude command prefilter | 1–10 Hz (with q) |
| Load-factor loop `AP_NZ_LOOP` (`AP_KP_NZ`/`AP_KI_NZ`) | on / 0.02 rad·s⁻¹·g⁻¹ / 0.004 |
| Load-factor lead `AP_NZ_LEAD` | 0.06 s (4-seed mean 3.3 m vs 17.7 m baseline) |
| Roll-alignment gain | 4.0 1/s |

### 18.3 Seeker and navigation

| Parameter | Value |
|---|---|
| Seeker FOV | ±20° |
| Blind range | 200 m |
| Radar lock range | 45 km at 5 m² RCS |
| IIR lock range | 25 km |
| Angle noise | 1 mrad |
| Range noise | 5 m |
| GNSS update | 1 s |
| Nav delay | 50 ms |
| GNSS position σ | 8 m |
| GNSS velocity σ | 0.15 m/s |

### 18.4 Numerical

| Parameter | Value |
|---|---|
| Outer step | 5 ms |
| Seeker / autopilot / guidance | 5 ms |
| Telemetry | 10 ms |
| Integrator | RK4 |
| Simulation end | 1 200 s |

---

## 19. Tests

Run:

```powershell
python -m pytest tests -q
```

Coverage:

- Frame conversions and quaternion round-trips.
- USSA1976 continuity and limits.
- Aero interpolation and hypersonic blending.
- Propulsion thrust and mass flow.
- Target acceleration and defensive phases.
- GNSS/INS convergence and delay handling.
- Seeker noise, FOV and lock logic.
- ZEM/APN command direction, clipping and t_go.
- Autopilot rate loop, roll alignment and fin limits.
- RK4 accuracy and event interpolation.
- Telemetry width, column order and finite values.
- Batch determinism and validation aggregation.

If a Numba kernel reports a signature mismatch after editing a function
argument list, clear `__pycache__/numba_*`. The Python and compiled kernels are
kept equivalent by design; the tests compare them when Numba is available.

---

## 20. Nominal results

A nominal run with the default seeds produces approximately:

| Metric | Value |
|---|---|
| Miss distance | ≈ 26 m |
| Flight time | ≈ 672 s |
| Terminal phase | reached |
| Peak altitude | ≈ 30 km |
| Peak speed | ≈ 3.1 km/s |
| Max dynamic pressure | ≈ 0.89 MPa |
| Peak command load | 40 g |
| Actual peak load | ≈ 12 g |
| Handover time / range | ≈ 664.5 s / 24.3 km |
| Terminal duration | ≈ 8 s |
| FOV exceedance | ≈ 5.6% |
| Telemetry | ≈ 67 k frames × 132 columns |

Exact numbers depend on the seed, the target-defence phase and the handover
geometry. The Monte-Carlo and validation tools are the authoritative way to
measure a change; do not tune to a single seed.

The validation pass criterion is a 15 m miss distance. Under the current
F-35A scenario and the radar-lock model, some low-altitude or low-RCS cases
hand over late or lose lock; those are scenario/seeker/handover limitations,
not terminal-guidance tuning errors.

---

## 21. Assumptions and limitations

1. **Point-mass target**: the target has no attitude, control lag or sensor
   model beyond the range-gated manoeuvre logic.
2. **Aero data**: DATCOM below Mach 5 and modified Newtonian above; the
   transition band is engineering-smoothed.
3. **Atmosphere**: USSA1976, no winds by default; the optional wind model is
   not wired into the compiled derivative by default.
4. **Seeker**: radar/IIR with white noise, glint, dropout and false-lock
   statistics; no terrain, clutter or electronic attack.
5. **Navigation**: 12-state GNSS/INS; no star tracker by default; the 50 ms
   output delay is modelled.
6. **Autopilot**: three-loop linear design with nonlinear limits; no structural
   bending, fuel slosh or actuator bandwidth beyond the first-order model.
7. **Guidance**: ZEM/APN; no impact-angle constraint, no cooperative
   midcourse-terminal optimization.
8. **Earth**: WGS84 with J2; no higher-order gravity, winds or tides.
9. **Determinism**: all random streams are seeded; a run is reproducible on
   the same platform and library versions.

The model is intended for algorithm and software verification, not for
operational performance claims. Public complete data for a 2000-km-class
interceptor are scarce; geometry, mass, aero and propulsion values are
engineering extrapolations from public sources.

---

## 22. References

### Aerodynamics and atmosphere

- USAF Digital DATCOM (January 1996).
- NASA USSA1976, NASA-TM-X-74335.
- Modified Newtonian / lifting-body hypersonic correlations.

### Guidance, control and estimation

- JAST-Bezier midcourse guidance, Mohamadifard & Naghash, JAST Vol. 8 No. 2.
- ZEM/APN terminal-guidance survey (Evduzen, 2026); standard PN/APN
  literature.
- Hacettepe three-loop autopilot / TU-Delft anti-windup and gain scheduling.
- GNSS/INS noise levels from `gnss-ins-sim`.
- Glint model from DTIC.

### Software

- NumPy, Numba, Matplotlib, pytest.
- Digital DATCOM parser (`tools/datcom_aero.py`).
- ECharts for the HTML dashboard.

---

## Appendix A: symbols

| Symbol | Meaning | Units |
|---|---|---|
| `r, v` | Position and velocity, ECI | m, m/s |
| `q` | Body-to-ECI quaternion | — |
| `ω` | Body angular rate | rad/s |
| `m` | Mass | kg |
| `α, β` | Angle of attack, sideslip | rad |
| `q_dyn` | Dynamic pressure | Pa |
| `Ma` | Mach number | — |
| `R` | Missile-target range | m |
| `Vc` | Closing velocity | m/s |
| `t_go` | Time-to-go | s |
| `ZEM` | Zero-effort miss | m |
| `N` | Navigation constant | — |
| `a_cmd` | Guidance command acceleration | m/s² |
| `δ` | Fin deflection | rad |
| `λ` | LOS angle | rad |
| `ω_LOS` | LOS angular rate | rad/s |

---

## Appendix B: telemetry dictionary

The full profile has 132 columns. The basic profile (Monte-Carlo/validation)
keeps the first 48 columns through `tgt_est_err`.

### Core columns (0–47)

| # | Column | Meaning | Unit |
|---:|---|---|---|
| 0 | `time` | Simulation time | s |
| 1–3 | `m_rx/ry/rz` | Missile position, ECI | m |
| 4–6 | `m_vx/vy/vz` | Missile velocity, ECI | m/s |
| 7–9 | `t_rx/ry/rz` | Target position, ECI | m |
| 10–12 | `t_vx/vy/vz` | Target velocity, ECI | m/s |
| 13 | `mass` | Missile mass | kg |
| 14 | `mach` | Mach number | — |
| 15 | `q_dyn` | Dynamic pressure | Pa |
| 16 | `alt` | Missile altitude | m |
| 17–18 | `lat, lon` | Missile geodetic latitude/longitude | deg |
| 19–20 | `alpha, beta` | Angle of attack / sideslip | rad |
| 21–23 | `nx, ny, nz` | Body load factors | g |
| 24–26 | `a_cmd_x/y/z` | Guidance command, ECI | m/s² |
| 27–29 | `a_act_x/y/z` | Actual non-gravity acceleration, ECI | m/s² |
| 30–33 | `fin_up/down/left/right` | Physical fin deflections | rad |
| 34 | `fin_sat` | Fin saturation flag | — |
| 35 | `nav_err` | Navigation position error magnitude | m |
| 36 | `range` | Missile-target range | m |
| 37 | `range_rate` | Range rate | m/s |
| 38 | `seeker_lock` | Seeker lock flag | — |
| 39 | `fov_angle` | Seeker off-boresight angle | rad |
| 40 | `phase` | Phase code (1 boost, 2 mid, 3 terminal) | — |
| 41 | `handover` | Handover flag | — |
| 42 | `dh` | Altitude difference | m |
| 43 | `lead_angle` | Lead angle | rad |
| 44–46 | `p, q_rate, r_rate` | Body angular rates | rad/s |
| 47 | `tgt_est_err` | Target-estimate error | m |

### Extended columns (48–131)

| # | Column | Meaning | Unit |
|---:|---|---|---|
| 48–50 | `m_ecef_x/y/z` | Missile ECEF position | m |
| 51–53 | `m_vecef_x/y/z` | Missile ECEF velocity | m/s |
| 54–56 | `m_vned_n/e/d` | Missile local-NED velocity | m/s |
| 57–60 | `q_w, q_x, q_y, q_z` | Body-to-ECI quaternion | — |
| 61–63 | `roll_deg, pitch_deg, yaw_deg` | Body-to-NED ZYX Euler angles | deg |
| 64–65 | `gamma_deg, chi_deg` | Flight-path angle / heading | deg |
| 66–67 | `m_speed, airspeed` | Inertial speed / airspeed | m/s |
| 68–69 | `air_density, sound_speed` | Local density / speed of sound | kg/m³, m/s |
| 70–72 | `Fbx, Fby, Fbz` | Body aero + thrust force | N |
| 73–75 | `a_cmd_b_x/y/z` | Guidance command, body axes | m/s² |
| 76 | `n_cmd_g` | Command load magnitude | g |
| 77–79 | `los_x/y/z` | LOS unit vector, ECI | — |
| 80–82 | `los_rate_x/y/z` | LOS angular-rate vector, ECI | rad/s |
| 83–84 | `t_go, vc` | Time-to-go / closing velocity | s, m/s |
| 85–87 | `nav_rx/ry/rz` | Navigation position, ECI | m |
| 88–90 | `nav_vx/vy/vz` | Navigation velocity, ECI | m/s |
| 91–93 | `nav_err_x/y/z` | Navigation position error, ECI | m |
| 94–96 | `rel_x/y/z` | Target relative position, ECI | m |
| 97–99 | `t_lat, t_lon, t_alt` | Target geodetic position | deg, m |
| 100–102 | `t_acc_x/y/z` | Target inertial acceleration, ECI | m/s² |
| 103–104 | `seeker_range, seeker_range_rate` | Seeker range / range rate | m, m/s |
| 105–107 | `bx_x/y/z` | Body X axis in ECI | — |
| 108–110 | `by_x/y/z` | Body Y axis in ECI | — |
| 111–113 | `bz_x/y/z` | Body Z axis in ECI | — |
| 114–116 | `Mbx, Mby, Mbz` | Body aero + thrust moment | N·m |
| 117–119 | `t_ecef_x/y/z` | Target ECEF position | m |
| 120–122 | `t_vecef_x/y/z` | Target ECEF velocity | m/s |
| 123–125 | `seeker_los_x/y/z` | Seeker LOS unit vector, ECI | — |
| 126–128 | `seeker_los_rate_x/y/z` | Seeker LOS angular rate, ECI | rad/s |
| 129–131 | `g_x, g_y, g_z` | Gravity acceleration, ECI | m/s² |

---

## Appendix C: troubleshooting

| Symptom | Likely cause / action |
|---|---|
| `Numba signature mismatch` | Stale cache: delete `__pycache__/numba_*` and rerun |
| `Telemetry width mismatch` | A column was added to `TELEMETRY_COLUMNS` without a value (or vice versa) |
| Batch becomes very slow or swaps | Set the three thread-limit variables; use `--workers` ≤ CPU cores |
| Dashboard has no charts | Open it in a modern browser and ensure JavaScript is enabled |
| Miss distance is huge / midcourse phase | Check seeker lock range, handover gates and target RCS; this is not always a terminal-law problem |
| Target never manoeuvres | Check `TARGET_EVADE_G`, `TARGET_DEFEND_DIST`, `TARGET_MANEUVER_DIST` |
| Ramjet never lights | Check Mach ≥ 1.6 and q ≥ 2.5 kPa; the booster must finish first |
| `Wind` parameters are zero | The wind model is optional and not wired into the compiled derivative by default |

---

*This English README is kept in sync with the Chinese README. If a parameter
changes, update `config.py` first, then both READMEs.*
