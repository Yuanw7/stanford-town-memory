const { gradeAnswer } = require('./evaluate');
const normalize = text => text.normalize('NFKC').trim().toLowerCase();
function evaluateComparison({ workload, config, manifest, predictions, truth }) {
  const questions = new Map(workload.queries.map(q => [q.id, q])), answers = new Map();
  for (const row of truth) {
    const q = questions.get(row.id);
    if (!q || answers.has(row.id) || !Array.isArray(row.acceptedAnswers) || !row.acceptedAnswers.length
        || row.acceptedAnswers.some(a => typeof a !== 'string' || !a.trim()) || !Array.isArray(row.sourceEventIds)
        || (q.category !== 'unanswerable' && !row.sourceEventIds.length)) throw new Error('invalid_truth_or_missing_sources');
    const visible = new Set(workload.conversations.filter(c => c.worldId === q.worldId && c.observedBy.includes(q.agentId)).flatMap(c => c.messages.map(m => m.id)));
    if (row.sourceEventIds.some(id => !visible.has(id))) throw new Error('truth_source_not_visible');
    if ('contradictionAnswers' in row && (!Array.isArray(row.contradictionAnswers)
        || row.contradictionAnswers.some(a => typeof a !== 'string' || !a.trim()
          || row.acceptedAnswers.some(b => normalize(a) === normalize(b))))) throw new Error('invalid_contradiction_annotations');
    answers.set(row.id, row);
  }
  if (answers.size !== questions.size) throw new Error('truth_question_mismatch');
  const variants = config.variants.map(v => v.id), seen = new Set();
  const rows = predictions.map(p => {
    const key = JSON.stringify([p.repetition, p.strategy, p.queryId]);
    if (!Number.isInteger(p.repetition) || p.repetition < 1 || p.repetition > config.repetitions
        || !variants.includes(p.strategy) || !questions.has(p.queryId) || seen.has(key)) throw new Error('invalid_or_duplicate_prediction');
    seen.add(key);
    const grade = p.status === 'succeeded' ? gradeAnswer(p.response, answers.get(p.queryId).acceptedAnswers)
      : { correct: false, valid: false, answer: null, reason: p.status ?? 'missing_status' };
    const truth = answers.get(p.queryId), annotated = Array.isArray(truth.contradictionAnswers);
    const contradiction = !annotated || !grade.valid ? null : grade.correct || ['未知', 'unknown'].includes(normalize(grade.answer)) ? false
      : truth.contradictionAnswers.some(a => normalize(a) === normalize(grade.answer)) ? true : null;
    return { repetition: p.repetition, strategy: p.strategy, queryId: p.queryId, category: questions.get(p.queryId).category,
      ...grade, contradictionAnnotated: annotated, contradiction };
  });
  const stats = (items, expected) => ({ expected, observed: items.length, correct: items.filter(r => r.correct).length,
    accuracy: expected ? items.filter(r => r.correct).length / expected : null, missing: expected - items.length });
  const byVariant = Object.fromEntries(variants.map(strategy => {
    const selected = rows.filter(r => r.strategy === strategy);
    const expectedContradictions = workload.queries.filter(q => Array.isArray(answers.get(q.id).contradictionAnswers)).length * config.repetitions;
    const assessed = selected.filter(r => r.contradictionAnnotated && r.contradiction !== null);
    const contradictions = assessed.filter(r => r.contradiction === true).length;
    const unknownQuestions = workload.queries.filter(q => q.category === 'unanswerable').length * config.repetitions;
    return [strategy, { ...stats(selected, questions.size * config.repetitions),
      contradictions: { expectedAnnotated: expectedContradictions, assessed: assessed.length, confirmed: contradictions,
        unassessed: expectedContradictions - assessed.length,
        rateAmongAssessed: assessed.length ? contradictions / assessed.length : null,
        lowerBoundRate: expectedContradictions ? contradictions / expectedContradictions : null },
      unanswerable: { expected: unknownQuestions, unsupportedValidAnswers: selected.filter(r => r.category === 'unanswerable' && r.valid && !r.correct).length },
      byCategory: Object.fromEntries([...new Set(workload.queries.map(q => q.category))].map(category => [category,
        stats(selected.filter(r => r.category === category), workload.queries.filter(q => q.category === category).length * config.repetitions)])),
      byRepetition: Array.from({ length: config.repetitions }, (_, i) => ({ repetition: i + 1, ...stats(selected.filter(r => r.repetition === i + 1), questions.size) })) }];
  }));
  return { diagnosticOnly: true, runCompleted: manifest.status === 'completed', distinctQuestions: questions.size,
    repetitions: config.repetitions, byVariant, rows,
    complete: manifest.status === 'completed' && rows.length === questions.size * variants.length * config.repetitions,
    formalQualityAccepted: false, limitation: 'Development QA; contradictions only for predeclared exact counteranswers, with coverage. No human review or actual task-completion gate.' };
}
module.exports = { evaluateComparison };
