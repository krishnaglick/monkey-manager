import { basename } from 'node:path';
import type { Conflict, Sibling } from './core.js';

export function formatAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

export function formatConflicts(cs: Conflict[], maxRows: number): string {
  if (cs.length === 0) return '';
  const shown = cs.slice(0, maxRows);
  const lines = shown.map((c) => {
    const wt = c.cross_worktree ? ` [wt:${basename(c.worktree)}/${c.branch ?? '?'}]` : '';
    const what = c.kind === 'claim' ? `claim "${c.note ?? ''}"` : 'touch';
    return `${c.path}\t${c.session_id.slice(0, 8)} ${c.branch ?? '-'}${wt} ${what} ${formatAge(c.age_sec)}`;
  });
  if (cs.length > maxRows) lines.push(`+${cs.length - maxRows} more`);
  return lines.join('\n');
}

export function formatBranchSiblings(ss: Sibling[]): string {
  return ss
    .map((s) => `${s.session_id.slice(0, 8)} [${basename(s.worktree)}] (${formatAge(s.age_sec)} ago)`)
    .join('\n');
}
