import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store';
import type { Seat, TeamRegistry } from '../teams/registry';
import type { QueueItem } from '../orchestration/types';
import type { RuntimeEvidence } from '../runtime/codex';

/** Team-owned, stable-seat knowledge; task/native session identity never owns experience.
 * Evidence-keyed versions make replay idempotent. Originals stay in recap-superseded.
 */
export class TeamKnowledge {
  constructor(private memory: MemoryStore, private teams: TeamRegistry, private db: DatabaseSync) { db.exec('CREATE TABLE IF NOT EXISTS knowledge_projections (record_key TEXT PRIMARY KEY)'); db.exec('CREATE TABLE IF NOT EXISTS seat_recaps (seq INTEGER PRIMARY KEY AUTOINCREMENT, record_key TEXT NOT NULL UNIQUE, seat_id TEXT NOT NULL, content TEXT NOT NULL)'); }
  record(seat: Seat, item: QueueItem, evidence: RuntimeEvidence) {
    const root = this.teams.seatRoot(seat); mkdirSync(join(root, 'recap-superseded'), { recursive: true });
    const key = `${item.id}-${item.generation}`;
    const version = join(root, 'recap-superseded', `${key}.md`);
    const content = `# 交接记录\n\n来源：${item.evidenceRef}\n任务：${item.taskId}\n\n${evidence.recap || evidence.summary}\n`;
    if (!existsSync(version)) writeFileSync(version, content, { flag: 'wx' });
    this.db.prepare('INSERT OR IGNORE INTO seat_recaps (record_key,seat_id,content) VALUES (?,?,?)').run(key, seat.id, readFileSync(version, 'utf8'));
    const latest = this.db.prepare('SELECT content FROM seat_recaps WHERE seat_id=? ORDER BY seq DESC LIMIT 1').get(seat.id)!;
    this.atomic(join(root, 'RECAP.md'), String(latest.content));
    if (evidence.lessons?.trim()) {
      const scope = { kind: 'team' as const, id: seat.teamId };
      if (!this.memory.list(scope).some(m => m.key === key)) this.memory.put({ scope, key, taxonomy: 'lore', content: `[${seat.role}] ${evidence.lessons}`, sourceRef: item.evidenceRef! }, 0);
      this.atomic(join(root, 'LEARNED.md'), this.memory.list(scope).filter(m => m.enabled && m.content.startsWith(`[${seat.role}]`)).map(m => `## ${m.key}\n来源：${m.sourceRef}\n${m.content}`).join('\n\n'));
    }
    this.db.prepare('INSERT OR IGNORE INTO knowledge_projections VALUES (?)').run(key);
  }
  context(seat: Seat, query: string) {
    const root = this.teams.seatRoot(seat); mkdirSync(root, { recursive: true });
    const recap = join(root, 'RECAP.md');
    return [existsSync(recap) ? `[seat:RECAP.md]\n${readFileSync(recap, 'utf8')}` : '', this.memory.context([{ kind: 'team', id: seat.teamId }], query, 16000).text].filter(Boolean).join('\n\n');
  }
  private atomic(path: string, content: string) { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, content); renameSync(temp, path); }
}
