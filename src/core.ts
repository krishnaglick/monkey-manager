import type { DB, SessionRow, Kind } from './db.js';
import { resolveIdentity } from './repo.js';
import { normalizePath, pathsOverlap } from './paths.js'; // normalizePath used in Task 5; pathsOverlap used in Task 6

export type Scope = 'repo' | 'worktree';

export interface Conflict {
  path: string;
  session_id: string;
  repo_label: string;
  branch: string | null;
  worktree: string;
  kind: Kind;
  note: string | null;
  age_sec: number;
  cross_worktree: boolean;
}

export function getSession(db: DB, session_id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session_id) as
    | SessionRow
    | undefined;
}

export function register(db: DB, p: { session_id: string; cwd: string }, now: number): SessionRow {
  // Identity is frozen at first registration; later SessionStarts only heartbeat
  // (avoids re-running git on every repeated SessionStart, and makes the freeze explicit).
  if (getSession(db, p.session_id)) {
    heartbeat(db, p.session_id, now);
    return getSession(db, p.session_id)!;
  }
  const id = resolveIdentity(p.cwd);
  db.prepare(`
    INSERT INTO sessions (session_id, repo, repo_label, worktree, branch, cwd, started_at, last_seen)
    VALUES (@session_id, @repo, @repo_label, @worktree, @branch, @cwd, @now, @now)
    ON CONFLICT(session_id) DO UPDATE SET last_seen = @now
  `).run({
    session_id: p.session_id,
    repo: id.repo,
    repo_label: id.repoLabel,
    worktree: id.worktree,
    branch: id.branch,
    cwd: id.cwd,
    now,
  });
  return getSession(db, p.session_id)!;
}

export function heartbeat(db: DB, session_id: string, now: number): void {
  db.prepare('UPDATE sessions SET last_seen = ? WHERE session_id = ?').run(now, session_id);
}

export function whoami(
  db: DB,
  session_id: string,
): Pick<SessionRow, 'session_id' | 'repo_label' | 'worktree' | 'branch'> | null {
  const s = getSession(db, session_id);
  return s
    ? { session_id: s.session_id, repo_label: s.repo_label, worktree: s.worktree, branch: s.branch }
    : null;
}

export function touch(db: DB, session_id: string, absFilePath: string, now: number): void {
  const s = getSession(db, session_id);
  if (!s) return;
  const path = normalizePath(absFilePath, s.worktree);
  db.prepare(`
    INSERT OR IGNORE INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'touch', NULL, ?)
  `).run(session_id, s.repo, s.worktree, path, now);
  heartbeat(db, session_id, now);
}

export function claim(
  db: DB,
  session_id: string,
  rawPath: string,
  note: string,
  now: number,
  ttl: number,
  maxRows: number = 50,
): Conflict[] {
  const s = getSession(db, session_id);
  if (!s) return [];
  const path = normalizePath(rawPath, s.worktree);
  db.prepare(`
    INSERT INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'claim', ?, ?)
    ON CONFLICT(repo, session_id, worktree, path, kind)
    DO UPDATE SET note = excluded.note
  `).run(session_id, s.repo, s.worktree, path, note, now);
  heartbeat(db, session_id, now);
  return check(db, session_id, [path], 'repo', now, ttl, maxRows);
}

export function release(db: DB, session_id: string): void {
  db.prepare("DELETE FROM work WHERE session_id = ? AND kind = 'claim'").run(session_id);
}

interface JoinedRow {
  session_id: string;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
  repo_label: string;
  branch: string | null;
}

export function check(
  db: DB,
  session_id: string,
  paths: string[],
  scope: Scope,
  now: number,
  ttl: number,
  maxRows: number,
): Conflict[] {
  const me = getSession(db, session_id);
  if (!me) return [];
  const cutoff = now - ttl;

  const sql = `
    SELECT w.session_id, w.worktree, w.path, w.kind, w.note, w.created_at,
           s.repo_label, s.branch
    FROM work w JOIN sessions s ON s.session_id = w.session_id
    WHERE w.repo = ? AND w.session_id != ? AND s.last_seen > ?
    ${scope === 'worktree' ? 'AND w.worktree = ?' : ''}
  `;
  const args =
    scope === 'worktree' ? [me.repo, session_id, cutoff, me.worktree] : [me.repo, session_id, cutoff];
  const rows = db.prepare(sql).all(...args) as unknown as JoinedRow[];

  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const qp = normalizePath(raw, me.worktree);
    const bySession = new Map<string, JoinedRow>();
    for (const r of rows) {
      if (!pathsOverlap(qp, r.path)) continue;
      const cur = bySession.get(r.session_id);
      if (!cur || (cur.kind === 'touch' && r.kind === 'claim')) bySession.set(r.session_id, r);
    }
    for (const r of bySession.values()) {
      const key = `${qp}|${r.session_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: qp,
        session_id: r.session_id,
        repo_label: r.repo_label,
        branch: r.branch,
        worktree: r.worktree,
        kind: r.kind,
        note: r.note,
        age_sec: now - r.created_at,
        cross_worktree: r.worktree !== me.worktree,
      });
    }
  }
  return out.slice(0, maxRows);
}

export interface ActiveRow {
  session_id: string;
  repo_label: string;
  branch: string | null;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
}

export function active(
  db: DB,
  session_id: string,
  scope: Scope,
  now: number,
  ttl: number,
  maxRows: number,
): ActiveRow[] {
  const me = getSession(db, session_id);
  if (!me) return [];
  const cutoff = now - ttl;
  const sql = `
    SELECT w.session_id, w.path, w.kind, w.note, w.created_at,
           s.repo_label, s.branch, s.worktree
    FROM work w JOIN sessions s ON s.session_id = w.session_id
    WHERE w.repo = ? AND s.last_seen > ?
    ${scope === 'worktree' ? 'AND w.worktree = ?' : ''}
    ORDER BY w.created_at DESC
    LIMIT ?
  `;
  const args =
    scope === 'worktree'
      ? [me.repo, cutoff, me.worktree, maxRows]
      : [me.repo, cutoff, maxRows];
  return db.prepare(sql).all(...args) as unknown as ActiveRow[];
}

export function reap(db: DB, now: number, ttl: number): void {
  const cutoff = now - ttl;
  db.prepare(
    'DELETE FROM work WHERE session_id IN (SELECT session_id FROM sessions WHERE last_seen <= ?)',
  ).run(cutoff);
  db.prepare('DELETE FROM work WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
  db.prepare('DELETE FROM sessions WHERE last_seen <= ?').run(cutoff);
}

export function endSession(db: DB, session_id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM work WHERE session_id = ?').run(session_id);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(session_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
