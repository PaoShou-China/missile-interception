# Validation Status

This page separates **software verification** (does the implementation do what
it claims?) from **scientific validation** (is the underlying simulation
correct and adequate?). They are not interchangeable.

## 1. Runtime frame validation (PASS)

`validation.json` records eleven checks executed by the adapter on the current
telemetry. All are PASS:

| Check | Meaning | Result |
| --- | --- | --- |
| `timeline-monotonic` | Time strictly increases | PASS (dt = 0.01 s) |
| `finite-values` | No NaN/Inf in 67 164 × 132 data | PASS |
| `eci-ecef-alignment` | ECI and ECEF coincide at t = 0 | PASS |
| `velocity-frame` | ECEF velocity = Rz(−ωt)(v_ECI − ω×r_ECI) | PASS |
| `llh-ecef-roundtrip` | WGS84 lat/lon/alt reproduce ECEF | PASS (≤ 0.073 m) |
| `quaternion-normalized` | Unit quaternions, scalar-first | PASS |
| `speed-semantics` | Source speed is inertial; web uses Earth-relative | PASS |
| `speed-and-mach-semantics` | Mach is wind-corrected air-relative | PASS |
| `altitude-units` | WGS84 geodetic height, metres | PASS |
| `sample-recovery` | Converted samples reproduce source state | PASS |
| `actuator-channels` | Recorded fin deflections and body rates are present | PASS (max 0.436 rad, 8.67 rad/s) |

The browser also re-validates the payload at load (`src/scientific/scenario.ts`)
and refuses to render if a check fails.

## 2. Software test status

- Unit / scientific tests: coordinate frames, quaternions, interpolation,
  clock, attitude, scenario validation, astronomy.
- Browser E2E (Chromium + WebKit deployment gate; Firefox informational):
  load, playback, seek, camera modes, close-ups, language switch, cinematic.
- Performance: 10-minute 1080p soak recorded in `docs/performance/`.

## 3. Scientific validation status (NOT a pass)

The source project's own envelope validation is **FAIL**:

- 48-case performance matrix: 39/48 (81.2 %), but groups D (maneuver, 50 %)
  and E (engagement geometry, 70 %) sit below the 80 % threshold.
- Monte-Carlo campaign: 79 % (one source) / 86 % (another source) at 15 m —
  internally contradictory and unreproducible from current artifacts.

Therefore this platform **does not claim an interception success rate**. It
claims only that the replay is faithful to the telemetry it was given, and that
the telemetry itself passed the frame/units checks above.

## 4. Known gaps

1. Legacy Monte-Carlo artifacts were overwritten; the 79 %/86 % figures are
   historical only.
2. The current payload comes from a dirty working tree (`commit=workspace`).
3. Only one scenario is wired into the explorer; the frozen contract is
   designed to accept more.
4. Astronomy is demonstrative (fixed demo UTC), not mission ephemeris.
5. Close-up camera finite-detail: fin deflection is real recorded data, but
   the fin geometry is a schematic, not a CAD model.
