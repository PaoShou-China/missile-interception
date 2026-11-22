# Architecture

## 1. Layering

```
                 ┌────────────────────────────┐
                 │ tools/data-adapter (Python)│
                 │ CSV → schema v1.0.0 JSON   │
                 └─────────────┬──────────────┘
                               │ scenario.json
┌──────────────────────────────▼───────────────────────────────┐
│ app/          composition, loading, keyboard, error boundary  │
│ components/   DOM UI (panels, timeline, charts, cinematic)    │
│ state/        SimulationClock (authority) + Zustand mirror    │
│ scientific/   pure TS: types, geodesy, quaternions, sampler,  │
│               clock, attitude, scenario validation            │
│ scene/        R3F: Earth, atmosphere, stars, entities, trail, │
│               camera director                                 │
│ cinematic/    shot list and captions                          │
└───────────────────────────────────────────────────────────────┘
```

Dependencies point downward: `scene`/`components` → `state`/`scientific`;
`scientific` imports nothing from React or Three.js.

## 2. Single time authority

`SimulationClock` (scientific/clock.ts) owns playback state. A `ClockDriver`
inside the R3F canvas calls `clock.tick(delta)` once per frame; every visual
consumer reads `simClock.time` during its own `useFrame`. UI text subscribes to
a Zustand copy updated at 20 Hz. Seeks write the clock and the mirror in the
same action. Consequences:

- camera, model, trail, HUD and charts share one time value;
- playing does not trigger 60 Hz React renders;
- pause/scrub/step are frame-accurate.

## 3. Data flow at runtime

1. `App` fetches `data/missile-intercept/scenario.json`.
2. `validateScenario` checks schema version, WGS84/ECEF declarations, adapter
   PASS status, monotonic time, finite values, unit quaternions, and
   geodetic ↔ ECEF consistency.
3. Two `TrajectorySampler`s are built (missile, target).
4. `SceneCanvas` mounts; `EntityVisual` samples at `simClock.time`, assigns the
   ECEF position (km) and `BODY→ECEF` quaternion.
5. `TrajectoryRibbon` builds static geometries and reveals the flown part with
   `drawRange`; no geometry rebuild per frame.
6. `CameraRig` computes a desired pose per mode, damping position/look-at with
   a frame-rate-independent exponential filter. User drag/wheel offsets are
   applied on top of every framing, so any mode can be orbited and zoomed.

## 4. Coordinate strategy

The renderer works directly in ECEF kilometres (~6 378 km). `logarithmicDepthBuffer`
preserves depth precision from 1 m near-plane to 300 000 km far-plane. No
camera-relative floating origin is needed at these magnitudes; positions are
double-precision JS numbers and only the GPU matrices are float32, giving
sub-metre resolution at Earth radius.

Earth is a WGS84 ellipsoid (a = 6378.137 km, b = 6356.752 km) with the texture
mapped so that texture centre = 0° longitude and the north pole is +Z. Entity
positions are not clamped to the ellipsoid — they are the telemetry values.

## 5. Rendering and performance

- WebGL2, ACES tone mapping, dpr capped by quality.
- Earth: 8K day map + 4K cloud layer on the high tier (with automatic 2K
  fallback when `maxTextureSize < 8192`), 2K/1K on medium/low; tessellation
  192×128 / 96×72 / 64×48.
- Stars 9 000 / 4 200 / 1 800 points.
- Moderate HDR bloom (`@react-three/postprocessing`) on the high tier only;
  medium/low use the additive atmosphere + sprites without the composer.
- Trajectory geometry allocated once (1 504 vertices × 3 lines, plus a
  screen-legibility cord that is disabled near the vehicle).
- No shadow maps. The atmosphere is a two-shell fresnel shader, glows are
  additive sprites, and a small camera-anchored fill light keeps the backlit
  vehicle readable without altering any data.
- Charts are canvas ECharts instances, updated with a mark-line only when time
  changes; chart series are built once.
- `useFrame` allocations are kept small; textures/geometries are owned by
  memoised objects and released with the component tree.

## 5.1 Cinematic pacing

Each shot declares a sim-time range and a playback rate. The wall duration is
`(end - start) / rate`; entering cinematic mode seeks to 0, applies the first
shot rate, and cuts directly to the launch framing. The clock driver updates
the rate at each shot boundary, so captions stay on screen for 6–22 seconds
regardless of the scenario's absolute duration. Exiting restores the scientific
playback rate that was active before the tour.

## 5.2 Track emphasis

At orbital distances a 1-pixel line is hard to read, so an additive cord of
3 km radius follows the exact centreline. Its width is symbolic and is disclosed
in the UI; the **Track** toggle removes it, leaving the true-scale polyline.
Within ~800 km of the surface the cord is hidden automatically.

## 6. Interfaces (frozen at G0)

From `src/scientific/types.ts`:

- `ScenarioManifest` — metadata, Earth constants, time axis, frames, provenance,
  metrics, sites, phases, events, observables, entities, validation.
- `TrajectorySample` — `t`, ECEF position/velocity, BODY→ECEF quaternion,
  geodetic coordinates, speed, Mach, q, load, mass, seeker FOV, range, phase,
  flags.
- `SceneEntity` — id/label/kind/colour + samples.
- `ScientificObservable` — key/label/unit/description/precision.
- `VisualizationEvent` — time-stamped, typed mission event.
- `CameraMode` (`state/cameraModes.ts`) — earth, top, chase, launch, target,
  free, fin, engine, attitude, seeker.
- `PlaybackState` — `SimulationClock` exposes time, rate, playing, progress.

## 7. Extension points

New scenarios only need a new adapter output directory and a manifest; the
loader URL can become a query parameter (`?scenario=...`) without touching scene
code. Additional entities can be added by extending `SceneEntity.kind` and the
visual switch in `Entities.tsx`.

## 8. V4 structure (bilingual academic site)

```
src/
  app/
    App.tsx           hash-router shell; academic routes vs. explorer
    router.ts         "/", "/methodology", "/results", "/verification",
                      "/resources", "/explore"
    ExploreApp.tsx    the 3D application (mounts only at #/explore)
  i18n/
    messages.ts       flat zh/en catalogue with {var} interpolation
    index.tsx         provider, persistence (localStorage), <html lang>, title
  pages/
    Layout.tsx        sticky academic header, nav, language switch, footer
    HomePage.tsx      hero, live metrics, capability grid, audit callout
    MethodologyPage.tsx / ResultsPage.tsx / VerificationPage.tsx /
    ResourcesPage.tsx (legacy paths + audit docs + source links)
  scientific/
    astronomy.ts      NOAA solar + low-precision lunar ECEF directions
    types.ts          schema 1.1.0 (fin deflection, body rates, experiment)
  cinematic/shots.ts  independent 180 s presentation timeline
  state/
    cameraModes.ts    10 ordered modes (numeric hotkeys 1..0)
```

The explorer is mounted only on `#/explore`, so the academic pages never stream
the 8K Earth texture. Vite `base: "./"` plus hash routing keeps deep links valid
on GitHub Pages project sites.

### 8.1 Four cameras, one merged close-up

`earth`, `chase`, `target`, `closeup`. The former `fin`, `engine` and `attitude`
views were merged into a single three-quarter rear close-up so the tail fins,
nozzle/plume and body-axis triad are visible in one frame. Launch and Seeker
were removed earlier as near-duplicates of Chase and Intercept. The close-up
resolves its offset in the vehicle body frame and rotates it by the recorded
attitude quaternion, so it stays locked to the true orientation at any playback
rate; the fins are still driven by the recorded four-channel deflection data.
Pointer drag and wheel zoom are applied on top of the automatic pose.

The Earth reference now uses a bump-mapped day surface plus a separate ocean
sun-glint shell, layered clouds and the atmospheric limb, so terrain relief and
specular water respond to the same astronomical sun direction as the vehicle.

### 8.2 Astronomy

`skyStateAt(demoUtc, elapsedS)` returns unit sun/moon ECEF directions plus the
launch-site sun elevation. `SpaceEnvironment` updates a directional light, the
sun/moon meshes and the atmosphere shader uniforms. The epoch is fixed and
declared in the payload (`time.demoUtc`); it never changes trajectory data.

### 8.3 Cinematic presentation clock

`CINEMATIC_WALL_S = 180`. The wall clock is split by mission phase: boost
0–60 s, midcourse 60–142 s, terminal 142–180 s, each mapped linearly to its
own telemetry interval. Boost and terminal therefore play much slower than the
compressed midcourse inside the same three-minute film. Shots are selected by
wall time; the overlay offers a clickable/draggable progress bar, keyboard
seek, pause, ±15 s skip, fullscreen and exit.

### 8.4 Loading strategy

`ExploreApp` and `ResultsPage` are `React.lazy` routes. Vite emits separate
`three` and `echarts` chunks, so academic pages ship only the entry bundle
(~274 kB, 87 kB gzip) and never stream 8K textures or WebGL code.

### 8.5 Presentation modes

`Scientific` shows the 3D scene with panels, the centered mode dock and the
timeline. `Cinematic` runs the three-minute film with its own transport.
`Charts` is a dedicated data view: eight large ECharts time series in a 2×4
grid (altitude/speed, q/load, load command/response, attitude, body rates,
four fin channels, Mach/range, mass/propellant), each with inside/slider zoom,
while the shared timeline stays available for scrubbing. Esc returns to
Scientific. The right rail itself is telemetry-only.

### 8.6 Route metadata and social preview

A single `RouteMeta` effect owns document title, description, canonical URL,
Open Graph/Twitter tags and locale. `index.html` carries static defaults plus
JSON-LD `WebSite` so crawlers that do not execute the hash route still get
valid metadata.

### 8.7 Responsive explorer

Below 760 px the two desktop rails become a single sheet with a two-tab
switcher (mission / telemetry); the camera dock becomes a horizontal
scroller. The sheet is rendered only in scientific mode, and the active tab is
stored in Zustand so panel content keeps its state.

### 8.8 Accessibility and print

- Skip link focuses the `main` landmark without touching the hash route.
- Camera, presentation and track toggles expose `aria-pressed`.
- Global `:focus-visible` ring; `prefers-reduced-motion` removes transitions.
- A print stylesheet hides chrome, expands the page and avoids breaking cards
  and charts, so the results/verification pages can be exported as a report.
