import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { runCommand } from '../src/cli.js';
import { claim } from '../src/core.js';

function freshDb() { return openDb(':memory:'); }

test('on-session-start registers the session', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'cli1', cwd: process.cwd() }, 1000);
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 1 });
});

test('on-session-start warns when a same-branch sibling is already live', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1000);
  // Force a shared branch deterministically (independent of the test repo's HEAD).
  db.prepare("UPDATE sessions SET branch='wave-zz' WHERE session_id IN ('a','b')").run();
  // Re-running start for 'b' heartbeats (keeps branch) and recomputes siblings.
  const out = runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1001);
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('monkey-manager');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('wave-zz');
});

test('on-session-start is silent (empty) for a solo session', () => {
  const db = freshDb();
  const out = runCommand(db, 'on-session-start', { session_id: 'solo', cwd: process.cwd() }, 1000);
  expect(out).toBe('');
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

test('on-pre-edit records the caller intent so a near-simultaneous peer sees it (TOCTOU)', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1000);
  // a pre-edits a file no one has touched -> no warning, but intent is now recorded.
  const aOut = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/race.gd` } }, 1001);
  expect(aOut).toBe('');
  const work = db.prepare("SELECT * FROM work WHERE session_id='a'").all() as any[];
  expect(work).toHaveLength(1); // intent reserved on pre-edit, not only on post-edit
  // b pre-edits the SAME file before a's post-edit -> now warns because a's intent is on record.
  const bOut = runCommand(db, 'on-pre-edit', { session_id: 'b', tool_input: { file_path: `${process.cwd()}/race.gd` } }, 1002);
  expect(bOut).toContain('monkey-manager');
  expect(bOut).toContain('race.gd');
});

test('on-pre-edit never warns the caller against its own recorded intent', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  // First pre-edit records intent; a SECOND pre-edit of the same file must stay silent.
  runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/mine.gd` } }, 1001);
  const again = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/mine.gd` } }, 1002);
  expect(again).toBe('');
});

test('on-pre-edit: a touch conflict stays advisory (additionalContext, no decision)', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-post-edit', { session_id: 'b', tool_input: { file_path: `${process.cwd()}/t.gd` } }, 1001);
  const out = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/t.gd` } }, 1002);
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput.additionalContext).toContain('monkey-manager');
  expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined();
});

test('on-pre-edit: a claim conflict escalates to a blocking "ask" decision', () => {
  const db = freshDb();
  runCommand(db, 'on-session-start', { session_id: 'a', cwd: process.cwd() }, 1000);
  runCommand(db, 'on-session-start', { session_id: 'b', cwd: process.cwd() }, 1000);
  // b deliberately claims the file (reservation), then a tries to edit it.
  claim(db, 'b', 'refactor-c', `${process.cwd()}/c.gd`, 'b is refactoring', 1001, 1800);
  const out = runCommand(db, 'on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/c.gd` } }, 1002);
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('monkey-manager');
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('c.gd');
});

test('unknown command and missing fields are safe no-ops', () => {
  const db = freshDb();
  expect(runCommand(db, 'bogus', {}, 1000)).toBe('');
  expect(runCommand(db, 'on-stop', {}, 1000)).toBe('');
});
