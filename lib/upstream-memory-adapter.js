const { validateConversation, fingerprint } = require('./conversations-v2');
const { scopeKey } = require('./memory-store');

function conversationMessages(event, agentId) {
  const c = validateConversation(event);
  const player = c.participants.find(p => p.agentId === agentId);
  if (!player || !c.observedBy.includes(agentId)) throw new Error('conversation_not_visible');
  const other = c.participants.find(p => p.agentId !== agentId);
  return [ { role: 'user', content: `You are ${player.name}, and you just finished a conversation with ${other.name}. I would
      like you to summarize the conversation from ${player.name}'s perspective, using first-person pronouns like
      "I," and add if you liked or disliked this interaction.` },
  ...c.messages.map(m => {
    const author = c.participants.find(p => p.agentId === m.authorAgentId);
    const recipient = c.participants.find(p => p.agentId !== m.authorAgentId);
    return { role: 'user', content: `${author.name} to ${recipient.name}: ${m.text}` };
  }), { role: 'user', content: 'Summary:' } ];
}
function importanceMessages(description) {
  return [{ role: 'user', content: `On the scale of 0 to 9, where 0 is purely mundane (e.g., brushing teeth, making bed) and 9 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of 0 to 9. Respond with number only, e.g. "5"` }];
}
function parseImportance(raw) {
  let value = parseFloat(raw);
  if (Number.isNaN(value)) value = +(raw.match(/\d+/)?.[0] ?? NaN);
  return { value: Number.isNaN(value) ? 5 : value, fallback: Number.isNaN(value) };
}
function reflectionMessages(name, memories) {
  const prompt = ['[no prose]', '[Output only JSON]', `You are ${name}, statements about you:`];
  memories.forEach((m, idx) => prompt.push(`Statement ${idx}: ${m.text}`));
  prompt.push('What 3 high-level insights can you infer from the above statements?');
  prompt.push('Return in JSON format, where the key is a list of input statements that contributed to your insights and value is your insight. Make the response parseable by Typescript JSON.parse() function. DO NOT escape characters or include "\n" or white space in response.');
  prompt.push('Example: [{insight: "...", statementIds: [1,2]}, {insight: "...", statementIds: [1]}, ...]');
  return [{ role: 'user', content: prompt.join('\n') }];
}
function reflectionEligible(memories, lastReflectionMs = 0) {
  return memories.filter(m => m.createdAtMs > lastReflectionMs).reduce((n, m) => n + m.importance, 0) > 500;
}
function parseReflections(text, memories) {
  const insights = JSON.parse(text);
  if (!Array.isArray(insights) || !insights.length || insights.length > 3) throw new Error('invalid_reflection_structure');
  return insights.map(item => {
    if (!item || typeof item.insight !== 'string' || !item.insight.trim() || !Array.isArray(item.statementIds)
        || !item.statementIds.length || item.statementIds.some(i => !Number.isInteger(i) || i < 0 || i >= memories.length)) {
      throw new Error('invalid_reflection_sources');
    }
    return { text: item.insight, sourceMemoryIds: [...new Set(item.statementIds)].map(i => memories[i].id) };
  });
}
class ConversationMemoryWriter {
  constructor({ store, generate, embed }) { Object.assign(this, { store, generate, embed }); this.pending = new Map(); }
  async remember(event, scope) {
    const c = validateConversation(event), key = JSON.stringify([scopeKey(scope), c.id]);
    const inputFingerprint = fingerprint(c), pending = this.pending.get(key);
    if (pending) {
      if (pending.inputFingerprint !== inputFingerprint) throw new Error('operation_conflict');
      return pending.promise;
    }
    const promise = this.write(c, scope);
    this.pending.set(key, { inputFingerprint, promise });
    try { return await promise; } finally { this.pending.delete(key); }
  }
  async write(event, scope) {
    const c = validateConversation(event);
    if (scope.worldId !== c.worldId) throw new Error('conversation_world_mismatch');
    const messages = conversationMessages(c, scope.agentId);
    const operationId = `conversation:${c.id}`, inputFingerprint = fingerprint(c);
    const previous = this.store.operation(scope, operationId);
    if (previous) {
      if (previous.inputFingerprint !== inputFingerprint) throw new Error('operation_conflict');
      return { inserted: false };
    }
    const summary = await this.generate(messages, { ...scope, purpose: 'summary' }, 500);
    const other = c.participants.find(p => p.agentId !== scope.agentId);
    // Explicit adaptation: UTC ISO time replaces host-dependent toLocaleString.
    const text = `Conversation with ${other.name} at ${new Date(c.createdAtMs).toISOString()}: ${summary}`;
    const importance = parseImportance(await this.generate(importanceMessages(text), { ...scope, purpose: 'importance' }, 1));
    const embedding = await this.embed(text, { ...scope, purpose: 'memory_embedding' });
    const memory = { id: operationId, kind: 'conversation', text, importance: importance.value,
      importanceFallback: importance.fallback, embedding, embeddingVersion: this.store.embeddingVersion,
      createdAtMs: c.messages.at(-1).atMs, lastAccess: c.messages.at(-1).atMs,
      sourceEventIds: c.messages.map(m => m.id), sourceMemoryIds: [] };
    return this.store.commit({ scope, operationId, inputFingerprint, memories: [memory] });
  }
}
module.exports = { conversationMessages, importanceMessages, parseImportance,
  reflectionMessages, reflectionEligible, parseReflections, ConversationMemoryWriter };
