const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveStore, ArchivePolicy } = require('../lib/archive-policy');
const day1 = Date.parse('2026-05-01'), day2 = Date.parse('2026-05-02');
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' };
const options = { dimensions: 2, embeddingVersion: 'd' };
function conversation(id = 'old', at = day1, world = 'w') { return { schemaVersion: 2, type: 'conversation', id, worldId: world, createdAtMs: at,
  participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bea' }], observedBy: ['a', 'b'],
  messages: [{ id: `${id}-1`, authorAgentId: 'a', atMs: at + 1, text: id === 'old' ? 'The library opens at 07:00.' : 'Today opens at 08:00; yesterday opened at 07:00.' },
    { id: `${id}-2`, authorAgentId: 'b', atMs: at + 2, text: 'I heard your statement.' }] }; }
const query = { text: 'What did I hear?', queryId: 'q', nowMs: day2 + 1000, n: 3, readOnly: true,
  memoryBudgetTokens: 10000, maxInputTokens: 20000, countTokens: s => s.length,
  renderMemory: rows => JSON.stringify(rows), renderInput: rows => `task:${JSON.stringify(rows)}` };
test('归档向量批次失败不发布，恢复与并发重放幂等，冲突不能覆盖原文', async () => {
  const store = new ArchiveStore(options); let calls = 0, fail = true;
  const embed = async () => { calls++; if (fail && calls === 2) throw new Error('embedding_failed'); return [1, 0]; };
  const policy = new ArchivePolicy({ store, embed });
  await assert.rejects(policy.observe(conversation(), scope, { nowMs: day1 + 1000 }), /embedding_failed/);
  assert.deepEqual(store.records(scope), []); fail = false;
  await Promise.all([policy.observe(conversation(), scope, { nowMs: day1 + 1000 }), policy.observe(conversation(), scope, { nowMs: day1 + 1000 })]);
  assert.equal(calls, 4); assert.equal(store.records(scope).length, 2);
  const restored = new ArchiveStore({ ...options, snapshot: store.snapshot() });
  await new ArchivePolicy({ store: restored, embed }).observe(conversation(), scope, { nowMs: day1 + 1000 }); assert.equal(calls, 4);
  const changed = conversation(); changed.messages[0].text = 'Changed';
  await assert.rejects(policy.observe(changed, scope, { nowMs: day1 + 1000 }), /conflict/); assert.equal(calls, 4);
  const corrupt = store.snapshot(); corrupt.transactions[0].records[0].text = 'Invented';
  assert.throws(() => new ArchiveStore({ ...options, snapshot: corrupt }), /invalid_archive_record/);
});
test('按实验/世界/角色隔离后才检索，历史视图排除后来对过去的转述', async () => {
  const store = new ArchiveStore(options); let embeddings = 0;
  const policy = new ArchivePolicy({ store, embed: async () => { embeddings++; return [1, 0]; } });
  await policy.observe(conversation(), scope, { nowMs: day1 + 1000 });
  await policy.observe(conversation('new', day2), scope, { nowMs: day2 + 1000 });
  await policy.observe(conversation('foreign', day1, 'other'), { ...scope, worldId: 'other' }, { nowMs: day1 + 1000 });
  const before = store.snapshot();
  const historical = await policy.retrieve(scope, { ...query, text: 'Opening time on May 1, 2026?' });
  assert.ok(historical.selected.length > 0); assert.ok(historical.selected.every(m => m.id.startsWith('archive:old-')));
  assert.equal(historical.plan.planner, 'archive_observed_time_v1');
  for (const key of ['experimentId', 'agentId']) {
    const count = embeddings; const empty = await policy.retrieve({ ...scope, [key]: 'unknown' }, query);
    assert.deepEqual(empty.selected, []); assert.equal(embeddings, count);
  }
  assert.deepEqual(store.snapshot(), before);
});
test('预算整条排除且可观察，非法窗口/日期/写入模式不发起检索向量调用', async () => {
  const store = new ArchiveStore(options); let calls = 0;
  const policy = new ArchivePolicy({ store, embed: async () => { calls++; return [1, 0]; } });
  await policy.observe(conversation(), scope, { nowMs: day1 + 1000 });
  const small = await policy.retrieve(scope, { ...query, memoryBudgetTokens: 1 });
  assert.deepEqual(small.selected, []); assert.ok(small.excluded.every(m => m.reason === 'memory_budget'));
  const count = calls;
  for (const extra of [{ maxInputTokens: 1 }, { readOnly: false }, { text: 'May 1, 2026 and May 2, 2026?' }]) await assert.rejects(policy.retrieve(scope, { ...query, ...extra }));
  assert.equal(calls, count);
});
