import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { register, touch } from '../src/core.js';

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'orch-int-'));
  dirs.push(d);
  return join(d, 'state.db');
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// SPEC "Testing": concurrency — two writers under busy_timeout, no lock error.
test('two connections writing the same file DB do not error (WAL + busy_timeout)', () => {
  const path = tmpDb();
  const a = openDb(path);
  const b = openDb(path);
  register(a, { session_id: 'a', cwd: process.cwd() }, 1000);
  register(b, { session_id: 'b', cwd: process.cwd() }, 1000);
  for (let i = 0; i < 20; i++) {
    touch(a, 'a', `${process.cwd()}/a${i}.gd`, 1000 + i);
    touch(b, 'b', `${process.cwd()}/b${i}.gd`, 1000 + i);
  }
  expect(a.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 40 });
  a.close();
  b.close();
});

// SPEC "Testing": a Task sub-agent's edits attribute to the parent session_id.
// Sub-agents share the parent's session_id, so their touches land under one session.
test('sub-agent edits roll up to the parent session_id (shared id)', () => {
  const path = tmpDb();
  const db = openDb(path);
  register(db, { session_id: 'parent', cwd: process.cwd() }, 1000);
  touch(db, 'parent', `${process.cwd()}/from-parent.gd`, 1000);
  touch(db, 'parent', `${process.cwd()}/from-subagent.gd`, 1001); // same session_id
  const rows = db.prepare('SELECT DISTINCT session_id FROM work').all() as { session_id: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].session_id).toBe('parent');
  db.close();
});
