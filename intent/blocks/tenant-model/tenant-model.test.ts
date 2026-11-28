import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Policy } from '../rbac/index.ts';
import { CrossTenant, FairShare, MemoryBacking, Memberships, NoTenant, QuotaExceeded, Quotas, ScopedStore, TenantError, TenantRate, TooBusy, UsageWindow, assertScoped, can, currentTenant, keyBelongsTo, parseTenantKey, scopeFilter, scopeSql, tenantId, tenantKey, tenantSecret, withTenant, type Row } from './index.ts';

interface Doc extends Row {
  title: string;
}

test('tenant ids are checked once, strictly', () => {
  assert.equal(tenantId('acme-co'), 'acme-co');
  for (const bad of ['', 'a', 'A', 'acme co', '-acme', 'a--b', 'a:b', 'a/b', '../x', 'x'.repeat(64), 'ünï']) assert.throws(() => tenantId(bad), TenantError, bad);
});

test('the context follows async work, nests, and has no default', async () => {
  assert.throws(() => currentTenant(), NoTenant);
  const seen: string[] = [];
  await Promise.all([
    withTenant({ tenant: 'one', actor: 'ana' }, async () => {
      await sleep(5);
      seen.push(`${currentTenant().tenant}/${currentTenant().actor}`);
      await withTenant({ tenant: 'inner' }, async () => {
        await sleep(1);
        seen.push(currentTenant().tenant);
      });
      seen.push(currentTenant().tenant);
    }),
    withTenant({ tenant: 'two' }, async () => {
      await sleep(1);
      seen.push(currentTenant().tenant);
    }),
  ]);
  assert.deepEqual(seen.sort(), ['inner', 'one', 'one/ana', 'two']);
  assert.throws(() => currentTenant(), NoTenant, 'nothing leaks out after');
  assert.throws(() => withTenant({ tenant: 'Bad Id' }, () => 1), TenantError);
});

test('tenant keys cannot be forged by what is in a part', () => {
  assert.equal(tenantKey('acme', 'files', 'a/b.txt'), 't:acme:files:a/b.txt');
  assert.notEqual(tenantKey('acme', 'a:b', 'c'), tenantKey('acme', 'a', 'b:c'));
  assert.deepEqual(parseTenantKey(tenantKey('acme', 'x:y', '100%', 'z')), { tenant: 'acme', parts: ['x:y', '100%', 'z'] });
  const forged = tenantKey('acme', 't:other:secret');
  assert.equal(parseTenantKey(forged)!.tenant, 'acme');
  assert.equal(keyBelongsTo(forged, 'other'), false);
  assert.equal(keyBelongsTo(forged, 'acme'), true);
  assert.equal(parseTenantKey('plain-key'), null);
  assert.equal(parseTenantKey('t:BAD:x'), null);
});

test('per-tenant secrets are repeatable, distinct per tenant and purpose, and need a real master', () => {
  const m = Buffer.alloc(32, 7);
  const a = tenantSecret(m, 'acme', 'cookies');
  assert.equal(a.length, 32);
  assert.deepEqual(a, tenantSecret(m, 'acme', 'cookies'));
  assert.notDeepEqual(a, tenantSecret(m, 'globex', 'cookies'));
  assert.notDeepEqual(a, tenantSecret(m, 'acme', 'files'));
  assert.notDeepEqual(a, tenantSecret(Buffer.alloc(32, 8), 'acme', 'cookies'));
  assert.throws(() => tenantSecret('short', 'acme', 'x'), /at least 16 bytes/);
  assert.equal(a.toString('hex'), tenantSecret(m, 'acme', 'cookies').toString('hex'));
});

test('a scoped store confines every operation to the tenant and hides other tenants', () => {
  const s = new ScopedStore<Doc>(new MemoryBacking<Doc>());
  const acme = s.forTenant('acme');
  const globex = s.forTenant('globex');
  acme.insert({ id: 'd1', title: 'Acme plan' });
  globex.insert({ id: 'd2', title: 'Globex plan' });
  assert.equal(acme.get('d1')!.tenant, 'acme', 'the tenant is stamped on insert');
  assert.equal(acme.get('d2'), undefined, 'another tenant\'s id is simply not found');
  assert.deepEqual(acme.list().map((d) => d.id), ['d1']);
  assert.equal(acme.update('d2', { title: 'hacked' }), undefined);
  assert.equal(acme.delete('d2'), false);
  assert.equal(globex.get('d2')!.title, 'Globex plan', 'and nothing was changed');
  assert.equal(globex.count(), 1);
});

test('the same id may exist in two tenants; a tenant cannot add a duplicate of its own', () => {
  const s = new ScopedStore<Doc>(new MemoryBacking<Doc>());
  s.forTenant('acme').insert({ id: 'inv-1', title: 'A' });
  s.forTenant('globex').insert({ id: 'inv-1', title: 'G' });
  assert.equal(s.forTenant('acme').get('inv-1')!.title, 'A');
  assert.equal(s.forTenant('globex').get('inv-1')!.title, 'G');
  assert.throws(() => s.forTenant('acme').insert({ id: 'inv-1', title: 'again' }), /already exists/);
});

test('a record cannot be inserted for, or moved to, another tenant', () => {
  const s = new ScopedStore<Doc>(new MemoryBacking<Doc>());
  const acme = s.forTenant('acme');
  assert.throws(() => acme.insert({ id: 'x', title: 't', tenant: 'globex' }), CrossTenant);
  acme.insert({ id: 'd', title: 't', tenant: 'acme' });
  assert.throws(() => acme.update('d', { tenant: 'globex' }), /cannot be moved/);
  assert.throws(() => acme.update('d', { id: 'e' }), /cannot change its id/);
  assert.equal(acme.update('d', { title: 'new' })!.title, 'new');
  assert.equal(acme.get('d')!.tenant, 'acme');
});

test('current uses the running context, and fails outside one', () => {
  const s = new ScopedStore<Doc>(new MemoryBacking<Doc>());
  assert.throws(() => s.current, NoTenant);
  withTenant({ tenant: 'acme' }, () => s.current.insert({ id: 'a', title: 'x' }));
  withTenant({ tenant: 'globex' }, () => assert.equal(s.current.get('a'), undefined));
  assert.equal(s.forTenant('acme').get('a')!.title, 'x');
});

test('a backing store that returns another tenant\'s row is caught, not trusted', () => {
  const leaky = { all: () => [{ id: 'x', tenant: 'globex', title: 'secret' }] as Doc[], put: () => undefined, remove: () => undefined };
  const s = new ScopedStore<Doc>(leaky);
  assert.throws(() => s.forTenant('acme').list(), /a row of tenant globex was returned inside tenant acme/);
  assert.deepEqual(assertScoped([{ tenant: 'a' }], 'a'), [{ tenant: 'a' }]);
  assert.throws(() => assertScoped([{ tenant: 'a' }, { tenant: 'b' }], 'a'), CrossTenant);
});

test('scoped SQL and filters: the tenant is a parameter, hostile columns and filters are refused', () => {
  assert.deepEqual(scopeSql('tenant_id', 'acme'), { sql: 'tenant_id = $1', params: ['acme'] });
  assert.deepEqual(scopeSql('d.tenant_id', 'acme', 3), { sql: 'd.tenant_id = $3', params: ['acme'] });
  assert.throws(() => scopeSql('tenant_id = 1 OR 1', 'acme'), /not a column name/);
  assert.throws(() => scopeSql('tenant_id', "acme' OR '1'='1"), TenantError);
  assert.deepEqual(scopeFilter('acme', { status: 'open' }), { status: 'open', tenant: 'acme' });
  assert.deepEqual(scopeFilter('acme', { tenant: 'acme' }), { tenant: 'acme' });
  assert.throws(() => scopeFilter('acme', { tenant: 'globex' }), /asks for tenant "globex"/);
  assert.throws(() => scopeFilter('acme', { $or: [{ tenant: 'globex' }] }), /\$or could reach outside/);
  assert.deepEqual(scopeFilter('acme', { $and: [{ a: 1 }] }, 'org'), { $and: [{ a: 1 }], org: 'acme' });
});

const POLICY: Policy = {
  roles: { member: { label: 'Member' }, admin: { label: 'Admin', inherits: ['member'] } },
  grants: [
    { role: 'member', kind: 'doc', actions: ['read'] },
    { role: 'admin', kind: 'doc', actions: ['write', 'delete'] },
  ],
};

test('access needs membership, the record\'s tenant, and a role held in that tenant only', () => {
  const m = new Memberships();
  m.add('ana', 'acme', ['admin']);
  m.add('ana', 'globex', ['member']);
  assert.equal(can(POLICY, m, 'ana', 'acme', 'delete', 'doc').allowed, true);
  assert.equal(can(POLICY, m, 'ana', 'globex', 'delete', 'doc').allowed, false, 'admin in one tenant is only a member in another');
  assert.equal(can(POLICY, m, 'ana', 'globex', 'read', 'doc').allowed, true);
  assert.equal(can(POLICY, m, 'ana', 'initech', 'read', 'doc').because, 'ana does not belong to tenant initech');
  assert.equal(can(POLICY, m, 'ana', 'acme', 'read', 'doc', { tenant: 'globex' }).because, 'the record belongs to another tenant');
  assert.equal(can(POLICY, m, 'eve', 'acme', 'read', 'doc').allowed, false);
  assert.deepEqual(m.tenantsOf('ana'), ['acme', 'globex']);
  assert.equal(m.choose('ana', 'acme'), 'acme');
  assert.throws(() => m.choose('ana', 'initech'), CrossTenant);
  m.remove('ana', 'acme');
  assert.equal(can(POLICY, m, 'ana', 'acme', 'read', 'doc').allowed, false, 'removed means gone at once');
});

const PLANS = [
  { name: 'free', limits: { seats: 3, storageMb: 100 }, rate: { perMinute: 60, burst: 5 }, concurrency: 2 },
  { name: 'pro', limits: { seats: 50, storageMb: 10_000 }, rate: { perMinute: 600 }, concurrency: 8 },
];

test('quotas are reserved whole, refuse with what is left, and unlisted resources are not allowed', () => {
  const q = new Quotas(PLANS);
  q.assign('acme', 'free');
  q.reserve('acme', 'seats', 2);
  q.reserve('acme', 'seats');
  assert.throws(() => q.reserve('acme', 'seats'), (e: Error) => e instanceof QuotaExceeded && e.limit === 3 && e.used === 3 && /plan allows 3, 3 are used/.test(e.message));
  assert.equal(q.usage('acme', 'seats'), 3, 'nothing is taken on refusal');
  assert.throws(() => q.reserve('acme', 'storageMb', 101), QuotaExceeded);
  assert.throws(() => q.reserve('acme', 'api-keys'), /plan allows 0/);
  assert.throws(() => q.reserve('acme', 'seats', 0), /whole units/);
  assert.throws(() => q.reserve('acme', 'seats', 1.5), /whole units/);
  q.release('acme', 'seats', 2);
  q.reserve('acme', 'seats', 2);
  q.release('acme', 'seats', 99);
  assert.equal(q.usage('acme', 'seats'), 0, 'release never goes below zero');
  assert.throws(() => q.reserve('nobody', 'seats'), /has no plan/);
  assert.throws(() => q.assign('acme', 'gold'), /no plan named "gold"/);
  q.assign('big', 'pro');
  assert.equal(q.usage('big', 'seats'), 0, 'usage is per tenant');
  assert.deepEqual(q.report('acme').map((r) => [r.resource, r.used, r.limit, r.share]), [['seats', 0, 3, 0], ['storageMb', 0, 100, 0]]);
});

test('request rates are per tenant, refill with time, and say how long to wait', () => {
  let t = 0;
  const q = new Quotas(PLANS);
  q.assign('acme', 'free');
  q.assign('globex', 'free');
  const r = new TenantRate(q, () => t);
  for (let i = 0; i < 5; i++) r.take('acme');
  assert.throws(() => r.take('acme'), (e: Error) => e instanceof TooBusy && e.retryAfterMs === 1000);
  r.take('globex');
  t += 1000;
  r.take('acme');
  assert.throws(() => r.take('acme'), TooBusy);
  t += 60_000;
  for (let i = 0; i < 5; i++) r.take('acme');
});

test('fair share: caps hold, and when busy one tenant cannot take more than an equal share', () => {
  const f = new FairShare(8, (t) => (t === 'big' ? 8 : 4), 0.5);
  const big = Array.from({ length: 4 }, () => f.acquire('big'));
  assert.equal(f.load().total, 4);
  const s1 = f.acquire('small');
  assert.throws(() => f.acquire('big'), (e: Error) => e instanceof TooBusy && /fair share of 4/.test(e.message), 'busy: big already has 8 / 2 tenants');
  const s2 = f.acquire('small');
  assert.deepEqual(f.load(), { total: 6, byTenant: { big: 4, small: 2 } });
  big[0]!();
  big[0]!();
  assert.equal(f.load().total, 5, 'giving a slot back twice gives it back once');
  s1();
  s2();
  f.acquire('big');
  assert.equal(f.load().byTenant.big, 4);
});

test('fair share: a tenant\'s own cap and the system capacity refuse with a wait', () => {
  const f = new FairShare(3, () => 2);
  f.acquire('a');
  f.acquire('a');
  assert.throws(() => f.acquire('a'), /limit of 2 at once/);
  f.acquire('b');
  assert.throws(() => f.acquire('c'), (e: Error) => e instanceof TooBusy && e.retryAfterMs === 1000 && /at capacity/.test(e.message));
  assert.throws(() => new FairShare(0, () => 1), /at least 1/);
});

test('noisy neighbours: a tenant over its share of the window is named, once others are active too', () => {
  let t = 0;
  const w = new UsageWindow(60_000, () => t);
  for (let i = 0; i < 80; i++) w.record('loud');
  w.record('aa', 10);
  assert.deepEqual(w.noisy(), [], 'two tenants are not enough to call one noisy');
  w.record('bb', 10);
  const n = w.noisy();
  assert.deepEqual(n.map((x) => x.tenant), ['loud']);
  assert.equal(n[0]!.share, 0.8);
  t = 61_000;
  assert.deepEqual(w.noisy(), [], 'the window slides on');
  w.record('aa');
  w.record('bb');
  w.record('cc');
  assert.deepEqual(w.noisy(), []);
});
