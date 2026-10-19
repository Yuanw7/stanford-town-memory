const { validateConversation, fingerprint } = require('./conversations-v2');
function convertTown({ worldId, people, archives, messages }, { allowUnacknowledgedMessages = false } = {}) {
  if (typeof worldId !== 'string' || !worldId || ![people, archives, messages].every(Array.isArray)) throw new Error('invalid_town_export');
  const mapping = new Map(), agents = new Set();
  for (const p of people) {
    if (!['playerId', 'agentId', 'name'].every(k => typeof p[k] === 'string' && p[k])
        || mapping.has(p.playerId) || agents.has(p.agentId)) throw new Error('invalid_people_mapping');
    mapping.set(p.playerId, p); agents.add(p.agentId);
  }
  const archived = new Map();
  for (const a of archives) {
    if (!a || typeof a.id !== 'string' || archived.has(a.id)) throw new Error('invalid_archive_ids');
    archived.set(a.id, a);
  }
  const groups = new Map(), ids = new Map(), uuids = new Set();
  let duplicates = 0;
  for (const m of messages) {
    if (!m || typeof m.id !== 'string' || !m.id || typeof m.conversationId !== 'string'
        || typeof m.authorPlayerId !== 'string' || typeof m.text !== 'string' || !m.text.trim()
        || !Number.isFinite(m.createdAt) || m.createdAt < 0
        || ['answer', 'acceptedAnswers', 'expected_answer'].some(k => k in m)) throw new Error('invalid_source_message');
    if (ids.has(m.id)) {
      if (ids.get(m.id) !== fingerprint(m)) throw new Error('conflicting_message_id');
      duplicates++; continue;
    }
    ids.set(m.id, fingerprint(m));
    if (m.messageUuid) {
      const key = JSON.stringify([m.conversationId, m.messageUuid]);
      if (uuids.has(key)) throw new Error('duplicate_logical_message');
      uuids.add(key);
    }
    const list = groups.get(m.conversationId) ?? []; list.push(m); groups.set(m.conversationId, list);
  }
  const conversations = [], excluded = [], provenance = [];
  for (const [id, rows] of groups) {
    const a = archived.get(id);
    let reason;
    if (!a) reason = 'not_archived';
    else if (!Array.isArray(a.participantPlayerIds) || a.participantPlayerIds.length !== 2
        || new Set(a.participantPlayerIds).size !== 2) reason = 'not_two_participants';
    else if (!a.participantPlayerIds.every(p => mapping.has(p))) reason = 'participant_has_no_agent_mapping';
    else if (!Number.isSafeInteger(a.numMessages) || a.numMessages < 1 || a.numMessages !== rows.length
        && !(allowUnacknowledgedMessages && rows.length > a.numMessages)) reason = 'message_count_mismatch';
    else if (!Number.isFinite(a.createdAt) || a.createdAt < 0 || rows.some(m => m.createdAt < a.createdAt)) reason = 'invalid_archive_time';
    else if (rows.some(m => !a.participantPlayerIds.includes(m.authorPlayerId))) reason = 'author_not_participant';
    if (reason) { excluded.push({ conversationId: id, reason, messages: rows.length }); continue; }
    rows.sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
    const participants = a.participantPlayerIds.map(p => ({ agentId: mapping.get(p).agentId, name: mapping.get(p).name }));
    const c = validateConversation({ schemaVersion: 2, type: 'conversation', id, worldId,
      createdAtMs: Math.floor(a.createdAt), participants, observedBy: participants.map(p => p.agentId),
      messages: rows.map(m => ({ id: m.id, authorAgentId: mapping.get(m.authorPlayerId).agentId,
        atMs: Math.floor(m.createdAt), text: m.text })) });
    conversations.push(c); provenance.push({ conversationId: id, sourceArchiveCreatedAt: a.createdAt,
      sourceMessageIds: rows.map(m => m.id), sourceMessageTimes: rows.map(m => m.createdAt),
      originalParticipantPlayerIds: a.participantPlayerIds, convertedFingerprint: fingerprint(c) });
    Object.assign(provenance.at(-1), { engineAcknowledgedMessages: a.numMessages, persistedMessages: rows.length,
      countMismatch: a.numMessages !== rows.length, archivedAt: a.archivedAt ?? null });
  }
  conversations.sort((a, b) => a.messages.at(-1).atMs - b.messages.at(-1).atMs || a.id.localeCompare(b.id));
  return { conversations, excluded, provenance, duplicates,
    summary: { worldId, sourceMessages: messages.length, uniqueMessages: ids.size,
      includedConversations: conversations.length, includedMessages: conversations.reduce((n, c) => n + c.messages.length, 0),
      excludedConversations: excluded.length, missingMessageArchives: archives.filter(a => a.numMessages > 0 && !groups.has(a.id)).map(a => a.id),
      allowUnacknowledgedMessages, countMismatchConversations: provenance.filter(p => p.countMismatch).length,
      timestampAdaptation: 'fractional Convex milliseconds floored to integer v2 milliseconds; originals retained in provenance' } };
}
module.exports = { convertTown };
