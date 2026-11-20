# 本轮重写说明

上一版过度围绕来源审计展开，软件本身的设计、接口和实现解释不足。当前稿件已按软件论文重新组织，作者仍匿名，旧稿保留在 `versions/v1-audit/`。

## 参考的论文及借鉴内容

| 原始论文 | 本稿采用的组织思路 |
| --- | --- |
| [Stable-Baselines3: Reliable Reinforcement Learning Implementations](https://jmlr.org/papers/v22/20-1364.html)，JMLR 2021 | 先交代软件目的，再说明接口、功能及可验证的实现质量。 |
| [CleanRL: High-quality Single-file Implementations of Deep Reinforcement Learning Algorithms](https://jmlr.org/papers/v23/21-1342.html)，JMLR 2022 | 用具体实现和使用片段解释软件选择，并让实验记录可检查。 |
| [OpenML Benchmarking Suites](https://datasets-benchmarks-proceedings.neurips.cc/paper_files/paper/2021/hash/c7e1249ffc03eb9ded908c236bd1996d-Abstract-round2.html)，NeurIPS Datasets and Benchmarks 2021 | 明确区分软件、任务、协议及运行记录，据此界定当前稿件的主张。 |
| [JSBSim, An Open Source Flight Dynamics Software Library](https://doi.org/10.21105/joss.11129)，JOSS 2026 | 将软件需要、架构职责和适用范围作为正文内容。 |

这里借鉴的是软件论文的叙述和证据组织方式，没有复制这些论文的文字、图件或实验数据，也没有把它们当作本项目的性能基线。

## 主要变化

| 方面 | 当前版本 |
| --- | --- |
| 论文主线 | 模块化架构、数据契约、日志实现、软件实验 |
| 系统图 | 配置/表示/协调器/数值后端/四个模块族/输出层的完整关系图 |
| 实现图 | 元数据到数组布局图；日志写入与所有权流程图 |
| 实现解释 | 数据结构、输入检查顺序、复制语义、复杂度、内存载荷、导出精度 |
| 接口示例 | 取自实际通用类的无量纲示例，附可重做脚本 |
| 实验 | 新增 23 项接口检查和 12 个数组分配案例，保留两项未满足的诊断要求 |
| 来源审计 | 缩至支持性证据与局限，不再主导摘要、引言和方法章节 |
| 相关工作 | 引入四篇实际软件/benchmark 论文，并增加定位比较表 |
| 可复查性 | 源码选取位置、原文件哈希、逐项观察、环境及编译检查均随稿提供 |

当前正文深入通用的数据和记录机制，领域算法以模块职责呈现。历史仿真报告缺乏原始运行链条的问题仍如实保留，因此当前稿件使用软件论文定位。
