const { hash } = require('./artifacts');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('invalid_or_unknown_fields');
}
function validateConversation(input) {
  keys(input, ['schemaVersion', 'type', 'id', 'worldId', 'createdAtMs', 'participants', 'observedBy', 'messages']);
  if (input.schemaVersion !== 2 || input.type !== 'conversation'
      || ![input.id, input.worldId].every(nonempty)
      || !Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) throw new Error('invalid_conversation');
  if (!Array.isArray(input.participants) || input.participants.length !== 2) throw new Error('requires_two_participants');
  for (const p of input.participants) {
    keys(p, ['agentId', 'name']);
    if (![p.agentId, p.name].every(nonempty)) throw new Error('invalid_participant');
  }
  const ids = input.participants.map(p => p.agentId);
  if (new Set(ids).size !== 2 || !Array.isArray(input.observedBy)
      || input.observedBy.length !== 2 || new Set(input.observedBy).size !== 2
      || input.observedBy.some(id => !ids.includes(id))) throw new Error('invalid_observation_scope');
  if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('empty_conversation');
  let previous = input.createdAtMs;
  const messageIds = new Set();
  for (const m of input.messages) {
    keys(m, ['id', 'authorAgentId', 'atMs', 'text']);
    if (!nonempty(m.id) || messageIds.has(m.id) || !ids.includes(m.authorAgentId)
        || !nonempty(m.text) || !Number.isSafeInteger(m.atMs) || m.atMs < previous) throw new Error('invalid_message_or_time');
    messageIds.add(m.id); previous = m.atMs;
  }
  return structuredClone(input);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const fingerprint = value => hash(JSON.stringify(canonical(value)));
module.exports = { validateConversation, fingerprint };
