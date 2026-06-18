import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- monkey-manager -->';
const END = '<!-- /monkey-manager -->';
const BLOCK = `${START}
## Monkey Manager (concurrent-session coordination)
Coordination is automatic: you are warned before editing a file another live
session is working on. To reserve an area ahead of time, dispatch the
\`monkey-manager-scout\` (haiku) agent to \`claim\`/\`check\` it.
${END}`;

export function upsertBlock(path: string): void {
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let next: string;
  if (prev.includes(START) && prev.includes(END)) {
    next = prev.replace(new RegExp(`${START}[\\s\\S]*?${END}`), BLOCK);
  } else {
    next = (prev ? prev.replace(/\s*$/, '') + '\n\n' : '') + BLOCK + '\n';
  }
  writeFileSync(path, next);
}
