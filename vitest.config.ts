import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

// vite-node normalizes 'node:sqlite' → 'sqlite' via normalizeModuleId() because
// 'sqlite' is an experimental built-in absent from Node's builtinModules list.
// This plugin intercepts the resolve + load for both ids and returns a synthetic
// module that re-exports from 'node:sqlite' via dynamic import (evaluated at
// runtime in Node where node:sqlite is always available).
// Tested against vitest ^2.1 / vite 5 on Node 24; revisit if vite-node adds
// 'sqlite' to its known experimental builtins (then this plugin can be deleted).
const nodeSqlitePlugin: Plugin = {
  name: 'node-sqlite-external',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'node:sqlite' || id === 'sqlite') {
      // Return a virtual module id
      return '\0virtual:node-sqlite';
    }
  },
  load(id) {
    if (id === '\0virtual:node-sqlite') {
      // Inline CJS that requires node:sqlite directly at runtime
      return `module.exports = require('node:sqlite');`;
    }
  },
};

export default defineConfig({
  plugins: [nodeSqlitePlugin],
  test: { include: ['tests/**/*.test.ts'] },
});
