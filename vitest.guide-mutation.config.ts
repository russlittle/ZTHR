import base from './vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';
// The guide's own tests, for a quick mutation run on the guide modules (stryker.guide.json).
export default mergeConfig(base, defineConfig({ test: { include: ['apps/advocate/test/guide.test.ts', 'apps/advocate/test/guide-units.test.ts'] } }));
