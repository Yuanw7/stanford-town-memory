const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createRun, root } = require('../lib/artifacts');
const { validateTownSnapshot } = require('../lib/town-validation');
const { checkTownServices } = require('../lib/service-health');
const execute = promisify(execFile);

async function main() {
  if (process.argv.length > 2) throw new Error('用法：npm run town:observe（固定 30 分钟验收）');
  const run = createRun('town-observe', { durationSeconds: 1800, intervalSeconds: 30, expectedAgents: 5 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let observedWorld;
  console.log(`记录目录：${run.directory}`);
  const convex = async (fn, args) => {
    const result = await execute('npx', ['convex', 'run', fn, ...(args ? [JSON.stringify(args)] : [])],
      { cwd: path.join(root, 'ai-town'), timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  try {
    const initial = await convex('research:snapshot');
    if (initial.agentCount !== 5) throw new Error('需要先创建并运行恰好 5 个角色');
    observedWorld = initial.worldId;
    run.write('initial-snapshot.json', initial);
    run.append('service-health.jsonl', await checkTownServices({ minimumRemainingMs: 1800000 + 120000 }));
    const end = Date.now() + 1800 * 1000;
    let final;
    do {
      if (controller.signal.aborted) throw new Error('interrupted');
      run.append('service-health.jsonl', await checkTownServices());
      // 显式保持活跃；这项 mutation 属于验收工作量，必须留痕。
      await convex('world:heartbeatWorld', { worldId: initial.worldId });
      final = await convex('research:snapshot');
      run.append('snapshots.jsonl', { at: new Date().toISOString(), ...final });
      validateTownSnapshot(initial, final);
      console.log(`已完成对话 ${final.completedConversations}，记忆 ${final.memories.length}`);
      await delay(Math.min(30000, Math.max(0, end - Date.now())), undefined, { signal: controller.signal });
    } while (Date.now() < end);
    const passed = final.completedConversations - initial.completedConversations >= 10
      && final.memories.length > initial.memories.length;
    run.write('summary.json', { passed, completedConversationsDelta:
      final.completedConversations - initial.completedConversations,
      newMemories: final.memories.length - initial.memories.length,
      persistenceRestartAccepted: false, pending: ['暂停重启后的持久化验收', '请求完整结束状态核查'] });
    run.finish('completed', { activityGatePassed: passed });
    if (!passed) process.exitCode = 1;
  } catch (error) {
    run.finish(controller.signal.aborted ? 'interrupted' : 'failed', { error: error.message }); throw error;
  } finally {
    if (observedWorld) {
      try {
        await convex('testing:stop');
        run.append('control-events.jsonl', { at: new Date().toISOString(), action: 'stop', worldId: observedWorld, succeeded: true });
      } catch {
        run.append('control-events.jsonl', { at: new Date().toISOString(), action: 'stop', worldId: observedWorld, succeeded: false });
        console.error('停止世界失败，请运行 npx convex run testing:stop');
        process.exitCode = 1;
      }
    }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
