const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const requiredFiles = [
  'README.md', 'MISSION.md', 'ROADMAP.md', 'SKILLS.md', 'AGENTS.md',
  'docs/ARCHITECTURE.md', 'docs/MEMORY_PROTOCOL.md',
  'docs/EXPERIMENTS.md', 'docs/RISKS.md', 'docs/LOCAL_SETUP.md',
  'docs/DECISIONS.md', 'configs/experiment.example.json',
  'experiments/README.md', 'models/Modelfile', 'configs/ai-town.env.example',
  'configs/model-pilot.json', 'scripts/model-check.js', 'scripts/model-pilot.js',
];

function validateConfig(config, { formal = false } = {}) {
  const errors = [];
  const integer = (value, min, name) => {
    if (!Number.isInteger(value) || value < min) errors.push(`${name} 必须是 >= ${min} 的整数`);
  };
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['配置必须是 JSON 对象'];
  }
  if (config.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!['draft', 'ready'].includes(config.status)) errors.push('status 必须为 draft 或 ready');
  if (formal && config.status !== 'ready') errors.push('正式验收配置必须为 ready');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.experimentId ?? '')) {
    errors.push('experimentId 只能使用小写字母、数字、下划线和短横线');
  }
  integer(config.population, 1, 'population');
  integer(config.repetitions, 3, 'repetitions');
  if (!['fixed_workload', 'town_live'].includes(config.mode)) errors.push('不支持的 mode');
  if (config.mode === 'fixed_workload' && !config.dataset?.path) errors.push('fixed_workload 需要 dataset.path');
  if (!config.dataset?.checksum || !config.initialState?.checksum) {
    errors.push('需要填写 dataset.checksum 和 initialState.checksum（未就绪可用 UNSET）');
  }
  for (const key of ['chat', 'embedding']) {
    if (!config.models?.[key]?.name) errors.push(`models.${key}.name 不能为空`);
    if (!config.models?.[key]?.digest) errors.push(`models.${key}.digest 不能为空`);
  }
  integer(config.models?.embedding?.dimensions, 1, 'models.embedding.dimensions');
  const budgets = config.budgets ?? {};
  for (const key of ['contextWindowTokens', 'maxInputTokens', 'maxOutputTokens',
    'memoryTokens', 'maxModelConcurrency', 'maxTotalCalls', 'wallTimeLimitSeconds']) {
    integer(budgets[key], 1, `budgets.${key}`);
  }
  if (budgets.maxInputTokens + budgets.maxOutputTokens > budgets.contextWindowTokens) {
    errors.push('输入预算 + 输出预算不能超过上下文窗口');
  }
  if (budgets.memoryTokens > budgets.maxInputTokens) errors.push('记忆预算不能超过总输入预算');
  const allowed = new Set(['baseline', 'budgeted_retrieval', 'tiered_memory']);
  if (!Array.isArray(config.variants) || config.variants.length < 2) {
    errors.push('variants 至少包含 baseline 和一个对照策略');
  } else {
    if (!config.variants.includes('baseline')) errors.push('variants 必须包含 baseline');
    if (new Set(config.variants).size !== config.variants.length) errors.push('variants 不能重复');
    if (config.variants.some(v => !allowed.has(v))) errors.push('variants 包含未知策略');
  }
  const quality = config.qualityGates ?? {};
  for (const key of ['maxRecallDropPercentagePoints', 'maxContradictionIncreasePercentagePoints',
    'maxCommitmentDropPercentagePoints']) {
    if (!Number.isFinite(quality[key]) || quality[key] < 0 || quality[key] > 100) {
      errors.push(`qualityGates.${key} 必须在 0～100 之间，单位为百分点`);
    }
  }
  if (formal) {
    for (const key of ['aiTownCommit', 'researchCommit']) {
      if (!/^[a-f0-9]{40}$/.test(config.versions?.[key] ?? '')) errors.push(`versions.${key} 需要真实 commit`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(config.versions?.convexImageDigest ?? '')) errors.push('需要 Convex 镜像 digest');
    if (!config.versions?.ollamaVersion || config.versions.ollamaVersion === 'UNSET') errors.push('需要 Ollama 版本');
    for (const key of ['chat', 'embedding']) {
      if (!/^(sha256:)?[a-f0-9]{64}$/.test(config.models?.[key]?.digest ?? '')) errors.push(`models.${key}.digest 无效`);
    }
    for (const key of ['dataset', 'initialState']) {
      if (!/^[a-f0-9]{64}$/.test(config[key]?.checksum ?? '')) errors.push(`${key}.checksum 需要 SHA256`);
      if (!config[key]?.path) errors.push(`${key}.path 不能为空`);
    }
    if (JSON.stringify(config).includes('UNSET')) errors.push('正式配置不能包含 UNSET');
  }
  return errors;
}

function checkConfig(file, formal = false) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const errors = validateConfig(config, { formal });
  if (errors.length) throw new Error(errors.join('\n'));
  if (formal) {
    const { hash } = require('./lib/artifacts');
    for (const key of ['dataset', 'initialState']) {
      const buffer = fs.readFileSync(path.resolve(root, config[key].path));
      if (hash(buffer) !== config[key].checksum) throw new Error(`${key} 文件与校验和不一致`);
    }
  }
  console.log(`配置结构检查通过：${path.relative(root, file)}`);
  console.log('仅检查关键字段及预算关系；不验证模型、数据集或仿真服务可用性。');
  if (JSON.stringify(config).includes('UNSET')) {
    console.log('状态：仍有 UNSET，采集真实模型摘要、数据集和版本信息后才能开展实验。');
  }
}

function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  const formal = args.includes('--formal');
  const paths = args.filter(arg => arg !== '--formal');
  const configPath = paths[0];
  if (paths.length > 1 || args.filter(arg => arg === '--formal').length > 1
    || (args.length && command !== 'check-config')) throw new Error('参数过多或不支持的参数');
  if (command === 'status') {
    console.log('斯坦福小镇 · Memory 实验基底');
    console.log('使命：在保留行为质量的条件下，比较记忆策略的上下文成本和可靠性。');
    console.log('当前阶段：P0 规范已同步；P1 模型诊断工具已实现，验收证据见 artifacts/local。');
    console.log('阅读：README.md → MISSION.md → ROADMAP.md');
    console.log('命令：npm run check / npm test / npm run model:check / npm run model:pilot');
  } else if (command === 'check') {
    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(root, file))) throw new Error(`缺少基础文件：${file}`);
    }
    console.log(`基础文件检查通过：${requiredFiles.length} 个文件`);
    checkConfig(path.join(root, 'configs/experiment.example.json'));
  } else if (command === 'check-config') {
    if (!configPath) throw new Error('用法：node index.js check-config <配置路径>');
    checkConfig(path.resolve(root, configPath), formal);
  } else {
    throw new Error(`未知命令：${command}。支持 status、check、check-config。`);
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`检查失败：${error.message}`); process.exitCode = 1; }
}
module.exports = { validateConfig };
