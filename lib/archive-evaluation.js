const { ArchiveStore } = require('./archive-policy');
const { deterministicPlan } = require('./query-plan');
function archiveSourceOverlap({ workload, config, manifest, truth, retrieval, snapshots }) {
  const result = {}, answers = new Map(truth.map(row => [row.id, row]));
  for (const variant of config.variants.filter(v => v.policy === 'archive_retrieval')) {
    const records = retrieval.filter(r => r.strategy === variant.id), seen = new Set();
    for (const r of records) {
      const key = `${r.repetition}:${r.queryId}`;
      if (!Number.isInteger(r.repetition) || r.repetition < 1 || r.repetition > config.repetitions
          || !workload.queries.some(q => q.id === r.queryId) || seen.has(key)) throw new Error('invalid_archive_retrieval_evaluation');
      seen.add(key);
    }
    const rows = [];
    for (let repetition = 1; repetition <= config.repetitions; repetition++) {
      const snapshot = snapshots[`${repetition}:${variant.id}`];
      const store = snapshot ? new ArchiveStore({ dimensions: config.embeddingDimensions, embeddingVersion: config.embeddingDigest, snapshot }) : null;
      for (const q of workload.queries) {
        const row = records.find(r => r.repetition === repetition && r.queryId === q.id);
        const annotated = answers.get(q.id)?.sourceEventIds;
        if (!annotated) throw new Error('missing_archive_evaluation_truth');
        let selected = null;
        if (row && store) {
          const scope = { experimentId: `${manifest.runId}:${variant.id}`, worldId: q.worldId, agentId: q.agentId };
          const visible = store.records(scope), cutoff = deterministicPlan(q.text, q.atMs).asOfMs;
          if (!Array.isArray(row.selectedIds) || new Set(row.selectedIds).size !== row.selectedIds.length) throw new Error('invalid_archive_selected_ids');
          selected = [...new Set(row.selectedIds.flatMap(id => {
            const memory = visible.find(m => m.id === id);
            if (!memory || memory.createdAtMs > cutoff) throw new Error('archive_selected_source_not_visible_at_time');
            return memory.sourceEventIds;
          }))];
        }
        rows.push({ repetition, queryId: q.id, selectedSourceEventIds: selected,
          annotatedSourceEventIds: annotated, anyAnnotatedSourceSelected: !annotated.length || selected === null ? null : annotated.some(id => selected.includes(id)) });
      }
    }
    const applicable = rows.filter(r => r.annotatedSourceEventIds.length);
    result[variant.id] = { expectedAnswerable: applicable.length,
      anyAnnotatedSourceSelected: applicable.filter(r => r.anyAnnotatedSourceSelected === true).length,
      unassessed: applicable.filter(r => r.selectedSourceEventIds === null).length, rows };
  }
  return { byVariant: result, limitation: 'Source-ID overlap only: annotations may list alternative evidence. Overlap does not establish complete evidence or semantic entailment; unknown-answer questions are not scored.' };
}
module.exports = { archiveSourceOverlap };
