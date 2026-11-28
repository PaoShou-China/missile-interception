<div align="center">
  <img src="assets/hero.jpg" alt="Cinematic render: hypersonic interceptor with cruciform tail fins and strake wings above Earth's limb" width="100%">
</div>

<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Project icon"></p>

<h1 align="center">2000 km-class Hypersonic Interceptor</h1>
<h3 align="center">6DOF simulation · experiment comparison · browser-native 3D replay</h3>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-4da3ff?style=flat-square&labelColor=0b1b2b" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/python-3.9%2B-4da3ff?style=flat-square&labelColor=0b1b2b" alt="Python 3.9+">
  <img src="https://img.shields.io/badge/node-20%2B-4da3ff?style=flat-square&labelColor=0b1b2b" alt="Node 20+">
  <img src="https://img.shields.io/badge/solver-6DOF%20%C2%B7%205%20ms-30b0c7?style=flat-square&labelColor=0b1b2b" alt="6DOF, 5 ms step">
  <a href="https://paoshou-china.github.io/missile-interception/"><img src="https://img.shields.io/badge/platform-online-30b0c7?style=flat-square&labelColor=0b1b2b" alt="Online platform"></a>
</p>

<p align="center">
  A modular, testable flight-dynamics simulation of a 2000 km-class lifting-body interceptor,
  plus <b>Aerospace Vision Web</b> — a static React/Three.js platform that replays the
  telemetry, compares real experiment records, and never re-simulates in the browser.
</p>

---

> **Disclaimer** — Public data for a 2000 km-class interceptor are scarce. Geometry, mass,
> inertia, aerodynamic and propulsion parameters in `config.py` are an **engineering
> extrapolation** from public sources plus generic hypersonic-vehicle characteristics.
> They serve algorithm, software and architecture verification only, and do not represent
> measured data or the performance of any fielded system.

## What is in this repository

| Part | Purpose |
| --- | --- |
| **`missile_intercept/`** | Python/NumPy/Numba 6DOF simulator: vertical cold launch, discrete Stage-1 separation, scramjet propulsion (with stoichiometric capture & Unstart hysteresis), 1D transient TPS, dual-mode X-band radar + MWIR seeker, flare/chaff countermeasures, 3-model IMM tracker, 2nd-order hinge-moment fin servos, proximity fuze lethality, and parallel Monte-Carlo / validation campaigns |
| **`aerospace-vision-web/`** | React 19 + Vite + Three.js + ECharts platform: bilingual academic site, 3D orbital/close-up replay with GLSL shock cone / blackbody heat / X-Ray force vectors, dual-mode sensor analytics, and **Experiment Configuration Studio** (`#/compare`) with Monte-Carlo 3D trajectory bundles |
| **`interceptor-vision/`** | Dedicated Three.js + Blender 3D tactical explorer (the site's primary 3D entry): high-fidelity scramjet interceptor & F-35A meshes, GLSL Mach-diamond plumes, real-time 25 Hz radar R-D / MWIR / RCS polar / B-Plane waterfall `SeekerOverlay`, X-Ray physics overlay, semantic event timeline + `0.1×` bullet-time, and in-browser 6-DoF terminal solver |
| **`docs/experiments/`** | Paired Monte-Carlo campaigns: guidance-law, boost-law, attitude-control and architecture comparisons |

### Aerospace Vision Web at a glance

- **Four cameras**: Earth overview, chase, intercept framing, and one merged **close-up** that
  shows tail fins, nozzle/plume, GLSL shock cone, blackbody nose-cap heating, and 3D X-Ray force vectors + live CG/CP markers.
- **Real telemetry only**: **1,509 samples** over **680.47 s** (1,652.1 km downrange, 29.84 km apogee, 632.5 kPa max q, 5.49 MW/m² peak heat flux, 2,282 K transient wall temp, **1.48 m** miss, **99.5%** proximity-fuze $P_k$) converted directly from binary `telemetry.npz` (`53,673 × 152` float64 rows); no procedural pose and no altitude exaggeration.
- **Experiment Configuration Studio** (`#/compare`): choose Guidance / Attitude control /
  Vehicle / Scenario for A and B, press Compare, and load only real records alongside 3D Monte-Carlo trajectory bundles & handover point clouds (`InstancedMesh`). Unsupported
  combinations show `No Available Experiment`; nothing is fabricated.
- **Semantic event timeline & `0.1×` bullet-time**: clickable anchors for booster separation, max dynamic pressure, inlet unstart, decoy ejection, handover and intercept, plus shareable `?t=&view=&compare=` deep links.
- **Paired campaign statistics**: hit rate, median/P90/max miss, handover range/energy,
  boost-end state and fin saturation, with deltas only when definitions and conditions match.
- **Earth realism**: bump-mapped WGS84 surface, ocean sun-glint shader, layered clouds,
  atmosphere limb, Sun/Moon/day-night all driven by the same astronomical epoch.
- **Bilingual (zh/en), desktop-first and small-screen readable**: 390 px layout keeps
  14–15 px dropdown text, 44 px controls, 38–42 vh stacked 3D panes and scroll-contained tables.
- **Static deployment**: GitHub Pages, no backend.

**Live platform:** https://paoshou-china.github.io/missile-interception/
· **3D Explorer:** https://paoshou-china.github.io/missile-interception/interceptor-vision/

## Guidance, control and comparison matrix

The simulator exposes real switchable laws; the web Studio lists exactly the combinations
that have records.

| Stage | Implemented options | Source |
| --- | --- | --- |
| Boost | feasibility-shaped gravity turn; classical fixed-rate programme | `guidance/boost_guidance.py`, `guidance/fixed_rate_boost_guidance.py` |
| Midcourse | cubic Bezier shaping; predicted-intercept-point (PIP) direct guidance | `guidance/midcourse_guidance.py`, `guidance/pip_midcourse_guidance.py` |
| Terminal | ZEM/APN; classical pure PN | `guidance/terminal_guidance.py`, `guidance/pure_pn_guidance.py` |
| Attitude control | scheduled three-loop (dead-time prediction + n_z loop); uncompensated; no n_z; classical fixed-gain PID | `control/autopilot.py`, `control/classic_autopilot.py`, `config.py` switches |
| Vehicle | one audited `lifting-body-2000` profile (v4) | `config.py` |

Web registry entries with shipped representative trajectories:

| Guidance | Control | Scenario | Record |
| --- | --- | --- | --- |
| Bezier + ZEM/APN | scheduled | paired case 0 | `exp-campaign-bezier-zem` |
| PIP + ZEM/APN | scheduled | paired case 0 | `exp-campaign-pip-zem` |
| Bezier + pure PN | scheduled | paired case 0 | `exp-campaign-bezier-pn` |
| fixed-rate boost | scheduled | target 15 km | `exp-campaign-fixedrate` |
| Bezier + ZEM/APN | classical PID | paired case 0 | `exp-campaign-classic-pid` |
| fixed-rate boost | classical PID | paired case 0 | `exp-campaign-classic-full` |
| Bezier + ZEM/APN | uncompensated / no-n_z | nominal | `exp-*` isolation records |

The shipped aggregate statistics live in
[`aerospace-vision-web/public/data/experiments/campaign.json`](aerospace-vision-web/public/data/experiments/campaign.json):
a 4-case-per-law quick campaign captured on 2026-11-21 plus a 24-case architecture arm.
The offline driver `missile_intercept/tools/guidance_comparison.py` can rerun larger
campaigns; its output changes when rerun, while the web copy is explicit and frozen.

## Online entry points

| Entry | Contents | Link |
| --- | --- | --- |
| **Aerospace Vision platform** | Bilingual academic site, results/sensor analytics, **Experiment Configuration Studio** (`#/compare`) | [Open →](https://paoshou-china.github.io/missile-interception/) |
| **Interceptor Vision (3D Explorer)** | Tactical 3D replay, GLSL shock cone / X-Ray vectors, 25 Hz dual-mode `SeekerOverlay`, live 6-DoF terminal solver | [Open →](https://paoshou-china.github.io/missile-interception/interceptor-vision/) |

## Repository layout

```
.
├── missile_intercept/            # Python/Numba 6DOF simulator
│   ├── main.py                   # single run; --csv / --no-adaptive-step / law switches
│   ├── fastcore.py               # nogil Numba kernels (fused RK4, 3-model IMM, aero, servos)
│   ├── batch.py                  # Monte-Carlo campaigns (multiprocess & --threads)
│   ├── validate_performance.py   # 48-case 6-suite envelope validation matrix
│   ├── config.py                 # all parameters and comparison switches
│   ├── guidance/                 # boost, Bezier/PIP midcourse, ZEM/APN, pure PN, handover
│   ├── control/                  # scheduled autopilot, classic PID, 2nd-order fin mixer, thrust
│   ├── sensors/                  # IMU, 12-state GNSS/INS, dual-mode seeker, 3-model IMM tracker
│   ├── vehicle/                  # atmosphere, hypersonic aero/TPS, scramjet, target, warhead/fuze, wind
│   ├── tools/                    # DATCOM, miss_budget ablation, UQ, tuning, comparison campaigns
│   └── tests/                    # 103 pytest checks (incl. Python/Numba 1e-11 isomorphism)
├── aerospace-vision-web/         # React 19 + Three.js + ECharts academic portal & Compare Studio
│   ├── src/                      # scientific, scene, state, components, compare, pages
│   ├── public/data/              # explorer payload, experiment registry, campaign stats
│   ├── tools/data-adapter/       # NPZ/CSV -> scenario.json builder + 11-check validator
│   ├── tests/                    # 66 Vitest unit + Playwright E2E
│   └── docs/                     # architecture, comparison, acceptance, scientific status
├── interceptor-vision/           # Three.js + Blender 3D tactical explorer & 6-DoF terminal solver
├── docs/experiments/             # generated campaigns and reports (CSV/JSON/MD/PNG)
├── assets/                       # README figures
├── TECHNICAL_REPORT.md           # Chinese technical report (subsystems, equations, benchmarks)
└── CHANGELOG.md                  # release history
```

## Quick start

### Simulation

```bash
cd missile_intercept
python -m pip install -r requirements.txt

python main.py                                    # nominal run -> telemetry.npz + 12-panel HTML (~52 s)
python main.py --csv                              # also export telemetry.csv
python validate_performance.py --workers 12 --no-plot   # 48-case 6-suite envelope matrix (~200 s)
python tools/miss_budget.py --quick --workers 6   # error-budget ablation (~48 s)

# Comparison switches
python main.py --boost-law fixed_rate --control-law classic_pid --no-plot
python main.py --midcourse-law pip_pn --terminal-law pn --no-plot

# Monte-Carlo & paired comparison campaigns
python batch.py --cases 24 --workers 8 --seed 2026
python tools/guidance_comparison.py --cases 24 --seed 2026
python tools/architecture_comparison.py --cases 24 --seed 2026
```

Outputs go to `missile_intercept/output/` and are intentionally untracked.

### Web platform

```bash
cd aerospace-vision-web
npm ci
npm run dev        # http://localhost:5173
npm test           # Vitest: 66 unit/scientific tests
npm run build      # production bundle in dist/
npm run preview    # serve dist/ on :4173
```

Regenerate and verify the explorer payload from binary `telemetry.npz` (takes `< 1 s`):

```bash
python aerospace-vision-web/tools/data-adapter/build_scenario.py
python aerospace-vision-web/tools/data-adapter/verify_scenario.py
```

Export one paired campaign case with full telemetry (for a new B record):

```bash
cd missile_intercept
python tools/export_campaign_case.py --law bezier_zem_apn --out output/experiments/example
```

## Verification snapshot (2026-11-28)

| Area | Result |
| --- | --- |
| Backend 6DOF & Python/Numba isomorphism (`missile_intercept`, pytest) | **103 passed** |
| Root provenance/traceability tests (`tests/`, pytest) | **36 passed** |
| 48-case performance envelope matrix (`validate_performance.py`, 12 workers) | **6/6 suites PASS (45/48 = 93.8 %, 200.3 s)** |
| Nominal 6DOF intercept (`main.py`, 152-col `.npz`) | **1.48 m** miss @ 680.47 s (`Pk(fuze) = 99.5 %`) |
| Scenario data contract (`verify_scenario.py`) | **11/11 PASS** (float64 quaternion err `6.19e-12`) |
| Web unit/scientific (`aerospace-vision-web`, Vitest) | **66 passed** (9 files) + production build PASS |
| 3D explorer validators (`interceptor-vision`) | **28/28 aero**, **12/12 6-DoF** + production build PASS |
| Chromium E2E / narrow screen | 16 passed, 60.2 FPS on Intel UHD; 390×844 verified |

What is **not** claimed: independent scientific validation of every new law, a full-factorial
campaign, statistical equivalence between campaigns, or mobile GPU performance parity.
See [VALIDATION_STATUS](aerospace-vision-web/docs/scientific/VALIDATION_STATUS.md) and
[COMPARISON](aerospace-vision-web/docs/COMPARISON.md) for the exact NOT RUN list.

## Scientific conventions

| Quantity | Convention |
| --- | --- |
| Render frame | WGS84 ECEF, right-handed, kilometres in the renderer |
| Source frame | ECI; `ECI == ECEF` at t = 0; `r_ECEF = Rz(−ωt) r_ECI` |
| Attitude | scalar-first `[w,x,y,z]`, Hamilton product, `BODY → ECEF` |
| Body axes | +x nose, +y right, +z down |
| Time | seconds since launch, monotonic; one shared clock |
| Position interpolation | cubic Hermite with telemetry velocity tangents |
| Attitude interpolation | shortest-arc SLERP, renormalised |
| Speed shown | Earth-relative `|v_ECEF|`; Mach is wind-corrected |

No altitude or trajectory exaggeration is applied. The vehicle mesh is built at its physical
size; a distance-scaled glow marker keeps it findable at orbital zoom without moving it.

## Documentation

- [Technical report (Chinese, subsystems, equations, references)](TECHNICAL_REPORT.md)
- [Simulation technical reference](missile_intercept/README.md) · [English edition](missile_intercept/README.en.md)
- [Web architecture](aerospace-vision-web/docs/ARCHITECTURE.md)
- [Experiment comparison policy and registry](aerospace-vision-web/docs/COMPARISON.md)
- [Acceptance log](aerospace-vision-web/docs/ACCEPTANCE.md)
- [Scientific audit](aerospace-vision-web/docs/scientific/DATA_AUDIT.md) ·
  [provenance](aerospace-vision-web/docs/scientific/RESULT_PROVENANCE.md) ·
  [validation status](aerospace-vision-web/docs/scientific/VALIDATION_STATUS.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Requirements

- **Python** 3.9+ (Windows/Linux). `numba` accelerates hot paths; without it the solver
  falls back to pure Python with identical results but slower.
- **Node** 20+ for the web platform.
- The DATCOM binary under `missile_intercept/tools/datcom/` is third-party and not versioned.

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center"><sub>Engineering-extrapolated model — for algorithm and software verification only.</sub></p>
