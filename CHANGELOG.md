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
