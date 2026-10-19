const fs = require('node:fs');
const path = require('node:path');
const { root, hash } = require('../lib/artifacts');
const { validateMemoryWorkload } = require('../lib/memory-workload');
const { evaluateComparison } = require('../lib/comparison-evaluation');
const { archiveSourceOverlap } = require('../lib/archive-evaluation');
try {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('用法：npm run memory:compare:evaluate -- <run目录> <答案JSON文件>');
  const directory = path.resolve(root, args[0]), bytes = fs.readFileSync(path.join(directory, 'workload.json'));
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')));
  if (!['diagnostic_memory_comparison', 'diagnostic_policy_comparison'].includes(config.mode) || hash(bytes) !== config.dataset.sha256) throw new Error('workload_or_mode_mismatch');
  const workload = validateMemoryWorkload(JSON.parse(bytes));
  const answers = fs.readFileSync(path.resolve(root, args[1]));
  const file = path.join(directory, 'answers.jsonl');
  const predictions = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const evaluation = { ...evaluateComparison({ workload, config, predictions, truth: JSON.parse(answers),
    manifest: JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))) }), answersSha256: hash(answers) };
  if (config.variants.some(v => v.policy === 'archive_retrieval')) {
    const retrievalFile = path.join(directory, 'retrieval.jsonl'), snapshots = {};
    for (const v of config.variants.filter(v => v.policy === 'archive_retrieval')) for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const file = path.join(directory, `state-${repetition}-${v.id}.json`);
      snapshots[`${repetition}:${v.id}`] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
    }
    evaluation.archiveSourceOverlap = archiveSourceOverlap({ workload, config, manifest: JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'))),
      truth: JSON.parse(answers), retrieval: fs.existsSync(retrievalFile) ? fs.readFileSync(retrievalFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [], snapshots });
    evaluation.archiveSourceOverlapSourceSha256 = hash(fs.readFileSync(path.join(root, 'lib/archive-evaluation.js')));
    fs.copyFileSync(path.join(root, 'lib/archive-evaluation.js'), path.join(directory, `archive-evaluation-source-${evaluation.archiveSourceOverlapSourceSha256.slice(0, 12)}.js`));
  }
  evaluation.evaluatorSourceSha256 = hash(fs.readFileSync(__filename));
  const name = `evaluation-${hash(answers).slice(0, 12)}.json`;
  const target = path.join(directory, name), output = JSON.stringify(evaluation, null, 2) + '\n';
  if (fs.existsSync(target)) {
    const previous = fs.readFileSync(target);
    if (hash(previous) !== hash(output)) {
      const archive = path.join(directory, `evaluation-${hash(answers).slice(0, 12)}-revision-${hash(previous).slice(0, 12)}.json`);
      if (!fs.existsSync(archive)) fs.writeFileSync(archive, previous);
    }
  }
  fs.writeFileSync(target, output);
  fs.copyFileSync(__filename, path.join(directory, `evaluation-source-${evaluation.evaluatorSourceSha256.slice(0, 12)}.js`));
  console.log(JSON.stringify({ artifact: name, ...evaluation, rows: undefined }, null, 2));
  if (!evaluation.complete) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
