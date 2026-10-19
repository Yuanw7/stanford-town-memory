const normalize = value => value.normalize('NFKC').trim().toLowerCase();
function gradeAnswer(text, acceptedAnswers) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.answer !== 'string' || Object.keys(parsed).some(key => key !== 'answer')) {
      return { correct: false, valid: false, answer: null, reason: 'invalid_structure' };
    }
    return { correct: acceptedAnswers.some(a => normalize(a) === normalize(parsed.answer)),
      valid: true, answer: parsed.answer, reason: null };
  } catch { return { correct: false, valid: false, answer: null, reason: 'invalid_json' }; }
}
function evaluate(rows, expectedPerCategory, repetitions) {
  const categories = ['fact', 'update', 'relationship', 'commitment', 'unanswerable'];
  const byCategory = Object.fromEntries(categories.map(category => {
    const items = rows.filter(r => r.category === category);
    const expected = expectedPerCategory * repetitions;
    return [category, { expected, observed: items.length, correct: items.filter(r => r.correct).length,
      accuracy: items.filter(r => r.correct).length / expected }];
  }));
  const expected = expectedPerCategory * repetitions * categories.length;
  const accuracy = rows.filter(r => r.correct).length / expected;
  const complete = rows.length === expected && Object.values(byCategory).every(c => c.observed === c.expected);
  return { expected, observed: rows.length, accuracy, byCategory, complete,
    qualityGatePassed: complete && accuracy >= 0.9 && Object.values(byCategory).every(c => c.accuracy >= 0.8) };
}
module.exports = { gradeAnswer, evaluate };
