import { DatabaseSync } from 'node:sqlite';

export type Kind = 'claim' | 'touch';

export interface SessionRow {
  session_id: string;
  repo: string;
  repo_label: string;
  worktree: string;
  branch: string | null;
  cwd: string;
  started_at: number;
  last_seen: number;
}

export interface WorkRow {
  id: number;
  session_id: string;
  repo: string;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
}

export type DB = DatabaseSync;

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repo       TEXT NOT NULL,
      repo_label TEXT NOT NULL,
      worktree   TEXT NOT NULL,
      branch     TEXT,
      cwd        TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work (
      id         INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo       TEXT NOT NULL,
      worktree   TEXT NOT NULL,
      path       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_dedupe
      ON work (repo, session_id, worktree, path, kind);
    CREATE INDEX IF NOT EXISTS work_repo ON work (repo);
    -- usage tracking (optional, gated by MONKEY_MANAGER_LOG; see src/events.ts).
    -- Always created (empty table is free); removal: drop this block + src/events.ts.
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY,
      ts         INTEGER NOT NULL,
      ev         TEXT NOT NULL,
      session_id TEXT,
      repo       TEXT,
      path       TEXT,
      detail     TEXT
    );
  `);
}

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}
