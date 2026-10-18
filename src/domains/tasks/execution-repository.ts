import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '../../contracts';
import { transaction } from '../../infrastructure/database';
import { DEFAULT_EXECUTION_SETTINGS, type ExecutionSettings, type TaskDetail, type TaskEvent, type TaskRun, type TaskStep } from './execution';

export class ExecutionRepository {
  constructor(readonly db: DatabaseSync) {}
  transaction<T>(work: () => T): T { return transaction(this.db, work); }
  tasks(): Task[] { return this.db.prepare('SELECT payload FROM tasks ORDER BY rowid').all().map(row => JSON.parse(String(row.payload))); }
  task(id: string): Task {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error('任务不存在。');
    return JSON.parse(String(row.payload));
  }
  saveTask(task: Task) { this.db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(JSON.stringify(task), task.id); }
  steps(taskId: string): TaskStep[] { return this.db.prepare('SELECT payload FROM task_steps WHERE task_id = ? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.payload))); }
  saveStep(step: TaskStep) { this.db.prepare('INSERT INTO task_steps VALUES (?, ?, ?) ON CONFLICT(task_id, id) DO UPDATE SET payload = excluded.payload').run(step.taskId, step.id, JSON.stringify(step)); }
  runs(taskId: string): TaskRun[] { return this.db.prepare('SELECT payload FROM task_runs WHERE task_id = ? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.payload))); }
  run(id: string): TaskRun {
    const row = this.db.prepare('SELECT payload FROM task_runs WHERE id = ?').get(id);
    if (!row) throw new Error('执行记录不存在。');
    return JSON.parse(String(row.payload));
  }
  saveRun(run: TaskRun) { this.db.prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(run.id, run.taskId, run.stepId, JSON.stringify(run)); }
  append(event: Omit<TaskEvent, 'seq' | 'createdAt'>): TaskEvent {
    const value = { ...event, createdAt: new Date().toISOString() };
    const result = this.db.prepare('INSERT INTO task_events(task_id, payload) VALUES (?, ?)').run(value.taskId, JSON.stringify(value));
    return { ...value, seq: Number(result.lastInsertRowid) };
  }
  detail(id: string, before?: number): TaskDetail {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error('事件游标无效。');
    const rows = this.db.prepare('SELECT seq, payload FROM task_events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT 101').all(id, before ?? Number.MAX_SAFE_INTEGER);
    const events = rows.slice(0, 100).map(row => ({ ...JSON.parse(String(row.payload)), seq: Number(row.seq) } as TaskEvent)).reverse();
    return { task: this.task(id), steps: this.steps(id), runs: this.runs(id), events, nextBefore: rows.length > 100 ? events[0]?.seq : undefined };
  }
  settings(): ExecutionSettings {
    const row = this.db.prepare('SELECT payload FROM execution_settings WHERE id = 1').get();
    return row ? JSON.parse(String(row.payload)) : { ...DEFAULT_EXECUTION_SETTINGS };
  }
  saveSettings(settings: ExecutionSettings) { this.db.prepare('INSERT INTO execution_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(JSON.stringify(settings)); }
  receipt(runId: string, callId: string, name: string, args: unknown): unknown | undefined {
    const row = this.db.prepare('SELECT name, args, result FROM task_tool_receipts WHERE run_id = ? AND call_id = ?').get(runId, callId);
    if (!row) return undefined;
    if (row.name !== name || row.args !== JSON.stringify(args)) throw new Error('工具调用标识已用于其他参数。');
    return JSON.parse(String(row.result));
  }
  saveReceipt(runId: string, callId: string, name: string, args: unknown, result: unknown) {
    this.db.prepare('INSERT INTO task_tool_receipts VALUES (?, ?, ?, ?, ?)').run(runId, callId, name, JSON.stringify(args), JSON.stringify(result));
  }
}
