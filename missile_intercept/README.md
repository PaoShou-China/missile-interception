# 2000-km-class Lifting-Body Interceptor — 6DOF End-to-End Simulation

**User Guide + Technical Report**

A modular, testable and parallel hypersonic-interceptor simulation in pure
Python/NumPy. It covers vertical cold launch, solid boost plus supersonic
ramjet combined-cycle propulsion, GNSS/INS navigation, radar seeker,
three-loop attitude control, Bezier midcourse guidance, ZEM/APN terminal
guidance, handover management, multi-rate sampling and Monte-Carlo campaigns.

> Disclaimer: complete public data for a 2000-km-class interceptor are scarce.
> The geometry, mass, inertia, aerodynamic and propulsion parameters in
> `config.py` are an **engineering extrapolation** from public sources plus
> generic hypersonic-vehicle characteristics. They are intended only for
> algorithm, software and architecture verification, and do not represent
> measured data or performance figures of any fielded system.

> **Language**: English (this file). The legacy English edition is kept at
> [README.en.md](README.en.md); this file is the complete reference.
>
> Coverage: quick start, repository layout, architecture and data flow, frames
> and the Earth model, 6DOF dynamics, atmosphere/aerodynamics/propulsion,
> target, navigation, seeker, guidance and handover, attitude control,
> integration and telemetry, Monte-Carlo, data files, key parameters, tests,
> nominal results, assumptions and limitations, the symbol table and the full
> telemetry dictionary.

---

## Contents

1. [Overview](#1-overview)
2. [Quick start (user guide)](#2-quick-start-user-guide)
3. [Repository layout and module responsibilities](#3-repository-layout-and-module-responsibilities)
4. [Architecture and data flow](#4-architecture-and-data-flow)
5. [Frames, time and Earth model](#5-frames-time-and-earth-model)
6. [6DOF rigid-body dynamics](#6-6dof-rigid-body-dynamics)
7. [Atmosphere model and USSA1976 database](#7-atmosphere-model-and-ussa1976-database)
8. [Aerodynamic database and aerodynamic model](#8-aerodynamic-database-and-aerodynamic-model)
9. [Combined-cycle propulsion model](#9-combined-cycle-propulsion-model)
10. [Target model](#10-target-model)
11. [GNSS/INS navigation](#11-gnssins-navigation)
12. [Radar seeker](#12-radar-seeker)
13. [Guidance laws and handover management](#13-guidance-laws-and-handover-management)
14. [Control system and actuators](#14-control-system-and-actuators)
15. [Numerical integration, events and telemetry](#15-numerical-integration-events-and-telemetry)
16. [Monte-Carlo campaign](#16-monte-carlo-campaign)
17. [Data files and database inventory](#17-data-files-and-database-inventory)
18. [Key parameters summary](#18-key-parameters-summary)
19. [Test matrix](#19-test-matrix)
20. [Nominal results and verification](#20-nominal-results-and-verification)
21. [Assumptions, limitations and scope](#21-assumptions-limitations-and-scope)
22. [References](#22-references)
23. [Appendix A: symbol table](#appendix-a-symbol-table)
24. [Appendix B: telemetry column definitions](#appendix-b-telemetry-column-definitions)

### Documentation map

| Document | Contents |
|---|---|
| `README.md` (this file) | Detailed English user guide and technical report |
| [`README.en.md`](README.en.md) | Legacy English edition |
| [`output/intercept_dashboard.html`](output/intercept_dashboard.html) | Bilingual interactive dashboard |
| [`../intercept-report/intercept-report.html`](../intercept-report/intercept-report.html) | Bilingual static intercept report |
| Appendix B | Full 132-column telemetry dictionary |
| `config.py` | Single source of truth for parameters and columns |
| `validate_performance.py` | Per-suite validation and pass rate |
| `batch.py` | Parallel Monte-Carlo campaign |

---

## 1. Overview

| Item | Contents |
|---|---|
| Mission | Inland launch site → sea target at about 1990 km range and 15.2 km altitude, head-on intercept |
| Trajectory phases | Vertical cold launch → gravity-turn boost → constant-dynamic-pressure midcourse cruise → ZEM/APN terminal guidance |
| Propulsion | Solid booster (13 s, 800 kg propellant) + supersonic ramjet (Mach 1.6–10) |
| Dynamics | 14-state 6DOF rigid body (3 translation + 4 rotation quaternion + 3 angular rate + 1 mass) |
| Target | F-35A-class threat (3DOF point mass), Mach 1.6 constant-altitude cruise, 9 g weaving evasion inside 15 km |
| Navigation | INS prediction + 1 Hz GNSS with a 12-state linear Kalman filter, 50 ms output delay |
| Seeker | Dual-mode (radar + imaging infrared) 5 ms measurement (boost/terminal; midcourse follows the 10 ms outer step), ±20° FOV, 200 m blind zone, angle noise + glint; radar lock range scales with the fourth root of target RCS |
| Control | Three-loop PID (pseudo angle of attack → angular rate → virtual fin) + anti-windup + dynamic-pressure gain scheduling |
| Numerics | In-house fixed-step RK4 + uniflight-style direction-aware event guard + RK4 bisection localisation |
| Parallelism | `ProcessPoolExecutor` multiprocess Monte-Carlo campaign, reproducible results |

Nominal single-shot results (`intercept-report/assets/metrics.json`):

| Metric | Value |
|---|---|
| Miss distance | **11.38 m** |
| Intercept time | 675.92 s |
| Maximum speed / Mach | 3102.3 m/s / **Mach 9.53** |
| Maximum dynamic pressure | 780.1 kPa |
| Maximum altitude | 29.99 km |
| Maximum load factor | 30.0 g (terminal command limit) |
| Range | 1844.1 km |
| Handover time / range | 668.29 s / 1821.5 km |
| Propellant consumption | 1499 kg (solid 800 kg + ramjet 699 kg) |

---

## 2. Quick start (user guide)

### 2.1 Requirements

- Python 3.9+ (code keeps 3.6+ syntax compatibility, verified on 3.14)
- NumPy 1.x / 2.x
- Optional: SciPy (only for the Saltelli/Sobol sampling in `analysis.py`)
- Optional: matplotlib (only for the batch-campaign histograms)
- Optional: Numba (hot-path acceleration; falls back to pure Python automatically with identical behaviour)
- Tests: pytest, pytest-xdist

```bash
python -m pip install numpy scipy pytest pytest-xdist
# optional
python -m pip install numba matplotlib
```

### 2.2 Single end-to-end run

```bash
cd missile_intercept

python main.py                          # boost/terminal 5 ms, midcourse 10 ms
python main.py --max-step 0.002         # finer boost/terminal step
python main.py --midcourse-step 0.005   # midcourse back to 5 ms
python main.py --duration 900           # set the simulation end time
python main.py --no-plot                # simulation + CSV only
python main.py --converge               # step convergence + Richardson extrapolated miss distance
python main.py --converge --converge-levels 5 --converge-factor 2
```

`--converge` turns off sensor noise and runs the closed loop with h, h/2, …
(4 levels by default), measures the observed order of convergence from the two
finest levels, then performs Richardson extrapolation and reports the miss
distance per level, the observed order, the extrapolated value and the error
estimate. Note that a single-shot miss distance is extremely sensitive to the
endgame initial conditions; use the batch Monte-Carlo campaign to assess hit
rate. (`--converge-factor` changes the refinement ratio.)

At start-up `config.validate_data()` is executed first; it checks the reference
area, specific impulse, inertia, static stability margin, centre-of-gravity
travel and other consistency conditions, and raises an exception on failure.

Example terminal output fields: simulation success/failure, integrator type,
step size, RHS call count, CPU time, miss distance, telemetry frames.

### 2.3 Monte-Carlo campaign

```bash
python main.py --batch 20 --workers 8
# or
python batch.py --cases 50 --workers 8 --seed 2026
python batch.py --cases 20 --workers 4 --duration 600 --no-plot
```

Optional dispersion parameters (1σ or 2D CEP):

```bash
python batch.py --cases 50 \
  --launch-cep 500 --target-cep 2000 \
  --target-alt-sigma 500 --target-mach-sigma 0.05 \
  --evade-g-sigma 1.0 --lethal-radius 10
```

### 2.4 Tests

```bash
python -m pytest -n auto
# when Windows thread limits apply
python -m pytest -n 4
```

### 2.5 Tool chain

| Command | Purpose |
|---|---|
| `python tools/datcom_aero.py` | Invoke `tools/datcom/datcom.exe` to generate the Mach ≤ 5 aero tables → `output/datcom_aero.csv` |
| `python tools/aero_crosscheck.py` | Cross-check the aero model against classical theory, exact shock/expansion relations and DATCOM output |
| `python tools/aero_optimize.py` | DATCOM-based wing planform screening (DoE) |
| `python tools/aero_uq.py [N]` | Fast uncertainty quantification of aero-coefficient / centre-of-gravity perturbations |
| `python tools/build_report_data.py` | Build the `../intercept-report/` report data from `output/telemetry.csv` |
| `python tools/handover_diagnostics.py --suite baseline` | 逐案交班诊断：首次锁定距离、交班距离、FOV 裕度、t_go、前置角、可用/需求过载、末段指令/实际过载与失锁率 |
| `python verification.py` | Built-in numerical verification: RK4 order, Kepler conservation, long-run quaternion norm, fixed-step vs RK45 cross-comparison |
| `python analysis.py sweep spec.json` | Cartesian parameter sweep (`config.*` / `scenario.*` paths) |
| `python analysis.py sobol spec.json --cases 64` | Saltelli/Sobol first-order and total sensitivity indices |
| `python analysis.py mc --checkpoint out.jsonl --resume` | Monte-Carlo campaign with resume support |
| `python main.py` (default) | Additionally generates the single-file interactive dashboard `output/intercept_dashboard.html` |

### 2.6 Output files

| Path | Contents |
|---|---|
| `output/telemetry.csv` | 单发全量遥测 132 列（`telemetry_profile="full"`，10 ms 一帧）；批量/验证用 48 列 basic profile |
| `output/intercept_dashboard.html` | Self-contained six-panel dashboard (Canvas, no third-party front-end dependencies) |
| `output/batch/batch_results.csv` | Per-case miss distance, intercept time, final phase, CPU time, etc. |
| `output/batch/batch_miss_hist.png` | Miss-distance distribution (requires matplotlib) |
| `output/datcom_aero.csv` | Raw DATCOM aero tables |
| `output/handover_diagnostics/handover_diagnostics.csv` | 逐案交班诊断明细 / per-case handover diagnostics |
| `output/handover_diagnostics/handover_summary.json` | 交班失败分类与下一步建议 / failure classification and recommendation |
| `../intercept-report/intercept-report.html` | Apple-style single-page HTML technical report (ECharts) |

### 2.7 Mode and switch reference

Every optional behaviour is a configuration item, not a hidden branch. Runtime
switches live in `config.py` (`SimConfig` / `Scenario`); campaign modes are CLI
flags. Defaults reproduce the nominal run.

**Realism and sensor models**

| Switch | Default | Alternative |
|---|---|---|
| `EARTH_MODEL` | `"wgs84"` (ellipsoid + J2) | `"sphere"` (6371 km sphere, central gravity) |
| `SimConfig.enable_wind` | `True` | `False` = still air |
| `SimConfig.ideal_attitude` | `False` (IMU + star tracker) | `True` = autopilot/seeker use truth attitude and rate |
| `SimConfig.enable_attitude_aid` | `True` | `False` = no star fix / GNSS heading correction |
| `SimConfig.seeker_swerling` | `True` | `False` = constant RCS and lock range |
| `SimConfig.seeker_dropout_rate` | `0.05` 1/s | `0` disables loss-of-lock events |
| `SimConfig.seeker_false_lock_rate` | `0.01` 1/s | `0` disables false detections |
| `SimConfig.sensor_noise_scale` | `1.0` | `0` = noise-free navigation/seeker (`--converge`) |
| `SimConfig.datalink_period` | `1.0` s | `<= 0` disables the midcourse datalink |
| `SimConfig.datalink_latency` / `datalink_loss_prob` | `0.2` s / `0.02` | `0` = ideal zero-delay, lossless link |
| `Scenario.cue_pos_sigma` / `cue_vel_sigma` | `0` | non-zero = imperfect pre-launch cue |
| `Scenario.target_evade_g` | `9` g | `0` = cooperative straight-flying target |
| `Scenario.target_evade_phase` | `0` rad | weave phase offset |

**Guidance, control and hard-wired modes**

| Switch | Default | Alternative |
|---|---|---|
| `AP_NZ_LOOP` | `1` | `0` = pure alpha loop without direct load-factor feedback |
| `AP_NZ_SCHED` | `0` | `1` = schedule the `n_z` gains with q and mass |
| `AP_NZ_LEAD` | `0` s | non-zero = lead compensation on the measured load factor |
| `AP_ACT_INV` | `0` | `0..1` = inverse actuator-lag pre-warp |
| `HANDOVER_*` | tuned gates | thresholds for range/FOV/lead/t_go/load/altitude/speed |
| `MIDCOURSE_*` | q-hold + adaptive descent | cruise q, descent gradient, coplanar constraint gains |

Always-on (no switch): radar + IIR dual-mode seeker, forced-handover fallback,
boost/midcourse/terminal phase machine, and the 12-state INS.

**Numerical and run modes**

| Mode | Where | Effect |
|---|---|---|
| Fixed-step RK4 | `integrate(..., method="rk4")` (default) | production integrator |
| Adaptive RK45 | `integrate(..., method="rk45")` | continuous-system reference integrator (verification) |
| Numba / pure Python | automatic via `fastcore.NUMBA_AVAILABLE` | compiled hot paths or identical fallback |
| Telemetry profile | `SimConfig.telemetry_profile` | `"full"` 132 columns or `"basic"` 48 columns |
| Plot / no plot | `SimConfig.enable_plot`, `--no-plot` | write the HTML dashboard or not |
| Verbose | `SimConfig.verbose` | console summary on/off |

**Campaign and analysis modes (CLI)**

| Entry point | Modes / options |
|---|---|
| `main.py` | `--max-step`, `--midcourse-step`, `--duration`, `--no-plot`, `--converge` (+`--converge-factor/--converge-levels`), `--batch N --workers W --seed S` |
| `batch.py` | dispersion (`--launch-cep`, `--target-cep`, `--target-alt-sigma`, `--target-mach-sigma`, `--evade-g-sigma`, `--lethal-radius`), `--checkpoint/--resume`, `--workers`, `--no-plot` |
| `analysis.py` | `sweep` (Cartesian), `sobol` (sensitivity), `optimize` (cross-entropy), `mc` (checkpoint/resume) |
| `verification.py` | RK4 order, Kepler invariants, quaternion norm, RK4/RK45 cross-check, adaptive accuracy |
| `validate_performance.py` | per-suite pass-rate validation |
| `tools/` | DATCOM generation, aero cross-check/optimisation/UQ, autopilot/handover tuning, handover diagnostics, miss budget, report data |

> Legacy modes removed: LADRC rate loop, the q-table gain-schedule fallback,
> the 6-state navigation filter and the NDI feed-forward.

---

## 3. Repository layout and module responsibilities

```text
missile_intercept/
├── config.py                    # constants, data contracts, SimConfig, data-consistency checks
├── math_utils.py                # 3D vectors / quaternions / ECI-LLH-ENU (pure functions)
├── integrator.py                # native RK4/RK45 + direction-aware events + bisection localisation
├── state_schema.py              # packed-state schema (fields/units/frames/layout hash)
├── verification.py              # built-in formal numerical verification suite
├── fastcore.py                  # optional numba hot paths; automatic fallback when unavailable
├── telemetry.py                 # preallocated telemetry buffer (list.append forbidden)
├── visualization.py             # self-contained interactive HTML dashboard
├── main.py                      # sampling schedule, event detection, telemetry, plotting
├── batch.py                     # multiprocess Monte-Carlo (JSONL resume)
├── analysis.py                  # unified entry point for sweeps / Sobol sensitivity / Monte-Carlo
├── vehicle/
│   ├── missile.py               # aero / propulsion / variable-mass 6DOF
│   ├── target.py                # 3DOF target (local-horizontal manoeuvres)
│   └── atmosphere.py            # USSA1976
├── sensors/
│   ├── navigation.py            # INS prediction + 1 Hz GNSS KF, 50 ms delay
│   ├── seeker.py                # 5 ms seeker, FOV / blind zone / glint
│   └── target_tracker.py        # target-state estimation (converted-measurement KF); guidance no longer uses truth
├── control/
│   ├── autopilot.py             # three-loop PID + low-pass + anti-windup + gain scheduling
│   ├── fin_mixer.py             # cruciform fin mixing + rate/position limiting
│   └── thrust_controller.py     # ramjet Mach-hold P control
├── guidance/
│   ├── base_guidance.py         # base class and geometry helpers
│   ├── boost_guidance.py        # vertical cold launch + gravity turn
│   ├── midcourse_guidance.py    # 3D Bezier + PN + energy management + coplanarity constraint
│   ├── terminal_guidance.py     # ZEM/APN + adaptive N + gravity compensation
│   └── handover_manager.py      # hard gates + 0.5 s weight blending
├── tools/
│   ├── datcom/                  # raw USAF Digital DATCOM executable
│   ├── datcom_aero.py           # DATCOM input-card builder and output parser
│   ├── aero_crosscheck.py       # aerodynamic cross-validation
│   ├── aero_optimize.py         # wing planform screening
│   ├── aero_uq.py               # aerodynamic uncertainty quantification
│   └── build_report_data.py     # HTML report data generation
└── tests/                       # pytest (supports -n auto)
```

The dependency direction is strictly one-way:
`config / math_utils → vehicle / sensors / control / guidance → main`.
There is no global mutable state; modules interact through dataclass contracts.

---

## 4. Architecture and data flow

### 4.1 State vector

The integrator maintains a 20-dimensional packed state:

$$
\mathbf{y} =
\underbrace{[\mathbf{r}_{m}(3),\ \mathbf{v}_{m}(3),\ \mathbf{q}_{m}(4),\ \boldsymbol{\omega}_{m}(3),\ m_{m}(1)]}_{\text{missile }14}
\ \Vert\
\underbrace{[\mathbf{r}_{t}(3),\ \mathbf{v}_{t}(3)]}_{\text{target }6}
$$

- `r_m`: ECI position (m)
- `v_m`: ECI velocity (m/s)
- `q_m`: body → ECI quaternion, scalar first `[w, x, y, z]`
- `ω_m`: body-frame angular rate `[p, q, r]` (rad/s)
- `m_m`: current mass (kg)

### 4.2 Multi-rate sampling (ZOH)

Discrete modules are sampled once at the start of each outer step; RK4
integrates only the continuous dynamics internally. Hence there are no
sampling side effects from "rejected steps", and the integration is
deterministic and reproducible.

| Module | Nominal period | Configuration item |
|---|---|---|
| Seeker | 5 ms | `DT_SEEKER = 0.005` |
| Attitude control + fin mixing | 5 ms | `DT_AUTOPILOT = 0.005` |
| Guidance + handover + thrust control | 5 ms | `DT_GUIDANCE = 0.005` |
| GNSS measurement update | 1 s | `DT_GNSS = 1.000` |
| Telemetry | 10 ms | `DT_LOG = 0.010` |
| Navigation output delay | 50 ms | `NAV_DELAY = 0.050` |
| Outer integration step (boost/terminal) | 5 ms | `DEFAULT_MAX_STEP = 0.005` |
| Outer integration step (midcourse) | 10 ms | `DEFAULT_MIDCOURSE_MAX_STEP = 0.010` |

> Discrete modules can only be sampled on outer-step boundaries, so during the
> midcourse phase (10 ms step) the effective sampling rate is 100 Hz; boost and
> terminal remain at 5 ms / 200 Hz.

### 4.3 Data contract (`config.py`)

| Dataclass | Purpose | Key fields |
|---|---|---|
| `MissileState` | Missile state | `r_eci, v_eci, q, omega_body, mass, inertia, cg_pos` |
| `NavEstimate` | Navigation output | `r_eci, v_eci, timestamp` |
| `SeekerMeasurement` | Seeker measurement | `los_angle, los_rate, range, range_rate, is_locked, fov_angle` |
| `GuidanceCommand` | Guidance command | `a_cmd_eci` (desired acceleration excluding gravity), `phase` |
| `ActuatorCommand` | Fin command | `delta_fins(4)` = [up, down, left, right], `is_saturated` |
| `Scenario` | Single-shot scenario | Launch/target lat-lon-alt, target Mach, evasion load factor, random seed, preset cue errors (`cue_pos_sigma / cue_vel_sigma`, default 0) |
| `SimConfig` | Run configuration | Step sizes, module periods, delays, midcourse datalink period/noise (`datalink_period / datalink_pos_sigma / datalink_vel_sigma`), output directory, verbose mode |

### 4.4 Phase state machine

```text
boost ──(t ≥ 20 s or speed > 1700 m/s and altitude > 20 km)──▶ midcourse
midcourse ──(all handover gates satisfied and held for 0.2 s, or forced handover)──▶ terminal
```

Within 0.5 s after handover, the midcourse and terminal commands are blended
linearly by weight.

### 4.5 Frames

- Propagation frame: ECI (Earth-centred inertial)
- Body frame: X forward, Y right, Z down
- Earth model: WGS84 ellipsoid + J2 by default; `EARTH_MODEL="sphere"` switches
  to a sphere of radius `Re = 6371 km`
- Latitude: WGS84 geodetic latitude; longitude adds Earth rotation `ωt` in
  `llh_to_eci`
- At `t = 0` ECI and ECEF coincide

---

## 5. Frames, time and Earth model

### 5.1 Physical constants (WGS84 / USSA1976)

| Symbol | Value | Meaning |
|---|---|---|
| $a$ | 6 378 137.0 m | WGS84 semi-major axis |
| $f$ | 1/298.257223563 | WGS84 flattening |
| $b$ | $a(1-f)$ | WGS84 semi-minor axis |
| $e^2$ | $f(2-f)$ | First eccentricity squared |
| $J_2$ | 1.08262668 × 10⁻³ | Second zonal harmonic |
| $R_e$ | 6 371 000 m | Spherical-mode radius (`EARTH_MODEL="sphere"`) |
| $\mu$ | 3.986004418 × 10¹⁴ m³/s² | Earth gravitational constant |
| $\omega_\oplus$ | 7.2921150 × 10⁻⁵ rad/s | Earth rotation rate |
| $g_0$ | 9.80665 m/s² | Standard gravity |
| $P_{sl}$ | 101 325 Pa | Sea-level pressure |
| $\rho_{sl}$ | 1.225 kg/m³ | Sea-level density |
| $R_{air}$ | 287.05287 J/(kg·K) | Dry-air gas constant |
| $\gamma$ | 1.4 | Air specific-heat ratio |

### 5.2 Geodetic coordinates ↔ ECI

The WGS84 ellipsoid is used by default. Let $\lambda'=\lambda+\omega_\oplus t$,
$N=a/\sqrt{1-e^2\sin^2\varphi}$:

$$
\mathbf{r} =
\begin{bmatrix}
(N+h)\cos\varphi\cos\lambda'\\
(N+h)\cos\varphi\sin\lambda'\\
\big(N(1-e^2)+h\big)\sin\varphi
\end{bmatrix}
$$

The inverse transform solves for $\varphi$ iteratively in `eci_to_llh` and then
back-substitutes to obtain $h$; longitude is normalised to $(-\pi,\pi]$. With
`EARTH_MODEL="sphere"` this degenerates to
$\mathbf{r}=(R_e+h)[\cos\varphi\cos\lambda',\cos\varphi\sin\lambda',\sin\varphi]^\top$.

### 5.3 Local ENU → ECI rotation

$$
\mathbf{R}_{ENU\to ECI} =
\begin{bmatrix}
-\sin\lambda & -\sin\varphi\cos\lambda & \cos\varphi\cos\lambda\\
 \cos\lambda & -\sin\varphi\sin\lambda & \cos\varphi\sin\lambda\\
 0           &  \cos\varphi              & \sin\varphi
\end{bmatrix}
$$

### 5.4 Gravity field (central gravity + J2)

In the default WGS84 mode the J2 oblateness term is added to central gravity:

$$
\begin{aligned}
g_x &= -\frac{\mu x}{r^3}\left[1-\frac{3}{2}J_2\left(\frac{R_e}{r}\right)^2
\left(5\frac{z^2}{r^2}-1\right)\right],\\
g_y &= -\frac{\mu y}{r^3}\left[1-\frac{3}{2}J_2\left(\frac{R_e}{r}\right)^2
\left(5\frac{z^2}{r^2}-1\right)\right],\\
g_z &= -\frac{\mu z}{r^3}\left[1-\frac{3}{2}J_2\left(\frac{R_e}{r}\right)^2
\left(5\frac{z^2}{r^2}-3\right)\right].
\end{aligned}
$$

The implementation is in `math_utils.gravity_eci`. With
`EARTH_MODEL="sphere"` only $-\mu\mathbf{r}/r^3$ remains.

### 5.5 Air-relative velocity (Earth-rotation carry-over)

$$
\mathbf{v}_{air} = \mathbf{v} - \boldsymbol{\omega}_\oplus\times\mathbf{r}
= [v_x + \omega r_y,\ v_y - \omega r_x,\ v_z]^\top
$$

Aerodynamic forces, Mach number, dynamic pressure and line-of-sight angular
rate all use $\mathbf{v}_{air}$.

### 5.6 Line-of-sight (LOS) geometry

$$
\boldsymbol{\rho} = \mathbf{r}_t - \mathbf{r}_m,\quad
R = \|\boldsymbol{\rho}\|,\quad
\mathbf{u} = \boldsymbol{\rho}/R
$$

$$
\dot R = \mathbf{u}\cdot(\mathbf{v}_t - \mathbf{v}_m)
$$

$$
\boldsymbol{\omega}_{LOS}
= \frac{\boldsymbol{\rho}\times\mathbf{v}_{rel}}{R^2}
$$

### 5.7 Predicted intercept point (PIP)

Using the current missile speed as the average speed, the time of flight to
intercept is iterated:

$$
t_{go}^{(k+1)} = \frac{\|\mathbf{r}_t + \mathbf{v}_t t_{go}^{(k)} - \mathbf{r}_m\|}{\|\mathbf{v}_m\|}
$$

At most 8 iterations, convergence threshold 0.5 s, with a 0.5 relaxation factor
to avoid oscillation.

---

## 6. 6DOF rigid-body dynamics

### 6.1 Translation

$$
\dot{\mathbf{r}} = \mathbf{v},\qquad
\dot{\mathbf{v}} = \frac{1}{m}\left(\mathbf{R}_{be}\mathbf{F}_b\right) + \mathbf{g}(\mathbf{r})
$$

where $\mathbf{F}_b$ is the body-axis aerodynamic force + thrust (excluding
gravity).

### 6.2 Quaternion kinematics

$$
\dot{\mathbf{q}} = \frac{1}{2}
\begin{bmatrix}
-x p - y q - z r\\
 w p + y r - z q\\
 w q - x r + z p\\
 w r + x q - y p
\end{bmatrix},
\qquad
\mathbf{q} = [w, x, y, z]^\top
$$

The quaternion is normalised after every step; a zero quaternion falls back to
`[1,0,0,0]`.

Quaternion → body-to-ECI direction cosine matrix:

$$
\mathbf{R}_{be} =
\begin{bmatrix}
1-2(y^2+z^2) & 2(xy-wz) & 2(xz+wy)\\
2(xy+wz) & 1-2(x^2+z^2) & 2(yz-wx)\\
2(xz-wy) & 2(yz+wx) & 1-2(x^2+y^2)
\end{bmatrix}
$$

DCM → quaternion uses the **Shepperd robust algorithm** (branching on the trace
or the largest diagonal element to avoid division by zero).

### 6.3 Rotation (Euler equations)

$$
\mathbf{I}\,\dot{\boldsymbol{\omega}}
= \mathbf{M}_b - \boldsymbol{\omega}\times(\mathbf{I}\boldsymbol{\omega})
$$

$$
\dot{\boldsymbol{\omega}} = \mathbf{I}^{-1}\left(\mathbf{M}_b - \boldsymbol{\omega}\times(\mathbf{I}\boldsymbol{\omega})\right)
$$

### 6.4 Variable mass and centre-of-gravity travel

Fuel fraction:

$$
f = \operatorname{clip}\!\left(\frac{m - m_{dry}}{m_0 - m_{dry}}, 0, 1\right)
$$

Inertia and centre of gravity vary linearly with fuel:

$$
\mathbf{I}(m) = \mathbf{I}_{dry} + f\,(\mathbf{I}_{full} - \mathbf{I}_{dry})
$$

$$
x_{cg}(m) = x_{cg,dry} + f\,(x_{cg,full} - x_{cg,dry})
$$

Mass equation:

$$
\dot m = -\dot m_{prop}
$$

A hard dry-mass floor guards `m ≥ DRY_MASS`; thrust is set to zero when the
propellant is exhausted.

### 6.5 Stagnation pressure coefficient (Newtonian / Rayleigh pitot)

$$
C_{p,\max}(M) = \frac{2}{\gamma M^2}\left(\frac{p_{02}}{p_1} - 1\right)
$$

$$
\frac{p_{02}}{p_1} =
\left[\frac{(\gamma+1)^2 M^2}{4\gamma M^2 - 2(\gamma-1)}\right]^{\frac{\gamma}{\gamma-1}}
\cdot \frac{1-\gamma+2\gamma M^2}{\gamma+1}
$$

$\gamma$ decreases linearly from 1.40 to 1.36 across the hypersonic band
(`GAMMA_HYP_DROP = 0.04`, completed at $M=10$). As $M\to\infty$,
$C_{p,\max}\to 1.84$.

---

## 7. Atmosphere model and USSA1976 database

`vehicle/atmosphere.py` implements the 0–86 km layers plus an isothermal
exponential tail above 86 km.

### 7.1 Layer database

| Base altitude $h_b$ (m) | Base temperature $T_b$ (K) | Temperature gradient $L$ (K/m) |
|---|---|---|
| 0 | 288.15 | −0.0065 |
| 11 000 | 216.65 | 0.0 |
| 20 000 | 216.65 | +0.0010 |
| 32 000 | 228.65 | +0.0028 |
| 47 000 | 270.65 | 0.0 |
| 51 000 | 270.65 | −0.0028 |
| 71 000 | 214.65 | −0.0020 |
| 84 852 | 186.946 | 0.0 |

### 7.2 Layer formulas

Temperature:

$$
T(h) = T_b + L\,(h - h_b)
$$

Pressure ($L\neq0$):

$$
p(h) = p_b\left(\frac{T(h)}{T_b}\right)^{-\frac{g_0}{R_{air}L}}
$$

Isothermal layer ($L=0$):

$$
p(h) = p_b\exp\!\left(-\frac{g_0 (h-h_b)}{R_{air}T_b}\right)
$$

Density and speed of sound:

$$
\rho = \frac{p}{R_{air}T},\qquad
a = \sqrt{\gamma R_{air} T}
$$

### 7.3 Exponential tail above 86 km

The tail is anchored to the exact 86 km values, removing the seam at the top of
the table:

$$
p(h) = p_{86}\exp\!\left(-\frac{h-86000}{H}\right),\quad H = 6000\ \text{m}
$$

$$
\rho(h) = \rho_{86}\exp\!\left(-\frac{h-86000}{H}\right)
$$

The temperature is held at 186.946 K. Input altitude is clipped to 0–200 km;
any non-finite or non-positive value raises an exception immediately.

---

## 8. Aerodynamic database and aerodynamic model

### 8.1 Data sources and layering strategy

| Mach range | Model | Source |
|---|---|---|
| $M \le 5$ | DATCOM coefficient table + conservative transonic bridge | Raw USAF Digital DATCOM (Jan 96), `tools/datcom_aero.py` |
| $0.5 \lesssim M \lesssim 1.6$ | Monotonic transonic bridge, CN reduced by 8%, CD0 increased by 10% | Digital DATCOM returns NDM for this planform; P-G trend plus conservative margin adopted |
| $M > 5$ | Shock-expansion trend (normal section of swept wing) | Anchored to the DATCOM $M=5$ value, $\eta=0.334$ |
| Large angle of attack | Modified Newtonian $\sin^2\alpha$ branch | Larger of the two branches, gradual blending over $M=5\to7$ |
| Friction drag | $C_f = 0.074/Re^{0.2}$ with altitude correction | Prandtl-Schlichting turbulent flat plate |
| Base drag | CD0 reduced by 0.020 while thrust is on | Exhaust plume raises base pressure |
| Aerodynamic-centre shift | DATCOM table + centre-of-gravity travel | CR-2835 trend |

### 8.2 Built-in DATCOM coefficient table ($M \le 5$, reference area `S_REF`)

| M | CN_α (1/rad) | CM_α (1/rad) | CD0 | Induced-drag k |
|---:|---:|---:|---:|---:|
| 0.00 | 9.45 | −0.840 | 0.235 | 0.073 |
| 0.20 | 9.91 | −0.920 | 0.244 | 0.071 |
| 0.50 | 9.63 | −0.955 | 0.270 | 0.061 |
| 0.80 | 10.27 | −1.053 | 0.344 | 0.054 |
| 0.95 | 10.78 | −1.127 | 0.374 | 0.054 |
| 1.05 | 11.16 | −1.176 | 0.385 | 0.054 |
| 1.20 | 11.53 | −1.201 | 0.374 | 0.051 |
| 1.50 | 12.30 | −1.225 | 0.349 | 0.048 |
| 2.00 | 12.89 | −1.250 | 0.312 | 0.045 |
| 2.50 | 12.97 | −1.400 | 0.269 | 0.046 |
| 3.00 | 13.05 | −1.550 | 0.226 | 0.046 |
| 3.50 | 12.28 | −1.450 | 0.202 | 0.050 |
| 4.00 | 11.50 | −1.350 | 0.178 | 0.054 |
| 4.50 | 10.65 | −1.070 | 0.162 | 0.064 |
| 5.00 | 9.80 | −0.790 | 0.146 | 0.074 |

### 8.3 Hypersonic lift-slope table ($M > 5$)

| M | 5 | 6 | 7 | 8 | 10 | 12 | 15 | 20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CN_α (1/rad) | 9.800 | 7.767 | 6.660 | 5.940 | 5.040 | 4.490 | 3.970 | 3.474 |

Generation method: an oblique shock (windward side) + Prandtl-Meyer expansion
(leeward side) on the normal section of the 74.9° swept fin, then projected
back onto the freestream direction; the magnitude is anchored to DATCOM $M=5$
with the calibration factor $\eta = 0.334$.

### 8.4 Large-angle-of-attack shape factors

$$
C_N(M,\alpha) = C_{N\alpha}(M)\,\alpha\,S_{CN}(|\alpha|)
$$

| α (deg) | 0 | 2 | 4 | 6 | 8 | 12 | 16 | 20 | 24 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| $S_{CN}$ | 1.000 | 0.890 | 1.000 | 1.117 | 1.245 | 1.490 | 1.720 | 1.930 | 2.120 |
| $S_k$ | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 0.840 | 0.770 | 0.700 | 0.650 |

### 8.5 Aerodynamic forces and moments

**Normal force / side force:**

$$
C_N = C_{N\alpha}\alpha S_{CN}(\alpha) + 0.25\,\delta_{P,eff}
$$

$$
C_Y = C_{Y\beta}\,\kappa(M)\,\beta + 0.25\,\delta_{Y,eff}
$$

where $\kappa(M) = (C_{N\alpha}(M) - 2.0)/(10.17 - 2.0)$ is the fin-slope ratio.

**Hypersonic Newtonian blending** ($M=5\to7$ gradual):

$$
C_{N,newton} = 2.0\,C_{p,\max}(M)\sin^2\alpha\cos\alpha
$$

If $|C_{N,newton}| > |C_{N,body}|$, the linear branch is replaced using the
blending factor.

**Drag (velocity-frame polar rotated back to body axes):**

$$
C_D = C_{D0} + \Delta C_{D,fric} + k(M)S_k(\alpha)(C_N^2 + C_Y^2)
$$

$$
C_A = \frac{C_D - C_N\sin\alpha}{\max(\cos\alpha,\,0.2)}
$$

Then add the fin incremental drag:

$$
\Delta C_A = C_{D,fin}\left(|\delta| + 0.5\,\delta^2/\delta_{\max}\right)
$$

**Friction-drag altitude correction:**

$$
\Delta C_{D,fric} = \left(C_f(Re) - C_f(Re_{ref})\right)\frac{S_{wet}}{S_{ref}}
$$

$$
C_f = \frac{0.074}{Re^{0.2}},\qquad
Re = \frac{\rho V L}{\mu(T)}
$$

Sutherland viscosity:

$$
\mu(T) = \frac{1.458\times10^{-6}\,T^{1.5}}{T + 110.4}
$$

**Static moment (moment-arm method, static stability counted once):**

$$
C_M = -\frac{h(M, x_{cg})}{L}\,C_{N,body}\,G_{cm}(M,\alpha)
+ C_{M\delta_e}(M)\,\delta_{P,eff}
$$

Static stability margin:

$$
h(M, x_{cg}) = -\frac{C_{M\alpha}(M)L}{C_{N\alpha}(M)} + (x_{cg,full} - x_{cg})
$$

Fin effectiveness:

$$
C_{M\delta_e}(M) = -\frac{(C_{N\alpha}(M)-2.0)\,\ell_{fin}}{L}
$$

$\ell_{fin}$ is computed from the root chord / tip chord / semi-span / sweep
angle and the quarter mean aerodynamic chord. Large-angle moment convexity is
corrected by $G_{cm}(M,\alpha)$ ($M$ table: 0.2/2/3/4/5 → 1.00/1.85/1.35/1.35/1.31,
enabled linearly from α = 6° to 16°).

**Yaw / roll:**

$$
C_{N,yaw} = -C_{N\beta}\,\kappa(M)\,\beta + C_{N\delta_r}\,\kappa(M)\,\delta_{Y,eff}
$$

$$
C_L = C_{L\delta_a}\,\kappa(M)\,\delta_{R,eff}
$$

**Damping terms:**

$$
C_m = C_M + C_{m_q}\hat q,\quad
C_n = C_{N,yaw} + C_{n_r}\hat r,\quad
C_l = C_L + C_{l_p}\hat p
$$

$$
\hat p = \frac{pL}{2V},\quad \hat q = \frac{qL}{2V},\quad \hat r = \frac{rL}{2V}
$$

Moments:

$$
\mathbf{M}_b = [C_l,\ C_m,\ C_n]^\top\,q_\infty S_{ref}L
$$

### 8.6 Fin nonlinearity

$$
\delta_{eff} = \delta\left[1 - 0.25\left(\frac{|\delta|}{\delta_{\max}}\right)^2\right]
$$

### 8.7 Body-axis force composition

$$
\mathbf{F}_b =
\begin{bmatrix}
-C_A q_\infty S + T + \Delta_{base}\\
 C_Y q_\infty S\\
-C_N q_\infty S
\end{bmatrix}
$$

where $\Delta_{base} = 0.020\,q_\infty S$ while thrust is on.

### 8.8 Reference derivatives (M = 2 anchor)

| Derivative | Value | Meaning |
|---|---:|---|
| `CM_ALPHA` | −0.51 | Pitch static stability |
| `CM_DE` | −1.03 | Elevator effectiveness |
| `CN_BETA` | −0.30 | Yaw static stability |
| `CN_DR` | +0.30 | Rudder effectiveness |
| `CY_BETA` | −1.6 | Side force |
| `CL_P` | −0.90 | Roll damping |
| `CL_DA` | +0.270 | Differential-fin effectiveness |
| `CM_Q` | −25.0 | Pitch damping |
| `CN_R` | −20.0 | Yaw damping |
| `FIN_CD` | 0.08 | Fin drag per radian |

---

## 9. Combined-cycle propulsion model

### 9.1 Solid booster

Thrust altitude correction:

$$
F = F_{sl}\,\phi(t) + A_e\,(P_{sl} - P_a)
$$

- $F_{sl} = 130\,000$ N (sea level, thrust-to-weight ratio about 5.2)
- $A_e = 0.196\ \text{m}^2$ (nozzle diameter 0.50 m)
- $\phi(t)$ is the normalised thrust curve (ignition transient + tail-off)

| Time fraction | 0.00 | 0.10 | 0.80 | 0.90 | 1.00 |
|---|---:|---:|---:|---:|---:|
| Thrust ratio | 0.85 | 1.02 | 1.02 | 1.00 | 0.90 |

Mass flow and specific impulse:

$$
\dot m = \frac{800\ \text{kg}}{13\ \text{s}} = 61.54\ \text{kg/s}
$$

$$
I_{sp} = \frac{F_{sl}\bar\phi}{g_0\dot m} \approx 215\ \text{s}
$$

Not throttleable; after propellant exhaustion or $t \ge 13$ s it switches to
ramjet/glide.

### 9.2 Supersonic ramjet

Available thrust:

$$
T_{avail} = C_R\,q_\infty\,A_{inlet}\,\eta_M(M)\,\eta_h(h)\cos\alpha\cdot u_{thr}
$$

- $C_R = 6.0$
- $A_{inlet} = 0.22\ \text{m}^2$
- Ignition window: $1.6 \le M \le 10$, $q_\infty > 2500$ Pa
- Thrust cap 60 kN, fuel-flow cap 3 kg/s

Efficiency envelopes:

$$
\eta_M = \max\!\left(1 - 0.05(M-3),\ 0.55\right)
$$

$$
\eta_h =
\begin{cases}
1, & h \le 18\ \text{km}\\
1 - \dfrac{h - 18}{32 - 18}, & 18 < h < 32\ \text{km}\\
0, & h \ge 32\ \text{km}
\end{cases}
$$

Fuel flow and thrust:

$$
\dot m = \min\!\left(\frac{T_{avail}}{g_0 I_{sp,ramjet}},\ 3.0\right),
\quad
T = \min\!\left(\dot m\,g_0 I_{sp,ramjet},\ 60000\right)
$$

$I_{sp,ramjet} = 1500$ s.

### 9.3 Ramjet thrust control (Mach hold)

$$
e = M_{ref} - M,\qquad u_{cmd} = \operatorname{clip}(K_p e,\,0,\,1)
$$

- $M_{ref} = 9.5$, $K_p = 0.80$
- Fuel system first-order lag $\tau = 0.25$ s
- Throttle rate limit 1.5 /s
- Boost phase fixed at full throttle; terminal phase full throttle to preserve
  energy; zero outside the envelope

The proportional controller exhibits steady-state Mach droop (thrust must
balance drag), which is acceptable for the hold phase.

### 9.4 Phase determination

| Condition | State |
|---|---|
| $t < 13$ s and not exhausted | `boost` |
| Inside the envelope and $q > 2500$ Pa | `ramjet` |
| Otherwise / fuel exhausted | `coast` |

---

## 10. Target model

3DOF point mass, constant-altitude cruise + terminal weaving evasion.

### 10.1 Initial state

Target speed = target Mach × local speed of sound; heading along the great
circle towards the launch site (head-on). The Earth-rotation carry-over term is
added to the velocity:

$$
\mathbf{v}_0 = V_t\,\hat{\mathbf{d}} + \boldsymbol{\omega}_\oplus\times\mathbf{r}_0
$$

### 10.2 Acceleration

Centripetal term for constant-altitude cruise (inertial velocity is used to
avoid altitude drift):

$$
\mathbf{a}_{level} = -\hat{\mathbf{r}}\,\frac{\|\mathbf{v}\|^2}{\|\mathbf{r}\|}
$$

Once the missile is inside 15 km, the evasion manoeuvre is superimposed:

$$
\mathbf{a}_{evade} = A\sin(2\pi\cdot0.25\,t)\,\mathbf{e}_{cross}
+ 0.25A\sin(2\pi\cdot0.5\,t+1)\,(-\hat{\mathbf{r}})
$$

where $A = n_{evade}g_0$, $\mathbf{e}_{cross} = \hat{\mathbf{r}}\times\hat{\mathbf{v}}$.
By default $n_{evade} = 6$ g.

### 10.3 Target-state estimation and the midcourse datalink

Guidance no longer uses the target truth; it consumes the 6-state estimate from
`sensors/target_tracker.py`:

- Preset cue: `Scenario.cue_pos_sigma / cue_vel_sigma` inject an initial bias
  (default 0);
- Prediction: coordinated constant-altitude cruise + white-noise acceleration;
- Correction: after seeker lock, the converted measurement of LOS + range is
  used; before lock, the **midcourse datalink** provides position/velocity
  corrections at `DATALINK_PERIOD = 1 s` (default 200 m / 4 m/s, adjustable via
  `SimConfig.datalink_*`; `datalink_period <= 0` disables it).

If the datalink is disabled, a 2 km preset cue bias makes the midcourse aim off
(miss distance of kilometres); with it enabled the same bias recovers to the
ten-metre level, see the regression case in `tests/test_main_integration.py`.

---

## 11. GNSS/INS navigation

### 11.1 Twelve-state linear Kalman filter

State (position, velocity, accelerometer bias, gyro bias):

$$
\mathbf{x} = [\mathbf{r},\ \mathbf{v},\ \mathbf{b}_a,\ \mathbf{b}_g]^\top \in \mathbb{R}^{12}
$$

**Prediction (constant-acceleration model):**

$$
\mathbf{r}_{k+1} = \mathbf{r}_k + \Delta t\,\mathbf{v}_k + \tfrac12\Delta t^2\,\mathbf{a}_k
$$

$$
\mathbf{v}_{k+1} = \mathbf{v}_k + \Delta t\,\mathbf{a}_k
$$

The two bias vectors follow first-order Gauss-Markov dynamics. Covariance block propagation:

$$
\mathbf{P}_{00}^{+} = \mathbf{P}_{00} + \Delta t(\mathbf{P}_{01}+\mathbf{P}_{10}) + \Delta t^2\mathbf{P}_{11} + Q_{pos}\mathbf{I}
$$

$$
\mathbf{P}_{01}^{+} = \mathbf{P}_{01} + \Delta t\,\mathbf{P}_{11},\qquad
\mathbf{P}_{11}^{+} = \mathbf{P}_{11} + Q_{vel}\mathbf{I}
$$

$$
Q_{pos} = \left(\sigma_a \Delta t^2\right)^2/4,\qquad
Q_{vel} = \left(\sigma_a \Delta t\right)^2
$$

**GNSS update ($H = [I_6\ 0\ 0]$):**

$$
\mathbf{S} = \mathbf{P}_{0:6,0:6} + \mathbf{R},\qquad
\mathbf{K} = \mathbf{P}_{:,0:6}\mathbf{S}^{-1}
$$

$$
\mathbf{x} \leftarrow \mathbf{x} + \mathbf{K}(\mathbf{z} - \mathbf{x}_{0:6}),\qquad
\mathbf{P} \leftarrow (\mathbf{I}-\mathbf{K}\mathbf{H})\mathbf{P}
$$

After the update, $\mathbf{P}$ is forced symmetric:
$\mathbf{P} \leftarrow \frac12(\mathbf{P}+\mathbf{P}^\top)$.

### 11.2 IMU error model

- Acceleration white noise: 100–120 μg/√Hz, equivalent to about 0.012 m/s² at
  the 5 ms sampling rate
- Initial bias: 1.5 mg = 0.0147 m/s²
- In-run bias stability: 150 μg = 0.0015 m/s²
- First-order Gauss-Markov correlation time: 1000 s

$$
\phi = e^{-\Delta t/\tau},\qquad
b_{k+1} = \phi b_k + \sigma_{walk}\sqrt{1-\phi^2}\,\mathcal{N}(0,1)
$$

### 11.3 Navigation parameters

| Parameter | Value |
|---|---:|
| GNSS position 1σ | 8 m / axis |
| GNSS velocity 1σ | 0.15 m/s / axis |
| Process-noise acceleration | 0.50 m/s² |
| GNSS period | 1 s |
| Output delay | 50 ms |

Delay implementation: a `deque` stores `(t, x)` and the newest frame before
`t - delay` is output. Initial alignment uses noisy GNSS positioning, and the
covariance starts from the GNSS noise level rather than near zero.

---

## 12. Radar seeker

### 12.1 Measurements

- Line-of-sight unit vector (with angle noise)
- Line-of-sight angular rate (with noise + first-order low-pass)
- Range and range rate
- Lock flag and off-boresight angle

### 12.2 Noise model

Angle white noise 1σ:

$$
\sigma_{angle} = 1.0\ \text{mrad}
$$

Glint:

$$
\sigma_{glint} = \frac{k\,L_{target}}{R},\qquad k = 0.30,\ L_{target}=15\ \text{m}
$$

Total angle noise:

$$
\sigma_{tot} = \sqrt{\sigma_{angle}^2 + \sigma_{glint}^2}
$$

Line-of-sight angular-rate noise is injected as $\sigma_{tot}/0.02$ and then
filtered by a 20 ms first-order filter:

$$
\hat{\boldsymbol{\omega}}_k = \hat{\boldsymbol{\omega}}_{k-1} + \alpha(\boldsymbol{\omega}_{meas} - \hat{\boldsymbol{\omega}}_{k-1}),
\quad \alpha = \min(\Delta t/0.02, 1)
$$

Range / range-rate measurement noise: 5 m / 2 m·s⁻¹.

### 12.3 Field of view, blind zone and dual-mode lock

$$
\text{lock} = \left(\theta_{FOV} \le 20^\circ\right)\ \wedge\
\left(R > 200\ \text{m}\right)\ \wedge\ \left(R \le R_{lock}\right)
$$

The off-boresight angle is given by the `acos` of the dot product between the
body X axis and the LOS unit vector. The seeker is a radar + imaging-infrared
dual mode:

| Channel | Lock range | Notes |
|---|---:|---|
| Radar | $R_{radar}=45\,\text{km}\,(\sigma/5\,\text{m}^2)^{1/4}$ | Scales with target RCS by the fourth root |
| Infrared | 25 km | Passive imaging, independent of RCS |

$$
R_{lock} = \max\left(R_{radar},\ R_{IR}\right)
$$

For the F-35 head-on, $\sigma=0.005\ \text{m}^2$ (-23 dBsm) is used, giving a
radar lock range of only about **8 km**; the infrared channel still locks at
25 km under a clear sky, so the effective lock range of the dual-mode seeker is
25 km and the terminal window is about 7.6 s. In pure radar mode (infrared
channel disabled) the terminal phase shrinks to 2.4 s and the nominal miss
distance degrades to 462 m, showing that stealth is decisive against a
single-mode radar seeker.

---

## 13. Guidance laws and handover management

### 13.1 Boost phase: vertical cold launch + gravity turn

Vertical ascent for the first 2 s; attitude control holds the initial attitude.

The climb-angle reference is rate-limited by the **available normal load
factor** rather than by a fixed angular rate:

$$
a_{feasible} = 0.85\left(\frac{q_\infty S_{ref} C_{N\alpha}\alpha_{\max}}{m}
+ \frac{T\sin\alpha_{\max}}{m}\right)
$$

$$
\dot\gamma_{\max} = \min\left(8^\circ/\text{s},\ \frac{a_{feasible}}{V}\right)
$$

$$
\gamma_{ref} \leftarrow \max\left(30^\circ,\ \gamma_{ref} - \dot\gamma_{\max}\Delta t\right)
$$

Required normal acceleration:

$$
a_\perp = V\left(\dot\gamma_{ref} + K_\gamma(\gamma_{ref}-\gamma)\right) + g_0\cos\gamma
$$

Heading hold:

$$
a_{head} = V K_{head}\,\varepsilon_{head}
$$

Thrust normal-component deduplication:

$$
a \leftarrow \frac{a}{1 + \dfrac{T}{q_\infty S_{ref} C_{N\alpha}}}
$$

The total lateral budget is scaled proportionally to $a_{feasible}$; the final
command is limited to 4 g. Below 500 m altitude an additional 1.5 g pull-up
protection is applied.

### 13.2 Midcourse: 3D cubic Bezier + PN + energy management

**Bezier curve:**

$$
\mathbf{B}(s) = (1-s)^3\mathbf{P}_0 + 3(1-s)^2s\,\mathbf{P}_1
+ 3(1-s)s^2\mathbf{P}_2 + s^3\mathbf{P}_3
$$

- $\mathbf{P}_0$: current navigation position
- $\mathbf{P}_1$: along the current velocity direction, length
  $\min(0.25\,T\,V,\ 40\ \text{km})$
- $\mathbf{P}_2$: back-derived from the arrival velocity direction,
  $\mathbf{P}_2 = \mathbf{P}_3 - \ell\,\hat{\mathbf{v}}_{arr}$
- $\mathbf{P}_3$: predicted intercept point + altitude advantage
  `HANDOVER_DH_NOMINAL`

First and second derivatives are given analytically; the tracking law is:

$$
\mathbf{a}_{bez} = k_1(\mathbf{p}_{ref}-\mathbf{r}) + k_2(\mathbf{v}_{ref}-\mathbf{v}) + \ddot{\mathbf{p}}_{ref}
$$

$k_1 = 2\times10^{-4}$, $k_2 = 0.06$; the curvature feedforward is limited to
1.5 g.

**PN enhancement:**

$$
\mathbf{a}_{PN} = N_{mid}\,V_c\,\boldsymbol{\omega}_{LOS}\times\mathbf{u},\qquad N_{mid}=2.0
$$

**Energy management:**

- Long range: hold dynamic pressure at 75 kPa (about 30 km, α≈6°, close to the
  best lift-to-drag ratio),

$$
\gamma_{des} = \operatorname{clip}\left(0.45\left(\frac{q_\infty}{q_{cruise}}-1\right),\ \pm0.08\right)
$$

- Inside 220 km: the altitude advantage decreases linearly from 14 km to 2 km at
  the handover point
- Vertical command:

$$
a_{net} = \operatorname{clip}\left(\frac{V}{2}(\gamma_{des}-\gamma) - 0.22\,v_{z,up},\ \pm1.5g\right)
$$

$$
a_{vert} = a_{net} + g_0\cos\gamma
$$

**Coplanar handover constraint (lateral channel):**

Normal to the vertical plane of the target ground velocity:

$$
\mathbf{n} = \frac{\mathbf{r}_t\times\mathbf{v}_{t,air}}{\|\mathbf{r}_t\times\mathbf{v}_{t,air}\|}
$$

Lateral offset $x = (\mathbf{r}_m-\mathbf{r}_t)\cdot\mathbf{n}$, lateral rate
$\dot x = \mathbf{v}_{rel}\cdot\mathbf{n}$. Terminal double-integrator profile:

$$
a_n = -K_{cop}\,w\,\frac{6x + 4\dot x\,t_{go}}{t_{go}^2}
$$

$K_{cop}=0.8$, $t_{go}$ floor 8 s, lateral command cap 3 g; fades in starting at
2100 km.

**Replanning and blending:**

- Replan every 10 s
- Freeze the path inside 150 km (to prevent curvature blow-up as $t_{go}\to0$)
- Crossfade the new path over 2 s
- Final command limited to 5 g

### 13.3 Terminal: ZEM/APN + adaptive N

Navigation-delay extrapolation:

$$
\mathbf{a}_{est} = \mathbf{a}_{prev} + \mathbf{g}(\mathbf{r}_{nav}),\qquad
\mathbf{r} = \mathbf{r}_{nav} + \mathbf{v}_{nav}\Delta t + \tfrac12\mathbf{a}_{est}\Delta t^2
$$

$$
\mathbf{v} = \mathbf{v}_{nav} + \mathbf{a}_{est}\Delta t
$$

Time-to-go:

$$
t_{go} = \max\left(\frac{R}{V_c},\ t_{go,\min}\right),\qquad
V_c = \max(-\dot R,\ 50)
$$

Zero-effort miss (including target-acceleration feedforward):

$$
\mathbf{ZEM} = \boldsymbol{\rho} + \mathbf{v}_{rel}t_{go} + \tfrac12\mathbf{a}_T t_{go}^2
$$

Target-acceleration estimate: finite difference of the tracked target velocity
+ 30 ms first-order low-pass.

Adaptive navigation constant:

$$
N_{eff} = \max\left(3,\ N\left[1 + 0.4\,\operatorname{clip}\left(1 - \frac{t_{go}}{20},0,1\right)\right]\right)
$$

Command:

$$
\mathbf{a}_{cmd} = N_{eff}\,\frac{\mathbf{ZEM}_{\perp}}{t_{go}^2}
$$

FOV soft protection (only near the edge):

$$
\mathbf{a}_{cmd} \mathrel{+}= 2.0\,V_c\,\operatorname{perp}_{\hat{\mathbf{v}}}(\mathbf{u})
\quad\text{when } \theta_{FOV} > 0.8\times20^\circ
$$

Compensate only the gravity component normal to the velocity:

$$
\mathbf{a}_{cmd} \leftarrow \mathbf{a}_{cmd} - \mathbf{g}_{\perp\hat{\mathbf{v}}}
$$

The command is smoothed with a first-order filter ($\alpha=0.75$) and finally
limited to 40 g.

### 13.4 Handover management

Handover is not a single range trigger but a combined "acquisition + energy +
geometry" criterion:

| Gate | Condition | Design intent |
|---|---|---|
| Range | $R \le 40$ km | Reliable seeker tracking |
| FOV | $\theta \le 0.9\times20^\circ$ | Leave manoeuvre margin |
| Lead angle | $\le 12^\circ$ | Terminal guidance needs no large reorientation |
| Time-to-go | $t_{go} \ge 4$ s | Complete the 0.5 s blending + endgame transient |
| Available load factor | $n_{avail} \ge 4$ g | Aerodynamic authority still sufficient |
| Altitude difference | $0 \le \Delta h \le 12$ km | Retain dive energy, avoid ground clutter |
| Speed | $\ge 1800$ m/s | Energy gate |
| Seeker lock | yes | Hard acquisition gate |

Available load factor:

$$
n_{avail} = \frac{q_\infty S_{ref} C_{N\alpha}\alpha_{\max}}{m g_0}
$$

All gates must hold continuously for 0.2 s. If within 30 km the altitude gate
still cannot be satisfied, but speed, FOV, lead angle and lock are all
satisfied and the altitude difference is not below −5 km, handover is forced.

Blending weight after handover:

$$
w = \operatorname{clip}\left(1 - \frac{t-t_{trig}}{0.5},0,1\right),\qquad
\mathbf{a} = w\,\mathbf{a}_{mid} + (1-w)\,\mathbf{a}_{term}
$$

---

## 14. Control system and actuators

### 14.1 Three-loop autopilot structure

```text
a_cmd(ECI) ──▶ virtual α/β ──▶ 2nd-order command prefilter ──▶ rate loop ──▶ virtual fin ──▶ mixer
                              ▲                                 ▲
                              └── reference governor            └── gain schedule / DOB / anti-windup
```

### 14.2 Virtual angle of attack / sideslip

$$
\alpha_{cmd} = -\frac{a_{b,z}\,m}{q_\infty S_{ref} C_{N\alpha}},\qquad
\beta_{cmd} = -\frac{a_{b,y}\,m}{q_\infty S_{ref}|C_{Y\beta}|}
$$

Limited to ±25°. Lift-vector alignment with the roll command:

$$
p_{cmd} = \operatorname{clip}\left(2.0\,\operatorname{atan2}(a_{b,y},\,-a_{b,z}),\ \pm1\ \text{rad/s}\right)
$$

### 14.3 Second-order command prefilter + reference governor

$$
\ddot x = \omega_n^2(x_{cmd}-x) - 2\zeta\omega_n\dot x
$$

- $\zeta = 0.707$
- Bandwidth scheduled with $\sqrt{q_\infty}$, range 1–8 Hz
- Acceleration limit:

$$
\ddot\alpha_{\max} = 0.45\,\frac{q_\infty S_{ref} L\,|C_{M\delta_e}|\,\delta_{\max}}{I_{yy}}
$$

- Rate limit $|\dot x| \le \sqrt{2\ddot x_{\max}|x_{cmd}-x|}$, guaranteeing no
  overshoot

### 14.4 Outer loop (pseudo angle of attack → angular rate)

$$
q_{cmd} = \dot\alpha_{ref} + K_{P\alpha}e_\alpha + K_{I\alpha}\int e_\alpha
$$

$$
r_{cmd} = -\left(\dot\beta_{ref} + K_{P\alpha}e_\beta + K_{I\alpha}\int e_\beta\right)
$$

$K_{P\alpha}=3.2$, $K_{I\alpha}=0.6$; integral clamp ±0.5.
At low dynamic pressure the integral gain is scaled by $\sqrt{q/q_{ref}}$, with
a floor of 0.35.

### 14.5 Inner loop (angular rate → virtual fin)

$$
d_p = -K_{Pq}\,e_q - K_{Iq}\int e_q
$$

$$
d_y = +K_{Pr}\,e_r + K_{Ir}\int e_r
$$

$K_{Pq}=0.14$, $K_{Iq}=1.5$ (the integral term is further multiplied by 0.1).
Roll:

$$
d_r = K_{Pp}\,e_p + 0.01\int e_p,\qquad K_{Pp}=0.03
$$

**Model gain scheduling:**

$$
K_{Pq,req} = \frac{\omega_q I_{yy}}{q_\infty S_{ref} L\,|C_{M\delta_e}|}
$$

$$
\text{gain\_scale} = \operatorname{clip}\left(\frac{K_{Pq,req}}{K_{Pq,baseline}},0.30,3.0\right)
$$

$\omega_q = 22$ rad/s. No offline retuning is needed after geometry or
aerodynamic changes.

### 14.6 Anti-windup and low-dynamic-pressure protection

- Freeze all integrators when the mixer saturates
- On position saturation, back-calculate the rate-loop integrals:

$$
I \leftarrow I + 0.5\,\frac{\delta_{cmd}-\delta_{applied}}{K_I}
$$

- Disable integration when $q_\infty < 100$ Pa
- Angular-rate integral clamp ±5, roll integral clamp ±1

### 14.7 Disturbance observer (DOB)

Second-order linear extended state observer:

$$
\dot z_1 = z_2 + b_0 u + 2\omega_o(y-z_1)
$$

$$
\dot z_2 = \omega_o^2(y-z_1)
$$

Compensation:

$$
d \leftarrow d - K_{DOB}\,\frac{z_2}{|b_0|}\operatorname{sign}(b_0)
$$

$K_{DOB}=0.25$, $\omega_o=20$ rad/s, $z_2$ limited to ±50 rad/s², frozen when
$q<1000$ Pa.

### 14.8 Model feedforward trim

$$
\delta_{trim} = 0.3\,\text{LPF}_{\tau=0.1}\left(
-\frac{\alpha}{|C_{M\delta_e}|}\,|C_{M\alpha}|\,
\frac{X_{ref}-x_{cg}}{X_{ref}-x_{cg,full}}\right)
$$

where the static-stability ratio is updated with the current centre of gravity
as fuel is consumed.

### 14.9 Fin mixing and actuators

Four cruciform fins:

$$
\delta_{up} = \delta_{down} = \delta_Y
$$

$$
\delta_{left} = \delta_P - \delta_R,\qquad
\delta_{right} = \delta_P + \delta_R
$$

Processing order: **rate limit → first-order lag → position limit**

| Parameter | Value |
|---|---:|
| Fin position limit | ±25° |
| Fin rate limit | 100°/s |
| Actuator first-order time constant | 10 ms |
| Saturation flag | Fed back to the attitude-control anti-windup |

---

## 15. Numerical integration, events and telemetry

### 15.1 Native RK4

$$
\mathbf{k}_1 = f(t,\mathbf{y})
$$

$$
\mathbf{k}_2 = f(t+\tfrac h2,\ \mathbf{y}+\tfrac h2\mathbf{k}_1)
$$

$$
\mathbf{k}_3 = f(t+\tfrac h2,\ \mathbf{y}+\tfrac h2\mathbf{k}_2)
$$

$$
\mathbf{k}_4 = f(t+h,\ \mathbf{y}+h\mathbf{k}_3)
$$

$$
\mathbf{y}_{n+1} = \mathbf{y}_n + \frac h6(\mathbf{k}_1 + 2\mathbf{k}_2 + 2\mathbf{k}_3 + \mathbf{k}_4)
$$

The RK4 weighted average derivative is also returned:

$$
\mathbf{f}_{avg} = \frac{\mathbf{k}_1 + 2\mathbf{k}_2 + 2\mathbf{k}_3 + \mathbf{k}_4}{6}
$$

`before_step` samples all discrete modules at the start of each outer step
(ZOH); `after_step` updates caches such as the INS with $\mathbf{f}_{avg}$,
avoiding endpoint derivatives at thrust/fin jumps.

### 15.2 In-step state reconstruction

Event localisation no longer uses endpoint Hermite interpolation. The candidate
state within the interval $[t_a, t_b]$ is obtained by **re-running RK4 once from
the left end of the interval** (`_rk4_state`), consistent with uniflight's
`FixedStepRK4Integrator._refine_root`:

$$
\mathbf{y}(t_a+\tau) = \mathrm{RK4}\left(\mathbf{y}_a,\ \tau\right),\qquad 0<\tau\le h
$$

Because `before_step` has already frozen the sampled modules (ZOH), the RHS is
a pure function within the step; re-integration produces no sampling side
effects, and no Hermite endpoint-derivative interpolation error is introduced at
thrust/fin jumps.

### 15.3 Event detection

- **Miss event**: range rate changes from negative to positive (closest
  approach), `direction=+1`
- **Ground-impact event**: $\|\mathbf{r}\| = R_e$, `direction=-1`
- Direction determination follows uniflight semantics: a zero at the left
  endpoint does not count as a new root (`g0 < 0 <= g1` / `g0 > 0 >= g1`)
- Guard values are zeroed within `event_guard_tolerance` (default 1e-10); time /
  guard tolerances and iteration counts are configurable
- Simultaneous events in the same time window are ordered by `priority`;
  non-terminal events continue integration from the root
- The miss distance is taken from the RK4-reconstructed event state, avoiding
  sampling distortion at high fly-through speeds
- If no event fires, the minimum range from telemetry is used as a fallback

### 15.4 Telemetry

- Preallocated NumPy buffer, `list.append` forbidden
- Fixed capacity; overflow is only counted, never resized
- Time must be strictly increasing
- Any NaN/Inf immediately raises `FloatingPointError`
- One frame per 10 ms by default, 47 columns (see Appendix B)

### 15.5 Optional Numba hot paths

When compilation is possible, `fastcore.py` enables `@njit` versions of the
RHS, attitude control, fin mixing, seeker, navigation prediction/update,
telemetry writing and atmosphere model; otherwise it falls back to pure Python
function by function.
The Numba cache directory is keyed by the first 12 hex digits of the SHA-256 of
`config.py / fastcore.py / atmosphere.py / missile.py`, so changing constants
cannot accidentally reuse stale kernels.

---

## 16. Monte-Carlo campaign

### 16.1 Dispersion model

| Parameter | Default | Meaning |
|---|---:|---|
| `launch_cep_m` | 500 | Launch-point horizontal CEP |
| `target_cep_m` | 2000 | Target horizontal CEP |
| `target_alt_sigma_m` | 500 | Target altitude 1σ |
| `target_mach_sigma` | 0.05 | Target Mach 1σ |
| `evade_g_sigma` | 1.0 | Target evasion load factor 1σ |
| `lethal_radius` | 10 m | Hit-criterion radius |

CEP to 1σ conversion:

$$
\sigma = \frac{\text{CEP}}{\sqrt{2\ln 2}}
$$

Latitude/longitude offsets (spherical approximation):

$$
\Delta\varphi = \frac{\Delta n}{111320},\qquad
\Delta\lambda = \frac{\Delta e}{111320\cos\varphi}
$$

### 16.2 Parallelism and reproducibility

- Each case is fully described by `(SimConfig, Scenario)`, with no shared
  mutable state
- `ProcessPoolExecutor` multiprocessing bypasses the GIL
- Random seed `base_seed + case_id × 7919`, reproducible
- Child processes return only scalar metrics; telemetry arrays stay in the child
  process to avoid IPC overhead
- A single-case exception does not abort the whole batch; it is recorded in the
  `error` column

### 16.3 Statistics

- Hit rate: fraction of cases with miss distance ≤ hit radius
- Mean / standard deviation / minimum / maximum
- CEP50 / CEP90
- Total wall-clock time and degree of parallelism

---

## 17. Data files and database inventory

### 17.1 Built-in / generated data files

| File | Type | Contents | Generated by |
|---|---|---|---|
| `output/datcom_aero.csv` | Aerodynamic database | CD/CL/CM/CN/CA/CN_α/CM_α/CYB/CNB/CLB for M = 0.2/0.5/0.8/0.95/1.05/1.2/2/3/4/5, α = 0–24° | `tools/datcom_aero.py` |
| `output/telemetry.csv` | Time-series database | Full 47-column telemetry | `main.py` at run end |
| `output/batch/batch_results.csv` | Statistics database | Per-case miss distance, time, final phase, CPU time, scenario parameters | `batch.py` |
| `intercept-report/assets/metrics.json` | Results database | Key metrics and phase segmentation of the nominal trajectory | `tools/build_report_data.py` |
| `intercept-report/assets/data.js` | Chart data | 900-point sampled telemetry + fully computed metrics | `tools/build_report_data.py` |
| `output/intercept_dashboard.html` | Visualisation | Six-panel interactive dashboard | `main.py` |
| `intercept-report/intercept-report.html` | Technical report | Apple-style single-page ECharts report | `tools/build_report_data.py` |

### 17.2 `datcom_aero.csv` fields

```text
mach, alpha_deg, CD, CL, CM, CN, CA, CN_alpha, CM_alpha, CYB, CNB, CLB
```

### 17.3 Nominal scenario data

| Item | Latitude | Longitude | Altitude | Speed |
|---|---:|---:|---:|---:|
| Launch site | 40.0°N | 110.0°E | 0 m | At rest (carried by Earth rotation) |
| Target (F-35A-class threat) | 28.0°N | 126.0°E | 15 240 m | Mach 1.6, head-on |

Great-circle range about 1990 km. The target starts a 9 g weaving evasion when
it is 15 km from the missile.

### 17.4 Geometry, mass and inertia

| Parameter | Value | Notes |
|---|---:|---|
| Body length | 8.11 m | |
| Body diameter | 0.63 m | |
| Reference area | 0.3117 m² | $\pi(D/2)^2$ |
| Exposed semi-span per side | 0.364 m | Fin span +30% |
| Root chord / tip chord | 3.8 / 1.6 m | |
| Planform area | 1.9656 m² | Two lifting surfaces |
| Aspect ratio | 0.270 | $(2b)^2/S_{planform}$ |
| Launch mass | 2565 kg | |
| Dry mass | 1000 kg | Hard lower bound |
| Ixx (full/dry) | 190 / 90 kg·m² | |
| Iyy = Izz (full/dry) | 6000 / 2400 kg·m² | Lifting-body mass concentrated near the CG |
| Centre of gravity (full/dry) | 4.45 / 4.10 m | Measured from the nose tip |
| Aerodynamic centre | 5.24 m | DATCOM M=2 anchor |
| Static stability margin | 0.79 m (full fuel) | $X_{ref}-CG_{full}$ |

`validate_data()` checks:

- Reference area = body cross-sectional area
- Solid thrust-curve mean normalised (±2%)
- Specific impulse back-calculation consistent (±5%)
- Nozzle area ∈ (0, S_REF)
- Ramjet altitude envelope non-degenerate
- Booster ideal Δv covers 1.2 times the ramjet ignition speed
- Inertia positive definite, Iyy = Izz > Ixx, and 0.35–1.1 times that of a
  uniform slender-cylinder baseline
- Static stability margin consistent with $X_{ref}-CG$ (±0.10 m) and within the
  DATCOM band of 0.2–1.2 m
- Dry-mass CG ahead of the full-mass CG, with a positive dry static stability
  margin
- CG travel between 0.2 m and 15% of body length

---

## 18. Key parameters summary

### 18.1 Scenario and phases

| Parameter | Value |
|---|---:|
| Launch time | 0 s |
| Vertical cold launch | 2 s |
| Solid burn | 13 s |
| Boost → midcourse | 20 s |
| Nominal handover | ~637 s |
| Simulation end | 1200 s |
| Midcourse replanning | 10 s |
| Midcourse freeze distance | 150 km |
| Midcourse descent start | 220 km |
| Midcourse cruise altitude difference | 14 km |
| Handover altitude difference | 2 km |

### 18.2 Aerodynamic / control limits

| Parameter | Value |
|---|---:|
| Maximum trim angle of attack | 25° |
| Maximum fin deflection | 25° |
| Maximum fin rate | 100°/s |
| Pitch-rate loop crossover frequency | 22 rad/s |
| Pitch outer-loop gain `AP_KP_ANGLE` | 6.0 |
| Pitch rate-loop gain `AP_KP_RATE` | 0.14 |
| Attitude command prefilter | 1–10 Hz (with q) |
| 法向过载环 `AP_NZ_LOOP`（`AP_KP_NZ`/`AP_KI_NZ`） | 开 / 0.02 rad·s⁻¹·g⁻¹ / 0.004 |
| 过载超前补偿 `AP_NZ_LEAD` | 0.06 s（4 种子均值 3.3 m，基线 17.7 m） |
| Midcourse command limit | 5 g |
| Terminal command limit | 40 g |
| Boost command limit | 4 g |
| Coplanar lateral command limit | 3 g |

### 18.3 Seeker and navigation

| Parameter | Value |
|---|---:|
| Seeker period | 5 ms |
| Half field-of-view angle | 20° |
| Blind zone | 200 m |
| Angle noise 1σ | 1 mrad |
| Glint coefficient | 0.30 |
| Target equivalent length | 15.7 m |
| Target head-on RCS | 0.005 m² (-23 dBsm) |
| Radar reference lock range | 45 km @ 5 m² |
| Radar actual lock range | about 8 km @ 0.005 m² |
| Infrared lock range | 25 km |
| GNSS period | 1 s |
| Navigation delay | 50 ms |
| GNSS position/velocity 1σ | 8 m / 0.15 m·s⁻¹ |
| IMU white noise | 0.012 m/s² / 5 ms |
| IMU initial bias | 1.5 mg |
| Bias stability | 150 μg |
| Bias correlation time | 1000 s |

### 18.4 Numerical

| Parameter | Value |
|---|---:|
| Outer step (boost/terminal) | 5 ms |
| Outer step (midcourse) | 10 ms |
| Integrator | Fixed-step RK4 |
| In-step state reconstruction | Left-end RK4 re-integration |
| Event localisation | Direction-aware + bisection (tolerance 1e-10) |
| Telemetry period | 10 ms |
| Telemetry capacity | 200 000 frames |
| Integration step limit | 2 000 000 |

---

## 19. Test matrix

Run: `python -m pytest -n auto`

| Test file | Coverage |
|---|---|
| `test_data_consistency.py` | Atmosphere monotonicity, thrust increasing with altitude, non-constant boost curve, ramjet throttle/envelope, CG travel entering the static moment, data consistency, mass/inertia decay, dry-mass protection, quaternion round-trip, LLA/ECI round-trip, telemetry preallocation and NaN rejection |
| `test_aero_anchors.py` | DATCOM anchors at M=2/3/5, α=4°; CN_α table continuity with the hypersonic band; transonic-bridge conservatism; static stability margin and control authority; large-angle moment gain; friction increasing with altitude; lift-to-drag ratio range |
| `test_control.py` | Second-order filter without high-frequency oscillation; fin-mixer rate/position limits; anti-windup integral freeze; low-dynamic-pressure protection; gain-schedule boundedness and interpolation; prefilter/acceleration limits vs q; reference governor; back-calculation limiting; thrust-controller Mach hold/envelope/rate/steady-state droop |
| `test_guidance.py` | Handover all gates pass / bad-geometry rejection / no-lock rejection; decreasing blending weight; Bezier endpoints and tangents; midcourse lead-point prediction; coplanar bias drives into plane; terminal guidance corrects LOS deviation |
| `test_sensors.py` | Navigation KF convergence; seeker FOV rejects targets behind; lock and blind zone; glint scaling with range |
| `test_main_integration.py` | Multi-rate trigger counts; short-run simulation stability; event detection returns a finite miss distance |
| `test_fastcore.py` | Numba atmosphere/missile RHS/target RHS/attitude-control mixing identical to pure Python; noise streams reproducible |
| `test_batch.py` | Small parallel batch; hit-rate and CEP statistics; dispersion sampling reproducible |

There is also a standalone verification script:

```bash
python tools/aero_crosscheck.py
```

It outputs six checks:

1. Slender-body normal-force slope → theoretical value 2/rad
2. Lifting-line nonlinearity → $C_N(8°)/C_N(4°)$ > 2 as M increases
3. Modified Newtonian vs exact oblique-shock $C_p$ (10° wedge, M=6/8/10)
4. Turbulent flat-plate friction $0.074/Re^{0.2}$ vs Prandtl-Schlichting
5. The built-in M > 5 table reproducible from shock-expansion relations
   ($\eta=0.334$)
6. CN/CD/CM reproduction error of the built-in table against
   `output/datcom_aero.csv`

---

## 20. Nominal results and verification

### 20.1 Nominal trajectory

The following are single-shot nominal results for the current F-35A threat
scenario with the default seed (they vary slightly with the seed / handover
geometry):

| Metric | Value |
|---|---:|
| Miss distance | 25.7 m |
| Intercept time | 672.47 s |
| Maximum speed | 3094.8 m/s |
| Maximum Mach | 9.52 |
| Maximum dynamic pressure | 894.9 kPa |
| Maximum altitude | 29.96 km |
| Maximum load factor | 12.1 g (measured) / 40 g (command limit) |
| Fuel consumption | 1474 kg |
| Range | 1670.5 km |
| Handover time | 664.52 s |
| Handover distance | 24.35 km |
| Terminal guidance duration | 7.95 s |
| FOV exceedance fraction | 5.6% |
| Telemetry frames | 67,248 |

Phase segmentation: boost 0–20 s, midcourse 20–664.52 s, terminal
664.52–672.47 s.
The handover distance is determined by the actual seeker lock range and may be
earlier than the nominal 45 km gate; low-altitude / low-RCS conditions may
hand over late or lose lock, which is a scenario/seeker/handover constraint
rather than a terminal-guidance tuning issue.

### 20.2 Result credibility

- No rejected steps under multi-rate scheduling; repeated runs agree (stochastic
  processes are reproducible with a fixed seed)
- Numba and pure-Python paths are aligned value by value in the tests
- The aero tables are cross-checked three ways against DATCOM output, classical
  theory and exact shock relations
- Data-consistency checks are enforced at every start-up
- Batch campaigns use independent random seeds and independent processes, and
  their statistics are reproducible

---

## 21. Assumptions, limitations and scope

### 21.1 Main assumptions

1. WGS84 ellipsoid + J2 gravity by default; the 6371 km spherical model can be
   selected instead; neither includes terrain
2. No wind field, atmospheric disturbance or rain attenuation by default;
   `vehicle/wind.py` is an optional wind model, and the current compiled hot
   path passes zero wind
3. The target is a 3DOF point mass with a fixed head-on RCS and no
   attitude/frequency fluctuation
4. Aerodynamic coefficients are DATCOM + theoretical extrapolation, not
   calibrated against wind-tunnel or flight tests of this vehicle
5. The seeker is a simplified dual-mode model: radar monopulse + an infrared
   channel represented only by an RCS-independent lock range, without clutter,
   jamming, multipath, cloud attenuation or a signal-processing chain
6. The actuator is a first-order lag + rate/position limits, without backlash,
   dead band or structural flexibility
7. Inertia and centre of gravity vary linearly with fuel; propellant sloshing is
   ignored
8. Thrust is an engineering model without combustion instability or
   inlet start-up/surge
9. Aerodynamic heating, structural strength, thermal protection and
   aeroelasticity are not modelled
10. Datalinks, cooperative engagement and in-flight command updates are not
    modelled

### 21.2 Scope

- Guidance/control/navigation algorithm design and comparison
- Trajectory scheme trade studies and energy-management research
- Monte-Carlo miss-distance statistics and robustness assessment
- Software architecture, multi-rate simulation and test-method verification

**Not suitable for**: system performance qualification, operational-level
hit-probability assessment, or any live-fire employment decision.

---

## 22. References

### 22.1 Aerodynamics and atmosphere

| Tag | Reference |
|---|---|
| `DATCOM` / AFFDL-TR-79-3032 | The USAF Stability and Control Digital DATCOM, Vol. I User Manual, AFFDL-TR-79-3032, 1979. This project reproduces the M ≤ 5 tables via `tools/datcom/datcom.exe` |
| `USSA1976` | U.S. Standard Atmosphere, 1976, NASA-TM-X-74335, 1976 |
| `WGS84` | NIMA Technical Report TR8350.2, Department of Defense World Geodetic System 1984 |
| `Allen & Perkins` | Allen, H. J., Perkins, E. W., *A Study of Effects of Viscosity on Flow Over Slender Inclined Bodies of Revolution*, NACA Report 1048, 1951 |
| `NACA Rep. 1135` | Ames Research Staff, *Equations, Tables, and Charts for Compressible Flow*, NACA Report 1135, 1953 (oblique shock, Prandtl-Meyer) |
| `Prandtl-Schlichting` | Schlichting, H., *Boundary-Layer Theory* (turbulent flat-plate friction) |
| `Helmbold/Diederich` | Classical finite-span lift-slope relations (NACA wartime report) |
| `NACA RM A54H27` | *Wind-Tunnel Investigation of a Cruciform Missile at M = 2*, NACA RM A54H27, 1954 (large-angle lift-line trend) |
| `Sooy & Schmidt 2005` | Sooy, T. J., Schmidt, R. J., *Aerodynamic Predictions, Comparisons, and Validations Using Missile DATCOM (97) and Aeroprediction 98 (AP98)*, Journal of Spacecraft and Rockets, 42(2), 2005 |
| `CR-2835` | Aerodynamic-centre shift trend with Mach (cited in code comments) |
| `PyDATCOM` / `datcom-parser` | Open-source DATCOM wrappers, axis conventions and cruciform-symmetry references |

### 22.2 Guidance, control and estimation

| Tag | Reference |
|---|---|
| `JAST-Bezier` | Mohamadifard, A., Naghash, A., Bezier trajectory shaping for midcourse guidance, *Journal of Aerospace Science and Technology (JAST)*, Vol. 8, No. 2 |
| `ZEM/APN` | Zero-effort-miss / augmented proportional navigation survey (code annotation: Evduzen, 2026); for the APN form see the standard proportional-navigation literature |
| `Hacettepe-3loop` | Three-loop load-factor autopilot structure and anti-windup design (project reference label) |
| `TU-Delft-AW` | Gain scheduling and anti-windup (Anti-Windup) methods (project reference label) |
| `gnss-ins-sim` | IMU bias and angle-random-walk magnitude reference from an open-source GNSS/INS simulator |
| `METU-VarMass` | Variable-mass / centre-of-gravity-travel 6DOF modelling (project reference label) |
| `uniflight` | Single-owner RHS, packed state and event-integrator architecture reference (implemented natively in this project) |

### 22.3 Sensors and engineering calibration

| Tag | Reference / source |
|---|---|
| `DTIC-Glint` | Model of seeker glint noise versus target size and range (DTIC technical report) |
| `DTIC-ThrustAlt` | Thrust altitude correction $F = F_{sl} + A_e(P_{sl}-P_a)$ (DTIC technical report) |
| `KAIST-FlightData` | Load-factor / fin-deflection magnitude calibration (public flight data) |
| `THAAD public data` | Public order of magnitude for a single-stage solid booster: about 20 s burn, burnout speed about 2600 m/s (sanity anchor only) |
| `AIM-120-class seeker` | Public order of magnitude of < 1 mrad angle noise and about 15 dB SNR at 10 nmi |
| `PPS GNSS` | Public figures of military PPS positioning < 3 m SEP and velocity < 0.1 m/s (this model keeps margin) |
| `EMCORE SDI-170 class` | Tactical-grade quartz MEMS IMU noise level |

### 22.4 Software and tools

| Tool | Purpose |
|---|---|
| USAF Digital DATCOM (Jan 96) | Aerodynamic coefficient table generation |
| NumPy | All numerical computation |
| SciPy | Gain-schedule differential-evolution optimisation only |
| Numba | Optional hot-path compilation |
| pytest / pytest-xdist | Parallel testing |
| ECharts | Interactive charts in `intercept-report` |
| Canvas API | Dependency-free plotting in `intercept_dashboard.html` |

---

## Appendix A: symbol table

| Symbol | Meaning | Unit |
|---|---|---|
| $\mathbf{r},\mathbf{v}$ | ECI position / velocity | m, m/s |
| $\mathbf{q}$ | Body → ECI quaternion | — |
| $\boldsymbol{\omega}$ | Body-frame angular rate | rad/s |
| $m$ | Mass | kg |
| $\mathbf{I}$ | Inertia tensor | kg·m² |
| $q_\infty$ | Dynamic pressure $\frac12\rho V^2$ | Pa |
| $M$ | Mach number | — |
| $\alpha,\beta$ | Angle of attack / sideslip | rad |
| $C_N,C_A,C_Y$ | Normal / axial / side force coefficient | — |
| $C_M,C_n,C_l$ | Pitch / yaw / roll moment coefficient | — |
| $t_{go}$ | Time-to-go | s |
| $V_c$ | Closing velocity $-\dot R$ | m/s |
| $\mathbf{ZEM}$ | Zero-effort miss | m |
| $N$ | Navigation constant | — |
| $n$ | Load factor | g |
| $\mathbf{u}$ | Line-of-sight unit vector | — |
| $\boldsymbol{\omega}_{LOS}$ | Line-of-sight angular rate | rad/s |
| $\Delta h$ | Altitude advantage $h_m-h_t$ | m |
| $h(M)$ | Static stability margin | m |
| $\kappa(M)$ | Fin-slope ratio | — |
| $f$ | Fuel fraction | — |

---

## Appendix B: telemetry column definitions

`TELEMETRY_COLUMNS` has 132 columns in array order by default. Monte-Carlo and
batch validation runs use `telemetry_profile="basic"`, which keeps the first
48 columns to bound the per-process telemetry buffer. A single run of
`main.py` writes the full 132-column set.

| # | Column | Meaning | Unit |
|---:|---|---|---|
| 0 | `time` | Simulation time | s |
| 1–3 | `m_rx, m_ry, m_rz` | Missile ECI position | m |
| 4–6 | `m_vx, m_vy, m_vz` | Missile ECI velocity | m/s |
| 7–9 | `t_rx, t_ry, t_rz` | Target ECI position | m |
| 10–12 | `t_vx, t_vy, t_vz` | Target ECI velocity | m/s |
| 13 | `mass` | Missile mass | kg |
| 14 | `mach` | Mach number | — |
| 15 | `q_dyn` | Dynamic pressure | Pa |
| 16 | `alt` | Altitude | m |
| 17–18 | `lat, lon` | Latitude / longitude | deg |
| 19–20 | `alpha, beta` | Angle of attack / sideslip | rad |
| 21–23 | `nx, ny, nz` | Body-axis load-factor components | g |
| 24–26 | `a_cmd_x/y/z` | Guidance command acceleration (ECI) | m/s² |
| 27–29 | `a_act_x/y/z` | Actual aerodynamic + thrust acceleration (ECI) | m/s² |
| 30–33 | `fin_up, fin_down, fin_left, fin_right` | Four fin deflections | rad |
| 34 | `fin_sat` | Fin saturation flag | 0/1 |
| 35 | `nav_err` | Navigation position error | m |
| 36 | `range` | Missile-target range | m |
| 37 | `range_rate` | Range rate | m/s |
| 38 | `seeker_lock` | Seeker lock | 0/1 |
| 39 | `fov_angle` | Line-of-sight off-boresight angle | rad |
| 40 | `phase` | Phase code 0/1/2 | — |
| 41 | `handover` | Handover flag | 0/1 |
| 42 | `dh` | Altitude advantage | m |
| 43 | `lead_angle` | Lead angle | rad |
| 44–46 | `p, q_rate, r_rate` | Body-axis angular rates | rad/s |
| 47 | `tgt_est_err` | Target-tracking estimation error | m |

Extended observables (48–131, emitted by default for a single run; the frame is
stated in each description):

| # | Column | Meaning | Unit |
|---:|---|---|---|
| 48–50 | `m_ecef_x/y/z` | Missile ECEF position | m |
| 51–53 | `m_vecef_x/y/z` | Missile ECEF velocity (Earth rotation removed) | m/s |
| 54–56 | `m_vned_n/e/d` | Missile local-NED velocity components | m/s |
| 57–60 | `q_w, q_x, q_y, q_z` | Body-to-ECI quaternion (scalar first) | — |
| 61–63 | `roll_deg, pitch_deg, yaw_deg` | Body-to-local-NED ZYX Euler angles | deg |
| 64–65 | `gamma_deg, chi_deg` | Flight-path angle (up positive) / heading (from north, east positive) | deg |
| 66–67 | `m_speed, airspeed` | Inertial speed / airspeed (air-relative) | m/s |
| 68–69 | `air_density, sound_speed` | Local air density / speed of sound | kg/m³, m/s |
| 70–72 | `Fbx, Fby, Fbz` | Body-frame aero + thrust force | N |
| 73–75 | `a_cmd_b_x/y/z` | Guidance command acceleration (body axes) | m/s² |
| 76 | `n_cmd_g` | Command load-factor magnitude | g |
| 77–79 | `los_x/y/z` | Missile-to-target LOS unit vector (ECI) | — |
| 80–82 | `los_rate_x/y/z` | LOS angular-rate vector (ECI) | rad/s |
| 83–84 | `t_go, vc` | Time-to-go / closing velocity | s, m/s |
| 85–87 | `nav_rx/ry/rz` | Navigation position estimate (ECI) | m |
| 88–90 | `nav_vx/vy/vz` | Navigation velocity estimate (ECI) | m/s |
| 91–93 | `nav_err_x/y/z` | Navigation position-error vector (ECI) | m |
| 94–96 | `rel_x/y/z` | Target relative position (ECI) | m |
| 97–99 | `t_lat, t_lon, t_alt` | Target geodetic latitude / longitude / altitude | deg, m |
| 100–102 | `t_acc_x/y/z` | Target inertial acceleration (ECI) | m/s² |
| 103–104 | `seeker_range, seeker_range_rate` | Seeker range / range-rate measurement | m, m/s |
| 105–107 | `bx_x/y/z` | Body X axis in ECI | — |
| 108–110 | `by_x/y/z` | Body Y axis in ECI | — |
| 111–113 | `bz_x/y/z` | Body Z axis in ECI | — |
| 114–116 | `Mbx, Mby, Mbz` | Body-frame aero + thrust moment | N·m |
| 117–119 | `t_ecef_x/y/z` | Target ECEF position | m |
| 120–122 | `t_vecef_x/y/z` | Target ECEF velocity (Earth rotation removed) | m/s |
| 123–125 | `seeker_los_x/y/z` | Seeker LOS unit vector (ECI, noisy) | — |
| 126–128 | `seeker_los_rate_x/y/z` | Seeker LOS angular rate (ECI, noisy) | rad/s |
| 129–131 | `g_x, g_y, g_z` | Spherical-Earth gravity acceleration (ECI) | m/s² |

---

*This README is maintained in sync with the code. Parameters are governed by
`config.py`; run results are governed by the files actually generated in
`output/` and `intercept-report/`.*
