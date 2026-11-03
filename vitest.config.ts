import { defineConfig } from 'vitest/config';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every package under packages/ is importable as @zthr/<name>, so a new block needs no wiring.
const root = fileURLToPath(new URL('./packages/', import.meta.url));
const alias = Object.fromEntries(readdirSync(root).map((name) => [`@zthr/${name}`, `${root}${name}/src/index.ts`]));

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
