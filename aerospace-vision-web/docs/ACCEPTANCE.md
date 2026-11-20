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
| G3 visual quality | **PASS (local)** | five Playwright screenshots in `docs/visual/`; Earth, clouds, atmosphere, PBR vehicle, gradient track, cinematic captions |
| G4 browser performance & compatibility | **PARTIAL** | 59.9 FPS measured at 1280×720 in headless Chromium; 1080p hardware and Firefox/Safari NOT RUN |
| G5 GitHub Pages public URL | **NOT RUN** | workflow added; requires a push and enabling Pages in repository settings. No public URL has been claimed. |

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

### Browser E2E

```
$ $env:PW_CHANNEL=msedge; npx playwright test
✓ loads the validated scenario and renders the 3D scene
✓ timeline playback advances the single simulation clock and telemetry
✓ seeking to the intercept event updates the scene state
✓ camera modes switch and the chase view renders
✓ cinematic mode runs a captioned shot sequence and exits cleanly
✓ measures animation frame rate over two seconds
measured FPS: 60.1
6 passed
```

Screenshots produced during the run are in `test-results/visual/`; the curated
set referenced by the README is in `docs/visual/`:
`01-earth-overview.png`, `02-chase-camera.png`, `03-intercept-chase.png`,
`04-terminal-overview.png`, `05-cinematic-boost.png`.

### Production build

```
$ npm run build
dist/index.html                               1.49 kB │ gzip 0.74 kB
dist/assets/index-*.css                      19.63 kB │ gzip 4.82 kB
dist/assets/index-*.js                      456.32 kB │ gzip ~142 kB
dist/assets/echarts-*.js                    510.70 kB │ gzip 172.46 kB
dist/assets/three-*.js                      757.27 kB │ gzip 191.58 kB
dist/data/missile-intercept/scenario.json   785.16 kB
dist/textures/earth_day_2048.jpg            512.61 kB
dist/textures/earth_clouds_1024.png         226.11 kB
total dist                                  3.27 MB
```

## Known limitations and risks

1. **G5 is unverified.** The Pages workflow is written
   (`.github/workflows/aerospace-vision-pages.yml`) but never executed against a
   real repository. Do not describe the site as deployed until a public URL has
   been loaded and tested.
2. **E2E browser coverage.** Local runs use the installed Edge channel because
   the Playwright Chromium download did not complete. CI will use its bundled
   Chromium; Firefox/WebKit remain untested.
3. **Resolution.** FPS was measured at 1280×720 in headless mode (vsync-capped
   at ~60). A physical 1080p run on low-end integrated GPUs is still unverified.
4. **Earth surface detail.** The day map is 2048 × 1024 and the cloud layer
   1024 × 512; close chase passes show soft terrain. A tiled/streamed Earth is
   the next visual upgrade, not a correctness issue.
5. **Symbolic track width.** At orbital zoom the trajectory is drawn as a 3 km
   radius tube so it is legible; its centreline is the exact telemetry path and
   it is hidden within ~800 km altitude, where the 1 px line is used. No
   positional exaggeration is applied.
6. **Bloom.** “Bloom” is approximated with additive atmospheric shells and
   sprites; there is no post-processing pass. This keeps the frame budget and
   WebGL compatibility simple, but is not a true HDR bloom pipeline.
7. **Target attitude** is derived from its ECEF velocity (source telemetry has
   no target attitude). It affects orientation only and is documented in the
   UI's provenance section.
8. **Cinematic pacing** is tied to the 10× cinematic playback rate; camera
   transitions are damped in the vehicle frame, so low frame rates converge
   more slowly during the first seconds of a shot.

## Next highest-priority work

1. Push and verify GitHub Pages (G5): confirm asset paths, `.nojekyll`, model and
   scenario loading over HTTPS.
2. Run the suite with bundled Chromium and add a Firefox/WebKit project; record
   WebGL capability detection and graceful fallback.
3. 1080p hardware performance measurement with the browser performance panel,
   including a 10-minute memory-growth check.
4. Stream a higher-resolution Earth (8k day + clouds) or add tiled imagery for
   chase shots.
5. Add a data-driven second scenario to exercise the frozen manifest contract.
