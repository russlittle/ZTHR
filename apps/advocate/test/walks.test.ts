// Verifies docs/testing/exploration.md
// Verifies docs/testing/coverage.md
import { describe, expect, it } from 'vitest';
import { exploreAdvocateAsync } from './harness/world.js';
import { crawlAdvocate } from './harness/crawl.js';

/**
 * A quick slice of the exhaustive walks, run with every test pass. The full walks (every student, every depth,
 * typing included) run in the factory with npm run explore and npm run crawl.
 */
describe('walks, quick slice', () => {
  it('button walk: Ana (brief), to a fixpoint, with no violations', async () => {
    const r = await exploreAdvocateAsync({ only: ['Ana'], withTyping: false });
    expect(r.violations.map((v) => `${v.problem} :: ${v.path.join(' > ')}`)).toEqual([]);
    expect(r.exhausted).toBe(true);
  }, 600_000);
  it('feature walk: Keisha (out of area), every page, link and form, with no violations', async () => {
    const r = await crawlAdvocate({ only: ['Keisha'] });
    expect(r.violations.map((v) => `${v.problem} :: ${v.path.slice(-2).join(' > ')}`)).toEqual([]);
    expect(r.exhausted).toBe(true);
  }, 600_000);
});
