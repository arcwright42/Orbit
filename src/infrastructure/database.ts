import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > 2) {
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
    CREATE TABLE IF NOT EXISTS task_steps (
      task_id TEXT NOT NULL REFERENCES tasks(id), id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (task_id, id)
    );
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_runs_by_task ON task_runs(task_id);
    CREATE TABLE IF NOT EXISTS task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events(task_id, seq);
    CREATE TABLE IF NOT EXISTS execution_settings (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_tool_receipts (
      run_id TEXT NOT NULL REFERENCES task_runs(id), call_id TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(run_id, call_id)
    );
    PRAGMA user_version = 2;
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
