const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fingerprint } = require('./conversations-v2');
function scopeKey(scope) {
  if (!scope || !['experimentId', 'worldId', 'agentId'].every(k => typeof scope[k] === 'string' && scope[k])) {
    throw new Error('invalid_memory_scope');
  }
  return JSON.stringify([scope.experimentId, scope.worldId, scope.agentId]);
}
class MemoryStore {
  constructor({ dimensions = 1024, embeddingVersion, snapshot } = {}) {
    if (!Number.isInteger(dimensions) || dimensions < 1 || typeof embeddingVersion !== 'string' || !embeddingVersion) {
      throw new Error('invalid_embedding_identity');
    }
    this.dimensions = dimensions; this.embeddingVersion = embeddingVersion;
    this.transactions = []; this.touchTransactions = []; this.operations = new Map(); this.records = new Map();
    if (snapshot) {
      if (![1, 2].includes(snapshot.schemaVersion) || snapshot.dimensions !== dimensions
          || snapshot.embeddingVersion !== embeddingVersion || !Array.isArray(snapshot.transactions)) throw new Error('snapshot_identity_mismatch');
      for (const tx of snapshot.transactions) this.commit(tx);
      if (snapshot.schemaVersion === 2) {
        if (!Array.isArray(snapshot.touchTransactions)) throw new Error('invalid_touch_snapshot');
        for (const tx of snapshot.touchTransactions) this.touch(tx);
      }
    }
  }
  operation(scope, operationId) { return this.operations.get(JSON.stringify([scopeKey(scope), operationId])); }
  visible(scope) { return structuredClone(this.records.get(scopeKey(scope)) ?? []); }
  commit({ scope, operationId, inputFingerprint, memories }) {
    const key = scopeKey(scope);
    if (typeof operationId !== 'string' || !operationId || !/^[a-f0-9]{64}$/.test(inputFingerprint)
        || !Array.isArray(memories) || !memories.length) throw new Error('invalid_memory_transaction');
    const transaction = { scope: JSON.parse(JSON.stringify(scope)), operationId, inputFingerprint, memories: structuredClone(memories) };
    const digest = fingerprint(transaction), existing = this.operation(scope, operationId);
    if (existing) {
      if (existing.digest !== digest) throw new Error('operation_conflict');
      return { inserted: false, count: memories.length };
    }
    const current = this.records.get(key) ?? [], ids = new Set(current.map(m => m.id));
    for (const m of memories) {
      if (typeof m.id !== 'string' || !m.id || ids.has(m.id) || typeof m.text !== 'string' || !m.text.trim()
          || !['conversation', 'reflection'].includes(m.kind)
          || ![m.createdAtMs, m.lastAccess].every(v => Number.isSafeInteger(v) && v >= 0)
          || !Number.isFinite(m.importance) || m.embeddingVersion !== this.embeddingVersion
          || !Array.isArray(m.embedding) || m.embedding.length !== this.dimensions || !m.embedding.every(Number.isFinite)
          || !Array.isArray(m.sourceEventIds) || !Array.isArray(m.sourceMemoryIds)
          || !m.sourceEventIds.every(v => typeof v === 'string' && v)
          || !m.sourceMemoryIds.every(id => current.some(row => row.id === id))
          || (m.kind === 'conversation' && !m.sourceEventIds.length)
          || (m.kind === 'reflection' && !m.sourceMemoryIds.length)) throw new Error('invalid_memory_or_provenance');
      ids.add(m.id);
    }
    this.records.set(key, [...current, ...structuredClone(memories)]);
    this.transactions.push(transaction);
    this.operations.set(JSON.stringify([key, operationId]), { digest, inputFingerprint });
    return { inserted: true, count: memories.length };
  }
  touch({ scope, operationId, ids, nowMs }) {
    const key = scopeKey(scope), current = this.records.get(key) ?? [];
    if (typeof operationId !== 'string' || !operationId || !Array.isArray(ids) || new Set(ids).size !== ids.length
        || !Number.isSafeInteger(nowMs) || nowMs < 0 || ids.some(id => !current.some(m => m.id === id))) {
      throw new Error('invalid_touch_transaction');
    }
    const tx = structuredClone({ scope, operationId, ids, nowMs }), digest = fingerprint(tx);
    const operationKey = JSON.stringify([key, `touch:${operationId}`]), previous = this.operations.get(operationKey);
    if (previous) {
      if (previous.digest !== digest) throw new Error('operation_conflict');
      return { inserted: false };
    }
    if (ids.some(id => current.find(m => m.id === id).lastAccess > nowMs)) throw new Error('non_monotonic_touch');
    this.records.set(key, current.map(m => ids.includes(m.id) && m.lastAccess < nowMs - 300000
      ? { ...m, lastAccess: nowMs } : m));
    this.touchTransactions.push(tx); this.operations.set(operationKey, { digest });
    return { inserted: true };
  }
  snapshot() { return structuredClone({ schemaVersion: 2, dimensions: this.dimensions,
    embeddingVersion: this.embeddingVersion, transactions: this.transactions, touchTransactions: this.touchTransactions }); }
  save(file) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(this.snapshot())); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
module.exports = { MemoryStore, scopeKey };
