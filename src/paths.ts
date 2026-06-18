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
