const test = require('node:test');
const assert = require('node:assert/strict');
const { TieredStore, validateExtraction, timestamp } = require('../lib/tiered-store');
const { TieredPolicy, parsePlan } = require('../lib/tiered-policy');
const { sourceSentenceSchema } = require('../lib/tiered-schema');
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' }, day1 = Date.parse('2026-01-01'), day2 = Date.parse('2026-01-02');
const c = (id = 'c1', time = day1) => ({ schemaVersion: 2, type: 'conversation', id, worldId: 'w', createdAtMs: time,
  participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bea' }], observedBy: ['a', 'b'],
  messages: [{ id: `${id}-m`, authorAgentId: 'a', atMs: time + 1000,
    text: `The cafe opens at ${time === day1 ? '09' : '10'}:00. I accept. I will deliver the blue notebook to Bea by 10:00 today.` }] });
const fact = (id = 'c1', extra = {}) => ({ kind: 'fact', subject: 'cafe', predicate: 'opening_time', value: '09:00',
  validFrom: '2026-01-01', validUntil: null, replacesPrior: false, sourceEventIds: [`${id}-m`], quote: 'The cafe opens at 09:00.', ...extra });
const promise = () => ({ kind: 'commitment', actor: 'a', action: 'deliver', item: 'blue notebook', recipient: 'b',
  dueAt: '2026-01-01T10:00:00Z', sourceEventIds: ['c1-m'], quote: 'I accept. I will deliver the blue notebook to Bea by 10:00 today.' });
const store = snapshot => new TieredStore({ dimensions: 2, embeddingVersion: 'digest', snapshot });
function commit(s, conversation, claims) {
  const records = validateExtraction({ records: claims }, conversation).map((r, i) => ({ ...r, id: `${conversation.id}-${i}`,
    observedAtMs: conversation.messages.at(-1).atMs, embedding: [1, 0] }));
  return s.commit({ scope, conversation, records });
}
test('显式时间替换保留历史，原始记录不变；不明确替换的冲突不能覆盖', () => {
  const s = store(); commit(s, c(), [fact()]);
  commit(s, c('c2', day2), [fact('c2', { value: '10:00', quote: 'The cafe opens at 10:00.', validFrom: '2026-01-02', replacesPrior: true })]);
  assert.equal(s.materialize(scope, { nowMs: day2 + 5000, asOfMs: day1 + 5000 })[0].value, '09:00');
  assert.equal(s.materialize(scope, { nowMs: day2 + 5000 })[0].value, '10:00');
  assert.equal(s.records(scope).length, 2); assert.equal(s.records(scope)[0].validUntilMs, null);
  const conflicting = store(); commit(conflicting, c(), [fact()]);
  commit(conflicting, c('c2', day2), [fact('c2', { value: '10:00', quote: 'The cafe opens at 10:00.', validFrom: '2026-01-02' })]);
  assert.ok(conflicting.materialize(scope, { nowMs: day2 + 5000 }).every(r => r.conflict));
});
test('来源/原文/角色/时间校验与世界隔离，恢复/幂等保留归档', () => {
  assert.throws(() => validateExtraction({ records: [fact('foreign')] }, c()), /source/);
  assert.throws(() => validateExtraction({ records: [fact('c1', { quote: 'Invented quote' })] }, c()), /quote/);
  assert.throws(() => validateExtraction({ records: [fact('c1', { value: '10:00' })] }, c()), /not_in_quote/);
  assert.throws(() => timestamp('2026-02-30'), /time/);
  assert.throws(() => validateExtraction({ records: [fact('c1', { replacesPrior: true, validFrom: null })] }, c()), /interval/);
  const s = store(); commit(s, c(), [fact()]); const before = s.snapshot();
  assert.equal(commit(s, c(), [fact()]).inserted, false);
  assert.deepEqual(store(before).snapshot(), before);
  for (const key of ['experimentId', 'worldId', 'agentId']) assert.deepEqual(s.records({ ...scope, [key]: 'foreign' }), []);
  const invalid = { ...c(), worldId: 'foreign' };
  assert.throws(() => s.commit({ scope, conversation: invalid, records: [] }), /scope/);
  assert.deepEqual(s.archives(scope), [c()]);
});
test('承诺必须由实际作者明确接受；执行器匹配回执才改变状态，可恢复历史', () => {
  assert.throws(() => validateExtraction({ records: [{ ...promise(), actor: 'b' }] }, c()), /acceptance/);
  assert.throws(() => validateExtraction({ records: [{ ...promise(), item: 'red diary' }] }, c()), /affirmative/);
  const negative = c(); negative.messages[0].text = 'I will not deliver the blue notebook to Bea today.';
  assert.throws(() => validateExtraction({ records: [{ ...promise(), quote: negative.messages[0].text }] }, negative), /affirmative/);
  const s = store(); commit(s, c(), [promise()]);
  const at = day1 + 9 * 3600000, receipt = { scope, actionId: 'delivery', atMs: at,
    action: { action: 'deliver', itemId: 'blue_notebook', recipientId: 'b' } };
  assert.equal(s.materialize(scope, { nowMs: at })[0].status, 'pending');
  assert.throws(() => s.complete(scope, 'c1-0', { ...receipt, action: { ...receipt.action, recipientId: 'a' } }), /fulfill/);
  s.complete(scope, 'c1-0', receipt); assert.equal(s.complete(scope, 'c1-0', receipt).inserted, false);
  const restored = store(s.snapshot()); assert.equal(restored.materialize(scope, { nowMs: at })[0].status, 'completed_on_time');
  assert.equal(restored.materialize(scope, { nowMs: at, asOfMs: at - 1000 })[0].status, 'pending');
});
test('结构化抽取和向量批次失败不发布；恢复后重复观察不调用模型', async () => {
  const s = store(); let broken = true, calls = 0;
  const options = { generate: async () => { calls++; return JSON.stringify({ records: [fact()] }); },
    embed: async () => { if (broken) throw new Error('embedding_failed'); return [1, 0]; } };
  let p = new TieredPolicy({ store: s, ...options });
  await assert.rejects(p.observe(c(), scope, { nowMs: day1 + 2000 }), /embedding_failed/); assert.deepEqual(s.records(scope), []);
  broken = false; await p.observe(c(), scope, { nowMs: day1 + 2000 });
  const count = calls; p = new TieredPolicy({ store: store(s.snapshot()), ...options });
  await p.observe(c(), scope, { nowMs: day1 + 2000 }); assert.equal(calls, count);
});
test('查询日期必须来自问题，未知/未来日期拒绝；关键承诺放不下显式拒绝', async () => {
  assert.equal(parsePlan('{"asOfDate":"2026-01-01","focus":"fact"}', 'On January 1, 2026?', day2).asOfMs, day1 + 86400000 - 1);
  assert.throws(() => parsePlan('{"asOfDate":"2026-01-01","focus":"fact"}', 'Current?', day2), /ungrounded/);
  assert.throws(() => parsePlan('{"asOfDate":"2026-01-03","focus":"fact"}', '2026-01-03?', day2), /future/);
  assert.throws(() => parsePlan('{"asOfDate":null,"focus":null}', 'Current?', day2), /ungrounded/);
  const s = store(); commit(s, c(), [promise()]);
  const p = new TieredPolicy({ store: s, generate: async () => '{"asOfDate":null,"focus":"commitment"}', embed: async () => [1, 0] });
  const before = s.snapshot();
  const result = await p.retrieve(scope, { text: 'What did I promise?', queryId: 'q', nowMs: day1 + 2000, n: 3,
    memoryBudgetTokens: 1, maxInputTokens: 1000, countTokens: text => text.length,
    renderMemory: rows => rows.map(m => m.text).join(''), renderInput: rows => 'task:' + rows.map(m => m.text).join('') });
  assert.equal(result.executable, false); assert.equal(result.rejectionReason, 'critical_commitment_budget_exceeded');
  assert.deepEqual(s.snapshot(), before);
});
test('抽取纠错有硬上限，每次生成独立留痕；超时不纠错且不写入', async () => {
  const s = store(), attempts = [], events = [];
  const p = new TieredPolicy({ store: s, maxExtractionAttempts: 2,
    generate: async (messages, metadata) => {
      attempts.push(metadata.extractionAttempt);
      if (attempts.length === 2) assert.match(messages.at(-1).content, /Validation failed/);
      return JSON.stringify({ records: [fact('c1', { value: attempts.length === 1 ? 'false' : '09:00' })] });
    }, embed: async () => [1, 0], record: row => events.push(row) });
  await p.observe(c(), scope, { nowMs: day1 + 2000 });
  assert.deepEqual(attempts, [1, 2]); assert.equal(s.records(scope).length, 1);
  assert.equal(events.filter(r => r.action === 'tiered_extraction_rejected').length, 1);
  for (const failure of ['invalid', 'timeout']) {
    const empty = store(); let calls = 0;
    const bad = new TieredPolicy({ store: empty, maxExtractionAttempts: 2,
      generate: async () => { calls++; if (failure === 'timeout') throw new Error('timeout'); return '{}'; }, embed: async () => [1, 0] });
    await assert.rejects(bad.observe(c(), scope, { nowMs: day1 + 2000 }));
    assert.equal(calls, failure === 'timeout' ? 1 : 2); assert.deepEqual(empty.snapshot().transactions, []);
  }
});
test('句子约束只来自当前可见消息，跨消息拼接仍由来源校验拒绝', () => {
  const conversation = c(), schema = sourceSentenceSchema(conversation);
  const fields = schema.properties.records.items.anyOf[0].properties;
  assert.ok(fields.value.enum.includes('The cafe opens at 09:00.'));
  assert.ok(!fields.value.enum.includes('false'));
  assert.deepEqual(fields.sourceEventIds.items.enum, ['c1-m']);
  assert.deepEqual(fields.quote.enum, [conversation.messages[0].text]);
  const second = { ...conversation, messages: [...conversation.messages, { id: 'c1-other', authorAgentId: 'b', atMs: day1 + 2000, text: 'A different, private assertion.' }] };
  const branches = sourceSentenceSchema(second).properties.records.items.anyOf.filter(b => b.properties.kind.const === 'fact');
  assert.equal(branches.length, 2);
  for (const branch of branches) {
    const f = branch.properties, message = second.messages.find(m => m.id === f.sourceEventIds.items.enum[0]);
    assert.deepEqual(f.quote.enum, [message.text]);
    assert.ok(f.value.enum.every(value => message.text.includes(value)));
    assert.equal(f.sourceEventIds.maxItems, 1);
  }
  assert.throws(() => validateExtraction({ records: [fact('c1', { value: 'I accept.', quote: 'The cafe opens at 09:00.' })] }, conversation), /not_in_quote/);
});
test('抽取条数上限在解码之外复验，超额不能静默保留部分记录', async () => {
  const s = store(); let embeddings = 0;
  assert.throws(() => new TieredPolicy({ store: s, maxExtractedRecords: 0 }), /record_limit/);
  const p = new TieredPolicy({ store: s, maxExtractedRecords: 1,
    generate: async messages => { assert.match(messages[0].content, /at most 1 records/); return JSON.stringify({ records: [fact(), promise()] }); },
    embed: async () => { embeddings++; return [1, 0]; } });
  await assert.rejects(p.observe(c(), scope, { nowMs: day1 + 2000 }), /record_limit_exceeded/);
  assert.equal(embeddings, 0); assert.deepEqual(s.snapshot().transactions, []);
});
