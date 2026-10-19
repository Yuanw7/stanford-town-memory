const fs = require('node:fs');
const path = require('node:path');
const { createRun, hash, root } = require('../lib/artifacts');
const { loadWorkload, Timeline } = require('../lib/workload');
const { loadTokenizer, renderPrompt } = require('../lib/tokenizer');
const { OllamaClient } = require('../lib/ollama');

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 2 && args[0] === '--config')) throw new Error('用法：npm run replay -- --config 配置文件');
  const config = JSON.parse(fs.readFileSync(path.resolve(root, args[1])));
  if (config.mode !== 'diagnostic_replay' || config.policy !== 'full_history_control') {
    throw new Error('当前执行器仅支持诊断回放控制组，不冒充原版 memory baseline 或正式策略实验');
  }
  for (const key of ['repetitions', 'contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'maxTotalCalls', 'wallTimeLimitSeconds']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} 无效`);
  }
  if (config.maxInputTokens + config.maxOutputTokens > config.contextWindowTokens) throw new Error('输入输出预算超过窗口');
  const rows = loadWorkload(path.resolve(root, config.dataset.path), config.dataset.sha256);
  const initialBytes = fs.readFileSync(path.resolve(root, config.initialState.path));
  if (hash(initialBytes) !== config.initialState.sha256) throw new Error('初始状态校验和不匹配');
  const initial = JSON.parse(initialBytes);
  if (!Array.isArray(initial)) throw new Error('初始状态必须是观察事件数组');
  const tokenizer = loadTokenizer();
  const run = createRun('replay', config);
  fs.copyFileSync(path.resolve(root, config.dataset.path), path.join(run.directory, 'workload.jsonl'));
  fs.writeFileSync(path.join(run.directory, 'initial-state.json'), initialBytes);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const calls = [];
  const client = new OllamaClient({ host: config.host, maxTotalCalls: config.maxTotalCalls,
    deadline: Date.now() + config.wallTimeLimitSeconds * 1000, signal: controller.signal,
    record: row => { calls.push(row); run.append('calls.jsonl', row); } });
  let processed = 0, answered = 0;
  try {
    const tags = await client.info('/api/tags');
    const model = tags.models.find(m => m.name === config.model || m.name === `${config.model}:latest`);
    if (!model || model.digest !== config.modelDigest) throw new Error('模型 digest 不匹配');
    run.manifest.modelDigest = model.digest; run.manifest.tokenizer = tokenizer.metadata;
    run.write('manifest.json', run.manifest);
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const timeline = new Timeline(initial);
      run.write(`initial-state-${repetition}.json`, timeline.snapshot());
      for (const row of rows) {
        if (controller.signal.aborted) throw new Error('interrupted');
        run.append('events.jsonl', { repetition, event: row }); processed++;
        if (row.type === 'observation') { timeline.observe(row); continue; }
        const memories = timeline.visible(row);
        const prompt = renderPrompt([
          { role: 'system', content: '仅根据你已经观察到的事件回答；不知道时回答“未知”。只输出JSON：{"answer":"最简答案"}。时间使用HH:MM，日期使用YYYY-MM-DD，不解释。' },
          { role: 'user', content: `已观察事件：\n${memories.map(m => `[${m.id}] ${m.text}`).join('\n')}\n问题：${row.text}` },
        ]);
        const inputTokens = tokenizer.count(prompt);
        run.append('retrieval.jsonl', { repetition, queryId: row.id, worldId: row.worldId,
          agentId: row.agentId, memoryIds: memories.map(m => m.id), inputTokens, policy: config.policy });
        if (inputTokens > config.maxInputTokens) throw new Error(`input_budget_exceeded:${row.id}；未截断或发送`);
        const { result, entry } = await client.request('/api/generate', {
          model: config.model, prompt, raw: true, stream: false, format: 'json',
          options: { num_ctx: config.contextWindowTokens, num_predict: config.maxOutputTokens, temperature: 0, seed: 42 + repetition - 1 },
        }, { experimentId: run.runId, worldId: row.worldId, agentId: row.agentId, purpose: 'fixed_workload_query', queryId: row.id, repetition });
        if (result.prompt_eval_count !== inputTokens) throw new Error('tokenizer_mismatch_or_input_truncation');
        if (result.done_reason === 'length') throw new Error('output_truncated');
        answered++;
        run.append('answers.jsonl', { repetition, queryId: row.id, category: row.category,
          response: result.response, logicalCallId: entry.logicalCallId });
        run.append('resource-samples.jsonl', { at: new Date().toISOString(), processRssBytes: process.memoryUsage().rss });
      }
      run.write(`final-state-${repetition}.json`, timeline.snapshot());
    }
    run.write('summary.json', { diagnosticOnly: true, processed, answered,
      expectedEvents: rows.length * config.repetitions,
      expectedQueries: rows.filter(r => r.type === 'query').length * config.repetitions,
      attempts: calls.length, measured: calls.filter(c => c.usageStatus === 'measured').length,
      inputTokensKnown: calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0),
      outputTokensKnown: calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0),
      datasetSha256: config.dataset.sha256, initialStateSha256: config.initialState.sha256 });
    run.finish('completed'); console.log(`回放完成：${run.directory}`);
  } catch (error) {
    run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message, processed, answered });
    console.error(`保留失败记录：${run.directory}`); throw error;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
