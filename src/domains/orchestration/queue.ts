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
  private claimable: (item: QueueItem) => boolean = () => true;
  setClaimGuard(guard: (item: QueueItem) => boolean) { this.claimable = guard; }
  private projector?: (item: QueueItem, result: ExecutionResult) => void;
  setProjector(projector: (item: QueueItem, result: ExecutionResult) => void) { this.projector = projector; }
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS queue_pauses (item_id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS queue_wakes (item_id TEXT PRIMARY KEY REFERENCES execution_queue(id), due_at INTEGER NOT NULL, delay_seconds INTEGER NOT NULL, max_seconds INTEGER NOT NULL)');
  }

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
      const next = this.list().find(item => item.state === 'pending' && this.claimable(item) && destinations.includes(item.destination) && !busy.has(lane(item.destination)));
      if (!next) return undefined;
      this.db.prepare("UPDATE execution_queue SET state = 'in-progress', generation = ?, blocked_on = NULL, updated_at = ? WHERE id = ?")
        .run(randomUUID(), new Date().toISOString(), next.id);
      this.event(next.id, 'in-progress', next.destination, 'claimed');
      return this.get(next.id);
    });
  }

  /** Stale generations are ignored, including callbacks racing cancellation or recovery. */
  finish(id: string, generation: string, result: ExecutionResult): QueueItem {
    return transaction(this.db, () => this.finishResult(id, generation, result));
  }

  private finishResult(id: string, generation: string, result: ExecutionResult): QueueItem {
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
        if (result.blockedOn.startsWith('queue:')) {
          const blocker = this.get(result.blockedOn.slice(6));
          if (blocker.taskId !== item.taskId || blocker.id === item.id) throw new Error('Invalid blocker');
          let cursor: QueueItem | undefined = blocker;
          const seen = new Set([item.id]);
          while (cursor) { if (seen.has(cursor.id)) throw new Error('Blocker cycle'); seen.add(cursor.id); cursor = cursor.blockedOn?.startsWith('queue:') ? this.get(cursor.blockedOn.slice(6)) : undefined; }
        }
        if (result.wakeAfterSeconds !== undefined && (!Number.isInteger(result.wakeAfterSeconds) || result.wakeAfterSeconds < 1 || result.wakeAfterSeconds > 86400)) throw new Error('Invalid wake delay');
        if (result.wakeMaxSeconds !== undefined && (!Number.isInteger(result.wakeMaxSeconds) || result.wakeMaxSeconds < (result.wakeAfterSeconds ?? Infinity) || result.wakeMaxSeconds > 604800)) throw new Error('Invalid wake maximum');
        this.change(item, 'blocked', item.destination, required(result.reason, 'reason'), required(result.blockedOn, 'blockedOn'));
        if (result.wakeAfterSeconds !== undefined) {
          const old = this.db.prepare('SELECT delay_seconds FROM queue_wakes WHERE item_id=?').get(id);
          const max = result.wakeMaxSeconds ?? result.wakeAfterSeconds;
          const delay = Math.min(max, Math.max(result.wakeAfterSeconds, Number(old?.delay_seconds ?? 0) * 2));
          this.db.prepare('INSERT OR REPLACE INTO queue_wakes VALUES (?,?,?,?)').run(id, Date.now() + delay * 1000, delay, max);
        }
      } else {
        this.change(item, result.kind === 'canceled' ? 'canceled' : 'failed', item.destination, required(result.reason, 'reason'));
      }
      const finished = this.get(id);
      this.projector?.(finished, result);
      return finished;
  }

  reconcileResult(id: string, generation: string, result: ExecutionResult): QueueItem {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (item.generation !== generation || item.state !== 'blocked' || item.blockedOn !== 'runtime:unknown') return item;
      this.db.prepare("UPDATE execution_queue SET state='in-progress' WHERE id=?").run(id);
      return this.finishResult(id, generation, result);
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

  pickup(id: string, now = Date.now(), thresholdMs = 3 * 60_000): 'unclaimed' | 'working' | 'stalled-after-claim' | 'parked' | 'terminal' {
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

  confirmCancel(id: string, generation: string | null): QueueItem {
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

  /** Event-first blocker wake; durable deadlines survive application restart. Never infer process death from age. */
  wakeDue(now = Date.now()): number {
    return transaction(this.db, () => {
      let count = 0;
      for (const item of this.list()) {
        if (item.state !== 'blocked' || item.cancelRequested || item.blockedOn === 'runtime:unknown' || item.blockedOn === 'application:paused') continue;
        const blocker = item.blockedOn?.startsWith('queue:') ? this.get(item.blockedOn.slice(6)) : undefined;
        const wake = this.db.prepare('SELECT due_at FROM queue_wakes WHERE item_id=?').get(item.id);
        if (blocker && !activeStates.includes(blocker.state) || wake && Number(wake.due_at) <= now) {
          this.db.prepare('UPDATE execution_queue SET generation=NULL WHERE id=?').run(item.id);
          this.change(item, 'pending', 'scheduler', blocker ? `依赖 ${blocker.id} 已结束：${blocker.state}。重新核对结果。` : '等待期限到达，重新核对条件。');
          count++;
        }
      }
      return count;
    });
  }

  parkPending(id: string, blockedOn: string, reason: string) {
    return transaction(this.db, () => { const item = this.get(id); if (item.state !== 'pending') throw new Error('Only pending work can be parked'); this.change(item, 'blocked', 'application', reason, blockedOn); return this.get(id); });
  }

  approveGate(id: string, answer: string) {
    return transaction(this.db, () => { const item = this.get(id); if (item.state !== 'blocked' || item.blockedOn !== 'human:gate') throw new Error('No human gate'); this.db.prepare('UPDATE execution_queue SET body=? WHERE id=?').run(`${item.body}\n用户审批：${required(answer, 'gate answer')}`, id); this.change(item, 'pending', 'human:user', '用户明确批准执行该步骤'); });
  }

  pauseStopped(id: string) {
    return transaction(this.db, () => {
      const item = this.get(id);
      if (item.state === 'in-progress' || item.blockedOn === 'runtime:unknown') return;
      if (!['pending','blocked','canceled'].includes(item.state) || item.blockedOn === 'application:paused') return;
      this.db.prepare('INSERT OR REPLACE INTO queue_pauses VALUES (?,?)').run(id, JSON.stringify({ state: item.state === 'blocked' ? 'blocked' : 'pending', blockedOn: item.blockedOn, resolution: item.resolution }));
      this.db.prepare('UPDATE execution_queue SET cancel_requested=0,generation=NULL WHERE id=?').run(id);
      this.change(item, 'blocked', 'application', '应用已退出，等待用户恢复', 'application:paused');
    });
  }

  resumePaused(id: string) {
    return transaction(this.db, () => {
      const item = this.get(id); if (item.state !== 'blocked' || item.blockedOn !== 'application:paused') throw new Error('Not paused');
      const row = this.db.prepare('SELECT payload FROM queue_pauses WHERE item_id=?').get(id);
      const previous = row ? JSON.parse(String(row.payload)) : { state: 'pending', blockedOn: null };
      this.change(item, previous.state, 'human:user', previous.resolution ?? '用户恢复任务', previous.state === 'blocked' ? previous.blockedOn : null);
      this.db.prepare('DELETE FROM queue_pauses WHERE item_id=?').run(id);
    });
  }

  private change(item: QueueItem, state: QueueState, actor: string, note: string, blockedOn: string | null = null) {
    this.db.prepare('UPDATE execution_queue SET state = ?, blocked_on = ?, resolution = ?, updated_at = ? WHERE id = ?')
      .run(state, blockedOn, note, new Date().toISOString(), item.id);
    this.event(item.id, state, actor, note);
    if (!activeStates.includes(state)) this.db.prepare('DELETE FROM queue_wakes WHERE item_id=?').run(item.id);
  }

  private event(id: string, state: QueueState, actor: string, note: string) {
    this.db.prepare('INSERT INTO execution_events (item_id,state,actor,note,at) VALUES (?,?,?,?,?)')
      .run(id, state, actor, note, new Date().toISOString());
  }
}
