const test = require('node:test');
const assert = require('node:assert/strict');
const { referenceEvidence, expandReferences } = require('../lib/reference-extraction');
const { validateExtraction, TieredStore } = require('../lib/tiered-store');
const { TieredPolicy } = require('../lib/tiered-policy');
const { parseUniqueJson } = require('../lib/unique-json');
const time = Date.parse('2026-04-02');
const c = { schemaVersion: 2, type: 'conversation', id: 'c', worldId: 'w', createdAtMs: time,
  participants: [{ agentId: 'a', name: 'A' }, { agentId: 'b', name: 'B' }], observedBy: ['a', 'b'],
  messages: [{ id: 'm', authorAgentId: 'a', atMs: time + 1000, text: 'Update for April 2, 2026: The library now opens at 11:00. The previous opening time on April 1 was 10:00.' }] };
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' };
const payload = { facts: { e0: { subject: 'library', predicate: 'opening_time' }, e1: { subject: 'library', predicate: 'opening_time' } }, commitments: [] };
test('引用协议仅展开当前证据并绑定日期，不能由模型注入值或其他来源', () => {
  assert.equal(referenceEvidence(c).length, 2);
  const records = validateExtraction(expandReferences(payload, c), c);
  assert.equal(records[0].validFrom, '2026-04-02'); assert.equal(records[0].replacesPrior, true);
  assert.equal(records[1].validFrom, '2026-04-01'); assert.equal(records[1].replacesPrior, false);
  assert.deepEqual(records[0].sourceEventIds, ['m']);
  assert.throws(() => expandReferences({ facts: { foreign: { subject: 'x', predicate: 'y' } }, commitments: [] }, c), /reference/);
  const injection = structuredClone(payload); injection.facts.e0.value = 'made up';
  assert.throws(() => expandReferences(injection, c), /reference/);
});
test('引用写入可恢复，幂等重放不重新生成；跨世界输入在生成前拒绝', async () => {
  let calls = 0;
  const options = { dimensions: 2, embeddingVersion: 'd' }, store = new TieredStore(options);
  const args = { extractionFormat: 'dated_reference_schema_v1', generate: async () => { calls++; return JSON.stringify(payload); }, embed: async () => [1, 0] };
  await new TieredPolicy({ store, ...args }).observe(c, scope, { nowMs: time + 2000 });
  const restored = new TieredStore({ ...options, snapshot: store.snapshot() });
  const policy = new TieredPolicy({ store: restored, ...args });
  await policy.observe(c, scope, { nowMs: time + 2000 }); assert.equal(calls, 1);
  await assert.rejects(policy.observe({ ...c, worldId: 'other' }, scope, { nowMs: time + 2000 }), /scope/);
  assert.equal(calls, 1); assert.equal(restored.records(scope).length, 2);
});
test('引用 map 重复键不能经 JSON.parse 覆盖而静默丢事实，转义键同样拒绝', () => {
  assert.throws(() => parseUniqueJson('{"facts":{"e0":{},"e0":{}},"commitments":[]}'), /duplicate_json_key/);
  assert.throws(() => parseUniqueJson('{"e0":1,"\\u00650":2}'), /duplicate_json_key/);
  assert.deepEqual(parseUniqueJson('{"facts":{"e0":{"subject":"a, \\\"b\\\""}},"commitments":[]}'), { facts: { e0: { subject: 'a, "b"' } }, commitments: [] });
  assert.deepEqual(parseUniqueJson('[[],{},null,"a"]'), [[], {}, null, 'a']);
});
