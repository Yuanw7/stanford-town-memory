const fs = require('node:fs');
const path = require('node:path');
const { root, hash } = require('../lib/artifacts');
const json = file => JSON.parse(fs.readFileSync(file));
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function costs(calls) {
  const sum = (rows, field) => rows.some(r => r[field] === null || r[field] === undefined) ? null : rows.reduce((n, r) => n + r[field], 0);
  const generations = calls.filter(c => c.endpoint === '/api/generate');
  const embeddings = calls.filter(c => c.endpoint === '/api/embed');
  return { attempts: calls.length, unknownUsageAttempts: calls.filter(c => c.usageStatus !== 'measured').length,
    generationInputTokens: sum(generations, 'inputTokens'), generationOutputTokens: sum(generations, 'outputTokens'),
    embeddingInputTokens: sum(embeddings, 'inputTokens'), embeddingOutputTokens: null,
    embeddingOutputUsageReason: 'no embedding completion-token field', clientRequestElapsedMs: sum(calls, 'endToEndMs') };
}
function main() {
  const ids = process.argv.slice(2);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('用法：node scripts/report-tiered-development.js <run ID> [...]');
  const gatewayRoot = path.join(root, 'artifacts/local/gateway');
  const gateway = fs.readdirSync(gatewayRoot).flatMap(id => lines(path.join(gatewayRoot, id, 'calls.jsonl')));
  const allCalls = [], runs = ids.map(id => {
    const dir = path.join(root, 'artifacts/local/policy-comparison', id), config = json(path.join(dir, 'config.json'));
    const manifest = json(path.join(dir, 'manifest.json'));
    if (config.mode !== 'diagnostic_policy_comparison' || !['completed', 'failed', 'interrupted'].includes(manifest.status)) throw new Error('invalid_or_unfinished_run');
    const calls = lines(path.join(dir, 'calls.jsonl')); allCalls.push(...calls);
    const evaluationName = fs.readdirSync(dir).find(f => /^evaluation-[a-f0-9]{12}\.json$/.test(f));
    if (!evaluationName) throw new Error('independent_evaluation_required');
    const evaluation = json(path.join(dir, evaluationName));
    const matched = calls.every(call => {
      const rows = gateway.filter(g => g.logicalCallId === call.logicalCallId && g.attempt === call.attempt);
      return rows.length === 1 && ['experimentId', 'worldId', 'agentId', 'purpose', 'status', 'inputTokens', 'outputTokens'].every(k => rows[0][k] === call[k]);
    });
    return { run: path.relative(root, dir), status: manifest.status, error: manifest.error ?? null,
      extractionRevision: config.extractionRevision ?? 'initial_v1', datasetSha256: config.dataset.sha256,
      costs: costs(calls), allGatewayScopeAndUsageMatched: matched,
      byPurpose: Object.fromEntries([...new Set(calls.map(c => c.purpose))].map(p => [p, costs(calls.filter(c => c.purpose === p))])),
      evaluation: { complete: evaluation.complete, byVariant: evaluation.byVariant },
      callsSha256: hash(fs.readFileSync(path.join(dir, 'calls.jsonl'))),
      evaluationSha256: hash(fs.readFileSync(path.join(dir, evaluationName))) };
  });
  const summary = { measuredAt: new Date().toISOString(), diagnosticOnly: true, formalQualityAccepted: false,
    runs, developmentCosts: costs(allCalls), allGatewayScopeAndUsageMatched: runs.every(r => r.allGatewayScopeAndUsageMatched),
    optimizationConclusion: 'Not established; preserve incomplete runs and all development costs. No savings ratio computed.',
    pending: ['Reliable extraction, including negation and validity dates', 'Complete repeated independent-maintenance comparison',
      'Archive fallback and query-count break-even', 'Human reviewed holdout, formal matrix and Convex parity'],
    analysisScriptSha256: hash(fs.readFileSync(__filename)) };
  const output = path.join(root, 'experiments/tiered-development-summary.json');
  if (fs.existsSync(output)) {
    const previous = fs.readFileSync(output), archive = path.join(root, `experiments/tiered-development-summary-${hash(previous).slice(0, 12)}.json`);
    if (!fs.existsSync(archive)) fs.writeFileSync(archive, previous);
  }
  fs.writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ runs: runs.length, developmentCosts: summary.developmentCosts, allGatewayScopeAndUsageMatched: summary.allGatewayScopeAndUsageMatched }, null, 2));
  if (!summary.allGatewayScopeAndUsageMatched) process.exitCode = 1;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { costs };
