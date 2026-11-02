import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@zthr/gates': pkg('gates'),
      '@zthr/evidence': pkg('evidence'),
      '@zthr/runtime': pkg('runtime'),
      '@zthr/intent': pkg('intent'),
      '@zthr/twins': pkg('twins'),
      '@zthr/review': pkg('review'),
      '@zthr/models': pkg('models'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
