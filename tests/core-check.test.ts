import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, check } from '../src/core.js';

function db3() {
  const db = openDb(':memory:');
  register(db, { session_id: 'me', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'other', cwd: process.cwd() }, 1000);
  return db;
}

test('check excludes the caller own work', () => {
  const db = db3();
  touch(db, 'me', `${process.cwd()}/a.gd`, 1000);
  expect(check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50)).toHaveLength(0);
});

test('check finds another live session touch', () => {
  const db = db3();
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  const c = check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].session_id).toBe('other');
  expect(c[0].kind).toBe('touch');
});

test('check matches a directory claim against a file query', () => {
  const db = db3();
  claim(db, 'other', 'ai', 'combat/ai/', 'refactor', 1000, 1800);
  const c = check(db, 'me', ['combat/ai/foo.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].note).toBe('refactor');
});

test('check ignores stale (TTL-expired) sessions', () => {
  const db = db3();
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  expect(check(db, 'me', ['a.gd'], 'repo', 2801, 1800, 50)).toHaveLength(0);
});

test('check dedupes a session that both claims and touches the same path (prefers claim)', () => {
  const db = db3();
  claim(db, 'other', 'feat-a', 'a.gd', 'note', 1000, 1800);
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  const c = check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].kind).toBe('claim');
});

test('two sessions on the same feature collide even with disjoint files', () => {
  const db = db3();
  claim(db, 'other', 'questionnaire', 'editor/a.gd', 'wave-05b', 1000, 1800);
  // 'me' works a totally different file but the same feature id.
  const c = claim(db, 'me', 'questionnaire', 'game/z.gd', 'wave-05b', 1000, 1800, 50);
  expect(c.some((x) => x.path === 'feature://questionnaire' && x.session_id === 'other')).toBe(true);
});

test('near-miss feature spellings collide after engine canonicalization', () => {
  const db = db3();
  claim(db, 'other', '§0.5.B', null, 'section work', 1000, 1800);
  // 'me' types the same section a different way — still collides on feature://05b.
  const c = claim(db, 'me', '0.5b', null, 'same section', 1000, 1800, 50);
  expect(c.some((x) => x.path === 'feature://05b' && x.session_id === 'other')).toBe(true);
});

test('distinct feature ids that share a number prefix do NOT collide', () => {
  const db = db3();
  claim(db, 'other', 'payment-v2', null, 'a', 1000, 1800);
  const c = claim(db, 'me', 'checkout-v2', null, 'b', 1000, 1800, 50);
  expect(c).toHaveLength(0); // 'paymentv2' vs 'checkoutv2' — no word-eating
});

test('check caps output at maxRows', () => {
  const db = db3();
  for (let i = 0; i < 5; i++) register(db, { session_id: `s${i}`, cwd: process.cwd() }, 1000);
  for (let i = 0; i < 5; i++) touch(db, `s${i}`, `${process.cwd()}/a.gd`, 1000);
  expect(check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 3)).toHaveLength(3);
});
