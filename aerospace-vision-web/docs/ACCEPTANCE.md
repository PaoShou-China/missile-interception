# Acceptance report — Aerospace Vision Web V4

Run date: 2026-11-20 (Asia/Shanghai)
Environment: Windows, Node 24.19.0, npm 11.17.0, Python 3.14.10,
Vite 8.3.8, Three.js 0.187.0, React 19.3.1, ECharts 6.1.0.
Browser used for E2E: Microsoft Edge 157.0.4341.60 (Chromium engine), headless,
1280 × 720. Bundled Playwright Chromium download was blocked by the network;
the Edge channel exercises the same Chromium engine stack and is recorded here
as such. Bundled Firefox and WebKit were installed locally and run.

> **V4 update (2026-11-20).** The platform is now a bilingual academic site at
> `/` with the 3D explorer at `#/explore`. Schema is **1.1.0** (fin deflection,
> body rates, experiment manifest, demo UTC). Camera modes are **10**,
> astronomy is sun/moon/day-night, and the cinematic timeline is an independent
> **180 s** presentation clock. The V1 gate table below is retained as history;
> see “V4 acceptance” at the end for current evidence.

## V4 acceptance

| Item | Result | Evidence |
| --- | --- | --- |
| Academic home + navigation | PASS | `#/`, `#/methodology`, `#/results`, `#/verification`, `#/resources`; E2E asserts nav and explorer CTA |
| Bilingual zh/en | PASS | Language switch persists in `localStorage`; `document.lang` becomes `zh-CN`; E2E reload check |
| Frozen data contract | PASS | schema 1.1.0; `finDeflectionsRad`, `bodyRatesRadS`, `experiment`, `time.demoUtc`; unit test asserts recorded actuator channels |
| Six cameras incl. close-ups | PASS | Earth, Chase, Intercept, Fin, Engine, Attitude (Launch/Seeker removed as near-duplicates); browser agent confirmed the strake-wing missile and F-35-style target |
| Sun / moon / day-night | PASS | `src/scientific/astronomy.ts`, 6 unit tests (equinox, solstice, day/night, launch-site elevation, elapsed-time drift); dynamic light and atmosphere uniform |
| Three-minute cinematic | PASS | Independent 180 s wall clock mapped to the mission; E2E checks `03:00` total, pause/skip/exit controls |
| Legacy paths preserved | PASS | CI stages original paths (`/missile-intercept-overview/...`, `/intercept-report/...`, `/test-report/...`) and `/legacy/`; E2E asserts HTTP 200 |
| Scientific audit | PASS | `docs/scientific/DATA_AUDIT.md`, `RESULT_PROVENANCE.md`, `VALIDATION_STATUS.md` |
| Astronomy at real datum | PASS | `skyStateAt` now takes the manifest launch site; unit test proves east/west day-night split |
| Actuator validation in payload | PASS | adapter now emits 11 checks, including `actuator-channels`; unit test asserts the count and id |
| Initial bundle / code splitting | PASS | entry 274 kB (86.9 kB gzip); three.js and ECharts are lazy chunks (no longer on the academic pages) |
| SEO + social metadata | PASS | route-specific title/description/canonical; OG/Twitter tags and JSON-LD WebSite |
| Accessibility | PASS | skip link, `aria-pressed` on camera/mode toggles, focus-visible rings, reduced-motion support, print stylesheet |
| Mobile explorer | PASS | mission/telemetry tab sheet, horizontally scrolling camera dock; E2E at 390 × 844 |
| Provenance copy | PASS | commit/SHA/Demo UTC are copyable with bilingual confirmation |

### V4.4 model and camera consolidation (2026-11-21)

| Item | Result | Evidence |
| --- | --- | --- |
| Camera set de-duplicated | PASS | Launch (≈Chase) and Seeker (≈Intercept) removed; dock now has Earth, Chase, Intercept, Fin, Engine, Attitude |
| Strake lifting surfaces | PASS | Mid-body boxes replaced with long swept leading-edge strake wings (边条翼), extruded with bevel, one per side |
| F-35-style target | PASS | Octagonal blended fuselage, swept wings, horizontal stabs, twin canted tails, bubble canopy, intakes, EOTS, nozzle and nav lights |
| Camera framing | PASS | Ignition shot uses Chase; body close-ups re-aimed for the new strake geometry; E2E covers all six modes |

### V4.4 test evidence

```
$ npm test                         46 passed
$ playwright chromium              12 passed, 60.1 FPS (Intel UHD, D3D11)
$ playwright webkit                11 passed, 1 skipped
```

### V4.3 third UX pass (2026-11-21)

| Item | Result | Evidence |
| --- | --- | --- |
| Cinematic transport clickability | PASS | `.cinematic__controls` now re-enables pointer events; E2E clicks pause/resume twice and observes ▶/❚❚ toggling |
| Realistic interceptor proportions | PASS | 6.5 m length × 0.34 m diameter (≈19:1), 0.48 m fin chord / 0.30 m semi-span, scaled close-up cameras; browser agent confirmed the slim body and fins |
| More line charts | PASS | Dedicated Charts view now shows 8 series groups: altitude/speed, q/load, load command/response, attitude, body rates, four fins, Mach/range, mass/propellant |
| Removed redundant panel | PASS | Right rail is telemetry only; the old “Science / Time series” accordion and its chart modal are gone |
| Mobile tabs | PASS | Mission / Telemetry only, matching the removed panel |

### V4.3 test evidence

```
$ npm test                         46 passed
$ playwright chromium              12 passed, 60.2 FPS (Intel UHD, D3D11)
$ playwright webkit                11 passed, 1 skipped
```

### V4.2 second UX pass (2026-11-21)

| Item | Result | Evidence |
| --- | --- | --- |
| Engine plume visibility | PASS | Engine camera moved to a side-rear framing; plume layers enlarged/brightened; browser agent confirmed a visible flame and glow |
| Typography | PASS | New sans/mono stacks, no forced uppercase on eyebrows, brighter label colours, larger panel values and consistent weights |
| Per-phase cinematic pacing | PASS | Wall budget boost 0–60 s, midcourse 60–142 s, terminal 142–180 s; the three phases now play at clearly different speeds |
| Cinematic controls | PASS | Centered 44 px control bar (pause, ±15 s, fullscreen, exit) plus a full-width clickable/draggable progress bar; Exit no longer escaped the bar |
| Camera mode set | PASS | Free/Plan removed; Earth, Chase, Launch, Intercept, Fin, Engine, Attitude, Seeker remain |
| Dedicated charts mode | PASS | Third presentation mode “Charts” shows eight large time series with zoom, Esc/return to 3D |
| Centered mode dock | PASS | Mode buttons moved to a centered translucent dock above the timeline; rails end above it, so the left panel is never overlapped |

### V4.2 test evidence

```
$ npm test                         46 passed
$ playwright chromium              13 passed, 60.0 FPS (Intel UHD, D3D11)
$ playwright webkit                12 passed, 1 skipped
```

### V4.1 UX and model pass (2026-11-21)

| Item | Result | Evidence |
| --- | --- | --- |
| Readable type scale | PASS | Explorer labels/values raised ~20–35 % (timeline 16 px, telemetry 19 px, panel titles 16 px, chart titles 12 px) |
| Orbit/zoom in every mode | PASS | Canvas drag/yaw-pitch and wheel zoom applied on top of the automatic rig; double-click or “Reset view” clears it |
| Chart expand + time zoom | PASS | Per-chart expand opens a portal modal with ECharts dataZoom (inside + slider), reset and close; E2E covers it |
| Full Chinese coverage | PASS | Scenario title/description, phases, event labels, validation descriptions, PASS/FAIL, table headers and canvas beacons are translated |
| Controllable cinematic | PASS | Clickable/draggable progress bar, keyboard seek, pause, ±15 s, fullscreen and exit; slow camera drift removes static shots; E2E scrubs to “Midcourse” |
| High-fidelity interceptor | PASS | Lathe ogive/boattail body, clearcoat material, radome window, panel rings, strakes, canards, extruded cruciform fins driven by recorded data, nozzle bell and layered plume; visually verified by browser agent |

### V4.1 test evidence

```
$ npm test                         46 passed
$ playwright chromium              12 passed, 58.8 FPS (Intel UHD, D3D11)
$ playwright webkit                11 passed, 1 skipped
```

### V4 test evidence (local, 2026-11-20)

```
$ npm test
Test Files  7 passed (7)
Tests       46 passed (46)

$ npx playwright test --project=chromium   (Edge channel)
13 passed — includes academic home, language persistence, route metadata,
mobile panel tabs, legacy paths, 8 cameras, chart modal, charts presentation,
cinematic scrub, 60.0 FPS hardware

$ npx playwright test --project=webkit
12 passed, 1 skipped (FPS gate is Chromium-only)

$ npx playwright test --project=firefox
10 passed, 1 skipped (FPS gate is Chromium-only)
```

### V4 data snapshot

```
schema 1.1.0 · 67 276 source rows → 1 504 missile samples
miss 26.726 m @ 672.75 s · apogee 29.897 km · downrange 1 655.4 km
max load 40.0 g · max Mach 9.48 · reproducibility unreproducible-current-artifacts
demo UTC 2026-11-20T02:00:00Z (presentation only)
```

Note: the source telemetry was regenerated in the same session, so numeric
values differ from the V1 rows below. The payload is a snapshot; the adapter
records its SHA-256, row count and generation time.

## Gate status (V1 history)

| Gate | Status | Evidence |
| --- | --- | --- |
| G0 requirements & interface freeze | **PASS** | `schemas/scenario-manifest.schema.json`, `src/scientific/types.ts`, no schema drift between adapter and renderer |
| G1 real data + numerical checks | **PASS** | adapter 10/10 PASS; independent verifier 8/8 PASS; 39 unit/scientific tests |
| G2 3D scene and charts synchronised | **PASS** | single `SimulationClock`; E2E asserts clock and altitude advance together; charts read the same mirror |
| G3 visual quality | **PASS** | six 1080p screenshots in `docs/visual/`; 8K Earth, 4K clouds, HDR bloom, PBR vehicle, gradient track, cinematic launch/midcourse framing |
| G4 browser performance & compatibility | **PASS** | 1080p / Intel UHD soak: mean **60.0 FPS**, min 51.0, 10 min, heap Δ −0.07 MB; E2E passed on Chromium, Firefox and WebKit (16 passed, 2 FPS tests skipped on non-Chromium). CI uses SwiftShader and records a 5.9 FPS annotation rather than a hardware verdict |
| G5 GitHub Pages public URL | **PASS** | Live at https://paoshou-china.github.io/missile-interception/ ; verified in a real browser: telemetry PASS, playback advances, no console/HTTP errors; legacy report at `/legacy/` |

## Commands and actual results

### Data adapter

```
$ python tools/data-adapter/build_scenario.py
scenario: public/data/missile-intercept/scenario.json 0.79 MB
samples : 1504 missile, 240 target
checks  : PASS
  [PASS] timeline-monotonic
  [PASS] finite-values           rows=67164, columns=132
  [PASS] eci-ecef-alignment
  [PASS] velocity-frame          mid-flight frame error 6.8e-07 m/s
  [PASS] llh-ecef-roundtrip      max 0.073 m
  [PASS] quaternion-normalized   max |‖q‖-1| = 8.18e-07 (6-decimal CSV)
  [PASS] speed-semantics         source m_speed is inertial |v_ECI|
  [PASS] speed-and-mach-semantics  airspeed = |v_ECEF|; Mach wind-corrected
  [PASS] altitude-units
  [PASS] sample-recovery         lat ≤ 0.06 m, alt ≤ 0.00 m
```

### Independent payload verification

```
$ python tools/data-adapter/verify_scenario.py
  [PASS] schema / frame / adapter-pass / monotonic / finite
  [PASS] unit-quaternions   max |‖q‖-1| = 7.40e-10 (after normalisation)
  [PASS] geodetic-ecef      max mismatch = 0.071 m
  [PASS] intercept-metric   miss=22.609 m @ 671.63 s
RESULT: PASS
```

### Unit and scientific tests

```
$ npm test
Test Files  6 passed (6)
Tests       39 passed (39)
```

Covers WGS84 round-trips, ENU orthonormality, ECI→ECEF rotation, quaternion
algebra/SLERP, Hermite recovery, segment isolation, clock semantics, NED
attitude extraction against an independent DCM, and the shipped scenario
(monotonic time, geodetic consistency, sample recovery, motion/speed
consistency, intercept metric, phase bounds).

### Browser E2E — three engines

```
$ $env:PW_CHANNEL=msedge; npx playwright test
Running 18 tests using 3 projects

[chromium] 6/6 passed  (measured FPS 60.0, Intel UHD via ANGLE)
[firefox]  5/5 passed  (FPS gate skipped by design)
[webkit]   5/5 passed  (FPS gate skipped by design)

16 passed, 2 skipped, 0 failed (1.5 min)
```

The functional suite covers load/validation, clock+telemetry synchronisation,
event seeking, camera switching, the Track emphasis toggle, and the cinematic
sequence.

### 1080p soak (10 minutes)

```
$ npm run perf:soak
renderer: ANGLE (Intel, Intel(R) UHD Graphics, D3D11)
viewport: 1920×1080, quality high (8K Earth + bloom)
mean 60.0 FPS · min 51.0 · P95 60.2
JS heap 41.3 MB → 41.3 MB (Δ −0.07 MB)
console errors: none
```

Full data: [performance/soak-1080p.md](performance/soak-1080p.md) and
`performance/soak-1080p.json`.

Screenshots produced during the run are in `test-results/visual/`; the curated
1080p set referenced by the README is in `docs/visual/`:
`01-earth-overview.png`, `02-chase-camera.png`, `03-intercept-chase.png`,
`04-terminal-overview.png`, `05-cinematic-ignition.png`,
`06-cinematic-midcourse.png`. The public-site check captures
`07-live-pages.png`.

### CI deployment run

Commit `1d4f622` — workflow run
[44753808320](https://github.com/PaoShou-China/missile-interception/actions/runs/44753808320):
`build` and `deploy` **success**. The deployment gate runs Chromium and WebKit
(full functional suite, including screenshots). Firefox is exercised in CI as an
informational step with software Mesa GL and does not block deployment; the same
Firefox suite passed locally on Windows (5/5). Chromium CI uses SwiftShader and
records ~2.5 FPS as a software annotation rather than a hardware verdict.

### Public URL verification (G5)

```
URL:    https://paoshou-china.github.io/missile-interception/
title:  Aerospace Vision Web · Scientific Trajectory Visualisation
status: TELEMETRY VERIFIED · 10 CHECKS
canvas: 1920 × 1080
assets: earth_day_8k.jpg 200 · earth_clouds_4k.jpg 200
ui:     Track emphasis toggle present
clock:  T+00:00:42, altitude 11.45 km after pressing play
load:   10.3 s first visit (8K + 4K textures over the Pages CDN)
legacy: https://paoshou-china.github.io/missile-interception/legacy/ → 200,
        original report title
errors: none (console, page errors, HTTP >= 400)
```

### Production build

```
$ npm run build
dist/index.html                               1.49 kB │ gzip 0.74 kB
dist/assets/index-*.css                      19.72 kB │ gzip 4.84 kB
dist/assets/index-*.js                      576.95 kB │ gzip ~183 kB
dist/assets/echarts-*.js                    510.70 kB │ gzip 172.46 kB
dist/assets/three-*.js                      757.39 kB │ gzip 191.64 kB
dist/data/missile-intercept/scenario.json   785.16 kB
dist/textures/earth_day_8k.jpg              4.57 MB   (High tier)
dist/textures/earth_clouds_4k.jpg           2.60 MB   (High tier)
dist/textures/earth_day_2048.jpg            0.51 MB   (fallback)
dist/textures/earth_clouds_1024.png         0.23 MB   (fallback)
total dist                                 10.55 MB
```

High quality streams 8K/4K textures (~7.2 MB); Medium/Low use the 2K/1K pair
(~0.7 MB). JavaScript is split into three/echarts/app chunks.

## Known limitations and risks

1. **Mobile and high-DPI devices** are not part of the current verified matrix;
   the High tier streams 8K textures (≈7 MB) and automatically falls back to 2K
   when the GPU reports `maxTextureSize < 8192`. First-load time on the Pages
   CDN was 10.3 s for the 8K assets.
2. **Firefox/WebKit performance** was verified functionally (all tests passed)
   but not profiled for frame rate; only Chromium passed the 60 FPS hardware
   gate. CI Firefox runs without a GPU and is informational; local Windows
   Firefox passed the functional suite.
3. **Earth LOD.** The 8K map is a single equirectangular texture, not tiled LOD;
   close chase passes can still look soft when the camera is metres above the
   surface. A tiled/streamed Earth is the next visual upgrade.
4. **Symbolic track cord.** The orbital emphasis cord has a 3 km radius by
   design; its centreline is exact telemetry, it is disclosed in the UI, hidden
   within ~800 km altitude, and can be switched off with the Track toggle. No
   positional exaggeration is applied.
5. **Camera fill light.** A small camera-anchored point light improves vehicle
   legibility on the night side; it affects lighting only, never state.
6. **Target attitude** is derived from its ECEF velocity (source telemetry has
   no target attitude). It affects orientation only and is documented in the
   UI's provenance section.
7. **CI Firefox environment.** The informational Firefox job needs software
   Mesa; its result may vary by runner image and is not part of the deployment
   gate. Local Firefox 5/5 is the authoritative functional evidence.

## Next highest-priority work

1. Profile Firefox and WebKit frame rates on physical hardware.
2. Mobile/tablet layout and touch controls; automatic quality downgrade on
   low-memory devices.
3. Tiled Earth LOD for sub-kilometre chase shots.
4. Add a data-driven second scenario to exercise the frozen manifest contract.
5. Add a lightweight “legacy report” link inside the new platform UI.
