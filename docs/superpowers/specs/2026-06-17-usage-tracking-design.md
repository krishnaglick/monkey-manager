# Monkey Manager — Usage Tracking Design

## Goal

Add optional usage tracking so the operator can verify the coordination system
is working correctly: that hooks and MCP tools actually fire, that real
conflicts are detected and the pre-edit warning is actually emitted, and that
aggregate usage can be inspected over time. Must be trivial to turn off and
trivial to remove later.

## Non-goals

- Not a user-facing analytics product. It is an operator diagnostic.
- Not log levels, log rotation config, or a structured JSON detail schema.
  Deferred until the flat model below measurably falls short.
- Logging is **on by default** (the point is to verify the system works out of
  the box). Set `MONKEY_MANAGER_LOG=0` to disable; when off there is zero
  functional difference from today.

## Background (codebase facts the design relies on)

- Hooks are **not** separate `.mjs` files. `hooks/hooks.json` wires each Claude
  Code event to `node dist/cli.js <subcommand>`. The "hook entrypoints" are the
  `case` branches of `runCommand()` in `src/cli.ts` (compiled to `dist/cli.js`).
  So instrumentation for hooks goes into those `src/cli.ts` cases.
- `runCommand()` is wrapped in try/catch in `main()` (fail-open). The **server**
  tool handlers in `src/server.ts` have no such wrapper.
- `migrate()` in `src/db.ts` is a single idempotent `CREATE TABLE IF NOT EXISTS`
  block run on every `openDb()`. Existing databases auto-gain new tables.
- The whole codebase injects `now` (see `src/clock.ts`, `nowSec()`) rather than
  calling the clock internally, for deterministic tests.
- `reap(db, now, ttl)` (`src/core.ts`) receives `ttl` in **seconds** (default
  1800 = 30 min). It is called from `src/cli.ts` and `src/server.ts`.

## Design

### Module boundary (the "pull out later" knob)

All logging lives in one new file `src/events.ts` exporting two functions:

```ts
// Records one event. Self-contained: reads the toggle, no-ops when off,
// and SWALLOWS ALL ERRORS internally (returns void, never throws) so no
// call site — hook or server tool — can ever be broken by logging.
export function record(
  db: DB,
  now: number,
  ev: string,
  fields?: { session_id?: string; repo?: string; path?: string; detail?: string },
): void;

// Retention. Deletes events older than the window. Lives here (not in
// core.reap) so core.ts stays pure. Called at the boundaries right beside
// the existing reap() calls. Safe to call when logging is off (deleting from
// an empty/old table is harmless and cheap); also self-swallows errors.
export function reapEvents(db: DB, now: number): void;
```

`record()` and `reapEvents()` are called from the **boundaries** — the
`runCommand()` cases in `src/cli.ts` and the tool handlers in `src/server.ts` —
not threaded through `core.ts`. **Core stays untouched.**

`record()` performs a **single autonomous INSERT** (`prepare().run()`), no
surrounding read and no wrapping transaction, so it adds no held write-lock
beyond the one row — important under WAL with many concurrent sessions.

Removal stays mechanical (see Removal procedure).

### Toggle

Env var `MONKEY_MANAGER_LOG`. **On by default**; set to `0` or `false` to
disable. When off, `record()` returns immediately (env check, no DB write).
The toggle governs **inserts only**, not schema.

- **Hooks** are fresh processes per invocation, so they read the env every time
  — a toggle change takes effect immediately.
- **The server** is long-lived and inherits its env at launch, so toggling
  `MONKEY_MANAGER_LOG` only affects the server **after a restart**. (Per-call
  `process.env` read is still used; no caching needed.)

### Schema

Added to the `migrate()` block in `src/db.ts`. The table is always created (an
empty table is free) so the on/off flag never branches on schema existence.

```sql
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  ev         TEXT NOT NULL,   -- register|pre_edit|post_edit|session_end|claim|check|release
  session_id TEXT,
  repo       TEXT,            -- nullable
  path       TEXT,            -- nullable
  detail     TEXT             -- nullable; pinned key=value grammar (see below)
);
```

No index. The table is retention-bounded and queried rarely; a scan over a small
table is instant, and an index would double the per-insert write cost on the
hot path (every edit). Add one only if a query is ever measurably slow.

**`detail` grammar (pinned).** `record()` writers and the `stats` reader share
exactly this `key=value` format so parsing never drifts:

| Event       | `detail` value     |
|-------------|--------------------|
| `pre_edit`  | `warned=true` / `warned=false` |
| `claim`     | `conflicts=N`      |
| `check`     | `conflicts=N`      |
| `reap`      | `reaped=N`         |
| others      | `NULL`             |

### Call sites

| Event       | Where (src)                       | Fields                          | Proves                                              |
|-------------|-----------------------------------|---------------------------------|-----------------------------------------------------|
| `register`  | cli.ts `on-session-start` case    | session_id, repo                | plumbing: session registered (R1)                   |
| `pre_edit`  | cli.ts `on-pre-edit` case         | session_id, path, `warned=bool` | the value event: conflict checked + warning emitted (R3) |
| `post_edit` | cli.ts `on-post-edit` case        | session_id, path                | touch-recording hook fired (R2)                     |
| `session_end` | cli.ts `on-session-end` case    | session_id                      | cleanup fired (R9)                                  |
| `claim`     | server.ts claim handler           | session_id, path, `conflicts=N` | MCP claim + conflict detection (R4)                 |
| `check`     | server.ts check handler           | session_id, `conflicts=N`       | MCP check exercised (R3/R4)                          |
| `release`   | server.ts release handler         | session_id                      | MCP release exercised (R4)                           |

`pre_edit` is emitted on the conflict-checked path **after** `conflicts` is
computed, with `warned = conflicts.length > 0`. The early-return branch (no
session id / no file path) does **not** log — nothing meaningful happened.

**Deliberately not logged** (cut as low-signal noise):

- `stop` — fires every turn; would be the highest-volume event by far. Heartbeat
  liveness is already directly observable as `sessions.last_seen`; an event row
  per turn proves nothing extra. Verify liveness with
  `SELECT session_id, last_seen FROM sessions`.
- `active`, `whoami` — pure read-only introspection that proves nothing about
  coordination; `claim`/`check` already prove the MCP server is exercised.
- `reap` (core liveness reaping) — runs on every session start, so a row each
  time is low-signal noise; a `reaped=N` count would also require changing
  `core.reap`'s return type, breaking core purity. Verify reaping by observing
  stale rows disappear from `sessions`/`work`. (Distinct from `reapEvents`,
  which prunes the `events` table itself — see Growth control.)

### Growth control

`reapEvents(db, now)` deletes aged rows:

```sql
DELETE FROM events WHERE ts <= ? ;   -- ? = now - MONKEY_MANAGER_LOG_DAYS*86400
```

Retention defaults to 7 days (`MONKEY_MANAGER_LOG_DAYS`). It is computed in
`events.ts` from days → seconds — it does **not** reuse `reap`'s `ttl` (which is
30 min in seconds). `reapEvents()` is called at the same boundary points that
already call `core.reap()`, so there is no new cron and no change to `core.ts`.

Note: with logging off, `record()` writes nothing, so the table cannot grow;
`reapEvents()` is still safe to call but has nothing to do. If logging is turned
off after a burst, the existing rows persist until logging is re-enabled (the
next `reapEvents()` clears the aged ones) or the table is dropped via the
removal procedure. Acceptable for an operator-controlled diagnostic (and rare,
since logging is on by default — you would have to opt out first).

### Read path

A `monkey-manager stats` CLI subcommand prints counts grouped by `ev` (total +
last 24h) and a warned/conflict tally, plus a per-session liveness section for
spotting a stuck/idle agent, so the operator does not hand-write SQL.

The liveness section shows, per live session: `idle` (since last heartbeat —
any turn/edit/MCP call, i.e. `sessions.last_seen`) and `last_action` (since the
last logged coordination event, or `-` if none). A large `idle` means possibly
hung; a large `last_action` with small `idle` means looping but not coordinating.

`stats` is an **operator** command, not a hook: it takes no stdin payload, so the
`stats` case must run **before / instead of** the `readStdin()` call in `main()`
(which would otherwise block waiting for EOF on a terminal).

```
$ monkey-manager stats
event        24h   total
register      4      31
pre_edit      9      88   (warned: 3 / 22)
post_edit    14     140
claim         2      15
check         5      40
release       1       8

session   idle  last_action  repo/branch
a1b2c3d4    3m           3m  monkey-manager/main
e5f6a7b8   42m            -  monkey-manager/feature-x
```

Raw SQL against the `events` table remains available for ad-hoc queries.

## Toggle / tunables

| Setting              | Default | Override                  |
|----------------------|---------|---------------------------|
| Logging enabled      | on      | `MONKEY_MANAGER_LOG` (`0`/`false` disables) |
| Event retention      | 7 days  | `MONKEY_MANAGER_LOG_DAYS` |

## Testing

`tests/events.test.ts` (against `:memory:` SQLite, `now` injected):

- `record` writes a row when `MONKEY_MANAGER_LOG` is set; correct columns.
- `record` is a no-op (zero rows) when the flag is unset.
- `record` never throws — e.g. when the `events` table is absent it swallows the
  error and returns (proves it can't break a hook or server tool).
- `reapEvents` deletes events older than the window, keeps newer ones; uses the
  days-based window, not the 30-min reap TTL.
- `stats` aggregation produces correct per-event totals, 24h counts, and the
  warned tally from the pinned `detail` grammar.

## Removal procedure

1. Delete `src/events.ts` and `tests/events.test.ts`.
2. Grep-delete every `record(` and `reapEvents(` call line in `src/cli.ts` and
   `src/server.ts`.
3. Remove the `events` table from the `migrate()` block in `src/db.ts`.
4. Remove the `stats` subcommand from `src/cli.ts` and the two env vars from docs.

## Out of scope

Log levels, rotation config, structured JSON detail column, an index, exporting
to an external sink. Each deferred until a concrete need appears.
