const { OllamaClient } = require('../lib/ollama');
const { loadTokenizer, renderPrompt } = require('../lib/tokenizer');
const { createRun } = require('../lib/artifacts');

async function main() {
  const config = { host: 'http://127.0.0.1:11434', model: 'town-qwen', embedding: 'mxbai-embed-large' };
  const run = createRun('model-check', config);
  console.log(`记录目录：${run.directory}`);
  const client = new OllamaClient({ record: record => run.append('calls.jsonl', record) });
  try {
    const tokenizer = loadTokenizer();
    run.manifest.tokenizer = tokenizer.metadata;
    run.manifest.ollama = await client.info('/api/version');
    const tags = await client.info('/api/tags');
    run.manifest.models = tags.models.filter(m => [config.model, `${config.model}:latest`,
      config.embedding, `${config.embedding}:latest`].includes(m.name));
    if (run.manifest.models.length !== 2) throw new Error('需要先下载两个模型并创建 town-qwen');
    const show = await client.info('/api/show', { model: config.model });
    run.write('model-show.json', show);
    const checks = [];
    for (const context of [8192, 4096]) {
      const prompt = renderPrompt([{ role: 'user', content: '用中文回答：咖啡店几点开门？已知：咖啡店08:00开门。只回答时间。' }]);
      const inputTokens = tokenizer.count(prompt);
      const { result } = await client.request('/api/generate', {
        model: config.model, prompt, raw: true, keep_alive: '30m',
        options: { num_ctx: context, num_predict: 32, temperature: 0, seed: 42 },
      }, { worldId: 'preflight', agentId: 'single-agent', purpose: 'calibration' });
      const ps = await client.info('/api/ps');
      const loaded = ps.models.find(m => m.name === config.model || m.name === `${config.model}:latest`);
      const check = { context, inputTokens, measuredTokens: result.prompt_eval_count,
        loadedContext: loaded?.context_length ?? null, response: result.response,
        passed: inputTokens === result.prompt_eval_count && loaded?.context_length === context
          && result.done_reason !== 'length' && Boolean(result.response?.trim()) };
      checks.push(check);
      run.write('generation-checks.json', checks);
      if (!check.passed) throw new Error(`窗口或分词校准失败：${JSON.stringify(check)}`);
    }
    const { result: compatibleChat } = await client.request('/v1/chat/completions', {
      model: config.model, messages: [{ role: 'user', content: '用一句中文向小镇邻居问好。' }],
      max_tokens: 64, temperature: 0,
    }, { worldId: 'preflight', agentId: 'single-agent', purpose: 'ai_town_chat_compatibility' });
    if (!compatibleChat.choices?.[0]?.message?.content?.trim()
      || compatibleChat.choices[0].finish_reason !== 'stop') throw new Error('AI Town 聊天兼容接口验证失败');
    run.write('compatible-chat.json', compatibleChat);
    const { result: embedding } = await client.request('/api/embed', {
      model: config.embedding, input: '咖啡店每天早上八点开门。', truncate: false,
    }, { worldId: 'preflight', agentId: 'single-agent', purpose: 'embedding' });
    const dimension = embedding.embeddings?.[0]?.length;
    if (dimension !== 1024) throw new Error(`向量维度错误：${dimension}`);
    run.write('summary.json', { passed: true, checks, chatCompatibility: true, embeddingDimensions: dimension });
    run.finish('completed', { passed: true });
    console.log('接口、4K/8K 实际窗口与 tokenizer 校准通过；向量维度 1024。');
  } catch (error) {
    run.finish('failed', { passed: false, error: error.message });
    throw error;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
