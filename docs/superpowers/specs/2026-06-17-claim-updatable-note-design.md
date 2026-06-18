# Claim as an updatable advisory note — Design

**Date:** 2026-06-17
**Status:** Approved (design)
**Scope:** A small change to the existing `claim` tool. No new tool, no new `kind`, no schema migration.

## Summary

Turn the existing `claim(path, note)` MCP tool into a **live shared scratchpad**: a path-anchored note that one live session leaves for other concurrent live sessions, is **updatable** (latest-only, overwrite), and lives only as long as the session (reaped at TTL/SessionEnd like all work). This is delivered by fixing one bug — `claim` currently uses `INSERT OR IGNORE`, so re-claiming a path silently drops the update — plus a length cap to protect the token budget.

The feature the user asked for ("running-session memory management") was narrowed through brainstorming to: a **path-anchored, latest-only, concurrent-lifetime** scratchpad. The existing `claim(path, note)` already provides path-anchoring, concurrent lifetime, and cross-session visibility (it surfaces in `check`, `active`, and the pre-edit warning). The only missing pieces are mutability and a size bound. So the feature reduces to fixing and bounding `claim`.

## Why this and not a new `note` tool

A four-lens review (correctness, token-impact, scope/over-engineering, devil's-advocate) converged on dropping the originally-proposed separate `note(path, text)` tool:

- `claim(path, note)` already stores a path-anchored, note-bearing, concurrent-lifetime `work` row. A second tool that writes the *same* row shape is a rename — a third write-verb (claim/release/note) an agent must choose between — for **zero new capability**.
- No concrete, repeated user need was identified that a "note that is explicitly *not* a reservation" serves over `claim` + an upsert fix. In an advisory system nothing is actually reserved, so a claim already means "I'm working here, FYI."
- Storing notes as `kind='claim'` (the way to avoid a new kind) was found to introduce three regressions, all avoided by simply keeping one verb: `release()` deleting notes, `check()` precedence masking a real edit behind a passive note, and directory-note warning fan-out.

A distinct `kind='note'` (so notes survive `release()` and render differently) was considered and **deferred**: it costs ~5 ripple points (kind type, format, check precedence, release filter, overlap rule) and is only worth it if notes must outlive a `release()` and read as visually distinct from reservations. No current need justifies it. Revisit if one appears.

## Decisions (locked)

1. **One verb.** Extend `claim`; do **not** add a `note` tool. Document that `claim` *is* an updatable advisory note.
2. **Upsert text only.** On re-claim, overwrite `note`; **do not** bump `created_at`.
3. **Length cap** the note at the trust boundary (`.max(200)`).
4. **`touch` unchanged** — stays `INSERT OR IGNORE` (SPEC R2: "refresh nothing, ignore if present").
5. No new `kind`, no schema migration, no changes to `format`, `release`, overlap rule, or reap.

## The change

### 1. `src/core.ts` — `claim()` becomes an upsert

Current (`core.ts:86-89`) silently ignores a second claim on the same `work_dedupe` key `(repo, session_id, worktree, path, kind)`:

```sql
INSERT OR IGNORE INTO work (session_id, repo, worktree, path, kind, note, created_at)
VALUES (?, ?, ?, ?, 'claim', ?, ?)
```

New — overwrite the note on conflict, leave `created_at` intact:

```sql
INSERT INTO work (session_id, repo, worktree, path, kind, note, created_at)
VALUES (?, ?, ?, ?, 'claim', ?, ?)
ON CONFLICT(repo, session_id, worktree, path, kind)
DO UPDATE SET note = excluded.note
```

`node:sqlite` supports this UPSERT form (`register()` already uses `ON CONFLICT(session_id) DO UPDATE SET …` at `core.ts:36`). The conflict target matches the existing `work_dedupe` unique index in `src/db.ts`.

**Why `created_at` is not bumped:** `age_sec = now - created_at` (`core.ts`) is the "how long has this session been parked here" signal, rendered on every conflict line (`format.ts:16`) and used to weigh merge risk. Bumping it on every note edit would reset a session that has been camped on a hot file for an hour to "just arrived" — actively misleading the exact read the tool exists to inform. First-claim time is the right anchor for a latest-only note.

### 2. `src/server.ts` — cap the note length

The `claim` tool's `note` input is currently an unbounded `z.string()`. An unbounded note lands verbatim in `check` / `active` / pre-edit output; `MONKEY_MANAGER_MAX_ROWS` caps the number of rows, **not** their byte size, so a single long note can inject hundreds of tokens. Add `.max(200)` to the `note` field. This is the only required validation gap; the SPEC already commits to "terse and bounded" output.

`200` chars is a tunable default chosen to fit comfortably on one conflict line; it is not exposed as an env override unless a need appears.

### 3. Documentation

- **`src/server.ts` — the `claim` tool `description` string (`server.ts:89`).** Currently "Reserve a file or directory (trailing /) with a note." This is **agent-facing** (it loads into the tool-list every session sees), so it matters more than the prose docs. Update it to signal updatability, e.g. "Claim/annotate a file or directory (trailing /); re-claim the same path to update its note."
- `SPEC.md`: update the `claim` tool entry and the data-model note to state that `claim` is now upsert / latest-only / length-capped — i.e. "an updatable advisory note." Remove the implication that re-claiming is ignored.
- `README.md` (optional — ponytail-cut): a one-line "re-claim to update the note" is redundant with the SPEC contract and the tool description; skip unless wanted.
- The installed `CLAUDE.md` advisory block already references `claim`/`check`; no change needed.

## Data model

Unchanged. Notes continue to live as `kind='claim'` rows in the existing `work` table, deduped by the `work_dedupe` unique index, joined to a live `sessions` row, and reaped when the session ages out (TTL) or ends (SessionEnd). No new columns, no `updated_at`, no migration.

## Token impact

- **No-conflict hot path: 0 extra tokens.** All hooks return empty except the pre-edit hook, which emits only on a real conflict. A note is a `kind='claim'` row, so it can surface *only* through `check` / `active` / the pre-edit warning — never through PostToolUse/Stop/SessionEnd.
- **On a surfaced conflict: ~30 tokens per line** (note body plus mandatory per-row scaffolding: path, short session id, branch, age, tab). The body is now hard-capped at 200 chars (~50 tokens), and the whole result is bounded by `MAX_ROWS`.
- **No new tool schema.** Because we reuse `claim`, no additional MCP tool definition is added to any session's tool-list. (Note: a connected MCP server's tool schemas load into the context of every thread it is mounted in; the haiku scout keeps tool *output* off the main thread but cannot keep a tool *schema* off it. Reusing `claim` sidesteps this entirely.)
- **Pre-existing, unchanged:** a directory claim (trailing `/`) overlap-matches every path under it, so a directory note warns on edits across that subtree. This is existing `claim` behavior, neither introduced nor worsened here.

## Out of scope (deliberately cut)

- A separate `note` tool or `kind='note'` (deferred — see rationale above).
- Note history / append log (the scratchpad is latest-only).
- Notes that survive the author's session (cross-session handoff is carved out by the SPEC — that is tokensave `session_*` / `RESUME.md`).
- Notes on auto-`touch` rows, a per-session status line, per-path note deletion, an env-configurable length cap.

## Testing

Two cases (ponytail-trimmed: the original "regression" case re-asserted untouched code — `touch`, `check`, `release`, reap — already covered by the existing suite, so it is dropped).

1. **Upsert overwrites note, age anchored to first claim** (`tests/core-work.test.ts`) — `claim(path, "a")`, advance the clock, then `claim(path, "b")`; assert the single `work` row for that dedupe key now has note `"b"`, there is still exactly one row, and `created_at` is unchanged from the first claim (so reported age reflects the first claim). This one test pins the whole behavior change.
2. **Length cap** (`tests/server.test.ts`) — the `claim` tool rejects a note longer than 200 chars. Kept despite being thin (ponytail flagged it as testing the library): it guards a token-budget trust boundary, which the ponytail rules themselves exempt from cutting. One assertion, no ceremony.

## Files touched

- `src/core.ts` — `claim()` upsert.
- `src/server.ts` — `.max(200)` on the claim note schema **and** the agent-facing `claim` tool `description` string.
- `SPEC.md` — doc update (`README.md` optional, ponytail-cut).
- `tests/core-work.test.ts` — case 1.
- `tests/server.test.ts` — case 2 (length-cap validation).

## Review notes (2026-06-17)

Reviewed by a three-agent fleet (caveman file-review, ponytail over-engineering, code fact-check) plus the earlier four-lens design review:

- **Fact-check:** all code claims and line references verified against current source — PASS, no corrections.
- **Caveman:** caught one gap — the agent-facing `claim` tool `description` (`server.ts:89`) was missing from the doc edits; added above. Empty notes (`claim ""`) are allowed and render harmlessly; no `.min()` added (YAGNI).
- **Ponytail:** trimmed 4 test cases → 2 (folded age-preservation into the upsert test; dropped the regression of untouched code) and downgraded the README edit to optional. Upsert + `.max(200)` + one SPEC sentence + the two tests is the lazy-but-safe floor.
