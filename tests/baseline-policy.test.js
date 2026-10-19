const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../lib/memory-store');
const { BaselinePolicy, cosine } = require('../lib/baseline-policy');
const { fingerprint } = require('../lib/conversations-v2');
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' };
const memory = (id, extra = {}) => ({ id, kind: 'conversation', text: `Memory ${id}`, importance: 5,
  createdAtMs: 1000, lastAccess: 1000, embedding: [1, 0], embeddingVersion: 'digest', sourceEventIds: [id], sourceMemoryIds: [], ...extra });
function setup(memories = []) {
  const store = new MemoryStore({ dimensions: 2, embeddingVersion: 'digest' });
  if (memories.length) store.commit({ scope, operationId: 'seed', inputFingerprint: fingerprint(memories), memories });
  return store;
}
const query = extra => ({ queryId: 'q1', text: 'Question', nowMs: 1000000, maxInputTokens: 1000,
  countTokens: text => text.length, renderMemory: rows => rows.map(r => r.text).join('\n'),
  renderInput: rows => `task:${rows.map(r => r.text).join('\n')}`, ...extra });
const generate = async (_, scope) => scope.purpose === 'reflection_importance' ? '5'
  : '[{"insight":"I help neighbors","statementIds":[0,1]}]';

test('余弦验证真实向量形状，零向量拒绝；作用域隔离先于 embedding', async () => {
  assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.throws(() => cosine([0, 0], [1, 0]), /zero/);
  assert.throws(() => cosine([NaN], [1]), /invalid/);
  let calls = 0; const policy = new BaselinePolicy({ store: setup([memory('m')]), generate,
    embed: async () => { calls++; return [1, 0]; } });
  for (const key of ['experimentId', 'worldId', 'agentId']) {
    const result = await policy.retrieve({ ...scope, [key]: 'foreign' }, query());
    assert.deepEqual(result.selected, []);
  }
  assert.equal(calls, 0);
});
test('检索串联相关性重排与预算选择；只读探针不 touch，写入访问可恢复', async () => {
  const store = setup([memory('first'), memory('second', { embedding: [0, 1] })]);
  const policy = new BaselinePolicy({ store, generate, embed: async () => [1, 0] });
  const before = store.snapshot();
  const selected = await policy.retrieve(scope, query({ n: 1 }));
  assert.equal(selected.selected[0].id, 'first'); assert.deepEqual(store.snapshot(), before);
  await policy.retrieve(scope, query({ n: 1, readOnly: false }));
  assert.equal(store.visible(scope)[0].lastAccess, 1000000);
  assert.equal(store.visible(scope)[1].lastAccess, 1000);
  const recovered = new MemoryStore({ dimensions: 2, embeddingVersion: 'digest', snapshot: store.snapshot() });
  assert.deepEqual(recovered.visible(scope), store.visible(scope));
  const budget = await policy.retrieve(scope, query({ queryId: 'q2', policy: 'budgeted_retrieval', memoryBudgetTokens: 1 }));
  assert.deepEqual(budget.selected, []); assert.ok(budget.excluded.every(x => x.reason === 'memory_budget'));
});
test('溢出拒绝不更新访问，非法参数与时钟在调用模型前失败', async () => {
  const store = setup([memory('m', { text: 'x'.repeat(30) })]); let calls = 0;
  const policy = new BaselinePolicy({ store, generate, embed: async () => { calls++; return [1, 0]; } });
  const before = store.snapshot();
  const rejected = await policy.retrieve(scope, query({ maxInputTokens: 10, readOnly: false }));
  assert.equal(rejected.executable, false); assert.deepEqual(store.snapshot(), before);
  const count = calls;
  await assert.rejects(policy.retrieve(scope, query({ policy: 'unknown' })), /invalid/);
  await assert.rejects(policy.retrieve(scope, query({ nowMs: 0 })), /clock/);
  await assert.rejects(policy.retrieve(scope, query({ maxInputTokens: 1 })), /essential/);
  assert.equal(calls, count);
});
test('自动反思仅用最新 100 条，失败不发布，恢复重试后不重复反思', async () => {
  const seeds = Array.from({ length: 60 }, (_, i) => memory(String(i), { importance: 9, createdAtMs: 1000 + i }));
  const store = setup(seeds); let failure = true, calls = 0;
  let policy = new BaselinePolicy({ store, generate: async (...args) => { calls++; return generate(...args); },
    embed: async () => { if (failure) throw new Error('embedding_failed'); return [1, 0]; } });
  await assert.rejects(policy.consolidate(scope, { nowMs: 10000, name: 'Nora' }), /embedding_failed/);
  assert.equal(store.visible(scope).length, 60); failure = false;
  const recovered = new MemoryStore({ dimensions: 2, embeddingVersion: 'digest', snapshot: store.snapshot() });
  policy = new BaselinePolicy({ store: recovered, generate: async (...args) => { calls++; return generate(...args); }, embed: async () => [1, 0] });
  assert.equal((await policy.consolidate(scope, { nowMs: 10000, name: 'Nora' })).reflected, true);
  assert.equal(recovered.visible(scope).length, 61);
  const count = calls;
  assert.equal((await policy.consolidate(scope, { nowMs: 11000, name: 'Nora' })).reflected, false);
  assert.equal(calls, count);
  assert.ok(recovered.visible(scope).at(-1).sourceMemoryIds.every(id => seeds.some(m => m.id === id)));
});
test('旧的高分记忆在最新 100 之外不会触发；非法 JSON 不调用评分/向量', async () => {
  const old = memory('old', { importance: 1000, createdAtMs: 1 });
  const recent = Array.from({ length: 100 }, (_, i) => memory(`recent-${i}`, { importance: 0, createdAtMs: 1000 + i }));
  const store = setup([old, ...recent]);
  const policy = new BaselinePolicy({ store, generate: async () => { throw new Error('should_not_call'); }, embed: async () => [1, 0] });
  assert.equal((await policy.consolidate(scope, { name: 'Nora', nowMs: 2000 })).reflected, false);
  const invalid = new BaselinePolicy({ store: setup([memory('high', { importance: 501 })]),
    generate: async () => 'not JSON', embed: async () => { throw new Error('should_not_embed'); } });
  await assert.rejects(invalid.consolidate(scope, { name: 'Nora', nowMs: 2000 }), SyntaxError);
  assert.equal(invalid.store.visible(scope).length, 1);
});
test('touch 节流、幂等、作用域验证和 v1 快照迁移', () => {
  const store = setup([memory('m')]);
  const tx = { scope, operationId: 'q', ids: ['m'], nowMs: 301000 };
  store.touch(tx); assert.equal(store.visible(scope)[0].lastAccess, 1000); // strict <, not <=
  assert.equal(store.touch(tx).inserted, false);
  assert.throws(() => store.touch({ ...tx, nowMs: 400000 }), /conflict/);
  assert.throws(() => store.touch({ ...tx, scope: { ...scope, agentId: 'foreign' } }), /invalid/);
  const legacy = setup([memory('m')]).snapshot(); legacy.schemaVersion = 1; delete legacy.touchTransactions;
  const restored = new MemoryStore({ dimensions: 2, embeddingVersion: 'digest', snapshot: legacy });
  assert.equal(restored.snapshot().schemaVersion, 2); assert.equal(restored.visible(scope).length, 1);
});

test('会话已写入但反思失败后，恢复并重放会话会补做维护而非重复摘要', async () => {
  const store = setup(Array.from({ length: 60 }, (_, i) => memory(`seed-${i}`, { importance: 9 })));
  const event = { schemaVersion: 2, type: 'conversation', id: 'c', worldId: 'w', createdAtMs: 1500,
    participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bob' }], observedBy: ['a', 'b'],
    messages: [{ id: 'event', authorAgentId: 'a', atMs: 2000, text: 'Hello' }] };
  const failing = new BaselinePolicy({ store, generate: async (_, scope) => {
    if (scope.purpose === 'reflection') throw new Error('reflection_failed');
    return scope.purpose === 'importance' ? '5' : 'Summary';
  }, embed: async () => [1, 0] });
  await assert.rejects(failing.observe(event, scope, { nowMs: 3000, name: 'Alice' }), /reflection_failed/);
  assert.equal(store.visible(scope).filter(m => m.id === 'conversation:c').length, 1);
  const recovered = new MemoryStore({ dimensions: 2, embeddingVersion: 'digest', snapshot: store.snapshot() });
  const purposes = [];
  const resumed = new BaselinePolicy({ store: recovered, generate: async (...args) => {
    purposes.push(args[1].purpose); return generate(...args);
  }, embed: async () => [1, 0] });
  const result = await resumed.observe(event, scope, { nowMs: 4000, name: 'Alice' });
  assert.equal(result.write.inserted, false); assert.equal(result.maintenance.reflected, true);
  assert.deepEqual(purposes, ['reflection', 'reflection_importance']);
});
