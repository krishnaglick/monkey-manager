# Monkey Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `monkey-manager` Claude Code plugin — an MCP server + lifecycle hooks over a single SQLite DB that lets concurrent Claude sessions in one repo avoid colliding on the same files (advisory, automatic pre-edit warnings, heartbeat-TTL liveness).

**Architecture:** One shared TypeScript `core` (pure functions over a `better-sqlite3` handle). A thin `cli.ts` is the hook entrypoint (subcommand per hook event, reads the hook JSON on stdin). A thin `server.ts` exposes the same `core` as MCP tools. Plugin manifest wires 5 hooks + the MCP server + a bundled haiku scout agent. Built to `dist/`; hooks/server run as `node dist/...`.

**Tech Stack:** Node ESM ≥ 22.5 + TypeScript (NodeNext), `node:sqlite` (built-in, no dep/build), `@modelcontextprotocol/sdk`, `zod`, `vitest`. Spec: `SPEC.md`.

**Conventions:** TDD (test → fail → impl → pass → commit). All local imports use `.js` extensions (Node ESM). Time is passed in as `now` (unix seconds) to every state function so tests are deterministic. End every commit message with:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

**Two platform unknowns that have explicit verification sub-steps (not placeholders) in their tasks:**
- Task 9: exact PreToolUse mechanism for a *non-blocking* context warning (`hookSpecificOutput.additionalContext` vs `permissionDecision`).
- Task 10: how a plugin MCP server learns the current `session_id` (env var?). The implementation adapts to the verified answer; a documented fallback exists.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project scaffold, build, test |
| `src/clock.ts` | `nowSec()` — the only wall-clock read |
| `src/db.ts` | Open DB (WAL, busy_timeout), schema/migrations, row types |
| `src/paths.ts` | `normalizePath`, `pathsOverlap` (the bug-prone matching) |
| `src/repo.ts` | `resolveIdentity(cwd)` — repo/worktree identity from git, frozen |
| `src/core.ts` | All state ops: register, heartbeat, whoami, touch, claim, release, check, active, reap, endSession |
| `src/format.ts` | `formatAge`, `formatConflicts` — terse bounded output |
| `src/cli.ts` | Hook entrypoint: stdin JSON → subcommand → core; pre-edit warning |
| `src/server.ts` | MCP stdio server → core (heartbeats each call) |
| `.claude-plugin/plugin.json` | Manifest: hooks + mcpServers + agents |
| `agents/monkey-manager-scout.md` | Bundled haiku agent, pinned one-line verdict |
| `scripts/install-claude-md.mjs` | Idempotent marker-block appender for repo CLAUDE.md |
| `tests/*.test.ts` | One focused suite per module |

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/clock.ts`, `tests/clock.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "monkey-manager",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
```

- [ ] **Step 4: Write the failing test `tests/clock.test.ts`**

```ts
import { expect, test } from 'vitest';
import { nowSec } from '../src/clock.js';

test('nowSec returns integer unix seconds near current time', () => {
  const t = nowSec();
  expect(Number.isInteger(t)).toBe(true);
  expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(5);
});
```

- [ ] **Step 5: Run test, verify it fails**

Run: `npm install && npm test`
Expected: FAIL — `Cannot find module '../src/clock.js'`.

- [ ] **Step 6: Implement `src/clock.ts`**

```ts
export const nowSec = (): number => Math.floor(Date.now() / 1000);
```

- [ ] **Step 7: Run test, verify it passes**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/clock.ts tests/clock.test.ts package-lock.json
git commit -m "chore: scaffold monkey-manager project (ts, vitest, clock)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1: Database schema and open

**Files:**
- Create: `src/db.ts`, `tests/db.test.ts`

- [ ] **Step 1: Write the failing test `tests/db.test.ts`**

```ts
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
});

test('migrate is idempotent', () => {
  const db = openDb(':memory:');
  expect(() => openDb(':memory:')).not.toThrow();
  // re-running migrate on same db must not throw
  const { migrate } = require('../src/db.js');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- db`
Expected: FAIL — cannot find `../src/db.js`.

- [ ] **Step 3: Implement `src/db.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';

export type Kind = 'claim' | 'touch';

export interface SessionRow {
  session_id: string;
  repo: string;
  repo_label: string;
  worktree: string;
  branch: string | null;
  cwd: string;
  started_at: number;
  last_seen: number;
}

export interface WorkRow {
  id: number;
  session_id: string;
  repo: string;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
}

export type DB = DatabaseSync;

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      repo       TEXT NOT NULL,
      repo_label TEXT NOT NULL,
      worktree   TEXT NOT NULL,
      branch     TEXT,
      cwd        TEXT,
      started_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work (
      id         INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo       TEXT NOT NULL,
      worktree   TEXT NOT NULL,
      path       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      note       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_dedupe
      ON work (repo, session_id, worktree, path, kind);
    CREATE INDEX IF NOT EXISTS work_repo ON work (repo);
  `);
}

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}
```

- [ ] **Step 4: Replace the weak idempotence test**

Replace the second test in `tests/db.test.ts` with:

```ts
test('migrate is idempotent', () => {
  const db = openDb(':memory:');
  const { migrate } = await import('../src/db.js');
  expect(() => migrate(db)).not.toThrow();
});
```
Make the test function `async`.

- [ ] **Step 5: Run test, verify it passes**

Run: `npm test -- db`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: sqlite schema and openDb (WAL, dedupe index)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Path matching (`normalizePath`, `pathsOverlap`)

This is the correctness-critical, bug-prone unit. Directories are encoded by a trailing `/`; files have none. A file named like a directory (`combat/ai`) must NOT match a file under `combat/ai/`.

**Files:**
- Create: `src/paths.ts`, `tests/paths.test.ts`

- [ ] **Step 1: Write the failing test `tests/paths.test.ts`**

```ts
import { expect, test } from 'vitest';
import { normalizePath, pathsOverlap } from '../src/paths.js';

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
  // "combat/ai" (file, no slash) must not match "combat/ai/foo.gd"
  expect(pathsOverlap('combat/ai', 'combat/ai/foo.gd')).toBe(false);
  // and must not match a sibling sharing a string prefix
  expect(pathsOverlap('combat/ai/', 'combat/aifoo.gd')).toBe(false);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- paths`
Expected: FAIL — cannot find `../src/paths.js`.

- [ ] **Step 3: Implement `src/paths.ts`**

```ts
import { isAbsolute, relative } from 'node:path';

export function normalizePath(p: string, worktree: string): string {
  const trailing = p.endsWith('/');
  let rel = isAbsolute(p) ? relative(worktree, p) : p.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  return trailing ? rel + '/' : rel;
}

/** Overlap iff equal, or one is a directory (trailing '/') that prefixes the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- paths`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat: worktree-relative path normalization and overlap rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Repo/worktree identity

**Files:**
- Create: `src/repo.ts`, `tests/repo.test.ts`

- [ ] **Step 1: Write the failing test `tests/repo.test.ts`**

```ts
import { afterAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  expect(id.repoLabel).toBe(require('node:path').basename(d));
});

test('linked worktree shares the same repo id as its main checkout', () => {
  const main = tmp();
  execFileSync('git', ['init', '-b', 'main', main]);
  execFileSync('git', ['-C', main, 'commit', '--allow-empty', '-m', 'init',
    '-c', 'user.email=t@t', '-c', 'user.name=t']);
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- repo`
Expected: FAIL — cannot find `../src/repo.js`.

- [ ] **Step 3: Implement `src/repo.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export interface Identity {
  repo: string;
  repoLabel: string;
  worktree: string;
  branch: string | null;
  cwd: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const sha12 = (s: string): string =>
  createHash('sha1').update(s).digest('hex').slice(0, 12);

export function resolveIdentity(cwd: string): Identity {
  const abs = resolve(cwd);
  const commonDir = git(['rev-parse', '--git-common-dir'], abs);
  if (!commonDir) {
    return { repo: sha12(abs), repoLabel: basename(abs), worktree: abs, branch: null, cwd: abs };
  }
  const absCommon = resolve(abs, commonDir);
  const worktree = git(['rev-parse', '--show-toplevel'], abs) ?? abs;
  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD'], abs);
  const repoRoot = basename(absCommon) === '.git' ? resolve(absCommon, '..') : absCommon;
  return {
    repo: sha12(absCommon),
    repoLabel: basename(repoRoot),
    worktree,
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    cwd: abs,
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- repo`
Expected: PASS (3 tests). (Requires `git` on PATH.)

- [ ] **Step 5: Commit**

```bash
git add src/repo.ts tests/repo.test.ts
git commit -m "feat: frozen repo/worktree identity from git with non-git fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: core — register, heartbeat, whoami

**Files:**
- Create: `src/core.ts`, `tests/core-session.test.ts`

- [ ] **Step 1: Write the failing test `tests/core-session.test.ts`**

```ts
import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, getSession, heartbeat, whoami } from '../src/core.js';

function freshDb() { return openDb(':memory:'); }

test('register inserts a session row with frozen identity', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const s = getSession(db, 's1')!;
  expect(s.session_id).toBe('s1');
  expect(s.started_at).toBe(1000);
  expect(s.last_seen).toBe(1000);
  expect(s.repo).toMatch(/^[0-9a-f]{12}$/);
});

test('register on an existing session only bumps last_seen (identity frozen)', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const before = getSession(db, 's1')!;
  register(db, { session_id: 's1', cwd: '/some/other/dir' }, 2000);
  const after = getSession(db, 's1')!;
  expect(after.last_seen).toBe(2000);
  expect(after.started_at).toBe(1000);
  expect(after.worktree).toBe(before.worktree); // not re-derived from new cwd
});

test('heartbeat bumps last_seen only', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  heartbeat(db, 's1', 1500);
  expect(getSession(db, 's1')!.last_seen).toBe(1500);
});

test('whoami returns trimmed fields, null for unknown session', () => {
  const db = freshDb();
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  const w = whoami(db, 's1')!;
  expect(Object.keys(w).sort()).toEqual(['branch', 'repo_label', 'session_id', 'worktree']);
  expect(whoami(db, 'nope')).toBeNull();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- core-session`
Expected: FAIL — cannot find `../src/core.js`.

- [ ] **Step 3: Implement the first slice of `src/core.ts`**

```ts
import type { DB, SessionRow, Kind } from './db.js';
import { resolveIdentity } from './repo.js';
import { normalizePath, pathsOverlap } from './paths.js';

export type Scope = 'repo' | 'worktree';

export interface Conflict {
  path: string;
  session_id: string;
  repo_label: string;
  branch: string | null;
  worktree: string;
  kind: Kind;
  note: string | null;
  age_sec: number;
  cross_worktree: boolean;
}

export function getSession(db: DB, session_id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session_id) as
    | SessionRow
    | undefined;
}

export function register(db: DB, p: { session_id: string; cwd: string }, now: number): SessionRow {
  const id = resolveIdentity(p.cwd);
  db.prepare(`
    INSERT INTO sessions (session_id, repo, repo_label, worktree, branch, cwd, started_at, last_seen)
    VALUES (@session_id, @repo, @repo_label, @worktree, @branch, @cwd, @now, @now)
    ON CONFLICT(session_id) DO UPDATE SET last_seen = @now
  `).run({
    session_id: p.session_id,
    repo: id.repo,
    repo_label: id.repoLabel,
    worktree: id.worktree,
    branch: id.branch,
    cwd: id.cwd,
    now,
  });
  return getSession(db, p.session_id)!;
}

export function heartbeat(db: DB, session_id: string, now: number): void {
  db.prepare('UPDATE sessions SET last_seen = ? WHERE session_id = ?').run(now, session_id);
}

export function whoami(
  db: DB,
  session_id: string,
): Pick<SessionRow, 'session_id' | 'repo_label' | 'worktree' | 'branch'> | null {
  const s = getSession(db, session_id);
  return s
    ? { session_id: s.session_id, repo_label: s.repo_label, worktree: s.worktree, branch: s.branch }
    : null;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- core-session`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/core-session.test.ts
git commit -m "feat: core register/heartbeat/whoami with frozen identity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: core — touch, claim, release

**Files:**
- Modify: `src/core.ts` (append functions)
- Create: `tests/core-work.test.ts`

- [ ] **Step 1: Write the failing test `tests/core-work.test.ts`**

```ts
import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, release } from '../src/core.js';

function setup(sid = 's1') {
  const db = openDb(':memory:');
  const s = register(db, { session_id: sid, cwd: process.cwd() }, 1000);
  return { db, worktree: s.worktree };
}

test('touch records a worktree-relative touch row and dedupes', () => {
  const { db, worktree } = setup();
  touch(db, 's1', `${worktree}/a/b.gd`, 1001);
  touch(db, 's1', `${worktree}/a/b.gd`, 1002); // same file -> no new row
  const rows = db.prepare("SELECT * FROM work WHERE kind='touch'").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBe('a/b.gd');
  expect(rows[0].created_at).toBe(1001); // first touch wins (INSERT OR IGNORE)
});

test('touch on unknown session is a no-op', () => {
  const { db } = setup();
  touch(db, 'ghost', '/x/y.gd', 1001);
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 1 - 1 + 0 });
});

test('claim records a claim row with note', () => {
  const { db } = setup();
  claim(db, 's1', 'combat/ai/', 'AI refactor', 1001, 1800);
  const rows = db.prepare("SELECT * FROM work WHERE kind='claim'").all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].path).toBe('combat/ai/');
  expect(rows[0].note).toBe('AI refactor');
});

test('release deletes only this session claims, not touches', () => {
  const { db, worktree } = setup();
  claim(db, 's1', 'combat/ai/', 'x', 1001, 1800);
  touch(db, 's1', `${worktree}/a/b.gd`, 1001);
  release(db, 's1');
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='claim'").get()).toMatchObject({ c: 0 });
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='touch'").get()).toMatchObject({ c: 1 });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- core-work`
Expected: FAIL — `touch`/`claim`/`release` are not exported.

- [ ] **Step 3: Append to `src/core.ts`**

```ts
export function touch(db: DB, session_id: string, absFilePath: string, now: number): void {
  const s = getSession(db, session_id);
  if (!s) return;
  const path = normalizePath(absFilePath, s.worktree);
  db.prepare(`
    INSERT OR IGNORE INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'touch', NULL, ?)
  `).run(session_id, s.repo, s.worktree, path, now);
  heartbeat(db, session_id, now);
}

export function claim(
  db: DB,
  session_id: string,
  rawPath: string,
  note: string,
  now: number,
  ttl: number,
): Conflict[] {
  const s = getSession(db, session_id);
  if (!s) return [];
  const path = normalizePath(rawPath, s.worktree);
  db.prepare(`
    INSERT OR IGNORE INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'claim', ?, ?)
  `).run(session_id, s.repo, s.worktree, path, note, now);
  heartbeat(db, session_id, now);
  return check(db, session_id, [path], 'repo', now, ttl, 50);
}

export function release(db: DB, session_id: string): void {
  db.prepare("DELETE FROM work WHERE session_id = ? AND kind = 'claim'").run(session_id);
}
```

(`check` is added in Task 6; until then `claim` references it. To keep the suite green, add the `check` stub now and replace its body in Task 6:)

```ts
export function check(
  _db: DB,
  _session_id: string,
  _paths: string[],
  _scope: Scope,
  _now: number,
  _ttl: number,
  _maxRows: number,
): Conflict[] {
  return [];
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- core-work`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/core-work.test.ts
git commit -m "feat: core touch/claim/release (check stubbed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: core — check (overlap, self-exclude, scope, session-dedupe, cap)

**Files:**
- Modify: `src/core.ts` (replace the `check` stub)
- Create: `tests/core-check.test.ts`

- [ ] **Step 1: Write the failing test `tests/core-check.test.ts`**

```ts
import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, check } from '../src/core.js';

// All sessions share this process's repo (same cwd) so repo ids match.
function db3() {
  const db = openDb(':memory:');
  register(db, { session_id: 'me', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'other', cwd: process.cwd() }, 1000);
  return db;
}

test('check excludes the caller own work', () => {
  const db = db3();
  touch(db, 'me', `${process.cwd()}/a.gd`, 1000);
  expect(check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50)).toHaveLength(0);
});

test('check finds another live session touch', () => {
  const db = db3();
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  const c = check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].session_id).toBe('other');
  expect(c[0].kind).toBe('touch');
});

test('check matches a directory claim against a file query', () => {
  const db = db3();
  claim(db, 'other', 'combat/ai/', 'refactor', 1000, 1800);
  const c = check(db, 'me', ['combat/ai/foo.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].note).toBe('refactor');
});

test('check ignores stale (TTL-expired) sessions', () => {
  const db = db3();
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  // now = 1000 + 1801 > ttl 1800 -> other is stale
  expect(check(db, 'me', ['a.gd'], 'repo', 2801, 1800, 50)).toHaveLength(0);
});

test('check dedupes a session that both claims and touches the same path (prefers claim)', () => {
  const db = db3();
  claim(db, 'other', 'a.gd', 'note', 1000, 1800);
  touch(db, 'other', `${process.cwd()}/a.gd`, 1000);
  const c = check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 50);
  expect(c).toHaveLength(1);
  expect(c[0].kind).toBe('claim');
});

test('check caps output at maxRows', () => {
  const db = db3();
  for (let i = 0; i < 5; i++) register(db, { session_id: `s${i}`, cwd: process.cwd() }, 1000);
  for (let i = 0; i < 5; i++) touch(db, `s${i}`, `${process.cwd()}/a.gd`, 1000);
  expect(check(db, 'me', ['a.gd'], 'repo', 1000, 1800, 3)).toHaveLength(3);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- core-check`
Expected: FAIL — stub returns `[]`, so the "finds another session" tests fail.

- [ ] **Step 3: Replace the `check` stub in `src/core.ts`**

```ts
interface JoinedRow {
  session_id: string;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
  repo_label: string;
  branch: string | null;
}

export function check(
  db: DB,
  session_id: string,
  paths: string[],
  scope: Scope,
  now: number,
  ttl: number,
  maxRows: number,
): Conflict[] {
  const me = getSession(db, session_id);
  if (!me) return [];
  const cutoff = now - ttl;

  const sql = `
    SELECT w.session_id, w.worktree, w.path, w.kind, w.note, w.created_at,
           s.repo_label, s.branch
    FROM work w JOIN sessions s ON s.session_id = w.session_id
    WHERE w.repo = ? AND w.session_id != ? AND s.last_seen > ?
    ${scope === 'worktree' ? 'AND w.worktree = ?' : ''}
  `;
  const args =
    scope === 'worktree' ? [me.repo, session_id, cutoff, me.worktree] : [me.repo, session_id, cutoff];
  const rows = db.prepare(sql).all(...args) as JoinedRow[];

  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const qp = normalizePath(raw, me.worktree);
    const bySession = new Map<string, JoinedRow>();
    for (const r of rows) {
      if (!pathsOverlap(qp, r.path)) continue;
      const cur = bySession.get(r.session_id);
      if (!cur || (cur.kind === 'touch' && r.kind === 'claim')) bySession.set(r.session_id, r);
    }
    for (const r of bySession.values()) {
      const key = `${qp}|${r.session_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        path: qp,
        session_id: r.session_id,
        repo_label: r.repo_label,
        branch: r.branch,
        worktree: r.worktree,
        kind: r.kind,
        note: r.note,
        age_sec: now - r.created_at,
        cross_worktree: r.worktree !== me.worktree,
      });
    }
  }
  return out.slice(0, maxRows);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- core-check`
Expected: PASS (6 tests). Also re-run `npm test -- core-work` — still green.

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/core-check.test.ts
git commit -m "feat: core check with overlap, self-exclude, scope, dedupe, cap

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: core — active, reap, endSession

**Files:**
- Modify: `src/core.ts` (append)
- Create: `tests/core-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test `tests/core-lifecycle.test.ts`**

```ts
import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register, touch, claim, active, reap, endSession, getSession } from '../src/core.js';

function db1() {
  const db = openDb(':memory:');
  register(db, { session_id: 's1', cwd: process.cwd() }, 1000);
  return db;
}

test('active lists live work in repo scope, capped', () => {
  const db = db1();
  claim(db, 's1', 'combat/', 'x', 1000, 1800);
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  const rows = active(db, 's1', 'repo', 1000, 1800, 50);
  expect(rows.length).toBe(2);
});

test('active excludes stale sessions', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  expect(active(db, 's1', 'repo', 5000, 1800, 50).length).toBe(0);
});

test('reap deletes stale work and stale session rows', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  reap(db, 5000, 1800); // 5000-1800=3200 > 1000 -> stale
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 0 });
});

test('reap deletes orphan work whose session row is gone', () => {
  const db = db1();
  touch(db, 's1', `${process.cwd()}/a.gd`, 1000);
  db.prepare('DELETE FROM sessions WHERE session_id = ?').run('s1');
  reap(db, 1100, 1800);
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
});

test('endSession deletes the session work and row atomically', () => {
  const db = db1();
  claim(db, 's1', 'combat/', 'x', 1000, 1800);
  endSession(db, 's1');
  expect(getSession(db, 's1')).toBeUndefined();
  expect(db.prepare('SELECT count(*) c FROM work').get()).toMatchObject({ c: 0 });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- core-lifecycle`
Expected: FAIL — `active`/`reap`/`endSession` not exported.

- [ ] **Step 3: Append to `src/core.ts`**

```ts
export interface ActiveRow {
  session_id: string;
  repo_label: string;
  branch: string | null;
  worktree: string;
  path: string;
  kind: Kind;
  note: string | null;
  created_at: number;
}

export function active(
  db: DB,
  session_id: string,
  scope: Scope,
  now: number,
  ttl: number,
  maxRows: number,
): ActiveRow[] {
  const me = getSession(db, session_id);
  if (!me) return [];
  const cutoff = now - ttl;
  const sql = `
    SELECT w.session_id, w.path, w.kind, w.note, w.created_at,
           s.repo_label, s.branch, s.worktree
    FROM work w JOIN sessions s ON s.session_id = w.session_id
    WHERE w.repo = ? AND s.last_seen > ?
    ${scope === 'worktree' ? 'AND w.worktree = ?' : ''}
    ORDER BY w.created_at DESC
    LIMIT ?
  `;
  const args =
    scope === 'worktree'
      ? [me.repo, cutoff, me.worktree, maxRows]
      : [me.repo, cutoff, maxRows];
  return db.prepare(sql).all(...args) as ActiveRow[];
}

export function reap(db: DB, now: number, ttl: number): void {
  const cutoff = now - ttl;
  db.prepare(
    'DELETE FROM work WHERE session_id IN (SELECT session_id FROM sessions WHERE last_seen <= ?)',
  ).run(cutoff);
  db.prepare('DELETE FROM work WHERE session_id NOT IN (SELECT session_id FROM sessions)').run();
  db.prepare('DELETE FROM sessions WHERE last_seen <= ?').run(cutoff);
}

export function endSession(db: DB, session_id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM work WHERE session_id = ?').run(session_id);
    db.prepare('DELETE FROM sessions WHERE session_id = ?').run(session_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- core-lifecycle`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/core-lifecycle.test.ts
git commit -m "feat: core active/reap/endSession (heartbeat-TTL liveness)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Terse output formatting

**Files:**
- Create: `src/format.ts`, `tests/format.test.ts`

- [ ] **Step 1: Write the failing test `tests/format.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- format`
Expected: FAIL — cannot find `../src/format.js`.

- [ ] **Step 3: Implement `src/format.ts`**

```ts
import type { Conflict } from './core.js';

export function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export function formatConflicts(cs: Conflict[], maxRows: number): string {
  if (cs.length === 0) return '';
  const shown = cs.slice(0, maxRows);
  const lines = shown.map((c) => {
    const wt = c.cross_worktree ? ` [wt:${c.repo_label}/${c.branch ?? '?'}]` : '';
    const what = c.kind === 'claim' ? `claim "${c.note ?? ''}"` : 'touch';
    return `${c.path}\t${c.session_id.slice(0, 8)} ${c.branch ?? '-'}${wt} ${what} ${formatAge(c.age_sec)}`;
  });
  if (cs.length > maxRows) lines.push(`+${cs.length - maxRows} more`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- format`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/format.ts tests/format.test.ts
git commit -m "feat: terse bounded conflict formatting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: CLI hook entrypoint

**Files:**
- Create: `src/cli.ts`, `tests/cli.test.ts`

**Verification sub-step (do FIRST, it shapes the pre-edit branch):** Confirm the correct way for a **PreToolUse** hook to surface a *non-blocking* message to the model. Check the official hooks docs (https://code.claude.com/docs/en/hooks.md) — or dispatch the `claude-code-guide` agent with: *"For a PreToolUse hook, what stdout JSON makes Claude Code inject an advisory message into context WITHOUT blocking the tool? Is `hookSpecificOutput.additionalContext` supported on PreToolUse, or must I use `permissionDecision`?"* Implement the verified form below; if `additionalContext` is not honored on PreToolUse, switch that branch to emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":<warning>}}` instead (turns a real conflict into a user confirmation — still non-silent, still not a hard block). The DB-mutation behavior and tests below are unaffected by which form you pick.

- [ ] **Step 1: Write the failing test `tests/cli.test.ts`**

The CLI reads stdin and uses env for DB path/TTL. The test drives it as a child process against a temp DB.

```ts
import { afterAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';

const dirs: string[] = [];
function tmpDbPath() {
  const d = mkdtempSync(join(tmpdir(), 'orch-cli-'));
  dirs.push(d);
  return join(d, 'state.db');
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function runCli(cmd: string, payload: object, dbPath: string): string {
  return execFileSync('npx', ['tsx', 'src/cli.ts', cmd], {
    input: JSON.stringify(payload),
    env: { ...process.env, MONKEY_MANAGER_DB: dbPath },
    encoding: 'utf8',
  });
}

test('on-session-start registers the session', () => {
  const dbPath = tmpDbPath();
  runCli('on-session-start', { session_id: 'cli1', cwd: process.cwd() }, dbPath);
  const db = openDb(dbPath);
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 1 });
});

test('on-post-edit records a touch', () => {
  const dbPath = tmpDbPath();
  runCli('on-session-start', { session_id: 'cli1', cwd: process.cwd() }, dbPath);
  runCli('on-post-edit', { session_id: 'cli1', tool_input: { file_path: `${process.cwd()}/x.gd` } }, dbPath);
  const db = openDb(dbPath);
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='touch'").get()).toMatchObject({ c: 1 });
});

test('on-pre-edit emits a warning JSON only when another session conflicts', () => {
  const dbPath = tmpDbPath();
  runCli('on-session-start', { session_id: 'a', cwd: process.cwd() }, dbPath);
  runCli('on-session-start', { session_id: 'b', cwd: process.cwd() }, dbPath);
  runCli('on-post-edit', { session_id: 'b', tool_input: { file_path: `${process.cwd()}/x.gd` } }, dbPath);
  const clear = runCli('on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/free.gd` } }, dbPath);
  expect(clear.trim()).toBe('');
  const warn = runCli('on-pre-edit', { session_id: 'a', tool_input: { file_path: `${process.cwd()}/x.gd` } }, dbPath);
  expect(warn).toContain('monkey-manager');
  expect(warn).toContain('x.gd');
});

test('on-session-end clears the session', () => {
  const dbPath = tmpDbPath();
  runCli('on-session-start', { session_id: 'cli1', cwd: process.cwd() }, dbPath);
  runCli('on-session-end', { session_id: 'cli1' }, dbPath);
  const db = openDb(dbPath);
  expect(db.prepare('SELECT count(*) c FROM sessions').get()).toMatchObject({ c: 0 });
});

test('malformed stdin fails open (exit 0, no throw)', () => {
  const dbPath = tmpDbPath();
  const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'on-stop'], {
    input: 'not json',
    env: { ...process.env, MONKEY_MANAGER_DB: dbPath },
    encoding: 'utf8',
  });
  expect(out.trim()).toBe('');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- cli`
Expected: FAIL — cannot find `src/cli.ts`.

- [ ] **Step 3: Implement `src/cli.ts`**

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './db.js';
import { register, heartbeat, touch, endSession, reap, check } from './core.js';
import { formatConflicts } from './format.js';
import { nowSec } from './clock.js';

const DB_PATH =
  process.env.MONKEY_MANAGER_DB ?? join(homedir(), '.claude', 'monkey-manager', 'state.db');
const TTL = (Number(process.env.MONKEY_MANAGER_TTL_MIN) || 30) * 60;
const MAX_ROWS = Number(process.env.MONKEY_MANAGER_MAX_ROWS) || 50;

async function readStdin(): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const p = await readStdin();
  const sid: string | undefined = p.session_id;
  const cwd: string = p.cwd ?? process.cwd();
  const filePath: string | undefined = p.tool_input?.file_path;

  let db;
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = openDb(DB_PATH);
  } catch {
    process.exit(0); // fail open
  }

  const now = nowSec();
  try {
    switch (cmd) {
      case 'on-session-start':
        if (sid) register(db, { session_id: sid, cwd }, now);
        reap(db, now, TTL);
        break;
      case 'on-post-edit':
        if (sid && filePath) touch(db, sid, filePath, now);
        break;
      case 'on-stop':
        if (sid) heartbeat(db, sid, now);
        break;
      case 'on-session-end':
        if (sid) endSession(db, sid);
        break;
      case 'on-pre-edit':
        if (sid && filePath) {
          heartbeat(db, sid, now);
          const conflicts = check(db, sid, [filePath], 'repo', now, TTL, MAX_ROWS);
          if (conflicts.length) {
            process.stdout.write(
              JSON.stringify({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  additionalContext:
                    '⚠️ monkey-manager: another session is working here:\n' +
                    formatConflicts(conflicts, MAX_ROWS),
                },
              }),
            );
          }
        }
        break;
    }
  } catch {
    // fail open — never block a tool on coordination errors
  }
  process.exit(0);
}

void main();
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- cli`
Expected: PASS (5 tests). (Requires `tsx` — it ships transitively with vitest's toolchain; if absent, `npm i -D tsx` and add to devDependencies, then commit that too.)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: hook CLI entrypoint with fail-open and pre-edit warning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: MCP server

**Files:**
- Create: `src/server.ts`, `tests/server.test.ts`

**Verification sub-step (do FIRST):** Determine how a plugin-launched MCP server obtains the **current `session_id`**. Check whether Claude Code sets an env var (e.g. `CLAUDE_SESSION_ID`) for plugin `mcpServers`, via docs or the `claude-code-guide` agent: *"When Claude Code launches a plugin's MCP server (stdio, from plugin.json mcpServers), does it expose the session id to the server process — via env var or otherwise?"*
- **If yes:** read it once at startup → `SESSION_ID`. Tools attribute claims and self-exclusion to it.
- **If no (documented fallback):** the server self-registers using a per-process id `mcp:<repoHash>:<pid>` from `resolveIdentity(process.cwd())`, so claims are still attributable and scoped; note in `agents/monkey-manager-scout.md` and the README that, in this mode, an agent's own hook-touches are not self-excluded from its MCP `check` results. Factor the id into one `getSessionId()` so only it changes.

Tools are factored into a pure `makeTools(db, sessionId, opts)` map so they can be unit-tested without the stdio transport.

- [ ] **Step 1: Write the failing test `tests/server.test.ts`**

```ts
import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { register } from '../src/core.js';
import { makeTools } from '../src/server.js';

function ctx() {
  const db = openDb(':memory:');
  register(db, { session_id: 'mcp-me', cwd: process.cwd() }, 1000);
  register(db, { session_id: 'mcp-other', cwd: process.cwd() }, 1000);
  const tools = makeTools(db, 'mcp-me', { ttl: 1800, maxRows: 50, now: () => 1000 });
  return { db, tools };
}

test('claim then check from another session sees the claim', () => {
  const { db, tools } = ctx();
  tools.claim({ path: 'combat/ai/', note: 'x' });
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
  tools.claim({ path: 'a/', note: 'x' });
  tools.release({});
  expect(db.prepare("SELECT count(*) c FROM work WHERE kind='claim'").get()).toMatchObject({ c: 0 });
});

test('check returns "CLEAR" sentinel when nothing conflicts', () => {
  const { tools } = ctx();
  expect(tools.check({ paths: ['free.gd'] })).toBe('CLEAR');
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- server`
Expected: FAIL — cannot find `../src/server.js`.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, type DB } from './db.js';
import { register, heartbeat, claim, release, check, active, whoami, reap } from './core.js';
import { formatConflicts } from './format.js';
import { resolveIdentity } from './repo.js';
import { nowSec } from './clock.js';

interface Opts {
  ttl: number;
  maxRows: number;
  now: () => number;
}

/** Pure, testable tool implementations. */
export function makeTools(db: DB, sessionId: string, o: Opts) {
  const beat = () => heartbeat(db, sessionId, o.now());
  return {
    check: (a: { paths: string[]; scope?: 'repo' | 'worktree' }) => {
      beat();
      const c = check(db, sessionId, a.paths, a.scope ?? 'repo', o.now(), o.ttl, o.maxRows);
      return c.length ? formatConflicts(c, o.maxRows) : 'CLEAR';
    },
    claim: (a: { path: string; note: string }) => {
      const c = claim(db, sessionId, a.path, a.note, o.now(), o.ttl);
      return c.length ? 'CLAIMED (conflicts):\n' + formatConflicts(c, o.maxRows) : 'CLAIMED';
    },
    release: (_a: Record<string, never>) => {
      release(db, sessionId);
      return 'RELEASED';
    },
    active: (a: { scope?: 'repo' | 'worktree' }) => {
      beat();
      const rows = active(db, sessionId, a.scope ?? 'repo', o.now(), o.ttl, o.maxRows);
      if (!rows.length) return 'none';
      return rows
        .map((r) => `${r.path}\t${r.session_id.slice(0, 8)} ${r.branch ?? '-'} ${r.kind}`)
        .join('\n');
    },
    whoami: (_a: Record<string, never>) => {
      const w = whoami(db, sessionId);
      return w ? `${w.session_id.slice(0, 8)} ${w.repo_label} ${w.branch ?? '-'} ${w.worktree}` : 'unknown';
    },
  };
}

function getSessionId(): string {
  // Adapt per Task 10 verification. Primary: env var set by Claude Code.
  const fromEnv = process.env.CLAUDE_SESSION_ID;
  if (fromEnv) return fromEnv;
  const id = resolveIdentity(process.cwd());
  return `mcp:${id.repo}:${process.pid}`;
}

async function start(): Promise<void> {
  const DB_PATH =
    process.env.MONKEY_MANAGER_DB ?? join(homedir(), '.claude', 'monkey-manager', 'state.db');
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = openDb(DB_PATH);
  const ttl = (Number(process.env.MONKEY_MANAGER_TTL_MIN) || 30) * 60;
  const maxRows = Number(process.env.MONKEY_MANAGER_MAX_ROWS) || 50;
  const sessionId = getSessionId();

  // Ensure a session row exists for this MCP participant; reap on boot.
  register(db, { session_id: sessionId, cwd: process.cwd() }, nowSec());
  reap(db, nowSec(), ttl);

  const tools = makeTools(db, sessionId, { ttl, maxRows, now: nowSec });
  const server = new McpServer({ name: 'monkey-manager', version: '0.1.0' });

  server.tool('check', 'Check if paths are being worked on by other sessions.',
    { paths: z.array(z.string()), scope: z.enum(['repo', 'worktree']).optional() },
    async (a) => ({ content: [{ type: 'text', text: tools.check(a) }] }));
  server.tool('claim', 'Reserve a file or directory (trailing /) with a note.',
    { path: z.string(), note: z.string() },
    async (a) => ({ content: [{ type: 'text', text: tools.claim(a) }] }));
  server.tool('release', 'Release all claims held by this session.',
    {}, async () => ({ content: [{ type: 'text', text: tools.release({}) }] }));
  server.tool('active', 'List active work in scope.',
    { scope: z.enum(['repo', 'worktree']).optional() },
    async (a) => ({ content: [{ type: 'text', text: tools.active(a) }] }));
  server.tool('whoami', 'Show this session identity.',
    {}, async () => ({ content: [{ type: 'text', text: tools.whoami({}) }] }));

  await server.connect(new StdioServerTransport());
}

// Only start the transport when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('server.js')) void start();
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- server`
Expected: PASS (4 tests). Then run the whole suite: `npm test` — all green. Then `npm run typecheck` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: MCP server exposing core tools (testable tool map)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Plugin manifest, scout agent, install script, build

**Files:**
- Create: `.claude-plugin/plugin.json`, `agents/monkey-manager-scout.md`, `scripts/install-claude-md.mjs`, `tests/install.test.ts`, `README.md`

- [ ] **Step 1: Write the failing test `tests/install.test.ts`**

```ts
import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertBlock } from '../scripts/install-claude-md.mjs';

const dirs: string[] = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'orch-inst-')); dirs.push(d); return d; }
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('upsertBlock adds the marker block once and is idempotent', () => {
  const d = tmp();
  const f = join(d, 'CLAUDE.md');
  writeFileSync(f, '# Project\n');
  upsertBlock(f);
  upsertBlock(f); // second run must not duplicate
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- install`
Expected: FAIL — cannot find `../scripts/install-claude-md.mjs`.

- [ ] **Step 3: Implement `scripts/install-claude-md.mjs`**

```js
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- monkey-manager -->';
const END = '<!-- /monkey-manager -->';
const BLOCK = `${START}
## Monkey Manager (concurrent-session coordination)
Coordination is automatic: you are warned before editing a file another live
session is working on. To reserve an area ahead of time, dispatch the
\`monkey-manager-scout\` (haiku) agent to \`claim\`/\`check\` it.
${END}`;

export function upsertBlock(path) {
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let next;
  if (prev.includes(START) && prev.includes(END)) {
    next = prev.replace(new RegExp(`${START}[\\s\\S]*?${END}`), BLOCK);
  } else {
    next = (prev ? prev.replace(/\s*$/, '') + '\n\n' : '') + BLOCK + '\n';
  }
  writeFileSync(path, next);
}

// CLI: `node scripts/install-claude-md.mjs [path]`
if (process.argv[1] && process.argv[1].endsWith('install-claude-md.mjs')) {
  upsertBlock(process.argv[2] ?? 'CLAUDE.md');
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npm test -- install`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `.claude-plugin/plugin.json`**

Hooks call the built CLI subcommands; the MCP server is the built server. `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code.

```json
{
  "name": "monkey-manager",
  "version": "0.1.0",
  "description": "Coordinate concurrent Claude sessions in one repo (advisory collision avoidance).",
  "mcpServers": {
    "monkey-manager": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]
    }
  },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js on-session-start" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js on-session-end" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js on-stop" }] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js on-pre-edit" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js on-post-edit" }] }
    ]
  }
}
```

> Verify the manifest hook/MCP key shapes against the current plugins schema (https://code.claude.com/docs/en/plugins.md) during this step; adjust key names if the schema differs, keeping the same five events + one MCP server + the agents directory.

- [ ] **Step 6: Write `agents/monkey-manager-scout.md`**

```markdown
---
name: monkey-manager-scout
description: Cheap haiku scout for the monkey-manager coordination MCP. Dispatch to check or claim paths before working; returns a one-line verdict so DB chatter stays off the main context.
model: haiku
tools: [mcp__monkey-manager__check, mcp__monkey-manager__claim, mcp__monkey-manager__release, mcp__monkey-manager__active, mcp__monkey-manager__whoami]
---

You are a coordination scout. You call ONLY the monkey-manager MCP tools and reply
with a single verdict line. Never paste raw tool output, never add prose.

- To check paths: call `check` with the path list. Reply exactly `CLEAR`, or
  `CONFLICT: <path> held by <label>/<branch> "<note>" (<age>)` — one line per
  conflict, max 10 lines, then `+N more`.
- To reserve: call `claim` with the path and a short note; reply `CLAIMED` or
  `CLAIMED (conflicts): ...` (same one-line-per-conflict format).
- To release: call `release`; reply `RELEASED`.
- Keep the reply to verdict lines only.
```

- [ ] **Step 7: Write `README.md`** (install + usage, ≤40 lines): document `npm install && npm run build`, that the plugin auto-registers hooks + MCP, the `MONKEY_MANAGER_DB` / `MONKEY_MANAGER_TTL_MIN` / `MONKEY_MANAGER_MAX_ROWS` env vars, the local-filesystem requirement for the DB, and `node scripts/install-claude-md.mjs <repo>/CLAUDE.md` to add the advisory note. Note the Task-10 session-id mode actually shipped.

- [ ] **Step 8: Build and full verification**

Run: `npm run build && npm test && npm run typecheck`
Expected: `dist/` produced; all suites PASS; no type errors. Confirm `dist/cli.js` and `dist/server.js` exist:
Run: `ls dist/cli.js dist/server.js`
Expected: both listed.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin/plugin.json agents/monkey-manager-scout.md scripts/install-claude-md.mjs tests/install.test.ts README.md
git commit -m "feat: plugin manifest, haiku scout, CLAUDE.md install script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (each SPEC.md requirement → task):
- R1 register on start → Task 4 (`register`), Task 9 (`on-session-start`), Task 11 (manifest `SessionStart`).
- R2 auto-track work → Task 5 (`touch`), Task 9 (`on-post-edit`), Task 11 (`PostToolUse`).
- R3 auto-warn → Task 6 (`check`), Task 9 (`on-pre-edit`), Task 11 (`PreToolUse`).
- R4 explicit claim/query → Task 5 (`claim`), Task 6 (`check`), Task 10 (MCP tools).
- R5 both surfaces share core → `core.ts` imported by `cli.ts` (Task 9) and `server.ts` (Task 10).
- R6 SQLite → Task 1.
- R7 repo namespacing → Task 3 (`resolveIdentity` repo hash), used everywhere.
- R8 worktree sub-namespacing → Task 3 (worktree), Task 6/7 (`scope`).
- R9 cleanup on finish → Task 7 (`endSession`), Task 9 (`on-session-end`), Task 11 (`SessionEnd`).
- R10 crash-safe heartbeat/TTL → Task 4 (`heartbeat`), Task 7 (`reap`), Task 9 (`on-stop` heartbeat), Task 10 (MCP beats).
- Scout agent → Task 11. Install CLAUDE.md note → Task 11. Local-FS DB note → Task 11 README.
- Out-of-scope items (hard locks, minimatch, released_at) → correctly absent.

**Placeholder scan:** No "TBD"/"implement later". The two platform unknowns (Tasks 9, 10) are explicit verification sub-steps with a concrete default and a concrete fallback — not deferrals.

**Type consistency:** `Conflict`, `ActiveRow`, `SessionRow`, `WorkRow`, `Kind`, `Scope` defined once (db.ts/core.ts) and reused. Function names stable across tasks: `register/heartbeat/whoami/getSession` (T4), `touch/claim/release` (T5), `check` (T6, stub in T5), `active/reap/endSession` (T7), `formatAge/formatConflicts` (T8), `makeTools/getSessionId` (T10), `upsertBlock` (T11). `check` signature `(db, session_id, paths, scope, now, ttl, maxRows)` is identical in the T5 stub and the T6 implementation.

**Scope:** One plugin, ~12 commits, each independently green. No decomposition needed.
