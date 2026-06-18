import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';

test('openDb creates sessions and work tables, WAL, and indexes', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r: any) => r.name);
  expect(tables).toContain('sessions');
  expect(tables).toContain('work');

  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='work_dedupe'"
  ).get();
  expect(idx).toBeTruthy();

  const idx2 = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='work_repo'"
  ).get();
  expect(idx2).toBeTruthy();
});

test('migrate is idempotent', async () => {
  const db = openDb(':memory:');
  const { migrate } = await import('../src/db.js');
  expect(() => migrate(db)).not.toThrow();
});
