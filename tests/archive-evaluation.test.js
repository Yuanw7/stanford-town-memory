const test = require('node:test');
const assert = require('node:assert/strict');
const { ArchiveStore, ArchivePolicy } = require('../lib/archive-policy');
const { archiveSourceOverlap } = require('../lib/archive-evaluation');
async function fixture() {
  const day1 = Date.parse('2026-05-01'), day2 = Date.parse('2026-05-02');
  const store = new ArchiveStore({ dimensions: 2, embeddingVersion: 'd' });
  const policy = new ArchivePolicy({ store, embed: async () => [1, 0] });
  const scope = { experimentId: 'run:archive', worldId: 'w', agentId: 'a' };
  for (const [id, time] of [['old', day1], ['late', day2]]) await policy.observe({ schemaVersion: 2, type: 'conversation', id, worldId: 'w', createdAtMs: time,
    participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bea' }], observedBy: ['a', 'b'],
    messages: [{ id, authorAgentId: 'a', atMs: time + 1, text: 'The library opened at 07:00 on May 1, 2026.' }] }, scope, { nowMs: time + 100 });
  return { config: { repetitions: 2, variants: [{ id: 'archive', policy: 'archive_retrieval' }], embeddingDimensions: 2, embeddingDigest: 'd' },
    manifest: { runId: 'run' }, snapshots: { '1:archive': store.snapshot() },
    workload: { queries: [{ id: 'q', worldId: 'w', agentId: 'a', text: 'Opening time on May 1, 2026?', atMs: day2 + 100 }] },
    truth: [{ id: 'q', sourceEventIds: ['old', 'late'] }], retrieval: [{ strategy: 'archive', repetition: 1, queryId: 'q', selectedIds: ['archive:old'] }] };
}
test('来源交集不要求所有替代来源都选中，缺失重复仍保留分母与未评状态', async () => {
  const result = archiveSourceOverlap(await fixture()).byVariant.archive;
  assert.equal(result.expectedAnswerable, 2); assert.equal(result.anyAnnotatedSourceSelected, 1); assert.equal(result.unassessed, 1);
  assert.equal(result.rows[1].anyAnnotatedSourceSelected, null);
});
test('来源评估拒绝越过历史截止或角色作用域的选中记录', async () => {
  const args = await fixture(); args.retrieval[0].selectedIds = ['archive:late'];
  assert.throws(() => archiveSourceOverlap(args), /not_visible_at_time/);
  args.retrieval[0].selectedIds = ['archive:old']; args.workload.queries[0].agentId = 'b';
  assert.throws(() => archiveSourceOverlap(args), /not_visible_at_time/);
});
