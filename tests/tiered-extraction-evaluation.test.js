const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TieredStore, validateExtraction } = require('../lib/tiered-store');
const { evaluate } = require('../scripts/evaluate-tiered-extraction');
const load = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../experiments/datasets', name)));
const fixture = load('commitment-action.development.json');
const conversation = load('memory-quality.development.json').conversations.find(c => c.id === 'quality-promise');
const config = { mode: 'diagnostic_tiered_extraction', repetitions: 3, embeddingDimensions: 2, embeddingDigest: 'd' };
function snapshot(rep, recipient = 'iris') {
  const store = new TieredStore({ dimensions: 2, embeddingVersion: 'd' });
  for (const p of conversation.participants) {
    const claims = validateExtraction({ records: [{ kind: 'commitment', actor: 'rowan', action: 'deliver', item: 'blue notebook',
      recipient, dueAt: '2026-11-02T10:00:00Z', sourceEventIds: ['quality-promise-m2'],
      quote: 'I will deliver the blue notebook to Iris by 10:00 today.' }] }, conversation);
    store.commit({ scope: { experimentId: `probe:${rep}`, worldId: fixture.worldId, agentId: p.agentId }, conversation,
      records: claims.map((r, i) => ({ ...r, id: `claim-${i}`, observedAtMs: conversation.messages.at(-1).atMs, embedding: [1, 0] })) });
  }
  return store.snapshot();
}
const run = snapshots => evaluate({ config, manifest: { runId: 'probe', status: 'completed' }, conversations: [conversation], fixture, snapshots });
test('承诺抽取评分保留缺失重复的分母，空输出不能通过', () => {
  const missing = run([snapshot(1), null, null]);
  assert.equal(missing.expected, 6); assert.equal(missing.matched, 2); assert.equal(missing.missing, 4); assert.equal(missing.passed, false);
  const complete = run([snapshot(1), snapshot(2), snapshot(3)]); assert.equal(complete.passed, true);
});
test('合法结构和来源仍可能语义错误，独立任务目标核验拒绝错误收件人', () => {
  const wrong = run([snapshot(1, 'rowan'), snapshot(2), snapshot(3)]);
  assert.equal(wrong.matched, 4); assert.equal(wrong.unsupported, 2); assert.equal(wrong.passed, false);
});
