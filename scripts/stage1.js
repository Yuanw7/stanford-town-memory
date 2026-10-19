// 等待已下载的模型；不自动拉取、不启动服务、不修改评估题集。
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { OllamaClient } = require('../lib/ollama');
const { loadTokenizer } = require('../lib/tokenizer');
const { root } = require('../lib/artifacts');
const execute = promisify(execFile);

async function step(name, executable, args) {
  console.log(`开始：${name}`);
  try {
    const result = await execute(executable, args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    throw new Error(`${name} 未通过：${error.stderr || error.message}`);
  }
}
async function main() {
  loadTokenizer();
  const client = new OllamaClient();
  const deadline = Date.now() + 30 * 60 * 1000;
  let waits = 0;
  while (true) {
    const tags = await client.info('/api/tags');
    const names = new Set(tags.models.map(m => m.name));
    if (names.has('qwen2.5:7b') && names.has('mxbai-embed-large:latest')) break;
    if (Date.now() >= deadline) throw new Error('等待模型下载超时；下载可以继续，重新运行本命令即可');
    if (waits++ % 6 === 0) console.log('等待 Qwen2.5 7B 与 embedding 下载完成……');
    await delay(5000);
  }
  await step('创建固定 8K 模型', 'ollama', ['create', 'town-qwen', '-f', 'models/Modelfile']);
  await step('窗口、接口和向量校准', process.execPath, ['scripts/model-check.js']);
  await step('20 道开发题×3', process.execPath, ['scripts/model-pilot.js', '--config', 'configs/model-pilot.development.json']);
  await step('50 道冻结验收题×3', process.execPath, ['scripts/model-pilot.js']);
  console.log('技术诊断通过。完整 P1 验收仍需题集独立人工审核，证据见 artifacts/local。');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
