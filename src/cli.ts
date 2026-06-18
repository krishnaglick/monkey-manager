import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { upsertBlock } from './claude-md.js';
import { openDb, type DB } from './db.js';
import { register, heartbeat, touch, endSession, reap, check, branchSiblings } from './core.js';
import { formatConflicts, formatBranchSiblings } from './format.js';
import { record, reapEvents, stats } from './events.js';
import { nowSec } from './clock.js';

const TTL = (Number(process.env.MONKEY_MANAGER_TTL_MIN) || 30) * 60;
const MAX_ROWS = Number(process.env.MONKEY_MANAGER_MAX_ROWS) || 50;

export function dbPath(): string {
  return process.env.MONKEY_MANAGER_DB ?? join(homedir(), '.claude', 'monkey-manager', 'state.db');
}

export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_input?: { file_path?: string };
}

/** Run one hook subcommand against an open db. Returns the stdout to emit (or ''). */
export function runCommand(
  db: DB,
  cmd: string,
  p: HookPayload,
  now: number,
  ttl: number = TTL,
  maxRows: number = MAX_ROWS,
): string {
  const sid = p.session_id;
  const cwd = p.cwd ?? process.cwd();
  const filePath = p.tool_input?.file_path;
  switch (cmd) {
    case 'on-session-start': {
      let warn = '';
      if (sid) {
        const s = register(db, { session_id: sid, cwd }, now);
        record(db, now, 'register', { session_id: sid, repo: s.repo });
        // Same-branch siblings = a free feature-collision signal (no claim needed):
        // surface ONCE at start, not per-edit. Computed before reap (live filter
        // already excludes stale rows, so order is harmless either way).
        const sibs = branchSiblings(db, sid, now, ttl, maxRows);
        if (sibs.length) {
          warn =
            `⚠️ monkey-manager: ${sibs.length} other live session(s) on branch "${s.branch}":\n` +
            formatBranchSiblings(sibs) +
            '\nLikely the same feature. Coordinate (claim feature=<id>) or stop before duplicating work.';
        }
      }
      reap(db, now, ttl);
      reapEvents(db, now);
      const claudeMdPath = join(cwd, 'CLAUDE.md');
      if (existsSync(claudeMdPath)) upsertBlock(claudeMdPath);
      if (warn) {
        return JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: warn },
        });
      }
      return '';
    }
    case 'on-post-edit':
      if (sid && filePath) {
        touch(db, sid, filePath, now);
        record(db, now, 'post_edit', { session_id: sid, path: filePath });
      }
      return '';
    case 'on-stop':
      if (sid) heartbeat(db, sid, now);
      return '';
    case 'on-session-end':
      if (sid) {
        endSession(db, sid);
        record(db, now, 'session_end', { session_id: sid });
      }
      return '';
    case 'on-pre-edit':
      if (sid && filePath) {
        heartbeat(db, sid, now);
        // Check OTHER sessions first, THEN record our own intent. Order matters:
        // check excludes the caller, so recording before checking would be safe
        // too, but check-then-record keeps the warning strictly about peers and
        // closes the TOCTOU window where two sessions pre-edit the same file
        // before either reaches post-edit.
        const conflicts = check(db, sid, [filePath], 'repo', now, ttl, maxRows);
        touch(db, sid, filePath, now);
        record(db, now, 'pre_edit', {
          session_id: sid,
          path: filePath,
          detail: `warned=${conflicts.length > 0}`,
        });
        if (conflicts.length) {
          const body =
            '⚠️ monkey-manager: another session is working here:\n' +
            formatConflicts(conflicts, maxRows);
          // A deliberate `claim` is a hard reservation: escalate to a blocking
          // (but advisory) prompt via permissionDecision "ask" — never "deny",
          // so the user can still proceed. Plain `touch` overlaps stay advisory
          // (additionalContext, ignorable).
          const hasClaim = conflicts.some((c) => c.kind === 'claim');
          if (hasClaim) {
            return JSON.stringify({
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: body,
              },
            });
          }
          return JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: body,
            },
          });
        }
      }
      return '';
    default:
      return '';
  }
}

async function readStdin(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as HookPayload;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  // `stats` is an operator command with no stdin payload — handle it before
  // readStdin(), which would otherwise block on EOF at a terminal.
  if (cmd === 'stats') {
    try {
      mkdirSync(dirname(dbPath()), { recursive: true });
      process.stdout.write(stats(openDb(dbPath()), nowSec()) + '\n');
    } catch {
      // ignore
    }
    process.exit(0);
  }
  const p = await readStdin();
  let db: DB;
  try {
    mkdirSync(dirname(dbPath()), { recursive: true });
    db = openDb(dbPath());
  } catch {
    process.exit(0); // fail open — never block a tool on coordination errors
  }
  let out = '';
  try {
    out = runCommand(db, cmd, p, nowSec());
  } catch {
    // fail open
  }
  if (out) process.stdout.write(out);
  process.exit(0);
}

// Run main() only when invoked as the entrypoint (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('cli.js')) void main();
