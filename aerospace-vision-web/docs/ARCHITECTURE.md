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
   a frame-rate-independent exponential filter. Free mode hands control to
   `OrbitControls`.

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
- Earth tessellation 160×112 (high) / 96×72 / 64×48.
- Stars 9 000 / 4 200 / 1 800 points.
- Trajectory geometry allocated once (1 504 vertices × 3 lines).
- No shadow maps, no post-processing passes; atmosphere is a two-shell
  fresnel shader, glows are additive sprites.
- Charts are canvas ECharts instances, updated with a mark-line only when time
  changes; chart series are built once.
- `useFrame` allocations are kept small; textures/geometries are owned by
  memoised objects and released with the component tree.

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
- `CameraMode` (`state/store.ts`) — earth, chase, top, target, free.
- `PlaybackState` — `SimulationClock` exposes time, rate, playing, progress.

## 7. Extension points

New scenarios only need a new adapter output directory and a manifest; the
loader URL can become a query parameter (`?scenario=...`) without touching scene
code. Additional entities can be added by extending `SceneEntity.kind` and the
visual switch in `Entities.tsx`.
