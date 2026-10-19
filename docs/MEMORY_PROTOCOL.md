# Memory 协议

状态：接口契约；已实现 P4 检索与预算基础模块，尚无完整策略执行器。

`lib/baseline-policy.js` 已接入离线 `observe`、`retrieve`、`consolidate` 流程：会话写入后检查最新 100 条记忆、按最近一次反思时间累计重要性并在 >500 时反思；所有反思输出完成校验、评分和 embedding 后一次提交。会话已写入但维护失败时，重放会话会跳过重复摘要并补做维护；成功反思后的恢复重试不重新调用模型。

检索使用同作用域中的真实向量做精确余弦、10n 候选和三项评分，仍是 Convex 向量检索的离线适配。探针默认只读，不更新访问；显式 `readOnly:false` 才应用 5 分钟访问节流。窗口拒绝不更新访问时间。基线算子保持 Top-K，预算组整条跳过超限记忆。两组的只读比较在相同快照副本中进行，不能据此省略重建/维护成本并声称端到端收益。

存储快照现为 schemaVersion=2，新增访问事务；可以加载 v1 的无访问事务快照，输出新文件，不覆盖旧实验。恢复先重建不可变创建事务，再回放访问事务。当前只支持单进程本地事务，尚未证明断电耐久性、多进程互斥、Convex 候选等价或原版在线行为等价。

2026-10-15 新增最小写入流程：`conversations-v2.js` 校验双人会话、参与者、观察范围和显式时间；`memory-store.js` 以实验/世界/角色隔离本地事务，保存记忆与向量及来源并支持文件快照；`upstream-memory-adapter.js` 适配原版摘要/importance 模板及会话记忆写入。同一 writer 的并发重复合并模型调用，提交层拒绝重复 ID 和冲突操作；独立 writer 之间允许发生已计量的重复计算，但最多发布一个一致事务，冲突结果不覆盖。

这是独立本地测试适配器，未接入 Convex。采用 UTC ISO 时间、Qwen raw ChatML、显式输出上限和严格反思来源校验，均为需冻结的适配变化；不宣称与原版在线策略完全等价。存储校验反思父记忆必须属于当前作用域；会话原始事件资格由上层 v2 writer 校验，存储本身不是完整事件 ACL 服务。文件快照通过临时文件重命名写入，尚未验证断电耐久性或多进程互斥。

`lib/memory-retrieval.js` 按固定上游 searchMemories/rankAndTouchMemories 的规则实现 relevance 候选取 10n、三项归一化重排、Top-K 和 5 分钟访问节流；继承公共的同分归一化修复。调用方必须先用同一模型生成向量并提供相关性分数，不能用伪造分数代替 embedding。

基础模块在评分前过滤世界/角色，不改变传入记录；返回实际选中记录、预算排除原因及待执行的访问更新。budgeted_retrieval 在同一候选池中逐条测量完整记忆文本和输入模板，超预算整条跳过。upstream_top_k 保留原有数量，窗口溢出返回不可执行，不减少数量或截断。这里的名称表示检索算子，**不是完整 baseline 策略**；写入、摘要、importance、反思、数据库原子操作与回放计量尚待接入。事实更新和 tiered_memory 也尚未实现。

## 策略

| ID | 定义 | 目的 |
| --- | --- | --- |
| `baseline` | 适配固定上游版本的写入、检索与反思行为 | 提供可比较的原始参考 |
| `budgeted_retrieval` | 保持写入与评分方式，按预算选取候选 | 单独测量限制检索上下文的影响 |
| `tiered_memory` | 工作记忆、情节记忆、长期事实、归档；加入去重和合并 | 测量压缩与维护成本的整体影响 |

运行模式、质量阈值和预算属于实验配置。对 baseline 的通用错误修复需显式记录；不得在 baseline 中偷偷加入待比较优化。

## 记忆记录建议字段

```ts
type MemoryRecord = {
  id: string;
  schemaVersion: number;
  worldId: string;
  agentId: string;
  kind: 'observation' | 'conversation' | 'fact' | 'commitment' | 'reflection';
  text: string;
  sourceEventIds: string[];
  sourceMemoryIds: string[];
  createdAt: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  lastAccessedAt?: string;
  importance: number;
  confidence?: number;
  status: 'active' | 'superseded' | 'archived';
  embeddingVersion?: string;
};
```

时间统一使用 UTC 或明确的模拟时间类型，禁止把二者混写在同一字段。`confidence` 是系统或模型的估计，不能被当作事实正确率。

## 统一接口

```ts
interface MemoryPolicy {
  observe(scope: Scope, events: ObservedEvent[]): Promise<WriteResult>;
  retrieve(scope: Scope, query: MemoryQuery, budget: TokenBudget): Promise<RetrievalResult>;
  consolidate(scope: Scope, trigger: ConsolidationTrigger): Promise<MaintenanceResult>;
  snapshot(scope: Scope): Promise<SnapshotReference>;
}
```

这些是设计类型，`Scope`、结果类型等将在 P3 中定义。接口结果必须携带：选中记忆 ID、来源、计量状态、丢弃/归档原因和相关调用 ID。调试时可追溯某条记忆为什么被选择，不能只返回拼接好的字符串。

## 上下文预算

1. 先计算身份、当前任务、近期对话、工具/格式约束的占用，再预留输出。
2. 记忆预算是总输入的一部分，不是额外窗口。计算应包含模板和消息边界开销。
3. 候选先做访问范围过滤，再打分与选择。不能先跨角色检索再靠提示词要求模型忽略。
4. 对单条超长记忆给出显式结果：跳过、截取受控片段或生成有来源的摘要；记录原因及成本。
5. tokenizer 估算与服务 usage 分开保存。无法精确计量时标注 estimated，并通过实测校准。
6. 超过总预算的请求停止或按配置降级；不依赖推理服务静默截断。

初始建议：总窗口 8192、最大输入 6500、最大输出 512、记忆最多 1200 tokens，其余空间作为模板和计量误差余量。上游不同用途可能指定不同输出上限，接入时需要逐个核对。

`memoryTokens` 和 `maxRetrievedItems` 在优化组中启用；baseline 保持原有检索数量，仅受所有组共用的安全窗口约束。任何触发共用约束的样本都单独报告，避免把窗口溢出当成策略正常表现。

## 合并、遗忘与事实更新

- 去重先限定世界、角色、事件语义和时间；同一句话在不同日期可能是不同事件。
- 摘要保留人物、时间、否定、承诺、状态变化和来源。摘要不是新的独立证据。
- 旧事实被新事实替代时保留 `superseded` 记录及有效时间，不简单覆盖历史。
- 未到期承诺、身份和关键关系不能仅因低访问频率被清除；以单独规则维护。
- 反思的来源可以是事实或观察，但不能循环引用自己证明自己。
- 归档意味着从活跃检索范围移出；原始事件保留用于评估。若有数据保留限制，作为独立配置记录。

## 必须验证的性质

角色/世界隔离；空候选返回；分数相等不产生 NaN；预算不溢出；重试不重复写；快照恢复不丢来源；矛盾事实能按时间解析；模型结构化输出无效时不制造默认“事实”。


## 已实现的分层最小原型（2026-10-15）

`TieredStore` 使用独立 schemaVersion=1 快照，不与基线快照混用。每个会话、每个实际参与者触发一次抽取；原始会话、事实/承诺及向量原子提交，批次验证或向量失败不发布部分记录。重复事件不重复调用，同 ID 不同内容拒绝。所有操作按 experimentId/worldId/agentId 隔离。

事实包含 subject/predicate/value、validFrom/validUntil、replacesPrior 和当前可见 sourceEventIds/quote。仅明确标记的、带生效时间的新值在读取视图关闭旧值区间，原记录保留；无法确定替换的断言并存并标冲突。按问题中实际出现的日期查询历史视图；日期规划也调用模型并计费，不读取答案。当前只支持 ISO 日期和完整英文月份日期，不支持未来状态预测。

承诺只接受实际作者的明确第一人称接受声明，携带物品、参与者、期限与来源。动作由本地执行器产生匹配回执才可更新完成状态，模型自称完成无效。包含承诺的检索优先保留角色自身待履行项；预算容不下时返回 critical_commitment_budget_exceeded，不静默遗忘后正常执行。

Schema 解码只限制结构；提交前仍检查引用可见性、原文片段、事实值位于引用、参与者与时间。它们不能证明主语/属性/有效时间在语义上正确，也不保证抽取完整。实体和属性键尚无通用归一化，命名变化可能影响更新匹配。只读查询不改写状态；恢复时重验事务及回执。

当前保留原文归档，但正常查询尚无通用归档回查、情节生成式压缩或长期 consolidation。代码接口与上面的设计类型仍有适配差异；此原型不等于 D 全项验收或上游 Convex 集成。


新增的原文句子模式在解码时把 value/quote/sourceEventIds 按单条当前消息绑定；仍在提交时复验。承诺额外要求物品位于同句肯定的第一人称投递声明，明显否定拒绝；复杂语句的误拒边界待验证。maxExtractionAttempts 仅允许 1 或 2，纠错只针对已完成但不合法的输出，传输超时不触发纠错，每次生成独立计量。最后一项承诺校验仅有单元验证，真实抽取暂未验收。


开发配置可设置 maxExtractedRecords（1～8，默认 8），同时约束提示词、JSON Schema 和提交前校验。超额输出拒绝整批，不静默取前 N 条。条数上限是策略变量，可能降低证据覆盖；不能替代 token 预算或质量门槛。


查询规划可显式使用 queryPlanFormat=grounded_schema_v1，将 focus 限为 fact/commitment/any、日期限为问题中出现的日期或 null。解码后继续进行日期来源/未来日期检查，分类和有效时间的语义仍由独立评估检验。该规划调用计入查询消耗。

动作上下文可显式启用 actionContextRevision=self_identity_utc_v1，两组共同提供已有世界/角色身份和公开时钟的 UTC 表达，预算计算包含新增字段，不加入 acceptedTasks。该修复已做固定记忆探针和完整单次复测；原配置/旧结果保持不变。


## 开发消融的新增模式

queryPlanner=deterministic_any_v1 不发起 tiered_query_plan 模型调用；问题中的单个明确日期沿用同一历史视图解析，多个日期显式拒绝。只有明确的承诺/接受用语将焦点设为 commitment，其他问题保留 any；其检索/质量影响需与 LLM 规划对照，不把取消调用直接称为总降耗。

extractionFormat=dated_sentence_schema_v1 采用句子级来源日期约束。可用候选与排除原因写入 extraction-evidence.jsonl，模型不能改写候选的原文/日期/来源。无日期则 validFrom=null；部分英文日期用会话年份补齐。复杂多日期/钟点和截止边界不自动推断单一起点；不支持的范围保留原文等待将来的归档回查，不假称已实现回查。

extractionFormat=dated_reference_schema_v1 使用 facts map 和 commitments 数组。facts 的 key 只引用当前会话的局部证据 ID，value 只允许 subject/predicate；服务端展开为同一规范事实记录，并执行来源、日期和原子提交校验。局部引用不作为跨世界缓存键；展开后仍是完整 experimentId/worldId/agentId 作用域。重复 JSON 键、未知引用、超额条目整批拒绝。恢复时重新核验日期绑定，不能把旧策略快照无检查地解释为新约束。


## 归档检索开发对照

archive_retrieval 使用独立 kind=archive、schemaVersion=1 快照；每段会话按每个实际参与者保存完整原文和逐消息向量。展示文本由固定 UTC 时间、原作者姓名/ID、原文组成，恢复时与原始消息严格对应。没有生成式写入或事实加工，所有 embedding 和失败尝试仍入账。

历史检索使用观察时间截止，随后本地余弦与 Top-K/实际 tokenizer 预算选择。它不是语义事实的有效期查询，也不是已完成的混合层归档 fallback。预算排除、不可执行、缺失回答和实际投递结果照常保留；语义承诺完成状态仅在独立动作执行器中计分。
