# 斯坦福小镇：Agent Memory 实验平台

本项目以 AI Town 为可视化环境，测试不同记忆管理方案能否减少上下文和推理消耗，同时保持角色的事实记忆、关系一致性与任务完成能力。研究也覆盖长时间运行中可能出现的隔离、超时、数据增长和实验偏差。

## 当前状态

**P0 研究规范与配置检查已完成；P1 模型技术诊断已通过，题集人工审核待完成；P2 本地小镇工程验收已通过；P3 计量与诊断回放已实现。** 上游 AI Town 已克隆并通过构建，已创建 5 个角色；本地原版记忆适配、预算检索和多查询开发 runner 已实现，分层记忆最小原型已实现，真实抽取可靠性与正式质量矩阵仍待验收。实际阶段证据见 [验收记录](docs/ACCEPTANCE.md)，配置参数不代表测量结果。

```bash
npm start
npm run check
npm run check:config
npm test
npm run tokenizer:setup
npm run model:check
npm run model:pilot
```

基础文件检查仅使用 Node.js 内置模块。模型诊断需先 `npm install` 和准备官方 tokenizer、Ollama 模型；建议 Node.js 22 或以上。`check` 通过只说明基础文件和配置关键字段有效，不代表小镇部署成功。

## 阅读入口

| 文件 | 用途 |
| --- | --- |
| [MISSION.md](MISSION.md) | 项目目的、研究问题、成功标准和边界 |
| [ROADMAP.md](ROADMAP.md) | 阶段依赖、交付物与验收条件 |
| [SKILLS.md](SKILLS.md) | 各阶段能力要求与技能使用路线 |
| [AGENTS.md](AGENTS.md) | 人与编码 Agent 共同遵循的开发约定 |
| [架构](docs/ARCHITECTURE.md) | 组件、数据流、隔离边界与代码落点 |
| [Memory 学习教程](docs/MEMORY_ARCHITECTURE_REVIEW.md) | 当前架构、逐步对话示例、方案取舍、实验操作与问题排查 |
| [记忆协议](docs/MEMORY_PROTOCOL.md) | 记忆数据结构、策略接口和预算规则 |
| [实验规范](docs/EXPERIMENTS.md) | 对照设计、指标、评估和结果判定 |
| [优化实施计划](docs/OPTIMIZATION_PLAN.md) | P4 工作包、优化假设、对照条件和逐项验收 |
| [问题清单](docs/RISKS.md) | 潜在缺陷、复现方式和优先级 |
| [本地部署](docs/LOCAL_SETUP.md) | Mac、Ollama、Convex、AI Town 的操作顺序 |
| [决策记录](docs/DECISIONS.md) | 已选方案、理由及待解决问题 |
| [实验配置](configs/experiment.example.json) | 尚未接入执行器的配置契约样例 |

## 计划目录

```text
斯坦福小镇/
├── index.js                 # 已有：状态和基础检查
├── configs/                 # 已有：实验配置样例
├── docs/                    # 已有：研究与实现规范
├── experiments/             # 已有：数据与结果管理约定
├── ai-town/                 # 已克隆：独立上游 checkout，根仓库忽略
├── models/                  # 已有：Modelfile 和官方 tokenizer；权重由 Ollama 管理
├── scripts/                 # 已有：tokenizer 下载、模型检查与能力测试
├── lib/                     # 已有：计量客户端、分词与评分
└── tests/                   # 已有：失败处理、预算、评分、数据隔离测试
```

第一版目标：5 个角色稳定运行；记忆可持久化；请求消耗可追踪；至少两种记忆策略可以在同一实验条件下比较。实现顺序以 ROADMAP 为准。

## 从 GitHub 获取与恢复工作区

根仓库包含研究代码、配置、文档、测试、开发题集和小型实验报告。模型权重、tokenizer 缓存、依赖、环境密钥、运行数据库及 `artifacts/local/` 原始运行目录保留在本机；报告中的原始 run 路径需要对应本地文件，克隆仓库不会自动获得这些记录。正式干净环境复现验收仍待完成。

克隆后先在根目录执行 `npm ci`、`npm run check` 和 `npm test`。需要真实模型时，再按 [本地部署](docs/LOCAL_SETUP.md) 准备 Ollama 和 tokenizer。

`ai-town/` 保持独立上游 checkout。上游版本、两个补丁和新增源码映射保存在 [upstream-lock.json](configs/upstream-lock.json)。仅在尚无 `ai-town/` 的新工作区中，按以下顺序恢复集成源码：

```bash
git clone https://github.com/a16z-infra/ai-town.git ai-town
git -C ai-town checkout 8e05997f2409275669c8344b84a51692e83f3f33
git -C ai-town apply ../configs/ai-town-local.patch
git -C ai-town apply ../configs/ai-town-research.patch
node <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const lock = JSON.parse(fs.readFileSync('configs/upstream-lock.json', 'utf8'));
for (const [destination, source] of Object.entries(lock.newSources)) {
  const target = path.join('ai-town', destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
JS
```

随后按本地部署文档安装上游依赖、配置自托管 Convex 并生成接口类型。不要在已有上游工作区重复应用补丁；已有修改应先核对。2026-10-19 上传前已核对两份补丁和新增源码与本地上游一致，生成的 `convex/_generated/api.d.ts` 由上游开发流程重新生成。

## 资料

- [AI Town 仓库](https://github.com/a16z-infra/ai-town)
- [斯坦福原版 Generative Agents](https://github.com/joonspk-research/generative_agents)
- [Ollama macOS 安装](https://docs.ollama.com/macos)
- [Ollama 配置与资源管理](https://docs.ollama.com/faq)
- [Convex 自托管](https://github.com/get-convex/convex-backend/tree/main/self-hosted)

正式配置关键字段及本地数据校验：`node index.js check-config <配置路径> --formal`。这项检查不启动实验，也不验证服务运行情况。

部署方案来自 2026-10-14 的文档与源码调研。真正运行实验时须记录所用 commit、镜像摘要、模型摘要；在线 main 分支和模型标签可能变化。

## 当前本地运行

小镇实际地址：[http://127.0.0.1:5174/ai-town/](http://127.0.0.1:5174/ai-town/)；数据面板为 http://127.0.0.1:6791。小镇观察任务结束或失败会停止世界，以避免持续推理；前端和容器保留供继续开发。

`npm run stage1:report` 汇总最新的完整技术诊断；`npm run town:observe` 运行固定 30 分钟观察。完整阶段验收状态见 docs/ACCEPTANCE.md，不以服务启动代替验收通过。

## 计量与回放

- `npm run gateway`：本地 11435 端口代理到 Ollama；限制 1 个请求并发、2000 次转发和 1 小时运行窗口。已有实例运行时不要重复启动。
- `npm run replay -- --config configs/replay-100.json`：固定观察与查询的诊断回放，所有角色只读自己的历史，预算不足直接保留失败，不截断。
- `npm run replay:evaluate -- <run目录> experiments/datasets/workload.answers.jsonl`：独立评分；答案不发送给模型。
- `npm run stage3:report`：按逻辑请求 ID 对账客户端和网关的作用域与 token。
- `npm run town:export`：分页只读导出对话和观察资格；正式数据先暂停并排空再导出。

以上回放采用 full_history_control，仅用于诊断，不代替下述原版适配器和策略对照。100 条历史准确率为 100%，1000 条历史为 96%；均为 50 问×3 次。证据见 experiments/stage3-replay-summary.json 与 experiments/stage3-replay-1000-summary.json。4K 长历史在调用前预算拒绝，见 experiments/stage3-4k-budget-summary.json。

服务关闭后重新启动 Ollama；若旧网关 `/health` 返回 `admissionOpen:false`，先结束旧实例，再执行 `npm run gateway`。观察启动前要求至少 32 分钟剩余额度，每次采样同时检查 Ollama 是否可访问。网关端口存活不能代表仍可推理。

`npm run stage2:report -- <观察run目录> --wait` 会等待观察结束、世界停止及请求排空，生成 experiments/stage2-summary.json；未完成观察不会被标记通过。P4 已接入离线策略对照，在线策略尚未接入。

`npm run memory:smoke` 测试 v2 会话、原版模板写入、快照恢复、重复重放与受控反思计量；需先启动网关。默认反思上限 512 的截断失败会保留；`npm run memory:smoke -- --config configs/memory-write-smoke-reflection-1024.json` 为只调整反思上限的独立复测。测试结果不等于完整 baseline 或降耗对照，见验收记录。

`npm run baseline:smoke` 测试离线基线生命周期：真实会话写入、Top-K/1024 预算只读检索、显式访问更新与恢复、自动反思触发和恢复后的去重。需先启动网关。它使用本地精确余弦，未接入 Convex；开发问题与答案文件分离，runner 不读取答案。完整质量矩阵与在线等价验证仍待完成。

`npm run town:capture-v2` 在世界停止后做两次有界只读检查，核对归档、作者与参与者，输出 v2 会话和排除清单。`--allow-stale-markers --allow-unacknowledged-messages` 只用于显式标记的开发导出：保留遗留操作标记和引擎计数差异，不能当作正式原子快照。

`node scripts/prepare-memory-development.js --capture <捕获run目录>` 生成可复现的开发输入及单独答案文件。`npm run memory:compare -- --config configs/memory-compare.development.json` 按重复重建记忆，使用相同快照比较检索策略；需先启动网关。`npm run memory:compare:evaluate -- <run目录> <答案JSON文件>` 在模型运行之外评分，缺失/失败样本保留分母。完整性检查通过不等于正式质量验收通过。

`npm run memory:compare -- --config configs/memory-quality.development.json` 测试事实、更新/历史、关系、承诺理解及无答案。128-token 记忆预算是额外压力探针，不属于正式预算矩阵。评估器对预先标注的矛盾答案单独计数并报告覆盖率，不把所有错误都算矛盾。

`npm run commitment:actions -- --parent <已完成quality对照run> --fixture experiments/datasets/commitment-action.development.json` 从父 run 的独立快照决定动作，由本地投递模拟器执行并记录是否按时完成。任务目标只供执行器/评估器使用，模型读取可见库存、联系人及选中记忆。它不是 AI Town 在线任务验收。

本轮负面结果与原文诊断见 experiments/memory-quality-summary.json：过小预算降低了输入，也丢失了关键证据与履行能力；原摘要在历史题上答错，原始消息上下文可答对。开发观察不等于完整优化收益。


`npm run policy:compare -- --config configs/tiered-quality-action-context.development.json` 比较独立维护的 baseline 与分层记忆原型。每个会话触发一次结构化抽取，保存原文归档、带时间的事实及显式投递承诺；每次查询的日期规划、抽取、向量和动作成本均计量。普通 JSON 模式的两次失败保留，Schema 约束不等于语义正确性。此配置是单次开发诊断，不是正式质量矩阵。运行完成后仍需用独立答案文件评分，再调用 `scripts/report-memory-comparison.js`，报告同时列查询输入和包含维护的总生成 token。

首轮分层真实诊断的 6 个 run 均在严格抽取校验处失败，尚无完整成本/质量对照；失败与全部消耗见 [分层开发诊断汇总](experiments/tiered-development-summary.json)。先修复可靠抽取，暂不启动正式矩阵。


`npm run tiered:probe -- --config configs/tiered-extraction-promise.development.json` 用独立作用域重放承诺抽取与恢复；`npm run tiered:probe:evaluate -- <run目录> experiments/datasets/commitment-action.development.json` 在运行结束后独立核验接受物品、对象、期限和来源。三次重复诊断通过见 experiments/tiered-extraction-summary.json，仍是同一开发任务，不能算正式验收。


最新已完成两组独立维护的完整开发对照，并共同补充动作身份/UTC 上下文：两组问答均 9/10，单步投递均 1/1；分层回答输入减少约 8.75%，但总生成 token 增加约 63.11%，本场景未观察到总降耗。详见 [完整策略开发报告](experiments/policy-comparison-summary.json)。这是单次开发配置，不是完整重复矩阵或正式验收。


### 2026-10-16：归档检索开发结果

`npm run policy:compare -- --config configs/archive-quality.repeated.development.json` 比较基线与逐消息原文归档检索，三次独立重建、每组 30 个回答。归档组 30/30、基线 27/30，投递各 3/3；回答输入减少约 36.11%，含维护的总生成 token 减少约 57.05%，但 JSON 快照约为基线 1.97 倍。该结果只覆盖相同的 10 道开发题，不是 30 个独立问题或正式验收。

迟到纠正的独立负面探针中，基线 2/2、归档 1/2：历史观察时间过滤丢掉了后来对过去事实的纠正。正反结果索引见 [归档研究汇总](experiments/archive-research-summary.json)，主对照见 [三次重复报告](experiments/policy-comparison-summary.json)。正式矩阵前先区分知识观察时间与事实有效时间，不能将当前归档策略宣称为通用优胜方案。

边界探针配置为 configs/archive-late-correction.development.json。报告命令可加 `--no-latest`，只保存该 run 报告，不覆盖主结果入口；派生评估/报告更新会按旧内容哈希保留修订。本轮启动的模型服务和网关均已关闭，继续推理前需重新启动。
