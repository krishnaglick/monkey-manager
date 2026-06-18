import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { record, reapEvents, stats } from '../src/events.js';
import { register, heartbeat } from '../src/core.js';

function freshDb() {
  return openDb(':memory:');
}

function on() {
  process.env.MONKEY_MANAGER_LOG = '1';
}
function off() {
  process.env.MONKEY_MANAGER_LOG = '0'; // logging is ON by default; disable explicitly
}

afterEach(() => {
  delete process.env.MONKEY_MANAGER_LOG; // restore default (on)
});

function count(db: ReturnType<typeof freshDb>): number {
  return (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
}

test('record writes a row with the right columns when logging is on', () => {
  on();
  const db = freshDb();
  record(db, 1000, 'pre_edit', { session_id: 's1', path: 'a.ts', detail: 'warned=true' });
  const row = db.prepare('SELECT * FROM events').get() as Record<string, unknown>;
  expect(row).toMatchObject({
    ts: 1000,
    ev: 'pre_edit',
    session_id: 's1',
    path: 'a.ts',
    detail: 'warned=true',
    repo: null,
  });
});

test('record is on by default (no env set) and a no-op when explicitly disabled', () => {
  delete process.env.MONKEY_MANAGER_LOG; // default
  const a = freshDb();
  record(a, 1000, 'register', { session_id: 's1' });
  expect(count(a)).toBe(1);

  off(); // MONKEY_MANAGER_LOG=0
  const b = freshDb();
  record(b, 1000, 'register', { session_id: 's1' });
  expect(count(b)).toBe(0);
});

test('record treats MONKEY_MANAGER_LOG=0 / false as off', () => {
  const db = freshDb();
  process.env.MONKEY_MANAGER_LOG = '0';
  record(db, 1, 'register', {});
  process.env.MONKEY_MANAGER_LOG = 'false';
  record(db, 2, 'register', {});
  expect(count(db)).toBe(0);
});

test('record never throws when the events table is missing', () => {
  on();
  const db = new DatabaseSync(':memory:'); // no migrate() -> no events table
  expect(() => record(db, 1000, 'register', { session_id: 's1' })).not.toThrow();
});

test('reapEvents deletes rows older than the 7-day window, keeps newer', () => {
  on();
  const db = freshDb();
  const now = 10 * 86400;
  record(db, now - 8 * 86400, 'register', {}); // older than 7d -> reaped
  record(db, now - 1 * 86400, 'register', {}); // within 7d -> kept
  reapEvents(db, now);
  expect(count(db)).toBe(1);
});

test('reapEvents is a no-op when logging is off', () => {
  on();
  const db = freshDb();
  record(db, 0, 'register', {}); // ancient row
  off();
  reapEvents(db, 1000 * 86400);
  expect(count(db)).toBe(1); // not reaped while off
});

test('stats aggregates totals, 24h counts, and the warned tally', () => {
  on();
  const db = freshDb();
  const now = 100 * 86400;
  // pre_edit: 3 total, 2 in last 24h, 2 warned
  record(db, now - 2 * 86400, 'pre_edit', { detail: 'warned=true' }); // old, warned
  record(db, now - 100, 'pre_edit', { detail: 'warned=true' }); // recent, warned
  record(db, now - 200, 'pre_edit', { detail: 'warned=false' }); // recent, not warned
  record(db, now - 50, 'claim', { detail: 'conflicts=1' });

  const out = stats(db, now);
  const pre = out.split('\n').find((l) => l.startsWith('pre_edit'))!;
  expect(pre).toContain('warned: 2 / 3');
  // 2 of 3 pre_edits in last 24h
  expect(pre).toMatch(/pre_edit\s+2\s+3/);
  expect(out).toMatch(/claim\s+1\s+1/);
});

test('stats on an empty table prints a hint', () => {
  const db = freshDb();
  expect(stats(db, 1000)).toContain('no events');
});

test('stats shows per-session idle and last_action for stuck-agent detection', () => {
  on();
  const db = freshDb();
  register(db, { session_id: 'stuck123', cwd: process.cwd() }, 1000);
  record(db, 1000, 'register', { session_id: 'stuck123' });
  heartbeat(db, 'stuck123', 1100); // last_seen=1100, last event ts=1000
  const now = 1100 + 5 * 60; // 5 min after last heartbeat
  const out = stats(db, now);
  const line = out.split('\n').find((l) => l.startsWith('stuck123'))!;
  expect(line).toContain('5m'); // idle since last_seen
  expect(line).toMatch(/monkey-manager\//);
});
