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
| `timeline-monotonic` | Time strictly increases | PASS (adaptive 0.005–0.02 s) |
| `finite-values` | No NaN/Inf in 53 673 × 152 binary `.npz` data (incl. transient TPS, IMM, decoys, fuze) | PASS |
| `eci-ecef-alignment` | ECI and ECEF coincide at t = 0 | PASS (0.000 m) |
| `velocity-frame` | ECEF velocity = Rz(−ωt)(v_ECI − ω×r_ECI) | PASS (0.000 m/s) |
| `llh-ecef-roundtrip` | WGS84 lat/lon/alt reproduce ECEF | PASS (≤ 0.001 m) |
| `quaternion-normalized` | Unit quaternions, scalar-first (full float64 via `.npz`) | PASS (max 6.19e-12) |
| `speed-semantics` | Source speed is inertial; web uses Earth-relative | PASS |
| `speed-and-mach-semantics` | Mach is wind-corrected air-relative | PASS |
| `altitude-units` | WGS84 geodetic height, metres | PASS |
| `sample-recovery` | Converted samples reproduce source state | PASS (≤ 0.00 m) |
| `actuator-channels` | Recorded fin deflections and body rates are present | PASS (max 0.436 rad, 3.41 rad/s) |

The browser also re-validates the payload at load (`src/scientific/scenario.ts`)
and refuses to render if a check fails.

## 2. Software test status

- Backend 6DOF & physics unit tests (`missile_intercept`, pytest): **103 passed**
  (covering Python/Numba `fastcore.py` 1e-11 isomorphism for fused `nogil`
  multi-substep RK4, 3-model IMM CV+CA+3D-CT prediction/fusion, Eckert
  hypersonic skin friction, stoichiometric scramjet capture ceiling, 2nd-order
  hinge-moment fin servo, stage separation, inlet recovery/unstart, 1D transient
  TPS, flare/chaff anti-decoy gating, 22 Hz flex-mode + notch filter, directed-
  fragmentation proximity fuze lethality, binary `.npz` round-trip, and
  zero-allocation `telemetry_profile="none"` equivalence).
- Root traceability tests (`tests/`, pytest): **36 passed**.
- Web unit / scientific tests (`aerospace-vision-web`, Vitest): **66 passed**:
  coordinate frames, quaternions, interpolation, clock, attitude, scenario
  validation, astronomy, comparison matcher, experiment registry and campaign slices.
- Explorer aero & 6DOF validators (`interceptor-vision`): **28/28 aero**,
  **12/12 WGS84+USSA1976 6DOF**, production build green.
- Browser E2E (16 Chromium passed; WebKit deployment gate; Firefox informational):
  load, playback, seek, four cameras incl. the merged close-up, language switch,
  cinematic, the configuration studio, unsupported-combination refusal and the
  390 px layout.
- Performance: 10-minute 1080p soak recorded in `docs/performance/`.

## 3. Scientific validation status (2026-11-28 Hypersonic Aero/Propulsion Realism + Full-Stack Optimization: 6/6 Suites PASS, 93.8%)

Following the 2026-11-28 high-adversarial physical-closure, hypersonic
aerodynamics/scramjet realism (Eckert reference-temperature skin friction,
Mach-dependent induced drag & JP-10 Isp roll-off, stoichiometric oblique-shock
air-capture ceiling, Hoerner base-drag relief, coast/unstart inlet spillage
drag, live-CG dynamic damping, ±30° gimballed AESA/MWIR FOV, Zarchan finite-
horizon OGL glint roll-off), upgraded procedural 3D interceptor & F-35A models,
and 6-item full-stack performance optimizations (fused `nogil` Numba RK4 + IMM
kernels, 20 ms pure-cruise adaptive stepping, zero-alloc `telemetry_profile="none"`,
binary `.npz` telemetry I/O, 25 Hz offscreen `ImageData` sensor canvases, and
zero-React-rerender playback + `InstancedMesh` instancing):

- **48-case performance envelope matrix (`validate_performance.py`, 12 workers)**:
  **OVERALL PASS — 45/48 (93.8 %)** across all 6 suites (criterion ≤ 15.0 m,
  suite threshold ≥ 80 %) in **`200.3 s`** wall clock (down from `463.6 s`, **2.31× faster**):
  - A Baseline: **100.0 %** (4/4, mean 7.02 m, median 6.86 m, max 9.22 m)
  - B Target altitude (5–15 km): **100.0 %** (8/8, mean 5.76 m, median 5.70 m, max 9.05 m)
  - C Target speed (Ma 0.8–1.6): **90.0 %** (9/10, mean 8.01 m, median 6.93 m, max 15.54 m)
  - D Target maneuver (0–9 g): **100.0 %** (8/8, mean 6.90 m, median 6.19 m, max 12.35 m)
  - E Engagement geometry (±200 km / ±150 km): **90.0 %** (9/10, mean 7.39 m, max 17.56 m)
  - F Combined stress: **87.5 %** (7/8, `very-low-fast` 2/2 mean 3.10 m, `mid-fast-hard-evade` mean 5.72 m)
- **Nominal single shot (152-column binary `.npz` telemetry)**: **`1.48 m`** miss at t = 680.474 s
  - Single-shot full telemetry CPU time reduced from `114.13 s` to **`52.39 s`** (**2.18×**);
    zero-alloc batch single-shot reduced to **`21.42 s`** (**5.33×**);
  - Binary `.npz` write: **`1.16 s`**; `build_scenario.py` ingestion: **`0.79 s`** (~20× faster than CSV);
  - Directed-fragmentation proximity fuze: **`2.00 ms` lead (5.1 m standoff)**,
    fragment density `134.64 /m²`, **$P_k(\text{fuze}) = 99.5\%$** vs Carleton `98.5 %`.
- **Miss-distance ablation (`tools/miss_budget.py --quick`, 6 workers)**: 6/6 valid in **`47.8 s`** (down from `112.1 s`, **2.35× faster**):
  `nominal truth_nav` **0.619 m**, `nominal no_sensor_noise` **1.404 m**,
  `nominal full` **1.482 m**, `alt-5km full` **4.742 m**, `alt-5km truth_nav` **1.008 m**.
- Legacy Monte-Carlo figures (79 % / 86 % in archived HTML reports) remain
  labelled historical only and are not mixed into current validation metrics.

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
