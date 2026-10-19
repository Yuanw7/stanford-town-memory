export type ResearchScope = { worldId: string; agentId: string; purpose: string };
export function embeddingCacheIdentity(text: string, scope: ResearchScope | undefined,
  model: string, digest: string, experimentId: string) {
  return JSON.stringify([experimentId, scope?.worldId ?? 'diagnostic', scope?.agentId ?? 'diagnostic', model, digest, text]);
}
export function researchHeaders(scope: ResearchScope | undefined, logicalCallId: string, attempt: number) {
  const resolved = scope ?? { worldId: 'diagnostic', agentId: 'diagnostic', purpose: 'diagnostic' };
  return {
    'x-town-scope': encodeURIComponent(JSON.stringify({
      experimentId: process.env.RESEARCH_EXPERIMENT_ID ?? 'local-town-p3', ...resolved,
    })),
    'x-town-call-id': logicalCallId,
    'x-town-attempt': String(attempt),
  };
}
