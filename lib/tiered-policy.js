const { scopeKey } = require('./memory-store');
const { fingerprint, validateConversation } = require('./conversations-v2');
const { validateExtraction } = require('./tiered-store');
const { cosine } = require('./baseline-policy');
const { selectMemories } = require('./memory-retrieval');
const { parsePlan, deterministicPlan } = require('./query-plan');
const { validateDatedFacts } = require('./temporal-evidence');
const { referenceMessages, expandReferences } = require('./reference-extraction');
const { parseUniqueJson } = require('./unique-json');
function extractionMessages(c, maxExtractedRecords = 8) {
  return [{ role: 'system', content: `Extract source-grounded records, not a conversation summary. Return a JSON object {"records":[...]}, at most ${maxExtractedRecords} records. Do not repeat the same assertion or create multiple versions with guessed dates. Calendar dates establish validity from midnight UTC; opening hours are values, not validity timestamps. replacesPrior=true requires an explicit non-null validFrom and is never used on a historical restatement.
Fact schema: {"kind":"fact","subject":"entity","predicate":"property","value":"value including negation","validFrom":null,"validUntil":null,"replacesPrior":false,"sourceEventIds":["message ID"],"quote":"exact substring copied from a cited message"}.
Commitment schema: {"kind":"commitment","actor":"speaker agent ID","action":"deliver","item":"item description","recipient":"participant agent ID","dueAt":"YYYY-MM-DDTHH:mm:ssZ","sourceEventIds":["explicit acceptance message ID"],"quote":"exact first-person acceptance substring"}.
Use every field in the selected schema, including null validUntil and boolean replacesPrior for facts. Fact value MUST be a verbatim substring of quote, never a paraphrase or invented boolean; retain literal negative phrases. Quote MUST be copied exactly from a cited current message. If a resolved name is not in a quote, choose a source mentioning it or keep a verbatim descriptive value. Use concise snake_case predicate keys consistently, such as opening_time. Do not infer any fact absent from the current conversation. No facts from greetings and no invented dates. Use ISO UTC or YYYY-MM-DD for explicit validity dates; null when not stated. A delivery deadline is NOT a fact validity start. An explicit dated update replacing an earlier value uses replacesPrior=true; a historical restatement does not. Preserve past and present values as separate dated records. Only explicit I accept/I will/I promise/I agree declarations create accepted delivery commitments, not requests or hypothetical actions. A prohibition (must not, do not, never) is NEVER an accepted commitment. Each commitment item must appear literally in the same affirmative first-person delivery sentence as its quote. Remove unsupported commitments rather than changing their quote to unrelated acceptance. Do not remove supported affirmative commitments. Resolve I/my using the actual message author. A commitment quote must be from that actor. Preserve negation. If no supported records, return {"records":[]}.` },
  { role: 'user', content: JSON.stringify({ conversation: c, conversationDateUTC: new Date(c.createdAtMs).toISOString() }) }];
}
function renderClaim(r) {
  if (r.kind === 'fact') return JSON.stringify({ type: 'fact', subject: r.subject, predicate: r.predicate, value: r.value,
    validFrom: r.validFrom, validUntil: r.effectiveUntilMs === null || r.effectiveUntilMs === undefined ? r.validUntil : new Date(r.effectiveUntilMs).toISOString(), conflict: r.conflict ?? false });
  return JSON.stringify({ type: 'accepted_commitment', actor: r.actorAgentId, action: r.action, item: r.item,
    recipient: r.recipientAgentId, dueAt: r.dueAt, status: r.status ?? 'pending', completionEventId: r.completionEventId ?? null });
}
class TieredPolicy {
  constructor({ store, generate, embed, record = () => {}, maxExtractionAttempts = 1, maxExtractedRecords = 8,
    queryPlanner = 'llm', extractionFormat = 'source_sentence_schema_v1' }) {
    if (![1, 2].includes(maxExtractionAttempts)) throw new Error('invalid_extraction_attempt_limit');
    if (!Number.isInteger(maxExtractedRecords) || maxExtractedRecords < 1 || maxExtractedRecords > 8) throw new Error('invalid_extraction_record_limit');
    if (!['llm', 'deterministic_any_v1'].includes(queryPlanner)) throw new Error('invalid_query_planner');
    if (['dated_sentence_schema_v1', 'dated_reference_schema_v1'].includes(extractionFormat)) {
      for (const tx of store.snapshot().transactions) validateDatedFacts(tx.records, tx.conversation);
    }
    Object.assign(this, { store, generate, embed, record, maxExtractionAttempts, maxExtractedRecords, queryPlanner, extractionFormat }); this.pending = new Map();
  }
  serial(scope, action) {
    const key = scopeKey(scope), previous = this.pending.get(key) ?? Promise.resolve(), job = previous.catch(() => {}).then(action);
    this.pending.set(key, job); return job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
  }
  observe(event, scope, { nowMs } = {}) {
    return this.serial(scope, async () => {
      const c = validateConversation(event);
      if (scope.worldId !== c.worldId || !c.observedBy.includes(scope.agentId) || !Number.isSafeInteger(nowMs)
          || nowMs < c.messages.at(-1).atMs || this.store.records(scope).some(r => r.observedAtMs > nowMs)) throw new Error('invalid_tiered_observation_scope_or_time');
      const previous = this.store.operation(scope, c.id);
      if (previous) { if (previous.inputFingerprint !== fingerprint(c)) throw new Error('tiered_operation_conflict'); return { inserted: false }; }
      const messages = this.extractionFormat === 'dated_reference_schema_v1' ? referenceMessages(c, this.maxExtractedRecords)
        : extractionMessages(c, this.maxExtractedRecords); let claims;
      for (let extractionAttempt = 1; extractionAttempt <= this.maxExtractionAttempts; extractionAttempt++) {
        // Transport errors/timeouts propagate; this bounded repair is only for
        // invalid completed model output and has its own fully metered call.
        const raw = await this.generate(messages, { ...scope, purpose: 'tiered_extract', extractionAttempt });
        try {
          const payload = this.extractionFormat === 'dated_reference_schema_v1' ? parseUniqueJson(raw) : JSON.parse(raw);
          claims = validateExtraction(this.extractionFormat === 'dated_reference_schema_v1' ? expandReferences(payload, c) : payload, c);
          if (['dated_sentence_schema_v1', 'dated_reference_schema_v1'].includes(this.extractionFormat)) validateDatedFacts(claims, c);
          if (claims.length > this.maxExtractedRecords) throw new Error('extraction_record_limit_exceeded');
          break;
        }
        catch (error) {
          this.record({ action: 'tiered_extraction_rejected', scope, eventId: c.id, extractionAttempt, error: error.message });
          if (extractionAttempt === this.maxExtractionAttempts) throw error;
          messages.push({ role: 'assistant', content: raw }, { role: 'user', content: this.extractionFormat === 'dated_reference_schema_v1'
            ? `Validation failed: ${error.message}. Return the entire corrected facts map and commitments array, within the total record limit. Choose distinct existing evidence IDs; no invented facts, no prohibited or unsupported commitments.`
            : `Validation failed: ${error.message}. Return the entire corrected records object. Recheck ALL records. Each fact value must occur literally in its quote: use a literal relationship phrase, never a resolved person name or true/false unless that text appears in the quote. Each commitment must quote an affirmative first-person delivery sentence containing its own item. Prohibitions, negative statements, requests and another item's acceptance are NOT commitments: remove those unsupported records, retain supported positive commitments. Keep every required field. Do not invent facts to repair missing evidence.` });
        }
      }
      const records = [];
      for (const [index, claim] of claims.entries()) {
        const text = renderClaim(claim);
        const embedding = await this.embed(text, { ...scope, purpose: 'tiered_memory_embedding' });
        records.push({ ...claim, id: `tiered:${fingerprint({ conversation: c.id, index }).slice(0, 20)}`,
          observedAtMs: c.messages.at(-1).atMs, embedding });
      }
      const result = this.store.commit({ scope, conversation: c, records });
      this.record({ action: 'tiered_observe', scope, eventId: c.id, ...result }); return result;
    });
  }
  retrieve(scope, { text, queryId, nowMs, n = 3, readOnly = true, memoryBudgetTokens,
    maxInputTokens, countTokens, renderMemory, renderInput } = {}) {
    return this.serial(scope, async () => {
      if (readOnly !== true || typeof text !== 'string' || !text.trim() || typeof queryId !== 'string' || !queryId
          || !Number.isSafeInteger(nowMs) || nowMs < 0 || this.store.records(scope).some(r => r.observedAtMs > nowMs)) throw new Error('invalid_tiered_query');
      const params = { policy: 'budgeted_retrieval', n, nowMs, memoryBudgetTokens, maxInputTokens, countTokens, renderMemory, renderInput };
      selectMemories({ ...params, ranked: [] });
      const rawPlan = this.queryPlanner === 'llm' ? await this.generate([{ role: 'system', content: 'Return JSON only: {"asOfDate":null,"focus":"fact"}. focus is fact, commitment, or any. Extract an explicit calendar date from the question only; represent it YYYY-MM-DD. No explicit calendar date -> null. Do not invent dates for today/current. Date formats supported: ISO YYYY-MM-DD or full English month/day/year. A question about accepted promises, delivery, or deadlines has focus commitment. Do not answer the question.' },
        { role: 'user', content: text }], { ...scope, purpose: 'tiered_query_plan', queryId }, 128) : null;
      const plan = rawPlan === null ? deterministicPlan(text, nowMs) : parsePlan(rawPlan, text, nowMs);
      const active = this.store.materialize(scope, { nowMs, asOfMs: plan.asOfMs });
      const focused = active.filter(r => plan.focus === 'any' || r.kind === plan.focus);
      // Keep conflicting assertions together; deduplicate identical representations
      // only in this read view, leaving all original sources in the ledger.
      const groups = new Map();
      for (const r of focused) { const key = `${r.kind}:${r.key}`, list = groups.get(key) ?? []; list.push(r); groups.set(key, list); }
      const candidates = [...groups.values()].map(group => {
        const distinct = [...new Map(group.map(r => [renderClaim(r), r])).values()];
        return { id: distinct[0].id, text: distinct.length === 1 ? renderClaim(distinct[0]) : JSON.stringify(distinct.map(r => JSON.parse(renderClaim(r)))),
          sourceEventIds: [...new Set(group.flatMap(r => r.sourceEventIds))], claimIds: group.map(r => r.id),
          embedding: group[0].embedding, importance: 0, lastAccess: nowMs,
          critical: group.some(r => r.kind === 'commitment' && r.actorAgentId === scope.agentId && ['pending', 'overdue_pending'].includes(r.status)) };
      });
      const vector = candidates.length ? await this.embed(text, { ...scope, purpose: 'tiered_retrieval_embedding', queryId }) : null;
      const ranked = candidates.map(memory => ({ memory, score: cosine(vector, memory.embedding) }))
        .sort((a, b) => Number(b.memory.critical) - Number(a.memory.critical) || b.score - a.score);
      const result = selectMemories({ ...params, ranked });
      const missingCritical = candidates.filter(m => m.critical && !result.selected.some(s => s.id === m.id)).map(m => m.id);
      if (missingCritical.length) { result.executable = false; result.rejectionReason = 'critical_commitment_budget_exceeded'; }
      this.record({ action: 'tiered_retrieve', scope, queryId, plan, selectedIds: result.selected.map(m => m.id),
        excluded: result.excluded, missingCritical, executable: result.executable, inputTokens: result.inputTokens, memoryTokens: result.memoryTokens });
      return { ...result, plan, missingCritical };
    });
  }
}
module.exports = { TieredPolicy, extractionMessages, renderClaim, parsePlan };
