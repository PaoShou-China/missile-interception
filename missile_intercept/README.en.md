# 2000-km-class Hypersonic Interceptor — 6DOF End-to-End Simulation

**User Guide + Technical Notes**

> [中文](README.md) | [English](README.en.md)

A modular, testable and parallel hypersonic-interceptor simulation in pure Python/NumPy. It covers vertical cold launch, solid boost plus supersonic ramjet combined-cycle propulsion, GNSS/INS navigation, a dual-mode radar/IR seeker, three-loop attitude control, Bezier loft-dive midcourse guidance, ZEM/APN terminal guidance, handover management, multi-rate sampling and Monte-Carlo campaigns.

> **Disclaimer**: complete public data for a 2000-km-class interceptor are scarce. The geometry, mass, inertia, aerodynamic and propulsion parameters in `config.py` are an **engineering extrapolation** from public sources plus generic hypersonic-vehicle characteristics. They are intended only for algorithm, software and architecture verification, and do not represent measured data or performance figures of any fielded system.

---

## Contents

1. [Overview](#1-overview)
2. [Quick start](#2-quick-start)
3. [Repository layout](#3-repository-layout)
4. [Architecture and data flow](#4-architecture-and-data-flow)
5. [Frames and Earth model](#5-frames-and-earth-model)
6. [6DOF rigid-body dynamics](#6-6dof-rigid-body-dynamics)
7. [Atmosphere and aerodynamics](#7-atmosphere-and-aerodynamics)
8. [Combined-cycle propulsion](#8-combined-cycle-propulsion)
9. [Target model](#9-target-model)
10. [Navigation and seeker](#10-navigation-and-seeker)
11. [Guidance and handover](#11-guidance-and-handover)
12. [Control and actuators](#12-control-and-actuators)
13. [Numerics and telemetry](#13-numerics-and-telemetry)
14. [Current single-shot results](#14-current-single-shot-results)
15. [Tests and performance validation](#15-tests-and-performance-validation)
16. [Key parameters](#16-key-parameters)
17. [Assumptions and scope](#17-assumptions-and-scope)
18. [References](#18-references)

---

## 1. Overview

| Item | Contents |
|---|---|
| Mission | Inland launch site → sea target at about 1990 km and 15.24 km altitude, head-on intercept |
| Phases | Vertical cold launch → gravity-turn boost → constant-q midcourse cruise → ZEM/APN terminal |
| Propulsion | Solid booster (13 s, 800 kg) + supersonic ramjet (Mach 1.6–10) |
| Dynamics | 14-state rigid body (3 position + 3 velocity + 4 quaternion + 3 rate + 1 mass) |
| Target | F-35A-class threat (3DOF point mass), Mach 1.6 constant-altitude cruise, 9 g weaving inside 15 km |
| Navigation | INS prediction + 1 Hz GNSS, 12-state linear Kalman filter, 50 ms output delay |
| Seeker | Dual-mode radar + imaging infrared, 5 ms measurement, ±20° FOV, 200 m blind zone |
| Control | Three-loop PID (pseudo AoA → rate → virtual fin) + anti-windup + dynamic-pressure gain scheduling |
| Integration | Native fixed-step RK4 + direction-aware event detection + bisection localisation |
| Parallelism | `ProcessPoolExecutor` Monte-Carlo, reproducible with fixed seeds |

Current single-shot results (`output/telemetry.csv`, run of 2026-11-13):

| Metric | Value |
|---|---:|
| Miss distance (10 ms telemetry sample) | **13.40 m** |
| Miss distance (integrator event locator) | 7.94 m |
| Intercept time | 676.46 s |
| Peak speed / Mach | 3094.5 m/s / 9.48 |
| Peak dynamic pressure | 881.3 kPa |
| Peak altitude | 29.93 km |
| Peak load factor | 40.0 g commanded / 10.6 g measured |
| Downrange | 1846.3 km |
| Handover time / downrange | 668.79 s / 1824.9 km |
| Terminal duration | 7.67 s |
| FOV exceedance | 6.4 % |
| Propellant used | 1424.4 kg (solid 800 + ramjet about 664) |
| Telemetry frames | 67 647 |

---

## 2. Quick start

### 2.1 Requirements

- Python 3.9+ (code keeps 3.6+ syntax compatibility)
- NumPy 1.x / 2.x
- Optional: SciPy (Sobol sampling), matplotlib (batch histograms), Numba (hot-path acceleration with automatic fallback)
- Tests: pytest, pytest-xdist

```bash
python -m pip install numpy scipy pytest pytest-xdist
# optional
python -m pip install numba matplotlib
```

### 2.2 Single run

```bash
cd missile_intercept

python main.py                          # boost/terminal 5 ms, midcourse 10 ms
python main.py --max-step 0.002         # finer boost/terminal step
python main.py --midcourse-step 0.005   # midcourse back to 5 ms
python main.py --duration 900           # set simulation end time
python main.py --no-plot                # CSV only
python main.py --converge               # step convergence + Richardson extrapolation
```

At start-up `config.validate_data()` checks reference area, specific impulse, inertia, static stability margin, centre-of-gravity travel and other consistency conditions, and raises on failure.

### 2.3 Monte-Carlo campaign

```bash
python main.py --batch 20 --workers 8
python batch.py --cases 50 --workers 8 --seed 2026

python batch.py --cases 50 \
  --launch-cep 500 --target-cep 2000 \
  --target-alt-sigma 500 --target-mach-sigma 0.05 \
  --evade-g-sigma 1.0 --lethal-radius 10
```

### 2.4 Tests and analysis

```bash
python -m pytest -n auto
python verification.py
python analysis.py sweep spec.json
python analysis.py sobol spec.json --cases 64
python analysis.py mc --checkpoint out.jsonl --resume
```

### 2.5 Outputs

| Path | Contents |
|---|---|
| `output/telemetry.csv` | Full single-shot telemetry (132 columns by default, 10 ms per frame) |
| `output/intercept_dashboard.html` | Six-panel interactive dashboard (Canvas, no front-end dependencies) |
| `output/batch/batch_results.csv` | Per-case miss distance, intercept time, phase, CPU time |
| `output/validation/` | Per-scenario performance validation report and summary |
| `output/handover_diagnostics/` | Per-case handover diagnostics |
| `intercept-report/` | Single-page HTML report data and page |

---

## 3. Repository layout

```text
missile_intercept/
├── config.py                    # constants, data contracts, SimConfig, start-up checks
├── math_utils.py                # 3D vectors / quaternions / ECI-LLH-ENU
├── integrator.py                # RK4/RK45 + events + bisection localisation
├── state_schema.py              # packed-state layout and hash
├── telemetry.py                 # preallocated telemetry buffer
├── fastcore.py                  # optional Numba hot paths with fallback
├── main.py                      # sampling schedule, events, telemetry, plotting
├── batch.py                     # multiprocess Monte-Carlo (JSONL resume)
├── analysis.py                  # sweeps / Sobol / cross-entropy / MC
├── verification.py              # numerical verification suite
├── visualization.py             # self-contained HTML dashboard
├── vehicle/
│   ├── missile.py               # aero / propulsion / variable-mass 6DOF
│   ├── target.py                # 3DOF target
│   ├── atmosphere.py            # USSA1976
│   └── wind.py                  # optional wind model
├── sensors/
│   ├── navigation.py            # INS + 1 Hz GNSS Kalman filter
│   ├── seeker.py                # 5 ms dual-mode seeker
│   └── target_tracker.py        # target-state estimation
├── control/
│   ├── autopilot.py             # three-loop PID + anti-windup + gain scheduling
│   ├── fin_mixer.py             # cruciform fin mixing and limiting
│   └── thrust_controller.py     # ramjet Mach hold
├── guidance/
│   ├── boost_guidance.py        # vertical cold launch + gravity turn
│   ├── midcourse_guidance.py    # Bezier + loft-dive + angle constraint + prediction
│   ├── terminal_guidance.py     # ZEM/APN + adaptive N
│   └── handover_manager.py      # gates + weight blending
├── tools/                       # DATCOM, aero cross-check, UQ, tuning, reports
└── tests/                       # pytest (supports -n auto)
```

Dependency direction is strictly one-way: `config / math_utils → vehicle / sensors / control / guidance → main`. Modules interact through dataclass contracts with no global mutable state.

---

## 4. Architecture and data flow

### 4.1 State vector

The integrator maintains a 20-dimensional packed state:

```text
y = [r_m(3), v_m(3), q_m(4), ω_m(3), m_m(1) | r_t(3), v_t(3)]
      missile 14 states                       target 6 states
```

- `r_m / v_m`: ECI position / velocity
- `q_m`: body-to-ECI quaternion, scalar first `[w, x, y, z]`
- `ω_m`: body-frame angular rate `[p, q, r]`
- `m_m`: current mass

### 4.2 Multi-rate sampling (ZOH)

Discrete modules are sampled once at the start of each outer step; RK4 integrates only the continuous dynamics.

| Module | Period | Configuration |
|---|---:|---|
| Seeker | 5 ms | `DT_SEEKER` |
| Attitude control + fin mixing | 5 ms | `DT_AUTOPILOT` |
| Guidance + handover + thrust control | 5 ms | `DT_GUIDANCE` |
| GNSS measurement update | 1 s | `DT_GNSS` |
| Telemetry | 10 ms | `DT_LOG` |
| Navigation output delay | 50 ms | `NAV_DELAY` |
| Outer step (boost/terminal) | 5 ms | `DEFAULT_MAX_STEP` |
| Outer step (midcourse) | 10 ms | `DEFAULT_MIDCOURSE_MAX_STEP` |

The midcourse phase therefore samples at 100 Hz, while boost and terminal run at 200 Hz.

### 4.3 Data contracts

| Dataclass | Purpose | Key fields |
|---|---|---|
| `MissileState` | Missile state | `r_eci, v_eci, q, omega_body, mass, inertia, cg_pos` |
| `NavEstimate` | Navigation output | `r_eci, v_eci, timestamp` |
| `SeekerMeasurement` | Seeker measurement | `los_angle, los_rate, range, range_rate, is_locked, fov_angle` |
| `GuidanceCommand` | Guidance command | `a_cmd_eci, phase` |
| `ActuatorCommand` | Fin command | `delta_fins(4), is_saturated` |
| `Scenario` | Single-shot scenario | launch/target lat-lon-alt, target Mach, evasion load, seed, cue errors |
| `SimConfig` | Run configuration | step sizes, module periods, delays, datalink, output directory, verbose |

### 4.4 Phase state machine

```text
boost ──(t ≥ 20 s or speed > 1700 m/s and altitude > 20 km)──▶ midcourse
midcourse ──(all handover gates held for 0.2 s, or forced handover)──▶ terminal
```

Within 0.5 s after handover, midcourse and terminal commands are blended linearly by weight.

---

## 5. Frames and Earth model

- Propagation frame: ECI
- Body frame: X forward, Y right, Z down
- Earth model: WGS84 ellipsoid + J2 by default; `EARTH_MODEL="sphere"` switches to a 6371 km sphere
- Latitude: WGS84 geodetic latitude; longitude adds Earth rotation `ωt` in `llh_to_eci`
- At `t = 0`, ECI and ECEF coincide

Key constants:

| Constant | Value |
|---|---:|
| WGS84 semi-major axis a | 6 378 137.0 m |
| Flattening f | 1/298.257223563 |
| J2 | 1.08262668 × 10⁻³ |
| Earth gravitational parameter μ | 3.986004418 × 10¹⁴ m³/s² |
| Earth rotation rate ω⊕ | 7.2921150 × 10⁻⁵ rad/s |
| Standard gravity g0 | 9.80665 m/s² |
| Sea-level pressure / density | 101 325 Pa / 1.225 kg/m³ |

Aerodynamic forces, Mach number, dynamic pressure and LOS rate all use the air-relative velocity `v_air = v − ω⊕ × r`.

---

## 6. 6DOF rigid-body dynamics

**Translation:**

```text
ṙ = v
v̇ = (R_be F_b) / m + g(r)
```

**Quaternion kinematics:**

```text
q̇ = 0.5 · [−x p − y q − z r,
            w p + y r − z q,
            w q − x r + z p,
            w r + x q − y p]
```

The quaternion is normalised after every step; a zero quaternion falls back to `[1,0,0,0]`. DCM-to-quaternion uses the Shepperd robust algorithm.

**Rotation (Euler equations):**

```text
I ω̇ = M_b − ω × (I ω)
```

**Variable mass and centre-of-gravity travel:**

```text
f = clip((m − m_dry) / (m_0 − m_dry), 0, 1)
I(m)     = I_dry + f (I_full − I_dry)
x_cg(m)  = x_cg,dry + f (x_cg,full − x_cg,dry)
ṁ = −ṁ_prop
```

A hard dry-mass floor guards operation; thrust is zeroed when propellant is exhausted.

---

## 7. Atmosphere and aerodynamics

### 7.1 Atmosphere

`vehicle/atmosphere.py` implements the USSA1976 layers from 0–86 km plus an isothermal exponential tail above 86 km (scale height 6 km). Altitude input is clipped to 0–200 km.

| Base altitude (m) | Base temperature (K) | Lapse rate (K/m) |
|---:|---:|---:|
| 0 | 288.15 | −0.0065 |
| 11 000 | 216.65 | 0.0 |
| 20 000 | 216.65 | +0.0010 |
| 32 000 | 229.27 | +0.0028 |
| 47 000 | 270.65 | 0.0 |
| 51 000 | 270.65 | −0.0028 |
| 71 000 | 214.65 | −0.0020 |
| 84 852 | 186.946 | 0.0 |

### 7.2 Aerodynamic layering

| Mach range | Model | Source |
|---|---|---|
| M ≤ 5 | DATCOM coefficient table + conservative transonic bridge | USAF Digital DATCOM |
| M > 5 | Oblique-shock + Prandtl-Meyer expansion extrapolation | Anchored to DATCOM M=5, η = 0.334 |
| Large AoA | Modified Newtonian sin²α branch | Gradual blending over M=5→7 |
| Friction drag | `Cf = 0.074/Re^0.2` with altitude correction | Prandtl-Schlichting |
| Base drag | CD0 reduced by 0.020 while thrust is on | Exhaust plume raises base pressure |

Built-in DATCOM anchors (excerpt):

| M | CN_α (1/rad) | CM_α (1/rad) | CD0 | Induced-drag k |
|---:|---:|---:|---:|---:|
| 0.20 | 9.91 | −0.920 | 0.244 | 0.071 |
| 0.80 | 10.27 | −1.053 | 0.344 | 0.054 |
| 1.20 | 11.53 | −1.201 | 0.374 | 0.051 |
| 2.00 | 12.89 | −1.250 | 0.312 | 0.045 |
| 3.00 | 13.05 | −1.550 | 0.226 | 0.046 |
| 5.00 | 9.80 | −0.790 | 0.146 | 0.074 |

Hypersonic CN_α: M = 5 / 8 / 10 / 20 → 9.80 / 5.94 / 5.04 / 3.47 (1/rad).

Normal force, drag, pitch moment, damping, fin effectiveness and large-AoA corrections follow `vehicle/missile.py`; the static margin includes variable mass via `h(M, x_cg) = −CM_α L / CN_α + (x_cg,full − x_cg)`.

### 7.3 Geometry and mass

| Parameter | Value |
|---|---:|
| Length / diameter | 8.11 m / 0.63 m |
| Reference area | 0.3117 m² |
| Root / tip chord | 3.8 m / 1.6 m |
| Semi-span per side | 0.364 m |
| Launch / dry mass | 2565 kg / 1000 kg |
| Ixx (full/dry) | 190 / 90 kg·m² |
| Iyy = Izz (full/dry) | 6000 / 2400 kg·m² |
| CG (full/dry) | 4.45 / 4.10 m |
| Aerodynamic centre | 5.24 m |
| Static margin (full fuel) | 0.79 m |

---

## 8. Combined-cycle propulsion

### 8.1 Solid booster

```text
F = F_sl φ(t) + A_e (P_sl − P_a)
F_sl = 130 kN, A_e = 0.196 m²
ṁ = 800 kg / 13 s = 61.54 kg/s
Isp ≈ 215 s
```

Not throttleable; after propellant exhaustion or t ≥ 13 s it switches to ramjet/glide.

### 8.2 Supersonic ramjet

```text
T_avail = C_R q∞ A_inlet η_M(M) η_h(h) cosα · u_thr
C_R = 6.0, A_inlet = 0.22 m²
Ignition window: 1.6 ≤ M ≤ 10, q∞ > 2500 Pa
Thrust cap 60 kN, fuel-flow cap 3 kg/s, Isp = 1500 s
```

Mach efficiency `η_M = max(1 − 0.05(M−3), 0.55)`; altitude efficiency decays linearly from 18 to 32 km and is zero above 32 km.

### 8.3 Thrust control

```text
e = M_ref − M, u_cmd = clip(Kp e, 0, 1)
M_ref = 9.5, Kp = 0.80
Fuel first-order lag τ = 0.25 s, throttle-rate limit 1.5 /s
```

Boost runs at full throttle; terminal also runs at full throttle to preserve energy; zero outside the envelope.

---

## 9. Target model

3DOF point mass with constant-altitude cruise and terminal weaving. Target speed = target Mach × local speed of sound; heading along the great circle toward the launch site (head-on); Earth-rotation carry-over is added.

```text
a_level = −r̂ · |v|² / |r|
a_evade = A sin(2π·0.25 t) e_cross + 0.25A sin(2π·0.5 t + 1)(−r̂)
A = n_evade g0, e_cross = r̂ × v̂
```

Default `n_evade = 9 g`, triggered when the missile is inside 15 km.

Guidance no longer uses target truth; it consumes the 6-state estimate from `sensors/target_tracker.py`:

- Pre-launch cue errors `Scenario.cue_pos_sigma / cue_vel_sigma` (default 0)
- Before lock: midcourse datalink corrects once per second (default 200 m / 4 m/s, 0.2 s latency, 2% loss)
- After lock: converted-measurement Kalman filter using LOS and range

With a 2 km cue bias, the datalink restores metre-level accuracy; disabling it leaves an aim error of kilometres.

---

## 10. Navigation and seeker

### 10.1 GNSS/INS

12-state linear Kalman filter:

```text
x = [r, v, b_a, b_g] ∈ R¹²
```

Constant-acceleration prediction with first-order Gauss-Markov biases; GNSS updates at 1 Hz with `H = [I₆ 0 0]`; covariance is forced symmetric after each update.

| Parameter | Value |
|---|---:|
| GNSS position / velocity 1σ | 8 m / 0.15 m·s⁻¹ |
| Process-noise acceleration | 0.50 m/s² |
| GNSS period / output delay | 1 s / 50 ms |
| IMU accel white noise | 0.012 m/s² @ 5 ms |
| Initial bias / bias stability | 1.5 mg / 150 μg |
| Bias correlation time | 1000 s |

### 10.2 Dual-mode seeker

| Parameter | Value |
|---|---:|
| Update period | 5 ms |
| Half FOV | 20° |
| Blind zone | 200 m |
| Angle noise 1σ | 1 mrad |
| Range / range-rate noise | 5 m / 2 m·s⁻¹ |
| Radar reference lock range | 45 km @ 5 m² |
| Radar actual lock (0.005 m²) | about 8 km |
| IR lock range | 25 km |
| Dropout / false-lock rate | 0.05 / 0.01 s⁻¹ |

```text
lock = (θ_FOV ≤ 20°) ∧ (R > 200 m) ∧ (R ≤ R_lock)
R_lock = max(R_radar, R_IR)
R_radar = 45 km · (σ / 5 m²)^(1/4)
```

Glint noise `σ_glint = 0.30 × 15.7 m / R`; combined with angle noise and filtered by a 20 ms first-order low-pass to produce LOS rate.

Against a 0.005 m² head-on F-35, radar locks at only about 8 km while IR locks at 25 km and sets the effective range. In pure-radar mode the terminal window shrinks to about 2.4 s and miss distance degrades to hundreds of metres.

---

## 11. Guidance and handover

### 11.1 Boost: vertical cold launch + gravity turn

Vertical ascent for the first 2 s with attitude hold. Climb rate is limited by available normal load:

```text
a_feasible = 0.85 (q∞ S CN_α α_max / m + T sinα_max / m)
γ̇_max = min(8°/s, a_feasible / V)
γ_ref ← max(30°, γ_ref − γ̇_max Δt)
a⊥ = V (γ̇_ref + Kγ (γ_ref − γ)) + g0 cosγ
```

The lateral budget is scaled to available load and limited to 4 g; an extra 1.5 g pull-up protection applies below 500 m.

### 11.2 Midcourse: 3D Bezier + loft-dive + prediction

```text
B(s) = (1−s)³ P0 + 3(1−s)²s P1 + 3(1−s)s² P2 + s³ P3
a_bez = k1 (p_ref − r) + k2 (v_ref − v) + p̈_ref
k1 = 2×10⁻⁴, k2 = 0.06, curvature feedforward limited to 1.5 g
a_PN = N_mid Vc (ω_LOS × u), N_mid = 2.0
```

- Long range holds 75 kPa dynamic pressure, about 30 km cruise altitude
- The descent entry is scheduled as needed (at most 520 km, about 300 km for the nominal target), then the altitude profile switches to a loft-dive: a two-segment Hermite plans a 1.5 km pull-up, then pitches over into the dive; the realised bump is about 0.6 km, limited by the ~30 km lift ceiling
- The terminal slope is constrained to the handover descent angle `γ_h = −atan(1000 m / 24 km) ≈ −2.4°` with a 1 km altitude-advantage target; the current single shot arrives at about 1.2 km / −6.6° because of profile-tracking lag
- Angle-constraint feedback: `a_γ = −K_γ w (V/t_go)(γ − γ_ref)`, correcting only the difference between the actual and profile flight-path angles
- Prediction: both vehicles are propagated to the handover point, the lateral component of the terminal ZEM is evaluated there and removed early with gain 0.2; the term fades out inside twice the handover range so it does not fight terminal PN
- Coplanar constraint: `a_n = −K_cop w (6x + 4ẋ t_go) / t_go²`, K_cop = 0.8, lateral limit 3 g
- Replanned every 10 s, path frozen inside 150 km, 2 s crossfade, 5 g command limit

### 11.3 Terminal: ZEM/APN

```text
t_go = max(R / Vc, t_go,min), Vc = max(−Ṙ, 50)
ZEM = ρ + v_rel t_go + ½ a_T t_go²
N_eff = max(3, N [1 + 0.4 clip(1 − t_go/20, 0, 1)])
a_cmd = N_eff ZEM⊥ / t_go² − g⊥v̂
```

The command is smoothed with a 0.75 first-order filter and limited to 40 g; soft FOV protection is added when the off-boresight angle exceeds 0.8 × 20°.

### 11.4 Handover gates

| Gate | Condition | Intent |
|---|---:|---|
| Range | R ≤ 40 km | Reliable tracking |
| FOV | θ ≤ 18° | Maneuver margin |
| Lead angle | ≤ 12° | No large reorientation |
| Time-to-go | t_go ≥ 4 s | Finish blending |
| Available load | ≥ 4 g | Aero authority |
| Altitude difference | 0–12 km | Dive energy |
| Speed | ≥ 1800 m/s | Energy gate |
| Seeker lock | locked | Hard acquisition |

All gates must hold for 0.2 s; forced handover is allowed inside 30 km if the altitude gate cannot be met. Commands are blended for 0.5 s after handover:

```text
a = w a_mid + (1 − w) a_term, w = clip(1 − (t − t_trig)/0.5, 0, 1)
```

---

## 12. Control and actuators

```text
a_cmd(ECI) → virtual α/β → 2nd-order prefilter → rate loop → virtual fin → mixer
```

- Virtual AoA limited to ±25°, with a 20° alpha envelope (the reference is pulled back instead of chasing an unattainable demand)
- Sideslip is treated as a trim channel: reference limited to 8° at 70 kPa and scaled with √(q∞/70 kPa) up to the full envelope; above the 12° envelope it recovers in the opposite direction
- Prefilter damping 0.707, bandwidth scheduled with √q∞, 1–10 Hz
- Outer loop Kpα = 6.0, Kiα = 0.75; Kpβ = 3.6; rate loop Kpq = 0.14, Kpp = 0.035
- Dynamic-pressure gain scheduling: `gain_scale = clip(Kp,req / Kp,baseline, 0.30, 3.0)`, ωq = 22 rad/s
- Roll command: 4/s angle alignment, derated by 15°/α above α = 15° to suppress the α·p sideslip coupling
- Direct load-factor loop: n_z PI with 0.06 s lead
- Anti-windup, position-saturation back-calculation, integration frozen below q∞ < 100 Pa

Cruciform fin mixing:

```text
δ_up = δ_down = δ_Y
δ_left = δ_P − δ_R
δ_right = δ_P + δ_R
```

Processing order: rate limit → first-order lag → position limit. Fin deflection ±25°, fin rate 150°/s, actuator time constant 10 ms; the saturation flag feeds back to the anti-windup loop.

Why the sideslip envelope matters: the side-force channel is about three times weaker than the lift channel (CY_β = 1.6 vs CN_α ≈ 5), so at cruise dynamic pressure a lateral demand of only 0.2 g already needs more than 10° of sideslip. The yaw fins saturate first, the cruciform mixer then loses the differential pitch command that rolls the airframe, and the body is pushed out of envelope by the α·p coupling at high alpha/large sideslip; drag rises, energy is spent and the missile overflies the target. Moving lateral load into the lift plane after rolling takes the 172.6 km overfly in the geometry suite down to 5.3 m.

---

## 13. Numerics and telemetry

- Native RK4, fourth-order fixed step, returning the weighted average derivative for the INS cache
- In-step reconstruction: RK4 is re-run from the left end of the interval, avoiding endpoint Hermite interpolation error at thrust/fin jumps
- Events: miss (range rate turns negative to positive) and ground impact (|r| = Re); direction-aware root finding plus bisection, tolerance 1e-10
- Optional RK45 is a continuous-system reference only
- Telemetry uses a preallocated NumPy buffer, forbids `list.append`, requires strictly increasing time and raises on NaN/Inf
- Optional Numba hot paths with a cache key bound to source hashes

---

## 14. Current single-shot results

Computed from the current `output/telemetry.csv` (run of 2026-11-13):

| Metric | Value |
|---|---:|
| Miss distance (10 ms telemetry sample) | 13.40 m |
| Miss distance (integrator event locator) | 7.94 m |
| Intercept time | 676.46 s |
| Peak speed / Mach | 3094.5 m/s / 9.48 |
| Peak dynamic pressure | 881.3 kPa |
| Peak altitude | 29.93 km |
| Peak load factor | 40.0 g commanded / 10.6 g measured |
| Downrange | 1846.3 km |
| Handover time / downrange | 668.79 s / 1824.9 km |
| Terminal duration | 7.67 s |
| FOV exceedance | 6.4 % |
| Propellant used | 1424.4 kg |
| Telemetry frames | 67 647 |

Phase segmentation: boost 0–20 s, midcourse 20–668.79 s, terminal 668.79–676.46 s.

Single-shot miss distance is highly sensitive to endgame initial conditions; use Monte-Carlo statistics for hit rate. Handover is set by the actual seeker lock range and may occur earlier than the nominal 40 km gate.

---

## 15. Tests and performance validation

### 15.1 Unit tests

Re-running `python -m pytest -n auto` on the current code: **11 test modules, all 80 cases pass**.

| Test module | Cases | Coverage |
|---|---:|---|
| `test_data_consistency.py` | 13 | atmosphere monotonicity, thrust altitude correction, CG travel, quaternion round-trip, telemetry checks |
| `test_control.py` | 16 | prefilter, fin-mixer limits, anti-windup, low-q protection, gain schedule, Mach hold, sideslip/AoA envelopes, roll derating |
| `test_guidance.py` | 15 | handover gates, Bezier endpoints and tangents, coplanar constraint, loft-dive profile, angle constraint, prediction term, terminal correction |
| `test_aero_anchors.py` | 9 | DATCOM anchors, transonic conservatism, static margin, L/D band |
| `test_main_integration.py` | 8 | multi-rate counts, short-run stability, event detection |
| `test_fastcore.py` | 5 | Numba/pure-Python equivalence, reproducible noise streams |
| `test_sensors.py` | 4 | navigation convergence, FOV rejection, lock and blind zone, glint scaling |
| `test_batch.py` | 4 | parallel batches, hit rate and CEP, reproducible dispersion |
| `test_state_schema.py` | 3 | state layout and hash |
| `test_analysis.py` | 2 | sweep and sensitivity entry points |
| `test_verification.py` | 1 | numerical-verification entry point |

### 15.2 Performance validation

`output/validation/validation_report.txt` currently reports **FAIL** (criterion: single-shot miss ≤ 15 m and suite pass rate ≥ 80%):

- Baseline suite: 4/4 pass (100%), mean 10.70 m
- Target-speed suite: 10/10 pass (100%)
- Target altitude: 7/8 (87.5%); with the 520 km early descent and the sideslip envelope the 5 km target no longer overflies
- Target maneuver: 4/8 (50%); engagement geometry: 7/10 (70%), worst 44.3 m, **no 486.7 km fly-past**; combined stress: 7/8 (87.5%)
- Green unit tests do not imply full-envelope hit-rate compliance

### 15.3 Monte-Carlo campaign (100 cases)

```bash
python batch.py --cases 100 --workers 16 --seed 2026 \
  --launch-cep 500 --target-cep 2000 --target-alt-sigma 500 \
  --target-mach-sigma 0.05 --evade-g-sigma 1.0 \
  --lethal-radius 15 --no-plot
```

| Metric | Result |
|---|---:|
| Cases / seed | 100 / 2026 |
| Hit rate (≤15 m) | **79% (79/100)** |
| 95% confidence interval | 70.0–85.8% |
| CEP50 / CEP90 | **9.27 m / 17.96 m** |
| Median miss distance | 9.27 m |
| Mean / std | 10.11 m / 5.81 m |
| Min / max | 1.36 m / 34.90 m |
| Miss ≤20 m / ≤30 m | 91 / 99 cases |
| Outliers | 0 (all cases reach terminal guidance) |
| Wall-clock time | 475 s (16 workers) |

Results are stored in `output/batch/batch_results.csv`. With the loft-dive profile, the predictive term and the sideslip envelope all 100 cases reach terminal guidance, eliminating both the 915 km and 486.7 km fly-pasts; the 79% hit rate sits just below the 80% acceptance threshold, and the full-envelope scenario validation still reports FAIL (see 15.2). The 21 cases beyond 15 m are dominated by terminal target evasion and lift saturation.

---

## 16. Key parameters

| Parameter | Value |
|---|---:|
| Launch site | 40.0°N, 110.0°E, 0 m |
| Target | 28.0°N, 126.0°E, 15 240 m |
| Target Mach / evasion load | 1.6 / 9 g |
| Boost → midcourse | 20 s |
| Simulation end | 1200 s |
| Midcourse replan / freeze distance | 10 s / 150 km |
| Midcourse descent start / look-down | at most 520 km / 1 km at −2.4° |
| Max AoA / fin deflection / fin rate | 25° / 25° / 100°/s |
| Boost / midcourse / terminal command limit | 4 g / 5 g / 40 g |
| Seeker period / FOV / blind zone | 5 ms / ±20° / 200 m |
| Navigation delay / GNSS period | 50 ms / 1 s |
| Outer step (boost·terminal / midcourse) | 5 ms / 10 ms |
| Telemetry period / capacity | 10 ms / 200 000 frames |

---

## 17. Assumptions and scope

### 17.1 Main assumptions

1. WGS84 ellipsoid + J2 gravity, no terrain; a 6371 km spherical model is optional
2. No wind or atmospheric disturbance by default; `vehicle/wind.py` is an optional model
3. Target is a 3DOF point mass with fixed head-on RCS and no attitude/frequency fluctuation
4. Aero coefficients are DATCOM plus theoretical extrapolation, not calibrated on this vehicle
5. Seeker is a simplified dual-mode model without clutter, jamming, multipath, cloud attenuation or a signal-processing chain
6. Actuator is first-order lag with rate/position limits, no backlash, dead band or structural flexibility
7. Inertia and CG vary linearly with fuel; propellant sloshing is ignored
8. Thrust is an engineering model without combustion instability or inlet start-up/surge
9. Aerodynamic heating, structural strength, thermal protection and aeroelasticity are not modelled
10. Datalink networking, cooperative engagement and in-flight command updates are not modelled

### 17.2 Scope

**Suitable for**: guidance/control/navigation design and comparison, trajectory trade studies, energy-management research, Monte-Carlo miss statistics, software architecture and test-method verification.

**Not suitable for**: system qualification, operational hit-probability assessment, or any live-fire employment decision.

---

## 18. References

| Tag | Reference |
|---|---|
| DATCOM | USAF Stability and Control Digital DATCOM, AFFDL-TR-79-3032, 1979 |
| USSA1976 | U.S. Standard Atmosphere, 1976, NASA-TM-X-74335 |
| WGS84 | NIMA TR8350.2, Department of Defense World Geodetic System 1984 |
| NACA Report 1135 | Equations, Tables, and Charts for Compressible Flow, 1953 |
| Prandtl-Schlichting | Schlichting, Boundary-Layer Theory |
| ZEM/APN | Zero-effort-miss / augmented proportional navigation literature |
| JAST-Bezier | Bezier trajectory shaping for midcourse guidance |
| uniflight | Single-owner RHS, packed state and event-integrator architecture reference |

---

*This document mirrors the Chinese [README.md](README.md). Parameters are governed by `config.py`; results are governed by the actual artefacts in `output/` and `intercept-report/`.*
