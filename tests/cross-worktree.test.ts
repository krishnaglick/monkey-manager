import { afterAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorktreeRoot } from '../src/paths.js';
import { openDb } from '../src/db.js';
import { register, touch, check } from '../src/core.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Build a main checkout + a linked worktree, both with a data/main.gd file. */
function twoWorktrees(): { main: string; wt: string } {
  const main = tmp('mm-main-');
  execFileSync('git', ['init', '-b', 'main', main]);
  execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '--allow-empty', '-m', 'init']);
  const wt = join(main, '..', `mm-wt-${Date.now()}`);
  execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'feat', wt]);
  dirs.push(wt);
  return { main, wt };
}

test('resolveWorktreeRoot returns the file own worktree root, not the session root', () => {
  const { main, wt } = twoWorktrees();
  const mkdir = (p: string) => execFileSync('mkdir', ['-p', join(p, 'data')]);
  mkdir(main);
  mkdir(wt);
  writeFileSync(join(main, 'data', 'main.gd'), 'x');
  writeFileSync(join(wt, 'data', 'main.gd'), 'y');
  expect(resolveWorktreeRoot(join(main, 'data', 'main.gd'))).toBe(main);
  expect(resolveWorktreeRoot(join(wt, 'data', 'main.gd'))).toBe(wt);
});

test('resolveWorktreeRoot fails open (null) for a non-git path', () => {
  const d = tmp('mm-nogit-');
  expect(resolveWorktreeRoot(join(d, 'x.gd'))).toBeNull();
});

test('same logical file in two worktrees normalizes to the same key and check cross-detects', () => {
  const { main, wt } = twoWorktrees();
  execFileSync('mkdir', ['-p', join(main, 'data')]);
  execFileSync('mkdir', ['-p', join(wt, 'data')]);
  writeFileSync(join(main, 'data', 'main.gd'), 'x');
  writeFileSync(join(wt, 'data', 'main.gd'), 'y');

  const db = openDb(':memory:');
  // session A frozen at main root, session B frozen at the linked worktree root.
  const a = register(db, { session_id: 'A', cwd: main }, 1000);
  const b = register(db, { session_id: 'B', cwd: wt }, 1000);
  // Same repo id groups the two worktrees together.
  expect(a.repo).toBe(b.repo);
  // A touches the file via its absolute path in the main checkout.
  touch(db, 'A', join(main, 'data', 'main.gd'), 1000);
  // B asks about the same logical file via ITS absolute path in the worktree.
  const conflicts = check(db, 'B', [join(wt, 'data', 'main.gd')], 'repo', 1001, 1800, 50);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].session_id).toBe('A');
  expect(conflicts[0].path).toBe('data/main.gd');
  expect(conflicts[0].cross_worktree).toBe(true);
});
