import { DatabaseSync } from 'node:sqlite';

/** Separate file from the desktop intake database; never pass orbit.sqlite here. */
export function openCoreDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (tables.length && !tables.some(row => row.name === 'core_meta')) {
      throw new Error('Expected a dedicated Orbit core database.');
    }
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS core_meta (version INTEGER NOT NULL);');
    const version = Number(db.prepare('SELECT version FROM core_meta').get()?.version ?? 0);
    if (version > 1) throw new Error('Core database requires a newer Orbit version.');
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS execution_queue (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_payload TEXT NOT NULL,
        task_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
        body TEXT NOT NULL, priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2),
        state TEXT NOT NULL CHECK(state IN ('pending','in-progress','blocked','done','failed','denied','canceled','handed-off')),
        generation TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        blocked_on TEXT, resolution TEXT, evidence_ref TEXT,
        parent_id TEXT REFERENCES execution_queue(id), successor_id TEXT REFERENCES execution_queue(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_pickup ON execution_queue(state, priority DESC, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS queue_one_owner ON execution_queue(destination) WHERE state = 'in-progress';
      CREATE TABLE IF NOT EXISTS execution_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES execution_queue(id),
        state TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, key TEXT NOT NULL,
        taxonomy TEXT NOT NULL, content TEXT NOT NULL, source_ref TEXT NOT NULL,
        revision INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(scope_kind, scope_id, key)
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope_kind, scope_id, enabled);
      INSERT INTO core_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM core_meta);
      COMMIT;
    `);
    return db;
  } catch (error) { db.close(); throw error; }
}
