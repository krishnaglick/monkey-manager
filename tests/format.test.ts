import { expect, test } from 'vitest';
import { formatAge, formatConflicts } from '../src/format.js';
import type { Conflict } from '../src/core.js';

const base: Conflict = {
  path: 'a.gd', session_id: 'abcdef123456', repo_label: 'game',
  branch: 'main', worktree: '/repo', kind: 'touch', note: null,
  age_sec: 130, cross_worktree: false,
};

test('formatAge: s/m/h', () => {
  expect(formatAge(42)).toBe('42s');
  expect(formatAge(130)).toBe('2m');
  expect(formatAge(7300)).toBe('2h');
});

test('formatConflicts: empty -> empty string', () => {
  expect(formatConflicts([], 50)).toBe('');
});

test('formatConflicts: one touch line, short session id', () => {
  const out = formatConflicts([base], 50);
  expect(out).toContain('a.gd');
  expect(out).toContain('abcdef12'); // 8-char id
  expect(out).toContain('touch');
  expect(out).toContain('2m');
});

test('formatConflicts: claim shows note; cross-worktree annotated', () => {
  const out = formatConflicts(
    [{ ...base, kind: 'claim', note: 'refactor', cross_worktree: true, branch: 'feat' }],
    50,
  );
  expect(out).toContain('claim "refactor"');
  expect(out).toContain('[wt:');
});

test('formatConflicts: caps and appends "+N more"', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...base, session_id: `id${i}` }));
  const out = formatConflicts(many, 2);
  expect(out.split('\n').filter((l) => l.includes('+3 more'))).toHaveLength(1);
});
