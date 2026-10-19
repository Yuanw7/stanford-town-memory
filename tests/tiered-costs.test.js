const test = require('node:test');
const assert = require('node:assert/strict');
const { costs } = require('../scripts/report-tiered-development');
test('失败生成的未知成本保留 null，不能被成功输出或 embedding 掩盖', () => {
  const good = { endpoint: '/api/generate', usageStatus: 'measured', inputTokens: 10, outputTokens: 3, endToEndMs: 20 };
  const embedding = { endpoint: '/api/embed', usageStatus: 'measured', inputTokens: 5, outputTokens: null, endToEndMs: 2 };
  const known = costs([good, embedding]);
  assert.equal(known.generationInputTokens, 10); assert.equal(known.generationOutputTokens, 3);
  assert.equal(known.embeddingInputTokens, 5); assert.equal(known.embeddingOutputTokens, null);
  const unknown = costs([good, embedding, { endpoint: '/api/generate', usageStatus: 'unknown', inputTokens: null, outputTokens: null, endToEndMs: 100 }]);
  assert.equal(unknown.attempts, 3); assert.equal(unknown.unknownUsageAttempts, 1);
  assert.equal(unknown.generationInputTokens, null); assert.equal(unknown.generationOutputTokens, null);
  assert.equal(unknown.embeddingInputTokens, 5); assert.equal(unknown.clientRequestElapsedMs, 122);
});
