// Verifies docs/architecture.md
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';

describe('done means serving', () => {
  it('the app reports the commit it was built from at /version, a path Cloud Run passes through', async () => {
    const app = new Hono().route('/studentadvocate', createApp(new Advocate(), { base: '/studentadvocate' }));
    const before = process.env.BUILD_COMMIT;
    process.env.BUILD_COMMIT = 'abc1234';
    try {
      const r = await app.request('/studentadvocate/version');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, commit: 'abc1234' });
    } finally {
      if (before === undefined) delete process.env.BUILD_COMMIT;
      else process.env.BUILD_COMMIT = before;
    }
  });
  it('the front door links to the product page and the reference on zthr.ai, which work from any host', async () => {
    const html = await (await new Hono().route('/studentadvocate', createApp(new Advocate(), { base: '/studentadvocate' })).request('/studentadvocate')).text();
    expect(html).toContain('href="https://zthr.ai/advocate"');
    expect(html).toContain('href="https://zthr.ai/reference"');
  });
});
