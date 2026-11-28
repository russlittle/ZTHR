import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Broker, BrokeringError, MemoryAccountStore, mapRoles, normalizeEmail, usernameFrom } from './index.ts';
import type { Account, ExternalLogin, ProviderConfig } from './index.ts';

const google: ProviderConfig = { id: 'google', kind: 'social', issuer: 'https://accounts.google.com', trust: 'verified-email', jit: 'create' };
const corp: ProviderConfig = {
  id: 'corp',
  kind: 'enterprise',
  issuer: 'https://login.corp.example',
  trust: 'authoritative',
  domains: ['corp.example'],
  jit: 'create',
  sync: 'force',
  roles: { defaults: ['member'], grantable: ['admin', 'finance'], mappings: [{ group: 'eng-admins', role: 'admin' }, { group: 'fin-*', role: 'finance' }, { group: 'owners', role: 'owner' }] },
};
const github: ProviderConfig = { id: 'github', kind: 'social', issuer: 'https://github.com', trust: 'none', jit: 'create', requireVerifiedEmail: false };

function setup(extra: ProviderConfig[] = []) {
  let t = 1_000_000;
  let n = 0;
  const store = new MemoryAccountStore();
  const broker = new Broker({ providers: [google, corp, github, ...extra], store, now: () => t, newId: () => `id-${++n}` });
  return { broker, store, advance: (ms: number) => (t += ms) };
}
const g = (claims: Record<string, unknown>): ExternalLogin => ({ provider: 'google', issuer: 'https://accounts.google.com', claims });
const c = (claims: Record<string, unknown>): ExternalLogin => ({ provider: 'corp', issuer: 'https://login.corp.example', claims });
const local = (over: Partial<Account> = {}): Account => ({ id: 'local-1', email: 'ana@example.com', emailVerified: true, username: 'ana', roles: ['user'], disabled: false, hasLocalCredential: true, createdAt: 1, ...over });

test('a first sign-in with a verified email creates the account on the spot, with its link and a username', () => {
  const { broker, store } = setup();
  const r = broker.login(g({ sub: 'g-1', email: 'Ana.Lee@Example.com', email_verified: true, name: 'Ana Lee' }));
  assert.equal(r.kind, 'created');
  assert.ok(r.kind === 'created');
  assert.equal(r.account.email, 'ana.lee@example.com');
  assert.equal(r.account.emailVerified, true);
  assert.equal(r.account.username, 'ana.lee');
  assert.equal(r.account.displayName, 'Ana Lee');
  assert.equal(r.account.hasLocalCredential, false);
  assert.deepEqual(r.events, ['email:verified', 'created:jit']);
  assert.equal(store.findLink('google', 'g-1')!.accountId, r.account.id);
});

test('the same subject signs in again as the same account, even after the upstream email changes', () => {
  const { broker, store, advance } = setup();
  const first = broker.login(g({ sub: 'g-1', email: 'ana@example.com', email_verified: true }));
  assert.ok(first.kind === 'created');
  advance(5000);
  const again = broker.login(g({ sub: 'g-1', email: 'new-address@example.com', email_verified: true }));
  assert.ok(again.kind === 'signed-in');
  assert.equal(again.account.id, first.account.id);
  assert.equal(again.account.email, 'ana@example.com', 'identity is the subject, not the email');
  assert.equal(store.findLink('google', 'g-1')!.lastLoginAt, 1_005_000);
  assert.equal((store as MemoryAccountStore).accounts.size, 1);
});

test('usernames stay unique: the second Ana becomes ana-2', () => {
  const { broker } = setup();
  const a = broker.login(g({ sub: '1', email: 'ana@one.example', email_verified: true }));
  const b = broker.login(g({ sub: '2', email: 'ana@two.example', email_verified: true }));
  assert.ok(a.kind === 'created' && b.kind === 'created');
  assert.equal(a.account.username, 'ana');
  assert.equal(b.account.username, 'ana-2');
  assert.equal(usernameFrom('Ana Lee+tag@x.org'), 'ana-lee-tag');
  assert.equal(usernameFrom('@@'), 'user');
  assert.equal(usernameFrom('x'.repeat(80)).length, 32);
});

test('a verified upstream email links to the local account that already has that verified email', () => {
  const { broker, store } = setup();
  (store as MemoryAccountStore).add(local());
  const r = broker.login(g({ sub: 'g-9', email: 'ANA@example.com', email_verified: true }));
  assert.ok(r.kind === 'linked');
  assert.equal(r.account.id, 'local-1');
  assert.equal(r.credentialsReset, false);
  assert.equal(r.account.hasLocalCredential, true, 'her password still works');
  assert.deepEqual(r.events, ['email:verified', 'linked:verified-email']);
  assert.equal(broker.login(g({ sub: 'g-9' })).kind, 'signed-in');
});

test('an upstream email that is not verified never links: the person must prove the existing account first', () => {
  const { broker, store, advance } = setup();
  (store as MemoryAccountStore).add(local());
  for (const claims of [{ sub: 'x', email: 'ana@example.com', email_verified: false }, { sub: 'x', email: 'ana@example.com' }, { sub: 'x', email: 'ana@example.com', email_verified: 'no' }]) {
    const r = broker.login(g(claims));
    assert.ok(r.kind === 'challenge-required', JSON.stringify(claims));
    assert.equal(r.reason, 'provider-email-unverified');
    assert.equal(store.findLink('google', 'x'), undefined, 'nothing is linked yet');
  }
  const gh = broker.login({ provider: 'github', issuer: 'https://github.com', claims: { sub: 42, email: 'ana@example.com', email_verified: true } });
  assert.ok(gh.kind === 'challenge-required', 'a provider with trust "none" is never believed about email, whatever it claims');
  const r = broker.login(g({ sub: 'x', email: 'ana@example.com' }));
  assert.ok(r.kind === 'challenge-required');
  assert.throws(() => broker.completeLink(r.pending.id, 'someone-else'), /different account/);
  assert.throws(() => broker.completeLink(r.pending.id, 'local-1'), /no such pending link/, 'a failed attempt spends it');
  const r2 = broker.login(g({ sub: 'x', email: 'ana@example.com' }));
  assert.ok(r2.kind === 'challenge-required');
  advance(601_000);
  assert.throws(() => broker.completeLink(r2.pending.id, 'local-1'), /expired/);
  const r3 = broker.login(g({ sub: 'x', email: 'ana@example.com' }));
  assert.ok(r3.kind === 'challenge-required');
  const done = broker.completeLink(r3.pending.id, 'local-1');
  assert.ok(done.kind === 'linked');
  assert.equal(store.findLink('google', 'x')!.accountId, 'local-1');
  assert.throws(() => broker.completeLink(r3.pending.id, 'local-1'), /already used/, 'single use');
});

test('pre-hijack: a verified upstream email meeting an unverified local account does not auto-link for a social provider', () => {
  const { broker, store } = setup();
  (store as MemoryAccountStore).add(local({ id: 'planted', emailVerified: false, username: 'planted', email: 'victim@example.com' }));
  const r = broker.login(g({ sub: 'victim-google', email: 'victim@example.com', email_verified: true }));
  assert.ok(r.kind === 'challenge-required');
  assert.equal(r.reason, 'local-email-unverified');
  assert.equal(store.findLink('google', 'victim-google'), undefined);
  assert.equal((store.get('planted') as Account).hasLocalCredential, true, 'nothing was changed');
});

test('an authoritative provider may take over an unverified local account, and the old credentials are reset', () => {
  const { broker, store } = setup();
  (store as MemoryAccountStore).add(local({ id: 'planted', emailVerified: false, email: 'victim@corp.example', username: 'victim' }));
  const r = broker.login(c({ sub: 'u-77', email: 'victim@corp.example' }));
  assert.ok(r.kind === 'linked');
  assert.equal(r.credentialsReset, true);
  assert.equal(r.account.emailVerified, true);
  assert.equal(r.account.hasLocalCredential, false, 'the attacker\'s password no longer works');
  assert.equal(r.account.credentialsResetAt, 1_000_000);
  assert.ok(r.events.includes('credentials-reset'));
});

test('authoritative means the provider is believed about its own domains without an email_verified flag, and about no others', () => {
  const { broker } = setup();
  const ok = broker.login(c({ sub: 'u-1', email: 'sam@corp.example' }));
  assert.ok(ok.kind === 'created');
  assert.equal(ok.account.emailVerified, true);
  const other = broker.login(c({ sub: 'u-2', email: 'sam@elsewhere.example', email_verified: true }));
  assert.ok(other.kind === 'denied');
  assert.equal(other.reason, 'domain-not-allowed');
  const none = broker.login(c({ sub: 'u-3' }));
  assert.ok(none.kind === 'denied' && none.reason === 'domain-not-allowed', 'an enterprise login without an email cannot prove its domain');
  assert.throws(() => new Broker({ providers: [{ ...corp, domains: [] }], now: () => 0, newId: () => 'x' }), /lists no domains/);
});

test('hostile or malformed logins are denied with a reason: other issuer, unknown or disabled provider, no subject, bad email', () => {
  const { broker } = setup([{ ...google, id: 'google-off', disabled: true }]);
  const d = (l: ExternalLogin) => { const r = broker.login(l); assert.ok(r.kind === 'denied'); return r.reason; };
  assert.equal(d({ ...g({ sub: '1' }), issuer: 'https://evil.example' }), 'issuer-mismatch');
  assert.equal(d({ provider: 'nope', issuer: 'x', claims: {} }), 'provider-unknown');
  assert.equal(d({ ...g({ sub: '1' }), provider: 'google-off' }), 'provider-disabled');
  assert.equal(d(g({ email: 'a@example.com', email_verified: true })), 'no-subject');
  assert.equal(d(g({ sub: '' })), 'no-subject');
  assert.equal(d(g({ sub: 'x'.repeat(256) })), 'no-subject');
  assert.equal(d(g({ sub: '1', email: 'not an email', email_verified: true })), 'invalid-email');
  assert.equal(d(g({ sub: '1', email: 'a@b@c.example', email_verified: true })), 'invalid-email');
  assert.equal(d(g({ sub: '1', email: 'a\u0000@example.com', email_verified: true })), 'invalid-email');
  assert.equal(normalizeEmail(' Ana@Example.COM '), 'ana@example.com');
  assert.equal(normalizeEmail(42), undefined);
});

test('just-in-time rules: deny mode lets only existing accounts in; a verified email is required unless waived', () => {
  const { broker, store } = setup([{ ...google, id: 'closed', issuer: 'https://closed.example', jit: 'deny' }]);
  const closed = broker.login({ provider: 'closed', issuer: 'https://closed.example', claims: { sub: '1', email: 'new@example.com', email_verified: true } });
  assert.ok(closed.kind === 'denied' && closed.reason === 'jit-disabled');
  const unverified = broker.login(g({ sub: '2', email: 'new@example.com', email_verified: false }));
  assert.ok(unverified.kind === 'denied' && unverified.reason === 'email-unverified');
  const waived = broker.login({ provider: 'github', issuer: 'https://github.com', claims: { sub: 12345, login: 'octo', preferred_username: 'octocat', email: 'octo@example.com' } });
  assert.ok(waived.kind === 'created', 'GitHub-style numeric subjects work');
  assert.equal(waived.account.emailVerified, false);
  assert.equal(waived.account.username, 'octocat');
  assert.equal(store.findLink('github', '12345')!.accountId, waived.account.id);
  const noEmail = broker.login({ provider: 'github', issuer: 'https://github.com', claims: { sub: 6 } });
  assert.ok(noEmail.kind === 'created' && noEmail.account.email === undefined);
});

test('a disabled account cannot sign in by link or by email, and nothing is linked', () => {
  const { broker, store } = setup();
  (store as MemoryAccountStore).add(local({ disabled: true }));
  const r = broker.login(g({ sub: 'g-1', email: 'ana@example.com', email_verified: true }));
  assert.ok(r.kind === 'denied' && r.reason === 'account-disabled');
  assert.equal(store.findLink('google', 'g-1'), undefined);
  (store as MemoryAccountStore).add(local({ id: 'l2', email: 'bo@example.com', username: 'bo', disabled: false }));
  assert.ok(broker.login(g({ sub: 'g-2', email: 'bo@example.com', email_verified: true })).kind === 'linked');
  store.get('l2')!.disabled = true;
  const again = broker.login(g({ sub: 'g-2' }));
  assert.ok(again.kind === 'denied' && again.reason === 'account-disabled');
});

test('roles: defaults, mapped groups and prefixes, never beyond the grantable list, and "force" refreshes only what the provider owns', () => {
  assert.deepEqual(mapRoles(corp, { groups: ['eng-admins', 'fin-uk', 'owners', 'random'] }), ['admin', 'finance', 'member'], '"owners" maps to a role that is not grantable, so it is dropped');
  assert.deepEqual(mapRoles(corp, { groups: 'eng-admins' }), ['admin', 'member'], 'a single string works');
  assert.deepEqual(mapRoles(corp, {}), ['member']);
  assert.deepEqual(mapRoles({ ...corp, roles: { mappings: [{ group: 'x', role: 'admin' }] } }, { groups: ['x'] }), [], 'with no grantable list, mapped roles are never granted');
  assert.deepEqual(mapRoles({ ...corp, mapping: { groups: 'realm.roles' } }, { realm: { roles: ['eng-admins'] }, groups: ['fin-x'] }), ['admin', 'member'], 'nested claim paths');
  const { broker, store } = setup();
  const first = broker.login(c({ sub: 'u-1', email: 'sam@corp.example', groups: ['eng-admins'] }));
  assert.ok(first.kind === 'created');
  assert.deepEqual(first.account.roles, ['admin', 'member']);
  first.account.roles.push('billing-contact');
  const second = broker.login(c({ sub: 'u-1', groups: ['fin-ops'], name: 'Sam S' }));
  assert.ok(second.kind === 'signed-in');
  assert.deepEqual(second.account.roles, ['billing-contact', 'finance', 'member'], 'admin was revoked upstream, the locally granted role stays');
  assert.equal(second.account.displayName, 'Sam S');
  assert.ok(second.events.includes('synced'));
  assert.equal(store.get(first.account.id)!.roles.includes('admin'), false);
});

test('"import" sync does not touch an account after the first sign-in', () => {
  const { broker } = setup();
  const a = broker.login(g({ sub: '1', email: 'a@example.com', email_verified: true, name: 'First' }));
  assert.ok(a.kind === 'created');
  const b = broker.login(g({ sub: '1', name: 'Renamed' }));
  assert.ok(b.kind === 'signed-in');
  assert.equal(b.account.displayName, 'First');
});

test('unlinking is refused when it would lock the person out', () => {
  const { broker, store } = setup();
  const a = broker.login(g({ sub: '1', email: 'a@example.com', email_verified: true }));
  assert.ok(a.kind === 'created');
  assert.throws(() => broker.unlink(a.account.id, 'google'), /only way to sign in/);
  assert.throws(() => broker.unlink(a.account.id, 'corp'), /not linked/);
  assert.throws(() => broker.unlink('nobody', 'google'), /no such account/);
  a.account.hasLocalCredential = true;
  broker.unlink(a.account.id, 'google');
  assert.equal(store.findLink('google', '1'), undefined);
});

test('claim paths cannot reach into prototypes, and a claim that is not a string is ignored', () => {
  const { broker } = setup([{ ...google, id: 'odd', issuer: 'https://odd.example', mapping: { subject: 'constructor.name', email: '__proto__.email' } }]);
  const r = broker.login({ provider: 'odd', issuer: 'https://odd.example', claims: { sub: 'x' } });
  assert.ok(r.kind === 'denied' && r.reason === 'no-subject');
  const o = broker.login(g({ sub: ['array'], email: { x: 1 } }));
  assert.ok(o.kind === 'denied');
});

test('configuration mistakes are refused when the broker is built', () => {
  const mk = (p: ProviderConfig[]) => () => new Broker({ providers: p, now: () => 0, newId: () => 'x' });
  assert.throws(mk([google, google]), /two providers are called "google"/);
  assert.throws(mk([{ ...google, issuer: 'http://accounts.example' }]), /must be an https URL/);
  assert.throws(mk([{ ...google, id: 'Bad Id' }]), /not a usable provider id/);
  assert.doesNotThrow(mk([{ ...google, issuer: 'http://localhost:8080/realm' }]));
});
