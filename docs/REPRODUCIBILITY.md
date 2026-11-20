# 可复现性与报告来源

仓库根目录的 `tools/` 提供独立的文件快照、环境记录与静态报告审计工具。它们使用 Python 标准库，不导入或运行仿真，不计算或修改任何仿真性能指标。工具测试只需安装 `pytest`。

## 证据的边界

已提交的三个 HTML 报告没有与之匹配的原始执行来源记录。它们保留历史数值，并标记为 `legacy_unverified`。报告内部声称的日期、命令和样本数也是待核实的历史描述，不构成原始证据。

当前源代码、现有输出文件、文件修改时间、当前安装环境都无法反推出历史实验使用的完整配置、随机种子或依赖。这个目录是没有 `.git` 的源码归档；工具不能据此恢复其原始提交。若有有效的 Git 工作区，提交号与工作区状态仍应与实际文件哈希一起记录。

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

该示例只登记 `README.md`，不能用来验证 HTML 报告。报告快照应覆盖页面本身及审计工具列出的全部本地依赖；对应清单约定存放在报告目录的 `provenance.json`。源代码或产物发生变化后，应保留旧清单作为历史记录，并在新的输出目录生成新清单。验证失败时应先查看差异原因，不要仅为消除失败而覆盖旧记录。

## 审计静态报告

```bash
python -m tools.audit_reports --root .
```

审计包含三个报告入口、相关本地文件和对应清单。默认输出 JSON；可通过 `--output PATH` 保存。没有匹配清单的报告显示 `legacy_unverified`，文件缺失、内容变化或清单覆盖不足会保留明确的问题记录。需要把未验证报告视为检查失败时，使用：

```bash
python -m tools.audit_reports --root . --strict
```

`--strict` 在当前历史报告状态下可能返回非零退出码，这是对证据缺失的明确表达。审计不访问远程资源，也无法保证发现所有由 JavaScript 动态加载的依赖；具体覆盖范围和限制以 JSON 输出为准。

## 测试与持续集成

```bash
python -m pytest -q tests
```

根目录 `tests/` 覆盖独立来源工具。仿真原有测试在 `missile_intercept/tests/`，两者不可混同。

`.github/workflows/provenance.yml` 配置 Python 3.11/3.12 和 Windows/Linux 的工具检查。该矩阵仅说明检查目标；一次本地通过或工作流配置存在本身不等于所有矩阵任务已经通过，更不能推导完整仿真的环境兼容性、数值精度或物理有效性。
