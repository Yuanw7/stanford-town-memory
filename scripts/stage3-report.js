const fs = require('node:fs');
const path = require('node:path');
const { root, hash } = require('../lib/artifacts');
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
try {
  const replayDirectory = path.join(root, 'artifacts/local/replay');
  const candidates = fs.readdirSync(replayDirectory).sort().reverse();
  const completed = candidates.map(id => path.join(replayDirectory, id)).find(directory =>
    JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))).status === 'completed');
  if (!completed) throw new Error('没有完整回放');
  const replayManifest = JSON.parse(fs.readFileSync(path.join(completed, 'manifest.json')));
  const clientCalls = lines(path.join(completed, 'calls.jsonl'));
  const gatewayCalls = fs.readdirSync(path.join(root, 'artifacts/local/gateway'))
    .flatMap(id => lines(path.join(root, 'artifacts/local/gateway', id, 'calls.jsonl')));
  const matches = gatewayCalls.filter(row => row.experimentId === replayManifest.runId);
  const byKey = new Map(matches.map(row => [`${row.logicalCallId}:${row.attempt}`, row]));
  const matched = clientCalls.every(row => {
    const gateway = byKey.get(`${row.logicalCallId}:${row.attempt}`);
    return gateway && gateway.worldId === row.worldId && gateway.agentId === row.agentId
      && gateway.purpose === row.purpose && gateway.inputTokens === row.inputTokens
      && gateway.outputTokens === row.outputTokens && gateway.usageStatus === 'measured';
  });
  const passed = clientCalls.length === 150 && matches.length === 150 && matched;
  const report = { measuredAt: new Date().toISOString(), diagnosticOnly: true,
    replayRun: completed, replayRunId: replayManifest.runId,
    replayAttempts: clientCalls.length, gatewayMatchedAttempts: matches.length,
    exactUsageAndScopeMatched: matched, meteringReplayGatePassed: passed,
    callsSha256: hash(fs.readFileSync(path.join(completed, 'calls.jsonl'))),
    onlineObservedPurposes: [...new Set(gatewayCalls.filter(r => r.experimentId === 'town-p3-baseline').map(r => r.purpose))],
    pending: ['反思路径尚未在真实小镇达到阈值；已传递作用域，仍需独立触发验证',
      '正式实验仍需固定版本信息和题集人工审核', 'P4 memory 策略尚未实现'] };
  fs.writeFileSync(path.join(root, 'experiments/stage3-metering-summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
