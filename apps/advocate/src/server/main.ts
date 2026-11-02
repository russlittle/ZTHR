import { serve } from '@hono/node-server';
import { refuseToStartUnless } from '@zthr/runtime';
import { Advocate } from '../agents/advocate.js';
import { createApp } from './app.js';
import { seedDemo } from './demo.js';
import { esc, page } from './html.js';

/**
 * Starts the Advocate. In production it refuses to start without its secrets
 * and a real authentication provider (Pattern 29); the demonstration mode runs
 * on synthetic students with keys generated in memory.
 */
const production = process.env.NODE_ENV === 'production';
const hex32 = (v: string | undefined) => (v && /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : undefined);

refuseToStartUnless([
  { name: 'master key', check: () => !production || !!hex32(process.env.ADVOCATE_MASTER_KEY) || 'ADVOCATE_MASTER_KEY must be 32 bytes of hex in production' },
  { name: 'approval secret', check: () => !production || !!hex32(process.env.ADVOCATE_APPROVAL_SECRET) || 'ADVOCATE_APPROVAL_SECRET must be 32 bytes of hex in production' },
  { name: 'authentication', check: () => !production || !!process.env.ADVOCATE_AUTH_ISSUER || 'production requires a passkey or OIDC issuer; the demo has no sign-in' },
  { name: 'demo data in production', check: () => !(production && process.env.ADVOCATE_DEMO === '1') || 'synthetic demo students may not be seeded in production' },
]);

const fixedToday = process.env.ADVOCATE_TODAY; // e.g. 2026-11-02 for a reproducible demo
const advocate = new Advocate({
  today: fixedToday ? () => fixedToday : undefined,
  masterKey: hex32(process.env.ADVOCATE_MASTER_KEY),
  approvalSecret: hex32(process.env.ADVOCATE_APPROVAL_SECRET),
});
const app = createApp(advocate);
const demo = production ? [] : seedDemo(advocate);
app.get('/demo', (c) =>
  c.html(
    page(
      'Demo students',
      `<div class="card"><h2>Twelve synthetic students</h2><p class="muted">Each is a persona from the design work. Open one to see their Advocate.</p><ul class="clean">${demo
        .map((s) => `<li><a href="/s/${esc(s.id)}">${esc(s.chosenName)}</a> <span class="tag">${esc(s.enrollment.college)}</span> <span class="tag">${esc(s.dial.depth)}</span></li>`)
        .join('')}</ul></div>`,
    ),
  ),
);
const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
console.log(`Student Advocate listening on http://localhost:${port} (${production ? 'production' : 'demonstration'} mode)`);
