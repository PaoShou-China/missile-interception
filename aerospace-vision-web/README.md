# Aerospace Vision Web

Browser-native, scientifically grounded 3D replay and experiment comparison for the
[2000 km-class hypersonic interceptor](../README.md). It runs entirely from static files:
React 19 + Vite + Three.js + ECharts, no backend, no game engine, no plugins.

**Live:** https://paoshou-china.github.io/missile-interception/
· **3D Explorer:** https://paoshou-china.github.io/missile-interception/interceptor-vision/

## What the platform contains

| Route | Purpose |
| --- | --- |
| `#/` | Bilingual Beihang-style academic site: overview, method, results (incl. 25 Hz dual-mode `SensorAnalyticsCards` & B-Plane waterfall), verification, resources |
| `/interceptor-vision/` | Dedicated 3D tactical explorer (primary "Launch 3D Explorer" target): high-fidelity scramjet interceptor & F-35A meshes, GLSL shock cone & X-Ray force vectors, 25 Hz `SeekerOverlay`, `0.1×` bullet-time, live 6-DoF terminal solver |
| `#/compare` | **Experiment Configuration Studio**: configure A/B from the real registry, compare 3D trajectories + Monte-Carlo trajectory bundles & handover point clouds (`InstancedMesh`) |

The shipped nominal scenario is the verified 2026-11-28 payload converted directly from binary `telemetry.npz` (`53,673 × 152` float64 rows in `0.79 s`): **1,509 samples** over **680.47 s**, 1,652.1 km downrange, 29.84 km apogee, 632.5 kPa max dynamic pressure, 5.49 MW/m² peak heat flux, 2,282.1 K peak transient nose-cap wall temp, **1.48 m** closest approach, and **99.5%** proximity-fuze $P_k$. No pose animation is procedural; all motion comes from the telemetry arrays.

## Experiment Configuration Studio

Two panels (A and B), four dropdowns each:

1. **Guidance method** — Bezier / PIP midcourse × ZEM/APN / pure PN terminal, plus the
   fixed-rate boost programme.
2. **Attitude control** — scheduled three-loop with dead-time prediction and n_z loop;
   uncompensated; no n_z; classical fixed-gain PID.
3. **Vehicle configuration** — read-only audited profile (`lifting-body-2000`, v4):
   length, diameter, masses, fin semi-span, version and source. Only visual parameters
   (model scale, camera, playback rate) are adjustable.
4. **Scenario** — nominal, paired campaign case 0, paired 15 km case, synthetic UI demo.

Pressing **Compare** loads the matching record. Combinations without a record show
`No Available Experiment` and the button is disabled; results are never fabricated.
Swap A/B and “save selection reference” (localStorage + clipboard) are one click each.

The page contains:

- **3D**: side-by-side or overlay, shared camera reference, four presets, shared clock,
  Sun/Moon/day-night;
- **Charts**: altitude, speed, load and dynamic pressure for A/B; Δ(t) only when eligible;
- **Campaign aggregate table**: hit rate, median/P90/mean/max miss, handover range and
  specific energy, boost-end altitude/Mach, fin saturation, with deltas;
- **Single-run summary** and **condition table** (hash, commit, validation, issues).

The aggregate values come from `public/data/experiments/campaign.json` (a 4-case-per-law
quick campaign plus a 24-case architecture arm captured on 2026-11-21). The representative
case trajectories are separate real exports. The UI states this distinction explicitly.

## Cameras and environment

- Four cameras: **Earth**, **Chase**, **Intercept**, **Close-up**.
- The close-up merges the former fin/engine/attitude views: a three-quarter rear framing
  shows the four tail fins, nozzle/plume and body-axis triad in one shot; fins are driven
  by recorded deflections.
- Earth: WGS84 ellipsoid, bump-mapped day surface, additive ocean sun-glint shader,
  layered clouds, atmospheric limb and star field.
- The directional sun, sun/moon meshes and atmosphere all follow `skyStateAt(demoUtc,
  elapsedS)`; the epoch is declared in the payload and never alters trajectory data.
- Quality tiers control DPR, star count, Earth tessellation and bloom; High streams 8K
  day + 4K clouds and falls back to 2K on GPUs with a texture limit below 8192.

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
| Comparison | A/B may differ only in method; duration differences are results, not mismatches |

No altitude or trajectory exaggeration is applied. Target orientation is derived from its
ECEF velocity (the source has no target attitude) and labelled as derived.

## Quick start

```bash
cd aerospace-vision-web
npm ci
npm run dev          # http://localhost:5173
npm test             # Vitest: 66 unit/scientific tests
npm run build        # dist/
npm run preview      # serve dist/ on :4173
```

E2E:

```bash
npx playwright test --project=chromium
npx playwright test --project=webkit
```

On Windows without bundled Chromium, set `PW_CHANNEL=msedge` to use an installed Edge.

### Data pipeline

```
telemetry.npz (or .csv) ──► tools/data-adapter/build_scenario.py ──► scenario.json
                             (frames, units, 11 checks, provenance)       │
                                                                          ▼
   src/scientific (types, geodesy, quaternion, interpolate, clock, attitude)
   src/state      (one SimulationClock + throttled ~8 Hz Zustand mirror)
   src/scene      (Earth, atmosphere, stars, Sun/Moon, InstancedMesh vehicles, GLSL AeroPhysicsField)
   src/components (25 Hz SensorAnalyticsCards, zero-rerender useRef Timeline, charts, camera dock)
   src/compare    (registry, manifest, matching, charts, Monte-Carlo 3D bundles & point clouds)
   src/pages      (academic pages, compare studio)
```

Regenerate and verify the explorer payload (`< 1 s` from `.npz`):

```bash
python tools/data-adapter/build_scenario.py
python tools/data-adapter/verify_scenario.py
```

Export one paired campaign case with full telemetry (for a new B record):

```bash
cd ../missile_intercept
python tools/export_campaign_case.py --law bezier_zem_apn \
  --boost-law feasible --control-law scheduled \
  --out output/experiments/example
```

## Validation and current status (2026-11-28)

```
$ npm test                          66 passed (9 files)
$ npm run build                     PASS (tsc -b && vite build)
$ python verify_scenario.py         11/11 PASS (miss 1.482 m @ 680.47 s, quat err 7.79e-10)
$ playwright chromium               16 passed, 60.2 FPS (Intel UHD, D3D11)
$ playwright webkit                 camera/comparison suites pass; FPS gate is Chromium-only
```

**Truthful limits**

- The nominal single-shot payload (`1.48 m` miss, 152 columns) and the 48-case envelope matrix (`6/6 PASS, 93.8%`) are verified; newer A/B comparison runs pass payload-integrity checks but have **NOT RUN** independent scientific validation.
- The web campaign is a quick 4-case-per-law capture plus a 24-case architecture arm; it is
  not a full-factorial campaign and not a basis for statistical superiority claims.
- The synthetic demo is labelled “not a scientific result” and excluded from all claims.
- Mobile is verified for layout and readability at 390×844, not GPU performance parity.

See [ACCEPTANCE](docs/ACCEPTANCE.md), [COMPARISON](docs/COMPARISON.md) and
[VALIDATION_STATUS](docs/scientific/VALIDATION_STATUS.md).

## Narrow-screen behaviour

At ≤720 px the configuration panels stack, dropdowns use 14–15 px text with ellipsis,
action buttons reach 44 px, the A/B 3D panes each keep 38–42 vh (instead of half of a
fixed 560 px stage), chart axis text grows to 11.5 px with overlap hiding, and wide tables
scroll inside their own section with a swipe hint. E2E asserts the page itself never
overflows horizontally.

## Deployment

`.github/workflows/aerospace-vision-pages.yml` builds both `aerospace-vision-web/` and
`interceptor-vision/` and publishes them to GitHub Pages (legacy static HTML reports were
removed in v0.3.0). Enable **Pages → GitHub Actions**. Vite uses a relative base, so
project-path hosting needs no configuration.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Comparison policy and registry](docs/COMPARISON.md)
- [Acceptance log](docs/ACCEPTANCE.md)
- [Scientific notes](docs/SCIENTIFIC_NOTES.md)
- [Data audit](docs/scientific/DATA_AUDIT.md) ·
  [provenance](docs/scientific/RESULT_PROVENANCE.md) ·
  [validation status](docs/scientific/VALIDATION_STATUS.md)
- [Project README](../README.md) · [Technical report](../TECHNICAL_REPORT.md)

## Assets and licensing

- Earth day/cloud textures: NASA Blue Marble-derived imagery (public domain), shipped
  locally so the site works offline and on Pages.
- Vehicle meshes: procedural geometry authored in this repository.
- Scenario data: derived from the MIT-licensed source repository; telemetry SHA-256 and
  provenance are embedded in each manifest.
