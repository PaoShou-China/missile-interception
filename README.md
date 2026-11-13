# 2000 km 级高超声速拦截器 — 6DOF 端到端仿真

**Hypersonic Interceptor 6DOF Simulation** · 垂冷发射 / 组合动力 / GNSS-INS + 雷达导引头 / 中末制导 / 蒙特卡洛打靶

基于纯 Python + NumPy 的模块化、可测试、可并行的飞行器六自由度仿真。覆盖垂直冷发射、固体助推 + 超声速冲压组合循环动力、GNSS/INS 组合导航、雷达导引头、三回路姿态控制、Bezier 中制导、ZEM/APN 末制导、交接班管理、多速率采样与蒙特卡洛打靶。

> **在线报告**：<https://paoshou-china.github.io/missile-interception/>
>
> **免责声明**：2000 km 级拦截器的公开数据十分有限。`config.py` 中的几何、质量、惯量、气动与动力参数是对公开资料的**工程外推**，仅用于算法、软件与体系验证，不代表任何现役装备的实测数据或性能。

## 页面与报告

| 报告 | 内容 | 链接 |
| --- | --- | --- |
| 项目概览 | 交互式总览：弹道、能量、制导交接与关键指标 | [/missile-intercept-overview/](https://paoshou-china.github.io/missile-interception/missile-intercept-overview/missile-intercept-overview.html) |
| 拦截分析报告 | 2000 km 级 6DOF 仿真分析：弹道剖面、脱靶量、蒙特卡洛统计 | [/intercept-report/](https://paoshou-china.github.io/missile-interception/intercept-report/intercept-report.html) |
| 全流程测试报告 | 分系统与全链路测试结果汇总 | [/test-report/](https://paoshou-china.github.io/missile-interception/test-report/missile_interceptor_test_report.html) |

## 仓库结构

```
.
├── missile_intercept/           # 仿真主体
│   ├── main.py                  # 单发仿真入口
│   ├── batch.py                 # 蒙特卡洛批量打靶
│   ├── analysis.py              # 灵敏度 / Sobol / 蒙特卡洛分析
│   ├── config.py                # 全部工程参数与开关
│   ├── fastcore.py              # Numba JIT 热路径（缺失时回退纯 Python）
│   ├── integrator.py            # 多速率积分与事件处理
│   ├── state_schema.py          # 状态量定义
│   ├── telemetry.py             # 遥测输出
│   ├── verification.py          # 数值验证
│   ├── validate_performance.py  # 性能指标校验
│   ├── vehicle/                 # 大气、气动、目标、风场
│   ├── sensors/                 # IMU、GNSS/INS、导引头、目标跟踪
│   ├── guidance/                # 助推/中制导/末制导/交接班
│   ├── control/                 # 自动驾驶仪、舵机分配、推力控制
│   ├── tools/                   # 气动交叉校核、参数整定、诊断工具
│   ├── tests/                   # pytest 测试集
│   └── README.md                # 完整技术说明与遥测字典
├── intercept-report/            # 拦截分析报告（HTML）
├── missile-intercept-overview/  # 项目概览页（HTML）
├── test-report/                 # 全流程测试报告（HTML）
└── index.html                   # GitHub Pages 首页
```

详细架构、坐标系、动力学模型、遥测字段字典请见 [missile_intercept/README.md](missile_intercept/README.md)（英文版：[README.en.md](missile_intercept/README.en.md)）。

## 快速开始

```bash
cd missile_intercept
python -m pip install -r requirements.txt

python main.py                      # 单发仿真（助推/末段 5 ms，中制导 10 ms）
python main.py --no-plot            # 只输出遥测 CSV
python main.py --converge           # 步长收敛 + Richardson 外推

python batch.py --cases 50 --workers 8 --seed 2026   # 蒙特卡洛打靶
python -m pytest -n auto            # 测试
python verification.py              # 数值验证
```

输出写入 `missile_intercept/output/`（遥测 CSV、图表与 HTML 看板），该目录不入库。

## 说明

- 运行环境为 Windows / Linux + Python 3.9+（代码保留 3.6+ 语法兼容）。
- `numba` 用于加速热路径；未安装时自动回退纯 Python，结果一致但更慢。
- `tools/datcom/` 中的 DATCOM 可执行文件为第三方二进制，未纳入版本库。
- CI 在 push / PR 时自动运行测试集，见 [.github/workflows/tests.yml](.github/workflows/tests.yml)。

## 参与贡献

欢迎提交 Issue 与 Pull Request。开发约定、提交规范与测试要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
