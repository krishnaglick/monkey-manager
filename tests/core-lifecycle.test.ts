import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, active, reap, endSession, getSession } from '../src/core.js';

function db1() {
  const db = openDb(':memory:');
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  return db;
}

test('active lists live work in repo scope, capped', () => {
  const db = db1();
  claim(db, 's1', 'combat/', 'x', 1000, 1800);
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  const rows = active(db, 's1', 'repo', 1000, 1800, 50);
  expect(rows.length).toBe(2);
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
  claim(db, 's1', 'combat/', 'x', 1000, 1800);
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
