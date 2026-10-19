const fs = require('node:fs');
const path = require('node:path');
const { createRun, root } = require('../lib/artifacts');

function latest(kind, filter = () => true) {
  const directory = path.join(root, 'artifacts/local', kind);
  const entries = fs.readdirSync(directory).sort().reverse();
  for (const entry of entries) {
    const run = path.join(directory, entry);
    const manifest = JSON.parse(fs.readFileSync(path.join(run, 'manifest.json')));
    const config = JSON.parse(fs.readFileSync(path.join(run, 'config.json')));
    if (manifest.status === 'completed' && filter(config)) {
      return { run, manifest, config, summary: JSON.parse(fs.readFileSync(path.join(run, 'summary.json'))) };
    }
  }
  throw new Error(`没有完整的 ${kind} 结果`);
}
try {
  const check = latest('model-check');
  const development = latest('model-pilot', c => c.dataset.endsWith('pilot-development.jsonl'));
  const acceptance = latest('model-pilot', c => c.dataset.endsWith('pilot-acceptance.jsonl'));
  const digest = acceptance.manifest.model.digest;
  const digestMatched = development.manifest.model.digest === digest
    && check.manifest.models.some(m => m.digest === digest);
  const technicalPassed = check.summary.passed && development.summary.qualityGatePassed
    && acceptance.summary.qualityGatePassed && acceptance.summary.expected === 150
    && acceptance.manifest.loadedContext === 8192 && digestMatched;
  const run = createRun('stage1', { evidence: [check.run, development.run, acceptance.run] });
  const summary = {
    technicalPassed, stageAccepted: false, pending: ['独立人工审核合成题目与证据来源'],
    modelDigest: digest, datasetSha256: acceptance.manifest.datasetSha256,
    tokenizer: acceptance.manifest.tokenizer, embeddingDimensions: check.summary.embeddingDimensions,
    windows: check.summary.checks, developmentAccuracy: development.summary.accuracy,
    acceptanceAccuracy: acceptance.summary.accuracy, byCategory: acceptance.summary.byCategory,
    evidence: [check.run, development.run, acceptance.run],
  };
  run.write('summary.json', summary); run.finish('completed', { technicalPassed, stageAccepted: false });
  console.log(`汇总：${run.directory}`); console.log(JSON.stringify(summary, null, 2));
  if (!technicalPassed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
