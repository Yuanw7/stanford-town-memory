async function checkTownServices({ minimumRemainingMs = 0, fetchImpl = fetch } = {}) {
  const request = async endpoint => {
    const response = await fetchImpl(`http://127.0.0.1:11435${endpoint}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`service_unavailable:${endpoint}:${response.status}`);
    return response.json();
  };
  const gateway = await request('/health');
  if (!gateway || (gateway.remainingMs !== null
      && (!Number.isFinite(gateway.remainingMs) || gateway.remainingMs < 0))) {
    throw new Error('gateway_invalid_health');
  }
  if (gateway.admissionOpen !== true) throw new Error('gateway_budget_exhausted');
  if (gateway.remainingMs !== null && gateway.remainingMs < minimumRemainingMs) {
    throw new Error('gateway_insufficient_duration');
  }
  const ollama = await request('/api/version');
  if (typeof ollama.version !== 'string' || !ollama.version) throw new Error('ollama_invalid_version');
  return { at: new Date().toISOString(), gateway, ollamaVersion: ollama.version };
}
module.exports = { checkTownServices };
