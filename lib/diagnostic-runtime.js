const fs = require('node:fs');
const path = require('node:path');
const { root } = require('./artifacts');
const { OllamaClient } = require('./ollama');
const { loadTokenizer, renderPrompt } = require('./tokenizer');
const { checkTownServices } = require('./service-health');
const { extractionSchema, sourceSentenceSchema, datedSentenceSchema, referenceSentenceSchema, queryPlanSchema } = require('./tiered-schema');
const { datedEvidence } = require('./temporal-evidence');
async function diagnosticRuntime(config, run, signal) {
  run.write('service-health.json', await checkTownServices({ minimumRemainingMs: config.wallTimeLimitSeconds * 1000 }));
  const calls = [];
  const client = new OllamaClient({ host: config.host, maxTotalCalls: config.maxTotalCalls,
    deadline: Date.now() + config.wallTimeLimitSeconds * 1000, signal,
    record: row => { calls.push(row); run.append('calls.jsonl', row); } });
  const tags = await client.info('/api/tags');
  for (const [name, digest] of [[config.model, config.modelDigest], [config.embeddingModel, config.embeddingDigest]]) {
    if (!tags.models.some(m => [name, `${name}:latest`].includes(m.name) && m.digest === digest)) throw new Error('model_digest_mismatch');
  }
  const tokenizer = loadTokenizer(); run.manifest.tokenizer = tokenizer.metadata;
  run.manifest.ollama = await client.info('/api/version'); run.write('manifest.json', run.manifest);
  const generate = async (messages, scope, outputTokens = config.maxOutputTokens) => {
    const prompt = renderPrompt(messages), inputTokens = tokenizer.count(prompt);
    if (inputTokens > config.maxInputTokens || outputTokens > config.maxOutputTokens) throw new Error('input_or_output_budget_exceeded');
    run.append('prompts.jsonl', { ...scope, messages, inputTokens, outputTokens });
    let extractionFormat;
    if (scope.purpose === 'tiered_extract') {
      const format = scope.extractionFormat ?? config.extractionFormat, c = JSON.parse(messages[1].content).conversation;
      extractionFormat = format === 'dated_reference_schema_v1' ? referenceSentenceSchema(c)
        : format === 'dated_sentence_schema_v1' ? datedSentenceSchema(c)
        : format === 'source_sentence_schema_v1' ? sourceSentenceSchema(c)
        : format === 'json_schema_v1' ? structuredClone(extractionSchema) : null;
      if (['dated_sentence_schema_v1', 'dated_reference_schema_v1'].includes(format)) run.append('extraction-evidence.jsonl', { ...scope, eventId: c.id, ...datedEvidence(c) });
      if (extractionFormat?.properties.records && config.maxExtractedRecords !== undefined) extractionFormat.properties.records.maxItems = config.maxExtractedRecords;
    }
    const { result, entry } = await client.request('/api/generate', { model: config.model, prompt, raw: true,
      ...(['memory_query', 'tiered_extract', 'tiered_query_plan'].includes(scope.purpose) ? {
        format: extractionFormat ?? (scope.purpose === 'tiered_query_plan' && config.queryPlanFormat === 'grounded_schema_v1'
          ? queryPlanSchema(messages.at(-1).content) : 'json'),
      } : {}),
      options: { num_ctx: config.contextWindowTokens, num_predict: outputTokens, temperature: config.temperature, seed: scope.seed ?? config.seed } }, scope);
    run.append('model-outputs.jsonl', { ...scope, response: result.response, logicalCallId: entry.logicalCallId });
    if (result.prompt_eval_count !== inputTokens) throw new Error('tokenizer_mismatch_or_truncation');
    if (result.done_reason === 'length' && !['importance', 'reflection_importance'].includes(scope.purpose)) throw new Error('output_truncated');
    if (!result.response?.trim()) throw new Error('empty_model_output');
    return result.response;
  };
  const embed = async (text, scope) => {
    const { result } = await client.request('/api/embed', { model: config.embeddingModel, input: text, truncate: false }, scope);
    const vector = result.embeddings?.[0];
    if (!Array.isArray(vector) || vector.length !== config.embeddingDimensions || !vector.every(Number.isFinite)) throw new Error('invalid_embedding');
    return vector;
  };
  const verifyMetering = () => {
    const base = path.join(root, 'artifacts/local/gateway');
    const records = fs.readdirSync(base).flatMap(dir => {
      const p = path.join(base, dir, 'calls.jsonl');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    });
    return calls.length > 0 && calls.every(call => {
      const rows = records.filter(r => r.logicalCallId === call.logicalCallId && r.attempt === call.attempt);
      return call.usageStatus === 'measured' && rows.length === 1
        && ['experimentId', 'worldId', 'agentId', 'purpose', 'inputTokens', 'outputTokens', 'status'].every(k => rows[0][k] === call[k]);
    });
  };
  return { calls, generate, embed, tokenizer, verifyMetering };
}
module.exports = { diagnosticRuntime };
