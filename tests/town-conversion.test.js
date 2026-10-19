const test = require('node:test');
const assert = require('node:assert/strict');
const { convertTown } = require('../lib/town-conversion');
const { validateMemoryWorkload } = require('../lib/memory-workload');
const { parseConvexData } = require('../lib/convex-data');
const source = () => ({ worldId: 'w', people: [{ agentId: 'a', playerId: 'p0', name: 'Alice' }, { agentId: 'b', playerId: 'p1', name: 'Bob' }],
  archives: [{ id: 'c', createdAt: 1000.25, numMessages: 2, participantPlayerIds: ['p0', 'p1'] }],
  messages: [{ id: 'm1', conversationId: 'c', authorPlayerId: 'p0', createdAt: 1001.75, text: 'Hello' },
    { id: 'm2', conversationId: 'c', authorPlayerId: 'p1', createdAt: 1002.5, text: 'Hi' }] });
test('归档转换保留作者/参与资格/来源和原始小数时间，精确重复幂等', () => {
  const input = source(); input.messages.push(structuredClone(input.messages[0]));
  const result = convertTown(input), c = result.conversations[0];
  assert.equal(result.duplicates, 1); assert.deepEqual(c.observedBy, ['a', 'b']);
  assert.equal(c.messages[0].authorAgentId, 'a'); assert.equal(c.messages[0].atMs, 1001);
  assert.equal(result.provenance[0].sourceMessageTimes[0], 1001.75);
  assert.equal(result.summary.includedMessages, 2);
});
test('不完整、未归档、作者越界和未知角色会话排除，不扩张观察资格', () => {
  for (const [mutate, reason] of [[s => { s.archives[0].numMessages = 3; }, 'message_count_mismatch'],
    [s => { s.archives = []; }, 'not_archived'],
    [s => { s.messages[0].authorPlayerId = 'foreign'; }, 'author_not_participant'],
    [s => { s.people.pop(); }, 'participant_has_no_agent_mapping']]) {
    const input = source(); mutate(input); const result = convertTown(input);
    assert.equal(result.conversations.length, 0); assert.equal(result.excluded[0].reason, reason);
  }
});
test('冲突事件、逻辑消息重复和答案字段拒绝；同一个玩家不能映射两个角色', () => {
  let input = source(); input.messages.push({ ...input.messages[0], text: 'Changed' });
  assert.throws(() => convertTown(input), /conflicting/);
  input = source(); input.messages.forEach(m => { m.messageUuid = 'same'; });
  assert.throws(() => convertTown(input), /logical_message/);
  input = source(); input.messages[0].answer = 'secret'; assert.throws(() => convertTown(input), /invalid_source/);
  input = source(); input.people.push({ ...input.people[0], agentId: 'spy' }); assert.throws(() => convertTown(input), /mapping/);
});
test('多查询契约拒绝答案泄漏、未知角色、重复问题、时序错误与重复来源', () => {
  const c = convertTown(source()).conversations[0];
  const input = () => ({ schemaVersion: 2, kind: 'memory_development', conversations: [c],
    queries: [{ id: 'q', worldId: 'w', agentId: 'a', atMs: 2000, text: 'Who?', category: 'relationship' }] });
  assert.equal(validateMemoryWorkload(input()).queries.length, 1);
  for (const change of [s => { s.queries[0].acceptedAnswers = ['Bob']; }, s => { s.queries[0].agentId = 'foreign'; },
    s => { s.queries.push(structuredClone(s.queries[0])); }, s => { s.queries[0].atMs = 1; },
    s => { s.conversations.push({ ...c, id: 'another' }); }]) {
    const s = input(); change(s); assert.throws(() => validateMemoryWorkload(s));
  }
});

test('Convex CLI 扩展数据无 eval 解析，不改写字符串里的字面量', () => {
  const text = '[{"bytes":Bytes("YWJj"),"integer":123n,"special":NaN,"literal":"Bytes(\\\"abc\\\") 123n NaN"}]';
  assert.deepEqual(parseConvexData(text), [{ bytes: { $convexBytes: 'YWJj' }, integer: { $convexInt64: '123' },
    special: { $convexFloat: 'NaN' }, literal: 'Bytes("abc") 123n NaN' }]);
  assert.throws(() => parseConvexData('process.exit()'), /invalid_convex/);
});

test('归档计数与持久化消息不一致默认排除，仅开发显式模式保留额外行并标注', () => {
  const input = source(); input.archives[0].numMessages = 1;
  assert.equal(convertTown(input).conversations.length, 0);
  const development = convertTown(input, { allowUnacknowledgedMessages: true });
  assert.equal(development.conversations[0].messages.length, 2);
  assert.equal(development.provenance[0].countMismatch, true);
  input.archives[0].numMessages = 3;
  assert.equal(convertTown(input, { allowUnacknowledgedMessages: true }).conversations.length, 0);
});
