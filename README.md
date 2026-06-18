# monkey-manager

Coordinate **concurrent Claude Code sessions** working in the same repo so they don't collide on the same files. Ships lifecycle hooks + an MCP server + a haiku "scout" agent, backed by a local SQLite database.

Coordination is **advisory**: you get an automatic, non-blocking warning before editing a file another live session is already working on. Nothing is ever blocked — sessions just *know*.

## Requirements

- **Node ≥ 22.5** (`node --version`) — uses the built-in `node:sqlite`, so there's no native build and no extra runtime dependency.
- Claude Code with plugin support.

## Install

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/krishnaglick/monkey-manager/main/install.sh | bash
```

Clones to `~/.local/share/monkey-manager`, builds, and registers the plugin in `~/.claude/settings.json`. Then start a new Claude Code session (or run `/reload-plugins`).

Override install location: `MONKEY_MANAGER_INSTALL_DIR=/your/path bash install.sh`

### Try it for one session (no install)

```bash
git clone https://github.com/krishnaglick/monkey-manager monkey-manager
cd monkey-manager
npm install                       # also builds (prepare script) → dist/
claude --plugin-dir "$(pwd)" "say hi"
```

`--plugin-dir` loads the plugin for that single Claude session only. Great for a smoke test before committing to a real install.

### Persistent install — humans (interactive)

1. **Clone + build** (build is automatic via the `prepare` script):
   ```bash
   git clone https://github.com/krishnaglick/monkey-manager monkey-manager
   cd monkey-manager
   npm install
   ls dist/cli.js dist/server.js   # both must exist
   pwd                             # copy this absolute path for the next step
   ```
2. **Register + install** inside Claude Code (a local repo is added as a one-plugin marketplace — use the absolute path from `pwd`):
   ```
   /plugin marketplace add /absolute/path/to/monkey-manager
   /plugin install monkey-manager@monkey-manager
   ```
3. **Confirm it loaded:**
   ```
   /mcp        # shows the "monkey-manager" server with tools: check, claim, release, active, whoami
   /agents     # shows "monkey-manager-scout"
   ```

### Persistent install — agents / non-interactive / CI

No interactive picker. Add to `~/.claude/settings.json` (user scope):

```json
{
  "extraKnownMarketplaces": {
    "monkey-manager": { "source": { "source": "local", "path": "/absolute/path/to/monkey-manager" } }
  },
  "enabledPlugins": {
    "monkey-manager@monkey-manager": "user"
  }
}
```

Then start a fresh session (or run `/reload-plugins` in an open one). For a stateless one-shot with no settings changes, use `claude --plugin-dir /absolute/path/to/monkey-manager "<task>"`.

> **Build is mandatory.** `dist/` is gitignored, so the plugin's hooks/MCP entrypoints (`dist/cli.js`, `dist/server.js`) only exist after a build. `npm install` builds automatically (`prepare`), so just re-run `npm install` after every `clone` or `pull`.

## Verify it works

**Tools present** — in a session run `/mcp` and look for `monkey-manager` → `check`, `claim`, `release`, `active`, `whoami`. Or ask Claude: *“call the monkey-manager `whoami` tool.”* It returns your session id.

**Hooks fired** — opening a session in any repo runs the `SessionStart` hook, which creates the DB:

```bash
ls ~/.claude/monkey-manager/state.db   # exists after a session has started
```

## See it work (the whole point)

Open **two** Claude Code sessions in the **same repo**:

1. **Session A** — ask it to edit `src/foo.ts`. The `PostToolUse` hook automatically records A as working on that file.
2. **Session B** — ask it to edit the *same* `src/foo.ts`. Before the edit lands, the `PreToolUse` hook injects an advisory warning into B's context:
   ```
   ⚠️ monkey-manager: another session is working here:
   src/foo.ts	a1b2c3d4 main touch 30s
   ```
   The edit still goes through (advisory only) — B just sees the conflict and can coordinate.
3. From B, ask Claude to *“call monkey-manager `check` with paths `["src/foo.ts"]`”* (or `active`) to see A's work explicitly.

To reserve work **before** starting — without spending main-context tokens — dispatch the bundled cheap agent: *“use the monkey-manager-scout agent to claim feature `auth-refactor`, path `src/foo.ts`, note ‘refactoring auth’.”* A `claim` **requires a feature id** — its primary collision key, which collides with any sibling session on the same feature even when their files don't overlap — plus an optional path/dir for file-level awareness and a short note (≤200 chars). The id is **canonicalized** (case/punctuation-insensitive: `§0.5.B` / `0.5B` / `05b` all match; `payment-v2` and `checkout-v2` stay distinct), so pass whatever stable id your tracker gives. Re-claiming the same feature updates the note (the claim's age is preserved).

## Example workflows (bundled skills)

Two example skills ship with the plugin and are auto-discovered — read them for the
intended usage patterns, then adapt to your project:

- **`feature-claim`** — a single session reserving a feature before editing when other
  sessions may be live.
- **`fleet-dispatch`** — an orchestrator claim-gating several parallel agents across
  worktrees so no two duplicate the same work.

Both center on the one rule: `claim` requires a **reproducible feature id** (the primary
collision key — collides even across disjoint files). `fleet-dispatch` shows the
derive-the-id-in-one-place pattern that stops two sessions picking different slugs for
the same work.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MONKEY_MANAGER_DB` | `~/.claude/monkey-manager/state.db` | Must be on a **local** filesystem — SQLite WAL is unsafe on network mounts (NFS/SMB/CIFS). The directory is created automatically. |
| `MONKEY_MANAGER_TTL_MIN` | `30` | Minutes of inactivity (no heartbeat) before a session's work is treated as stale and reaped. |
| `MONKEY_MANAGER_MAX_ROWS` | `50` | Max rows returned per `check` / `active` / `claim` query (output cap only — nothing is dropped from the DB). |
| `MONKEY_MANAGER_LOG` | `on` | Records a usage-tracking event per hook/MCP call into an `events` table — for verifying the system actually fires. On by default; set `0`/`false` to disable (zero rows, zero overhead). Inspect with `node dist/cli.js stats` (event counts + per-session `idle`/`last_action` to spot a stuck agent). |
| `MONKEY_MANAGER_LOG_DAYS` | `7` | Retention window for the `events` table; older rows are pruned during reap. Only applies while logging is on. |

**Session identity:** the MCP server reads the `CLAUDE_CODE_SESSION_ID` env var Claude Code provides, so its claims share the same session id as the hooks. If absent (e.g. local testing) it falls back to a per-process id (`mcp:<repo-hash>:<pid>`).

## Optional — nudge sessions to use it

Append an idempotent advisory note to a repo's `CLAUDE.md` so agents know to check before working:

```bash
node scripts/install-claude-md.mjs /path/to/repo/CLAUDE.md
```

## Troubleshooting

- **`Cannot find module 'node:sqlite'`** → Node is older than 22.5. Check `node --version` and upgrade.
- **`/mcp` doesn't list `monkey-manager`** → the plugin isn't enabled, or `dist/` wasn't built. Re-run `npm install`, re-do the install steps, then restart the session or run `/reload-plugins`.
- **DB error on startup** → `MONKEY_MANAGER_DB` is on a network filesystem. Point it at local disk, e.g. `export MONKEY_MANAGER_DB=/tmp/monkey-manager.db`.
- **Stale warnings after a crash** → a dead session is auto-reaped after `MONKEY_MANAGER_TTL_MIN` minutes; or clear it now via the `release` tool.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/krishnaglick/monkey-manager/main/uninstall.sh | bash
```

Removes the install directory (`~/.local/share/monkey-manager`) and the `extraKnownMarketplaces` / `enabledPlugins` entries from `~/.claude/settings.json`. Then start a new Claude Code session (or run `/reload-plugins`).

Override install location: `MONKEY_MANAGER_INSTALL_DIR=/your/path bash uninstall.sh`

To also remove stored state: `rm -rf ~/.claude/monkey-manager`

## Development

```bash
npm install        # installs deps and builds (prepare)
npm test           # vitest
npm run build      # tsc → dist/
npm run typecheck
```

Layout: `.claude-plugin/{plugin.json,marketplace.json}` → `hooks/hooks.json`, `.mcp.json`, `agents/monkey-manager-scout.md`. Source in `src/` (`clock`, `db`, `paths`, `repo`, `core`, `format`, `cli`, `server`). Design in `SPEC.md`; implementation plan in `docs/superpowers/plans/`.
