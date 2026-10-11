import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message, Task, Workspace } from '../contracts';
import { transaction } from '../infrastructure/database';
import { TaskRepository } from '../domains/tasks/repository';
import { validateRequest } from '../domains/tasks/task';
import { intakeReceipt } from '../domains/conversation/intake';
import { MaterialLibrary } from '../domains/materials/library';

export class WorkspaceService {
  private tasks: TaskRepository;
  constructor(private db: DatabaseSync, readonly materials: MaterialLibrary) {
    this.tasks = new TaskRepository(db);
  }

  snapshot(): Workspace {
    return {
      tasks: this.tasks.list(), attachments: this.materials.list(),
      messages: this.db.prepare('SELECT payload FROM messages ORDER BY rowid').all()
        .map(row => JSON.parse(String(row.payload)) as Message),
    };
  }

  submit(value: unknown): Workspace {
    const input = validateRequest(value);
    transaction(this.db, () => {
      const existing = this.tasks.findRequest(input.requestId);
      if (existing) {
        if (existing.brief !== input.text || JSON.stringify(existing.attachmentIds) !== JSON.stringify(input.attachmentIds)) {
          throw new Error('请求标识已经用于其他内容，请重新发送。');
        }
        return;
      }
      input.attachmentIds.forEach(id => this.materials.require(id));
      const now = new Date().toISOString();
      const task: Task = {
        id: randomUUID(), requestId: input.requestId,
        title: input.text.slice(0, 48) || '附件需求', brief: input.text, status: 'pending',
        attachmentIds: input.attachmentIds, createdAt: now, updatedAt: now,
      };
      this.tasks.create(task);
      const user: Message = { id: randomUUID(), role: 'user', text: input.text || '已添加附件', taskId: task.id, createdAt: now };
      const receipt = intakeReceipt(task, randomUUID());
      for (const message of [user, receipt]) {
        this.db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(message.id, task.id, JSON.stringify(message));
      }
    });
    return this.snapshot();
  }

  cancelTask(id: unknown): Workspace {
    if (typeof id !== 'string') throw new Error('任务标识无效。');
    this.tasks.cancel(id);
    return this.snapshot();
  }
}
