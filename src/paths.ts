import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function normalizePath(p: string, worktree: string): string {
  const trailing = p.endsWith('/');
  let rel = isAbsolute(p) ? relative(worktree, p) : p.replace(/^\.\//, '');
  rel = rel.replace(/\/+$/, '');
  return trailing ? rel + '/' : rel;
}

// Cache the git-worktree-root lookup per directory: an edit-heavy session would
// otherwise spawn `git` on every Edit. null means "git failed / not a repo".
const worktreeRootCache = new Map<string, string | null>();

/**
 * Derive the git worktree root that owns `filePath`, by running
 * `git -C <dir> rev-parse --show-toplevel` from the file's own directory.
 *
 * This makes the same logical file in two different worktrees of one repo
 * normalize to the same key — fixing cross-worktree conflict detection.
 * Fails open (returns null) when git is unavailable or the path is not in a
 * repo, so callers can fall back to the session's frozen worktree root.
 */
export function resolveWorktreeRoot(filePath: string): string | null {
  // A directory-claim path may carry a trailing slash; strip it for dirname.
  const cleaned = filePath.replace(/\/+$/, '');
  const dir = isAbsolute(cleaned) ? dirname(cleaned) : resolve(dirname(cleaned));
  const cached = worktreeRootCache.get(dir);
  if (cached !== undefined) return cached;
  let root: string | null;
  try {
    root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    root = null; // fail open — coordination must never break a tool call
  }
  worktreeRootCache.set(dir, root);
  return root;
}

/**
 * Normalize a file to a repo-stable key. Absolute paths are made relative to
 * the file's OWN git worktree root (so siblings in other worktrees collide),
 * falling back to the session's frozen worktree root when git can't resolve it.
 */
export function normalizeKey(filePath: string, sessionWorktree: string): string {
  const root = isAbsolute(filePath)
    ? (resolveWorktreeRoot(filePath) ?? sessionWorktree)
    : sessionWorktree;
  return normalizePath(filePath, root);
}

/** Overlap iff equal, or one is a directory (trailing '/') that prefixes the other. */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}
