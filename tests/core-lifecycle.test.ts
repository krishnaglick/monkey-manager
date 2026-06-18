import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import {
  register,
  touch,
  claim,
  active,
  reap,
  endSession,
  getSession,
  branchSiblings,
} from '../src/core.js';

function db1() {
  const db = openDb(':memory:');
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  return db;
}

test('active lists live work in repo scope, capped', () => {
  const db = db1();
  claim(db, 's1', 'combat', 'combat/', 'x', 1000, 1800);
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  const rows = active(db, 's1', 'repo', 1000, 1800, 50);
  expect(rows.length).toBe(3); // feature row + file claim + touch
});

test('active excludes stale sessions', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  expect(active(db, 's1', 'repo', 5000, 1800, 50).length).toBe(0);
});

test('reap deletes stale work and stale session rows', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  reap(db, 5000, 1800);
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 0 });
});

test('reap deletes orphan work whose session row is gone', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');
  reap(db, 1100, 1800);
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
});

test('endSession deletes the session work and row atomically', () => {
  const db = db1();
  claim(db, 's1', 'combat', 'combat/', 'x', 1000, 1800);
  endSession(db, 's1');
  expect(getSession(db, 's1')).toBeUndefined();
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
});

test('reap preserves live work and sessions (does not over-delete)', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  reap(db, 1100, 1800); // cutoff = 1100 - 1800 < 1000 -> s1 still live
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 1 });
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 1 });
});

test('branchSiblings finds live same-branch sessions (the no-claim feature signal)', () => {
  const db = openDb(':memory:');
  register(db, { session_id: 'a', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'b', cwd: process.cwd() }, 1000);
  db.prepare("UPDATE sessions SET branch='wave-05b', worktree='/wt/a' WHERE session_id='a'").run();
  db.prepare("UPDATE sessions SET branch='wave-05b', worktree='/wt/b' WHERE session_id='b'").run();
  expect(branchSiblings(db, 'a', 1000, 1800, 50).map((s) => s.session_id)).toEqual(['b']);
});

test('branchSiblings ignores different branch, null branch, and stale sessions', () => {
  const db = openDb(':memory:');
  register(db, { session_id: 'a', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'b', cwd: process.cwd() }, 1000);
  db.prepare("UPDATE sessions SET branch='x' WHERE session_id='a'").run();
  db.prepare("UPDATE sessions SET branch='y' WHERE session_id='b'").run();
  expect(branchSiblings(db, 'a', 1000, 1800, 50)).toHaveLength(0); // different branch
  db.prepare("UPDATE sessions SET branch='x' WHERE session_id='b'").run();
  expect(branchSiblings(db, 'a', 1000, 1800, 50)).toHaveLength(1); // now same branch
  db.prepare("UPDATE sessions SET branch=NULL WHERE session_id='a'").run();
  expect(branchSiblings(db, 'a', 1000, 1800, 50)).toHaveLength(0); // my branch null -> no key
  db.prepare("UPDATE sessions SET branch='x' WHERE session_id='a'").run();
  expect(branchSiblings(db, 'a', 5000, 1800, 50)).toHaveLength(0); // b now stale (TTL)
});
