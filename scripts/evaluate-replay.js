const fs = require('node:fs');
const path = require('node:path');
const { hash, root } = require('../lib/artifacts');
const { gradeAnswer, evaluate } = require('../lib/evaluate');
try {
  const [directory, answersPath, ...extra] = process.argv.slice(2);
  if (!directory || !answersPath || extra.length) throw new Error('用法：node scripts/evaluate-replay.js <run目录> <答案文件>');
  const target = path.resolve(root, directory);
  const config = JSON.parse(fs.readFileSync(path.join(target, 'config.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json')));
  const truthBytes = fs.readFileSync(path.resolve(root, answersPath));
  const truth = truthBytes.toString().trim().split('\n').map(JSON.parse);
  const predictions = fs.readFileSync(path.join(target, 'answers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const cases = fs.readFileSync(path.join(target, 'workload.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'query');
  if (new Set(truth.map(r => r.id)).size !== truth.length || truth.length !== cases.length) throw new Error('评估集 ID 或数量不匹配');
  const seen = new Set();
  const rows = predictions.map(p => {
    const key = `${p.repetition}:${p.queryId}`;
    if (seen.has(key) || !Number.isInteger(p.repetition) || p.repetition < 1 || p.repetition > config.repetitions) throw new Error('重复或非法预测');
    seen.add(key);
    const answer = truth.find(t => t.id === p.queryId);
    const item = cases.find(c => c.id === p.queryId);
    if (!answer || !item) throw new Error('预测与评估集不匹配');
    return { category: item.category, ...gradeAnswer(p.response, answer.acceptedAnswers), queryId: p.queryId, repetition: p.repetition };
  });
  const evaluation = { ...evaluate(rows, cases.length / 5, config.repetitions),
    runCompleted: manifest.status === 'completed', answersSha256: hash(truthBytes), diagnosticOnly: true };
  evaluation.qualityGatePassed = evaluation.qualityGatePassed && evaluation.runCompleted;
  fs.writeFileSync(path.join(target, 'evaluation.json'), JSON.stringify(evaluation, null, 2) + '\n');
  console.log(JSON.stringify(evaluation, null, 2));
  if (!evaluation.qualityGatePassed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
