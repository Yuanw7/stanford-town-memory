const { datedEvidence } = require('./temporal-evidence');
function referenceEvidence(conversation) { return datedEvidence(conversation).candidates.map((e, i) => ({ ...e, id: `e${i}` })); }
function referenceMessages(conversation, limit) {
  return [{ role: 'system', content: `Select informative source evidence, including current updates and historical assertions, without repeating evidence. Return JSON {"facts":{"evidence ID":{"subject":"entity","predicate":"property"}},"commitments":[]}. At most ${limit} facts plus commitments total. Use consistent predicate keys such as opening_time. Server supplies fact value, quote, validity and source from the chosen evidence; do not generate those fields. No facts for greetings or bare acceptance. Commitment schema: {"kind":"commitment","actor":"speaker agent ID","action":"deliver","item":"literal item description","recipient":"participant agent ID","dueAt":"UTC ISO timestamp","sourceEventIds":["acceptance message ID"],"quote":"exact affirmative first-person delivery sentence"}. Only the actual speaker's explicit affirmative acceptance creates a commitment. A prohibition or request is not a commitment. Each commitment item must appear in its own affirmative quote. Return empty facts/commitments when no evidence supports records.` },
  { role: 'user', content: JSON.stringify({ conversation, evidence: referenceEvidence(conversation) }) }];
}
function expandReferences(payload, conversation) {
  if (!payload || Object.keys(payload).some(k => !['facts', 'commitments'].includes(k)) || !payload.facts
      || typeof payload.facts !== 'object' || Array.isArray(payload.facts) || !Array.isArray(payload.commitments)) throw new Error('invalid_reference_extraction');
  const evidence = referenceEvidence(conversation);
  const facts = Object.entries(payload.facts).map(([id, fact]) => {
    const e = evidence.find(e => e.id === id);
    if (!e || !fact || Object.keys(fact).some(k => !['subject', 'predicate'].includes(k))) throw new Error('invalid_fact_evidence_reference');
    return { kind: 'fact', subject: fact.subject, predicate: fact.predicate, value: e.quote, quote: e.quote,
      validFrom: e.validFrom, validUntil: e.validUntil, replacesPrior: e.replacesPrior, sourceEventIds: [e.sourceEventId] };
  });
  return { records: [...facts, ...structuredClone(payload.commitments)] };
}
module.exports = { referenceEvidence, referenceMessages, expandReferences };
