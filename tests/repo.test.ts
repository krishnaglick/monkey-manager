import { afterAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveIdentity } from '../src/repo.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'orch-')); dirs.push(d); return d; }
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('git repo: stable repo id, label, worktree, branch', () => {
  const d = tmp();
  execFileSync('git', ['init', '-b', 'main', d]);
  const id = resolveIdentity(d);
  expect(id.repo).toMatch(/^[0-9a-f]{12}$/);
  expect(id.worktree).toBe(d);
  expect(id.branch).toBe('main');
  expect(id.repoLabel).toBe(basename(d));
});

test('linked worktree shares the same repo id as its main checkout', () => {
  const main = tmp();
  execFileSync('git', ['init', '-b', 'main', main]);
  execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '--allow-empty', '-m', 'init']);
  const wt = join(main, '..', `wt-${Date.now()}`);
  execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'feat', wt]);
  dirs.push(wt);
  expect(resolveIdentity(wt).repo).toBe(resolveIdentity(main).repo);
  expect(resolveIdentity(wt).worktree).toBe(wt);
});

test('non-git dir: cwd-hash fallback, null branch', () => {
  const d = tmp();
  const id = resolveIdentity(d);
  expect(id.repo).toMatch(/^[0-9a-f]{12}$/);
  expect(id.branch).toBeNull();
  expect(id.worktree).toBe(d);
});
