import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '../../contracts';
import { cancelPendingTask } from './task';

export class TaskRepository {
  constructor(private db: DatabaseSync) {}

  list(): Task[] {
    return this.db.prepare('SELECT payload FROM tasks ORDER BY rowid DESC').all()
      .map(row => JSON.parse(String(row.payload)) as Task);
  }

  findRequest(requestId: string): Task | undefined {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE request_id = ?').get(requestId);
    return row ? JSON.parse(String(row.payload)) as Task : undefined;
  }

  create(task: Task): void {
    this.db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(task.id, task.requestId, JSON.stringify(task));
  }

  cancel(id: string): void {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error('任务不存在。');
    const task = cancelPendingTask(JSON.parse(String(row.payload)), new Date().toISOString());
    this.db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(JSON.stringify(task), id);
  }
}
