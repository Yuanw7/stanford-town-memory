const { calendarDates } = require('./calendar-dates');
function datedEvidence(conversation) {
  const candidates = [], excluded = [], referenceDate = new Date(conversation.createdAtMs).toISOString().slice(0, 10);
  for (const message of conversation.messages) for (const quote of new Set(message.text.split(/(?<=[.!?。！？])\s+/))) {
    if (quote.trim().length < 5 || quote.length > 300) { excluded.push({ sourceEventId: message.id, quote, reason: 'unsupported_sentence_length' }); continue; }
    let dates;
    try { dates = [...calendarDates(quote, { referenceDate, allowPartial: true, relativeToday: true })]; }
    catch { excluded.push({ sourceEventId: message.id, quote, reason: 'invalid_calendar_date' }); continue; }
    const times = new Set(quote.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) ?? []);
    if (dates.length > 1 || times.size > 1) { excluded.push({ sourceEventId: message.id, quote, reason: 'ambiguous_temporal_sentence' }); continue; }
    if (dates.length && /\b(?:by|until|before|after|deadline|due)\b|截至|之前|之后/.test(quote.toLowerCase())) {
      excluded.push({ sourceEventId: message.id, quote, reason: 'unsupported_validity_relation' }); continue;
    }
    const validFrom = dates[0] ?? null;
    const replacesPrior = validFrom !== null && /\b(?:update|now|changed|currently|effective)\b|更新|现在/.test(quote.toLowerCase())
      && !/\b(?:previous|formerly|was|historical)\b|以前|曾经/.test(quote.toLowerCase());
    candidates.push({ quote, sourceEventId: message.id, validFrom, validUntil: null, replacesPrior });
  }
  return { candidates, excluded };
}
function validateDatedFacts(claims, conversation) {
  const { candidates } = datedEvidence(conversation);
  for (const claim of claims.filter(c => c.kind === 'fact')) {
    if (!candidates.some(c => claim.sourceEventIds.length === 1 && claim.sourceEventIds[0] === c.sourceEventId
        && claim.quote === c.quote && claim.value === c.quote && claim.validFrom === c.validFrom
        && claim.validUntil === c.validUntil && claim.replacesPrior === c.replacesPrior)) throw new Error('fact_temporal_evidence_mismatch');
  }
}
module.exports = { datedEvidence, validateDatedFacts };
