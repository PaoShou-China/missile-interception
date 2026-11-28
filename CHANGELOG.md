# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.0] - 2026-11-28

### Added

- **High-adversarial & hypersonic 6DOF physics** (strictly isomorphic in Python & Numba `fastcore.py`):
  - 1D transient thin-wall nose-cap thermal conduction coupled to sapphire MWIR seeker window transmittance & thermal background noise, plus joint $q_{\max}$–$\dot{q}_{\max}$ midcourse/throttle corridor (peak $q_\infty$ reduced from 881 kPa to 632.5 kPa)
  - Discrete Stage-1 booster separation at 13 s (95 kg casing jettison with CG/inertia step), scramjet inlet pressure recovery & Unstart hysteresis (`unstart_flag`), JP-10 Mach-dependent $I_{sp}$, oblique-shock stoichiometric air-capture ceiling, Eckert compressible skin friction, Mach-dependent induced drag, Hoerner base-drag relief, and coast/unstart inlet spillage drag
  - Terminal IR flare & radar chaff countermeasure ejection (`vehicle/target.py::decoy_state`), Blom–Bar-Shalom 3-model IMM target tracker (CV + CA/Singer + 3D-CT), dual-band/Doppler anti-decoy gating, and ±30° gimballed AESA/MWIR seeker FOV
  - 32 Hz / $\zeta=0.7$ 2nd-order electromechanical fin servos with >400 kPa hinge-moment torque cap, tail-fin NMP predictive compensation + Zarchan finite-horizon OGL glint roll-off, optional 22 Hz elastic bending mode + notch filter, and 3D directed-fragmentation proximity fuze lethality (`vehicle/warhead.py`)
- **3D physical-field visualization & high-fidelity vehicle meshes** (both `aerospace-vision-web` and `interceptor-vision`):
  - Custom GLSL Mach-dependent shock cone, Planck blackbody nose-cap heating, X-Ray 3D lift/drag/thrust/NMP fin force vectors & dynamic CG/CP markers (hotkey `X`)
  - Procedural 8.11 m Von Kármán ogive scramjet interceptor (twin 2D inlets, dorsal spine, strakes, separating booster, volumetric GLSL Mach-diamond plume) and 15.7 m F-35A (Have Glass V chined fuselage, gold ITO canopy, DSI inlets, sapphire EOTS, 15-petal F135 nozzle + GLSL afterburner, live IR flares)
  - Dual-mode `SeekerOverlay` & `SensorAnalyticsCards` with anti-decoy gate rendering + B-Plane miss-budget waterfall linked to `tools/miss_budget.py`, 3D Monte-Carlo trajectory bundles & handover point clouds in `#/compare`, and semantic event timeline + `0.1×` bullet-time + `?t=&view=&compare=` deep links
- **Full-stack 6-item performance acceleration**:
  - Fused zero-allocation `nogil=True` Numba RK4 (`rk4_multi_step_system_into`) & 3-model IMM (`imm_predict_all`) kernels + optional `--threads` pool
  - Phase-adaptive 20 ms pure-cruise step size (seamless 10 ms / 5 ms transition for dive, handover & terminal)
  - Zero-allocation `telemetry_profile="none"` with $O(1)$ scalar summaries for batch/validation + scalar-math hotspot elimination (`math_utils`, `midcourse_guidance`, `seeker`)
  - Binary compressed `.npz` telemetry I/O by default (`--csv` opt-in), with 0.79 s `build_scenario.py` float64 ingestion
  - 25 Hz decoupled low-res FPA sensor canvases (`128×84` / `128×96` reusable `ImageData`), zero-React-rerender playback (`useRef` + `subscribe` + `rAF`), and `InstancedMesh` instancing for F-35A nozzle petals & IR flares

### Changed

- Nominal 6DOF intercept refined to **1.48 m** miss at `680.47 s` (`Pk(fuze) = 99.5%`); 48-case validation matrix passes **6/6 suites (45/48 = 93.8%)** in `200.3 s` (2.31× faster; single-shot zero-alloc 5.33× faster at `21.42 s`)
- Updated backend tests to **103 passed** (`missile_intercept`), **36 passed** (`tests/`), **11/11** `verify_scenario.py`, **66/66** Vitest, **28/28** aero & **12/12** 6-DoF explorer validators

### Removed

- Legacy static HTML reports (`intercept-report/`, `missile-intercept-overview/`, `test-report/`), root `index.html`, `/explore-legacy` route (`ExploreApp.tsx`), and obsolete `tools/audit_reports.py` / `tests/test_report_audit.py`

## [0.2.0] - 2026-11-22

### Added

- **Aerospace Vision Web**: bilingual academic site, 3D telemetry explorer, cinematic mode,
  quality tiers and GitHub Pages deployment from `aerospace-vision-web/`
- **Experiment Configuration Studio** (`#/compare`): registry-driven A/B dropdowns for
  guidance, attitude control, vehicle profile and scenario; Compare / Swap / save reference
- Registry + comparison contracts: `experiment registry`, `comparison manifest`, scenario
  types, matcher levels A/B/C, condition and provenance tables
- **New comparison baselines**: PIP midcourse guidance, pure-PN terminal guidance,
  fixed-rate boost programme and classical fixed-gain PID autopilot
- Paired Monte-Carlo campaigns: guidance, boost, attitude-control and full-architecture
  comparisons, including the paired-campaign aggregate table in the Studio
- Representative-case exporter (`tools/export_campaign_case.py`) and architecture campaign
  driver (`tools/architecture_comparison.py`)
- Earth realism pass: bump-mapped surface, ocean sun-glint shader, layered clouds and
  atmosphere driven by the astronomical sun direction
- Merged close-up camera: tail fins, nozzle/plume and body axes in one rear three-quarter view
- 390 px small-screen layout: larger dropdowns/controls, taller stacked 3D panes,
  scroll-contained wide tables, larger chart labels
- Tests: registry/campaign unit coverage, mobile readability E2E, four-camera E2E

### Changed

- Camera set reduced from six to four: Earth, Chase, Intercept, Close-up
- Explorer payload refreshed to the current deterministic baseline
  (1,504 samples, 672.75 s, 26.73 m logged miss)
- Comparison fingerprint ignores flight duration so different intercept times remain comparable
- Documentation rewritten: root README, web README, architecture, comparison, acceptance,
  scientific status and technical report

### Fixed

- Synthetic records cannot be marked validated or used for performance claims
- Unsupported A/B combinations show `No Available Experiment` and disable Compare
- Narrow screens no longer squeeze both 3D panes into one fixed-height stage or widen the page

## [0.1.0] - 2026-11-12

### Added

- 6DOF 刚体动力学与垂直冷发射初始段
- 固体助推 + 超声速冲压组合循环动力模型
- USSA1976 大气模型、气动数据库与 DATCOM 交叉校核工具
- GNSS/INS 组合导航、雷达导引头与目标跟踪
- Bezier 中制导、ZEM/APN 末制导与制导交接班管理
- 三回路姿态控制、舵机限幅与增益调度
- 多速率积分器、步长收敛与 Richardson 外推
- 蒙特卡洛批量打靶、灵敏度 / Sobol 分析
- 遥测输出、可视化与 HTML 分析报告
- pytest 测试集与数值验证工具
