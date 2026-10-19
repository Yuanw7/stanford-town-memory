const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAblations, maintenanceFingerprint } = require('../lib/policy-ablation');
test('消融只允许指定因子变化，不能同时改规划和预算后声称单因子效果', () => {
  const config = { extractionFormat: 'source_sentence_schema_v1', variants: [
    { id: 'a', policy: 'tiered_memory', memoryBudgetTokens: 512 },
    { id: 'b', policy: 'tiered_memory', memoryBudgetTokens: 512, queryPlanner: 'deterministic_any_v1' }],
  ablations: [{ control: 'a', treatment: 'b', factor: 'queryPlanner' }] };
  assert.equal(validateAblations(config).length, 1);
  config.variants[1].memoryBudgetTokens = 1024;
  assert.throws(() => validateAblations(config), /multiple_ablation_factors/);
});
test('维护比较忽略运行作用域和向量浮点差异，但不能忽略世界、角色或事实漂移', () => {
  const a = { transactions: [{ scope: { experimentId: 'e1', worldId: 'w', agentId: 'a' }, conversation: { id: 'c' },
    records: [{ id: 'r', value: 'fact', embedding: [1, 0] }] }] };
  const b = structuredClone(a); b.transactions[0].scope.experimentId = 'e2'; b.transactions[0].records[0].embedding = [0.99, 0.01];
  assert.equal(maintenanceFingerprint(a), maintenanceFingerprint(b));
  b.transactions[0].records[0].value = 'changed'; assert.notEqual(maintenanceFingerprint(a), maintenanceFingerprint(b));
  b.transactions[0].records[0].value = 'fact'; b.transactions[0].scope.agentId = 'other';
  assert.notEqual(maintenanceFingerprint(a), maintenanceFingerprint(b));
});
