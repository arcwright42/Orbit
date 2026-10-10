import { validateMarkdownAddressability, recapAdvisories } from '../context/files';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore } from './store';
import type { Seat, TeamRegistry } from '../teams/registry';
import type { QueueItem, KnowledgeCheckpoint } from '../orchestration/types';
import type { RuntimeEvidence } from '../runtime/codex';
import { transaction } from '../../infrastructure/database';

/** Team-owned, stable-seat knowledge; task/native session identity never owns experience.
 * Evidence-keyed versions make replay idempotent. Originals stay in recap-superseded.
 */
export class TeamKnowledge {
  constructor(private memory: MemoryStore, private teams: TeamRegistry, private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS knowledge_projections (record_key TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE IF NOT EXISTS seat_recaps (seq INTEGER PRIMARY KEY AUTOINCREMENT, record_key TEXT NOT NULL UNIQUE, seat_id TEXT NOT NULL, content TEXT NOT NULL, source_seq INTEGER)');
    db.exec('CREATE TABLE IF NOT EXISTS knowledge_checkpoints (record_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, item_id TEXT NOT NULL, generation TEXT NOT NULL, payload TEXT NOT NULL, source_ref TEXT NOT NULL, source_seq INTEGER NOT NULL)');
    if(!db.prepare('PRAGMA table_info(seat_recaps)').all().some(c=>c.name==='source_seq')) transaction(db,()=> {
      db.exec('ALTER TABLE seat_recaps ADD COLUMN source_seq INTEGER');
      db.exec(`UPDATE seat_recaps SET source_seq=(SELECT min(e.seq) FROM execution_events e JOIN execution_queue q ON q.id=e.item_id
        WHERE q.id || '-' || q.generation=seat_recaps.record_key AND e.state='done')`);
    });
  }
  /** An authenticated running attempt can checkpoint before handoff, waiting or compaction.
   * The journal commits independently of task completion; file projection is retryable.
   */
  checkpoint(seat: Seat, item: QueueItem, knowledge: KnowledgeCheckpoint, requestId: string) {
    return transaction(this.db,()=> {
      const live=this.db.prepare('SELECT * FROM execution_queue WHERE id=?').get(item.id);
      if(!live || live.generation!==item.generation || live.destination!==seat.sessionId || live.state!=='in-progress' || live.cancel_requested || this.teams.seat(seat.sessionId).generation!==seat.generation) throw new Error('执行义务已结束、取消或换代');
      return this.capture(seat,item,knowledge,`tool:${requestId}`);
    });
  }
  recordClosure(seat: Seat,item: QueueItem,knowledge: KnowledgeCheckpoint) {
    return this.capture(seat,item,knowledge,'closure');
  }
  private capture(seat: Seat,item: QueueItem,knowledge: KnowledgeCheckpoint,requestId: string) {
    for(const value of [knowledge.recap,knowledge.lessons]) if(value!==undefined && (typeof value!=='string' || value.length>16000)) throw new Error('Invalid authored knowledge');
    const recap=knowledge.recap?.trim() ?? '',lessons=knowledge.lessons?.trim() ?? '';
    if(!recap && !lessons) throw new Error('Knowledge checkpoint is empty');
    if(recap) validateMarkdownAddressability(recap);
    const key=`checkpoint-${createHash('sha256').update(`${item.id}:${item.generation}:${requestId}`).digest('hex')}`;
    const payload=JSON.stringify({recap,lessons}),sourceRef=knowledge.sourceRef ?? `orbit://execution/${item.id}/${item.generation}/${key}`;
    const prior=this.db.prepare('SELECT * FROM knowledge_checkpoints WHERE record_key=?').get(key);
    if(prior) {
      if(prior.payload!==payload || prior.source_ref!==sourceRef || prior.session_id!==seat.sessionId) throw new Error('Checkpoint ID reused with different content');
      return {recorded:true,recordKey:key,sourceRef:String(prior.source_ref)};
    }
    // Share the queue event clock with completion records so delayed projection cannot
    // replace a newer checkpoint, even if wall time steps backwards.
    const event=this.db.prepare('INSERT INTO execution_events (item_id,state,actor,note,at) VALUES (?,?,?,?,?)').run(item.id,item.state,'knowledge',`保存席位交接记录 ${key}`,new Date().toISOString());
    this.db.prepare('INSERT INTO knowledge_checkpoints VALUES (?,?,?,?,?,?,?)').run(key,seat.sessionId,item.id,item.generation!,payload,sourceRef,event.lastInsertRowid);
    return {recorded:true,recordKey:key,sourceRef};
  }
  flushCheckpoints() {
    const failures: unknown[]=[];
    for(const row of this.db.prepare('SELECT * FROM knowledge_checkpoints k WHERE NOT EXISTS (SELECT 1 FROM knowledge_projections p WHERE p.record_key=k.record_key) ORDER BY source_seq').all()) {
      try {
        const item=this.db.prepare('SELECT task_id FROM execution_queue WHERE id=?').get(row.item_id)!;
        const knowledge=JSON.parse(String(row.payload)) as KnowledgeCheckpoint;
        this.project(this.teams.seat(String(row.session_id)),String(row.record_key),String(item.task_id),knowledge.recap ?? '',knowledge.lessons ?? '',String(row.source_ref),Number(row.source_seq));
      } catch(error) { failures.push(error); }
    }
    if(failures.length) throw new AggregateError(failures,'Checkpoint file projection pending; journal retained');
  }
  projected(recordKey:string) {return !!this.db.prepare('SELECT 1 FROM knowledge_projections WHERE record_key=?').get(recordKey);}
  record(seat: Seat, item: QueueItem, evidence: RuntimeEvidence) {
    const source=this.db.prepare("SELECT min(seq) AS seq FROM execution_events WHERE item_id=? AND state='done'").get(item.id);
    this.project(seat,`${item.id}-${item.generation}`,item.taskId,evidence.recap || evidence.summary,evidence.lessons ?? '',item.evidenceRef!,source?.seq == null ? null : Number(source.seq));
  }
  private project(seat: Seat,key: string,taskId: string,recap: string,lessons: string,sourceRef: string,sourceSeq: number | null) {
    const root = this.teams.seatRoot(seat); mkdirSync(join(root, 'recap-superseded'), { recursive: true });
    const version = join(root, 'recap-superseded', `${key}.md`);
    // Provenance is a preamble, not an invented heading that can collide with the author's addresses.
    const content = `来源：${sourceRef}\n任务：${taskId}\n\n${recap}\n`;
    if(recap.trim()) {
      validateMarkdownAddressability(content);
      if (!existsSync(version)) this.archive(version,content);
      this.db.prepare('INSERT OR IGNORE INTO seat_recaps (record_key,seat_id,content,source_seq) VALUES (?,?,?,?)').run(key, seat.id, readFileSync(version, 'utf8'),sourceSeq);
      const latest = this.db.prepare('SELECT content FROM seat_recaps WHERE seat_id=? ORDER BY coalesce(source_seq,0) DESC,seq DESC LIMIT 1').get(seat.id)!;
      this.atomic(join(root, 'RECAP.advisories.json'), JSON.stringify(recapAdvisories(String(latest.content))));
      this.atomic(join(root, 'RECAP.md'), String(latest.content));
    }
    if (lessons.trim()) {
      const scope = { kind: 'team' as const, id: seat.teamId };
      if (!this.memory.list(scope).some(m => m.key === key)) this.memory.put({ scope, key, taxonomy: 'lore', content: `[${seat.role}] ${lessons}`, sourceRef }, 0);
      this.atomic(join(root, 'LEARNED.md'), this.memory.list(scope).filter(m => m.enabled && m.content.startsWith(`[${seat.role}]`)).map(m => `## ${m.key}\n来源：${m.sourceRef}\n${m.content}`).join('\n\n'));
    }
    this.db.prepare('INSERT OR IGNORE INTO knowledge_projections VALUES (?)').run(key);
  }
  context(seat: Seat, query: string) {
    const root = this.teams.seatRoot(seat); mkdirSync(root, { recursive: true });
    const recap = join(root, 'RECAP.md');
    return [existsSync(recap) ? `[seat:RECAP.md]\n${readFileSync(recap, 'utf8')}` : '', this.memory.context([{ kind: 'team', id: seat.teamId }], query, 16000).text].filter(Boolean).join('\n\n');
  }
  private archive(path:string,content:string) {
    const temp=`${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp,content,{flag:'wx'});
      try { linkSync(temp,path); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
    } finally {rmSync(temp,{force:true});}
  }
  private atomic(path: string, content: string) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {writeFileSync(temp, content,{flag:'wx'}); renameSync(temp, path);} finally {rmSync(temp,{force:true});}
  }
}
