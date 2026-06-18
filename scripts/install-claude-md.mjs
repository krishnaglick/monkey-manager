import { upsertBlock } from '../dist/claude-md.js';
export { upsertBlock };

if (process.argv[1] && process.argv[1].endsWith('install-claude-md.mjs')) {
  upsertBlock(process.argv[2] ?? 'CLAUDE.md');
}
