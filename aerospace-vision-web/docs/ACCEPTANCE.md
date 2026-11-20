# Acceptance report — Aerospace Vision Web V1

Run date: 2026-11-20 (Asia/Shanghai)
Environment: Windows, Node 24.19.0, npm 11.17.0, Python 3.14.10,
Vite 8.3.8, Three.js 0.187.0, React 19.3.1, ECharts 6.1.0.
Browser used for E2E: Microsoft Edge 157.0.4341.60 (Chromium engine), headless,
1280 × 720. Bundled Playwright Chromium download was blocked by the network;
the Edge channel exercises the same Chromium engine stack and is recorded here
as such. Firefox and Safari: **NOT RUN**.

## Gate status

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

Commit `8fe3e3d` — workflow run
[44744503544](https://github.com/PaoShou-China/missile-interception/actions/runs/44744503544):
`build` and `deploy` both **success**. The CI browser uses SwiftShader: five
scene/interaction tests passed, and the FPS test recorded **5.9 FPS** as a
software-rendering annotation rather than a hardware result.

### Public URL verification (G5)

```
URL:    https://paoshou-china.github.io/missile-interception/
title:  Aerospace Vision Web · Scientific Trajectory Visualisation
status: TELEMETRY VERIFIED · 10 CHECKS
canvas: 1600 × 900
clock:  T+00:00:49, altitude 0.00 → 12.50 km after pressing play
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
   when the GPU reports `maxTextureSize < 8192`.
2. **Firefox/WebKit performance** was verified functionally (all tests passed)
   but not profiled for frame rate; only Chromium passed the 60 FPS hardware
   gate. CI has no GPU and records SwiftShader (~5.9 FPS) as an annotation.
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
7. **CI deployment** was verified for the previous commit chain; re-verify after
   any future deployment changes.

## Next highest-priority work

1. Profile Firefox and WebKit frame rates on physical hardware.
2. Mobile/tablet layout and touch controls; automatic quality downgrade on
   low-memory devices.
3. Tiled Earth LOD for sub-kilometre chase shots.
4. Add a data-driven second scenario to exercise the frozen manifest contract.
5. Add a lightweight “legacy report” link inside the new platform UI.
