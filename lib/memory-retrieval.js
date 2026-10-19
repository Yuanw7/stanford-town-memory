// Retrieval primitives only: callers supply scoped vector-search relevance and
// exact tokenizer functions. This is not the upstream write/reflection adapter.
const ACCESS_THROTTLE_MS = 300000;
const OVERFETCH = 10;

function normalize(value, values) {
  const min = Math.min(...values), max = Math.max(...values);
  return max === min ? 0 : (value - min) / (max - min);
}

function rankCandidates({ scope, candidates, nowMs, n = 3 }) {
  if (!scope?.worldId || !scope?.agentId || !Number.isFinite(nowMs)
      || !Number.isInteger(n) || n < 1) throw new Error('invalid_retrieval_parameters');
  // Filter before scoring/overfetch: foreign candidates cannot affect ranges.
  const visible = candidates.filter(m => m.worldId === scope.worldId && m.agentId === scope.agentId);
  const ids = new Set();
  for (const memory of visible) {
    if (typeof memory.id !== 'string' || !memory.id || ids.has(memory.id)
        || typeof memory.text !== 'string'
        || ![memory.relevance, memory.importance, memory.lastAccess].every(Number.isFinite)) {
      throw new Error('invalid_memory_candidate');
    }
    ids.add(memory.id);
  }
  const pool = visible.map(m => structuredClone(m))
    .sort((a, b) => b.relevance - a.relevance).slice(0, n * OVERFETCH);
  if (!pool.length) return [];
  const recency = pool.map(m => 0.99 ** Math.floor((nowMs - m.lastAccess) / 3600000));
  if (!recency.every(Number.isFinite)) throw new Error('invalid_recency');
  const relevance = pool.map(m => m.relevance), importance = pool.map(m => m.importance);
  return pool.map((memory, index) => ({ memory, score:
    normalize(memory.relevance, relevance) + normalize(memory.importance, importance)
      + normalize(recency[index], recency) }))
    .sort((a, b) => b.score - a.score);
}

function selectMemories({ ranked, policy, n = 3, memoryBudgetTokens,
  maxInputTokens, countTokens, renderMemory, renderInput, nowMs }) {
  if (!['upstream_top_k', 'budgeted_retrieval'].includes(policy)
      || !Number.isInteger(n) || n < 1 || !Number.isInteger(maxInputTokens) || maxInputTokens < 1
      || typeof countTokens !== 'function' || typeof renderMemory !== 'function'
      || typeof renderInput !== 'function' || !Number.isFinite(nowMs)) throw new Error('invalid_selection_parameters');
  if (policy === 'budgeted_retrieval' && (!Number.isInteger(memoryBudgetTokens) || memoryBudgetTokens < 0)) {
    throw new Error('invalid_memory_budget');
  }
  const count = text => {
    const tokens = countTokens(text);
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error('invalid_token_count');
    return tokens;
  };
  const measure = items => ({ memoryTokens: count(renderMemory(items)), inputTokens: count(renderInput(items)) });
  if (measure([]).inputTokens > maxInputTokens) throw new Error('essential_input_budget_exceeded');
  const selected = [], excluded = [];
  for (const item of ranked) {
    if (selected.length === n) { excluded.push({ id: item.memory.id, reason: 'item_limit' }); continue; }
    const trial = [...selected, item.memory];
    const tokens = measure(trial);
    if (policy === 'budgeted_retrieval') {
      if (tokens.memoryTokens > memoryBudgetTokens || tokens.inputTokens > maxInputTokens) {
        excluded.push({ id: item.memory.id, reason: tokens.memoryTokens > memoryBudgetTokens
          ? 'memory_budget' : 'input_budget' });
        continue;
      }
    }
    selected.push(structuredClone(item.memory));
  }
  const tokens = measure(selected);
  // Original Top-K is never silently reduced to fit a window.
  const executable = tokens.inputTokens <= maxInputTokens;
  return { policy, selected, excluded, ...tokens, executable,
    rejectionReason: executable ? null : 'input_budget_exceeded',
    touches: executable ? selected.filter(m => m.lastAccess < nowMs - ACCESS_THROTTLE_MS)
      .map(m => ({ id: m.id, lastAccess: nowMs })) : [] };
}

module.exports = { rankCandidates, selectMemories, ACCESS_THROTTLE_MS, OVERFETCH };
