# arXiv 论文包（匿名稿）

本目录是对 `missile-interception-main` 程序的独立论文整理，主线为：

1. 确定性多速率闭环架构；
2. 契约驱动的状态与遥测接口；
3. 分层验证与可追溯工作流。

正文严格采用“引言—问题描述—方法—仿真与验证—结论”结构。历史网页报告因缺少原始执行记录继续标记为 `legacy_unverified`，其中的性能数值没有被用作论文结论。

## 主要文件

- `paper.pdf`：可阅读的 11 页匿名论文。
- `main.tex`、`references.bib`、`verification_numbers.tex`：论文源文件。
- `arxiv-source.zip`：已通过独立解压重编译的 arXiv 源包。
- `figures/`：四张原创矢量图。
- `evidence/numerical_verification.json`：5 个数值验证案例的新执行记录。
- `evidence/simulation_tests.xml`：83 个程序测试的新执行记录。
- `scripts/`：作图、编译和 PDF 检查脚本。
- `versions/v2-software/`：本次重写前的软件论文版本。

## 已完成检查

- 内置数值验证：5/5 通过。
- 完整应用测试：83/83 通过。
- arXiv 源包独立编译：通过。
- LaTeX 警告、字体嵌入、页面越界、PDF 文本一致性：通过。
- 逐页 PNG 视觉检查：通过。

## 重建

先在 `missile_intercept/` 运行验证，再在本目录构建论文：

```text
python verification.py --json ../arxiv-paper/evidence/numerical_verification.json
python -m pytest -q tests -p no:cacheprovider --junitxml=../arxiv-paper/evidence/simulation_tests.xml
python scripts/draw_figures.py
python scripts/build_paper.py --verify-zip
python scripts/check_pdf.py
```

作图需要 ReportLab，PDF 检查需要 Poppler、pdfplumber 和 pypdf，论文编译需要 pdfLaTeX 与 BibTeX。
