const test = require('node:test');
const assert = require('node:assert/strict');
const { compareMemories } = require('../lib/memory-comparison');
const { evaluateComparison } = require('../lib/comparison-evaluation');
const c = { schemaVersion: 2, type: 'conversation', id: 'c', worldId: 'w', createdAtMs: 1000,
  participants: [{ agentId: 'a', name: 'Alice' }, { agentId: 'b', name: 'Bob' }], observedBy: ['a', 'b'],
  messages: [{ id: 'm', authorAgentId: 'a', atMs: 1001, text: 'Hi Bob' }] };
const workload = { conversations: [c], queries: [{ id: 'q1', worldId: 'w', agentId: 'a', text: 'Who?', category: 'relationship', atMs: 2000 },
  { id: 'q2', worldId: 'w', agentId: 'b', text: 'PIN?', category: 'unanswerable', atMs: 2001 }] };
const config = { repetitions: 2, seed: 42, embeddingDimensions: 2, embeddingDigest: 'digest', maxInputTokens: 10000,
  queryOutputTokens: 128, variants: [{ id: 'baseline', policy: 'upstream_top_k' }, { id: 'budget', policy: 'budgeted_retrieval', memoryBudgetTokens: 1 }] };
const truth = [{ id: 'q1', acceptedAnswers: ['Bob'], sourceEventIds: ['m'] }, { id: 'q2', acceptedAnswers: ['未知'], sourceEventIds: [] }];
test('多查询 runner 独立重建重复、轮换策略顺序、只读预算选择与记录', async () => {
  const journal = [], saved = [], seeds = new Set();
  const runtime = { tokenizer: { count: text => text.length }, generate: async (_, scope) => {
    seeds.add(scope.seed); return scope.purpose === 'importance' ? '5' : scope.purpose === 'summary' ? 'Summary' : '{"answer":"Bob"}';
  }, embed: async () => [1, 0] };
  const result = await compareMemories({ workload, config, runtime, experimentId: 'run',
    record: (file, row) => journal.push({ file, row }), save: (name, value) => saved.push({ name, value }) });
  assert.equal(result.answers.length, 8); assert.deepEqual([...seeds], [42, 43]);
  assert.deepEqual(result.answers.filter(a => a.queryId === 'q1').map(a => a.strategy), ['baseline', 'budget', 'budget', 'baseline']);
  assert.ok(result.retrieval.filter(r => r.strategy === 'budget').every(r => r.selectedIds.length === 0));
  assert.ok(result.retrieval.filter(r => r.strategy === 'baseline').every(r => r.selectedIds.length === 1));
  assert.ok(saved.every(s => s.value.touchTransactions.length === 0));
});
test('评估不漏掉失败或未执行问题，按类别和重复独立计数', () => {
  const predictions = [{ repetition: 1, strategy: 'baseline', queryId: 'q1', status: 'succeeded', response: '{"answer":"Bob"}' },
    { repetition: 1, strategy: 'budget', queryId: 'q1', status: 'rejected_input_budget', response: null }];
  const result = evaluateComparison({ workload, config, manifest: { status: 'failed' }, predictions, truth });
  assert.equal(result.byVariant.baseline.accuracy, 0.25);
  assert.equal(result.byVariant.budget.accuracy, 0);
  assert.equal(result.byVariant.baseline.missing, 3); assert.equal(result.distinctQuestions, 2);
  assert.equal(result.complete, false); assert.equal(result.formalQualityAccepted, false);
});
test('评估拒绝重复预测、答案缺项、未知查询与越界证据', () => {
  const p = { repetition: 1, strategy: 'baseline', queryId: 'q1', status: 'succeeded', response: '{"answer":"Bob"}' };
  const evaluate = (predictions, answers = truth) => evaluateComparison({ workload, config, manifest: { status: 'completed' }, predictions, truth: answers });
  assert.throws(() => evaluate([p, p]), /duplicate/);
  assert.throws(() => evaluate([{ ...p, queryId: 'unknown' }]), /prediction/);
  assert.throws(() => evaluate([], truth.slice(0, 1)), /mismatch/);
  assert.throws(() => evaluate([], [{ ...truth[0], sourceEventIds: ['foreign'] }, truth[1]]), /not_visible/);
});

test('已标注矛盾、未知/缺失回答与未识别错误分开，覆盖率不冒充完整矛盾率', () => {
  const answers = [{ ...truth[0], contradictionAnswers: ['Alice'] }, truth[1]];
  const p = response => ({ repetition: 1, strategy: 'baseline', queryId: 'q1', status: 'succeeded', response });
  const score = predictions => evaluateComparison({ workload, config, manifest: { status: 'completed' }, predictions, truth: answers });
  const wrong = score([p('{"answer":"Alice"}')]).byVariant.baseline.contradictions;
  assert.equal(wrong.confirmed, 1); assert.equal(wrong.assessed, 1); assert.equal(wrong.unassessed, 1);
  assert.equal(score([p('{"answer":"未知"}')]).byVariant.baseline.contradictions.confirmed, 0);
  assert.equal(score([p('{"answer":"Unlisted claim"}')]).byVariant.baseline.contradictions.assessed, 0);
  assert.equal(score([]).byVariant.baseline.contradictions.unassessed, 2);
  assert.throws(() => evaluateComparison({ workload, config, manifest: {}, predictions: [],
    truth: [{ ...truth[0], contradictionAnswers: ['Bob'] }, truth[1]] }), /annotations/);
});
