const test = require('node:test');
const assert = require('node:assert/strict');
const { rankCandidates, selectMemories } = require('../lib/memory-retrieval');
const scope = { worldId: 'world', agentId: 'agent' }, nowMs = 7200000;
const memory = (id, relevance, importance, lastAccess, text = id) =>
  ({ ...scope, id, relevance, importance, lastAccess, text, sourceEventIds: [id] });
const select = (ranked, extra = {}) => selectMemories({ ranked, policy: 'budgeted_retrieval', n: 3,
  nowMs, memoryBudgetTokens: 10, maxInputTokens: 20,
  // A deterministic test tokenizer, never used in experiment metrics.
  countTokens: text => text.length, renderMemory: items => items.map(m => m.text).join('|'),
  renderInput: items => `task:${items.map(m => m.text).join('|')}`, ...extra });

test('上游三项归一化排序及访问节流，外部角色不影响分数', () => {
  const candidates = [memory('a', 1, 0, 0), memory('b', 0.5, 9, nowMs), memory('c', 0, 0, 0),
    { ...memory('foreign', 999, 999, nowMs), worldId: 'another' }];
  const ranked = rankCandidates({ scope, candidates, nowMs });
  assert.deepEqual(ranked.map(r => [r.memory.id, r.score]), [['b', 2.5], ['a', 1], ['c', 0]]);
  const result = select(ranked);
  assert.deepEqual(result.touches.map(t => t.id), ['a', 'c']);
  result.selected[0].sourceEventIds.push('changed');
  assert.deepEqual(candidates[1].sourceEventIds, ['b']);
  assert.equal(candidates[0].lastAccess, 0);
});
test('候选先 relevance 取 10n 再重排，同分稳定且空集合正常', () => {
  const candidates = Array.from({ length: 31 }, (_, i) => memory(String(i), 31 - i, 1, nowMs));
  const ranked = rankCandidates({ scope, candidates, nowMs });
  assert.equal(ranked.length, 30); assert.ok(!ranked.some(r => r.memory.id === '30'));
  const equal = rankCandidates({ scope, nowMs, candidates: [memory('a', 1, 1, 0), memory('b', 1, 1, 0)] });
  assert.deepEqual(equal.map(r => r.score), [0, 0]);
  assert.deepEqual(rankCandidates({ scope, nowMs, candidates: [] }), []);
});
test('预算计入分隔符及完整模板，长条显式跳过且不截断', () => {
  const ranked = rankCandidates({ scope, nowMs, candidates: [
    memory('long', 3, 0, 0, 'x'.repeat(11)), memory('short', 2, 0, 0, 'abcd'), memory('next', 1, 0, 0, 'efgh')] });
  const result = select(ranked);
  assert.deepEqual(result.selected.map(m => m.id), ['short', 'next']);
  assert.equal(result.memoryTokens, 9); assert.equal(result.inputTokens, 14);
  assert.equal(result.excluded[0].reason, 'memory_budget');
  const tight = select(ranked, { maxInputTokens: 10 });
  assert.deepEqual(tight.selected.map(m => m.id), ['short']);
  assert.equal(tight.excluded.at(-1).reason, 'input_budget');
});
test('原版 Top-K 溢出不能伪装成预算检索；拒绝时不更新访问时间', () => {
  const ranked = rankCandidates({ scope, nowMs, candidates: [memory('long', 1, 1, 0, 'x'.repeat(30))] });
  const result = select(ranked, { policy: 'upstream_top_k' });
  assert.equal(result.selected.length, 1); assert.equal(result.executable, false);
  assert.equal(result.rejectionReason, 'input_budget_exceeded'); assert.deepEqual(result.touches, []);
  assert.throws(() => select(ranked, { maxInputTokens: 4 }), /essential_input_budget_exceeded/);
  assert.throws(() => rankCandidates({ scope, nowMs, candidates: [memory('bad', NaN, 1, 0)] }), /invalid_memory/);
});
