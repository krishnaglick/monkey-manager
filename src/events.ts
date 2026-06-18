import type { DB } from './db.js';

// Usage tracking. On by default; set MONKEY_MANAGER_LOG=0 to disable.
// Self-contained and fail-open: every export swallows its own errors so a
// logging failure can never break a hook or an MCP tool call.
//
// To remove entirely: delete this file, grep-delete record()/reapEvents()
// call sites in src/cli.ts and src/server.ts, and drop the `events` table
// from migrate() in src/db.ts. Core is never touched.

const RETENTION_SEC = (Number(process.env.MONKEY_MANAGER_LOG_DAYS) || 7) * 86400;

function enabled(): boolean {
  // On by default; set MONKEY_MANAGER_LOG=0 / false to disable.
  const v = process.env.MONKEY_MANAGER_LOG;
  return v !== '0' && v !== 'false';
}

export interface EventFields {
  session_id?: string;
  repo?: string;
  path?: string;
  detail?: string;
}

/** Record one event. No-op when logging is off. Never throws. */
export function record(db: DB, now: number, ev: string, f: EventFields = {}): void {
  if (!enabled()) return;
  try {
    db.prepare(
      'INSERT INTO events (ts, ev, session_id, repo, path, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(now, ev, f.session_id ?? null, f.repo ?? null, f.path ?? null, f.detail ?? null);
  } catch {
    // fail open — logging must never break coordination
  }
}

/** Delete events older than the retention window. No-op when off. Never throws. */
export function reapEvents(db: DB, now: number): void {
  if (!enabled()) return;
  try {
    db.prepare('DELETE FROM events WHERE ts <= ?').run(now - RETENTION_SEC);
  } catch {
    // fail open
  }
}

interface CountRow {
  ev: string;
  total: number;
  day: number;
  warned: number;
}

interface SessionRow {
  session_id: string;
  repo_label: string;
  branch: string | null;
  last_seen: number;
  last_ev: number | null;
}

function ago(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** Render the operator stats table (counts per event, total + last 24h). */
export function stats(db: DB, now: number): string {
  const dayAgo = now - 86400;
  const rows = db
    .prepare(
      `SELECT ev,
              count(*) AS total,
              sum(CASE WHEN ts > ? THEN 1 ELSE 0 END) AS day,
              sum(CASE WHEN detail = 'warned=true' THEN 1 ELSE 0 END) AS warned
       FROM events GROUP BY ev ORDER BY ev`,
    )
    .all(dayAgo) as unknown as CountRow[];

  const header = 'event        24h   total';
  if (!rows.length) return header + '\n(no events — set MONKEY_MANAGER_LOG=1 to enable)';
  const lines = rows.map((r) => {
    const base = `${r.ev.padEnd(12)}${String(r.day).padStart(3)} ${String(r.total).padStart(7)}`;
    if (r.ev === 'pre_edit') {
      const total = db.prepare("SELECT count(*) AS n FROM events WHERE ev='pre_edit'").get() as {
        n: number;
      };
      return `${base}   (warned: ${r.warned} / ${total.n})`;
    }
    return base;
  });

  // Per-session liveness — spot a stuck/idle agent. `idle` = since last heartbeat
  // (any turn/edit/MCP call); `last_action` = since the last logged coordination
  // event (null if none). A big idle = possibly hung; a big last_action with small
  // idle = looping but not coordinating.
  const sessions = db
    .prepare(
      `SELECT s.session_id, s.repo_label, s.branch, s.last_seen,
              (SELECT max(ts) FROM events e WHERE e.session_id = s.session_id) AS last_ev
       FROM sessions s ORDER BY s.last_seen ASC`,
    )
    .all() as unknown as SessionRow[];

  const out = [header, ...lines];
  if (sessions.length) {
    out.push('', 'session   idle  last_action  repo/branch');
    for (const s of sessions) {
      const idle = ago(now - s.last_seen);
      const last = s.last_ev == null ? '-' : ago(now - s.last_ev);
      out.push(
        `${s.session_id.slice(0, 8).padEnd(8)} ${idle.padStart(4)} ${last.padStart(11)}  ${s.repo_label}/${s.branch ?? '-'}`,
      );
    }
  }
  return out.join('\n');
}
