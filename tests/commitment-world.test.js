const test = require('node:test');
const assert = require('node:assert/strict');
const { CommitmentWorld } = require('../lib/commitment-world');
const scope = { experimentId: 'e', worldId: 'w', agentId: 'a' };
const fixture = () => ({ scope, contacts: [{ id: 'b', name: 'Bea' }, { id: 'c', name: 'Cal' }], inventory: ['notebook', 'diary'],
  acceptedTasks: [{ id: 't', itemId: 'notebook', recipientId: 'b', acceptedAtMs: 100, dueAtMs: 1000, sourceEventIds: ['acceptance'] }] });
const delivery = extra => ({ scope, actionId: 'action-1', atMs: 900, action: { action: 'deliver', itemId: 'notebook', recipientId: 'b' }, ...extra });
test('实际投递才完成承诺，模型可见状态不包含评估任务目标', () => {
  const world = new CommitmentWorld(fixture());
  assert.deepEqual(Object.keys(world.visibleState(900)).sort(), ['contacts', 'inventory', 'nowMs']);
  assert.equal(world.evaluate(900).completionRate, null); assert.equal(world.evaluate(1001).completionRate, 0);
  world.execute(delivery()); assert.equal(world.evaluate(1001).completionRate, 1);
  assert.ok(!world.visibleState(1001).inventory.includes('notebook'));
});
test('迟到、错误对象、错误物品和等待均不冒充履行', () => {
  for (const entry of [delivery({ atMs: 1001 }), delivery({ action: { action: 'deliver', itemId: 'notebook', recipientId: 'c' } }),
    delivery({ action: { action: 'deliver', itemId: 'diary', recipientId: 'b' } }), delivery({ action: { action: 'wait' } })]) {
    const world = new CommitmentWorld(fixture()); world.execute(entry); assert.equal(world.evaluate(1002).completionRate, 0);
  }
});
test('动作作用域、结构、物品约束、幂等及恢复，不合法动作不改变世界', () => {
  const f = fixture(), world = new CommitmentWorld(f), initial = world.snapshot();
  assert.throws(() => world.execute(delivery({ scope: { ...scope, agentId: 'foreign' } })), /scope/);
  assert.throws(() => world.execute(delivery({ action: { action: 'deliver', itemId: 'missing', recipientId: 'b' } })), /delivery/);
  assert.throws(() => world.execute(delivery({ action: { action: 'delete_all' } })), /unsupported/);
  assert.deepEqual(world.snapshot(), initial);
  world.execute(delivery()); assert.equal(world.execute(delivery()).duplicate, true);
  assert.throws(() => world.execute(delivery({ atMs: 901 })), /conflict/);
  const recovered = new CommitmentWorld({ ...f, snapshot: world.snapshot() });
  assert.equal(recovered.execute(delivery()).duplicate, true); assert.equal(recovered.evaluate(1001).completedDue, 1);
  assert.throws(() => new CommitmentWorld({ ...f, scope: { ...scope, worldId: 'other' }, snapshot: world.snapshot() }), /identity/);
});
