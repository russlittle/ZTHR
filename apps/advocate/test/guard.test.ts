// Verifies docs/security.md
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Window, clientOf, rateLimit, sameOrigin, securityHeaders } from '../src/server/guard.js';
import { SERVICES } from '../../campus-services/src/index.js';

describe('security headers', () => {
  const app = new Hono().use('*', securityHeaders()).get('/', (c) => c.text('ok'));
  it('every answer forbids framing, sniffing and other origins', async () => {
    const r = await app.request('/');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const csp = r.headers.get('content-security-policy')!;
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
  it('over HTTPS, browsers are told to use HTTPS only; over plain HTTP (local), they are not', async () => {
    const https = await app.request('/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(https.headers.get('strict-transport-security')).toMatch(/^max-age=31536000/);
    expect((await app.request('/')).headers.get('strict-transport-security')).toBeNull();
  });
});

describe('rate limits', () => {
  it('a window allows its maximum, refuses the next, and resets after its length', () => {
    const w = new Window(2, 1000);
    expect([w.take('a', 0), w.take('a', 10), w.take('a', 20)]).toEqual([true, true, false]);
    expect(w.take('b', 20)).toBe(true);
    expect(w.take('a', 1000)).toBe(true);
  });
  it('holds a bounded number of clients, dropping the oldest', () => {
    const w = new Window(1, 1000, 3);
    for (const k of ['a', 'b', 'c', 'd']) w.take(k, 0);
    expect(w.size).toBe(3);
    expect(w.take('a', 1)).toBe(true);
  });
  it('a client over its rate gets 429 with Retry-After; another client is unaffected', async () => {
    const app = new Hono().use('*', rateLimit(new Window(2, 60_000))).get('/', (c) => c.text('ok'));
    const from = (ip: string) => app.request('/', { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    expect((await from('1.1.1.1')).status).toBe(200);
    expect((await from('1.1.1.1')).status).toBe(200);
    const r = await from('1.1.1.1');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await from('2.2.2.2')).status).toBe(200);
  });
  it('the client is the first forwarded address', () => {
    const c = { req: { header: (n: string) => (n === 'x-forwarded-for' ? ' 9.9.9.9 , 10.0.0.1' : undefined) } } as never;
    expect(clientOf(c)).toBe('9.9.9.9');
  });
});

describe('request size', () => {
  it('a body over the limit is refused before any handler reads it', async () => {
    let read = false;
    const app = new Hono().use('*', bodyLimit({ maxSize: 1024, onError: (c) => c.text('too large', 413) })).post('/', async (c) => ((read = true), c.text(await c.req.text())));
    expect((await app.request('/', { method: 'POST', body: 'x'.repeat(2048) })).status).toBe(413);
    expect(read).toBe(false);
    expect((await app.request('/', { method: 'POST', body: 'x'.repeat(100) })).status).toBe(200);
  });
});

describe('public twins stay bounded', () => {
  it('a booking with a very long name or key is refused', async () => {
    const places = SERVICES.places.make();
    const post = (body: object, key = 'k1') => places.request('/v1/rooms/sinclair-room-6142/reservations?at=2026-11-02T14:00:00Z', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
    expect((await post({ date: '2026-11-04', start: '10:00', minutes: 30, name: 'x'.repeat(61) })).status).toBe(400);
    expect((await post({ date: '2026-11-04', start: '10:00', minutes: 30, name: 'Maria' }, 'k'.repeat(101))).status).toBe(400);
    expect((await post({ date: '2026-11-04', start: '10:00', minutes: 30, name: 'Maria' })).status).toBe(201);
  });
});

describe('the text demo stays bounded', () => {
  it('holds at most 200 conversations per copy, ignores implausible numbers, and cuts long messages', async () => {
    const { Advocate } = await import('../src/agents/advocate.js');
    const { createApp } = await import('../src/server/app.js');
    const app = new Hono().route('/x', createApp(new Advocate(), { base: '/x' }));
    const send = (phone: string, body = 'hi') => app.request('/x/text', { method: 'POST', body: new URLSearchParams({ phone, body }) });
    for (let i = 0; i < 200; i++) expect((await send(`+1937555${String(i).padStart(4, '0')}`)).status).toBe(200);
    expect((await send('+19375559999')).status).toBe(429);
    expect((await send('+19375550001')).status).toBe(200);
    const odd = await (await send('not a number', 'x'.repeat(5000))).text();
    expect(odd).not.toContain('not a number');
    expect(odd).not.toContain('x'.repeat(1601));
  });
});

describe('forms posted only from this site', () => {
  const app = new Hono().use('*', sameOrigin()).post('/s/ana/action', (c) => c.text('done')).get('/s/ana', (c) => c.text('page'));
  const post = (headers: Record<string, string>) => app.request('http://advocate.run.app/s/ana/action', { method: 'POST', headers: { host: 'advocate.run.app', ...headers } });
  it('a post from another site is refused, saying why', async () => {
    for (const origin of ['https://evil.example', 'https://zthr.ai.evil.example', 'http://advocate.run.app.evil', 'null', 'not a url']) {
      const r = await post({ origin });
      expect(r.status, origin).toBe(403);
      expect(await r.text()).toBe('This form can be sent only from this site.');
    }
  });
  it('a post from this host, the host that fronts it, or zthr.ai passes; so does one with no Origin, such as a text-message webhook', async () => {
    for (const h of [{ origin: 'https://advocate.run.app' } as Record<string, string>, { origin: 'https://zthr.ai' }, { origin: 'https://www.zthr.ai' }, { origin: 'https://front.example', 'x-forwarded-host': 'front.example' }, { origin: 'https://ADVOCATE.run.app' }, {}]) expect((await post(h)).status, JSON.stringify(h)).toBe(200);
  });
  it('only the sign-in route accepts Google posting the credential back', async () => {
    const g = new Hono().use('*', sameOrigin()).post('/sa/auth/google', (c) => c.text('in')).post('/sa/s/ana/action', (c) => c.text('done'));
    const send = (path: string, origin: string) => g.request(`http://advocate.run.app${path}`, { method: 'POST', headers: { host: 'advocate.run.app', origin } });
    expect((await send('/sa/auth/google', 'https://accounts.google.com')).status).toBe(200);
    expect((await send('/sa/s/ana/action', 'https://accounts.google.com')).status).toBe(403);
    expect((await send('/sa/auth/google', 'https://evil.example')).status).toBe(403);
    expect((await send('/sa/auth/google/x', 'https://accounts.google.com')).status).toBe(403);
  });
  it('reading a page is never refused for its origin', async () => {
    expect((await app.request('http://advocate.run.app/s/ana', { headers: { host: 'advocate.run.app', origin: 'https://evil.example' } })).status).toBe(200);
  });
});
