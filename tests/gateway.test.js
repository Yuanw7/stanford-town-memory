const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { createGateway } = require('../lib/gateway');

function invoke(server, endpoint, payload, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = 'POST'; req.url = endpoint;
  req.headers = { 'x-town-call-id': 'logical-1', 'x-town-attempt': '1',
    'x-town-scope': encodeURIComponent(JSON.stringify({ experimentId: 'test', worldId: 'world', agentId: 'agent', purpose: 'query' })),
    ...headers };
  const res = new EventEmitter(); res.chunks = [];
  const complete = new Promise(resolve => {
    res.writeHead = code => { res.statusCode = code; res.headersSent = true; };
    res.write = chunk => { res.chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if (chunk) res.write(chunk); res.writableEnded = true; resolve(res); };
    res.destroy = () => { res.destroyed = true; resolve(res); };
  });
  server.emit('request', req, res);
  return complete;
}
const generation = { done: true, response: '你好', prompt_eval_count: 10, eval_count: 2, total_duration: 1000000 };

test('网关转发旧 embedding API 并计量原生 usage', async () => {
  const records = [];
  const server = createGateway({ record: row => records.push(row), fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/api/embed'));
    assert.deepEqual(JSON.parse(options.body), { model: 'embed', input: '证据', truncate: false });
    return Response.json({ embeddings: [[1, 2]], prompt_eval_count: 2 });
  } });
  const res = await invoke(server, '/api/embeddings', { model: 'embed', prompt: '证据' });
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), { embedding: [1, 2] });
  assert.equal(records[0].inputTokens, 2);
  assert.equal(records[0].outputTokens, null);
  assert.equal(records[0].usageStatus, 'measured');
});
test('网关要求显式角色作用域，不允许伪造计量字段', async () => {
  const records = [];
  const server = createGateway({ record: r => records.push(r), fetchImpl: async () => Response.json(generation) });
  const invalid = await invoke(server, '/api/generate', { model: 'test' }, { 'x-town-scope': '' });
  assert.equal(invalid.statusCode, 400);
  const scope = { experimentId: 'test', worldId: 'world', agentId: 'agent', purpose: 'query', attempt: 500, inputTokens: 99999 };
  await invoke(server, '/api/generate', { model: 'test' }, { 'x-town-scope': encodeURIComponent(JSON.stringify(scope)) });
  assert.equal(records[1].attempt, 1); assert.equal(records[1].inputTokens, 10);
});
test('串行队列保留角色归属和实际排队时间', async () => {
  const records = []; let active = 0, peak = 0;
  const server = createGateway({ record: r => records.push(r), fetchImpl: async () => {
    active++; peak = Math.max(peak, active); await delay(30); active--; return Response.json(generation);
  } });
  await Promise.all([invoke(server, '/api/generate', { model: 'test' }), invoke(server, '/api/generate', { model: 'test' })]);
  assert.equal(peak, 1); assert.ok(records[1].queueMs >= 20);
});
test('网关调用上限拒绝继续推理，拒绝请求也留记录', async () => {
  const records = []; let forwarded = 0;
  const server = createGateway({ maxCalls: 1, record: r => records.push(r), fetchImpl: async () => { forwarded++; return Response.json(generation); } });
  await invoke(server, '/api/generate', { model: 'test' });
  const blocked = await invoke(server, '/api/generate', { model: 'test' });
  assert.equal(blocked.statusCode, 429); assert.equal(forwarded, 1);
  assert.equal(records[1].status, 'budget_exhausted'); assert.equal(records[1].inputTokens, null);
});
test('OpenAI SSE 流保留结束 usage，转发 include_usage 参数', async () => {
  const records = [];
  const server = createGateway({ record: r => records.push(r), fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\n'
      + 'data: [DONE]\n\n');
  } });
  const res = await invoke(server, '/v1/chat/completions', { model: 'test', stream: true });
  assert.equal(res.statusCode, 200); assert.equal(records[0].inputTokens, 20); assert.equal(records[0].outputTokens, 2);
});
test('不完整流不能记为成功', async () => {
  const records = [];
  const server = createGateway({ record: r => records.push(r), fetchImpl: async () => new Response('data: {"choices":[]}\n\n') });
  await invoke(server, '/v1/chat/completions', { model: 'test', stream: true });
  assert.equal(records[0].status, 'failed'); assert.equal(records[0].usageStatus, 'unknown');
});
