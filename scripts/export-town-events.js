const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRun, root, hash } = require('../lib/artifacts');
const execute = promisify(execFile);

async function main() {
  const run = createRun('town-events', { source: 'local_convex', readOnly: true });
  let cursor = null;
  const messages = [], seen = new Set();
  try {
    do {
      const result = await execute('npx', ['convex', 'run', 'research:exportMessages', JSON.stringify({ cursor })],
        { cwd: path.join(root, 'ai-town'), timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      const page = JSON.parse(result.stdout);
      for (const row of page.rows) if (!seen.has(row.id)) { seen.add(row.id); messages.push(row); }
      if (page.isDone) break;
      if (page.continueCursor === cursor) throw new Error('分页游标未前进');
      cursor = page.continueCursor;
    } while (true);
    messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const message of messages) run.append('messages.jsonl', message);
    let sequence = 0;
    for (const message of messages) {
      // 无法解析观察资格的消息不发给任何角色，保留原始记录供排查。
      if (!message.visibilityResolved) continue;
      for (const agentId of message.observedBy) run.append('observations.jsonl', {
        type: 'observation', id: `${message.id}:${agentId}`, sourceEventId: message.id,
        sequence: sequence++, worldId: message.worldId, agentId,
        at: new Date(message.createdAt).toISOString(), text: `${message.author}: ${message.text}`,
      });
    }
    const file = path.join(run.directory, 'observations.jsonl');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
    run.write('summary.json', { messages: messages.length, visibleObservations: sequence,
      unresolvedVisibility: messages.filter(m => !m.visibilityResolved).length,
      observationsSha256: hash(fs.readFileSync(file)),
      limitation: '活跃世界分页不是原子快照；正式数据集应先暂停并排空任务，再导出。只包含对话消息，不是完整世界状态事件。' });
    run.finish('completed'); console.log(`只读事件导出：${run.directory}`);
  } catch (error) { run.finish('failed', { error: error.message }); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
