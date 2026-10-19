const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarDates } = require('../lib/calendar-dates');
const { deterministicPlan } = require('../lib/query-plan');
const { datedEvidence, validateDatedFacts } = require('../lib/temporal-evidence');
const { TieredStore, validateExtraction } = require('../lib/tiered-store');
const { TieredPolicy } = require('../lib/tiered-policy');
const d1 = Date.parse('2026-03-01'), d2 = Date.parse('2026-03-02');
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' };
function conversation(id, time, text) { return { schemaVersion: 2, type: 'conversation', id, worldId: 'w', createdAtMs: time,
  participants: [{ agentId: 'a', name: 'A' }, { agentId: 'b', name: 'B' }], observedBy: ['a', 'b'],
  messages: [{ id: `${id}-m`, authorAgentId: 'a', atMs: time + 1000, text }] }; }
const c1 = conversation('old', d1, 'On March 1, 2026, Maple Library opens at 07:00.');
const c2 = conversation('new', d2, 'Update for March 2, 2026: Maple Library now opens at 08:00. The previous opening time on March 1 was 07:00.');
const claims = c => datedEvidence(c).candidates.map(e => ({ kind: 'fact', subject: 'Maple Library', predicate: 'opening_time',
  value: e.quote, quote: e.quote, validFrom: e.validFrom, validUntil: e.validUntil, replacesPrior: e.replacesPrior, sourceEventIds: [e.sourceEventId] }));
function commit(store, c) {
  const rows = claims(c); validateDatedFacts(rows, c);
  store.commit({ scope, conversation: c, records: validateExtraction({ records: rows }, c).map((r, i) => ({ ...r,
    id: `${c.id}-${i}`, observedAtMs: c.messages.at(-1).atMs, embedding: [1, 0] })) });
}
test('日期严格校验，部分日期只在显式会话年上下文使用，不把无效日期滚动到下月', () => {
  assert.throws(() => calendarDates('February 30, 2026'), /invalid_calendar_date/);
  assert.throws(() => calendarDates('2026-02-30'), /invalid_calendar_date/);
  assert.deepEqual([...calendarDates('March 1')], []);
  assert.deepEqual([...calendarDates('March 1', { referenceDate: '2026-03-02', allowPartial: true })], ['2026-03-01']);
  assert.throws(() => deterministicPlan('Compare March 1, 2026 and March 2, 2026', d2), /ambiguous/);
});
test('事实句子绑定生效日，历史重述不替换；恢复后当前/历史视图均可追溯', () => {
  const store = new TieredStore({ dimensions: 2, embeddingVersion: 'd' }); commit(store, c1); commit(store, c2);
  const restored = new TieredStore({ dimensions: 2, embeddingVersion: 'd', snapshot: store.snapshot() });
  assert.ok(restored.materialize(scope, { nowMs: d2 + 5000 }).every(r => r.value.includes('08:00')));
  assert.ok(restored.materialize(scope, { nowMs: d2 + 5000, asOfMs: d1 + 86400000 - 1 }).every(r => r.value.includes('07:00')));
  const wrong = claims(c2); wrong[1].validFrom = '2026-03-02';
  assert.throws(() => validateDatedFacts(wrong, c2), /mismatch/);
  assert.deepEqual(restored.records({ ...scope, worldId: 'other' }), []);
});
test('复合时间与无效日期有排除原因，不把整句的历史/当前值绑定到一个日期', () => {
  const mixed = conversation('mixed', d2, 'Current time is 08:00, while March 1 was 07:00. February 30, 2026 was a date.');
  const evidence = datedEvidence(mixed);
  assert.deepEqual(evidence.candidates, []);
  assert.deepEqual(evidence.excluded.map(e => e.reason), ['ambiguous_temporal_sentence', 'invalid_calendar_date']);
  const deadline = datedEvidence(conversation('deadline', d2, 'Deliver the parcel by March 3, 2026. The library is closed until March 3, 2026.'));
  assert.deepEqual(deadline.candidates, []);
  assert.ok(deadline.excluded.every(e => e.reason === 'unsupported_validity_relation'));
});
test('规则规划不调用生成模型，多日期拒绝前不做向量调用，读取不污染快照', async () => {
  const store = new TieredStore({ dimensions: 2, embeddingVersion: 'd' }); commit(store, c1); commit(store, c2);
  let embeddings = 0;
  const policy = new TieredPolicy({ store, queryPlanner: 'deterministic_any_v1', generate: async () => { throw new Error('unexpected_generation'); }, embed: async () => { embeddings++; return [1, 0]; } });
  const options = { queryId: 'q', nowMs: d2 + 5000, n: 3, memoryBudgetTokens: 10000, maxInputTokens: 20000,
    countTokens: s => s.length, renderMemory: rows => JSON.stringify(rows), renderInput: rows => JSON.stringify(rows) };
  const before = store.snapshot();
  const result = await policy.retrieve(scope, { ...options, text: 'Opening time on March 1, 2026?' });
  assert.equal(result.plan.planner, 'deterministic_any_v1'); assert.equal(result.executable, true);
  assert.ok(result.selected.every(r => r.text.includes('07:00'))); assert.equal(embeddings, 1);
  await assert.rejects(policy.retrieve(scope, { ...options, text: 'March 1, 2026 and March 2, 2026?' }), /ambiguous/);
  assert.equal(embeddings, 1); assert.deepEqual(store.snapshot(), before);
});
test('日期模式提交与恢复均复验原文绑定，结构合法的错误时间不能发布', async () => {
  const store = new TieredStore({ dimensions: 2, embeddingVersion: 'd' }); let embeddings = 0;
  const bad = claims(c1); bad[0].validFrom = '2026-03-02';
  const policy = new TieredPolicy({ store, extractionFormat: 'dated_sentence_schema_v1',
    generate: async () => JSON.stringify({ records: bad }), embed: async () => { embeddings++; return [1, 0]; } });
  await assert.rejects(policy.observe(c1, scope, { nowMs: d1 + 5000 }), /mismatch/);
  assert.equal(embeddings, 0); assert.deepEqual(store.snapshot().transactions, []);
  commit(store, c1); const snapshot = store.snapshot();
  snapshot.transactions[0].records[0].validFrom = '2026-03-02'; snapshot.transactions[0].records[0].validFromMs = d2;
  const restored = new TieredStore({ dimensions: 2, embeddingVersion: 'd', snapshot });
  assert.throws(() => new TieredPolicy({ store: restored, extractionFormat: 'dated_sentence_schema_v1' }), /mismatch/);
});
