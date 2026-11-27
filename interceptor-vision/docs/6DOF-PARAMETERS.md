# 6-DoF closed-loop parameters — checklist, public values, gaps

Target: upgrade the terminal solver from *6-DoF attitude + 3-DoF translation* to a true rigid-body
closed loop (forces **and** moments integrated, fin/DACS actuators in the loop).

A closed loop needs four parameter families. Below, “current” is what this repo uses today,
“public” is what can be sourced, and “status” says whether it is usable as-is.

---

## 1. Mass, geometry and inertia

| Parameter | Symbol | Current in repo | Public evidence | Status |
| --- | --- | --- | --- | --- |
| Overall length | L | 6.76 m | 6.55 m (Block IB) | close, align to 6.55 |
| Body diameter | d | 0.34 m | 0.34 m upper body; 0.53 m booster | OK for upper stage |
| Reference area | S_ref | 0.0908 m² | πd²/4 | OK |
| Launch mass | m0 | 2565 kg (payload curve) | ~1501 kg (Block IB) | **conflict — must decide** |
| Kinetic warhead mass | m_KW | not modelled | ~181 kg (Block IB, unverified) | to confirm |
| Stage masses | m1..m4 | not modelled | Mk72 / Mk104 / Mk136 / Mk142 | to confirm |
| CG travel | x_cg(t) | fixed 3.30 m from nose | not public | estimate / CFD / weigh |
| Roll inertia | Ixx | none | — | estimate: ½·m·R² |
| Pitch/yaw inertia | Iyy=Izz | none | — | estimate: m(L²/12 + R²/4) |
| Product of inertia | Ixz | none (symmetric) | — | 0 by symmetry |

Estimates for the current geometry (uniform slender body):

- Ixx = ½ m R² → 21.7 kg·m² at 1500 kg (37 kg·m² at 2565 kg)
- Iyy = Izz = m (L²/12 + R²/4) → ≈ 5 370 kg·m² at 1500 kg (≈ 9 180 at 2565 kg)

A real missile concentrates mass forward and in the motor case, so treat these as upper bounds;
they are enough to start a closed loop and can be trimmed against flight data.

## 2. Propulsion and staging

| Parameter | Symbol | Current | Public evidence | Status |
| --- | --- | --- | --- | --- |
| Stage 1 (Mk72) burn | t_b1 | 13 s (from the mass curve) | ~6 s, HTPB (reported) | **conflict — verify** |
| Stage 1 thrust | T1 | 4 kN in terminal leg only | ~160 kN implied by the mass curve (60 kg/s, Isp 270 s) | estimate |
| Stage 2 (Mk104) | — | not modelled | dual-thrust (boost + sustain) | to model |
| Stage 3 (Mk136) | — | not modelled | third-stage solid motor | to model |
| KW ejection | t_eject | not modelled | ≈ 24 s before intercept (JHU APL) | public, use it |
| DACS | divert/attitude | not modelled (load cap only) | 4 divert nozzles near CG + 6 attitude nozzles; throttling | thrust/ISP unknown |
| Isp | Isp | none | 250–280 s typical solid | estimate |

## 3. Aerodynamics (the core of a true 6-DoF loop)

Needed as functions of Mach, α (and β for lateral):

| Coefficient | What it does | Current | Status |
| --- | --- | --- | --- |
| CA(M, α) | axial force / drag | engineering table (0.20–0.56) | usable estimate |
| CN(M, α) | normal force | table, CNα(M=2)=8.7 /rad | usable estimate |
| CM(M, α) | static pitching moment | table, CM(10°)=−3.31 | usable estimate |
| Cmq, Cnr, Clp | pitch/yaw/roll damping | table (−16, −1.6, −0.55) | estimate |
| CNδ, CMδ | fin effectiveness | 3.1, −20.7 (per rad) | estimate |
| Clδ, Cnδ(roll) | roll control | 0.18 | estimate |
| Hinge moment | actuator load | **missing** | required for actuator sizing |
| β derivatives | side force / yaw | symmetrical (β = −α) | sufficient for a symmetric body |
| Reynolds/altitude effects | boundary layer, base drag | not modelled | second order |

Public status: **no validated SM-3 aero tables are published.** The only reproducible route without
classified data is:

1. Missile DATCOM (export-controlled) or Digital DATCOM — component build-up for body + strakes + fins;
2. CFD (SU2 / OpenFOAM / CFL3D) on the CAD/GLB, Mach 0.3–10, α −10…20°, plus forced-oscillation runs
   for damping derivatives;
3. wind tunnel for the transonic band and hinge moments;
4. public generic-missile datasets as cross-checks (NASA reports, AIAA papers).

Our `aero-interceptor.json` is the current best estimate and is already structured for interpolation.

## 4. Control loop, actuator, guidance

| Parameter | Symbol | Current | Public / typical | Status |
| --- | --- | --- | --- | --- |
| Fin travel | δ_max | implied ±13.2° (payload channel) | ±15°, ±30° classes | pick ±15° |
| Fin rate | δ̇_max | none | 100–250 °/s; a 1969 NASA actuator quotes 200 ± 50 °/s | use 200 °/s |
| Actuator delay | τ_d | none | 3 ± 1 ms transport delay (same report) | use 5 ms |
| Actuator bandwidth | f_bw | none | 8–20 Hz typical EMA/hydraulic | use 10 Hz, 2nd order |
| Autopilot | — | none (kinematic nose steering) | rate/accel loop, typically 5–15 rad/s crossover | design |
| Mixing | — | none | X-fin mixing (4 fins, pitch/yaw/roll) | implement |
| Guidance | N | 4 | 3–5 typical PN | OK |
| Seeker FOV / lock | — | 90° / 25 km | payload-locked 25 km; KW seeker | keep payload |
| Load limit | n_max | 40 g | recorded payload peak 40 g | keep |

For a KW, replace or blend aerodynamic control with the DACS: divert thrust per nozzle, minimum
impulse bit, valve latency and total divert propellant are **not public**; start with a load-equivalent
thrust budget (e.g. 5–10 g of lateral acceleration for ~20 s) and calibrate to the miss budget.

## 5. Environment and initial conditions

| Item | Value | Status |
| --- | --- | --- |
| Atmosphere | US Standard 1976 / exponential fit | use standard model |
| Gravity | spherical, μ = 3.986004418e14 | already implemented |
| Earth rotation | optional Coriolis | add for long flights |
| Wind | none | add if validating against telemetry |
| Hand-over state | recorded sample at T+664.54 | public (payload) |

---

## Sources consulted

- SM-3 Block IB dimensions / launch weight / wingspan — TheDefenseWatch, Army Recognition, Deagel.
- Stage layout (Mk72 / Mk104 / Mk136 / Mk142) — Aerojet/Raytheon releases, Space Foundation.
- Kinetic warhead and SDACS architecture, KW ejection ≈ 24 s before intercept — JHU APL Technical Digest, “Exo-atmospheric Intercepts”.
- SDACS / TDACS capabilities (multipulse gas generator, 4 divert + 6 attitude nozzles) — Mk 142 brochure, Raytheon/Voyager releases.
- Actuator travel/rate/delay — NASA CR “High-Response Electromechanical Control Actuator” (200 ± 50 °/s, 3 ± 1 ms, ±30°).
- Typical fin travel and resolution (±15°, 1°) — Cambridge Aeronautical Journal, rolling airframe missile controller.
- 6-DoF numerical/interpolation sensitivities — Royal Military Academy 6-DoF model tuning paper.
- JSBSim as an open 6-DoF framework with tabular aero — JSBSim reference manual.

## What is still missing before a true closed loop

1. **Inertia tensor and CG travel** — estimate now, verify by weighing or CFD mass properties.
2. **Hinge moments and fin actuator model** — required to close the loop without idealising the fins.
3. **DACS thrust/ISP/impulse bit** — required for the endgame; otherwise keep an equivalent load cap.
4. **Validated aero tables** — DATCOM/CFD/wind tunnel; the current JSON is an engineering estimate.
5. **Mass consistency** — the payload’s 2565 kg launch mass conflicts with the public 1501 kg; choose
   the vehicle the demo represents before fitting a closed loop.

With items 1–3 estimated and item 5 decided, the existing `aero-interceptor.json` plus the derivative
table is enough to implement the rigid-body equations (quaternion kinematics, Euler’s equations,
fin mixing, actuator lag) in the current TypeScript solver.

---

## 6. F3 data pack — public, paper and simulated values

Collected for the remaining gaps. Each block states **what it is**, the **numbers**, and **how far it
can be trusted**. None of this is SM-3 classified data; the useful items are open 6-DoF kill-vehicle
models, generic-missile wind-tunnel datasets and actuator/wind-tunnel technique papers.

### 6.1 DACS / divert thruster reference (open 6-DoF kill vehicle)

Source: Gaudet, Furfaro, Linares, Scorsoglio, *Reinforcement Meta-Learning for Interception of
Maneuvering Exoatmospheric Targets with Parasitic Attitude Loop*, arXiv:2004.09978 (2020). A fully
documented exo-atmospheric KV 6-DoF simulator — the closest open analogue to a SDACS/TDACS endgame.

| Parameter | Value | Notes |
| --- | --- | --- |
| KV geometry | cylinder h = 1.0 m, r = 0.25 m | body-axis x |
| Mass | 50 kg wet / 25 kg dry | fuel burn shifts CG and inertia |
| Inertia (wet) | Ixx = m·r²/2 = 1.56 kg·m²; Iyy = Izz = m(3r²+h²)/12 = 4.95 kg·m² | exact from their Eq. (1) |
| Divert thrusters | 4 × 5000 N | cruciform, on/off |
| ACS thrusters | 12 × 125 N | fired in pairs for torque |
| Switching | 25 Hz guidance, on/off | minimum divert impulse 200 N·s, ACS 5 N·s |
| CG shift / slosh | 5% CG shift, fuel slosh, time-varying inertia | explicitly modelled |
| Achieved miss | < 0.5 m requirement; Monte Carlo vs APN | 6-DoF with parasitic loops |

Derived and directly usable:

- Lateral divert authority: 2 × 5000 N = 10 kN → **20 g at 50 kg, 40 g at 25 kg** (two thrusters per plane).
- Divert ΔV budget: Isp 250 s → ΔV = 250·9.81·ln(50/25) ≈ **1 700 m/s** (≈1 900 m/s at Isp 280 s).
- **Consistency warning for this repo**: the current solver applies `divertMaxG = 30` to the recorded
  ~1 122 kg body, i.e. ≈330 kN — far above a real SDACS (≈10–20 kN). The physical endgame is the
  separated KW (~50 kg class). Either switch the terminal model to KW mass at separation, or scale
  divert to the actual thrust; see §6.7.

### 6.2 Interceptor mass / staging reference (paper, 6-DoF)

Source: 谢经纬, 陈万春, *大气层外拦截弹建模与攻防效能分析*, 北京航空航天大学学报 44(9):1826–1838,
2018, doi:10.13700/j.bh.1001-5965.2018.0095. A fully 6-DoF-modelled three-stage exo-atmospheric
interceptor with EKV release.

| Item | Value |
| --- | --- |
| Length / launch mass | 6.58 m / 2 313.2 kg |
| Stage 1 | 725.7 kg total, 577.8 kg propellant, 4 × 62.55 kN, 6 s (thrust-vector control) |
| Stage 2 | 1 134.0 kg total, dual-thrust, ~139 / 41 kN (table partly garbled in the HTML) |
| Stage 3 | 453.5 kg total, ~42 kN, ~10 s (dual-pulse), thrust-vector control |
| Control | stage 1/3 thrust vector, stage 2 aerodynamic fins; EKV released after burnout |

Use as a sanity check for stage mass fractions and the ~2 300 kg class; the SM-3 Block IB is
~1 500 kg, so scale accordingly. This paper also writes the standard body-axis 6-DoF equations (their
Eq. 1–3), useful for checking our sign conventions.

### 6.3 Aerodynamic validation datasets (public wind tunnel)

| Dataset | What it gives | Use |
| --- | --- | --- |
| NACA TM 1122, *Systematic Wind-Tunnel Measurements on Missiles* | CNα(M) for bodies/finsets, peak near M≈2 | trend / magnitude cross-check for our CNα(M) |
| NASA, *Experimental Investigation of the Aerodynamic Characteristics of a Ballistic-Type Missile* (NTRS 19930088169) | lift, drag, pitching moment, M 2.75–6.3, α 0–16° | full coefficient set in our Mach band |
| NASA, Hermes A-3B, M = 5.0 (NTRS 20090023659) | cp at 45.3% body length; lift slope 0.064/deg ≈ 3.67 /rad (body alone) | static-margin / CNα sanity check |
| Sooy & Schmidt, *Aerodynamic Predictions … Missile DATCOM (97) and AP98*, AIAA 2004-1246 | DATCOM vs wind tunnel: normal force < 9%, AP98 < 7%; pitching moment "effective" | uncertainty band if we generate tables with DATCOM |
| NASA, *Maneuver Performance of Interceptor Missiles* (NTRS 19710066790) | high-q endgame needs CN ≈ 2–3 (body-area reference) for ~30 g | **flags our CN as possibly low** |

**Actionable finding — CN may be ~2× low.** Our table gives CN(20°) ≈ 1.11 (Mach 8) →
≈5 g at the 626 kPa lock condition, while the record pulls ≈10 g. The NASA interceptor study says
CN ≈ 2–3 is the regime for high-g endgame manoeuvres. Re-fitting CN against the NACA/NASA datasets
is more defensible than leaning entirely on divert. Until then the divert allocation is doing work
the aero should do.

### 6.4 Hinge moment (for actuator sizing)

No open SM-3 fin hinge-moment table exists. The reproducible route:

- Definition `Ch = M_h / (q∞ · S_fin · c_fin)`, with `Ch = Chα·α + Chδ·δ + Ch_q·(q c/2V)`.
- Engineering estimate: `Chα ≈ −CNα_fin · (x_cp,fin − x_hinge) / c_fin`, `Chδ ≈ −CNδ_fin · (…)`,
  i.e. hinge moment is the fin normal force times the hinge-to-cp arm.
- Worked order of magnitude for our geometry (per fin, S_fin ≈ 0.16 m², c_fin ≈ 0.20 m, hinge-to-cp
  arm ≈ 0.05 m, q = 626 kPa, fin CN ≈ 0.5 at 10°): M_h ≈ 0.5 · 626 000 · 0.16 · 0.05 ≈ **2.5 kN·m**
  (≈0.2 kN·m at 1°) — the torque the fin actuator must hold.
- Measurement technique and uncertainty: 向立光 等, 《高超声速风洞铰链力矩试验技术研究进展》, 实验流体力学
  2022, 36(5):57–68, doi:10.11729/syltlx20210087 — Φ1 m 高超声速风洞, Mach 4–8, 总温 273–740 K,
  铰链力矩重复性优于 **1.5%**.
- Aeroelastic/hinge-moment tailoring: NASA NTRS 19890015798, *Static Aeroelastic Analysis and
  Tailoring of Missile Control Fins* (nonlinear supersonic load + hinge moment).
- Regulatory hinge-load formula for sizing checks: FAR 25.415 `H = K·V²·c·S` (limit hinge moment).

### 6.5 Servo / actuator (backlash, deadband, rate, delay)

| Parameter | Value | Source |
| --- | --- | --- |
| Travel / rate / delay | ±30°, 200 ± 50 °/s, 3 ± 1 ms | NASA CR, *High-Response Electromechanical Control Actuator* (1969) |
| Bandwidth | 8–20 Hz typical EMA/hydraulic | industry / actuator datasheets |
| Backlash / deadband | dead-zone in the position loop; 0.1° deadband ≈ 25% tracking-precision loss | Kpower servo application note (industrial claim); 空气舵执行机构非线性动力学建模 for gap + dry-friction model |
| Electric actuator with backlash | dead-zone model of the torque path, not a simple input offset | 《弹载电动舵机幂次滑模反演控制》, J. Beijing Inst. Technol. 2016 |

Recommended actuator model for F3: `δ_cmd → deadband(gap) → rate limit → second-order (ωn = 2π·10 Hz,
ζ = 0.7) → travel limit`, plus 5 ms transport delay. This is a small change to the existing
first-order servo in `sixdof.ts`.

### 6.6 Cross-validation and Monte Carlo

| Route | What it validates | Notes |
| --- | --- | --- |
| JSBSim (open 6-DoF FDM, tabular aero + rocket nozzle) | code-to-code: same aero tables and mass, compare terminal state | no ready missile model; build a minimal `<fdm_config>` with our tables |
| RocketPy (open 6-DoF, validated <1–2% apogee on real flights; LSODA, variable mass, Monte Carlo, ISA 1976) | ballistic/analytic comparison (G2) | best fit for the *no-control* ballistic gate, not a guided missile |
| C4dynamics `dof6sim` example (Python, PN-guided missile 6-DoF) | guidance/6-DoF code-to-code | small, readable reference implementation |
| Monte Carlo practice | miss-distance distribution / CEP | 300–500 runs typical; randomise initial state, aero ±10–15%, thrust ±5%, servo zero/gain, seeker noise; report mean, CEP(50%), 90% |

Uncertainty bands to use: CNα ±10%, CMα ±15%, damping derivatives ±25%, CNδ/CMδ ±10–20%, thrust ±5%,
inertia ±20% (estimate), servo gain ±10%, deadband 0–0.2°, delay 3–5 ms.

### 6.7 Recommended adoption order

1. **Decide the endgame vehicle**: separated KW (~50 kg class) vs the 1 122 kg third stage. This changes
   divert authority by ~17× and is the single biggest fidelity lever. (§6.1)
2. **Re-fit CN(M,α)** against NACA TM 1122 / the NASA ballistic-missile dataset, or scale the current
   table so CN(20°) ≈ 2 at Mach 8; re-run `validate_6dof.mjs`. (§6.3)
3. **Add hinge-moment load + a second-order servo with backlash/deadband**; the actuator then has a
   realistic torque/rate ceiling and the controller can saturate physically. (§6.4–6.5)
4. **Cross-check the ballistic branch in RocketPy** and the guided branch against JSBSim/C4dynamics. (§6.6)
5. **Run a 300–500-case Monte Carlo** with the bands above and publish mean/CEP/90%. (§6.6)

## 7. Additional sources (F3 data pack)

- Gaudet, Furfaro, Linares, Scorsoglio, *Reinforcement Meta-Learning for Interception of Maneuvering
  Exoatmospheric Targets with Parasitic Attitude Loop*, arXiv:2004.09978, 2020.
- 谢经纬, 陈万春, *大气层外拦截弹建模与攻防效能分析*, 北京航空航天大学学报, 2018, 44(9):1826–1838.
- 向立光, 舒海峰, 许晓斌, *高超声速风洞铰链力矩试验技术研究进展*, 实验流体力学, 2022, 36(5):57–68.
- 舒海峰 等, *空气舵执行机构非线性动力学建模与幅频特性预示* (gap / dry-friction model).
- Sooy T.J., Schmidt R.Z., *Aerodynamic Predictions, Comparisons, and Validations Using Missile
  DATCOM (97) and Aeroprediction 98 (AP98)*, AIAA 2004-1246.
- NASA NTRS 19930088169 (ballistic-type missile, M 2.75–6.3), 20090023659 (Hermes A-3B, M 5.0),
  19710066790 (interceptor maneuver, CN 2–3 for ~30 g), 19890015798 (fin aeroelastic/hinge moment),
  NACA TM 1122 (systematic missile wind-tunnel measurements).
- NASA CR, *High-Response Electromechanical Control Actuator* (1969): 200 ± 50 °/s, 3 ± 1 ms, ±30°.
- RocketPy (Ceotto et al., J. Aerospace Eng. 34(6), 2021, doi:10.1061/(ASCE)AS.1943-5525.0001331);
  C4dynamics `dof6sim`; JSBSim reference manual and rocket-nozzle element.
