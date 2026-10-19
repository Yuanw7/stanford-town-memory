const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { root, hash } = require('../lib/artifacts');
const { validateTownSnapshot } = require('../lib/town-validation');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--wait')) {
    throw new Error('用法：node scripts/stage2-report.js <观察 run 目录> [--wait]');
  }
  const directory = path.resolve(root, args[0]);
  const expires = Date.now() + 40 * 60 * 1000;
  let manifest = read(path.join(directory, 'manifest.json'));
  if (manifest.kind !== 'town-observe') throw new Error('需要 town-observe run');
  while (manifest.status === 'running' && args[1] === '--wait' && Date.now() < expires) {
    await delay(30000);
    manifest = read(path.join(directory, 'manifest.json'));
  }
  if (manifest.status === 'running') throw new Error('观察未结束，不能生成验收结论');
  // The observer finishes its manifest before its finally block stops the world.
  // Wait for the explicit stop result, then drain outstanding inference attempts.
  let controls = rows(path.join(directory, 'control-events.jsonl'));
  const drainDeadline = Date.now() + 180000;
  let health;
  let drainedSamples = 0;
  if (manifest.status === 'completed') {
    do {
      controls = rows(path.join(directory, 'control-events.jsonl'));
      const response = await fetch('http://127.0.0.1:11435/health', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('无法核查网关排空状态');
      health = await response.json();
      if (controls.some(c => c.action === 'stop' && c.succeeded) && health.active === 0 && health.queued === 0) drainedSamples++;
      else drainedSamples = 0;
      if (drainedSamples >= 2) break;
      await delay(3000);
    } while (Date.now() < drainDeadline);
  }
  const snapshots = rows(path.join(directory, 'snapshots.jsonl'));
  const initialPath = path.join(directory, 'initial-snapshot.json');
  const initial = fs.existsSync(initialPath) ? read(initialPath) : null;
  const activity = fs.existsSync(path.join(directory, 'summary.json')) ? read(path.join(directory, 'summary.json')) : null;
  const persistence = read(path.join(root, 'experiments/stage2-persistence.json'));
  const gateways = path.join(root, 'artifacts/local/gateway');
  const admitted = [], terminal = [];
  for (const entry of fs.readdirSync(gateways)) {
    const base = path.join(gateways, entry);
    admitted.push(...rows(path.join(base, 'request-events.jsonl')).filter(row =>
      row.type === 'admitted' && row.worldId === initial?.worldId
      && row.startedAt >= manifest.startedAt));
    terminal.push(...rows(path.join(base, 'calls.jsonl')));
  }
  const terminals = new Map();
  for (const row of terminal) {
    if (!terminals.has(row.requestId)) terminals.set(row.requestId, []);
    terminals.get(row.requestId).push(row);
  }
  const unmatched = admitted.filter(row => terminals.get(row.requestId)?.length !== 1).map(r => r.requestId);
  const outcomes = {};
  for (const row of admitted) {
    const result = terminals.get(row.requestId)?.[0];
    if (result) outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
  }
  const gates = {
    completed: manifest.status === 'completed',
    duration: Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt) >= 1800000
      && snapshots.length > 1
      && Date.parse(snapshots.at(-1)?.at) - Date.parse(snapshots[0]?.at) >= 1710000,
    activity: activity?.passed === true,
    persistence: persistence.passed === true && persistence.worldId === initial?.worldId,
    stoppedAndDrained: controls.some(c => c.action === 'stop' && c.succeeded)
      && health?.active === 0 && health?.queued === 0 && drainedSamples >= 2,
    attemptsEnded: admitted.length > 0 && unmatched.length === 0,
    scopes: admitted.length > 0 && admitted.every(row => initial.agentIds.includes(row.agentId)
      && typeof row.experimentId === 'string' && typeof row.purpose === 'string'),
    healthySnapshots: false,
  };
  try {
    for (const snapshot of snapshots) validateTownSnapshot(initial, snapshot);
    gates.healthySnapshots = snapshots.length > 0 && snapshots.every((s, i) => i === 0
      || Date.parse(s.at) - Date.parse(snapshots[i - 1].at) <= 90000);
  } catch { /* Preserve the failed gate rather than dropping the run. */ }
  const report = { measuredAt: new Date().toISOString(), run: path.relative(root, directory),
    status: manifest.status, error: manifest.error ?? null,
    stageAccepted: Object.values(gates).every(Boolean), gates,
    activity, admittedAttempts: admitted.length, terminalOutcomes: outcomes, unmatchedRequestIds: unmatched,
    snapshotSha256: fs.existsSync(path.join(directory, 'snapshots.jsonl'))
      ? hash(fs.readFileSync(path.join(directory, 'snapshots.jsonl'))) : null,
    limitation: '仅 P2 本地小镇工程验收；不代表题集人工审核或 memory 优化通过。' };
  const output = path.join(root, 'experiments/stage2-summary.json');
  fs.writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(`${output}.tmp`, output);
  fs.writeFileSync(path.join(directory, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.stageAccepted) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
