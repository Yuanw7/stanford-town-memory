const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRun, root, hash } = require('../lib/artifacts');
const { OllamaClient } = require('../lib/ollama');
const { loadTokenizer, renderPrompt } = require('../lib/tokenizer');
const { checkTownServices } = require('../lib/service-health');
const { validateConversation, fingerprint } = require('../lib/conversations-v2');
const { MemoryStore } = require('../lib/memory-store');
const { ConversationMemoryWriter, importanceMessages, parseImportance,
  reflectionMessages, reflectionEligible, parseReflections } = require('../lib/upstream-memory-adapter');

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--config')) throw new Error('用法：npm run memory:smoke -- [--config 文件]');
  const config = JSON.parse(fs.readFileSync(path.resolve(root, args[1] ?? 'configs/memory-write-smoke.json')));
  if (config.mode !== 'diagnostic_memory_write' || config.host !== 'http://127.0.0.1:11435') throw new Error('仅支持本地网关诊断');
  for (const key of ['contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'maxTotalCalls',
    'wallTimeLimitSeconds', 'embeddingDimensions']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`invalid_config:${key}`);
  }
  if (config.maxInputTokens + config.maxOutputTokens > config.contextWindowTokens) throw new Error('invalid_input_output_budget');
  if (!Number.isInteger(config.reflectionFixture?.count) || config.reflectionFixture.count < 1
      || config.reflectionFixture.count > 100 || !Number.isFinite(config.reflectionFixture.importance)) throw new Error('invalid_reflection_fixture');
  const bytes = fs.readFileSync(path.resolve(root, config.dataset.path));
  if (hash(bytes) !== config.dataset.sha256) throw new Error('dataset_checksum_mismatch');
  const conversation = validateConversation(JSON.parse(bytes));
  const run = createRun('memory-write-smoke', config), calls = [];
  console.log(`记录目录：${run.directory}`);
  run.write('conversation.json', conversation);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const client = new OllamaClient({ host: config.host, maxTotalCalls: config.maxTotalCalls,
    deadline: Date.now() + config.wallTimeLimitSeconds * 1000, signal: controller.signal,
    record: row => { calls.push(row); run.append('calls.jsonl', row); } });
  try {
    run.write('service-health.json', await checkTownServices({ minimumRemainingMs: config.wallTimeLimitSeconds * 1000 }));
    const tags = await client.info('/api/tags');
    for (const [name, digest] of [[config.model, config.modelDigest], [config.embeddingModel, config.embeddingDigest]]) {
      if (!tags.models.some(m => [name, `${name}:latest`].includes(m.name) && m.digest === digest)) throw new Error('model_digest_mismatch');
    }
    const tokenizer = loadTokenizer(); run.manifest.tokenizer = tokenizer.metadata;
    run.manifest.ollama = await client.info('/api/version'); run.write('manifest.json', run.manifest);
    const generate = async (messages, scope, outputTokens = config.maxOutputTokens) => {
      const prompt = renderPrompt(messages), inputTokens = tokenizer.count(prompt);
      if (inputTokens > config.maxInputTokens || outputTokens > config.maxOutputTokens) throw new Error('input_or_output_budget_exceeded');
      run.append('prompts.jsonl', { ...scope, messages, inputTokens, outputTokens });
      const { result, entry } = await client.request('/api/generate', { model: config.model, prompt, raw: true,
        options: { num_ctx: config.contextWindowTokens, num_predict: outputTokens, temperature: config.temperature, seed: config.seed } }, scope);
      run.append('model-outputs.jsonl', { ...scope, response: result.response, logicalCallId: entry.logicalCallId });
      if (result.prompt_eval_count !== inputTokens) throw new Error('tokenizer_mismatch_or_truncation');
      // Original importance uses max_tokens=1; a one-token length stop is expected there.
      if (result.done_reason === 'length' && !['importance', 'reflection_importance'].includes(scope.purpose)) throw new Error('output_truncated');
      if (!result.response?.trim()) throw new Error('empty_model_output');
      return result.response;
    };
    const embed = async (text, scope) => {
      const { result } = await client.request('/api/embed', { model: config.embeddingModel, input: text, truncate: false }, scope);
      const vector = result.embeddings?.[0];
      if (!Array.isArray(vector) || vector.length !== config.embeddingDimensions || !vector.every(Number.isFinite)) throw new Error('invalid_embedding');
      return vector;
    };
    const storeOptions = { dimensions: config.embeddingDimensions, embeddingVersion: config.embeddingDigest };
    let store = new MemoryStore(storeOptions);
    const file = path.join(run.directory, 'memory-snapshot.json'); store.save(file);
    const scopes = conversation.observedBy.map(agentId => ({ experimentId: run.runId, worldId: conversation.worldId, agentId }));
    for (const scope of scopes) {
      const writer = new ConversationMemoryWriter({ store, generate, embed });
      const result = await writer.remember(conversation, scope);
      store.save(file);
      run.append('memory-actions.jsonl', { action: 'remember', scope, ...result });
    }
    const beforeRestart = store.snapshot();
    store = new MemoryStore({ ...storeOptions, snapshot: JSON.parse(fs.readFileSync(file)) });
    assert.deepEqual(store.snapshot(), beforeRestart);
    const attemptsBeforeRetry = calls.length;
    for (const scope of scopes) await new ConversationMemoryWriter({ store, generate, embed }).remember(conversation, scope);
    assert.equal(calls.length, attemptsBeforeRetry);
    for (const key of ['experimentId', 'worldId', 'agentId']) assert.equal(store.visible({ ...scopes[0], [key]: 'foreign' }).length, 0);
    run.write('write-checks.json', { passed: true, memories: scopes.map(scope => ({ scope, count: store.visible(scope).length })),
      snapshotRestored: true, retryAdditionalAttempts: calls.length - attemptsBeforeRetry });

    // Independent, explicitly synthetic threshold fixture. No town state is modified.
    const reflectionScope = { experimentId: run.runId, worldId: 'controlled-reflection', agentId: 'probe-agent' };
    const seedMemories = Array.from({ length: config.reflectionFixture.count }, (_, i) => ({
      id: `seed-${i}`, kind: 'conversation', text: `I helped a neighbor plan a community garden during meeting ${i}.`,
      importance: config.reflectionFixture.importance, createdAtMs: 1000 + i, lastAccess: 1000 + i,
      embedding: Array.from({ length: config.embeddingDimensions }, (_, j) => j === 0 ? 1 : 0),
      embeddingVersion: config.embeddingDigest, sourceEventIds: [`synthetic-event-${i}`], sourceMemoryIds: [] }));
    run.write('reflection-fixture.json', { origin: config.reflectionFixture.origin, scope: reflectionScope, memories: seedMemories });
    if (!reflectionEligible(seedMemories)) throw new Error('reflection_fixture_below_original_threshold');
    const reflectionStore = new MemoryStore(storeOptions);
    reflectionStore.commit({ scope: reflectionScope, operationId: 'fixture', inputFingerprint: fingerprint(seedMemories), memories: seedMemories });
    reflectionStore.save(path.join(run.directory, 'reflection-snapshot.json'));
    const raw = await generate(reflectionMessages('Nora', seedMemories), { ...reflectionScope, purpose: 'reflection' });
    const insights = parseReflections(raw, seedMemories), reflected = [];
    for (const [i, item] of insights.entries()) {
      const importance = parseImportance(await generate(importanceMessages(item.text), { ...reflectionScope, purpose: 'reflection_importance' }, 1));
      const embedding = await embed(item.text, { ...reflectionScope, purpose: 'reflection_embedding' });
      reflected.push({ id: `reflection-${i}`, kind: 'reflection', ...item, sourceEventIds: [],
        importance: importance.value, importanceFallback: importance.fallback, createdAtMs: 10000, lastAccess: 10000,
        embedding, embeddingVersion: config.embeddingDigest });
    }
    reflectionStore.commit({ scope: reflectionScope, operationId: 'reflection-probe', inputFingerprint: fingerprint(seedMemories), memories: reflected });
    reflectionStore.save(path.join(run.directory, 'reflection-snapshot.json'));
    const gatewayBase = path.join(root, 'artifacts/local/gateway');
    const gatewayCalls = fs.readdirSync(gatewayBase).flatMap(dir => {
      const p = path.join(gatewayBase, dir, 'calls.jsonl');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    });
    const matched = calls.every(call => {
      const rows = gatewayCalls.filter(row => row.logicalCallId === call.logicalCallId && row.attempt === call.attempt);
      return rows.length === 1 && ['experimentId', 'worldId', 'agentId', 'purpose', 'inputTokens', 'outputTokens', 'status']
        .every(key => rows[0][key] === call[key]);
    });
    const summary = { diagnosticOnly: true, passed: matched && calls.every(c => c.usageStatus === 'measured'),
      conversationMemories: scopes.reduce((n, s) => n + store.visible(s).length, 0), snapshotRestored: true,
      retryAdditionalAttempts: 0, reflectionThresholdSum: seedMemories.reduce((n, m) => n + m.importance, 0),
      reflectionMemories: reflected.length, attempts: calls.length, allGatewayScopeAndUsageMatched: matched,
      purposes: [...new Set(calls.map(c => c.purpose))],
      generationInputTokens: calls.filter(c => c.endpoint === '/api/generate').reduce((n, c) => n + (c.inputTokens ?? 0), 0),
      generationOutputTokens: calls.filter(c => c.endpoint === '/api/generate').reduce((n, c) => n + (c.outputTokens ?? 0), 0),
      embeddingInputTokens: calls.filter(c => c.endpoint === '/api/embed').reduce((n, c) => n + (c.inputTokens ?? 0), 0),
      adaptations: config.adaptations,
      pending: ['上游 Convex 实际反思路径集成验证', '完整 baseline 检索与在线行为等价验证', '人工审核及正式策略质量/成本对照'] };
    run.write('summary.json', summary);
    if (!summary.passed) throw new Error('metering_or_scope_verification_failed');
    run.finish('completed'); console.log(JSON.stringify(summary, null, 2));
  } catch (error) { run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
