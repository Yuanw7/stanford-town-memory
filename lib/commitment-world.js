const { scopeKey } = require('./memory-store');
const { fingerprint } = require('./conversations-v2');
class CommitmentWorld {
  constructor({ scope, contacts, inventory, acceptedTasks, snapshot } = {}) {
    scopeKey(scope); this.scope = structuredClone(scope);
    if (!Array.isArray(contacts) || !contacts.length || new Set(contacts.map(c => c.id)).size !== contacts.length
        || contacts.some(c => typeof c.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name)
        || !Array.isArray(inventory) || new Set(inventory).size !== inventory.length
        || inventory.some(i => typeof i !== 'string' || !i) || !Array.isArray(acceptedTasks) || !acceptedTasks.length) throw new Error('invalid_task_world');
    const ids = new Set(), items = new Set();
    for (const t of acceptedTasks) {
      if (typeof t.id !== 'string' || !t.id || ids.has(t.id) || typeof t.itemId !== 'string' || !t.itemId || items.has(t.itemId)
          || !contacts.some(c => c.id === t.recipientId) || !Number.isSafeInteger(t.acceptedAtMs) || t.acceptedAtMs < 0
          || !Number.isSafeInteger(t.dueAtMs) || t.dueAtMs < t.acceptedAtMs
          || !Array.isArray(t.sourceEventIds) || !t.sourceEventIds.length || !t.sourceEventIds.every(id => typeof id === 'string' && id)) throw new Error('invalid_accepted_task');
      ids.add(t.id); items.add(t.itemId);
    }
    this.contacts = structuredClone(contacts); this.initialInventory = [...inventory]; this.inventory = [...inventory];
    this.tasks = structuredClone(acceptedTasks); this.actions = []; this.processed = new Map();
    if (snapshot) {
      if (snapshot.schemaVersion !== 1 || fingerprint(snapshot.scope) !== fingerprint(scope)
          || fingerprint(snapshot.contacts) !== fingerprint(contacts) || fingerprint(snapshot.inventory) !== fingerprint(inventory)
          || fingerprint(snapshot.acceptedTasks) !== fingerprint(acceptedTasks) || !Array.isArray(snapshot.actions)) throw new Error('task_snapshot_identity_mismatch');
      for (const entry of snapshot.actions) this.execute(entry);
    }
  }
  visibleState(nowMs) { return { nowMs, inventory: [...this.inventory], contacts: structuredClone(this.contacts) }; }
  execute({ scope = this.scope, actionId, atMs, action }) {
    if (scopeKey(scope) !== scopeKey(this.scope)) throw new Error('task_scope_mismatch');
    if (typeof actionId !== 'string' || !actionId || !Number.isSafeInteger(atMs)
        || atMs < Math.max(...this.tasks.map(t => t.acceptedAtMs)) || !action || typeof action !== 'object'
        || Array.isArray(action)) throw new Error('invalid_action');
    const entry = { scope: this.scope, actionId, atMs, action: structuredClone(action) }, digest = fingerprint(entry);
    const previous = this.processed.get(actionId);
    if (previous) { if (previous !== digest) throw new Error('action_conflict'); return { executed: false, duplicate: true }; }
    if (this.actions.length && atMs < this.actions.at(-1).atMs) throw new Error('non_monotonic_action');
    if (action.action === 'wait') {
      if (Object.keys(action).some(k => k !== 'action')) throw new Error('invalid_wait_action');
    } else if (action.action === 'deliver') {
      if (Object.keys(action).some(k => !['action', 'itemId', 'recipientId'].includes(k))
          || !this.inventory.includes(action.itemId) || !this.contacts.some(c => c.id === action.recipientId)) throw new Error('invalid_delivery');
      this.inventory = this.inventory.filter(i => i !== action.itemId);
    } else throw new Error('unsupported_action');
    this.actions.push(entry); this.processed.set(actionId, digest);
    return { executed: true, duplicate: false };
  }
  evaluate(atMs) {
    if (!Number.isSafeInteger(atMs) || atMs < 0 || this.actions.some(a => a.atMs > atMs)) throw new Error('invalid_task_evaluation_time');
    const rows = this.tasks.filter(t => t.acceptedAtMs <= atMs).map(t => {
      const delivery = this.actions.find(a => a.action.action === 'deliver' && a.action.itemId === t.itemId
        && a.action.recipientId === t.recipientId && a.atMs >= t.acceptedAtMs && a.atMs <= t.dueAtMs);
      return { taskId: t.id, due: t.dueAtMs <= atMs, completed: Boolean(delivery),
        completionEventId: delivery?.actionId ?? null, sourceEventIds: t.sourceEventIds };
    });
    const due = rows.filter(t => t.due), completedDue = due.filter(t => t.completed).length;
    return { accepted: rows.length, due: due.length, completedDue, pendingNotDue: rows.length - due.length,
      completionRate: due.length ? completedDue / due.length : null, rows };
  }
  snapshot() { return structuredClone({ schemaVersion: 1, scope: this.scope, contacts: this.contacts,
    inventory: this.initialInventory, acceptedTasks: this.tasks, actions: this.actions }); }
}
module.exports = { CommitmentWorld };
