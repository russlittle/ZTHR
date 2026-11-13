import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { Window, clientOf, rateLimit, securityHeaders } from './guard.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { refuseToStartUnless } from '@zthr/runtime';
import { realEgress, routedEgress } from '@zthr/egress';
import { SERVICES, SERVICE_IDS, startAll } from '../../../campus-services/src/index.js';
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
// The demonstration runs on one school day so every visitor sees the same story the walks checked. With a clock set
// (HH:MM, campus time), that day starts at the clock when the server starts and runs forward in real time, wrapping
// every twelve hours, so a visitor in the evening still sees a day ahead of the student rather than one already over.
const fixedClock = process.env.ADVOCATE_CLOCK;
const started = Date.now();
const demoNow = fixedToday && fixedClock && /^\d{2}:\d{2}$/.test(fixedClock) ? () => new Date(Date.parse(`${fixedToday}T${fixedClock}:00-05:00`) + ((Date.now() - started) % (12 * 3600_000))) : undefined;
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

// One set of synthetic campus services for the whole demo; their state (room bookings) is shared like a real one.
const campusServices = startAll();
const operators = new Set<Advocate>();
// The operator runs every minute for each live copy (Pattern 24); leases keep each job single (Pattern 26).
setInterval(() => {
  for (const a of operators) void a.operator.tick().catch(() => undefined);
}, 60_000).unref();

function build(): { app: Hono; advocate: Advocate } {
  const allow = (process.env.ADVOCATE_EGRESS_ALLOW ?? '').split(',').filter(Boolean);
  // Campus services: the synthetic ones in-process for the demo; in production, real vendors on the allow-list.
  const egress = demoMode ? routedEgress(campusServices) : realEgress(allow);
  const advocate = new Advocate({
    today: fixedToday ? () => fixedToday : undefined,
    ...(demoNow ? { now: demoNow } : {}),
    masterKey: hex32(process.env.ADVOCATE_MASTER_KEY),
    approvalSecret: hex32(process.env.ADVOCATE_APPROVAL_SECRET),
    egress,
    ...(process.env.CAMPUS_ENDPOINTS ? { campus: JSON.parse(process.env.CAMPUS_ENDPOINTS) } : {}),
  });
  const demo = demoMode ? seedDemo(advocate).map((s) => ({ id: s.id, name: s.chosenName, line: LINES[s.chosenName] ?? '' })) : [];
  operators.add(advocate);
  void advocate.operator.tick();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const secret = hex32(process.env.ADVOCATE_SESSION_SECRET);
  const sessions = clientId && secret ? new Sessions(secret) : undefined;
  const auth = clientId && sessions ? { clientId, verifier: new GoogleVerifier(realEgress(['www.googleapis.com']), clientId), sessions, adminEmailHashes: (process.env.ADMIN_EMAILS ?? '').split(',').filter(Boolean).map((e) => sessions.emailHash(e.trim())), secure: production } : undefined;
  return { app: createApp(advocate, { base, demo, auth }), advocate };
}

// One copy per visitor in the demo, kept while they use it; the oldest idle copy goes first.
const MAX = Number(process.env.ADVOCATE_SANDBOXES ?? 150);
const IDLE_MS = 2 * 60 * 60 * 1000;
const sandboxes = new Map<string, { app: Hono; advocate: Advocate; seen: number }>();
const shared = demoMode ? undefined : build().app;
function appFor(id: string): Hono {
  const now = Date.now();
  for (const [k, v] of sandboxes) if (now - v.seen > IDLE_MS) { sandboxes.delete(k); operators.delete(v.advocate); }
  let s = sandboxes.get(id);
  if (!s) {
    if (sandboxes.size >= MAX) {
      const [k, v] = [...sandboxes].sort((a, b) => a[1].seen - b[1].seen)[0]!;
      sandboxes.delete(k);
      operators.delete(v.advocate);
    }
    s = { ...build(), seen: now };
    sandboxes.set(id, s);
  }
  s.seen = now;
  return s.app;
}

const root = new Hono({ strict: false });

// Guards for a public server (guard.ts): security headers, a body size limit, and a per-client request rate.
root.use('*', securityHeaders());
root.use('*', bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text('That request is too large.', 413) }));
root.use('*', rateLimit(new Window(Number(process.env.ADVOCATE_RATE_PER_MIN ?? 600), 60_000)));
// Starting a demo sandbox builds twelve students; a client may start only a few an hour, so no one can push
// other visitors' sandboxes out by starting new ones.
const sandboxStarts = new Window(Number(process.env.ADVOCATE_SANDBOX_STARTS_PER_HOUR ?? 40), 60 * 60 * 1000);

// The synthetic campus services, public, so anyone can call them like real endpoints: /twins/<service>/openapi.json
if (demoMode) {
  for (const id of SERVICE_IDS) {
    const svc = campusServices[SERVICES[id].host]!;
    root.all(`/twins/${id}/*`, (c) => {
      const u = new URL(c.req.url);
      u.pathname = u.pathname.slice(`/twins/${id}`.length) || '/';
      return svc.fetch(new Request(u, c.req.raw));
    });
  }
  root.get('/twins', (c) => c.json({ services: SERVICE_IDS.map((id) => ({ id, title: SERVICES[id].info.title, openapi: `/twins/${id}/openapi.json`, endpoints: SERVICES[id].info.endpoints.map((e) => `${e.method} /twins/${id}${e.path}`) })) }));
}

// The published docs and factory console, built by tools/site.ts into site-out/.
if (existsSync('site-out')) {
  // The factory's cost records are public, and the static copy of the site on zthr.ai reads them from here.
  root.use('/factory/ci-costs.json', async (c, next) => {
    await next();
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'no-cache');
  });
  for (const p of ['docs', 'factory', 'assets']) {
    root.use(`/${p}/*`, async (c, next) => (new URL(c.req.url).pathname === `/${p}` ? c.redirect(`/${p}/`) : next()));
    root.use(`/${p}/*`, serveStatic({ root: 'site-out', rewriteRequestPath: (path) => (path.endsWith('/') ? `${path}index.html` : path) }));
    // Hosts that strip ".html" from links (clean URLs) still land on the page.
    root.use(`/${p}/*`, serveStatic({ root: 'site-out', rewriteRequestPath: (path) => (/\.[a-z0-9]+$/i.test(path) ? path : `${path}.html`) }));
  }
}
const mount = base || '/';
// A shared link is opened by someone without the student's demo cookie (their advisor), so it is routed to the copy
// that holds it, without starting a new copy. A link no copy holds is gone: expired, turned off, or its copy ended.
root.get(`${mount === '/' ? '' : mount}/shared/:token`, async (c) => {
  if (shared) return shared.fetch(rewrite(c.req.raw));
  const token = c.req.param('token');
  for (const s of sandboxes.values()) if (s.advocate.hasShare(token)) return s.app.fetch(rewrite(c.req.raw));
  c.header('Cache-Control', 'no-store');
  return c.html('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not available</title><main style="font:18px/1.5 system-ui;max-width:40rem;margin:3rem auto;padding:0 16px"><h1>This link isn\'t available</h1><p>It may have expired or been turned off by the student who made it.</p></main></html>', 410);
});
// The public guide and its feed hold no student data, so one shared copy serves them: an app taking the feed does
// not start a demonstration copy per request.
const publicGuide = shared ?? build().app;
for (const p of ['/guide', '/guide/*', '/api/guide/*']) root.get(`${mount === '/' ? '' : mount}${p}`, (c) => publicGuide.fetch(rewrite(c.req.raw)));
root.all(`${mount === '/' ? '' : mount}/*`, async (c) => {
  if (shared) return shared.fetch(rewrite(c.req.raw));
  let id = getCookie(c, 'adv_demo');
  const fresh = !id || !/^[a-f0-9]{32}$/.test(id) || !sandboxes.has(id);
  if (fresh && !sandboxStarts.take(clientOf(c))) return c.text('Too many new demonstration sessions from this address. Please try again in an hour.', 429);
  // A visitor whose copy is gone (it sat idle for two hours, or the server restarted) gets a fresh copy, told so,
  // rather than buttons that point at things the new copy never had.
  const lost = !!id && /^[a-f0-9]{32}$/.test(id) && !sandboxes.has(id);
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = randomBytes(16).toString('hex');
    setCookie(c, 'adv_demo', id, { path: mount, httpOnly: true, sameSite: 'Lax', secure: production, maxAge: 7200 });
  }
  const student = new URL(c.req.url).pathname.slice(base.length).match(/^\/s\/([^/]+)/)?.[1];
  if (lost && student) {
    appFor(id);
    return c.redirect(`${base}/s/${student}?reset=1`, 303);
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
// Done means serving (Pattern 23): the pipeline compares this commit with the one that passed.
root.get('/healthz', (c) => c.json({ ok: true, commit: process.env.BUILD_COMMIT ?? 'local', sandboxes: sandboxes.size }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: root.fetch, port });
console.log(`Student Advocate listening on http://localhost:${port}${base}/ (${demoMode ? 'demonstration, one copy per visitor' : 'production'} mode)`);
