# Validation Status

This page separates **software verification** (does the implementation do what
it claims?) from **scientific validation** (is the underlying simulation
correct and adequate?). They are not interchangeable.

## 1. Runtime frame validation (PASS)

`validation.json` records eleven checks executed by the adapter on every shipped
payload (explorer scenario, experiment-matrix runs and campaign representatives).
All are PASS for the archived explorer payload and for the shipped records:

| Check | Meaning | Result |
| --- | --- | --- |
| `timeline-monotonic` | Time strictly increases | PASS (dt = 0.01 s) |
| `finite-values` | No NaN/Inf in 67 276 × 132 data (explorer payload) | PASS |
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

- Unit / scientific tests (66): coordinate frames, quaternions, interpolation,
  clock, attitude, scenario validation, astronomy, comparison matcher, experiment
  registry and campaign slices.
- Browser E2E (16 Chromium passed; WebKit deployment gate; Firefox informational):
  load, playback, seek, four cameras incl. the merged close-up, language switch,
  cinematic, the configuration studio, unsupported-combination refusal and the
  390 px layout.
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

### Comparison experiments

Newer guidance, boost and control comparison runs were generated from the current
working tree. They pass the same eleven payload-integrity checks, and the web
Studio marks them `PASS` for payload integrity. They have **NOT RUN** an
independent scientific validation campaign, and the aggregate campaign is a
4-case-per-law quick capture plus a 24-case architecture arm. Differences shown
in the Studio are descriptive, not superiority claims.

## 4. Known gaps

1. Legacy Monte-Carlo artifacts were overwritten; the 79 %/86 % figures are
   historical only.
2. All comparison payloads come from a working tree (`commit=workspace`).
3. The explorer wires one nominal scenario; the comparison Studio wires several
   paired campaign cases, but the full contract is not yet used by the explorer.
4. Astronomy is demonstrative (fixed demo UTC), not mission ephemeris.
5. Close-up camera finite-detail: fin deflection is real recorded data, but
   the fin geometry is a schematic, not a CAD model. The merged close-up shows
   fins, nozzle and body axes together; it is not a CAD inspection view.
