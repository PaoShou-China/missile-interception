# 安全策略

## 支持范围

本项目为仿真与算法验证软件，不涉及联网服务或生产部署。安全修复仅针对 `main` 分支的最新版本。

| 版本 | 支持 |
| --- | --- |
| `main` 最新提交 | ✅ |
| 历史提交 / fork | ❌ |

## 报告漏洞

**请勿通过公开 Issue 报告安全问题。**

优先使用 GitHub 的私密报告通道：

1. 打开仓库的 **Security** 标签页
2. 选择 **Report a vulnerability**
3. 填写影响范围、复现步骤与建议修复

也可以在紧急情况下发送邮件至 <PaoShou@buaa.edu.cn>，标题注明 `[SECURITY] missile-interception`。

我们会在收到报告后尽快确认，并在修复发布后于 [CHANGELOG.md](CHANGELOG.md) 中说明。

## 适用范围

- 依赖库（NumPy / SciPy / Numba 等）的漏洞请直接上报给对应上游项目
- `tools/datcom/` 中的第三方可执行文件不在版本库内，相关风险由其作者承担
- 本项目为公开数据的工程外推仿真，**不得**用于任何实际装备的设计、测试或评估
