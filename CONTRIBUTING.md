# 贡献指南

感谢你对本项目的关注。以下约定适用于所有贡献（代码、文档、报告、问题反馈）。

## 开发环境

```bash
git clone https://github.com/PaoShou-China/missile-interception.git
cd missile-interception/missile_intercept
python -m pip install -r requirements.txt
python -m pytest -n auto
```

- Python 3.9+（代码保留 3.6+ 语法兼容）
- `numba` 可选：未安装时自动回退纯 Python，结果一致但更慢

## 分支与提交

- 从 `main` 拉出特性分支：`feature/<short-name>`、`fix/<short-name>`
- 提交信息使用祈使句、聚焦"为什么"：

```
Fix handover timing when midcourse step is coarsened

The handover manager compared absolute time stamps against a step-scaled
tolerance, which delayed the switch by up to two frames.
```

- 不要提交 `output/`（遥测 CSV、图表）、`__pycache__/`、`_tune_*` 等本地生成物

## 代码要求

- 参数集中放在 `config.py`，避免在模块内散落魔数
- 新增物理/制导/控制逻辑必须附带单元测试（`tests/`）
- 修改数值路径后运行 `python verification.py`，确认守恒量与收敛性无明显退化
- 保持 NumPy 向量化风格；热路径改动需同时验证 `fastcore.py` 与纯 Python 回退结果一致
- 不引入与现有风格冲突的格式化改动，保持 diff 聚焦

## 文档

- 行为或参数变更同步更新 `missile_intercept/README.md` 与 `README.en.md`
- 新增遥测字段需补充 README 中的遥测字典

## 提交前检查

```bash
python -m pytest -n auto
python verification.py
```

## 问题反馈

- Bug 请使用 Issue 模板，附运行命令、Python 版本、`config.py` 关键参数与复现步骤
- 安全问题请勿公开提交，见 [SECURITY.md](SECURITY.md)

## 许可证

提交即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
