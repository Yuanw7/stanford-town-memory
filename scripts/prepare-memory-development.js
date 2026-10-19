const fs = require('node:fs');
const path = require('node:path');
const { createRun, root, hash } = require('../lib/artifacts');
const { validateMemoryWorkload } = require('../lib/memory-workload');
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--capture') throw new Error('用法：node scripts/prepare-memory-development.js --capture <捕获run目录>');
  const capture = path.resolve(root, args[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(capture, 'manifest.json')));
  const summary = JSON.parse(fs.readFileSync(path.join(capture, 'summary.json')));
  const bytes = fs.readFileSync(path.join(capture, 'conversations.jsonl'));
  if (manifest.status !== 'completed' || manifest.kind !== 'town-conversations' || hash(bytes) !== summary.datasetSha256) throw new Error('invalid_or_changed_capture');
  const all = bytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
  if (!all.length) throw new Error('no_development_conversations');
  const focal = all[0].participants[0];
  const conversations = all.filter(c => c.observedBy.includes(focal.agentId)).slice(0, 3);
  if (conversations.length !== 3) throw new Error('insufficient_development_history');
  const last = conversations.at(-1), other = last.participants.find(p => p.agentId !== focal.agentId);
  const at = last.messages.at(-1).atMs + 600000;
  const queries = [
    { id: 'real-latest-contact-a', worldId: last.worldId, agentId: focal.agentId, text: 'Name the person I most recently talked to.', category: 'relationship', atMs: at },
    { id: 'real-latest-contact-b', worldId: last.worldId, agentId: other.agentId, text: 'Name the person I most recently talked to.', category: 'relationship', atMs: at + 1 },
    { id: 'real-unknown-a', worldId: last.worldId, agentId: focal.agentId, text: 'What is my bank account PIN?', category: 'unanswerable', atMs: at + 2 },
    { id: 'real-unknown-b', worldId: last.worldId, agentId: other.agentId, text: 'What is my bank account PIN?', category: 'unanswerable', atMs: at + 3 } ];
  const workload = validateMemoryWorkload({ schemaVersion: 2, kind: 'memory_development', conversations, queries });
  const truth = [{ id: queries[0].id, acceptedAnswers: [other.name], sourceEventIds: last.messages.map(m => m.id) },
    { id: queries[1].id, acceptedAnswers: [focal.name], sourceEventIds: last.messages.map(m => m.id) },
    ...queries.slice(2).map(q => ({ id: q.id, acceptedAnswers: ['未知'], sourceEventIds: [] })) ];
  const run = createRun('memory-development', { capture: path.relative(root, capture), diagnosticOnly: true });
  run.write('workload.json', workload); run.write('answers.json', truth);
  run.write('selection.json', { sourceCapture: path.relative(root, capture), selectedConversationIds: conversations.map(c => c.id),
    rule: 'first three archived persisted conversations for first participating agent',
    reviewStatus: 'development_not_human_reviewed', sourceSummary: summary,
    limitation: 'Contact probes derive from participant metadata; unknown-PIN probes require independent review. Not full-quality acceptance.' });
  run.write('summary.json', { datasetSha256: hash(fs.readFileSync(path.join(run.directory, 'workload.json'))),
    answersSha256: hash(fs.readFileSync(path.join(run.directory, 'answers.json'))), distinctQuestions: queries.length });
  run.finish('completed'); console.log(`开发数据：${run.directory}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
