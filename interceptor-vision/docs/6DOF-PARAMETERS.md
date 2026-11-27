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
