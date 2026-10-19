const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Timeline, loadWorkload } = require('../lib/workload');
const { hash } = require('../lib/artifacts');
const observation = { id: 'e1', type: 'observation', sequence: 0, worldId: 'w1', agentId: 'a1', text: '秘密' };
test('回放观察按世界及角色隔离，重复写幂等且冲突拒绝', () => {
  const state = new Timeline(); state.observe(observation); state.observe(observation);
  assert.equal(state.visible(observation).length, 1);
  assert.equal(state.visible({ worldId: 'w2', agentId: 'a1' }).length, 0);
  assert.equal(state.visible({ worldId: 'w1', agentId: 'a2' }).length, 0);
  assert.throws(() => state.observe({ ...observation, text: '新内容' }), /冲突/);
});
test('快照恢复保持初始状态，查询不改变记忆', () => {
  const original = new Timeline([observation]); const restored = new Timeline(original.snapshot());
  const visible = restored.visible(observation); visible[0].text = '污染';
  assert.deepEqual(restored.snapshot(), original.snapshot());
});
test('输入顺序、校验和及答案泄漏校验', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'town-workload-')); const file = path.join(directory, 'events.jsonl');
  try {
    const write = rows => { const bytes = Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n'); fs.writeFileSync(file, bytes); return hash(bytes); };
    const digest = write([observation]); assert.equal(loadWorkload(file, digest).length, 1);
    assert.throws(() => loadWorkload(file, 'bad'), /校验和/);
    assert.throws(() => loadWorkload(file, write([observation, { ...observation, id: 'e2' }])), /顺序/);
    assert.throws(() => loadWorkload(file, write([{ ...observation, answer: '秘密' }])), /评估答案/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
