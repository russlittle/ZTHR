import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { refuseToStartUnless } from '@zthr/runtime';
import { realEgress } from '@zthr/egress';
import { Advocate } from '../agents/advocate.js';
import { createApp } from './app.js';
import { PERSONAS, PERSONA_NAMES, seedDemo } from './demo.js';

/**
 * Starts the Advocate. In production it refuses to start without its secrets and a sign-in provider
 * (Pattern 29). The demonstration mode seeds the twelve students with keys generated in memory.
 */
const production = process.env.NODE_ENV === 'production';
const demoMode = process.env.ADVOCATE_DEMO === '1' || !production;
const hex32 = (v: string | undefined) => (v && /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : undefined);

refuseToStartUnless([
  { name: 'master key', check: () => demoMode || !!hex32(process.env.ADVOCATE_MASTER_KEY) || 'ADVOCATE_MASTER_KEY must be 32 bytes of hex in production' },
  { name: 'approval secret', check: () => demoMode || !!hex32(process.env.ADVOCATE_APPROVAL_SECRET) || 'ADVOCATE_APPROVAL_SECRET must be 32 bytes of hex in production' },
  { name: 'sign-in', check: () => demoMode || !!process.env.GOOGLE_CLIENT_ID || 'production requires Google sign-in (GOOGLE_CLIENT_ID)' },
]);

const fixedToday = process.env.ADVOCATE_TODAY;
const base = process.env.ADVOCATE_BASE ?? '';
const advocate = new Advocate({
  today: fixedToday ? () => fixedToday : undefined,
  masterKey: hex32(process.env.ADVOCATE_MASTER_KEY),
  approvalSecret: hex32(process.env.ADVOCATE_APPROVAL_SECRET),
  // Webhooks leave only through the egress block; in the demo they go to a recording twin.
  egress: demoMode ? undefined : realEgress((process.env.ADVOCATE_EGRESS_ALLOW ?? '').split(',').filter(Boolean)),
});

const LINES: Record<string, string> = {
  Maria: 'Single parent, nursing, works nights. Rent is short this month.',
  Jayden: 'First year, work-study, first time living alone.',
  Darnell: 'Back in school at 34 and working full time.',
  Ana: 'Wants short answers and nothing extra.',
  Tyler: 'First in his family at college.',
  Priya: 'Seventeen credits and a packed calendar.',
  Destiny: 'Juggling two jobs and a full load.',
  Sam: 'Wants things one step at a time.',
  Linda: 'Back to school at 46; prefers texting.',
  Luis: 'Speaks Spanish at home; family of five.',
  Alex: 'At Antioch; wants privacy above all.',
  Keisha: 'Moved to Atlanta mid-degree.',
};
const demo = demoMode ? seedDemo(advocate).map((s) => ({ id: s.id, name: s.chosenName, line: LINES[s.chosenName] ?? '' })) : [];
void PERSONAS;
void PERSONA_NAMES;

const inner = createApp(advocate, { base, demo });
const root = new Hono({ strict: false });
root.route(base || '/', inner);
if (base) root.get('/', (c) => c.redirect(`${base}/`));
// The published docs and factory console, built by tools/site.ts into site-out/.
if (existsSync('site-out')) {
  for (const p of ['docs', 'factory', 'assets']) {
    root.use(`/${p}/*`, async (c, next) => (new URL(c.req.url).pathname === `/${p}` ? c.redirect(`/${p}/`) : next()));
    root.use(`/${p}/*`, serveStatic({ root: 'site-out', rewriteRequestPath: (path) => (path.endsWith('/') ? `${path}index.html` : path) }));
  }
}

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: root.fetch, port });
console.log(`Student Advocate listening on http://localhost:${port}${base}/ (${demoMode ? 'demonstration' : 'production'} mode)`);
