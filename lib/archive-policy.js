const { scopeKey } = require('./memory-store');
const { fingerprint, validateConversation } = require('./conversations-v2');
const { deterministicPlan } = require('./query-plan');
const { selectMemories } = require('./memory-retrieval');
const { cosine } = require('./baseline-policy');
function archiveText(c, m) {
  const author = c.participants.find(p => p.agentId === m.authorAgentId);
  return `${new Date(m.atMs).toISOString()} ${author.name} (${author.agentId}): ${m.text}`;
}
class ArchiveStore {
  constructor({ dimensions, embeddingVersion, snapshot } = {}) {
    if (!Number.isInteger(dimensions) || dimensions < 1 || typeof embeddingVersion !== 'string' || !embeddingVersion) throw new Error('invalid_archive_identity');
    Object.assign(this, { dimensions, embeddingVersion }); this.transactions = []; this.operations = new Map();
    if (snapshot) {
      if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'archive' || snapshot.dimensions !== dimensions
          || snapshot.embeddingVersion !== embeddingVersion || !Array.isArray(snapshot.transactions)) throw new Error('archive_snapshot_mismatch');
      for (const tx of snapshot.transactions) this.commit(tx);
    }
  }
  operation(scope, id) { return this.operations.get(JSON.stringify([scopeKey(scope), id])); }
  records(scope) { const key = scopeKey(scope); return structuredClone(this.transactions.filter(tx => scopeKey(tx.scope) === key).flatMap(tx => tx.records)); }
  commit({ scope, conversation, records }) {
    const c = validateConversation(conversation); scopeKey(scope);
    if (scope.worldId !== c.worldId || !c.observedBy.includes(scope.agentId) || !Array.isArray(records)
        || records.length !== c.messages.length) throw new Error('archive_scope_or_sources_mismatch');
    const tx = structuredClone({ scope, conversation: c, records }), digest = fingerprint(tx), previous = this.operation(scope, c.id);
    if (previous) { if (previous.digest !== digest) throw new Error('archive_operation_conflict'); return { inserted: false }; }
    const ids = new Set(this.records(scope).map(r => r.id));
    for (const [i, r] of records.entries()) {
      const m = c.messages[i];
      if (r.id !== `archive:${m.id}` || ids.has(r.id) || r.text !== archiveText(c, m) || r.createdAtMs !== m.atMs
          || fingerprint(r.sourceEventIds) !== fingerprint([m.id]) || r.lastAccess !== m.atMs
          || !Array.isArray(r.embedding) || r.embedding.length !== this.dimensions || !r.embedding.every(Number.isFinite)) throw new Error('invalid_archive_record');
      ids.add(r.id);
    }
    this.transactions.push(tx); this.operations.set(JSON.stringify([scopeKey(scope), c.id]), { digest, inputFingerprint: fingerprint(c) });
    return { inserted: true, count: records.length };
  }
  snapshot() { return structuredClone({ schemaVersion: 1, kind: 'archive', dimensions: this.dimensions, embeddingVersion: this.embeddingVersion, transactions: this.transactions }); }
}
class ArchivePolicy {
  constructor({ store, embed, record = () => {} }) { Object.assign(this, { store, embed, record }); this.pending = new Map(); }
  serial(scope, fn) {
    const key = scopeKey(scope), previous = this.pending.get(key) ?? Promise.resolve(), job = previous.catch(() => {}).then(fn);
    this.pending.set(key, job); return job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
  }
  observe(event, scope, { nowMs } = {}) {
    return this.serial(scope, async () => {
      const c = validateConversation(event);
      if (scope.worldId !== c.worldId || !c.observedBy.includes(scope.agentId) || !Number.isSafeInteger(nowMs)
          || nowMs < c.messages.at(-1).atMs || this.store.records(scope).some(r => r.createdAtMs > nowMs)) throw new Error('invalid_archive_observation');
      const previous = this.store.operation(scope, c.id);
      if (previous) { if (previous.inputFingerprint !== fingerprint(c)) throw new Error('archive_operation_conflict'); return { inserted: false }; }
      const records = [];
      for (const m of c.messages) {
        const text = archiveText(c, m), embedding = await this.embed(text, { ...scope, purpose: 'archive_embedding', sourceEventId: m.id });
        records.push({ id: `archive:${m.id}`, text, sourceEventIds: [m.id], createdAtMs: m.atMs, lastAccess: m.atMs, embedding });
      }
      const result = this.store.commit({ scope, conversation: c, records });
      this.record({ action: 'archive_observe', scope, eventId: c.id, ...result }); return result;
    });
  }
  retrieve(scope, { text, queryId, nowMs, n = 3, readOnly = true, memoryBudgetTokens, maxInputTokens,
    countTokens, renderMemory, renderInput } = {}) {
    return this.serial(scope, async () => {
      const all = this.store.records(scope);
      if (readOnly !== true || typeof text !== 'string' || !text.trim() || typeof queryId !== 'string' || !queryId
          || !Number.isSafeInteger(nowMs) || nowMs < 0 || all.some(r => r.createdAtMs > nowMs)) throw new Error('invalid_archive_query');
      const plan = { ...deterministicPlan(text, nowMs), focus: 'any', planner: 'archive_observed_time_v1' };
      const params = { policy: 'budgeted_retrieval', n, nowMs, memoryBudgetTokens, maxInputTokens, countTokens, renderMemory, renderInput };
      selectMemories({ ...params, ranked: [] });
      // This filters event observation time, not semantic fact validity. Later
      // retellings are absent from an as-of view even if they describe the past.
      const candidates = all.filter(r => r.createdAtMs <= plan.asOfMs);
      const vector = candidates.length ? await this.embed(text, { ...scope, purpose: 'archive_retrieval_embedding', queryId }) : null;
      const ranked = candidates.map(memory => ({ memory, score: cosine(vector, memory.embedding) }))
        .sort((a, b) => b.score - a.score || b.memory.createdAtMs - a.memory.createdAtMs);
      const result = selectMemories({ ...params, ranked });
      this.record({ action: 'archive_retrieve', scope, queryId, plan, selectedIds: result.selected.map(r => r.id),
        excludedByTime: all.filter(r => r.createdAtMs > plan.asOfMs).map(r => r.id), excluded: result.excluded,
        candidates: ranked.map(r => ({ id: r.memory.id, score: r.score })), executable: result.executable });
      return { ...result, plan };
    });
  }
}
module.exports = { ArchiveStore, ArchivePolicy, archiveText };
