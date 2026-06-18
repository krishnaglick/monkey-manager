import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { runCommand } from '../src/cli.js';

function freshDb() { return openDb(':memory:'); }

test('on-session-start registers the session', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'cli1', cwd: process.cwd() }, 1000);
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 1 });
});

test('on-post-edit records a touch', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'cli1', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-post-edit', { session_id: 'cli1', tool_input: { file_path: `${process.cwd()}/x.gd` } }, 1001);
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='touch'").get()).toMatchObject({ c: 1 });
});

test('on-pre-edit emits a warning only when another session conflicts', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-post-edit', { session_id: 'b', tool_input: { file_path: `${process.cwd()}/x.gd` } }, 1001);
  const clear = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/free.gd` } }, 1002);
  expect(clear).toBe('');
  const warn = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/x.gd` } }, 1002);
  expect(warn).toContain('monkey-manager');
  expect(warn).toContain('x.gd');
});

test('on-session-end clears the session', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'cli1', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-end', { session_id: 'cli1' }, 1001);
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 0 });
});

test('unknown command and missing fields are safe no-ops', () => {
  const db = freshDb();
  expect(runCommand(db, 'bogus', {}, 1000)).toBe('');
  expect(runCommand(db, 'on-stop', {}, 1000)).toBe('');
});
