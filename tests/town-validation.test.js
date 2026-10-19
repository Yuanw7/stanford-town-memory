const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTownSnapshot } = require('../lib/town-validation');
const initial = { worldId: 'world', agentCount: 5, status: 'running', engineRunning: true,
  generationNumber: 7, controlEpoch: 0, staleOperations: [], embeddings: [{ exists: true, playerIdMatches: true, dimensions: 1024 }] };
test('健康连续运行可验收；暂停、重启、悬挂和向量错误均不能通过', () => {
  assert.doesNotThrow(() => validateTownSnapshot(initial, initial));
  for (const change of [{ status: 'stoppedByDeveloper' }, { engineRunning: false },
    { controlEpoch: 1 }, { staleOperations: ['a:1'] }, { embeddings: [{ exists: false }] }]) {
    assert.throws(() => validateTownSnapshot(initial, { ...initial, ...change }));
  }
});

test('正常仿真步的 generation 增长不是重启', () => {
  assert.doesNotThrow(() => validateTownSnapshot(initial, { ...initial, generationNumber: 8 }));
});
