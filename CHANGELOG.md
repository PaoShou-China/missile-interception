# 更新日志

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 仓库级 README、MIT 许可证、贡献指南、行为准则、安全策略与 Issue/PR 模板
- GitHub Pages 站点首页与 `.nojekyll`，发布概览、分析与测试三份报告
- GitHub Actions CI：在 push / PR 时运行测试集

### Changed

- 自动驾驶仪调节参数（`AP_KP_ANGLE` / `AP_KP_RATE`）迁入 `config.py` 统一管理
- 导航与姿态控制模型重构，更新中制导交接逻辑
- 移除 `tools/tune_gain_schedule.py`（由 `tune_autopilot.py` 取代）

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
