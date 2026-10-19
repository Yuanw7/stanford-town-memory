const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateConversation, fingerprint } = require('../lib/conversations-v2');
const { MemoryStore } = require('../lib/memory-store');
const { ConversationMemoryWriter, conversationMessages, importanceMessages, parseImportance,
  reflectionEligible, parseReflections } = require('../lib/upstream-memory-adapter');
const scope = { experimentId: 'run', worldId: 'w', agentId: 'a' };
const conversation = () => ({ schemaVersion: 2, type: 'conversation', id: 'c1', worldId: 'w', createdAtMs: 1000,
  participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bob' }], observedBy: ['a', 'b'],
  messages: [{ id: 'm1', authorAgentId: 'a', atMs: 1001, text: 'The cafe opens at 08:00.' },
    { id: 'm2', authorAgentId: 'b', atMs: 1002, text: 'Thank you.' }] });
const store = snapshot => new MemoryStore({ dimensions: 2, embeddingVersion: 'model:digest', snapshot });
const memory = id => ({ id, kind: 'conversation', text: 'Evidence', createdAtMs: 1000, lastAccess: 1000,
  importance: 5, embedding: [0, 1], embeddingVersion: 'model:digest', sourceEventIds: ['m1'], sourceMemoryIds: [] });
const transaction = (id = 'op') => ({ scope, operationId: id, inputFingerprint: fingerprint(conversation()), memories: [memory(id)] });

test('v2 会话拒绝答案字段、未知观察者、非法作者、乱序和空会话', () => {
  assert.deepEqual(validateConversation(conversation()), conversation());
  const changes = [c => { c.answer = '08:00'; }, c => { c.observedBy = ['a', 'spy']; },
    c => { c.messages[0].authorAgentId = 'spy'; }, c => { c.messages[1].atMs = 999; },
    c => { c.messages = []; }, c => { c.messages[0].acceptedAnswers = ['08:00']; }];
  for (const change of changes) { const c = conversation(); change(c); assert.throws(() => validateConversation(c)); }
  assert.throws(() => conversationMessages(conversation(), 'spy'), /not_visible/);
});
test('存储按实验、世界和角色隔离，事务重复幂等且冲突拒绝', () => {
  const s = store(); const tx = transaction();
  assert.equal(s.commit(tx).inserted, true); assert.equal(s.commit(tx).inserted, false);
  for (const key of ['experimentId', 'worldId', 'agentId']) assert.deepEqual(s.visible({ ...scope, [key]: 'other' }), []);
  tx.memories[0].text = 'changed'; assert.throws(() => s.commit(tx), /operation_conflict/);
  const rows = s.visible(scope); rows[0].embedding[0] = 99;
  assert.deepEqual(s.visible(scope)[0].embedding, [0, 1]);
});
test('坏向量与外部来源使整个批次拒绝，不出现半条记忆', () => {
  const s = store(), tx = transaction();
  tx.memories.push({ ...memory('bad'), embedding: [NaN, 0] });
  assert.throws(() => s.commit(tx), /invalid_memory/); assert.deepEqual(s.visible(scope), []);
  const foreign = { ...transaction('reflection'), memories: [{ ...memory('r'), kind: 'reflection', sourceMemoryIds: ['foreign'] }] };
  assert.throws(() => s.commit(foreign), /provenance/); assert.deepEqual(s.snapshot().transactions, []);
});
test('文件快照重建后保留向量、来源与幂等记录，模型不匹配拒绝恢复', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'town-memory-'));
  try {
    const s = store(), tx = transaction(); s.commit(tx); const file = path.join(directory, 'state.json'); s.save(file);
    const snapshot = JSON.parse(fs.readFileSync(file)); const recovered = store(snapshot);
    assert.deepEqual(recovered.snapshot(), s.snapshot()); assert.equal(recovered.commit(tx).inserted, false);
    assert.throws(() => new MemoryStore({ dimensions: 2, embeddingVersion: 'changed', snapshot }), /mismatch/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('会话写入保留参与视角、来源和调用用途；恢复后重复不调用模型', async () => {
  let generated = 0, embedded = 0;
  const s = store(), purposes = [];
  const options = { generate: async (messages, metadata, max) => {
    purposes.push(metadata.purpose); generated++;
    if (max === 500) { assert.ok(messages[0].content.includes('You are Alice')); return 'I learned about the cafe.'; }
    return 'unparseable';
  }, embed: async (text, metadata) => { purposes.push(metadata.purpose); embedded++; return [0, 1]; } };
  const writer = new ConversationMemoryWriter({ store: s, ...options });
  assert.equal((await writer.remember(conversation(), scope)).inserted, true);
  const recovered = store(s.snapshot());
  await new ConversationMemoryWriter({ store: recovered, ...options }).remember(conversation(), scope);
  assert.equal(generated, 2); assert.equal(embedded, 1);
  assert.deepEqual(purposes, ['summary', 'importance', 'memory_embedding']);
  assert.equal(recovered.visible(scope)[0].importanceFallback, true);
  assert.deepEqual(recovered.visible(scope)[0].sourceEventIds, ['m1', 'm2']);
  const changed = conversation(); changed.messages[0].text = 'Different evidence';
  await assert.rejects(writer.remember(changed, scope), /operation_conflict/);
  await assert.rejects(writer.remember(conversation(), { ...scope, worldId: 'foreign' }), /world_mismatch/);
});
test('embedding 失败不发布记忆，重试可成功；并发提交不重复发布', async () => {
  const s = store(); let fail = true;
  const writer = new ConversationMemoryWriter({ store: s, generate: async (_, scope) => scope.purpose === 'importance' ? '5' : 'Summary',
    embed: async () => { if (fail) throw new Error('embedding_failed'); return [0, 1]; } });
  await assert.rejects(writer.remember(conversation(), scope), /embedding_failed/); assert.deepEqual(s.visible(scope), []);
  fail = false; await Promise.all([writer.remember(conversation(), scope), writer.remember(conversation(), scope)]);
  assert.equal(s.visible(scope).length, 1);
});
test('原版 importance fallback 和严格 >500 反思阈值，非法引用拒绝', () => {
  assert.deepEqual(parseImportance('not a number'), { value: 5, fallback: true });
  assert.deepEqual(parseImportance('Rating: 7'), { value: 7, fallback: false });
  const memories = Array.from({ length: 100 }, (_, i) => ({ id: String(i), importance: 5, createdAtMs: 1000 }));
  assert.equal(reflectionEligible(memories), false); memories[0].importance = 6;
  assert.equal(reflectionEligible(memories), true); assert.equal(reflectionEligible(memories, 1000), false);
  assert.throws(() => parseReflections('[{"insight":"x","statementIds":[100]}]', memories), /sources/);
  assert.throws(() => parseReflections('not JSON', memories));
  assert.deepEqual(parseReflections('[{"insight":"x","statementIds":[0,0]}]', memories), [{ text: 'x', sourceMemoryIds: ['0'] }]);
});

test('会话和 importance 模板与本地固定上游源码逐字对照', () => {
  const source = fs.readFileSync(path.join(__dirname, '../ai-town/convex/agent/memory.ts'), 'utf8');
  const summary = source.match(/const llmMessages:[\s\S]*?content: `([\s\S]*?)`/)[1]
    .replaceAll('${player.name}', 'Alice').replaceAll('${otherPlayer.name}', 'Bob');
  assert.equal(conversationMessages(conversation(), 'a')[0].content, summary);
  const importance = source.match(/content: `(On the scale of 0 to 9,[\s\S]*?)`/)[1].replace('${description}', 'example');
  assert.equal(importanceMessages('example')[0].content, importance);
  assert.ok(source.includes('sumOfImportanceScore > 500'));
});

test('同一 writer 并发重复请求合并模型调用，冲突输入不进入模型', async () => {
  const s = store(); let count = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const writer = new ConversationMemoryWriter({ store: s, generate: async (_, metadata) => {
    count++; await gate; return metadata.purpose === 'importance' ? '5' : `nondeterministic-${count}`;
  }, embed: async () => [0, 1] });
  const first = writer.remember(conversation(), scope), duplicate = writer.remember(conversation(), scope);
  const conflicting = conversation(); conflicting.messages[0].text = 'changed';
  await assert.rejects(writer.remember(conflicting, scope), /operation_conflict/);
  release(); await Promise.all([first, duplicate]);
  assert.equal(count, 2); assert.equal(s.visible(scope).length, 1);
});
