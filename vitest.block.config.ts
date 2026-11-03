import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// One block's own tests, for that block's mutation run: BLOCK=<name> npx stryker run ...
const block = process.env.BLOCK;
if (!block) throw new Error('set BLOCK to a package name under packages/');
export default defineConfig({ ...base, test: { ...base.test, include: [`packages/${block}/test/**/*.test.ts`] } });
