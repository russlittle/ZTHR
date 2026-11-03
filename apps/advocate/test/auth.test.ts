// Verifies docs/flows/sign-in.md
import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { EgressTwin } from '@zthr/egress';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';
import { GoogleVerifier, Sessions } from '../src/server/auth.js';
import { PERSONAS } from '../src/server/demo.js';

const CLIENT = 'test-client.apps.googleusercontent.com';
const NOW = Date.parse('2026-11-02T15:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function token(claims: Record<string, unknown> = {}, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' };
  const body = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '1234567890', email: 'student@example.com', email_verified: true, name: 'Rae Student', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...claims };
  const signing = `${b64(header)}.${b64(body)}`;
  const s = createSign('RSA-SHA256');
  s.update(signing);
  return `${signing}.${s.sign(opts.key ?? privateKey).toString('base64url')}`;
}

const google = (status = 200) => new EgressTwin(['www.googleapis.com'], () => ({ status, body: JSON.stringify({ keys: [jwk] }) }));

describe('verifying a Google ID token', () => {
  const v = (status = 200) => new GoogleVerifier(google(status), CLIENT, () => NOW);
  it('accepts a token signed by Google for this app', async () => expect((await v().verify(token())).ok).toBe(true));
  const BAD: [string, () => string, RegExp][] = [
    ['another app', () => token({ aud: 'someone-else' }), /another app/],
    ['the wrong issuer', () => token({ iss: 'https://evil.example.com' }), /issuer/],
    ['expired', () => token({ exp: NOW / 1000 - 3600 }), /expired/],
    ['issued in the future', () => token({ iat: NOW / 1000 + 3600 }), /future/],
    ['an unverified email', () => token({ email_verified: false }), /not verified/],
    ['signed by a key that is not Google\'s', () => token({}, { key: other.privateKey }), /bad signature/],
    ['an unknown key id', () => token({}, { kid: 'nope' }), /unknown key/],
    ['alg none', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64({ aud: CLIENT })}.`, /not allowed/],
    ['HS256 instead of RS256', () => token({}, { alg: 'HS256' }), /not allowed/],
    ['a tampered body', () => { const t = token().split('.'); return `${t[0]}.${b64({ aud: CLIENT, iss: 'https://accounts.google.com', sub: 'attacker', email_verified: true, exp: NOW / 1000 + 3600, iat: NOW / 1000 })}.${t[2]}`; }, /bad signature/],
    ['garbage', () => 'not.a.token', /unreadable|not a JWT/],
  ];
  for (const [name, make, why] of BAD) it(`refuses ${name}`, async () => expect(await v().verify(make())).toMatchObject({ ok: false, reason: expect.stringMatching(why) }));
  it('refuses when Google\'s keys cannot be fetched, rather than trusting anything', async () => expect((await v(503).verify(token())).ok).toBe(false));
  it('fetches keys only from Google', async () => {
    const e = google();
    await new GoogleVerifier(e, CLIENT, () => NOW).verify(token());
    expect(e.sent.every((r) => r.url === 'https://www.googleapis.com/oauth2/v3/certs')).toBe(true);
  });
});

describe('sessions', () => {
  const s = new Sessions(randomBytes(32), () => NOW);
  it('round-trips and never contains the email or the Google subject', () => {
    const c = s.issue(s.subjectKey('1234567890'), 'student@example.com');
    expect(s.read(c)?.subjectKey).toBe(s.subjectKey('1234567890'));
    expect(Buffer.from(c.split('.')[0]!, 'base64url').toString()).not.toMatch(/student@|1234567890/);
  });
  it('refuses a forged or altered cookie', () => {
    const c = s.issue('k', 'a@b.c');
    expect(s.read(`${c.split('.')[0]}.AAAA`)).toBeUndefined();
    expect(s.read(`${b64({ k: 'k', e: 'x', x: NOW + 1e9 })}.${c.split('.')[1]}`)).toBeUndefined();
  });
  it('refuses an expired session', () => {
    const c = new Sessions(Buffer.alloc(32, 1), () => NOW - 13 * 3600 * 1000).issue('k', 'a@b.c');
    expect(new Sessions(Buffer.alloc(32, 1), () => NOW).read(c)).toBeUndefined();
  });
});

describe('the app with sign-in on', () => {
  const setup = () => {
    const a = new Advocate({ today: () => '2026-11-02' });
    const sessions = new Sessions(randomBytes(32), () => NOW);
    PERSONAS.Maria!(a);
    const app = new Hono({ strict: false }).route('/advocate', createApp(a, { base: '/advocate', auth: { clientId: CLIENT, verifier: new GoogleVerifier(google(), CLIENT, () => NOW), sessions, adminEmailHashes: [sessions.emailHash('admin@example.com')] } }));
    const signIn = async (claims: Record<string, unknown> = {}) => {
      const res = await app.request('/advocate/auth/google', { method: 'POST', body: new URLSearchParams({ credential: token(claims), g_csrf_token: 'c1' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'g_csrf_token=c1' } });
      return { res, cookie: (res.headers.get('set-cookie') ?? '').match(/adv_session=[^;]+/)?.[0] ?? '' };
    };
    return { a, app, signIn };
  };
  it('a student page needs a session', async () => expect((await setup().app.request('/advocate/s/maria')).status).toBe(302));
  it('signing in makes the student\'s own Advocate and opens it', async () => {
    const { app, signIn } = setup();
    const { res, cookie } = await signIn();
    expect(res.status).toBe(302);
    const home = res.headers.get('location')!;
    expect((await app.request(home, { headers: { cookie } })).status).toBe(200);
  });
  it('signing in again opens the same record, not a new one', async () => {
    const { a, signIn } = setup();
    const one = (await signIn()).res.headers.get('location');
    const two = (await signIn()).res.headers.get('location');
    expect(one).toBe(two);
    expect((a.store.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE collection = 'students'").get() as { n: number }).n).toBe(2);
  });
  it('one student\'s session cannot open another student\'s page', async () => {
    const { app, signIn } = setup();
    const { cookie } = await signIn();
    expect((await app.request('/advocate/s/maria', { headers: { cookie } })).status).toBe(302);
  });
  it('the record keeps only a keyed hash of the Google subject', async () => {
    const { a, signIn } = setup();
    await signIn();
    expect(JSON.stringify(a.store.exportStudent(a.findByAccount(a.store.list<{ account?: string }>('students', '').at(0)?.account ?? '')?.id ?? ''))).not.toContain('1234567890');
    const rows = a.store.db.prepare("SELECT json FROM docs WHERE collection = 'students'").all() as { json: string }[];
    expect(rows.map((r) => r.json).join()).not.toMatch(/1234567890|student@example\.com/);
  });
  it('a sign-in without the matching anti-forgery cookie is refused', async () => {
    const { app } = setup();
    const res = await app.request('/advocate/auth/google', { method: 'POST', body: new URLSearchParams({ credential: token(), g_csrf_token: 'c1' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'g_csrf_token=other' } });
    expect(res.status).toBe(400);
  });
  it('a bad token is refused and no record is made', async () => {
    const { a, app } = setup();
    const res = await app.request('/advocate/auth/google', { method: 'POST', body: new URLSearchParams({ credential: token({ aud: 'x' }), g_csrf_token: 'c1' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'g_csrf_token=c1' } });
    expect(res.status).toBe(401);
    expect((a.store.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE collection = 'students'").get() as { n: number }).n).toBe(1);
  });
  it('the admin needs a listed email', async () => {
    const { app, signIn } = setup();
    const student = await signIn();
    expect((await app.request('/advocate/admin/', { headers: { cookie: student.cookie } })).status).toBe(302);
    const admin = await signIn({ sub: '999', email: 'admin@example.com' });
    expect((await app.request('/advocate/admin/', { headers: { cookie: admin.cookie } })).status).toBe(200);
  });
});
