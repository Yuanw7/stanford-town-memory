const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { root, hash, createRun } = require('../lib/artifacts');
const { diagnosticRuntime } = require('../lib/diagnostic-runtime');
const { CommitmentWorld } = require('../lib/commitment-world');
const { withActionContext } = require('../lib/action-context');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--parent') throw new Error('用法：node scripts/probe-action-context.js --parent <已完成policy对照目录>');
  const parent = path.resolve(root, args[1]), read = name => JSON.parse(fs.readFileSync(path.join(parent, name)));
  const parentManifest = read('manifest.json'), sourceConfig = read('config.json');
  if (parentManifest.kind !== 'policy-comparison' || parentManifest.status !== 'completed' || sourceConfig.repetitions !== 1) throw new Error('completed_single_repeat_policy_run_required');
  const promptBytes = fs.readFileSync(path.join(parent, 'prompts.jsonl'));
  const prompts = promptBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse).filter(r => r.purpose === 'commitment_action');
  const fixtureBytes = fs.readFileSync(path.join(parent, 'task-fixture.json')), fixture = JSON.parse(fixtureBytes);
  if (prompts.length !== sourceConfig.variants.length || new Set(prompts.map(p => p.strategy)).size !== prompts.length
      || prompts.some(p => p.worldId !== fixture.worldId || p.agentId !== fixture.agentId)) throw new Error('action_prompt_scope_mismatch');
  const config = { ...sourceConfig, mode: 'diagnostic_action_context_probe', parent: path.relative(root, parent),
    parentPromptsSha256: hash(promptBytes), fixtureSha256: hash(fixtureBytes), repetitions: 3,
    maxTotalCalls: prompts.length * 2 * 3, wallTimeLimitSeconds: 600,
    formats: ['original', 'self_identity_utc'], comparisonScope: 'Fixed parent selected memories; no retrieval or maintenance; not a policy cost comparison' };
  const run = createRun('action-context-probe', config);
  run.write('source-prompts.json', prompts); run.write('task-fixture.json', fixture);
  console.log(`记录目录：${run.directory}`);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const runtime = await diagnosticRuntime(config, run, controller.signal), rows = [];
    for (let repetition = 1; repetition <= config.repetitions; repetition++) for (const prompt of prompts) {
      const formats = repetition % 2 ? config.formats : [...config.formats].reverse();
      for (const format of formats) {
        const scope = { experimentId: run.runId, worldId: fixture.worldId, agentId: fixture.agentId,
          repetition, strategy: prompt.strategy, format, seed: config.seed + repetition - 1 };
        const world = new CommitmentWorld({ scope, contacts: fixture.contacts, inventory: fixture.inventory, acceptedTasks: fixture.acceptedTasks });
        const messages = structuredClone(prompt.messages), payload = JSON.parse(messages[1].content);
        assert.deepEqual(payload.visibleWorld, world.visibleState(fixture.actionAtMs));
        if (format === 'self_identity_utc') {
          messages[1].content = JSON.stringify(withActionContext(payload, scope));
        }
        const raw = await runtime.generate(messages, { ...scope, purpose: 'commitment_action' }, 128);
        let status = 'executed', error = null;
        try { world.execute({ scope, actionId: `${prompt.strategy}-${format}-${repetition}`, atMs: fixture.actionAtMs, action: JSON.parse(raw) }); }
        catch (failure) { status = 'invalid_action'; error = failure.message; }
        const row = { repetition, strategy: prompt.strategy, format, status, error, evaluation: world.evaluate(fixture.evaluateAtMs) };
        rows.push(row); run.append('actions.jsonl', row); run.write(`world-${repetition}-${prompt.strategy}-${format}.json`, world.snapshot());
      }
    }
    const results = config.formats.flatMap(format => prompts.map(p => {
      const group = rows.filter(r => r.format === format && r.strategy === p.strategy);
      return { format, strategy: p.strategy, expected: config.repetitions, observed: group.length,
        completed: group.reduce((n, r) => n + r.evaluation.completedDue, 0), invalidActions: group.filter(r => r.status !== 'executed').length };
    }));
    const summary = { diagnosticOnly: true, attempts: runtime.calls.length, allGatewayScopeAndUsageMatched: runtime.verifyMetering(), results,
      limitation: 'Identity and readable UTC changed together; fixed selected parent memories, one repeated synthetic task; no policy savings or causal uniqueness claim' };
    run.write('summary.json', summary);
    if (!summary.allGatewayScopeAndUsageMatched) throw new Error('metering_mismatch');
    run.finish('completed'); console.log(JSON.stringify(summary, null, 2));
  } catch (error) { run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
