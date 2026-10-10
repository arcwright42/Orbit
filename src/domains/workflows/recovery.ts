import type { DatabaseSync } from 'node:sqlite';
import type { QueueItem } from '../orchestration/types';

/** Failure occurrences outlive individual drives; redrive never rewrites the failed packet. */
export class WorkflowRecovery {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_failures (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, source_id TEXT NOT NULL, source_generation TEXT, reason TEXT NOT NULL, successor_id TEXT, decision TEXT, created_at TEXT NOT NULL, resolved_at TEXT)`);
  }
  record(stepId: string, source: QueueItem) {
    const id = `${source.id}:${source.generation ?? 'unclaimed'}`;
    this.db.prepare('INSERT OR IGNORE INTO workflow_failures (id,task_id,step_id,source_id,source_generation,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(id,source.taskId,stepId,source.id,source.generation,source.resolution ?? '',new Date().toISOString());
    return id;
  }
  resolve(stepId: string, source: QueueItem, successorId: string, decision: string) {
    const id = this.record(stepId,source);
    const row = this.db.prepare('SELECT successor_id,decision FROM workflow_failures WHERE id=?').get(id)!;
    if (row.successor_id && (row.successor_id !== successorId || row.decision !== decision)) throw new Error('Failure occurrence already redriven with another decision');
    this.db.prepare('UPDATE workflow_failures SET successor_id=?,decision=?,resolved_at=? WHERE id=?').run(successorId,decision,new Date().toISOString(),id);
  }
}
