const { scopeKey } = require('./memory-store');
const { validateConversation, fingerprint } = require('./conversations-v2');
const normalize = s => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
function timestamp(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) throw new Error('invalid_claim_time');
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('invalid_claim_time');
  return ms;
}
function validateExtraction(payload, conversation) {
  if (!payload || Object.keys(payload).some(k => k !== 'records') || !Array.isArray(payload.records) || payload.records.length > 8) throw new Error('invalid_extraction_schema');
  return payload.records.map(row => {
    if (!row || !['fact', 'commitment'].includes(row.kind) || !Array.isArray(row.sourceEventIds) || !row.sourceEventIds.length
        || new Set(row.sourceEventIds).size !== row.sourceEventIds.length || typeof row.quote !== 'string' || row.quote.trim().length < 5) throw new Error('invalid_claim_sources');
    const sources = row.sourceEventIds.map(id => {
      const source = conversation.messages.find(m => m.id === id); if (!source) throw new Error('source_not_observed'); return source;
    });
    if (!sources.some(m => normalize(m.text).includes(normalize(row.quote)))) throw new Error('quote_not_in_source');
    if (row.kind === 'fact') {
      if (Object.keys(row).some(k => !['kind', 'subject', 'predicate', 'value', 'validFrom', 'validUntil', 'replacesPrior', 'sourceEventIds', 'quote'].includes(k))
          || !['subject', 'predicate', 'value'].every(k => typeof row[k] === 'string' && row[k].trim() && row[k].length <= 300)
          || typeof row.replacesPrior !== 'boolean') throw new Error('invalid_fact_schema');
      if (!normalize(row.quote).includes(normalize(row.value))) throw new Error('fact_value_not_in_quote');
      const from = timestamp(row.validFrom), until = timestamp(row.validUntil);
      if (until !== null && from !== null && until <= from || row.replacesPrior && from === null) throw new Error('invalid_fact_interval');
      return { ...structuredClone(row), validFromMs: from, validUntilMs: until,
        key: JSON.stringify([normalize(row.subject), normalize(row.predicate)]) };
    }
    if (Object.keys(row).some(k => !['kind', 'actor', 'action', 'item', 'recipient', 'dueAt', 'sourceEventIds', 'quote'].includes(k))
        || row.action !== 'deliver' || typeof row.item !== 'string' || !row.item.trim() || row.item.length > 100) throw new Error('invalid_commitment_schema');
    const person = value => conversation.participants.find(p => p.agentId === value || normalize(p.name) === normalize(String(value)));
    const actor = person(row.actor), recipient = person(row.recipient), dueAtMs = timestamp(row.dueAt);
    if (!actor || !recipient || dueAtMs === null || dueAtMs < Math.max(...sources.map(m => m.atMs))
        || !sources.some(m => m.authorAgentId === actor.agentId && normalize(m.text).includes(normalize(row.quote))
          && /\bI (?:accept|will|promise|agree)\b|我(?:接受|同意|承诺|会)/i.test(row.quote))) throw new Error('unverified_explicit_acceptance');
    const acceptedItem = row.quote.split(/(?<=[.!?。！？])\s+/).some(sentence =>
      normalize(sentence).includes(normalize(row.item))
      && /\bI (?:accept|will|promise|agree)\b|我(?:接受|同意|承诺|会)/i.test(sentence)
      && /\bdeliver\b|投递|交付|送/i.test(sentence)
      && !/\b(?:not|never|don't|won't|cannot)\b|不|禁止|不得/i.test(sentence));
    if (!acceptedItem) throw new Error('unverified_affirmative_delivery_item');
    return { ...structuredClone(row), actorAgentId: actor.agentId, recipientAgentId: recipient.agentId, dueAtMs,
      itemId: normalize(row.item).replace(/\s+/g, '_'), key: JSON.stringify([actor.agentId, normalize(row.item), recipient.agentId, dueAtMs]) };
  });
}
class TieredStore {
  constructor({ dimensions, embeddingVersion, snapshot } = {}) {
    if (!Number.isInteger(dimensions) || dimensions < 1 || typeof embeddingVersion !== 'string' || !embeddingVersion) throw new Error('invalid_tiered_identity');
    Object.assign(this, { dimensions, embeddingVersion }); this.transactions = []; this.operations = new Map(); this.receipts = [];
    if (snapshot) {
      if (snapshot.schemaVersion !== 1 || snapshot.kind !== 'tiered' || snapshot.dimensions !== dimensions
          || snapshot.embeddingVersion !== embeddingVersion || !Array.isArray(snapshot.transactions)) throw new Error('tiered_snapshot_mismatch');
      for (const tx of snapshot.transactions) this.commit(tx);
      if (!Array.isArray(snapshot.receipts)) throw new Error('invalid_tiered_receipt_snapshot');
      for (const r of snapshot.receipts) this.complete(r.scope, r.recordId, r.receipt);
    }
  }
  operation(scope, id) { return this.operations.get(JSON.stringify([scopeKey(scope), id])); }
  records(scope) { const key = scopeKey(scope); return structuredClone(this.transactions.filter(t => scopeKey(t.scope) === key).flatMap(t => t.records)); }
  archives(scope) { const key = scopeKey(scope); return structuredClone(this.transactions.filter(t => scopeKey(t.scope) === key).map(t => t.conversation)); }
  commit({ scope, conversation, records }) {
    scopeKey(scope); const c = validateConversation(conversation);
    if (scope.worldId !== c.worldId || !c.observedBy.includes(scope.agentId) || !Array.isArray(records)) throw new Error('tiered_scope_mismatch');
    const previous = this.operation(scope, c.id), inputFingerprint = fingerprint(c);
    const transaction = structuredClone({ scope, conversation: c, records }), digest = fingerprint(transaction);
    if (previous) { if (previous.digest !== digest) throw new Error('tiered_operation_conflict'); return { inserted: false }; }
    const derived = records.map(r => { const { id, embedding, ...claim } = r; return claim; });
    const stripped = derived.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !['validFromMs', 'validUntilMs', 'key', 'actorAgentId', 'recipientAgentId', 'dueAtMs', 'itemId', 'observedAtMs'].includes(k))));
    const validated = validateExtraction({ records: stripped }, c);
    const ids = new Set(this.records(scope).map(r => r.id));
    for (const [i, r] of records.entries()) {
      if (typeof r.id !== 'string' || !r.id || ids.has(r.id) || !Array.isArray(r.embedding)
          || r.embedding.length !== this.dimensions || !r.embedding.every(Number.isFinite)
          || fingerprint(derived[i]) !== fingerprint({ ...validated[i], observedAtMs: c.messages.at(-1).atMs })) throw new Error('invalid_tiered_record');
      ids.add(r.id);
    }
    this.transactions.push(transaction); this.operations.set(JSON.stringify([scopeKey(scope), c.id]), { digest, inputFingerprint });
    return { inserted: true, count: records.length };
  }
  materialize(scope, { nowMs, asOfMs = nowMs } = {}) {
    if (![nowMs, asOfMs].every(t => Number.isSafeInteger(t) && t >= 0) || asOfMs > nowMs) throw new Error('unsupported_future_or_invalid_query_time');
    const all = this.records(scope).filter(r => r.observedAtMs <= nowMs), result = [];
    for (const r of all) {
      if (r.kind === 'commitment') {
        const completed = this.receipts.find(t => scopeKey(t.scope) === scopeKey(scope)
          && (t.recordId === r.id || all.find(s => s.id === t.recordId)?.key === r.key) && t.receipt.atMs <= asOfMs);
        if (r.observedAtMs <= asOfMs) result.push({ ...r, status: completed ? completed.receipt.atMs <= r.dueAtMs ? 'completed_on_time' : 'completed_late'
          : r.dueAtMs < asOfMs ? 'overdue_pending' : 'pending', completionEventId: completed?.receipt.actionId ?? null });
        continue;
      }
      let until = r.validUntilMs;
      if (r.validFromMs !== null) for (const newer of all) {
        if (newer.kind === 'fact' && newer.key === r.key && newer.replacesPrior && newer.validFromMs > r.validFromMs
            && normalize(newer.value) !== normalize(r.value) && (until === null || newer.validFromMs < until)) until = newer.validFromMs;
      }
      if ((r.validFromMs === null || r.validFromMs <= asOfMs) && (until === null || asOfMs < until)) result.push({ ...r, effectiveUntilMs: until });
    }
    // Ambiguous concurrent assertions remain visible; do not silently choose a winner.
    return result.map(r => ({ ...r, conflict: r.kind === 'fact' && result.some(s => s.kind === 'fact' && s.key === r.key && normalize(s.value) !== normalize(r.value)) }));
  }
  complete(scope, recordId, receipt) {
    const record = this.records(scope).find(r => r.id === recordId);
    if (!record || record.kind !== 'commitment' || record.actorAgentId !== scope.agentId
        || !receipt || scopeKey(receipt.scope) !== scopeKey(scope) || typeof receipt.actionId !== 'string' || !receipt.actionId
        || !Number.isSafeInteger(receipt.atMs) || receipt.atMs < record.observedAtMs || receipt.action?.action !== 'deliver'
        || receipt.action.itemId !== record.itemId || receipt.action.recipientId !== record.recipientAgentId) throw new Error('receipt_does_not_fulfill_commitment');
    const entry = structuredClone({ scope, recordId, receipt });
    const previous = this.receipts.find(r => scopeKey(r.scope) === scopeKey(scope) && (r.recordId === recordId || r.receipt.actionId === receipt.actionId));
    if (previous) { if (fingerprint(previous) !== fingerprint(entry)) throw new Error('receipt_conflict'); return { inserted: false }; }
    this.receipts.push(entry); return { inserted: true };
  }
  snapshot() { return structuredClone({ schemaVersion: 1, kind: 'tiered', dimensions: this.dimensions,
    embeddingVersion: this.embeddingVersion, transactions: this.transactions, receipts: this.receipts }); }
}
module.exports = { TieredStore, validateExtraction, timestamp, normalize };
