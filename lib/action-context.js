const { scopeKey } = require('./memory-store');
function withActionContext(payload, scope) {
  scopeKey(scope);
  if (!payload?.visibleWorld || !Number.isSafeInteger(payload.visibleWorld.nowMs) || payload.visibleWorld.nowMs < 0) throw new Error('invalid_action_context_time');
  const result = structuredClone(payload);
  result.self = { worldId: scope.worldId, agentId: scope.agentId };
  result.visibleWorld.nowUTC = new Date(result.visibleWorld.nowMs).toISOString();
  return result;
}
module.exports = { withActionContext };
