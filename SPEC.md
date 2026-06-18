# Monkey Manager — Spec

A Claude Code plugin that coordinates **concurrent Claude sessions working in the same repo** so they don't collide on the same work. It ships an MCP server and lifecycle hooks backed by a SQLite database, installs with minimal manual setup, and is designed so agents need to interact with it as little as possible. Collision avoidance works **automatically** (a pre-edit hook warns on real conflicts); explicit claims and queries are available on top for forward planning.

## Scope

**This system IS:** a live presence-and-claims layer. Each session registers itself, automatically records which files it touches, is automatically warned before editing a file another live session is working on, and can place an explicit forward-looking claim on a code area. Coordination is **advisory** — it informs decisions and warns; it never blocks a tool.

**This system IS NOT:**
- A history/recall store — that is tokensave's `session_*` / `record_code_area` tools.
- A session-resume narrative — that is `RESUME.md`.
- A hard lock / mutex — claims are advisory, not enforced.

The delta that justifies this plugin over existing tooling is *live coordination between concurrent sessions*. It complements the above; it does not replace them.

## Requirements

Refined from the original seven, made precise:

1. **R1 — Register on start.** On session creation, a `SessionStart` hook records the session with a stable id and its repo/worktree location. Identity resolved here is **frozen** for the session.
2. **R2 — Track work automatically.** A `PostToolUse` hook on `Edit`/`Write`/`MultiEdit` records each touched file path for the session — no agent action required.
3. **R3 — Warn on collision automatically.** A `PreToolUse` hook on `Edit`/`Write`/`MultiEdit` checks the target file against other live sessions and emits an advisory warning *only when a real conflict exists* (silent and non-blocking otherwise). This is what makes coordination fire-and-forget — it does not depend on the agent remembering to query.
4. **R4 — Track work explicitly (optional).** An agent may register a forward-looking claim on a path (or directory) with a short note, and query arbitrary paths, via the MCP server.
5. **R5 — Queryable both ways.** All state is reachable from the MCP server *and* from the hook scripts, because both import one shared core module.
6. **R6 — SQLite.** State lives in a single SQLite database.
7. **R7 — Repo namespacing.** Every row is namespaced to a stable repo identity, derived so that all worktrees of a repo share it.
8. **R8 — Worktree sub-namespacing.** Rows also carry the worktree, so queries can scope to one worktree *or* see the whole repo across all its worktrees.
9. **R9 — Cleanup on finish.** `SessionEnd` deletes the session's work and its session row.
10. **R10 — Crash-safe.** Because `SessionEnd` may not fire on crash or kill, every session heartbeats while alive (any hook or MCP call bumps `last_seen`); work belonging to a session whose `last_seen` is older than a TTL is treated as inactive and reaped. No claim can block others forever; no liveness probing is needed.

## Architecture

### Runtime and layout

Node / TypeScript. Hooks and the MCP server both import one shared `core` module, so the MCP server "calls into the scripts" by sharing their code path — no per-call process spawn. Requires Node ≥ 22.5 — it uses the built-in `node:sqlite`, so there is no native dependency and no build toolchain needed to install.

```
monkey-manager/
  .claude-plugin/plugin.json     # registers hooks + MCP server + bundled agent
  src/core.ts                    # all logic: register, claim, release, touch, check, active, heartbeat, reap
  src/db.ts                      # node:sqlite (built-in): open (WAL), schema, migrations
  src/repo.ts                    # repo/worktree identity from git
  server.ts                      # MCP stdio server — thin; every tool calls core (+ heartbeats)
  hooks/on-session-start.mjs     # SessionStart -> core.register() (freezes identity) + reap
  hooks/on-pre-edit.mjs          # PreToolUse(Edit|Write|MultiEdit) -> core.check(file); warn on conflict
  hooks/on-post-edit.mjs         # PostToolUse(Edit|Write|MultiEdit) -> core.touch() + heartbeat
  hooks/on-stop.mjs              # Stop -> core.heartbeat() ONLY (fires every turn)
  hooks/on-session-end.mjs       # SessionEnd -> core.endSession() (delete work + session row)
  agents/monkey-manager-scout.md   # bundled haiku agent (see "Scout agent")
```

**All hooks are silent to the model** — they write to the database (and an optional log file) and emit zero bytes into the agent's context. The single exception is `on-pre-edit.mjs`, which emits an advisory warning string **only when it finds a real conflict**.

### Database location

A single **global** database at `~/.claude/monkey-manager/state.db` (override with `MONKEY_MANAGER_DB`). One global file — rather than per-repo files — is what lets all worktrees of a repo share state (R7/R8) and makes cross-repo queries possible. Rows are namespaced by the `repo` and `worktree` columns, not by file location.

> The database must live on a **local** filesystem. SQLite WAL mode is unsafe over networked filesystems (NFS/SMB); if `~/.claude` is network-mounted, point `MONKEY_MANAGER_DB` at a local path.

### Identity (frozen at SessionStart)

`SessionStart` resolves identity once and stores it on the `sessions` row. **Every later hook looks the row up by `session_id`** and reuses the stored values — it never re-derives identity from the current working directory, which can change mid-session.

- **`session_id`** — from the hook payload's `session_id` field; the agent id (R1). Sub-agents dispatched via the Task tool share their parent's `session_id` (verified Claude Code behavior), so their edits roll up to the parent. Throughout this spec, "agent" means "session".
- **`repo`** — first 12 hex of SHA-1 of the absolute `git rev-parse --git-common-dir`. The common dir is shared by every worktree of a repo, so this id is stable across worktrees (R7). **Fallback** (not a git repo): hash of the SessionStart `cwd`; frozen, so later hooks stay consistent even if the agent moves.
- **`repo_label`** — basename of the repo root, for human-readable output.
- **`worktree`** — absolute path from `git rev-parse --show-toplevel`. **`branch`** — `git rev-parse --abbrev-ref HEAD`, shown in output to disambiguate cross-worktree hits. For the primary checkout, `worktree` equals the repo root (R8).

### Data model

WAL mode, `busy_timeout = 5000ms`.

```sql
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  repo_label TEXT NOT NULL,
  worktree   TEXT NOT NULL,
  branch     TEXT,
  cwd        TEXT NOT NULL,       -- SessionStart cwd; basis of non-git fallback id
  started_at INTEGER NOT NULL,    -- unix seconds
  last_seen  INTEGER NOT NULL     -- heartbeat; sole liveness signal
);

CREATE TABLE work (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  repo       TEXT NOT NULL,
  worktree   TEXT NOT NULL,
  path       TEXT NOT NULL,       -- worktree-relative; dir-claim ends in '/', else a file
  kind       TEXT NOT NULL,       -- 'claim' | 'touch'
  note       TEXT,                -- what they're working on; claims only
  created_at INTEGER NOT NULL     -- for "since" display
);

CREATE UNIQUE INDEX work_dedupe ON work (repo, session_id, worktree, path, kind);
CREATE INDEX work_repo ON work (repo);
```

There is no `released_at` and no per-row `last_seen`: release and cleanup **delete** rows, and liveness is a single per-session signal. A `work` row is **active** iff its session row still exists and `sessions.last_seen > now - TTL` (a join). All paths are stored **relative to the session's frozen worktree toplevel**, which makes them directly comparable across worktrees of the same repo (same tree structure → same relative path for the same logical file).

### Lifecycle

| Req | Hook / call | Action |
|-----|------------|--------|
| R1 | `SessionStart` | Resolve + **freeze** identity; upsert `sessions` row. Run a lazy reap. |
| R3 | `PreToolUse` (`Edit\|Write\|MultiEdit`) | Look up own session row; normalize `tool_input.file_path` to worktree-relative; run `check` for it; **if a conflict exists, emit an advisory warning** into context (non-blocking, exit 0); else silent. Bump `last_seen`. |
| R2 | `PostToolUse` (`Edit\|Write\|MultiEdit`) | Upsert a `touch` row (path from `tool_input.file_path`, made worktree-relative; deduped by the unique index — refresh nothing, ignore if present). Bump `last_seen`. |
| R10 | `Stop` | Bump `last_seen` **only** — no release. Stop fires at the end of every turn, so it is a reliable liveness heartbeat even for read/think-only turns. |
| R10 | any MCP tool call | Bump `last_seen`. |
| R3/R4 | MCP `claim` | Upsert a `claim` row (path or dir + note); re-claim overwrites the note, leaves `created_at`. |
| R9 | `SessionEnd` | In one transaction: delete this session's `work` rows, then delete its `sessions` row. |
| R10 | lazy reap (on `SessionStart` and on every read/write path) | Delete `work` whose session is missing or stale (`last_seen < now - TTL`); delete stale `sessions` rows. |

**TTL** defaults to 30 minutes (`MONKEY_MANAGER_TTL_MIN`). `Stop` (every turn) plus `PostToolUse` and MCP calls keep a live session fresh; a crashed session stops heartbeating and ages out. Reap runs on read paths too (`check`/`active`/`claim`), so a quiet repo still self-heals.

> `MultiEdit` operates on a single file and carries `tool_input.file_path` like `Edit`/`Write`. Any matched tool that lacks `file_path` (or carries a different shape) is skipped rather than mis-recorded.

## MCP tools

Output is terse and **bounded**: filtering and overlap are computed in SQL/core, results are deduped by session, capped at `MONKEY_MANAGER_MAX_ROWS` (default 50, with a `+N more` tail), and emitted one fixed-format line per conflict. Free paths are omitted.

- **`check(paths: string[], scope = "repo" | "worktree" = "repo")`** — the collision query. Takes a list of paths (single path = a one-element list). Returns, per path that has a conflict, the **other live sessions** whose active work overlaps it; cross-worktree hits are annotated so the caller can weigh merge risk. Empty result = all clear.
  ```
  check(["combat/ai/foo.gd", "stats/job.gd", "ui/hud.gd"])
  -> combat/ai/foo.gd  sess-def  wave-0A [wt:combat-ai]  claim "AI gambit refactor"  9m
     ui/hud.gd         sess-ghi  main                    touch                       2m
     # stats/job.gd omitted -> free
  ```
- **`claim(path, note)`** — register or **update** an advisory note on a file or directory (trailing `/`). Latest-only: re-claiming the same path overwrites the note (the displayed age stays anchored to the first claim). The note is capped at 200 characters. Returns any current conflicts. Reaped with the session (TTL/SessionEnd) like all work.
- **`release()`** — delete this session's **claims** (no argument). Touches are auto-managed (recorded on edit, cleared at SessionEnd/TTL); they are not manually released.
- **`active(scope = "repo" | "worktree" = "repo")`** — the bounded board of active work in scope.
- **`whoami`** — this session's `session_id`, `repo_label`, `worktree`, `branch`. (Timestamps omitted.)

### Overlap rule

For a query path `P` (worktree-relative), match active `work` rows **in the same repo** (all worktrees when `scope = "repo"`; only the caller's worktree when `scope = "worktree"`), excluding the caller's own session, then **dedupe by session** (a session appearing as both claim and touch on `P` collapses to one line, preferring the claim + its note):

- `kind = 'claim'`, directory (ends in `/`): match if `P` starts with it (the trailing slash prevents `combat/ai/` matching `combat/aifoo.gd`).
- `kind = 'claim'`, file, or `kind = 'touch'`: match if `P` equals it.

Matching is advisory: `check`/`claim` and the pre-edit hook report or warn, but never block a tool call.

## Scout agent

To make cheap-model delegation turnkey, the plugin **bundles a haiku agent**, `agents/monkey-manager-scout.md`:

- Model: `haiku`. Tools: the monkey-manager MCP only.
- **Pinned output contract:** it returns exactly one verdict line — `CLEAR`, or `CONFLICT: <path> held by <label>/<branch> "<note>" (<age>)` (one line per conflict, capped). It must **not** pass raw tool output back to the caller.
- The main thread dispatches the scout instead of calling the MCP directly, so path lists and DB chatter stay off the expensive main context.

Token minimization therefore lands four ways: silent hooks, terse bounded SQL-side output, the cheap model, and keeping monkey-manager traffic off the main context. (The pre-edit warning already covers the common case automatically, so the scout/`check` is mainly for forward planning of larger areas.)

## Install

- The plugin manifest registers the hooks, the MCP server, and the scout agent automatically — no manual `settings.json` editing for a plugin-based install.
- Install appends a **small (≤5 line), idempotent, marker-delimited block** to the repo's `CLAUDE.md` (modeled on the existing `rtk-instructions` block): *"Concurrent-session coordination is automatic (you'll be warned before editing a file another session holds). To reserve an area ahead of time, dispatch `monkey-manager-scout` (haiku) to `claim`/`check` it."* The block is re-runnable and removable.
- Hooks **fail open**: if the database is unavailable or the payload is unexpected, the hook exits silently without blocking the tool.

## Concurrency

Many sessions write concurrently. WAL mode plus `busy_timeout = 5000ms` handles the low write volume (small single-row inserts/deletes) without lock errors, on a local filesystem.

## Testing

- **Core unit tests** (against `:memory:` SQLite): register/freeze identity, claim/release, touch + dedup, the overlap rule (dir trailing-slash, file equality, cross-worktree, session dedupe), heartbeat liveness, and TTL reap of both stale `work` and stale `sessions`.
- **Lifecycle regression:** assert `Stop` does **not** release work (only heartbeats) and that active claims survive across multiple turns; assert `SessionEnd` clears everything.
- **Hook tests:** feed each entrypoint a representative payload on stdin; assert resulting DB state and that only `on-pre-edit` (on conflict) emits to stdout.
- **Sub-agent attribution:** assert a Task sub-agent's edits attribute to the parent `session_id`.
- **Concurrency test:** two writers under `busy_timeout`; assert no lock error and correct final state.

## Out of scope (deliberately cut)

Hard locking/blocking, PID-liveness probing, cross-machine/networked state, a daemon or web UI, per-repo database files, glob-pattern matching (`minimatch` and `**`), and a `released_at`/soft-delete lifecycle. Each is omitted until a concrete need appears; advisory warnings + heartbeat-TTL + a single global DB cover the requirements without them.

## Tunable defaults

| Setting | Default | Override |
|---------|---------|----------|
| DB path | `~/.claude/monkey-manager/state.db` (local FS) | `MONKEY_MANAGER_DB` |
| Stale TTL | 30 min | `MONKEY_MANAGER_TTL_MIN` |
| Max rows per query result | 50 | `MONKEY_MANAGER_MAX_ROWS` |
| SQLite busy_timeout | 5000 ms | — |
| Coordination mode | advisory (warn, never block) | — |
| Path matching | dir-prefix (trailing `/`) + exact | — |
