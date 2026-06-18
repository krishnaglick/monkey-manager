import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, getSession, heartbeat, whoami } from '../src/core.js';

function freshDb() { return openDb(':memory:'); }

test('register inserts a session row with frozen identity', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const s = getSession(db, 's1')!;
  expect(s.session_id).toBe('s1');
  expect(s.started_at).toBe(1000);
  expect(s.last_seen).toBe(1000);
  expect(s.repo).toMatch(/^[0-9a-f]{12}$/);
});

test('register on an existing session only bumps last_seen (identity frozen)', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const before = getSession(db, 's1')!;
  register(db, { session_id: 's1', cwd: '/some/other/dir' }, 2000);
  const after = getSession(db, 's1')!;
  expect(after.last_seen).toBe(2000);
  expect(after.started_at).toBe(1000);
  expect(after.worktree).toBe(before.worktree);
  expect(after.repo).toBe(before.repo);
  expect(after.repo_label).toBe(before.repo_label);
  expect(after.branch).toBe(before.branch);
  expect(after.cwd).toBe(before.cwd);
});

test('heartbeat bumps last_seen only', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  heartbeat(db, 's1', 1500);
  expect(getSession(db, 's1')!.last_seen).toBe(1500);
});

test('whoami returns trimmed fields, null for unknown session', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const w = whoami(db, 's1')!;
  expect(Object.keys(w).sort()).toEqual(['branch', 'repo_label', 'session_id', 'worktree']);
  expect(whoami(db, 'nope')).toBeNull();
});
