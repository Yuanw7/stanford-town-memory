const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { root, hash, createRun } = require('../lib/artifacts');
const { validateMemoryWorkload } = require('../lib/memory-workload');
const { TieredStore } = require('../lib/tiered-store');
const { TieredPolicy } = require('../lib/tiered-policy');
const { diagnosticRuntime } = require('../lib/diagnostic-runtime');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') throw new Error('用法：node scripts/tiered-extraction-probe.js --config 文件');
  const config = JSON.parse(fs.readFileSync(path.resolve(root, args[1])));
  for (const key of ['repetitions', 'embeddingDimensions', 'contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'maxTotalCalls', 'wallTimeLimitSeconds']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`invalid_probe_config:${key}`);
  }
  if (config.mode !== 'diagnostic_tiered_extraction' || !Number.isInteger(config.repetitions) || config.repetitions < 1
      || config.host !== 'http://127.0.0.1:11435' || !Number.isSafeInteger(config.seed)
      || ![1, 2].includes(config.maxExtractionAttempts)
      || config.maxExtractedRecords !== undefined && (!Number.isInteger(config.maxExtractedRecords) || config.maxExtractedRecords < 1 || config.maxExtractedRecords > 8)
      || !['source_sentence_schema_v1', 'json_schema_v1'].includes(config.extractionFormat)
      || config.maxInputTokens + config.maxOutputTokens > config.contextWindowTokens
      || !Array.isArray(config.conversationIds) || !config.conversationIds.length
      || new Set(config.conversationIds).size !== config.conversationIds.length) throw new Error('invalid_probe_config');
  const bytes = fs.readFileSync(path.resolve(root, config.dataset.path));
  if (hash(bytes) !== config.dataset.sha256) throw new Error('dataset_checksum_mismatch');
  const workload = validateMemoryWorkload(JSON.parse(bytes));
  const conversations = config.conversationIds.map(id => { const c = workload.conversations.find(c => c.id === id); if (!c) throw new Error('unknown_conversation'); return c; });
  const run = createRun('tiered-extraction', config); run.write('conversations.json', conversations);
  console.log(`记录目录：${run.directory}`);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const runtime = await diagnosticRuntime(config, run, controller.signal), options = { dimensions: config.embeddingDimensions, embeddingVersion: config.embeddingDigest };
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const store = new TieredStore(options), policy = new TieredPolicy({ store, generate: runtime.generate, embed: runtime.embed,
        maxExtractionAttempts: config.maxExtractionAttempts, maxExtractedRecords: config.maxExtractedRecords ?? 8,
        record: row => run.append('memory-actions.jsonl', { repetition, ...row }) });
      for (const c of conversations) for (const p of c.participants) {
        const scope = { experimentId: `${run.runId}:${repetition}`, worldId: c.worldId, agentId: p.agentId, repetition, seed: config.seed + repetition - 1 };
        await policy.observe(c, scope, { nowMs: c.messages.at(-1).atMs });
        run.write(`state-${repetition}.json`, store.snapshot());
        const before = runtime.calls.length;
        const restored = new TieredStore({ ...options, snapshot: store.snapshot() });
        assert.deepEqual(restored.snapshot(), store.snapshot());
        const replay = new TieredPolicy({ store: restored, generate: runtime.generate, embed: runtime.embed });
        await replay.observe(c, scope, { nowMs: c.messages.at(-1).atMs });
        assert.equal(runtime.calls.length, before);
      }
    }
    const summary = { diagnosticOnly: true, repetitions: config.repetitions, attempts: runtime.calls.length,
      allGatewayScopeAndUsageMatched: runtime.verifyMetering(), limitation: 'Source/schema/restore probe only; extraction completeness and truth require independent evaluation' };
    run.write('summary.json', summary);
    if (!summary.allGatewayScopeAndUsageMatched) throw new Error('metering_mismatch');
    run.finish('completed'); console.log(JSON.stringify(summary, null, 2));
  } catch (error) { run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
