# Validation — aero dataset and terminal solver

Two automated harnesses cover the generated aero data and the live solver. Both run against the built site through Playwright / Node and are repeatable.

```bash
node scripts/build_aero.mjs       # regenerate the tables
node scripts/validate_aero.mjs    # 28 structural / physical checks
npm run build
npm run preview -- --port 4183 &
node scripts/validate_app.mjs     # 24 end-to-end checks + parameter sweep
```

Latest run: aero **28/28**, app **24/24**, 0 console errors.

## 1. Aero dataset (`aero-interceptor.json`)

| Group | Checks |
| --- | --- |
| Structure | identical src/public copies, strictly increasing Mach/α axes, table dimensions match axes, all values finite |
| Symmetry | CN odd in α, CM odd in α, CA even in α (exactly 0 residual) |
| Trends | CN increases with α and follows its sign; transonic CA peak at M=1.05; supersonic CA decays; CA slope bounded outside the transonic band |
| Magnitudes | CA0 ∈ 0.20–0.56; CA(α=10°) ∈ 0.24–0.80; CNα(M=2) = 8.70 /rad; \|CM\| ≤ 5.14; static margin 0.78 m |
| Derivatives | CNδ > 0, CMδ < 0, Cmq < 0, Clp < 0, Cnr < 0 |
| Cross-checks | skin-friction estimate at M=0.5 gives CA=0.339 vs table 0.340; reference area matches π d²/4; moment reference length equals the diameter |

Representative values:

| M | CA₀ | CA(10°) | CN(10°) | CM(10°) | CNα /rad |
| --- | --- | --- | --- | --- | --- |
| 0.3 | 0.340 | 0.581 | 1.841 | −4.01 | 10.55 |
| 0.85 | 0.370 | 0.611 | 1.841 | −4.01 | 10.55 |
| 1.05 | 0.560 | 0.795 | 1.820 | −3.97 | 10.43 |
| 2 | 0.400 | 0.565 | 1.518 | −3.31 | 8.70 |
| 3 | 0.330 | 0.455 | 1.316 | −2.87 | 7.54 |
| 5 | 0.260 | 0.344 | 1.070 | −2.33 | 6.13 |
| 8 | 0.220 | 0.276 | 0.866 | −1.89 | 4.96 |
| 12 | 0.200 | 0.239 | 0.712 | −1.55 | 4.08 |

The dataset is an engineering estimate from public geometry, not validated wind-tunnel or flight data. Method and disclaimer are embedded in the JSON.

## 2. Terminal solver and integration

Structural checks on the solved telemetry: samples strictly increasing (merge boundary fixed), all fields finite, `end` equals the last sample, intercept event present, events and phases sorted, target track covers the solved window, solved metrics finite and consistent with the samples (max Mach and max dynamic pressure are recomputed from the merged stream rather than inherited from the payload).

Behaviour checks:

| Check | Result |
| --- | --- |
| Solve time | 0–4 ms per solve (≈800 steps at dt=0.01 s) |
| Range → intercept time | 5 km → 666.24 s, 45 km → 679.51 s (monotonic) |
| Target speed changes geometry | 500 m/s → 672.65 s, 3000 m/s → 669.75 s |
| Navigation ratio | N=2 → 1.88 m miss, N=6 → 2.61 m |
| Load limit | every case ≤ its cap; 10 g case saturates exactly at 10.00 g |
| Restore | returns the 1504-sample payload, miss 26.7263 m, time 0 |
| Mobile | top bar overflow 0 px at 390×844 |
| Console | no errors in any state |

Parameter sweep (default 25.1 km / 138.4° / 14.8 km / 434 m/s unless changed):

| Case | Miss (m) | Intercept (s) | Max load (g) |
| --- | --- | --- | --- |
| range 5 km | 121.3 | 666.24 | 40.00 |
| range 15 km | 6.1 | 669.43 | 15.47 |
| range 45 km | 2.5 | 679.51 | 9.69 |
| range 60 km | 13.3 | 684.70 | 7.72 |
| alt 5 km | 1.0 | 674.00 | 38.76 |
| alt 30 km | 1.1 | 678.06 | 40.00 |
| alt 40 km | 2.5 | 693.33 | 40.00 |
| speed 500 | 13.9 | 672.65 | 15.17 |
| speed 2000 | 7.1 | 670.62 | 40.00 |
| speed 3000 | 4368.8 | 669.75 | 40.00 |
| heading 0 | 1.0 | 675.60 | 12.80 |
| heading −90 | 6.2 | 673.86 | 29.61 |
| heading 180 | 8.4 | 672.50 | 15.50 |
| turn 3 g | 1.4 | 673.38 | 17.06 |
| weave 3 g | 13.2 | 673.71 | 17.06 |
| N = 2 | 1.9 | 673.86 | 14.68 |
| N = 6 | 2.6 | 673.78 | 25.59 |
| max load 10 g | 5.2 | 673.83 | 10.00 |

### Findings

- **5 km hand-over is inside the minimum-turn basket**: at 25 km altitude the geometry demands more than 40 g, so the solve saturates and misses by 121 m. Physically consistent (too late to correct), and visible in the max-load column.
- **A 3000 m/s target is not catchable** from this hand-over state: the recorded closing speed is about 3.0 km/s but the target now recedes at 3.0 km/s, so the miss grows to 4.37 km. The solver reports it instead of forcing an intercept.
- **Lower load cap does not always mean a larger miss** (10 g gave 5.2 m vs 7.1 m at 40 g): the 40 g run over-corrects slightly on this geometry. Not a defect, but it means miss distance alone is a poor tuning signal.
- **Payload metrics are not sample-consistent**: the recorded `maxMach` (9.4806) and `maxDynamicPressurePa` (872 728) are higher than the maximum over the 0.45 s samples (9.445 / 632 358), so the payload metrics came from a finer integration. Solved metrics are recomputed from the merged samples and therefore match what the UI plots.
- **Attitude is representative, not aerodynamic**: body attitude is steered toward the velocity vector with finite rate/bank; the pitch/yaw moments and damping derivatives in the dataset are exported for external use but are not integrated in the current translation model.

### Limits

- Terminal leg only (from seeker lock); boost and midcourse remain the recorded payload.
- Translation is 3-DoF point mass with PN; aero enters through CA drag and the derivative table is informational.
- No validated SM-3 aero data is public; coefficients are engineering estimates and are labelled as such in the UI and the JSON.
