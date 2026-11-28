# Validation — aero dataset and terminal solver

Two automated harnesses cover the generated aero data and the live solver. Both run against the built site through Playwright / Node and are repeatable.

```bash
node scripts/build_aero.mjs       # regenerate the tables
node scripts/validate_aero.mjs    # 28 structural / physical checks
node scripts/validate_6dof.mjs    # 12 rigid-body / convergence checks
npm run build
npm run preview -- --port 4183 &
node scripts/validate_app.mjs     # 24 end-to-end checks + parameter sweep
```

Latest run (2026-11-28): aero **28/28**, 6-DoF **12/12** (`dt 1 ms vs 0.5 ms` terminal position `0.000 %`, miss `86.41 vs 86.50 m` on A1 aero-only divert-disabled check, body rates max `1.87 rad/s`, fin travel max `10.0 deg`, `0.0 %` sustained saturation), production build green (`588 ms`), 0 console errors.

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

## 2. Terminal solver — 6-DoF rigid body

The default model integrates a rigid body (RK4, 1 ms) from the recorded seeker-lock state: quaternion kinematics, Euler's equations, aero force/moment from the engineering tables, first-order fin servos (15° / 200 °·s⁻¹ / 10 Hz), a skid-to-turn autopilot, and DACS divert thrusters. A simplified 3-DoF point-mass model remains selectable in the panel.

### 2.1 Rigid-body checks (`scripts/validate_6dof.mjs`)

Run against the compiled `src/sim/sixdof.ts` (the shipped module, not a copy) on the recorded hand-over geometry:

| Check | Result |
| --- | --- |
| dt 1 ms vs 0.5 ms terminal position | 0.000 % (gate < 0.5 %) |
| dt 1 ms vs 0.5 ms miss distance | 1.00 vs 1.00 m |
| Intercept | 1.0 m at t = 672.71 s (lock 664.54 s) |
| Body rates | max 0.78 rad/s |
| Angle of attack | max 7.4° |
| Sideslip | max 10.5° |
| Fin travel | max 13.9° (limit 15°) |
| Sustained fin saturation | 0 % of samples |
| Commanded load | max 17.2 g (cap 40 g) |
| Divert impulse | 620 m/s used |

### 2.2 End-to-end checks (`scripts/validate_app.mjs`)

Structural: samples strictly increasing (merge boundary), all fields finite, `end` equals the last sample, intercept event present, events and phases sorted, target track covers the window, and max Mach / max dynamic pressure are recomputed from the merged stream rather than inherited from the payload.

| Check | Result |
| --- | --- |
| Default solve | 1 m miss, intercept 672.73 s, 16.6 g, max Mach 9.4475 |
| Solve time | 9–40 ms per solve (≈8 k steps at 1 ms) |
| Range → intercept time | 5 km → 666.23 s, 45 km → 679.41 s (monotonic) |
| Target speed changes geometry | 500 m/s → 672.59 s, 3000 m/s → 669.47 s |
| Navigation ratio | N=2 → 206 m miss, N=6 → 4.3 m |
| Load limit | every case ≤ its cap; 10 g case saturates exactly at 10.00 g |
| Restore | returns the 1504-sample payload, miss 26.7263 m, time 0 |
| Mobile | top bar overflow 0 px at 390×844 |
| Console | no errors in any state |

Parameter sweep (default 25.1 km / 138.4° / 14.8 km / 434 m/s unless changed):

| Case | Miss (m) | Intercept (s) | Max load (g) |
| --- | --- | --- | --- |
| range 5 km | 220.0 | 666.23 | 40.00 |
| range 15 km | 1.0 | 669.42 | 16.33 |
| range 45 km | 10.1 | 679.41 | 40.00 |
| range 60 km | 5.4 | 684.63 | 40.00 |
| alt 5 km | 681.5 | 674.04 | 40.00 |
| alt 30 km | 6841.2 | 674.56 | 40.00 |
| alt 40 km | 20134.6 | 674.84 | 40.00 |
| speed 500 | 1.2 | 672.59 | 16.55 |
| speed 2000 | 2185.6 | 670.58 | 40.00 |
| speed 3000 | 5662.2 | 669.47 | 40.00 |
| heading 0 | 1.0 | 675.69 | 40.00 |
| heading −90 | 1455.0 | 673.29 | 40.00 |
| heading 180 | 1.0 | 672.51 | 15.50 |
| turn 3 g | 1.1 | 673.31 | 17.06 |
| weave 3 g | 1.0 | 673.63 | 17.66 |
| N = 2 | 206.0 | 673.76 | 40.00 |
| N = 6 | 4.3 | 673.72 | 40.00 |
| max load 10 g | 2123.4 | 673.70 | 10.00 |

### Findings

- **The airframe is lift-limited; the endgame is divert-limited.** At ~16 km and Mach 9.4 the fins can trim only a few degrees of AoA, giving ~5 g. The recorded homing needs ~10–17 g, so the DACS divert thrusters (30 g cap, impulse budget reported) supply the difference. This is consistent with the SM-3 kinetic warhead's divert-and-attitude-control system, not a fin-only vehicle.
- **Yaw must be modelled with a moment derivative, not `Cn_delta`.** The aero table's `cnDelta` (≈1.3) is a fin normal-*force* derivative; using it as a yawing moment made the yaw loop ~8× too weak and diverged. Pitch and yaw are now symmetric: static terms use the tabulated `Cm` curve, fin moments use `|Cm_delta|`, and the yaw rate command carries the opposite sign of the pitch one (β̇ ≈ −r).
- **Hard geometries are reported, not forced.** Late hand-over (5 km), very high/low altitude, a receding 3000 m/s target, and a −90° crossing all saturate the load cap and miss by hundreds of metres to tens of kilometres. The solver reports these rather than bending the trajectory.
- **Payload metrics are not sample-consistent**: the recorded `maxMach` (9.4806) and `maxDynamicPressurePa` (872 728) exceed the 0.45 s sample maxima (9.445 / 632 358), so the payload metrics came from a finer integration. Solved metrics are recomputed from the merged samples and match what the UI plots.

### Limits

- Terminal leg only (from seeker lock); boost and midcourse remain the recorded payload.
- Inertia is a slender-body estimate (uniform-rod pitch/yaw, thin-tube roll); hinge moments, servo backlash/gap, and validated DACS thrust/Isp are not modelled. Aerodynamics remain an engineering estimate (F2 in the upgrade plan), not wind-tunnel data.
- Divert is a body-frame acceleration allocation (residual after the aero trim), capped at 30 g; it is a representative DACS model, not a thruster-by-thruster simulation.
