# 可复现性与来源快照

仓库根目录的 `tools/` 提供独立的文件快照与环境记录工具（`tools/provenance.py`、`tools/environment_snapshot.py`）。它们使用 Python 标准库，不导入或运行仿真，不计算或修改任何仿真性能指标。工具测试只需安装 `pytest`。

## 证据的边界

早期历史静态 HTML 报告（`intercept-report/`、`missile-intercept-overview/`、`test-report/`）及其静态审计脚本 `tools/audit_reports.py` 已在 v0.3.0 清理移除；当前所有在线展示数据均由 [build_scenario.py](../aerospace-vision-web/tools/data-adapter/build_scenario.py) 从最新仿真二进制遥测 `missile_intercept/output/telemetry.npz` 生成，并经 [verify_scenario.py](../aerospace-vision-web/tools/data-adapter/verify_scenario.py) 的 11 项物理与帧契约校验。

`posthoc_snapshot` 表示事后记录当前文件。`snapshot_verified` 表示审计范围内的文件通过对应快照核验；它不表示已重现某次实验。哈希可检测快照生成后的文件变化，但不证明文件或清单的来源真实性，也不验证物理模型。不要使用这些状态替代原始执行记录、独立实验验证或数字签名。

## 查看当前环境

以下命令均从仓库根目录执行：

```bash
python -m tools.environment_snapshot
```

工具记录当前解释器、平台和已安装发行包的版本，并显式列出未安装包。它只读取包元数据，不导入 NumPy、Numba 等运行时。版本记录不代表已检查依赖兼容性。

## 建立并核验事后快照

下面用文档和依赖声明演示文件记录流程。输出存放在已有忽略规则覆盖的 `output/` 下：

```bash
python -m tools.provenance capture --root . --artifact README.md --input missile_intercept/requirements.txt --output missile_intercept/output/provenance/documentation_snapshot.json
python -m tools.provenance verify --root . --manifest missile_intercept/output/provenance/documentation_snapshot.json
```

`capture` 记录指定产物、输入和当前源文件的哈希，以及快照生成时的环境。`--artifact` 和 `--input` 可重复使用。记录的是快照生成环境，不是原始产物生成环境。不要事后编造原始运行命令、配置或随机种子。

## 仿真与前端载荷校验

```bash
# 根级来源工具测试（36 passed）
python -m pytest -q tests

# 后端 6DOF 物理与双路径同构测试（103 passed）
cd missile_intercept && python -m pytest -q

# 前端场景数据 11 项物理一致性校验
python aerospace-vision-web/tools/data-adapter/verify_scenario.py
```

`.github/workflows/provenance.yml` 配置 Python 3.11/3.12 和 Windows/Linux 的工具检查。该矩阵仅说明检查目标；一次本地通过或工作流配置存在本身不等于所有矩阵任务已经通过。
