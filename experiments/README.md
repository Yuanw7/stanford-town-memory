# 实验数据与结果管理

已有合成模型诊断题集、100/1000 条观察工作负载及实际运行结果；题集独立人工审核尚未完成。当前原始 run 保存于 `artifacts/local/<kind>/<runId>/`，小型结果摘要保存在本目录。以下 experiments/runs 是正式策略实验的计划布局。

## 计划布局

```text
experiments/
├── datasets/
│   └── local/                 # 本地事件、查询和初始状态，默认不提交
└── runs/
    └── <experimentId>/<variant>/<runId>/
        ├── manifest.json
        ├── config.json
        ├── events.jsonl
        ├── calls.jsonl
        ├── memory-actions.jsonl
        ├── resource-samples.jsonl
        ├── evaluation.json
        └── summary.json
```

## 固定工作负载

数据集应区分 `observation`、`query`、`task`、`expected_answer`。标准答案存放在评估侧文件，不拼接到角色 prompt。每条观察带事件 ID、模拟时间、可观察角色范围；每个问题关联有资格知晓的证据。

一套输入分发给多个策略时，输入顺序、初始状态、提示词模板和模型配置保持一致。向量与生成缓存需要固定策略：冷缓存或各组独立预热，不能让后运行的组无条件继承先运行组收益。

## 记录规则

- run ID 必须唯一；同名目录存在时执行器拒绝覆盖。
- 大型结果、模型权重、密钥和原始本地数据不提交 Git。`.gitignore` 已忽略 runs 与 datasets/local。
- 原始结果按追加方式记录；修改或重新评估生成新的派生文件，保留脚本版本。
- 正式报告可提交脱敏摘要和小型公开 fixture，并说明原始数据获取方法及校验和。
- 格式中的 token 值无法获取时使用 null，附 `usageStatus` 与原因；不能以 0 代替。
- `calls.jsonl` 逐 attempt 保存，包括取消、失败、重试；逻辑调用 ID 用于聚合。
- 记录模型预热、重载和服务重启，不把冷启动开销混入稳态指标后隐去。

## 运行结束检查

确认 manifest 结束状态、停止原因、输入完成率、调用计量覆盖率和质量评估均存在。未完成、超时和预算耗尽的结果保留，不作为完整运行的成本替代品。
