const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../index');
const base = require('../configs/experiment.example.json');
test('草案可检查，正式配置拒绝占位信息', () => {
  assert.deepEqual(validateConfig(base), []);
  const errors = validateConfig(base, { formal: true });
  assert.ok(errors.some(e => e.includes('ready')));
  assert.ok(errors.some(e => e.includes('UNSET')));
});
test('质量门槛必须含承诺完成，输入输出预算必须合法', () => {
  const bad = structuredClone(base);
  delete bad.qualityGates.maxCommitmentDropPercentagePoints;
  bad.budgets.maxInputTokens = 8192;
  assert.ok(validateConfig(bad).some(e => e.includes('maxCommitment')));
  assert.ok(validateConfig(bad).some(e => e.includes('上下文窗口')));
});
