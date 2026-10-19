const fs = require('node:fs');
const path = require('node:path');
const { root, hash } = require('../lib/artifacts');
const { TieredStore } = require('../lib/tiered-store');
function evaluate({ config, manifest, conversations, fixture, snapshots }) {
  if (config.mode !== 'diagnostic_tiered_extraction' || conversations.some(c => c.worldId !== fixture.worldId)
      || !fixture.acceptedTasks.length) throw new Error('invalid_probe_evaluation');
  const observers = [...new Set(conversations.flatMap(c => c.observedBy))];
  const visible = new Set(conversations.flatMap(c => c.messages.map(m => m.id)));
  if (fixture.acceptedTasks.some(t => !t.sourceEventIds.every(id => visible.has(id)))) throw new Error('fixture_source_not_visible');
  const expected = observers.length * config.repetitions * fixture.acceptedTasks.length;
  let matched = 0, unsupported = 0, missingSnapshots = 0;
  const rows = [];
  for (let rep = 1; rep <= config.repetitions; rep++) {
    const snapshot = snapshots[rep - 1];
    if (!snapshot) { missingSnapshots++; continue; }
    const store = new TieredStore({ dimensions: config.embeddingDimensions, embeddingVersion: config.embeddingDigest, snapshot });
    for (const agentId of observers) {
      const scope = { experimentId: `${manifest.runId}:${rep}`, worldId: fixture.worldId, agentId };
      const claims = store.records(scope).filter(r => r.kind === 'commitment');
      const supports = (r, t) => r.actorAgentId === fixture.agentId && r.itemId === t.itemId
        && r.recipientAgentId === t.recipientId && r.dueAtMs === t.dueAtMs
        && t.sourceEventIds.every(id => r.sourceEventIds.includes(id));
      const hits = fixture.acceptedTasks.filter(t => claims.some(r => supports(r, t))).length;
      const extras = claims.filter(r => !fixture.acceptedTasks.some(t => supports(r, t))).length;
      matched += hits; unsupported += extras;
      rows.push({ repetition: rep, agentId, expected: fixture.acceptedTasks.length, matched: hits, unsupported: extras });
    }
  }
  return { diagnosticOnly: true, runCompleted: manifest.status === 'completed', expected, matched, missing: expected - matched,
    unsupported, missingSnapshots, passed: manifest.status === 'completed' && matched === expected && unsupported === 0 && missingSnapshots === 0,
    rows, limitation: 'Exact accepted-delivery tuples on a development fixture only; no general fact-quality or online acceptance claim' };
}
function main() {
  const args = process.argv.slice(2); if (args.length !== 2) throw new Error('用法：node scripts/evaluate-tiered-extraction.js <run目录> <独立任务fixture>');
  const dir = path.resolve(root, args[0]), read = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
  const config = read('config.json'), fixtureBytes = fs.readFileSync(path.resolve(root, args[1]));
  const snapshots = Array.from({ length: config.repetitions }, (_, i) => { const file = path.join(dir, `state-${i + 1}.json`); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; });
  const result = { ...evaluate({ config, manifest: read('manifest.json'), conversations: read('conversations.json'), fixture: JSON.parse(fixtureBytes), snapshots }), fixtureSha256: hash(fixtureBytes), analysisScriptSha256: hash(fs.readFileSync(__filename)) };
  fs.writeFileSync(path.join(dir, `evaluation-${hash(fixtureBytes).slice(0, 12)}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { evaluate };
