const http = require('node:http');
const { randomUUID } = require('node:crypto');

class Queue {
  constructor(limit = 1) { this.limit = limit; this.active = 0; this.waiting = []; }
  acquire(signal) {
    if (signal.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      const job = { resolve, reject, signal };
      const abort = () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error('cancelled'));
      };
      job.abort = abort;
      if (this.active < this.limit) { this.active++; resolve(); }
      else { signal.addEventListener('abort', abort, { once: true }); this.waiting.push(job); }
    });
  }
  release() {
    this.active--;
    while (this.waiting.length) {
      const job = this.waiting.shift();
      job.signal.removeEventListener('abort', job.abort);
      if (job.signal.aborted) { job.reject(new Error('cancelled')); continue; }
      this.active++; job.resolve(); break;
    }
  }
}

function captureUsage(payload) {
  const input = payload.prompt_eval_count ?? payload.usage?.prompt_tokens;
  const output = payload.eval_count ?? payload.usage?.completion_tokens;
  return { inputTokens: Number.isInteger(input) ? input : null,
    outputTokens: Number.isInteger(output) ? output : null,
    serviceDurationMs: Number.isFinite(payload.total_duration) ? payload.total_duration / 1e6 : null };
}

function createGateway({ fetchImpl = fetch, record = () => {}, event = () => {},
  maxActive = 1, maxCalls = 2000, deadline = Infinity, timeoutMs = 120000,
  upstream = 'http://127.0.0.1:11434' } = {}) {
  const url = new URL(upstream);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.port !== '11434') {
    throw new Error('计量网关只能转发到本机 Ollama:11434');
  }
  const queue = new Queue(maxActive);
  let forwarded = 0;
  const allowed = new Set(['/v1/chat/completions', '/api/generate', '/api/embed', '/api/embeddings']);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && ['/api/tags', '/api/version', '/api/ps'].includes(req.url)) {
      try {
        const response = await fetchImpl(url.origin + req.url, { signal: AbortSignal.timeout(5000) });
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(await response.json()));
      } catch { res.writeHead(502); res.end('{"error":"info_unavailable"}'); }
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      const remainingMs = Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : null;
      res.end(JSON.stringify({ active: queue.active, queued: queue.waiting.length, forwarded, maxCalls,
        remainingMs, admissionOpen: forwarded < maxCalls && (remainingMs === null || remainingMs > 0) }));
      return;
    }
    if (req.method !== 'POST' || !allowed.has(req.url)) { res.writeHead(404); res.end(); return; }
    const started = performance.now();
    const entry = { requestId: randomUUID(), logicalCallId: req.headers['x-town-call-id'] ?? null,
      attempt: Number(req.headers['x-town-attempt'] ?? 1), endpoint: req.url, model: null,
      startedAt: new Date().toISOString(), status: 'failed', inputTokens: null, outputTokens: null,
      usageStatus: 'unknown', queueMs: 0, proxyForwardMs: null, serviceDurationMs: null };
    const controller = new AbortController();
    let acquired = false, terminal = false, timeout;
    const final = status => {
      if (terminal) return;
      terminal = true; entry.status = status; entry.endToEndMs = performance.now() - started;
      entry.endedAt = new Date().toISOString(); record(entry);
    };
    const fail = (status, error, code = 502) => {
      entry.error = error; final(status);
      if (!res.destroyed && !res.headersSent) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error })); }
      else if (!res.destroyed) res.destroy();
    };
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const scope = JSON.parse(decodeURIComponent(String(req.headers['x-town-scope'] ?? '')));
      for (const key of ['experimentId', 'worldId', 'agentId', 'purpose']) {
        if (typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 200) throw new Error('invalid_scope');
      }
      if (!entry.logicalCallId || !Number.isInteger(entry.attempt) || entry.attempt < 1) throw new Error('invalid_call_id');
      for (const key of ['experimentId', 'worldId', 'agentId', 'purpose']) entry[key] = scope[key];
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('request_too_large');
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof payload.model !== 'string') throw new Error('invalid_model');
      entry.model = payload.model;
      event({ ...entry, type: 'admitted' });
      timeout = setTimeout(() => controller.abort(new Error('timeout')), Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
      await queue.acquire(controller.signal); acquired = true;
      entry.queueMs = performance.now() - started;
      if (forwarded >= maxCalls || Date.now() >= deadline) { fail('budget_exhausted', 'budget_exhausted', 429); return; }
      forwarded++;
      let endpoint = req.url;
      const legacyEmbedding = endpoint === '/api/embeddings';
      let body = payload;
      if (legacyEmbedding) {
        endpoint = '/api/embed'; body = { model: payload.model, input: payload.prompt, truncate: false };
      } else if (payload.stream && endpoint === '/v1/chat/completions') {
        body = { ...payload, stream_options: { ...payload.stream_options, include_usage: true } };
      }
      const forwardStart = performance.now();
      const response = await fetchImpl(url.origin + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      entry.upstreamStatus = response.status;
      if (!response.ok) { fail('failed', `upstream_http_${response.status}`, response.status); return; }
      const streaming = Boolean(body.stream);
      if (!streaming) {
        const data = await response.json();
        Object.assign(entry, captureUsage(data));
        if (data.error) throw new Error('upstream_error');
        const result = legacyEmbedding ? { embedding: data.embeddings?.[0] } : data;
        if (legacyEmbedding && !Array.isArray(result.embedding)) throw new Error('invalid_embedding');
        entry.usageStatus = entry.inputTokens === null
          || (!endpoint.includes('embed') && entry.outputTokens === null) ? 'unknown' : 'measured';
        entry.proxyForwardMs = performance.now() - forwardStart;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); final('succeeded');
      } else {
        const sse = endpoint.startsWith('/v1');
        res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/x-ndjson' });
        const decoder = new TextDecoder(); let buffer = '', ended = false;
        const consume = line => {
          line = line.trim();
          if (!line || (sse && !line.startsWith('data:'))) return;
          if (sse) line = line.slice(5).trim();
          if (line === '[DONE]') { ended = true; return; }
          const data = JSON.parse(line);
          if (data.error) throw new Error('upstream_stream_error');
          if (data.usage || data.done) {
            Object.assign(entry, captureUsage(data));
            if (data.done) ended = true;
          }
        };
        for await (const chunk of response.body) {
          res.write(chunk); buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(consume);
        }
        buffer += decoder.decode(); consume(buffer);
        if (!ended) throw new Error('stream_missing_terminal');
        entry.usageStatus = entry.inputTokens !== null && entry.outputTokens !== null ? 'measured' : 'unknown';
        entry.proxyForwardMs = performance.now() - forwardStart; res.end(); final('succeeded');
      }
    } catch (error) {
      if (!acquired) entry.queueMs = performance.now() - started;
      const cancelled = controller.signal.aborted;
      fail(cancelled ? (controller.signal.reason?.message === 'timeout' ? 'timeout' : 'cancelled') : 'failed',
        cancelled ? 'request_aborted' : error.message, 400);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (acquired) queue.release();
    }
  });
  return server;
}
module.exports = { createGateway, captureUsage, Queue };
