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
| `finite-values` | No NaN/Inf in 67 979 × 152 data (incl. transient TPS, IMM, decoys, fuze) | PASS |
| `eci-ecef-alignment` | ECI and ECEF coincide at t = 0 | PASS |
| `velocity-frame` | ECEF velocity = Rz(−ωt)(v_ECI − ω×r_ECI) | PASS |
| `llh-ecef-roundtrip` | WGS84 lat/lon/alt reproduce ECEF | PASS (≤ 0.073 m) |
| `quaternion-normalized` | Unit quaternions, scalar-first | PASS |
| `speed-semantics` | Source speed is inertial; web uses Earth-relative | PASS |
| `speed-and-mach-semantics` | Mach is wind-corrected air-relative | PASS |
| `altitude-units` | WGS84 geodetic height, metres | PASS |
| `sample-recovery` | Converted samples reproduce source state | PASS |
| `actuator-channels` | Recorded fin deflections and body rates are present | PASS (max 0.436 rad, 3.73 rad/s) |

The browser also re-validates the payload at load (`src/scientific/scenario.ts`)
and refuses to render if a check fails.

## 2. Software test status

- Backend 6DOF & physics unit tests (`missile_intercept`, pytest): **98 passed**
  (covering Python/Numba `fastcore.py` 1e-12 isomorphism for 2nd-order hinge-moment
  fin servo, stage separation, inlet recovery/unstart, 1D transient TPS, 3-model
  IMM CV+CA+3D-CT switching, flare/chaff anti-decoy gating, 22 Hz flex-mode +
  notch filter, and directed-fragmentation proximity fuze lethality).
- Root traceability tests (`tests/`, pytest): **48 passed, 1 skipped**.
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

## 3. Scientific validation status (2026-11-28 High-Adversarial Upgrade: 6/6 Suites PASS, 95.8%)

Following the 2026-11-28 high-adversarial physical-closure & 3D physical-field
upgrades (1D transient thin-wall TPS coupled to sapphire MWIR dome transmittance,
joint $q_{\max}$–$\dot{q}_{\max}$ midcourse/throttle corridor, discrete 13 s
Stage-1 booster casing separation, scramjet inlet pressure recovery & Unstart
hysteresis, terminal IR flare / radar chaff countermeasures, Blom–Bar-Shalom
3-model IMM [CV + CA/Singer + 3D-CT] + Doppler/dual-band anti-decoy gating,
32 Hz / $\zeta=0.7$ 2nd-order fin servo with >400 kPa hinge-moment torque cap,
tail-fin NMP predictive lead compensation, optional 22 Hz elastic bending mode +
notch filter, and 3D directed-fragmentation proximity fuze model):

- **48-case performance envelope matrix (`validate_performance.py`)**:
  **OVERALL PASS — 46/48 (95.8 %)** across all 6 suites (criterion ≤ 15.0 m,
  suite threshold ≥ 80 %):
  - A Baseline: **100.0 %** (4/4, mean 4.45 m, median 4.50 m, max 6.39 m)
  - B Target altitude (5–15 km): **87.5 %** (7/8, mean 8.16 m, median 6.66 m, max 15.15 m)
  - C Target speed (Ma 0.8–1.6): **100.0 %** (10/10, mean 9.26 m, median 9.01 m, max 14.29 m)
  - D Target maneuver (0–9 g): **100.0 %** (8/8, mean 8.09 m, evade-9g mean 6.48 m, max 14.48 m)
  - E Engagement geometry (±200 km / ±150 km): **100.0 %** (10/10, mean 7.09 m, max 13.07 m)
  - F Combined stress: **87.5 %** (7/8, low-fast-hard-evade mean 3.37 m, mid-fast-hard-evade mean 2.05 m)
- **Nominal single shot (152-column telemetry)**: **7.83 m** miss at t = 679.775 s
  - Peak dynamic pressure reduced from `857.9 kPa` to **`652.9 kPa`** (-23.9 %);
  - Peak stagnation heat flux reduced from `8.60 MW/m²` to **`5.77 MW/m²`** (-32.9 %);
  - Peak 1D transient wall temp **`2342.0 K`** vs steady radiative-equilibrium `2377.7 K`;
  - Directed-fragmentation proximity fuze: **`3.56 ms` lead (9.2 m standoff)**,
    fragment density `6.08 /m²`, **$P_k(\text{fuze}) = 69.7\%$** vs Carleton `65.5 %`;
  - IMM mode probabilities shift cleanly from `[CV 79.3%, CA 10.5%, CT 10.2%]` in
    cruise to `[CV 5.3%, CA 84.0%, CT 10.7%]` during 9 g terminal evasion with
    414 frames of active flare/chaff countermeasures rejected by the seeker gate.
- **Miss-distance ablation (`tools/miss_budget.py --quick`)**: 6/6 valid:
  `nominal truth_nav` **0.122 m**, `nominal no_sensor_noise` **0.474 m**,
  `nominal full` **7.826 m**, `alt-5km full` **2.444 m** (fed directly into
  the web & dashboard B-Plane Miss-Budget Waterfall charts).
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
