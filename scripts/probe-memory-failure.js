const fs = require('node:fs');
const path = require('node:path');
const { createRun, root, hash } = require('../lib/artifacts');
const { validateMemoryWorkload } = require('../lib/memory-workload');
const { diagnosticRuntime } = require('../lib/diagnostic-runtime');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--parent' || args[2] !== '--query' || args[4] !== '--event') throw new Error('用法：node scripts/probe-memory-failure.js --parent <run目录> --query <问题ID> --event <可见原始消息ID>');
  const parent = path.resolve(root, args[1]), read = file => JSON.parse(fs.readFileSync(path.join(parent, file)));
  const parentManifest = read('manifest.json'), parentConfig = read('config.json');
  const bytes = fs.readFileSync(path.join(parent, 'workload.json'));
  if (parentManifest.status !== 'completed' || parentManifest.kind !== 'memory-comparison' || hash(bytes) !== parentConfig.dataset.sha256) throw new Error('invalid_parent');
  const workload = validateMemoryWorkload(JSON.parse(bytes)), q = workload.queries.find(q => q.id === args[3]);
  if (!q) throw new Error('unknown_query');
  const visible = workload.conversations.filter(c => c.worldId === q.worldId && c.observedBy.includes(q.agentId)).flatMap(c => c.messages);
  const event = visible.find(m => m.id === args[5]); if (!event) throw new Error('event_not_visible');
  const prompts = fs.readFileSync(path.join(parent, 'prompts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const original = prompts.find(p => p.purpose === 'memory_query' && p.queryId === q.id && p.strategy === 'baseline' && p.repetition === 1);
  if (!original) throw new Error('original_prompt_not_found');
  const config = { ...parentConfig, mode: 'diagnostic_memory_failure_probe', maxTotalCalls: 10, wallTimeLimitSeconds: 300,
    parentRun: path.relative(root, parent), queryId: q.id, selectedRawEventId: event.id,
    limitation: 'Oracle-directed evidence subset is diagnostic only; not an Agent memory strategy or optimization result.' };
  const run = createRun('memory-failure-probe', config); console.log(`记录目录：${run.directory}`);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const runtime = await diagnosticRuntime(config, run, controller.signal);
    const rawMessages = rows => [{ ...original.messages[0] }, { role: 'user', content: JSON.stringify({ question: q.text,
      relatedMemories: JSON.stringify(rows.map(m => ({ id: m.id, text: m.text }))) }) }];
    const cases = [{ id: 'original_summary_prompt', messages: original.messages },
      { id: 'all_visible_raw_messages', messages: rawMessages(visible) },
      { id: 'selected_raw_event_only', messages: rawMessages([event]) }];
    const results = [];
    for (const c of cases) {
      const response = await runtime.generate(c.messages, { experimentId: run.runId, worldId: q.worldId, agentId: q.agentId,
        purpose: 'memory_query', diagnosticCase: c.id, queryId: q.id, seed: parentConfig.seed }, parentConfig.queryOutputTokens);
      run.append('results.jsonl', { caseId: c.id, queryId: q.id, response }); results.push({ caseId: c.id, response });
    }
    const summary = { diagnosticOnly: true, attempts: runtime.calls.length, allGatewayScopeAndUsageMatched: runtime.verifyMetering(), results,
      limitation: config.limitation, parentWorkloadSha256: hash(bytes) };
    run.write('summary.json', summary); if (!summary.allGatewayScopeAndUsageMatched) throw new Error('probe_metering_mismatch');
    run.finish('completed'); console.log(JSON.stringify(summary, null, 2));
  } catch (error) { run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
