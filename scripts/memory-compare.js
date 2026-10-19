const fs = require('node:fs');
const path = require('node:path');
const { root, hash, createRun } = require('../lib/artifacts');
const { validateMemoryWorkload } = require('../lib/memory-workload');
const { compareMemories } = require('../lib/memory-comparison');
const { diagnosticRuntime } = require('../lib/diagnostic-runtime');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('用法：npm run memory:compare -- --config 文件');
  const config = JSON.parse(fs.readFileSync(path.resolve(root, args[1])));
  if (config.mode !== 'diagnostic_memory_comparison' || config.host !== 'http://127.0.0.1:11435') throw new Error('only_local_diagnostic_comparison');
  for (const key of ['repetitions', 'embeddingDimensions', 'contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'queryOutputTokens', 'maxTotalCalls', 'wallTimeLimitSeconds']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`invalid_config:${key}`);
  }
  if (!Number.isSafeInteger(config.seed) || config.maxInputTokens + config.maxOutputTokens > config.contextWindowTokens
      || config.queryOutputTokens > config.maxOutputTokens || !Array.isArray(config.variants) || config.variants.length < 2
      || new Set(config.variants.map(v => v.id)).size !== config.variants.length
      || !config.variants.some(v => v.policy === 'upstream_top_k')) throw new Error('invalid_comparison_configuration');
  for (const v of config.variants) if (!/^[a-z0-9_-]+$/.test(v.id) || !['upstream_top_k', 'budgeted_retrieval'].includes(v.policy)
      || (v.policy === 'budgeted_retrieval' && (!Number.isInteger(v.memoryBudgetTokens) || v.memoryBudgetTokens < 1))) throw new Error('invalid_variant');
  const bytes = fs.readFileSync(path.resolve(root, config.dataset.path));
  if (hash(bytes) !== config.dataset.sha256) throw new Error('dataset_checksum_mismatch');
  const workload = validateMemoryWorkload(JSON.parse(bytes));
  const run = createRun('memory-comparison', config); fs.writeFileSync(path.join(run.directory, 'workload.json'), bytes);
  console.log(`记录目录：${run.directory}`);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const runtime = await diagnosticRuntime(config, run, controller.signal);
    const { answers, retrieval } = await compareMemories({ workload, config, runtime, experimentId: run.runId,
      record: (name, row) => run.append(name, row), save: (name, value) => run.write(name, value) });
    const summary = { diagnosticOnly: true, comparisonScope: 'retrieval-only; maintenance rebuilt per repetition and shared between query variants',
      conversationsPerRepetition: workload.conversations.length, distinctQuestions: workload.queries.length, repetitions: config.repetitions,
      expectedAnswers: workload.queries.length * config.variants.length * config.repetitions, observedAnswers: answers.length,
      attempts: runtime.calls.length, allGatewayScopeAndUsageMatched: runtime.verifyMetering(),
      byVariant: Object.fromEntries(config.variants.map(v => [v.id, {
        observedAnswers: answers.filter(a => a.strategy === v.id).length,
        inputTokens: retrieval.filter(r => r.strategy === v.id).reduce((n, r) => n + r.inputTokens, 0),
        budgetExclusions: retrieval.filter(r => r.strategy === v.id).flatMap(r => r.excluded).filter(e => ['memory_budget', 'input_budget'].includes(e.reason)).length }])) };
    run.write('summary.json', summary);
    if (!summary.allGatewayScopeAndUsageMatched || summary.observedAnswers !== summary.expectedAnswers) throw new Error('incomplete_or_unmatched_comparison');
    run.finish('completed'); console.log(JSON.stringify(summary, null, 2));
  } catch (error) { run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
