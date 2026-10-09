import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../../infrastructure/database';
import { activeStates, required, type EnqueueInput, type ExecutionResult, type Priority, type QueueEvent, type QueueItem, type QueueState } from './types';

const priorities: Priority[] = ['routine', 'urgent', 'critical'];
function decode(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id), requestId: String(row.request_id), taskId: String(row.task_id), source: String(row.source),
    destination: String(row.destination), body: String(row.body), priority: priorities[Number(row.priority)],
    state: row.state as QueueState, generation: row.generation as string | null,
    cancelRequested: Boolean(row.cancel_requested), blockedOn: row.blocked_on as string | null,
    resolution: row.resolution as string | null, evidenceRef: row.evidence_ref as string | null,
    parentId: row.parent_id as string | null, successorId: row.successor_id as string | null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

/** Single writer of execution obligations. All mutations and their events commit together.
 * Named sessions are opaque identities, never derived from UI labels or runtime session IDs.
 */
export class ExecutionQueue {
  constructor(private db: DatabaseSync) {}

  get(id: string): QueueItem {
    const row = this.db.prepare('SELECT * FROM execution_queue WHERE id = ?').get(id);
    if (!row) throw new Error('Queue item not found.');
    return decode(row);
  }

  list(): QueueItem[] {
    return this.db.prepare('SELECT * FROM execution_queue ORDER BY priority DESC, created_at, rowid').all().map(decode);
  }

  events(after = 0, limit = 100): QueueEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event cursor or limit.');
    return this.db.prepare('SELECT * FROM execution_events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit)
      .map(row => ({ seq: Number(row.seq), itemId: String(row.item_id), state: row.state as QueueState, actor: String(row.actor), note: String(row.note), at: String(row.at) }));
  }

  enqueue(input: EnqueueInput): QueueItem {
    return transaction(this.db, () => this.insert(input));
  }

  private insert(input: EnqueueInput, parentId: string | null = null): QueueItem {
    const normalized = {
      requestId: required(input.requestId, 'requestId', 256), taskId: required(input.taskId, 'taskId', 256),
      source: required(input.source, 'source', 256), destination: required(input.destination, 'destination', 256),
      body: required(input.body, 'body'), priority: input.priority ?? 'routine',
    };
    if (!priorities.includes(normalized.priority)) throw new Error('Invalid priority.');
    const payload = JSON.stringify(normalized);
    const existing = this.db.prepare('SELECT * FROM execution_queue WHERE request_id = ?').get(normalized.requestId);
    if (existing) {
      if (existing.request_payload !== payload || existing.parent_id !== parentId) throw new Error('Request ID reused with different content.');
      return decode(existing);
    }
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare(`INSERT INTO execution_queue
      (id, request_id, request_payload, task_id, source, destination, body, priority, state, parent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, normalized.requestId, payload,
      normalized.taskId, normalized.source, normalized.destination, normalized.body, priorities.indexOf(normalized.priority), parentId, now, now);
    this.event(id, 'pending', normalized.source, 'created');
    return this.get(id);
  }

  /** BEGIN IMMEDIATE + persisted running count + unique owner index coordinate schedulers. */
  claimNext(destinations: string[], maxConcurrent: number, lane: (destination: string) => string = value => value): QueueItem | undefined {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid concurrency.');
    if (!destinations.length) return undefined;
    return transaction(this.db, () => {
      const reservations = this.list().filter(item => item.state === 'in-progress' ||
        (item.state === 'blocked' && (item.blockedOn === 'runtime:unknown' || item.cancelRequested)));
      if (reservations.length >= maxConcurrent) return undefined;
      const busy = new Set(reservations.map(item => lane(item.destination)));
      const next = this.list().find(item => item.state === 'pending' && destinations.includes(item.destination) && !busy.has(lane(item.destination)));
      if (!next) return undefined;
      this.db.prepare("UPDATE execution_queue SET state = 'in-progress', generation = ?, blocked_on = NULL, updated_at = ? WHERE id = ?")
        .run(randomUUID(), new Date().toISOString(), next.id);
      this.event(next.id, 'in-progress', next.destination, 'claimed');
      return this.get(next.id);
    });
  }

  /** Stale generations are ignored, including callbacks racing cancellation or recovery. */
  finish(id: string, generation: string, result: ExecutionResult): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (item.generation !== generation || item.state !== 'in-progress') return item;
      if (result.kind === 'handoff') {
        if (item.cancelRequested) {
          this.change(item, 'blocked', item.destination, 'Cancellation pending; handoff suppressed.', 'cancellation-unconfirmed');
        } else {
          const successor = this.insert({ requestId: `handoff:${item.id}:${generation}`, taskId: item.taskId,
            source: item.destination, destination: result.destination, body: result.body, priority: item.priority }, item.id);
          this.db.prepare('UPDATE execution_queue SET successor_id = ? WHERE id = ?').run(successor.id, item.id);
          this.change(item, 'handed-off', item.destination, required(result.reason, 'handoff reason'));
        }
      } else if (result.kind === 'question') {
        this.change(item, 'blocked', item.destination, required(result.question, 'question'), 'human:user');
      } else if (result.kind === 'completed') {
        const evidence = required(result.evidenceRef, 'evidenceRef');
        this.db.prepare('UPDATE execution_queue SET evidence_ref = ? WHERE id = ?').run(evidence, id);
        this.change(item, 'done', item.destination, required(result.summary, 'summary'));
      } else if (result.kind === 'blocked') {
        this.change(item, 'blocked', item.destination, required(result.reason, 'reason'), required(result.blockedOn, 'blockedOn'));
      } else {
        this.change(item, result.kind === 'canceled' ? 'canceled' : 'failed', item.destination, required(result.reason, 'reason'));
      }
      return this.get(id);
    });
  }

  activity(id: string, generation: string, note: string): void {
    const item = this.get(id);
    if (item.state === 'in-progress' && item.generation === generation) this.event(id, item.state, item.destination, required(note, 'activity', 2000));
  }

  answer(id: string, answer: string): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (item.state !== 'blocked' || item.blockedOn !== 'human:user' || item.cancelRequested) throw new Error('此任务没有等待用户回答。');
      const reply = required(answer, 'answer', 16000);
      this.db.prepare('UPDATE execution_queue SET body=?, generation=NULL WHERE id=?').run(`${item.body}\n\n用户回答：${reply}`, id);
      this.change(item, 'pending', 'human:user', reply);
      return this.get(id);
    });
  }

  pickup(id: string, now = Date.now(), thresholdMs = 10 * 60_000): 'unclaimed' | 'working' | 'stalled-after-claim' | 'parked' | 'terminal' {
    const item = this.get(id);
    if (item.state === 'pending') return 'unclaimed';
    if (item.state === 'blocked') return 'parked';
    if (item.state !== 'in-progress') return 'terminal';
    const last = this.db.prepare('SELECT at FROM execution_events WHERE item_id=? ORDER BY seq DESC LIMIT 1').get(id);
    return now - Date.parse(String(last?.at ?? item.updatedAt)) > thresholdMs ? 'stalled-after-claim' : 'working';
  }

  requestCancel(id: string, actor: string): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (!activeStates.includes(item.state) || item.cancelRequested) return item;
      if (item.state === 'pending') this.change(item, 'canceled', required(actor, 'actor'), 'Canceled before dispatch.');
      else {
        this.db.prepare('UPDATE execution_queue SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        this.event(id, item.state, required(actor, 'actor'), 'Cancellation requested; runtime confirmation required.');
      }
      return this.get(id);
    });
  }

  confirmCancel(id: string, generation: string): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (item.generation === generation && item.cancelRequested && activeStates.includes(item.state)) {
        this.change(item, 'canceled', item.destination, 'Runtime confirmed cancellation.');
      }
      return this.get(id);
    });
  }

  /** Startup owner only, after the previous scheduler has stopped. Never redispatch uncertain work. */
  recoverInterrupted(): number {
    return transaction(this.db, () => {
      const interrupted = this.list().filter(item => item.state === 'in-progress');
      for (const item of interrupted) this.change(item, 'blocked', 'runtime', 'Execution interrupted; reconcile with runtime before retry.', 'runtime:unknown');
      return interrupted.length;
    });
  }

  /** Call only after external side effects / old runtime have been reconciled by a trusted adapter or operator. */
  retry(id: string, actor: string, reconciliation: string): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (!['blocked', 'failed'].includes(item.state)) throw new Error('Only blocked or failed work can retry.');
      if (item.cancelRequested) throw new Error('Cancellation must be reconciled before retry.');
      this.db.prepare('UPDATE execution_queue SET generation = NULL WHERE id = ?').run(id);
      this.change(item, 'pending', required(actor, 'actor'), required(reconciliation, 'reconciliation'));
      return this.get(id);
    });
  }

  private change(item: QueueItem, state: QueueState, actor: string, note: string, blockedOn: string | null = null) {
    this.db.prepare('UPDATE execution_queue SET state = ?, blocked_on = ?, resolution = ?, updated_at = ? WHERE id = ?')
      .run(state, blockedOn, note, new Date().toISOString(), item.id);
    this.event(item.id, state, actor, note);
  }

  private event(id: string, state: QueueState, actor: string, note: string) {
    this.db.prepare('INSERT INTO execution_events (item_id,state,actor,note,at) VALUES (?,?,?,?,?)')
      .run(id, state, actor, note, new Date().toISOString());
  }
}
