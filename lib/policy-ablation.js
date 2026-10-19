const { isDeepStrictEqual } = require('node:util');
const { fingerprint } = require('./conversations-v2');
function validateAblations(config) {
  if (config.ablations === undefined) return [];
  if (!Array.isArray(config.ablations)) throw new Error('invalid_ablations');
  const normalize = v => { const { id, ...rest } = v; return { ...rest, queryPlanner: v.queryPlanner ?? 'llm', extractionFormat: v.extractionFormat ?? config.extractionFormat }; };
  return config.ablations.map(edge => {
    if (!['queryPlanner', 'extractionFormat'].includes(edge.factor) || edge.control === edge.treatment) throw new Error('invalid_ablation_factor');
    const control = config.variants.find(v => v.id === edge.control), treatment = config.variants.find(v => v.id === edge.treatment);
    if (!control || !treatment || control.policy !== 'tiered_memory' || treatment.policy !== 'tiered_memory') throw new Error('invalid_ablation_variants');
    const a = normalize(control), b = normalize(treatment);
    if (a[edge.factor] === b[edge.factor]) throw new Error('unchanged_ablation_factor');
    delete a[edge.factor]; delete b[edge.factor];
    if (!isDeepStrictEqual(a, b)) throw new Error('multiple_ablation_factors_changed');
    return edge;
  });
}
function maintenanceFingerprint(snapshot) {
  return fingerprint(snapshot.transactions.map(tx => ({ worldId: tx.scope.worldId, agentId: tx.scope.agentId,
    conversation: tx.conversation, records: tx.records.map(row => {
      const { id, embedding, ...claim } = row; return claim;
    }) })));
}
module.exports = { validateAblations, maintenanceFingerprint };
