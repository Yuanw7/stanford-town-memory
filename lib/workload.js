const fs = require('node:fs');
const { hash } = require('./artifacts');

function loadWorkload(file, checksum) {
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== checksum) throw new Error('工作负载校验和不匹配');
  const rows = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
  const ids = new Set(); let previous = -1;
  for (const row of rows) {
    if (!['observation', 'query'].includes(row.type)) throw new Error('未知事件类型');
    if (typeof row.id !== 'string' || ids.has(row.id)) throw new Error('重复或无效事件 ID');
    ids.add(row.id);
    if (!Number.isInteger(row.sequence) || row.sequence <= previous) throw new Error('事件顺序不严格递增');
    previous = row.sequence;
    for (const field of ['worldId', 'agentId', 'text']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`事件 ${field} 无效`);
    }
    if (['answer', 'acceptedAnswers', 'expected_answer'].some(key => key in row)) throw new Error('工作负载不能包含评估答案');
  }
  return rows;
}

class Timeline {
  constructor(snapshot = []) {
    this.scopes = new Map();
    for (const observation of snapshot) this.observe(observation);
  }
  key(scope) { return JSON.stringify([scope.worldId, scope.agentId]); }
  observe(event) {
    if (event.type !== 'observation') throw new Error('只能写入观察事件');
    const key = this.key(event);
    const items = this.scopes.get(key) ?? [];
    const existing = items.find(item => item.id === event.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error('同 ID 事件内容冲突');
      return;
    }
    this.scopes.set(key, [...items, structuredClone(event)]);
  }
  visible(scope) { return structuredClone(this.scopes.get(this.key(scope)) ?? []); }
  snapshot() { return structuredClone([...this.scopes.values()].flat()); }
}
module.exports = { loadWorkload, Timeline };
