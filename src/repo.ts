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
  const branchRaw =
    git(['symbolic-ref', '--short', 'HEAD'], abs) ??
    git(['rev-parse', '--abbrev-ref', 'HEAD'], abs);
  const repoRoot = basename(absCommon) === '.git' ? resolve(absCommon, '..') : absCommon;
  return {
    repo: sha12(absCommon),
    repoLabel: basename(repoRoot),
    worktree,
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
    cwd: abs,
  };
}
