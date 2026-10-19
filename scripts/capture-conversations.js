const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRun, root, hash } = require('../lib/artifacts');
const { fingerprint } = require('../lib/conversations-v2');
const { convertTown } = require('../lib/town-conversion');
const { parseConvexData } = require('../lib/convex-data');
const execute = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  if (new Set(args).size !== args.length || args.some(a => !['--allow-stale-markers', '--allow-unacknowledged-messages'].includes(a))) throw new Error('用法：npm run town:capture-v2 -- [--allow-stale-markers] [--allow-unacknowledged-messages]');
  const allowStaleMarkers = args.includes('--allow-stale-markers');
  const allowUnacknowledgedMessages = args.includes('--allow-unacknowledged-messages');
  const run = createRun('town-conversations', { source: 'local_convex', readOnly: true, maximumMessages: 10000, maximumArchives: 1000,
    allowStaleMarkers, allowUnacknowledgedMessages, diagnosticOnly: true });
  console.log(`记录目录：${run.directory}`);
  const command = async args => {
    const r = await execute('npx', ['convex', ...args], { cwd: path.join(root, 'ai-town'), timeout: 45000, maxBuffer: 16 * 1024 * 1024 });
    return args[0] === 'data' ? parseConvexData(r.stdout) : JSON.parse(r.stdout);
  };
  const data = async (table, limit) => {
    const rows = await command(['data', table, '--limit', String(limit + 1), '--format', 'json']);
    if (rows.length > limit) throw new Error(`capture_limit_exceeded:${table}`); return rows;
  };
  const read = async () => {
    const values = await Promise.all([data('worlds', 1), data('playerDescriptions', 100), data('archivedConversations', 1000), data('messages', 10000)]);
    const [worlds, descriptions, archived, messages] = values;
    if (worlds.length !== 1) throw new Error('single_world_capture_only');
    const world = worlds[0];
    return { rawFingerprint: fingerprint(values), payload: { worldId: world._id,
      people: world.agents.map(a => { const description = descriptions.find(p => p.worldId === world._id && p.playerId === a.playerId);
        if (!description) throw new Error('missing_player_description');
        return { playerId: a.playerId, agentId: a.id, name: description.name }; }),
      archives: archived.filter(a => a.worldId === world._id).map(a => ({ id: a.id, createdAt: a.created, archivedAt: a._creationTime,
        numMessages: a.numMessages, participantPlayerIds: a.participants })),
      messages: messages.filter(m => m.worldId === world._id).map(m => ({ id: m._id, messageUuid: m.messageUuid,
        conversationId: m.conversationId, authorPlayerId: m.author, createdAt: m._creationTime, text: m.text })) } };
  };
  try {
    const before = await command(['run', 'research:snapshot']);
    if (before.engineRunning !== false || before.status === 'running'
        || (!allowStaleMarkers && before.staleOperations.length)) throw new Error('capture_requires_stopped_world');
    const source = await read(), second = await read(), after = await command(['run', 'research:snapshot']);
    if (source.rawFingerprint !== second.rawFingerprint || fingerprint(before) !== fingerprint(after)) throw new Error('source_changed_during_capture');
    run.write('source.json', source.payload); run.write('control-snapshot.json', before);
    const result = convertTown(source.payload, { allowUnacknowledgedMessages });
    const dataset = path.join(run.directory, 'conversations.jsonl'); fs.writeFileSync(dataset, result.conversations.map(c => JSON.stringify(c)).join('\n') + (result.conversations.length ? '\n' : ''));
    run.write('provenance.json', result.provenance); run.write('excluded.json', result.excluded);
    run.write('summary.json', { ...result.summary, sourceStableOnTwoReads: true, controlEpoch: before.controlEpoch,
      sourceSha256: hash(fs.readFileSync(path.join(run.directory, 'source.json'))), datasetSha256: hash(fs.readFileSync(dataset)),
      diagnosticOnly: true, staleOperationMarkers: before.staleOperations,
      limitation: 'Stopped world and identical bounded reads; no database snapshot transaction. Current-agent mapping only. Development data, not human-reviewed evaluation.' });
    run.finish('completed'); console.log(JSON.stringify(result.summary));
  } catch (error) { run.finish('failed', { error: error.message }); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
