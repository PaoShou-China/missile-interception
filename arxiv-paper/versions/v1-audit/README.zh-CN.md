# Missile Intercept：模块化仿真软件及其计算证据审计

本文件夹是独立的匿名英文论文草稿及配套材料，整理自上级 `missile-interception-main` 源码归档。正文围绕软件架构、数据接口、报告来源和可复现性展开。原仿真代码和历史报告保持原样；本文没有向 arXiv 或其他平台提交。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| `paper.pdf` | 编译好的英文论文，含摘要、引言、相关工作、架构、审计方法、实验、讨论、局限、参考文献及附录 |
| `main.tex` | 可编辑的 LaTeX 正文，当前署名为 Anonymous Authors |
| `references.bib`、`main.bbl` | 6 条核对过来源的参考文献及编译后的文献列表 |
| `arxiv-source.zip` | 精简的 arXiv 源码包，只含编译必需的 TeX、BibTeX、BBL 和图件 |
| `figures/` | 三张矢量图：软件结构、证据边界、审计结果 |
| `evidence/` | 本次检查的 JSON、JUnit XML、证据映射及编译检查记录 |
| `reproducibility/` | 原样复制的通用审计工具、测试及其 MIT 许可证 |
| `scripts/` | 静态证据收集、数字汇总、图件生成、编译打包和完整性验证脚本 |
| `package_manifest.json` | 交付文件的事后哈希快照，不是数字签名 |
| `build/` | 本地编译日志和排版预览；不进入 arXiv 源码包 |

## 这篇论文实际建立了哪些结果

- 对原归档的 85 个选定文件记录了路径、大小和 SHA-256；这不是整个归档的完整镜像。
- 三个历史 HTML 报告合计涉及 13 个本地文件。静态范围内未发现缺失文件，但三个报告均无匹配来源清单，状态仍为 `legacy_unverified`。
- 独立通用工具的测试结果为 **48 passed、1 skipped、0 failed**。跳过原因是当前环境无法创建目录符号链接。
- 另有 **10/10** 个非物理、通用文件完整性场景得到预期结果。
- 仿真测试目录有 12 个文件、78 个测试函数定义；这是静态统计，不能解释为 78 项测试通过。

历史网页中的拦截性能、蒙特卡洛统计、原始运行时间和样本说明，没有与之配对的完整原始执行记录。论文没有将这些数字改写成已经验证的新实验，也未运行或优化仿真模型。全文不声称物理精度或实际拦截能力得到验证。

## 编译论文

安装 TeX Live 或 MiKTeX 后，在本文件夹运行：

```powershell
python scripts/build_paper.py --verify-zip
```

脚本生成 `paper.pdf` 和 `arxiv-source.zip`，并从打包后的文件再次独立编译。只编译论文不需要安装仿真依赖，也不需要访问原源码目录。也可解压 `arxiv-source.zip` 到新目录，用 pdfLaTeX 编译 `main.tex` 两遍；其中已提供 `main.bbl`。

如需重新生成图件，额外安装 ReportLab，然后运行：

```powershell
python scripts/draw_figures.py
```

论文采用标准 `article` 文档类和 TeX Live 常见宏包，无外部样式文件、在线字体、shell-escape 或动态资源。精简源码包按 [arXiv 的 TeX 提交说明](https://info.arxiv.org/help/submit_tex.html)准备，不包含编译 PDF、日志和其他中间文件。这里只完成本地编译验证，不保证 arXiv 平台审稿、分类或接收结果。

## 重做本次检查

请在工作副本中重做，以保留交付时的证据记录。原归档默认位于本文件夹的上级；也可以用 `--source-root` 指定位置。

```powershell
python scripts/prepare_evidence.py --source-root ..
Push-Location reproducibility
python -m pytest -q tests -p no:cacheprovider --junitxml=../evidence/tooling_tests.xml
Pop-Location
python scripts/probe_tooling.py --source-root ..
python scripts/summarize_evidence.py
```

前两项来源收集和历史报告审计需要原归档。`reproducibility/` 中的工具测试与十个合成快照场景可独立运行。没有原归档时，`probe_tooling.py` 会将历史报告严格检查记为不可用，而不会编造结果。上述命令不导入、不运行仿真包。

通用工具只使用 Python 标准库，测试额外依赖 pytest。本次实际测试环境为 CPython 3.11.7、pytest 7.4.0、Windows。图件排版使用独立的文档运行环境，两者不能混为仿真的原始执行环境。

## 验证交付文件

```powershell
python scripts/verify_package.py
python scripts/verify_package.py --source-root ..
```

第一条核对本文件夹的交付文件；第二条还核对原归档中选定的 85 个文件。修改论文后可用 `--write` 为新版本建立新快照；不要用新快照冒充旧版本的原始记录。

## 投稿前需要作者决定的事项

当前按要求匿名，未虚构作者、单位、邮箱、基金或致谢。正式提交时请按实际情况完善这些信息，审核论文定位和事实表述，并选择适当分类与许可。当前稿件定位是**软件与计算证据审计研究**；如改为声称仿真性能或方法优越性的论文，则需要相应、真实、可追溯的实验和独立验证，现有历史网页不足以支撑这些结论。
