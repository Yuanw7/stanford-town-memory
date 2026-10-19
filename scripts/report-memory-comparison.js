const fs = require('node:fs');
const path = require('node:path');
const { root, hash } = require('../lib/artifacts');
const { validateAblations, maintenanceFingerprint } = require('../lib/policy-ablation');
function totals(calls) {
  const sum = (items, key) => items.some(c => c[key] === null || c[key] === undefined) ? null : items.reduce((n, c) => n + c[key], 0);
  const generation = calls.filter(c => c.endpoint === '/api/generate'), embedding = calls.filter(c => c.endpoint === '/api/embed');
  return { attempts: calls.length, failures: calls.filter(c => c.status !== 'succeeded').length,
    unknownUsageAttempts: calls.filter(c => c.usageStatus !== 'measured').length,
    clientRequestElapsedMs: sum(calls, 'endToEndMs'),
    generation: { attempts: generation.length, inputTokens: sum(generation, 'inputTokens'), outputTokens: sum(generation, 'outputTokens') },
    embedding: { attempts: embedding.length, inputTokens: sum(embedding, 'inputTokens'), outputTokens: null, outputUsageReason: 'no embedding completion-token field' } };
}
function writeVersioned(file, output) {
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file);
    if (hash(previous) !== hash(output)) {
      const archive = file.replace(/\.json$/, `-revision-${hash(previous).slice(0, 12)}.json`);
      if (!fs.existsSync(archive)) fs.writeFileSync(archive, previous);
    }
  }
  fs.writeFileSync(file, output);
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 && !(args.length === 3 && args[2] === '--no-latest')) throw new Error('用法：node scripts/report-memory-comparison.js <run目录> <评估JSON文件名> [--no-latest]');
  const noLatest = args[2] === '--no-latest';
  const directory = path.resolve(root, args[0]), read = name => JSON.parse(fs.readFileSync(path.join(directory, name)));
  if (path.basename(args[1]) !== args[1]) throw new Error('evaluation_filename_only');
  const manifest = read('manifest.json'), config = read('config.json'), summary = read('summary.json'), evaluation = read(args[1]);
  if (!['memory-comparison', 'policy-comparison'].includes(manifest.kind)
      || !['diagnostic_memory_comparison', 'diagnostic_policy_comparison'].includes(config.mode)) throw new Error('invalid_run_kind');
  const bytes = fs.readFileSync(path.join(directory, 'calls.jsonl'));
  const calls = bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  const isQuery = c => ['memory_query', 'retrieval_embedding', 'tiered_query_plan', 'tiered_retrieval_embedding', 'archive_retrieval_embedding'].includes(c.purpose);
  const byVariant = Object.fromEntries(config.variants.map(v => [v.id, totals(calls.filter(c => c.strategy === v.id && isQuery(c)))]));
  const allByVariant = Object.fromEntries(config.variants.map(v => [v.id, totals(calls.filter(c => c.strategy === v.id))]));
  const answerByVariant = Object.fromEntries(config.variants.map(v => [v.id, totals(calls.filter(c => c.strategy === v.id && c.purpose === 'memory_query'))]));
  const baseline = config.variants.find(v => ['upstream_top_k', 'baseline'].includes(v.policy)).id;
  const baselineInput = answerByVariant[baseline].generation.inputTokens;
  const totalGenerated = row => row.generation.inputTokens === null || row.generation.outputTokens === null ? null : row.generation.inputTokens + row.generation.outputTokens;
  const ablations = validateAblations(config).map(edge => {
    const a = totalGenerated(allByVariant[edge.control]), b = totalGenerated(allByVariant[edge.treatment]);
    const equalMaintenance = Array.from({ length: config.repetitions }, (_, i) => maintenanceFingerprint(read(`state-${i + 1}-${edge.control}.json`))
      === maintenanceFingerprint(read(`state-${i + 1}-${edge.treatment}.json`))).every(Boolean);
    return { ...edge, maintenanceClaimsEquivalent: equalMaintenance,
      totalGenerationTokenChangeRate: manifest.status === 'completed' && evaluation.complete && a > 0 && b !== null ? b / a - 1 : null,
      accuracyChangePoints: (evaluation.byVariant[edge.treatment].accuracy - evaluation.byVariant[edge.control].accuracy) * 100,
      controlActions: summary.actions?.[edge.control] ?? null, treatmentActions: summary.actions?.[edge.treatment] ?? null,
      formalQualityAccepted: false, limitation: edge.factor === 'queryPlanner' && !equalMaintenance ? 'Independent maintenance drift; cannot isolate planner causality from this run' : 'Development ablation only; no holdout or statistical acceptance' };
  });
  const report = { measuredAt: new Date().toISOString(), run: path.relative(root, directory), diagnosticOnly: true,
    status: manifest.status, distinctQuestions: evaluation.distinctQuestions ?? evaluation.independentQuestions,
    summary, evaluation, ablations, sharedMaintenance: totals(calls.filter(c => c.strategy === undefined)), queryCostsByVariant: byVariant,
    answerCostsByVariant: answerByVariant, allOwnedCostsByVariant: allByVariant,
    persistedPolicySnapshotBytes: manifest.kind === 'policy-comparison'
      ? Object.fromEntries(config.variants.map(v => [v.id, Array.from({ length: config.repetitions }, (_, i) =>
        fs.statSync(path.join(directory, `state-${i + 1}-${v.id}.json`)).size).reduce((n, bytes) => n + bytes, 0)])) : null,
    actionCostsByVariant: Object.fromEntries(config.variants.map(v => [v.id, totals(calls.filter(c => c.strategy === v.id && c.purpose === 'commitment_action'))])),
    maintenanceCostsByVariant: Object.fromEntries(config.variants.map(v => [v.id, totals(calls.filter(c => c.strategy === v.id && !isQuery(c) && c.purpose !== 'commitment_action'))])),
    queryInputReductionRate: Object.fromEntries(config.variants.map(v => [v.id,
      manifest.status === 'completed' && evaluation.complete && baselineInput > 0 && answerByVariant[v.id].generation.inputTokens !== null
        ? 1 - answerByVariant[v.id].generation.inputTokens / baselineInput : null])),
    totalOwnedGenerationTokenChangeRate: Object.fromEntries(config.variants.map(v => [v.id,
      manifest.kind === 'policy-comparison' && manifest.status === 'completed' && evaluation.complete && totalGenerated(allByVariant[baseline]) > 0
        && totalGenerated(allByVariant[v.id]) !== null ? totalGenerated(allByVariant[v.id]) / totalGenerated(allByVariant[baseline]) - 1 : null])),
    callsSha256: hash(bytes), evaluationSha256: hash(fs.readFileSync(path.join(directory, args[1]))),
    analysisScriptSha256: hash(fs.readFileSync(__filename)),
    analysisDependencySha256: { 'lib/policy-ablation.js': hash(fs.readFileSync(path.join(root, 'lib/policy-ablation.js'))),
      'lib/conversations-v2.js': hash(fs.readFileSync(path.join(root, 'lib/conversations-v2.js'))) },
    limitations: [manifest.kind === 'policy-comparison' ? 'Independent per-policy maintenance; read-only offline QA plus optional single-step simulation, not online interaction' : 'Shared maintenance; retrieval-only comparison, not independent end-to-end costs',
      'Distinct question IDs share a history; not independent statistical samples',
      'Request elapsed time sums client calls, including service wait/load; snapshot bytes are JSON artifacts, not database or power measurements',
      'queryCosts include action-probe retrieval/planning; actionCosts count commitment_action generation only; allOwnedCosts count both exactly once',
      config.sourceCapture ? 'Captured development data uses marked engine-count differences and stale control markers' : 'Synthetic development dataset; see config diagnostic notes',
      'No human review, full quality gates, or Convex parity',
      manifest.kind === 'policy-comparison' ? 'Offline memory prototypes; archive_retrieval filters observation time, not fact-validity time; no semantic entailment or general fallback guarantee' : 'No tiered-memory results'] };
  const prefix = manifest.kind;
  const output = path.join(root, `experiments/${prefix}-summary.json`);
  if (!noLatest && fs.existsSync(output)) {
    const previous = JSON.parse(fs.readFileSync(output));
    const previousId = path.basename(previous.run);
    if (/^[a-zA-Z0-9_-]+$/.test(previousId)) {
      const archive = path.join(root, `experiments/${prefix}-${previousId}-summary.json`);
      if (!fs.existsSync(archive)) fs.copyFileSync(output, archive);
    }
  }
  const serialized = JSON.stringify(report, null, 2) + '\n';
  writeVersioned(path.join(root, `experiments/${prefix}-${manifest.runId}-summary.json`), serialized);
  if (!noLatest) writeVersioned(output, serialized);
  writeVersioned(path.join(directory, 'report.json'), serialized);
  fs.copyFileSync(__filename, path.join(directory, 'report-source.js'));
  fs.mkdirSync(path.join(directory, 'report-analysis/lib'), { recursive: true });
  for (const file of ['policy-ablation.js', 'conversations-v2.js']) fs.copyFileSync(path.join(root, 'lib', file), path.join(directory, 'report-analysis/lib', file));
  console.log(JSON.stringify({ run: report.run, queryInputReductionRate: report.queryInputReductionRate,
    sharedMaintenance: report.sharedMaintenance, queryCostsByVariant: report.queryCostsByVariant }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
