function validateTownSnapshot(initial, current) {
  if (current.agentCount !== 5 || current.worldId !== initial.worldId) throw new Error('角色数或世界发生变化');
  if (current.status !== 'running' || current.engineRunning !== true) throw new Error('世界或引擎已暂停');
  if (!Number.isInteger(initial.controlEpoch) || current.controlEpoch !== initial.controlEpoch) {
    throw new Error('引擎控制计数改变，不能算作连续健康运行');
  }
  if (!Array.isArray(current.staleOperations) || current.staleOperations.length) throw new Error('存在悬挂或无法验证的操作');
  if (current.embeddings.some(e => !e.exists || !e.playerIdMatches || e.dimensions !== 1024)) {
    throw new Error('记忆与向量关联错误');
  }
}
module.exports = { validateTownSnapshot };
