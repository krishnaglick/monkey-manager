import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, release } from '../src/core.js';

function setup(sid = 's1') {
  const db = openDb(':memory:');
  const s = register(db, { session_id: sid, cwd: process.cwd() }, 1000);
  return { db, worktree: s.worktree };
}

test('touch records a worktree-relative touch row and dedupes', () => {
  const { db, worktree } = setup();
  touch(db, 's1', `${worktree}/a/b.gd`, 1001);
  touch(db, 's1', `${worktree}/a/b.gd`, 1002); // same file -> no new row
  const rows = db.prepare("SELECT * FROM work WHERE kind='touch'").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBe('a/b.gd');
  expect(rows[0].created_at).toBe(1001); // first touch wins (INSERT OR IGNORE)
});

test('touch on unknown session is a no-op', () => {
  const { db } = setup();
  touch(db, 'ghost', '/x/y.gd', 1001);
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
});

test('claim records a claim row with note', () => {
  const { db } = setup();
  claim(db, 's1', 'combat/ai/', 'AI refactor', 1001, 1800);
  const rows = db.prepare("SELECT * FROM work WHERE kind='claim'").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBe('combat/ai/');
  expect(rows[0].note).toBe('AI refactor');
});

test('release deletes only this session claims, not touches', () => {
  const { db, worktree } = setup();
  claim(db, 's1', 'combat/ai/', 'x', 1001, 1800);
  touch(db, 's1', `${worktree}/a/b.gd`, 1001);
  release(db, 's1');
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='claim'").get()).toMatchObject({ c: 0 });
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='touch'").get()).toMatchObject({ c: 1 });
});

test('re-claim updates the note, keeps one row, preserves created_at', () => {
  const { db } = setup();
  claim(db, 's1', 'combat/ai/', 'first', 1001, 1800);
  claim(db, 's1', 'combat/ai/', 'second', 1005, 1800); // same path, later clock
  const rows = db.prepare("SELECT * FROM work WHERE kind='claim'").all() as any[];
  expect(rows).toHaveLength(1); // upsert, not a second row
  expect(rows[0].note).toBe('second'); // note overwritten
  expect(rows[0].created_at).toBe(1001); // age anchored to FIRST claim, not bumped
});
