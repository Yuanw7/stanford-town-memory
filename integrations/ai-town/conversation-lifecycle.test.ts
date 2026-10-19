import { Conversation } from './conversation';
import { Game } from './game';

describe('conversation memory lifecycle', () => {
  for (const numMessages of [0, 1]) {
    test(`${numMessages} 条消息结束时仅真实对话安排记忆任务`, () => {
      const conversation = new Conversation({
        id: 'c:1', creator: 'p:0', created: 0, numMessages,
        participants: [{ playerId: 'p:0', invited: 0, status: { kind: 'invited' } }],
      });
      const agent = { playerId: 'p:0', lastConversation: undefined as number | undefined,
        toRemember: undefined as string | undefined };
      const game = { world: { agents: new Map([['a:0', agent]]), conversations: new Map([['c:1', conversation]]) } } as unknown as Game;
      conversation.stop(game, 123);
      expect(agent.lastConversation).toBe(123);
      expect(agent.toRemember).toBe(numMessages ? 'c:1' : undefined);
      expect(game.world.conversations.size).toBe(0);
    });
  }
});
