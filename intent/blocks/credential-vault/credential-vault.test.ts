import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKey } from '../crypto/index.ts';
import { load, envSecrets, Unsafe } from '../config/index.ts';
import { Vault, VaultError, vaultSettings, ringFromValues, hostAllowed, type AuditEvent, type VaultOptions } from './index.ts';

const mk = (o: Partial<VaultOptions> = {}) => {
  let t = 1_000_000;
  const events: AuditEvent[] = [];
  const ring = o.ring ?? { current: 'k1', keys: { k1: newKey() } };
  const v = new Vault({ ring, now: () => t, audit: (e) => events.push(e), ...o });
  return { v, events, ring, adv: (ms: number) => { t += ms; }, now: () => t };
};
const kind = (k: string) => (e: unknown) => e instanceof VaultError && e.kind === k;

test('secrets are sealed at rest and bound to the credential', () => {
  const { v } = mk();
  const id = v.create('ana', { name: 'github', type: 'bearer', secret: { token: 'tok-SECRETVALUE' } });
  assert.ok(!v.rawFor(id).includes('SECRETVALUE'));
  assert.deepEqual(v.reveal(id, 'ana'), { token: 'tok-SECRETVALUE' });
  const id2 = v.create('ana', { name: 'other', type: 'bearer', secret: { token: 'x'.repeat(10) } });
  // Copying a sealed value onto another row does not open.
  const raw = JSON.parse(v.rawFor(id)) as { sealed: string };
  const row2 = (v as unknown as { rows: Map<string, { sealed: string }> }).rows.get(id2)!;
  row2.sealed = raw.sealed;
  assert.throws(() => v.reveal(id2, 'ana'), /changed, or belongs somewhere else/);
});

test('type checks: required and unknown fields, names, host patterns', () => {
  const { v } = mk();
  assert.throws(() => v.create('a', { name: 'x', type: 'basic', secret: { username: 'u' } }), /needs password/);
  assert.throws(() => v.create('a', { name: 'x', type: 'apiKey', secret: { key: 'k', extra: 'e' } }), /no field extra/);
  assert.throws(() => v.create('a', { name: 'x', type: 'oauth2', secret: { clientId: 'c', clientSecret: 's', tokenUrl: 'http://evil.example/t' } }), kind('host'));
  assert.throws(() => v.create('a', { name: ' ', type: 'custom', secret: { a: '1' } }), /name/);
  assert.throws(() => v.create('a', { name: 'x', type: 'custom', secret: {}, hosts: [] }), /at least one/);
  assert.throws(() => v.create('a', { name: 'x', type: 'custom', secret: { a: '1' }, hosts: ['bad host'] }), /host pattern/);
  v.create('a', { name: 'dup', type: 'custom', secret: { a: '1' } });
  assert.throws(() => v.create('a', { name: 'dup', type: 'custom', secret: { a: '1' } }), /already have/);
  v.create('b', { name: 'dup', type: 'custom', secret: { a: '1' } });
});

test('sharing levels: use cannot see, view can, manage can share', async () => {
  const { v } = mk();
  const id = v.create('ana', { name: 'k', type: 'apiKey', secret: { key: 'sk_live_123456789' } });
  assert.throws(() => v.describe(id, 'bob'), kind('missing'));
  v.share(id, 'ana', 'bob', 'use');
  const d = v.describe(id, 'bob');
  assert.equal(d.level, 'use');
  assert.deepEqual(d.fields, { key: '********' });
  assert.throws(() => v.reveal(id, 'bob'), kind('denied'));
  assert.deepEqual(await v.headersFor(id, 'bob', { url: 'https://api.ex.com/x' }), { 'X-Api-Key': 'sk_live_123456789' });
  v.share(id, 'ana', 'cy', 'view');
  assert.equal(v.reveal(id, 'cy').key, 'sk_live_123456789');
  assert.match(v.describe(id, 'cy').fields.key!, /^\*{8}89$/);
  assert.throws(() => v.share(id, 'cy', 'dee', 'use'), kind('denied'));
  assert.throws(() => v.rotate(id, 'cy', { key: 'n' }), kind('denied'));
  assert.deepEqual(v.list('bob').map((x) => x.name), ['k']);
  assert.deepEqual(v.list('zed'), []);
});

test('share rules: no granting above own level, manage only from the owner, expiry, groups, revoke', () => {
  const { v, adv } = mk({ groups: { groupsOf: (a) => (a === 'eve' ? ['ops'] : []) } });
  const id = v.create('ana', { name: 'k', type: 'bearer', secret: { token: 'tttttttt' } });
  v.share(id, 'ana', 'bob', 'manage');
  assert.throws(() => v.share(id, 'bob', 'cy', 'manage'), kind('denied'));
  v.share(id, 'bob', 'cy', 'view');
  assert.throws(() => v.share(id, 'ana', 'ana', 'use'), /owner already/);
  assert.throws(() => v.share(id, 'ana', 'x y', 'use'), /target/);
  assert.throws(() => v.share(id, 'ana', 'dee', 'use', 1), /already be expired/);
  v.share(id, 'ana', 'group:ops', 'use', 1_000_000 + 1000);
  assert.equal(v.levelOf(id, 'eve'), 'use');
  adv(2000);
  assert.equal(v.levelOf(id, 'eve'), null);
  assert.equal(v.shares(id, 'ana').length, 3);
  assert.ok(v.unshare(id, 'ana', 'cy'));
  assert.ok(!v.unshare(id, 'ana', 'cy'));
  assert.equal(v.levelOf(id, 'cy'), null);
  assert.throws(() => v.delete(id, 'bob'), kind('denied'));
  v.delete(id, 'ana');
  assert.throws(() => v.reveal(id, 'ana'), kind('missing'));
  assert.equal(v.levelOf(id, 'bob'), null);
});

test('host allow-list and scopes stop a credential going where it should not', async () => {
  const { v, events } = mk();
  const id = v.create('ana', { name: 'slack', type: 'bearer', secret: { token: 'chat-secret-token' }, scopes: ['chat:write'], hosts: ['slack.com', '*.slack.com'] });
  assert.equal((await v.headersFor(id, 'ana', { scope: 'chat:write', url: 'https://api.slack.com/chat' })).Authorization, 'Bearer chat-secret-token');
  assert.equal((await v.headersFor(id, 'ana', { url: 'https://slack.com/x' })).Authorization!.startsWith('Bearer'), true);
  await assert.rejects(v.headersFor(id, 'ana', { url: 'https://evil.example/x' }), kind('host'));
  await assert.rejects(v.headersFor(id, 'ana', { url: 'https://slack.com.evil.example/x' }), kind('host'));
  await assert.rejects(v.headersFor(id, 'ana', { url: 'https://notslack.com/x' }), kind('host'));
  await assert.rejects(v.headersFor(id, 'ana', { url: 'http://api.slack.com/x' }), kind('host'));
  await assert.rejects(v.headersFor(id, 'ana', { scope: 'files:read', url: 'https://api.slack.com/x' }), kind('scope'));
  assert.ok(events.some((e) => e.action === 'denied' && e.detail === 'host evil.example'));
  assert.ok(hostAllowed('a.b.slack.com', ['*.slack.com']));
  assert.ok(!hostAllowed('slack.com', ['*.slack.com']));
});

test('basic and custom credentials build headers and fields', async () => {
  const { v } = mk();
  const b = v.create('ana', { name: 'basic', type: 'basic', secret: { username: 'u', password: 'p:w' } });
  assert.equal((await v.headersFor(b, 'ana', { url: 'https://x.example/a' })).Authorization, `Basic ${Buffer.from('u:p:w').toString('base64')}`);
  const c = v.create('ana', { name: 'c', type: 'custom', secret: { region: 'eu', secret: 'abc123xyz' } });
  await assert.rejects(v.headersFor(c, 'ana', { url: 'https://x.example/a' }), /fieldsFor/);
  assert.deepEqual(v.fieldsFor(c, 'ana', ['region'], { url: 'https://x.example/a' }), { region: 'eu' });
  assert.throws(() => v.fieldsFor(c, 'ana', ['nope'], { url: 'https://x.example/a' }), /no field/);
});

test('audit trail records use and reveal and never a secret', async () => {
  const { v, events } = mk();
  const id = v.create('ana', { name: 'k', type: 'bearer', secret: { token: 'TOPSECRET-123' } });
  v.share(id, 'ana', 'bob', 'view');
  await v.headersFor(id, 'bob', { scope: 's', url: 'https://x.example/a' });
  v.reveal(id, 'bob');
  try { v.rotate(id, 'bob', { token: 'a' }); } catch { /* denied */ }
  assert.deepEqual(events.map((e) => `${e.actor}:${e.action}`), ['ana:create', 'ana:share', 'bob:use', 'bob:reveal', 'bob:denied']);
  assert.ok(!JSON.stringify(events).includes('TOPSECRET'));
});

const oauth = (extra: Record<string, string | number> = {}) => ({ clientId: 'cid', clientSecret: 'csecret-xyz', tokenUrl: 'https://auth.example.com/token', ...extra });

test('OAuth: a valid token is used, an expiring one is refreshed, and a rotated refresh token is kept', async () => {
  const calls: Record<string, string>[] = [];
  const m = mk({ http: async (_u, f) => { calls.push(f); return { status: 200, json: { access_token: `at${calls.length}`, expires_in: 3600, refresh_token: `rt${calls.length}` } }; } });
  const id = m.v.create('ana', { name: 'g', type: 'oauth2', secret: oauth({ accessToken: 'at0', refreshToken: 'rt0', expiresAt: m.now() + 600_000 }) });
  assert.equal(await m.v.accessToken(id, 'ana'), 'at0');
  assert.equal(calls.length, 0);
  m.adv(560_000);
  assert.equal(await m.v.accessToken(id, 'ana'), 'at1');
  assert.deepEqual(calls[0], { grant_type: 'refresh_token', refresh_token: 'rt0', client_id: 'cid', client_secret: 'csecret-xyz' });
  assert.equal(m.v.reveal(id, 'ana').refreshToken, 'rt1');
  assert.equal(await m.v.accessToken(id, 'ana'), 'at1');
  m.adv(3_600_000);
  await m.v.accessToken(id, 'ana');
  assert.equal(calls[1]!.refresh_token, 'rt1');
  assert.ok(m.events.some((e) => e.action === 'refresh'));
});

test('OAuth: concurrent callers share one refresh; client credentials without a refresh token; headersFor uses it', async () => {
  let n = 0;
  const m = mk({ http: async () => { n++; await new Promise((r) => setTimeout(r, 10)); return { status: 200, json: { access_token: 'fresh', expires_in: 60 } }; } });
  const id = m.v.create('ana', { name: 'g', type: 'oauth2', secret: oauth({ scope: 'read' }), hosts: ['api.example.com'] });
  const [a, b, c] = await Promise.all([m.v.accessToken(id, 'ana'), m.v.accessToken(id, 'ana'), m.v.accessToken(id, 'ana')]);
  assert.deepEqual([a, b, c], ['fresh', 'fresh', 'fresh']);
  assert.equal(n, 1);
  assert.equal((await m.v.headersFor(id, 'ana', { url: 'https://api.example.com/v1' })).Authorization, 'Bearer fresh');
  const m2 = mk({ http: async (_u, f) => ({ status: 200, json: { access_token: JSON.stringify(f) } }) });
  const id2 = m2.v.create('ana', { name: 'cc', type: 'oauth2', secret: oauth({ scope: 'read' }) });
  assert.match(await m2.v.accessToken(id2, 'ana'), /client_credentials.*"scope":"read"/);
});

test('OAuth: invalid_grant needs re-authorisation; transient errors back off; reauthorize clears', async () => {
  let mode: 'grant' | '500' | 'ok' | 'net' = 'grant';
  const m = mk({ http: async () => {
    if (mode === 'net') throw new Error('ECONNRESET');
    if (mode === '500') return { status: 503, json: {} };
    if (mode === 'ok') return { status: 200, json: { access_token: 'good', expires_in: 100 } };
    return { status: 400, json: { error: 'invalid_grant' } };
  } });
  const id = m.v.create('ana', { name: 'g', type: 'oauth2', secret: oauth({ refreshToken: 'dead' }) });
  mode = '500';
  await assert.rejects(m.v.accessToken(id, 'ana'), kind('refresh'));
  await assert.rejects(m.v.accessToken(id, 'ana'), /trying again after/);
  m.adv(6000);
  mode = 'net';
  await assert.rejects(m.v.accessToken(id, 'ana'), /network/);
  m.adv(11_000);
  mode = 'grant';
  await assert.rejects(m.v.accessToken(id, 'ana'), kind('reauth'));
  await assert.rejects(m.v.accessToken(id, 'ana'), kind('reauth'));
  assert.equal(m.v.describe(id, 'ana').needsReauth, true);
  assert.deepEqual(m.v.due('ana', 90), [{ id, name: 'g', reason: 'needs re-authorisation' }]);
  m.v.reauthorize(id, 'ana', { accessToken: 'new', refreshToken: 'rt', expiresAt: m.now() + 3_600_000 });
  assert.equal(await m.v.accessToken(id, 'ana'), 'new');
  assert.ok(m.events.some((e) => e.action === 'refresh-failed' && e.detail === 'invalid_grant'));
});

test('rotation: new secret, grace window for the old one, version, due list', () => {
  const m = mk();
  const id = m.v.create('ana', { name: 'k', type: 'apiKey', secret: { key: 'old-key-123' } });
  assert.equal(m.v.rotate(id, 'ana', { key: 'new-key-456' }, { graceMs: 60_000 }), 2);
  assert.equal(m.v.reveal(id, 'ana').key, 'new-key-456');
  assert.ok(m.v.accepts(id, 'ana', 'key', 'new-key-456'));
  assert.ok(m.v.accepts(id, 'ana', 'key', 'old-key-123'));
  assert.ok(!m.v.accepts(id, 'ana', 'key', 'other'));
  m.adv(61_000);
  assert.ok(!m.v.accepts(id, 'ana', 'key', 'old-key-123'));
  assert.throws(() => m.v.rotate(id, 'ana', { wrong: 'x' }), /needs key/);
  m.adv(100 * 86_400_000);
  assert.match(m.v.due('ana', 90)[0]!.reason, /not rotated for 100 days/);
  m.v.rotate(id, 'ana', { key: 'third-key-789' });
  assert.deepEqual(m.v.due('ana', 90), []);
  assert.ok(!m.v.accepts(id, 'ana', 'key', 'new-key-456'));
});

test('expired credentials are refused and cannot be shared', async () => {
  const m = mk();
  const id = m.v.create('ana', { name: 'k', type: 'bearer', secret: { token: 'tttttttt' }, expiresAt: m.now() + 1000 });
  m.adv(2000);
  await assert.rejects(m.v.headersFor(id, 'ana', { url: 'https://x.example/a' }), kind('expired'));
  assert.throws(() => m.v.share(id, 'ana', 'bob', 'use'), kind('expired'));
  assert.deepEqual(m.v.due('ana', 90), [{ id, name: 'k', reason: 'expired' }]);
});

test('redaction removes secrets and their encoded forms for logs', () => {
  const m = mk();
  const id = m.v.create('ana', { name: 'k', type: 'apiKey', secret: { key: 'sk_live_a+b/c=d' } });
  m.v.share(id, 'ana', 'bob', 'use');
  const msg = `failed: key sk_live_a+b/c=d (${Buffer.from('sk_live_a+b/c=d').toString('base64')}) url ?k=${encodeURIComponent('sk_live_a+b/c=d')}`;
  for (const who of ['ana', 'bob']) assert.equal(m.v.redact(who, msg), 'failed: key [redacted] ([redacted]) url ?k=[redacted]');
  assert.equal(m.v.redact('zed', msg), msg);
});

test('key ring from config; test keys refused in production; re-seal after a key change', async () => {
  const k1 = newKey();
  const k2 = newKey();
  const env = { VAULT_KEYS: `prod1:${k1},prod2:${k2}`, VAULT_CURRENT_KEY: 'prod1' };
  const vals = await load(vaultSettings, env, envSecrets(env), { production: true });
  const ring = ringFromValues(vals);
  assert.equal(ring.current, 'prod1');
  const bad = { VAULT_KEYS: `test1:${k1}`, VAULT_CURRENT_KEY: 'test1' };
  await assert.rejects(load(vaultSettings, bad, envSecrets(bad), { production: true }), Unsafe);
  assert.throws(() => ringFromValues({ VAULT_KEYS: [`a:${k1}`], VAULT_CURRENT_KEY: 'zz' }), /not in the ring/);
  assert.throws(() => ringFromValues({ VAULT_KEYS: ['a:AAAA'], VAULT_CURRENT_KEY: 'a' }), /32 bytes/);
  const m = mk({ ring });
  const id = m.v.create('ana', { name: 'k', type: 'apiKey', secret: { key: 'abcdefgh' } });
  m.v.rotate(id, 'ana', { key: 'ijklmnop' }, { graceMs: 1000 });
  const ring2 = { current: 'prod2', keys: ring.keys };
  const v2 = new Vault({ ring: ring2, now: m.now });
  (v2 as unknown as { rows: unknown }).rows = (m.v as unknown as { rows: unknown }).rows;
  assert.equal(v2.resealAll(), 1);
  assert.match(JSON.parse(v2.rawFor(id)).sealed, /^v1\.prod2\./);
  assert.equal(v2.reveal(id, 'ana').key, 'ijklmnop');
  assert.ok(v2.accepts(id, 'ana', 'key', 'abcdefgh'));
  assert.equal(v2.resealAll(), 0);
});
