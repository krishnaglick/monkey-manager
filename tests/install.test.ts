import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertBlock } from '../src/claude-md.js';

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'orch-inst-')); dirs.push(d); return d; }
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('upsertBlock adds the marker block once and is idempotent', () => {
  const d = tmp();
  const f = join(d, 'CLAUDE.md');
  writeFileSync(f, '# Project\n');
  upsertBlock(f);
  upsertBlock(f);
  const content = readFileSync(f, 'utf8');
  const count = content.split('<!-- monkey-manager -->').length - 1;
  expect(count).toBe(1);
  expect(content).toContain('monkey-manager-scout');
});

test('upsertBlock creates the file if missing', () => {
  const d = tmp();
  const f = join(d, 'CLAUDE.md');
  upsertBlock(f);
  expect(readFileSync(f, 'utf8')).toContain('<!-- monkey-manager -->');
});
