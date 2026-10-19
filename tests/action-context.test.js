const test = require('node:test');
const assert = require('node:assert/strict');
const { withActionContext } = require('../lib/action-context');
test('动作身份和可读时钟来自作用域/公开时间，保留记忆和库存且不变更原输入', () => {
  const scope = { experimentId: 'e', worldId: 'w', agentId: 'alice' };
  const payload = { visibleWorld: { nowMs: 1000, inventory: ['parcel'], contacts: [] }, memories: 'selected evidence' };
  const before = structuredClone(payload), result = withActionContext(payload, scope);
  assert.deepEqual(result.self, { worldId: 'w', agentId: 'alice' });
  assert.equal(result.visibleWorld.nowUTC, '1970-01-01T00:00:01.000Z');
  assert.equal(result.memories, payload.memories); assert.deepEqual(result.visibleWorld.inventory, payload.visibleWorld.inventory);
  assert.deepEqual(Object.keys(result).sort(), ['memories', 'self', 'visibleWorld']);
  assert.deepEqual(payload, before);
  assert.throws(() => withActionContext(payload, { ...scope, agentId: '' }));
  assert.throws(() => withActionContext({ ...payload, visibleWorld: { nowMs: null } }, scope), /time/);
});
