import { expect, test } from 'vitest';
import { normalizePath, pathsOverlap, canonFeature, normalizeKey } from '../src/paths.js';

test('normalizePath makes absolute paths worktree-relative', () => {
  expect(normalizePath('/repo/combat/ai/foo.gd', '/repo')).toBe('combat/ai/foo.gd');
});

test('normalizePath keeps relative paths and strips ./', () => {
  expect(normalizePath('./combat/ai/foo.gd', '/repo')).toBe('combat/ai/foo.gd');
  expect(normalizePath('combat/ai/foo.gd', '/repo')).toBe('combat/ai/foo.gd');
});

test('normalizePath preserves a trailing slash (directory claim)', () => {
  expect(normalizePath('/repo/combat/ai/', '/repo')).toBe('combat/ai/');
  expect(normalizePath('combat/ai/', '/repo')).toBe('combat/ai/');
});

test('pathsOverlap: exact file equality', () => {
  expect(pathsOverlap('a/b.gd', 'a/b.gd')).toBe(true);
  expect(pathsOverlap('a/b.gd', 'a/c.gd')).toBe(false);
});

test('pathsOverlap: directory claim contains a file', () => {
  expect(pathsOverlap('combat/ai/', 'combat/ai/foo.gd')).toBe(true);
  expect(pathsOverlap('combat/ai/foo.gd', 'combat/ai/')).toBe(true);
});

test('pathsOverlap: file that looks like a dir prefix does NOT match', () => {
  expect(pathsOverlap('combat/ai', 'combat/ai/foo.gd')).toBe(false);
  expect(pathsOverlap('combat/ai/', 'combat/aifoo.gd')).toBe(false);
});

test('canonFeature collapses case/punctuation/separators but not words', () => {
  expect(canonFeature('§0.5.B')).toBe('05b');
  expect(canonFeature('0.5B')).toBe('05b');
  expect(canonFeature('0.5.b')).toBe('05b');
  expect(canonFeature('05B')).toBe('05b');
  expect(canonFeature('Issue #412')).toBe('issue412');
  expect(canonFeature('ISSUE_412')).toBe('issue412');
  expect(canonFeature('payment-v2')).toBe('paymentv2'); // not eaten down to '2'
  expect(canonFeature('payment-v2')).not.toBe(canonFeature('checkout-v2'));
});

test('normalizeKey canonicalizes feature:// keys, leaves files alone', () => {
  expect(normalizeKey('feature://§0.5.B', '/repo')).toBe('feature://05b');
  expect(normalizeKey('/repo/combat/ai/foo.gd', '/repo')).toBe('combat/ai/foo.gd');
});
