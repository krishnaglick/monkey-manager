import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDb, type DB } from './db.js';
import { register, heartbeat, claim, release, check, active, whoami, reap } from './core.js';
import { record, reapEvents, stats } from './events.js';
import { formatConflicts } from './format.js';
import { resolveIdentity } from './repo.js';
import { nowSec } from './clock.js';

interface Opts {
  ttl: number;
  maxRows: number;
  now: () => number;
}

/** Pure, testable tool implementations. */
export function makeTools(db: DB, sessionId: string, o: Opts) {
  const beat = () => heartbeat(db, sessionId, o.now());
  return {
    check: (a: { paths: string[]; scope?: 'repo' | 'worktree' }) => {
      beat();
      const c = check(db, sessionId, a.paths, a.scope ?? 'repo', o.now(), o.ttl, o.maxRows);
      record(db, o.now(), 'check', { session_id: sessionId, detail: `conflicts=${c.length}` });
      return c.length ? formatConflicts(c, o.maxRows) : 'CLEAR';
    },
    claim: (a: { path: string; note: string }) => {
      const c = claim(db, sessionId, a.path, a.note, o.now(), o.ttl, o.maxRows);
      record(db, o.now(), 'claim', {
        session_id: sessionId,
        path: a.path,
        detail: `conflicts=${c.length}`,
      });
      return c.length ? 'CLAIMED (conflicts):\n' + formatConflicts(c, o.maxRows) : 'CLAIMED';
    },
    release: (_a: Record<string, never>) => {
      release(db, sessionId);
      record(db, o.now(), 'release', { session_id: sessionId });
      return 'RELEASED';
    },
    active: (a: { scope?: 'repo' | 'worktree' }) => {
      beat();
      const rows = active(db, sessionId, a.scope ?? 'repo', o.now(), o.ttl, o.maxRows);
      if (!rows.length) return 'none';
      return rows
        .map(
          (r) =>
            `${r.path}\t${r.session_id.slice(0, 8)} ${r.branch ?? '-'} ${r.kind}${r.note ? ` "${r.note}"` : ''}`,
        )
        .join('\n');
    },
    whoami: (_a: Record<string, never>) => {
      const w = whoami(db, sessionId);
      return w
        ? `${w.session_id.slice(0, 8)} ${w.repo_label} ${w.branch ?? '-'} ${w.worktree}`
        : 'unknown';
    },
    stats: (_a: Record<string, never>) => stats(db, o.now()),
  };
}

/** Input schema for the `claim` tool. Exported so the note length cap is testable. */
export const claimInputSchema = { path: z.string(), note: z.string().max(200) };

function getSessionId(): string {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv) return fromEnv;
  const id = resolveIdentity(process.cwd());
  return `mcp:${id.repo}:${process.pid}`;
}

async function start(): Promise<void> {
  const DB_PATH =
    process.env.MONKEY_MANAGER_DB ?? join(homedir(), '.claude', 'monkey-manager', 'state.db');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  const ttl = (Number(process.env.MONKEY_MANAGER_TTL_MIN) || 30) * 60;
  const maxRows = Number(process.env.MONKEY_MANAGER_MAX_ROWS) || 50;
  const sessionId = getSessionId();

  register(db, { session_id: sessionId, cwd: process.cwd() }, nowSec());
  reap(db, nowSec(), ttl);
  reapEvents(db, nowSec());

  const tools = makeTools(db, sessionId, { ttl, maxRows, now: nowSec });
  const server = new McpServer({ name: 'monkey-manager', version: '0.1.0' });

  server.registerTool(
    'check',
    {
      description: 'Check if paths are being worked on by other sessions.',
      inputSchema: { paths: z.array(z.string()), scope: z.enum(['repo', 'worktree']).optional() },
    },
    async (a) => ({ content: [{ type: 'text', text: tools.check(a) }] }),
  );
  server.registerTool(
    'claim',
    {
      description:
        'Claim/annotate a file or directory (trailing /); re-claim the same path to update its note.',
      inputSchema: claimInputSchema,
    },
    async (a) => ({ content: [{ type: 'text', text: tools.claim(a) }] }),
  );
  server.registerTool(
    'release',
    { description: 'Release all claims held by this session.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: tools.release({}) }] }),
  );
  server.registerTool(
    'active',
    {
      description: 'List active work in scope.',
      inputSchema: { scope: z.enum(['repo', 'worktree']).optional() },
    },
    async (a) => ({ content: [{ type: 'text', text: tools.active(a) }] }),
  );
  server.registerTool(
    'whoami',
    { description: 'Show this session identity.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: tools.whoami({}) }] }),
  );
  server.registerTool(
    'stats',
    { description: 'Show usage stats: event counts (24h + total) and live sessions.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: tools.stats({}) }] }),
  );

  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) void start();
