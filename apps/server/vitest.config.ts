import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Load ../../.env so integration tests can reach the dev Postgres/Redis
// without a separate tool. Values already in the environment win.
const envPath = path.resolve(__dirname, '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? '';
  }
}

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
