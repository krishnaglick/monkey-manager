# Claim as an Updatable Advisory Note — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `claim(path, note)` MCP tool an updatable, length-capped advisory note (a live shared scratchpad), by fixing `claim`'s `INSERT OR IGNORE` to an upsert and bounding the note.

**Architecture:** One SQL change in `src/core.ts` (`INSERT OR IGNORE` → `ON CONFLICT … DO UPDATE SET note`, leaving `created_at` so age stays anchored to the first claim). One validation + doc change in `src/server.ts` (`.max(200)` on the note, exported schema for testability, updated agent-facing tool description). A SPEC.md doc update. No new tool, no new `kind`, no schema migration. Notes ride the existing `check`/`active`/pre-edit surfaces unchanged.

**Tech Stack:** Node ≥ 22.5, TypeScript, built-in `node:sqlite`, `zod` (MCP input schemas), `vitest` (tests against `:memory:` SQLite).

**Spec:** `docs/superpowers/specs/2026-06-17-claim-updatable-note-design.md`

---

## File Structure

- **Modify** `src/core.ts` — `claim()` SQL becomes an upsert (text only). Function signature unchanged.
- **Modify** `src/server.ts` — extract `claim` input schema to an exported const with `.max(200)` on `note`; update the `claim` tool `description` string. `makeTools.claim` (pure impl) unchanged.
- **Modify** `SPEC.md` — `claim` tool entry + lifecycle row now say "upsert / updatable / latest-only / capped."
- **Test** `tests/core-work.test.ts` — add the upsert/age test (Task 1).
- **Test** `tests/server.test.ts` — add the length-cap schema test (Task 2).

`touch()` is deliberately **not** touched (stays `INSERT OR IGNORE`). `format.ts`, `release()`, the overlap rule, and reap are unchanged. `README.md` edit is optional (ponytail-cut) and omitted.

Tests run against source via vitest (`tests/*.test.ts` import from `../src/*.js`), so no build is needed to run them. Commits happen on the currently checked-out branch.

---

### Task 1: `claim()` becomes an upsert (text only, age preserved)

**Files:**
- Modify: `src/core.ts:86-89` (the `INSERT OR IGNORE` block inside `claim()`)
- Test: `tests/core-work.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/core-work.test.ts`:

```ts
test('re-claim updates the note, keeps one row, preserves created_at', () => {
  const { db } = setup();
  claim(db, 's1', 'combat/ai/', 'first', 1001, 1800);
  claim(db, 's1', 'combat/ai/', 'second', 1005, 1800); // same path, later clock
  const rows = db.prepare("SELECT * FROM work WHERE kind='claim'").all() as any[];
  expect(rows).toHaveLength(1); // upsert, not a second row
  expect(rows[0].note).toBe('second'); // note overwritten
  expect(rows[0].created_at).toBe(1001); // age anchored to FIRST claim, not bumped
});
```

(`setup`, `claim`, `openDb` are already imported at the top of this file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core-work.test.ts -t 're-claim updates the note'`
Expected: FAIL. With the current `INSERT OR IGNORE`, the second claim is ignored, so `rows[0].note` is still `'first'` — the `expect(rows[0].note).toBe('second')` assertion fails. (`toHaveLength(1)` and `created_at === 1001` already hold.)

- [ ] **Step 3: Implement the upsert**

In `src/core.ts`, inside `claim()`, replace this exact block (lines ~86-89):

```ts
  db.prepare(`
    INSERT OR IGNORE INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'claim', ?, ?)
  `).run(session_id, s.repo, s.worktree, path, note, now);
```

with:

```ts
  db.prepare(`
    INSERT INTO work (session_id, repo, worktree, path, kind, note, created_at)
    VALUES (?, ?, ?, ?, 'claim', ?, ?)
    ON CONFLICT(repo, session_id, worktree, path, kind)
    DO UPDATE SET note = excluded.note
  `).run(session_id, s.repo, s.worktree, path, note, now);
```

The `.run(...)` arguments are unchanged. `DO UPDATE SET note = excluded.note` overwrites only the note; `created_at` is left at its first-insert value. The conflict target `(repo, session_id, worktree, path, kind)` matches the `work_dedupe` unique index in `src/db.ts`. (This UPSERT form is already used by `register()` at `core.ts:36`, so `node:sqlite` supports it.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/core-work.test.ts`
Expected: PASS — the new test plus all existing tests in the file (`touch ... dedupes`, `claim records a claim row with note`, `release deletes only this session claims`) stay green.

- [ ] **Step 5: Commit**

```bash
git add src/core.ts tests/core-work.test.ts
git commit -m "feat: claim upserts its note (updatable, age preserved)"
```

---

### Task 2: Cap note length at 200 + update the agent-facing tool description

**Files:**
- Modify: `src/server.ts:86-93` (the `claim` `registerTool` block) and add an exported schema const
- Test: `tests/server.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/server.test.ts`:

```ts
test('claim note schema caps length at 200', () => {
  expect(claimInputSchema.note.safeParse('x'.repeat(200)).success).toBe(true);
  expect(claimInputSchema.note.safeParse('x'.repeat(201)).success).toBe(false);
});
```

And add `claimInputSchema` to the existing server import at the top of the file. Change:

```ts
import { makeTools } from '../src/server.js';
```

to:

```ts
import { makeTools, claimInputSchema } from '../src/server.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/server.test.ts -t 'caps length at 200'`
Expected: FAIL — `claimInputSchema` is not yet exported (import resolves to `undefined`; the test throws on `claimInputSchema.note`).

- [ ] **Step 3: Add the exported, capped schema and use it; update the description**

In `src/server.ts`, add an exported const just above the `start()` function (after `makeTools`, e.g. after line 54):

```ts
/** Input schema for the `claim` tool. Exported so the note length cap is testable. */
export const claimInputSchema = { path: z.string(), note: z.string().max(200) };
```

Then change the `claim` `registerTool` block (lines ~86-93) from:

```ts
  server.registerTool(
    'claim',
    {
      description: 'Reserve a file or directory (trailing /) with a note.',
      inputSchema: { path: z.string(), note: z.string() },
    },
    async (a) => ({ content: [{ type: 'text', text: tools.claim(a) }] }),
  );
```

to:

```ts
  server.registerTool(
    'claim',
    {
      description:
        'Claim/annotate a file or directory (trailing /); re-claim the same path to update its note.',
      inputSchema: claimInputSchema,
    },
    async (a) => ({ content: [{ type: 'text', text: tools.claim(a) }] }),
  );
```

(`z` is already imported at `server.ts:3`. `makeTools.claim` is left unchanged — the cap lives only at the MCP input boundary, the single trust boundary; core `claim()` stays uncapped as the one source of truth.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS — the new cap test plus all existing server tests stay green.

- [ ] **Step 5: Verify types still compile**

Run: `npm run typecheck`
Expected: no errors (exporting the schema const and reusing it introduces no type changes).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: cap claim note at 200 chars; signal updatable in tool description"
```

---

### Task 3: Documentation (SPEC.md)

**Files:**
- Modify: `SPEC.md` (the `claim` tool bullet under "MCP tools", and the `claim` row in the Lifecycle table)

No test (documentation only).

- [ ] **Step 1: Update the `claim` tool entry**

In `SPEC.md`, under "## MCP tools", replace the `claim` bullet:

```markdown
- **`claim(path, note)`** — register a forward claim on a file or directory (trailing `/`); returns any current conflicts.
```

with:

```markdown
- **`claim(path, note)`** — register or **update** an advisory note on a file or directory (trailing `/`). Latest-only: re-claiming the same path overwrites the note (the displayed age stays anchored to the first claim). The note is capped at 200 characters. Returns any current conflicts. Reaped with the session (TTL/SessionEnd) like all work.
```

- [ ] **Step 2: Update the Lifecycle table row**

In `SPEC.md`, in the "### Lifecycle" table, replace the `claim` action cell:

```markdown
| R3/R4 | MCP `claim` | Insert a `claim` row (path or dir + note). |
```

with:

```markdown
| R3/R4 | MCP `claim` | Upsert a `claim` row (path or dir + note); re-claim overwrites the note, leaves `created_at`. |
```

- [ ] **Step 3: Commit**

```bash
git add SPEC.md
git commit -m "docs: SPEC reflects claim upsert (updatable, capped note)"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all tests green (the prior 50 plus the 2 new ones = 52).

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no type errors; `tsc` emits `dist/` cleanly.

---

## Self-Review

**Spec coverage:**
- Decision 1 (one verb, no `note` tool) — honored: nothing new added. ✓
- Decision 2 (upsert text only, no `created_at` bump) — Task 1 (SQL + the `created_at === 1001` assertion). ✓
- Decision 3 (`.max(200)` at trust boundary) — Task 2. ✓
- Decision 4 (`touch` unchanged) — not modified; existing `touch ... dedupes` test still asserts `INSERT OR IGNORE` behavior. ✓
- Decision 5 (no kind/migration/format/release/reap change) — none touched. ✓
- Doc updates incl. agent-facing tool description — Task 2 (description) + Task 3 (SPEC). README optional/omitted. ✓
- Two tests (upsert/age, length cap) — Task 1 + Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands.

**Type consistency:** `claimInputSchema` is the same name in `src/server.ts` (export) and `tests/server.test.ts` (import). `claim()`'s signature is unchanged across Task 1. The `.run(...)` argument list is identical before and after the SQL change.
