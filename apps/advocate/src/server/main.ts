import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { refuseToStartUnless } from '@zthr/runtime';
import { realEgress } from '@zthr/egress';
import { Advocate } from '../agents/advocate.js';
import { createApp } from './app.js';
import { seedDemo } from './demo.js';
import { GoogleVerifier, Sessions } from './auth.js';

/**
 * Starts the Advocate. In production it refuses to start without its secrets and a sign-in provider
 * (Pattern 29). The demonstration gives every visitor their own copy of the twelve students, so one visitor's
 * taps (even deleting an account) never change what the next visitor sees.
 */
const production = process.env.NODE_ENV === 'production';
const demoMode = process.env.ADVOCATE_DEMO === '1' || !production;
const hex32 = (v: string | undefined) => (v && /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : undefined);

refuseToStartUnless([
  { name: 'master key', check: () => demoMode || !!hex32(process.env.ADVOCATE_MASTER_KEY) || 'ADVOCATE_MASTER_KEY must be 32 bytes of hex in production' },
  { name: 'approval secret', check: () => demoMode || !!hex32(process.env.ADVOCATE_APPROVAL_SECRET) || 'ADVOCATE_APPROVAL_SECRET must be 32 bytes of hex in production' },
  { name: 'sign-in', check: () => demoMode || !!process.env.GOOGLE_CLIENT_ID || 'production requires Google sign-in (GOOGLE_CLIENT_ID)' },
  { name: 'session secret', check: () => demoMode || !!hex32(process.env.ADVOCATE_SESSION_SECRET) || 'ADVOCATE_SESSION_SECRET must be 32 bytes of hex in production' },
]);

const fixedToday = process.env.ADVOCATE_TODAY;
const base = process.env.ADVOCATE_BASE ?? '';

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
  Luis: 'Family of five; Spanish at home.',
  Alex: 'At Antioch; wants privacy above all.',
  Keisha: 'Moved to Atlanta mid-degree.',
};

function build(): Hono {
  const advocate = new Advocate({
    today: fixedToday ? () => fixedToday : undefined,
    masterKey: hex32(process.env.ADVOCATE_MASTER_KEY),
    approvalSecret: hex32(process.env.ADVOCATE_APPROVAL_SECRET),
    // Webhooks leave only through the egress block; in the demo they go to a recording twin.
    egress: demoMode ? undefined : realEgress((process.env.ADVOCATE_EGRESS_ALLOW ?? '').split(',').filter(Boolean)),
  });
  const demo = demoMode ? seedDemo(advocate).map((s) => ({ id: s.id, name: s.chosenName, line: LINES[s.chosenName] ?? '' })) : [];
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const secret = hex32(process.env.ADVOCATE_SESSION_SECRET);
  const sessions = clientId && secret ? new Sessions(secret) : undefined;
  const auth = clientId && sessions ? { clientId, verifier: new GoogleVerifier(realEgress(['www.googleapis.com']), clientId), sessions, adminEmailHashes: (process.env.ADMIN_EMAILS ?? '').split(',').filter(Boolean).map((e) => sessions.emailHash(e.trim())), secure: production } : undefined;
  return createApp(advocate, { base, demo, auth });
}

// One copy per visitor in the demo, kept while they use it; the oldest idle copy goes first.
const MAX = Number(process.env.ADVOCATE_SANDBOXES ?? 150);
const IDLE_MS = 2 * 60 * 60 * 1000;
const sandboxes = new Map<string, { app: Hono; seen: number }>();
const shared = demoMode ? undefined : build();
function appFor(id: string): Hono {
  const now = Date.now();
  for (const [k, v] of sandboxes) if (now - v.seen > IDLE_MS) sandboxes.delete(k);
  let s = sandboxes.get(id);
  if (!s) {
    if (sandboxes.size >= MAX) sandboxes.delete([...sandboxes].sort((a, b) => a[1].seen - b[1].seen)[0]![0]);
    s = { app: build(), seen: now };
    sandboxes.set(id, s);
  }
  s.seen = now;
  return s.app;
}

const root = new Hono({ strict: false });

// The published docs and factory console, built by tools/site.ts into site-out/.
if (existsSync('site-out')) {
  for (const p of ['docs', 'factory', 'assets']) {
    root.use(`/${p}/*`, async (c, next) => (new URL(c.req.url).pathname === `/${p}` ? c.redirect(`/${p}/`) : next()));
    root.use(`/${p}/*`, serveStatic({ root: 'site-out', rewriteRequestPath: (path) => (path.endsWith('/') ? `${path}index.html` : path) }));
    // Hosts that strip ".html" from links (clean URLs) still land on the page.
    root.use(`/${p}/*`, serveStatic({ root: 'site-out', rewriteRequestPath: (path) => (/\.[a-z0-9]+$/i.test(path) ? path : `${path}.html`) }));
  }
}
const mount = base || '/';
root.all(`${mount === '/' ? '' : mount}/*`, async (c) => {
  if (shared) return shared.fetch(rewrite(c.req.raw));
  let id = getCookie(c, 'adv_demo');
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = randomBytes(16).toString('hex');
    setCookie(c, 'adv_demo', id, { path: mount, httpOnly: true, sameSite: 'Lax', secure: production, maxAge: 7200 });
  }
  const res = await appFor(id).fetch(rewrite(c.req.raw));
  const out = new Response(res.body, res);
  for (const v of c.res.headers.getSetCookie?.() ?? []) out.headers.append('set-cookie', v);
  return out;
});
root.all(mount === '/' ? '/' : mount, (c) => c.redirect(`${base}/`));

/** The app's routes do not include the base; strip it before handing the request over. */
function rewrite(req: Request): Request {
  if (!base) return req;
  const u = new URL(req.url);
  u.pathname = u.pathname.slice(base.length) || '/';
  return new Request(u, req);
}

if (base) root.get('/', (c) => c.redirect(`${base}/`));
root.get('/healthz', (c) => c.json({ ok: true, sandboxes: sandboxes.size }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: root.fetch, port });
console.log(`Student Advocate listening on http://localhost:${port}${base}/ (${demoMode ? 'demonstration, one copy per visitor' : 'production'} mode)`);
