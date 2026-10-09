import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Message, Task, Workspace, ConnectionResult } from '../contracts';
import { transaction } from '../infrastructure/database';
import { TaskRepository } from '../domains/tasks/repository';
import { validateRequest } from '../domains/tasks/task';
import { intakeReceipt } from '../domains/conversation/intake';
import { MaterialLibrary } from '../domains/materials/library';
import { normalizeOpenRigUrl, OpenRigCatalog } from '../domains/runtime/openrig';

export class WorkspaceService {
  private tasks: TaskRepository;
  constructor(private db: DatabaseSync, readonly materials: MaterialLibrary) {
    this.tasks = new TaskRepository(db);
    db.exec('CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
  }

  snapshot(): Workspace {
    const setting = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('openrigUrl');
    return {
      tasks: this.tasks.list(), attachments: this.materials.list(),
      messages: [...this.db.prepare('SELECT payload FROM messages ORDER BY rowid').all(), ...this.db.prepare('SELECT payload FROM interactions ORDER BY rowid').all()]
        .map(row => JSON.parse(String(row.payload)) as Message).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      settings: { openrigUrl: setting ? String(setting.value) : 'http://127.0.0.1:7433' },
    };
  }

  recordInteraction(role: 'user' | 'assistant', text: string, channel: Message['channel'] = 'platform') {
    if (!text.trim()) return;
    const message: Message = { id: randomUUID(), role, channel, text: text.slice(0, 64000), createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO interactions VALUES (?,?)').run(message.id, JSON.stringify(message));
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

  saveConnection(value: unknown): Workspace {
    const url = normalizeOpenRigUrl(value);
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('openrigUrl', url);
    return this.snapshot();
  }

  async checkConnection(): Promise<ConnectionResult> {
    const checkedAt = new Date().toISOString();
    try {
      const teams = await new OpenRigCatalog(this.snapshot().settings.openrigUrl).listTeams();
      return { state: 'connected', checkedAt, teams };
    } catch (error) {
      return { state: 'unavailable', checkedAt, reason: error instanceof Error ? error.message : '连接失败。' };
    }
  }
}
