const test = require('node:test');
const assert = require('node:assert/strict');
const { checkTownServices } = require('../lib/service-health');

test('存活但额度耗尽的网关不能作为小镇可用服务', async () => {
  let requests = 0;
  await assert.rejects(checkTownServices({ fetchImpl: async () => {
    requests++; return Response.json({ admissionOpen: false, remainingMs: 0 });
  } }), /gateway_budget_exhausted/);
  assert.equal(requests, 1);
});
test('观察启动前拒绝不足 30 分钟的额度，Ollama 关闭也不能通过', async () => {
  await assert.rejects(checkTownServices({ fetchImpl: async () => Response.json({ admissionOpen: true }) }), /invalid_health/);
  await assert.rejects(checkTownServices({ minimumRemainingMs: 1800000,
    fetchImpl: async () => Response.json({ admissionOpen: true, remainingMs: 1000 }) }), /insufficient_duration/);
  await assert.rejects(checkTownServices({ fetchImpl: async url => url.endsWith('/health')
    ? Response.json({ admissionOpen: true, remainingMs: 3600000 })
    : new Response('', { status: 502 }) }), /service_unavailable/);
  const result = await checkTownServices({ fetchImpl: async url => Response.json(url.endsWith('/health')
    ? { admissionOpen: true, remainingMs: 3600000 } : { version: 'test-version' }) });
  assert.equal(result.ollamaVersion, 'test-version');
});
