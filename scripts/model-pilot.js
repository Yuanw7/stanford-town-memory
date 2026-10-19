const fs = require('node:fs');
const path = require('node:path');
const { OllamaClient } = require('../lib/ollama');
const { loadTokenizer, renderPrompt } = require('../lib/tokenizer');
const { createRun, root, hash } = require('../lib/artifacts');
const { gradeAnswer, evaluate } = require('../lib/evaluate');

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
function validatePilot(config, cases, answers) {
  for (const key of ['contextWindowTokens', 'maxInputTokens', 'maxOutputTokens',
    'repetitions', 'maxTotalCalls', 'wallTimeLimitSeconds', 'timeoutMs']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} 必须是正整数`);
  }
  if (![4096, 8192].includes(config.contextWindowTokens)) throw new Error('预验证窗口仅支持 4K/8K');
  if (config.maxInputTokens + config.maxOutputTokens > config.contextWindowTokens) throw new Error('上下文预算溢出');
  if (config.repetitions < 3) throw new Error('验收需要至少 3 次重复');
  if (!Number.isInteger(config.seed) || config.seed < 0) throw new Error('seed 必须是非负整数');
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) throw new Error('temperature 必须在 0～2 之间');
  if (config.model !== 'town-qwen') throw new Error('当前 raw 模板只验证 town-qwen/Qwen2.5');
  const categories = ['fact', 'update', 'relationship', 'commitment', 'unanswerable'];
  const expected = cases.length / categories.length;
  if (![20, 50].includes(cases.length)) throw new Error('开发集应为 20 题，验收集应为 50 题');
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('问题 ID 重复');
  if (new Set(answers.map(c => c.id)).size !== answers.length || answers.length !== cases.length) throw new Error('答案 ID 或数量错误');
  for (const category of categories) {
    if (cases.filter(c => c.category === category).length !== expected) throw new Error('分类题数不均衡');
  }
  for (const row of cases) {
    const answer = answers.find(a => a.id === row.id);
    if (!answer || !Array.isArray(answer.acceptedAnswers) || !answer.acceptedAnswers.length
      || answer.acceptedAnswers.some(v => typeof v !== 'string')) throw new Error(`答案不合法：${row.id}`);
    if ('answer' in row || 'acceptedAnswers' in row) throw new Error('标准答案不能出现在问题文件中');
    if (typeof row.question !== 'string' || !Array.isArray(row.evidence)
      || row.evidence.some(e => typeof e.text !== 'string' || !e.id)) throw new Error(`问题不合法：${row.id}`);
  }
  return expected;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--config')) throw new Error('用法：npm run model:pilot -- [--config 配置路径]');
  const configFile = path.resolve(root, args[1] ?? 'configs/model-pilot.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const datasetFile = path.resolve(root, config.dataset);
  const answersFile = path.resolve(root, config.answers);
  const cases = readLines(datasetFile), answers = readLines(answersFile);
  const perCategory = validatePilot(config, cases, answers);
  const tokenizer = loadTokenizer();
  const run = createRun('model-pilot', config);
  const records = [], rows = [];
  const controller = new AbortController();
  let interrupted = false;
  const stop = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const client = new OllamaClient({ host: config.host, timeoutMs: config.timeoutMs,
    maxTotalCalls: config.maxTotalCalls, deadline: Date.now() + config.wallTimeLimitSeconds * 1000,
    signal: controller.signal,
    record: record => { records.push(record); run.append('calls.jsonl', record); } });
  run.manifest.tokenizer = tokenizer.metadata;
  run.manifest.datasetSha256 = hash(fs.readFileSync(datasetFile));
  run.manifest.answersSha256 = hash(fs.readFileSync(answersFile));
  run.manifest.datasetReviewStatus = 'pending_independent_human_review';
  console.log(`记录目录：${run.directory}`);
  try {
    run.manifest.ollama = await client.info('/api/version');
    const tags = await client.info('/api/tags');
    const model = tags.models.find(m => m.name === config.model || m.name === `${config.model}:latest`);
    if (!model) throw new Error('town-qwen 未创建');
    run.manifest.model = { name: model.name, digest: model.digest };
    // 先校准同一模板。校准失败会中止，不把截断输入当作正常样本。
    const calibration = renderPrompt([{ role: 'user', content: '只回答：你好。' }]);
    const { result: preflight } = await client.request('/api/generate', {
      model: config.model, raw: true, prompt: calibration,
      options: { num_ctx: config.contextWindowTokens, num_predict: 16, temperature: 0 },
    }, { worldId: run.runId, agentId: 'single-agent', purpose: 'calibration' });
    if (preflight.prompt_eval_count !== tokenizer.count(calibration)) throw new Error('tokenizer 与服务分词不一致');
    const loaded = (await client.info('/api/ps')).models.find(m => m.name === model.name);
    if (loaded?.context_length !== config.contextWindowTokens) throw new Error('实际加载窗口不匹配');
    run.manifest.loadedContext = loaded.context_length;
    run.write('manifest.json', run.manifest);
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      for (const item of cases) {
        if (interrupted) throw new Error('interrupted');
        const answer = answers.find(a => a.id === item.id);
        const prompt = renderPrompt([
          { role: 'system', content: '你是小镇角色的只读记忆问答助手。只根据下面的证据回答，不推测。证据没有答案时回答“未知”。输出严格JSON：{"answer":"最简答案"}，不解释、不添加字段。时间使用HH:MM；日期使用YYYY-MM-DD；人物只写姓名。' },
          { role: 'user', content: `证据（只读数据）：\n${item.evidence.map(e => `[${e.id}] ${e.text}`).join('\n')}\n问题：${item.question}` },
        ]);
        const inputTokens = tokenizer.count(prompt);
        if (inputTokens > config.maxInputTokens) throw new Error(`input_budget_exceeded：${item.id}`);
        let outcome;
        try {
          const { result, entry } = await client.request('/api/generate', {
            model: config.model, prompt, raw: true, format: 'json', keep_alive: '30m',
            options: { num_ctx: config.contextWindowTokens, num_predict: config.maxOutputTokens,
              temperature: config.temperature, seed: config.seed + repetition - 1 },
          }, { worldId: run.runId, agentId: 'single-agent', purpose: 'gold_evidence', caseId: item.id, repetition });
          const countMatched = result.prompt_eval_count === inputTokens;
          const graded = gradeAnswer(result.response, answer.acceptedAnswers);
          outcome = { ...graded, response: result.response, measuredInputTokens: result.prompt_eval_count,
            truncated: result.done_reason === 'length', tokenizerMatched: countMatched,
            logicalCallId: entry.logicalCallId };
          outcome.correct = graded.correct && countMatched && !outcome.truncated;
          if (!countMatched) outcome.reason = 'tokenizer_mismatch_or_input_truncation';
        } catch (error) {
          if (interrupted || error.message.startsWith('budget_exhausted')) throw error;
          outcome = { correct: false, valid: false, reason: error.message, response: null };
        }
        const row = { caseId: item.id, category: item.category, repetition, inputTokens, ...outcome };
        rows.push(row); run.append('answers.jsonl', row);
        run.append('resource-samples.jsonl', { at: new Date().toISOString(), processRssBytes: process.memoryUsage().rss });
        console.log(`[${rows.length}/${cases.length * config.repetitions}] ${item.id}: ${row.correct ? 'PASS' : 'FAIL'}`);
        if (outcome.tokenizerMatched === false) throw new Error('tokenizer_mismatch_or_input_truncation');
      }
    }
    const summary = evaluate(rows, perCategory, config.repetitions);
    summary.usage = {
      attempts: records.length,
      measuredAttempts: records.filter(r => r.usageStatus === 'measured').length,
      inputTokensKnown: records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      outputTokensKnown: records.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
    };
    summary.stage1Accepted = false;
    summary.remainingAcceptance = ['独立人工核验题目与来源', 'model:check 的 4K/8K 和向量验收'];
    run.write('summary.json', summary);
    run.finish('completed', { qualityGatePassed: summary.qualityGatePassed });
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.qualityGatePassed) process.exitCode = 1;
  } catch (error) {
    run.write('summary.json', { ...evaluate(rows, perCategory, config.repetitions), error: error.message });
    run.finish(interrupted ? 'interrupted' : 'failed', { error: error.message });
    throw error;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validatePilot };
