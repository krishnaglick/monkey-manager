import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register } from '../src/core.js';
import { makeTools, claimInputSchema } from '../src/server.js';

function ctx() {
  const db = openDb(':memory:');
  register(db, { session_id: 'mcp-me', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'mcp-other', cwd: process.cwd() }, 1000);
  const tools = makeTools(db, 'mcp-me', { ttl: 1800, maxRows: 50, now: () => 1000 });
  return { db, tools };
}

test('claim then check from another session sees the claim', () => {
  const { db, tools } = ctx();
  tools.claim({ feature: 'ai', path: 'combat/ai/', note: 'x' });
  const other = makeTools(db, 'mcp-other', { ttl: 1800, maxRows: 50, now: () => 1000 });
  const res = other.check({ paths: ['combat/ai/foo.gd'] });
  expect(res).toContain('combat/ai');
});

test('whoami returns this session label', () => {
  const { tools } = ctx();
  expect(tools.whoami({})).toContain('mcp-me'.slice(0, 8));
});

test('release clears this session claims', () => {
  const { db, tools } = ctx();
  tools.claim({ feature: 'a', path: 'a/', note: 'x' });
  tools.release({});
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='claim'").get()).toMatchObject({ c: 0 });
});

test('check returns "CLEAR" sentinel when nothing conflicts', () => {
  const { tools } = ctx();
  expect(tools.check({ paths: ['free.gd'] })).toBe('CLEAR');
});

test('claim note schema caps length at 200', () => {
  expect(claimInputSchema.note.safeParse('x'.repeat(200)).success).toBe(true);
  expect(claimInputSchema.note.safeParse('x'.repeat(201)).success).toBe(false);
});

test('claim feature is required and non-empty', () => {
  expect(claimInputSchema.feature.safeParse('05b').success).toBe(true);
  expect(claimInputSchema.feature.safeParse('').success).toBe(false);
});
