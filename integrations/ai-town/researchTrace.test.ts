import { embeddingCacheIdentity, researchHeaders } from './researchTrace';

test('embedding 缓存键包含实验、世界、角色、模型摘要和文本', () => {
  const scope = { worldId: 'w1', agentId: 'a1', purpose: 'retrieval' };
  const base = embeddingCacheIdentity('文本', scope, 'model', 'digest', 'experiment');
  const variants = [
    embeddingCacheIdentity('文本', { ...scope, worldId: 'w2' }, 'model', 'digest', 'experiment'),
    embeddingCacheIdentity('文本', { ...scope, agentId: 'a2' }, 'model', 'digest', 'experiment'),
    embeddingCacheIdentity('文本', scope, 'model', 'different', 'experiment'),
    embeddingCacheIdentity('文本', scope, 'model', 'digest', 'other'),
  ];
  expect(variants.every(v => v !== base)).toBe(true);
});
test('元数据只进入 headers，角色作用域和 attempt 可还原', () => {
  const scope = { worldId: 'w1', agentId: 'a1', purpose: 'importance' };
  const headers = researchHeaders(scope, 'call1', 2);
  expect(JSON.parse(decodeURIComponent(headers['x-town-scope']))).toMatchObject(scope);
  expect(headers['x-town-attempt']).toBe('2');
});
