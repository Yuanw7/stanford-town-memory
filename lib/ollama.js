const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

class OllamaClient {
  constructor({ host = 'http://127.0.0.1:11434', timeoutMs = 120000, maxAttempts = 2,
    maxTotalCalls = 1000, deadline = Infinity, record = () => {}, fetchImpl = fetch, signal } = {}) {
    const url = new URL(host);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('诊断工具只允许本机 HTTP Ollama 地址');
    }
    this.host = url.origin;
    Object.assign(this, { timeoutMs, maxAttempts, maxTotalCalls, deadline, record, fetchImpl, signal });
    this.attempts = 0;
  }
  async info(endpoint, body) {
    const response = await this.fetchImpl(this.host + endpoint, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Ollama ${endpoint} HTTP ${response.status}`);
    return response.json();
  }
  async request(endpoint, body, scope = {}, stream = false) {
    const logicalCallId = crypto.randomUUID();
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.signal?.aborted) throw new Error('interrupted');
      if (this.attempts >= this.maxTotalCalls || Date.now() >= this.deadline) {
        throw new Error('budget_exhausted：已达到调用次数或运行时间上限');
      }
      this.attempts++;
      const started = performance.now();
      const entry = { logicalCallId, attempt, ...scope, endpoint, model: body.model,
        startedAt: new Date().toISOString(), status: 'failed', inputTokens: null, outputTokens: null,
        usageStatus: 'unknown', queueMs: null };
      let status;
      let result;
      try {
        const response = await this.fetchImpl(this.host + endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json',
            'x-town-call-id': logicalCallId, 'x-town-attempt': String(attempt),
            'x-town-scope': encodeURIComponent(JSON.stringify({
              experimentId: scope.experimentId ?? 'diagnostic', worldId: scope.worldId ?? 'diagnostic',
              agentId: scope.agentId ?? 'diagnostic', purpose: scope.purpose ?? 'diagnostic',
            })),
          },
          body: JSON.stringify({ ...body, stream }),
          signal: this.signal ? AbortSignal.any([this.signal,
            AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, this.deadline - Date.now())))])
            : AbortSignal.timeout(Math.max(1, Math.min(this.timeoutMs, this.deadline - Date.now()))),
        });
        status = response.status;
        if (!response.ok) throw new Error(`Ollama HTTP ${status}`);
        if (stream) {
          const decoder = new TextDecoder();
          let buffer = '', text = '', final;
          const consume = line => {
            if (!line.trim()) return;
            const chunk = JSON.parse(line);
            if (chunk.error) throw new Error('Ollama 流式响应错误');
            text += chunk.response ?? chunk.message?.content ?? '';
            if (chunk.done) final = chunk;
          };
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop();
            lines.forEach(consume);
          }
          buffer += decoder.decode(); consume(buffer);
          if (!final) throw new Error('流式响应缺少结束与 usage 记录');
          result = { ...final, response: text };
        } else result = await response.json();
        if (result.error) throw new Error('Ollama 返回错误响应');
        if (endpoint === '/api/generate' && result.done !== true) throw new Error('生成响应未结束');
        const rawInputTokens = result.prompt_eval_count ?? result.usage?.prompt_tokens;
        const rawOutputTokens = result.eval_count ?? result.usage?.completion_tokens;
        const inputTokens = Number.isInteger(rawInputTokens) ? rawInputTokens : null;
        const outputTokens = Number.isInteger(rawOutputTokens) ? rawOutputTokens : null;
        Object.assign(entry, {
          status: 'succeeded', inputTokens, outputTokens,
          usageStatus: inputTokens === null || (endpoint === '/api/generate' && outputTokens === null) ? 'unknown' : 'measured',
          inferenceMs: result.total_duration === undefined ? null : result.total_duration / 1e6,
          loadMs: result.load_duration === undefined ? null : result.load_duration / 1e6,
          promptEvalMs: result.prompt_eval_duration === undefined ? null : result.prompt_eval_duration / 1e6,
          generationMs: result.eval_duration === undefined ? null : result.eval_duration / 1e6,
          doneReason: result.done_reason ?? null,
        });
      } catch (error) {
        entry.error = error.name === 'TimeoutError' ? 'timeout' : error.message;
        entry.status = error.name === 'TimeoutError' ? 'timeout' : 'failed';
      }
      entry.endToEndMs = performance.now() - started;
      this.record(entry);
      if (entry.status === 'succeeded') return { result, entry };
      // 不自动重试超时：服务端可能已经消耗计算，未知 usage 仍保留。
      if (!(status === 429 || status >= 500) || attempt === this.maxAttempts) throw new Error(entry.error);
      await delay(250 * attempt);
    }
  }
}
module.exports = { OllamaClient };
