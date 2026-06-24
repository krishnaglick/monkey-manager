import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// The "active session" file bridges an identity gap: the MCP server freezes its
// session id at process launch (CLAUDE_CODE_SESSION_ID, captured once), but a
// `/clear` mints a new live session WITHOUT restarting the server. Enforcement
// hooks that read the *live* stdin session id then check claims under an id the
// server never wrote — and find nothing. Publishing "which session id currently
// owns this worktree's server" lets the hook check claims under the SERVER's
// identity instead, so claim-writes and claim-reads agree regardless of /clear.
//
// Keyed by worktree (git toplevel) so each worktree's server gets its own file.
// The scheme is mirrored by consumers in shell (sha256 of the worktree path);
// keep this in sync with any hook that reads it.

export function activeDir(dbPath: string): string {
  return join(dirname(dbPath), 'active');
}

export function activeSessionFile(dbPath: string, worktree: string): string {
  const key = createHash('sha256').update(worktree).digest('hex');
  return join(activeDir(dbPath), `${key}.session`);
}

/** Record that `sessionId` is the live MCP-server identity owning `worktree`. */
export function publishActiveSession(dbPath: string, worktree: string, sessionId: string): void {
  mkdirSync(activeDir(dbPath), { recursive: true });
  // First line = session id (what consumers read); second = worktree for debugging.
  writeFileSync(activeSessionFile(dbPath, worktree), `${sessionId}\n${worktree}\n`);
}

/** Read the published server session id for `worktree`, or null if none. */
export function readActiveSession(dbPath: string, worktree: string): string | null {
  try {
    const first = readFileSync(activeSessionFile(dbPath, worktree), 'utf8').split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}
