# Missile Intercept：具有显式数据契约与可追溯输出的模块化仿真软件

这是重写后的匿名英文软件论文及配套材料。正文采用“研究动机—相关软件—设计需求与架构—实现—工作流—软件实验—讨论”的组织方式，深入说明通用的数据表示、接口、内存、所有权和导出机制。原应用的领域算法保留模块级描述。

## 从这里开始

| 文件 | 内容 |
| --- | --- |
| `paper.pdf` | 当前编译后的论文 |
| `main.tex` | 当前 LaTeX 正文，署名 Anonymous Authors |
| `references.bib`、`main.bbl` | 文献数据库和当前文献列表 |
| `arxiv-source.zip` | 精简源码包；包含正文实际引用的四张图及全部编译输入 |
| `figures/architecture.pdf` | 系统架构图：配置、数据表示、协调器、模块族与输出层 |
| `figures/data_contracts.pdf` | 字段元数据、数组布局和 pack/unpack 关系 |
| `figures/telemetry_pipeline.pdf` | 日志写入、固定容量、视图/副本、CSV 导出 |
| `figures/software_evaluation.pdf` | 新接口检查与原通用工具测试的证据边界 |
| `evidence/software_probes.json` | 本次新增接口检查、源码选取记录、环境和内存分配结果 |
| `REVISION_NOTES.zh-CN.md` | 本轮重写说明及参考论文链接 |
| `versions/v1-audit/` | 上一版 PDF、正文、源码压缩包和说明，供对照 |

目录中此前生成的 `evidence_flow.pdf`、`audit_results.pdf` 属于旧稿图件，当前正文和当前源码包均不引用。

## 新增的实现内容

- `StateField` 的五项元数据、冻结描述符、字段顺序与布局哈希。
- `StateSchema` 的切片生成、键和形状检查、标量处理、打包/解包的不同校验范围。
- `TelemetryLogger` 的预分配数组、占用行数、溢出计数、写入返回值和异常。
- `get()` 返回共享视图，`as_dict()` 和解包后的数组返回副本；这三种所有权语义在正文明确区分。
- float64 数据数组的 `8NC` 字节载荷，以及导出副本和 Python 对象不计入该值的范围。
- CSV 的六位小数格式、示例舍入行为和加速路径的验证边界。
- 可核查的接口示例、API 表、模块职责表、相关软件定位表和实验记录。

## 本次实际执行的检查

新实验仅从原文件通过 AST 选取四个通用数据处理类，在显式提供的标准库/NumPy 命名空间中使用无量纲合成记录。没有导入或运行仿真模型、轨迹或领域决策算法。

- **23 项接口检查：21 项满足检查要求，2 项更强的诊断要求未被实现强制执行。** 两个边界分别是解包时的非有限输入，以及 Python 日志路径中的 NaN 时间戳。正文保留这些结果，原代码未作修复。
- **12 个数组分配案例：** 四种容量乘以三种列数，实测 NumPy 数组 `nbytes` 均与公式相符。该实验测量数组载荷，不代表进程总内存或运行速度。
- 新实验环境：CPython 3.12.14、NumPy 2.3.5、Windows/AMD64。
- 原独立来源工具的记录仍为 **48 passed、1 skipped**，对应另一个 CPython 3.11.7 / pytest 7.4.0 环境，正文将两次运行分开表述。

三个历史报告仍缺少匹配的原始执行来源记录。其性能数字未纳入新实验。因此当前稿件定位为软件论文，不声称已经建立标准化性能 benchmark。

## 重新生成

建议在工作副本中运行，以保留交付记录。默认原归档位于论文文件夹的上级；也可通过 `--source-root` 指定路径。

```powershell
python scripts/probe_data_contracts.py --source-root ..
python scripts/draw_figures.py
python scripts/build_paper.py --verify-zip
```

第一步需要 NumPy，第二步需要 ReportLab，第三步需要 TeX Live 或 MiKTeX 中的 pdfLaTeX 和 BibTeX。编译现有正文只需最后一步，不需要重新运行实验或访问仿真目录。源码包解压后也可以直接编译 `main.tex`，其中已提供 `main.bbl`。

原有通用工具测试单独运行：

```powershell
Push-Location reproducibility
python -m pytest -q tests -p no:cacheprovider --junitxml=../evidence/tooling_tests.xml
Pop-Location
```

交付检查：

```powershell
python scripts/check_pdf.py
python scripts/verify_package.py --source-root ..
```

PDF 检查需要 pypdf、pdfplumber 和 Poppler。`package_manifest.json` 是交付文件的事后哈希快照，不是数字签名；`--source-root` 还会核对原归档中选定的 85 个文件。排版预览和编译日志保存在 `build/`，不进入精简源码包。

## 文献、署名与投稿状态

本轮主要参考 Stable-Baselines3、CleanRL、OpenML Benchmarking Suites 和 JSBSim 的软件描述与组织方式；准确链接见重写说明及论文文献列表。四张图是本项目重新绘制的原创矢量图。

保持匿名署名。当前交付完成本地编译、源码包解压编译和排版检查，未向 arXiv 或其他平台提交。投稿前需要作者确认署名、单位、许可、分类和全部事实表述。
