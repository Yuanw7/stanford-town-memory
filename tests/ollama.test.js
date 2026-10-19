const test = require('node:test');
const assert = require('node:assert/strict');
const { OllamaClient } = require('../lib/ollama');

const complete = { done: true, done_reason: 'stop', response: '你好', prompt_eval_count: 12,
  eval_count: 2, total_duration: 3000000 };
test('计量成功请求并保留真实 token', async () => {
  const logs = [];
  const client = new OllamaClient({ record: row => logs.push(row), fetchImpl: async () => Response.json(complete) });
  await client.request('/api/generate', { model: 'test' }, { worldId: 'a', agentId: 'b', purpose: 'answer' });
  assert.equal(logs[0].inputTokens, 12);
  assert.equal(logs[0].outputTokens, 2);
  assert.equal(logs[0].queueMs, null); // 服务未提供排队计量，不能编造。
  assert.equal(logs[0].worldId, 'a');
});
test('500 重试逐 attempt 留痕，失败 usage 为 null', async () => {
  const logs = []; let calls = 0;
  const client = new OllamaClient({ record: row => logs.push(row), fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('error', { status: 500 }) : Response.json(complete);
  } });
  await client.request('/api/generate', { model: 'test' });
  assert.equal(logs.length, 2);
  assert.equal(logs[0].inputTokens, null);
  assert.equal(logs[0].logicalCallId, logs[1].logicalCallId);
  assert.equal(logs[1].attempt, 2);
});
test('流式碎片与最后 usage 正确汇总', async () => {
  const encoder = new TextEncoder();
  const text = JSON.stringify({ response: '你', done: false }) + '\n'
    + JSON.stringify({ ...complete, response: '好' }) + '\n';
  const client = new OllamaClient({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    const bytes = encoder.encode(text);
    controller.enqueue(bytes.slice(0, 31)); controller.enqueue(bytes.slice(31)); controller.close();
  } })) });
  const { result, entry } = await client.request('/api/generate', { model: 'test' }, {}, true);
  assert.equal(result.response, '你好');
  assert.equal(entry.outputTokens, 2);
});
test('流式缺少终止标记视为失败，不把部分文本当完整响应', async () => {
  const logs = [];
  const client = new OllamaClient({ record: row => logs.push(row),
    fetchImpl: async () => new Response('{"response":"部分","done":false}\n') });
  await assert.rejects(client.request('/api/generate', { model: 'test' }, {}, true), /缺少结束/);
  assert.equal(logs[0].usageStatus, 'unknown');
});
test('调用上限阻止继续发起请求', async () => {
  let calls = 0;
  const client = new OllamaClient({ maxTotalCalls: 1, fetchImpl: async () => {
    calls++; return new Response('', { status: 500 });
  } });
  await assert.rejects(client.request('/api/generate', { model: 'test' }), /budget_exhausted/);
  assert.equal(calls, 1);
});
test('中断及墙钟上限在请求前生效', async () => {
  const controller = new AbortController(); controller.abort();
  const client = new OllamaClient({ signal: controller.signal, fetchImpl: async () => { throw new Error('不应调用'); } });
  await assert.rejects(client.request('/api/generate', {}), /interrupted/);
  const expired = new OllamaClient({ deadline: Date.now() - 1 });
  await assert.rejects(expired.request('/api/generate', {}), /budget_exhausted/);
});
test('诊断禁止调用外部服务', () => {
  assert.throws(() => new OllamaClient({ host: 'https://api.example.com' }), /只允许本机/);
});
