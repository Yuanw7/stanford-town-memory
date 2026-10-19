const { fingerprint } = require('./conversations-v2');
const { scopeKey } = require('./memory-store');
const { ConversationMemoryWriter, reflectionEligible, reflectionMessages, parseReflections,
  importanceMessages, parseImportance } = require('./upstream-memory-adapter');
const { rankCandidates, selectMemories } = require('./memory-retrieval');

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length
      || !a.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error('invalid_search_vector');
  const normA = Math.hypot(...a), normB = Math.hypot(...b);
  if (!Number.isFinite(normA) || !Number.isFinite(normB) || normA === 0 || normB === 0) throw new Error('zero_or_invalid_search_vector');
  return a.reduce((sum, x, i) => sum + (x / normA) * (b[i] / normB), 0);
}
// Offline adaptation. Exact cosine replaces Convex vector search; parity with
// the upstream database and online conversation behavior is not established.
class BaselinePolicy {
  constructor({ store, generate, embed, record = () => {} }) {
    Object.assign(this, { store, generate, embed, record });
    this.writer = new ConversationMemoryWriter({ store, generate, embed }); this.pending = new Map();
  }
  serial(scope, action) {
    const key = scopeKey(scope), previous = this.pending.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(action);
    this.pending.set(key, job);
    return job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
  }
  assertClock(memories, nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || memories.some(m => m.createdAtMs > nowMs || m.lastAccess > nowMs)) {
      throw new Error('invalid_or_non_monotonic_clock');
    }
  }
  observe(event, scope, { nowMs, name } = {}) {
    return this.serial(scope, async () => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('invalid_agent_name');
      this.assertClock(this.store.visible(scope), nowMs);
      if (!event.messages?.length || event.messages.at(-1).atMs > nowMs) throw new Error('invalid_observation_clock');
      const write = await this.writer.remember(event, scope);
      this.record({ action: 'observe', scope, eventId: event.id, ...write });
      // Retrying an already written conversation still retries pending maintenance.
      const maintenance = await this.reflect(scope, { nowMs, name });
      return { write, maintenance };
    });
  }
  consolidate(scope, options) { return this.serial(scope, () => this.reflect(scope, options)); }
  async reflect(scope, { nowMs, name } = {}) {
    const all = this.store.visible(scope); this.assertClock(all, nowMs);
    if (typeof name !== 'string' || !name.trim()) throw new Error('invalid_agent_name');
    // Upstream takes newest 100 by insertion time; logical creation and stable
    // insertion order are the explicit offline equivalent.
    const latest = all.map((m, index) => ({ ...m, insertionIndex: index }))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.insertionIndex - a.insertionIndex);
    const lastReflection = latest.find(m => m.kind === 'reflection')?.createdAtMs ?? 0;
    const memories = latest.slice(0, 100);
    const eligible = reflectionEligible(memories, lastReflection);
    this.record({ action: 'reflection_gate', scope, nowMs, lastReflection, eligible,
      candidateIds: memories.map(m => m.id), importanceSinceReflection:
        memories.filter(m => m.createdAtMs > lastReflection).reduce((n, m) => n + m.importance, 0) });
    if (!eligible) return { reflected: false, reason: 'below_threshold' };
    const inputFingerprint = fingerprint({ lastReflection, memories: memories.map(m =>
      ({ id: m.id, text: m.text, importance: m.importance, createdAtMs: m.createdAtMs })) });
    const operationId = `reflection:${inputFingerprint}`;
    const raw = await this.generate(reflectionMessages(name, memories), { ...scope, purpose: 'reflection' });
    const insights = parseReflections(raw, memories), outputs = [];
    for (const [i, item] of insights.entries()) {
      const importance = parseImportance(await this.generate(importanceMessages(item.text), { ...scope, purpose: 'reflection_importance' }, 1));
      const embedding = await this.embed(item.text, { ...scope, purpose: 'reflection_embedding' });
      outputs.push({ ...item, id: `${operationId}:${i}`, kind: 'reflection', sourceEventIds: [],
        createdAtMs: nowMs, lastAccess: nowMs, importance: importance.value, importanceFallback: importance.fallback,
        embedding, embeddingVersion: this.store.embeddingVersion });
    }
    const committed = this.store.commit({ scope, operationId, inputFingerprint, memories: outputs });
    this.record({ action: 'reflection_commit', scope, operationId, memoryIds: outputs.map(m => m.id), ...committed });
    return { reflected: true, count: outputs.length };
  }
  retrieve(scope, { text, queryId, nowMs, n = 3, policy = 'upstream_top_k', readOnly = true,
    memoryBudgetTokens, maxInputTokens, countTokens, renderMemory, renderInput } = {}) {
    return this.serial(scope, async () => {
      if (typeof text !== 'string' || !text.trim() || typeof queryId !== 'string' || !queryId
          || typeof readOnly !== 'boolean' || !Number.isInteger(n) || n < 1) throw new Error('invalid_memory_query');
      const memories = this.store.visible(scope); this.assertClock(memories, nowMs);
      selectMemories({ ranked: [], policy, n, nowMs, memoryBudgetTokens, maxInputTokens,
        countTokens, renderMemory, renderInput });
      const vector = memories.length ? await this.embed(text, { ...scope, purpose: 'retrieval_embedding' }) : null;
      if (vector && vector.length !== this.store.dimensions) throw new Error('invalid_search_dimensions');
      const candidates = memories.map(m => ({ ...m, worldId: scope.worldId, agentId: scope.agentId,
        relevance: cosine(vector, m.embedding) }));
      const ranked = rankCandidates({ scope, candidates, nowMs, n });
      const result = selectMemories({ ranked, policy, n, nowMs, memoryBudgetTokens, maxInputTokens,
        countTokens, renderMemory, renderInput });
      if (!readOnly && result.executable) this.store.touch({ scope, operationId: queryId,
        ids: result.selected.map(m => m.id), nowMs });
      this.record({ action: 'retrieve', scope, queryId, readOnly, policy, nowMs,
        candidates: ranked.map(r => ({ id: r.memory.id, relevance: r.memory.relevance, score: r.score })),
        selectedIds: result.selected.map(m => m.id), excluded: result.excluded,
        inputTokens: result.inputTokens, memoryTokens: result.memoryTokens, executable: result.executable });
      return result;
    });
  }
}
module.exports = { BaselinePolicy, cosine };
