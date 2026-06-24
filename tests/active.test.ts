import { expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { activeSessionFile, publishActiveSession, readActiveSession } from '../src/active.js';
import { openDb } from '../src/db.js';
import { register, reap } from '../src/core.js';
import { makeTools } from '../src/server.js';

const dbPath = (dir: string) => join(dir, 'state.db');

test('publish then read round-trips the session id, keyed by worktree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-active-'));
  const db = dbPath(dir);
  publishActiveSession(db, '/some/worktree', 'sess-123');
  expect(readActiveSession(db, '/some/worktree')).toBe('sess-123');
  // A different worktree has a different file → no cross-talk.
  expect(readActiveSession(db, '/other/worktree')).toBeNull();
});

test('file key matches the sha256(worktree) scheme the shell hook reimplements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-active-'));
  const wt = '/home/kc/dev/godot-tactical-rpg';
  const expected = createHash('sha256').update(wt).digest('hex');
  expect(activeSessionFile(dbPath(dir), wt)).toContain(`${expected}.session`);
});

test('Fix B: claim self-heals after the session row is reaped', () => {
  const db = openDb(':memory:');
  // Register, then reap it away (simulate TTL idle eviction mid-session).
  register(db, { session_id: 'mcp-me', cwd: process.cwd() }, 1000);
  reap(db, 1000 + 9999, 1800);
  expect(db.prepare("SELECT count(*) c FROM sessions").get()).toMatchObject({ c: 0 });

  // Without ensure(), claim() would hit `if (!s) return []` and write nothing.
  const tools = makeTools(db, 'mcp-me', { ttl: 1800, maxRows: 50, now: () => 20000 });
  tools.claim({ feature: 'x', path: 'a/', note: 'n' });
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='claim'").get()).toMatchObject({ c: 2 });
});
