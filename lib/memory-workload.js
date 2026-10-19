const { validateConversation } = require('./conversations-v2');
const categories = new Set(['fact', 'update', 'relationship', 'commitment', 'unanswerable']);
function validateMemoryWorkload(input) {
  if (!input || input.schemaVersion !== 2 || input.kind !== 'memory_development'
      || Object.keys(input).some(k => !['schemaVersion', 'kind', 'conversations', 'queries'].includes(k))
      || !Array.isArray(input.conversations) || !input.conversations.length || !Array.isArray(input.queries) || !input.queries.length) {
    throw new Error('invalid_memory_workload');
  }
  const conversations = input.conversations.map(validateConversation), ids = new Set(), events = new Set(), people = new Set();
  let previous = -1;
  for (const c of conversations) {
    const key = JSON.stringify([c.worldId, c.id]), end = c.messages.at(-1).atMs;
    if (ids.has(key) || end < previous) throw new Error('duplicate_or_unordered_conversation');
    ids.add(key); previous = end;
    for (const p of c.participants) people.add(JSON.stringify([c.worldId, p.agentId]));
    for (const m of c.messages) {
      const event = JSON.stringify([c.worldId, m.id]);
      if (events.has(event)) throw new Error('duplicate_source_event'); events.add(event);
    }
  }
  const queries = input.queries.map(q => {
    if (!q || Object.keys(q).some(k => !['id', 'worldId', 'agentId', 'text', 'category', 'atMs'].includes(k))
        || !['id', 'worldId', 'agentId', 'text'].every(k => typeof q[k] === 'string' && q[k])
        || !categories.has(q.category) || !Number.isSafeInteger(q.atMs) || q.atMs < previous
        || !people.has(JSON.stringify([q.worldId, q.agentId])) || ids.has(q.id)) throw new Error('invalid_memory_query_or_scope');
    ids.add(q.id); previous = q.atMs; return structuredClone(q);
  });
  return { schemaVersion: 2, kind: 'memory_development', conversations, queries };
}
module.exports = { validateMemoryWorkload };
