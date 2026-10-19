const { timestamp } = require('./tiered-store');
const { calendarDates } = require('./calendar-dates');
function mentionedDates(text) {
  return calendarDates(text);
}
function parsePlan(text, question, nowMs) {
  const plan = JSON.parse(text);
  if (!plan || Object.keys(plan).some(k => !['asOfDate', 'focus'].includes(k))
      || !['fact', 'commitment', 'any'].includes(plan.focus)
      || plan.asOfDate !== null && (typeof plan.asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(plan.asOfDate)
        || !mentionedDates(question).has(plan.asOfDate))) throw new Error('invalid_or_ungrounded_query_plan');
  const dateMs = timestamp(plan.asOfDate);
  if (dateMs !== null && dateMs > nowMs) throw new Error('future_query_not_supported');
  return { ...plan, asOfMs: dateMs === null ? nowMs : Math.min(nowMs, dateMs + 86400000 - 1) };
}
function deterministicPlan(text, nowMs) {
  const dates = [...mentionedDates(text)];
  if (dates.length > 1) throw new Error('ambiguous_query_dates');
  // Only explicit acceptance/promise language narrows the kind. Otherwise keep
  // both kinds; no question IDs, dataset labels or evaluator answers are used.
  const promise = /\b(?:promise[ds]?|commitments?|accept(?:ed)?)\b|承诺|答应|接受/.test(text.toLowerCase());
  const negation = /\b(?:allowed|prohibited|forbidden|not|never)\b|不|禁止|允许/.test(text.toLowerCase());
  return { ...parsePlan(JSON.stringify({ asOfDate: dates[0] ?? null, focus: promise && !negation ? 'commitment' : 'any' }), text, nowMs), planner: 'deterministic_any_v1' };
}
module.exports = { mentionedDates, parsePlan, deterministicPlan };
