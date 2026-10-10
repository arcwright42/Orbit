import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Message } from '../../contracts';
import { transaction } from '../../infrastructure/database';

interface HistoryRow { sequence: number; room_id: string; message_id: string; session_id: string | null; role: Message['role']|'tool'; channel: string; text: string; created_at: string; task_id: string | null }
const textPageSize = 8000;
function integer(value: unknown, fallback: number, max: number, label: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error(`Invalid history ${label}`);
  return Number(value);
}
/** Product-owned, append-only originals. Native harness compaction never mutates this store. */
export class ConversationHistory {
  readonly roomId: string;
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS conversation_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES conversation_rooms(id),
        message_id TEXT NOT NULL UNIQUE, session_id TEXT, role TEXT NOT NULL, channel TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, task_id TEXT);
      CREATE INDEX IF NOT EXISTS conversation_room_sequence ON conversation_messages(room_id, sequence);
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(text, content='conversation_messages', content_rowid='sequence', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS conversation_index_insert AFTER INSERT ON conversation_messages BEGIN
        INSERT INTO conversation_fts(rowid,text) VALUES (new.sequence,new.text); END;`);
    db.prepare('INSERT OR IGNORE INTO conversation_rooms VALUES (?,?)').run(randomUUID(), 'main');
    this.roomId = String(db.prepare("SELECT id FROM conversation_rooms WHERE name='main'").get()!.id);
    // One atomic backfill; re-opening cannot duplicate messages or reorder cursor identities.
    transaction(db, () => {
      if (db.prepare("SELECT 1 FROM settings WHERE key='historyMigrated'").get()) return;
      const legacy = [...db.prepare('SELECT payload FROM messages ORDER BY rowid').all(), ...db.prepare('SELECT payload FROM interactions ORDER BY rowid').all()]
        .map(row => JSON.parse(String(row.payload)) as Message).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
      for (const message of legacy) this.append(message);
      db.prepare("INSERT INTO settings VALUES ('historyMigrated','1')").run();
    });
  }
  append(message: Message, sessionId?: string) {
    this.db.prepare(`INSERT OR IGNORE INTO conversation_messages(room_id,message_id,session_id,role,channel,text,created_at,task_id)
      VALUES (?,?,?,?,?,?,?,?)`).run(this.roomId,message.id,sessionId ?? null,message.role,message.channel ?? 'platform',message.text,message.createdAt,message.taskId ?? null);
  }
  recordTool(callId:string,name:string,args:unknown,output:unknown) {
    const parts=callId.split(':'),channel=['text','voice'].includes(parts[0]) ? parts[0] : 'platform';
    this.db.prepare(`INSERT OR IGNORE INTO conversation_messages(room_id,message_id,session_id,role,channel,text,created_at)
      VALUES (?,?,?,'tool',?,?,?)`).run(this.roomId,'tool:'+callId,parts.length>2 ? parts[1] : null,channel,JSON.stringify({name,arguments:args,output:output ?? null}),new Date().toISOString());
  }
  private roles(input:Record<string,unknown>) {
    if(input.include_tools!==undefined && typeof input.include_tools!=='boolean') throw new Error('Invalid include_tools');
    return input.include_tools ? '' : " AND role<>'tool'";
  }
  private scope(value: unknown) { if (value !== undefined && value !== this.roomId) throw new Error('Unknown or inaccessible history room'); return this.roomId; }
  search(input: Record<string, unknown>) {
    const room = this.scope(input.room_id), limit = integer(input.limit, 10, 50, 'limit');
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500) throw new Error('Invalid history query');
    // Trigram indexes Chinese and Latin substrings without a tokenizer service. Short tokens use
    // a literal fallback; quotes/operators are never treated as caller-supplied FTS syntax.
    const terms = [...new Set(input.query.trim().split(/\s+/u))].slice(0,20);
    const indexed = terms.filter(t => [...t].length >= 3), short = terms.filter(t => [...t].length < 3);
    const predicates: string[] = [], bindings: SQLInputValue[] = [room];
    if (indexed.length) { predicates.push('sequence IN (SELECT rowid FROM conversation_fts WHERE conversation_fts MATCH ?)'); bindings.push(indexed.map(t => '"' + t.replaceAll('"','""') + '"').join(' OR ')); }
    for (const term of short) { predicates.push('instr(lower(text),lower(?))>0'); bindings.push(term); }
    const rows = this.db.prepare(`SELECT * FROM conversation_messages WHERE room_id=?${this.roles(input)} AND (${predicates.join(' OR ')}) ORDER BY sequence DESC LIMIT ?`).all(...bindings,limit) as unknown as HistoryRow[];
    return { room_id: room, matches: rows.map(row => {
      const hit = terms.map(term => row.text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())).filter(n => n >= 0);
      const start = Math.max(0,(hit.length ? Math.min(...hit) : 0)-60);
      return { room_id:room,message_id:row.message_id,sequence:row.sequence,role:row.role,channel:row.channel,created_at:row.created_at,excerpt:row.text.slice(start,start+240) };
    }) };
  }
  read(input: Record<string, unknown>) {
    const room = this.scope(input.room_id), offset = integer(input.text_offset,0,Number.MAX_SAFE_INTEGER,'text_offset'),roles=this.roles(input);
    let rows: HistoryRow[];
    if (input.message_id !== undefined) {
      if (typeof input.message_id !== 'string') throw new Error('Invalid history message_id');
      const anchor = this.db.prepare('SELECT * FROM conversation_messages WHERE room_id=? AND message_id=?').get(room,input.message_id) as unknown as HistoryRow | undefined;
      if (!anchor) throw new Error('History message not found in this room');
      const before = integer(input.before,3,20,'before'), after = integer(input.after,5,20,'after');
      if (offset && (before || after) || offset > anchor.text.length) throw new Error('text_offset requires before=0, after=0 and an offset within the message');
      const prior = this.db.prepare(`SELECT * FROM conversation_messages WHERE room_id=?${roles} AND sequence<? ORDER BY sequence DESC LIMIT ?`).all(room,anchor.sequence,before) as unknown as HistoryRow[];
      const next = this.db.prepare(`SELECT * FROM conversation_messages WHERE room_id=?${roles} AND sequence>? ORDER BY sequence LIMIT ?`).all(room,anchor.sequence,after) as unknown as HistoryRow[];
      rows = [...prior.reverse(),anchor,...next];
    } else {
      if (offset) throw new Error('text_offset requires message_id');
      const cursor = integer(input.cursor,0,Number.MAX_SAFE_INTEGER,'cursor'), limit = integer(input.limit,20,50,'limit');
      rows = this.db.prepare(`SELECT * FROM conversation_messages WHERE room_id=?${roles} AND sequence>? ORDER BY sequence LIMIT ?`).all(room,cursor,limit) as unknown as HistoryRow[];
    }
    // Bound tool output independently of retained history, including JSON escaping / CJK bytes.
    const pages=rows.map(row=> {
      let length=textPageSize;
      const make=()=>({...row,text:row.text.slice(offset,offset+length),text_offset:offset,text_length:row.text.length,
        ...(offset+length<row.text.length ? {next_text_offset:offset+length} : {})});
      let page=make();while(Buffer.byteLength(JSON.stringify(page))>7900 && length>1) {length=Math.floor(length/2);page=make();}return page;
    });
    const messages:typeof pages=[];let budget=8000;
    const anchor=pages.findIndex(p=>p.message_id===input.message_id);
    const candidates=anchor>=0 ? [...pages].sort((a,b)=>Math.abs(a.sequence-pages[anchor].sequence)-Math.abs(b.sequence-pages[anchor].sequence)) : pages;
    for(const page of candidates) {
      const size=Buffer.byteLength(JSON.stringify(page));if(messages.length && size>budget) {if(anchor<0) break;continue;}
      messages.push(page);budget-=size;
    }
    messages.sort((a,b)=>a.sequence-b.sequence);
    const last = messages.at(-1)?.sequence ?? integer(input.cursor,0,Number.MAX_SAFE_INTEGER,'cursor');
    return { room_id:room, messages, next_cursor:last, context_truncated:messages.length<rows.length,
      has_more:!!this.db.prepare(`SELECT 1 FROM conversation_messages WHERE room_id=?${roles} AND sequence>? LIMIT 1`).get(room,last) };
  }
  clues(): string {
    const max = Number(this.db.prepare('SELECT max(sequence) AS n FROM conversation_messages WHERE room_id=?').get(this.roomId)?.n ?? 0);
    if (!max) return `\n对话 Room：${this.roomId}。`;
    const rows = this.db.prepare(`SELECT message_id,created_at,text,max(sequence) AS sequence FROM conversation_messages
      WHERE room_id=? AND role='user' GROUP BY CAST(sequence / ? AS INTEGER) ORDER BY sequence`).all(this.roomId,Math.max(1,Math.ceil(max/12)));
    return `\n对话 Room：${this.roomId}。历史线索抽样（不是完整目录；细节用 search_history / read_history）：\n` + rows.map(row => JSON.stringify({message_id:row.message_id,date:row.created_at,excerpt:String(row.text).slice(0,100)})).join('\n') + '\n';
  }
}
