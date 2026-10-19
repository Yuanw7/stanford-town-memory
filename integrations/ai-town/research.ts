import { internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { ACTION_TIMEOUT } from './constants';

// P2 只读验收入口，仅能以本地管理员身份调用。
// 上游记忆没有 worldId，必须限制单世界；多世界实验需先实现隔离迁移。
export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const worlds = await ctx.db.query('worlds').take(2);
    if (worlds.length > 1) throw new Error('P2 snapshot 仅支持单世界；需先修复跨世界记忆隔离');
    const world = worlds[0];
    if (!world) return { worldId: null, agentCount: 0, completedConversations: 0, memories: [], embeddings: [] };
    const status = await ctx.db.query('worldStatus').withIndex('worldId', q => q.eq('worldId', world._id)).first();
    const engine = status ? await ctx.db.get(status.engineId) : null;
    const conversations = await ctx.db.query('archivedConversations')
      .withIndex('worldId', q => q.eq('worldId', world._id)).take(1001);
    const memories = await ctx.db.query('memories').take(501);
    if (memories.length > 500 || conversations.length > 1000) throw new Error('P2 snapshot 超出小规模验收范围');
    const embeddings = await Promise.all(memories.map(async m => {
      const embedding = await ctx.db.get(m.embeddingId);
      return { memoryId: m._id, embeddingId: m.embeddingId, exists: Boolean(embedding),
        playerIdMatches: embedding?.playerId === m.playerId,
        dimensions: embedding?.embedding.length ?? null };
    }));
    return {
      worldId: world._id, status: status?.status ?? null, agentCount: world.agents.length,
      engineRunning: engine?.running ?? false, generationNumber: engine?.generationNumber ?? null,
      controlEpoch: status?.researchControlEpoch ?? 0,
      staleOperations: world.agents.filter(a => a.inProgressOperation
        && Date.now() > a.inProgressOperation.started + ACTION_TIMEOUT + 5000).map(a => a.id),
      agentIds: world.agents.map(a => a.id), playerIds: world.players.map(p => p.id),
      completedConversations: conversations.filter(c => c.numMessages > 0).length,
      memories: memories.map(m => ({ id: m._id, playerId: m.playerId, description: m.description,
        embeddingId: m.embeddingId, data: m.data, importance: m.importance })),
      embeddings,
    };
  },
});

export const inspectConversation = internalQuery({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const worlds = await ctx.db.query('worlds').take(2);
    if (worlds.length !== 1) throw new Error('诊断仅支持单世界');
    const world = worlds[0];
    const archived = await ctx.db.query('archivedConversations')
      .withIndex('worldId', q => q.eq('worldId', world._id).eq('id', args.conversationId)).first();
    const messages = await ctx.db.query('messages')
      .withIndex('conversationId', q => q.eq('worldId', world._id).eq('conversationId', args.conversationId)).take(100);
    return { conversationId: args.conversationId, archived: Boolean(archived),
      active: world.conversations.some(c => c.id === args.conversationId), messageCount: messages.length };
  },
});

export const exportMessages = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const worlds = await ctx.db.query('worlds').take(2);
    if (worlds.length !== 1) throw new Error('事件导出仅支持单世界');
    const world = worlds[0];
    const page = await ctx.db.query('messages').withIndex('conversationId', q => q.eq('worldId', world._id))
      .paginate({ numItems: 100, cursor: args.cursor });
    const rows = await Promise.all(page.page.map(async message => {
      const active = world.conversations.find(c => c.id === message.conversationId);
      const archived = active ? null : await ctx.db.query('archivedConversations')
        .withIndex('worldId', q => q.eq('worldId', world._id).eq('id', message.conversationId)).first();
      const participantIds = active ? active.participants.map(p => p.playerId) : archived?.participants ?? [];
      return { id: message._id, messageUuid: message.messageUuid, worldId: world._id,
        conversationId: message.conversationId, author: message.author, text: message.text,
        createdAt: message._creationTime,
        observedBy: world.agents.filter(a => participantIds.includes(a.playerId)).map(a => a.id),
        visibilityResolved: Boolean(active || archived) };
    }));
    return { rows, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
