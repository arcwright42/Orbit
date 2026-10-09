import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > 1) {
    db.close();
    throw new Error('数据来自较新的 Orbit 版本，请升级客户端。');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, payload TEXT NOT NULL, stored_path TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
  `);
  return db;
}

let savepointSequence = 0;
/** Domain operations can join an outer workflow transaction without committing it. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const savepoint = db.isTransaction ? `orbit_${++savepointSequence}` : undefined;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    if (savepoint) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); }
    else db.exec('ROLLBACK');
    throw error;
  }
}
