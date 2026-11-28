import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../rbac/index.ts';
import { Realm, RealmRefused, Realms, checkPassword } from './index.ts';
import type { RealmPolicy } from './index.ts';

const policy: RealmPolicy = { password: { minLength: 10, requireUpper: true, requireDigit: true, notUsername: true }, registrationAllowed: true, emailDomains: ['acme.test'], lockout: { maxFailures: 3, lockMs: 60_000 } };
const clock = { t: 1_000_000 };
let n = 0;
const make = (name = 'acme', p: RealmPolicy = policy) =>
  new Realm({ name, policy: p, now: () => clock.t, newId: () => `u${++n}`, attributes: [{ name: 'dept', required: true, pattern: '[A-Z]{2,4}' }, { name: 'phone', multivalued: true, editableBy: 'user', maxLength: 20 }, { name: 'region' }], defaultRoles: ['member'] });
const seeded = (): Realm => {
  const r = make();
  r.defineRole({ name: 'member', label: 'Member' });
  r.defineRole({ name: 'editor', label: 'Editor', includes: ['member'] });
  r.defineRole({ name: 'admin', label: 'Administrator', includes: ['editor'] });
  r.addGroup('/eng', { roles: ['editor'], attrs: { region: ['emea'] } });
  r.addGroup('/eng/platform', { attrs: { region: ['us'] } });
  return r;
};

test('roles compose: an administrator is also an editor and a member', () => {
  const r = seeded();
  const u = r.createUser({ username: 'Ana', roles: ['admin'], attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.effectiveRoles(u.id), ['admin', 'editor', 'member']);
});

test('role composition cycles are refused and leave the earlier definition alone', () => {
  const r = seeded();
  assert.throws(() => r.defineRole({ name: 'member', label: 'Member', includes: ['admin'] }), /include itself/);
  assert.deepEqual(r.rolePolicy().roles['member'], { label: 'Member' });
  assert.throws(() => r.defineRole({ name: 'x', label: 'X', includes: ['x'] }), /not defined|include itself/);
  assert.throws(() => r.defineRole({ name: 'y', label: 'Y', includes: ['nope'] }), /nope, which is not defined/);
  assert.throws(() => r.defineRole({ name: 'Bad Name', label: 'x' }), /not a valid role name/);
});

test('groups pass roles down the tree, and membership of a sub-group counts for its parents', () => {
  const r = seeded();
  const u = r.createUser({ username: 'bo', groups: ['/eng/platform'], attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.effectiveGroups(u.id), ['/eng', '/eng/platform']);
  assert.deepEqual(r.effectiveRoles(u.id), ['editor', 'member']);
});

test('attributes: groups pass them down, deeper groups override, the user overrides all', () => {
  const r = seeded();
  const u = r.createUser({ username: 'bo', groups: ['/eng/platform'], attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.effectiveAttrs(u.id)['region'], ['us']);
  r.setAttrs(u.id, { region: ['apac'] });
  assert.deepEqual(r.effectiveAttrs(u.id)['region'], ['apac']);
  const e = r.createUser({ username: 'cy', groups: ['/eng'], attrs: { dept: ['OPS'] } });
  assert.deepEqual(r.effectiveAttrs(e.id)['region'], ['emea']);
});

test('user attributes are checked: declared, required, patterned, single-valued, bounded, safe names', () => {
  const r = seeded();
  assert.throws(() => r.createUser({ username: 'a' }), /missing required attributes: dept/);
  assert.throws(() => r.createUser({ username: 'a', attrs: { dept: ['eng'] } }), /does not match its pattern/);
  assert.throws(() => r.createUser({ username: 'a', attrs: { dept: ['ENG', 'OPS'] } }), /takes one value/);
  assert.throws(() => r.createUser({ username: 'a', attrs: { dept: ['ENG'], shoe: ['9'] } }), /shoe is not declared/);
  assert.throws(() => r.createUser({ username: 'a', attrs: { dept: ['ENG'], phone: ['1'.repeat(21)] } }), /longer than 20/);
  assert.throws(() => r.createUser({ username: 'a', attrs: { dept: ['ENG'], ['__proto__']: ['x'] } }), /not allowed/);
  assert.equal(r.userCount(), 0);
});

test('a user may edit only the attributes the realm lets them', () => {
  const r = seeded();
  const u = r.createUser({ username: 'ana', attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.setAttrs(u.id, { phone: ['555'] }, 'user').attrs['phone'], ['555']);
  assert.throws(() => r.setAttrs(u.id, { dept: ['OPS'] }, 'user'), /only be changed by an administrator/);
  assert.deepEqual(r.setAttrs(u.id, { dept: ['OPS'] }, 'admin').attrs['dept'], ['OPS']);
  assert.deepEqual(r.setAttrs(u.id, { dept: ['OPS'] }, 'user').attrs['dept'], ['OPS'], 'an unchanged value is not an edit');
  assert.throws(() => r.setAttrs(u.id, { dept: [] }), /missing required/);
});

test('usernames and emails are unique within a realm, case-insensitively, and the same name can exist in another realm', () => {
  const rs = new Realms();
  const mk = (name: string) => rs.create({ name, policy, now: () => clock.t, newId: () => `${name}-${++n}` });
  const a = mk('acme');
  const b = mk('beta');
  a.createUser({ username: 'Ana', email: 'Ana@acme.test' });
  assert.throws(() => a.createUser({ username: 'ANA' }), /taken/);
  assert.throws(() => a.createUser({ username: 'other', email: 'ana@ACME.test' }), /already used/);
  assert.ok(b.createUser({ username: 'ana' }));
  assert.deepEqual(rs.names(), ['acme', 'beta']);
  assert.throws(() => mk('acme'), /already exists/);
  assert.throws(() => rs.get('zeta'), /no realm zeta/);
});

test('realms are closed: a user id from one realm does not resolve in another', () => {
  const rs = new Realms();
  const a = rs.create({ name: 'acme', policy, now: () => clock.t, newId: () => `a${++n}` });
  const b = rs.create({ name: 'beta', policy, now: () => clock.t, newId: () => `b${++n}` });
  const u = a.createUser({ username: 'ana' });
  assert.throws(() => b.user(u.id), /no user .* in realm beta/);
  assert.throws(() => b.join(u.id, '/x'), RealmRefused);
  assert.equal(a.subject(u.id).id, `acme:${u.id}`);
});

test('group paths are validated, parents must exist, and removing needs cascade when there are children', () => {
  const r = seeded();
  assert.throws(() => r.addGroup('eng2'), /not a group path/);
  assert.throws(() => r.addGroup('/a/../b'), /not a group path/);
  assert.throws(() => r.addGroup('/ops/team'), /does not exist yet/);
  assert.throws(() => r.addGroup('/eng'), /already exists/);
  assert.throws(() => r.removeGroup('/eng'), /has sub-groups: \/eng\/platform/);
  const u = r.createUser({ username: 'bo', groups: ['/eng/platform'], attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.removeGroup('/eng', { cascade: true }), ['/eng', '/eng/platform']);
  assert.deepEqual(r.user(u.id).groups, []);
  assert.deepEqual(r.groupPaths(), []);
});

test('moving a group moves its sub-groups and its members with it, and refuses loops and clashes', () => {
  const r = seeded();
  r.addGroup('/ops');
  const u = r.createUser({ username: 'bo', groups: ['/eng/platform'], attrs: { dept: ['ENG'] } });
  r.moveGroup('/eng', '/ops');
  assert.deepEqual(r.groupPaths(), ['/ops', '/ops/eng', '/ops/eng/platform']);
  assert.deepEqual(r.user(u.id).groups, ['/ops/eng/platform']);
  assert.deepEqual(r.effectiveRoles(u.id), ['editor', 'member']);
  assert.throws(() => r.moveGroup('/ops', '/ops/eng'), /into itself/);
  r.addGroup('/eng');
  assert.throws(() => r.moveGroup('/ops/eng', undefined), /already exists/);
});

test('password policy lists everything missing; a username inside the password is refused', () => {
  const r = seeded();
  const u = r.createUser({ username: 'ana', email: 'ana.k@acme.test', attrs: { dept: ['ENG'] } });
  assert.deepEqual(r.passwordProblems('short', u.id), ['at least 10 characters', 'an upper-case letter', 'a digit']);
  assert.deepEqual(r.passwordProblems('Xana-passw0rd!', u.id), ['not to contain the username']);
  assert.deepEqual(r.passwordProblems('Correct-horse-9'), []);
  assert.deepEqual(checkPassword({ minLength: 3, requireSymbol: true, requireLower: true, notEmail: true }, 'ABC', { email: 'abc@x.test' }), ['a lower-case letter', 'a symbol', 'not to contain the email address']);
  assert.deepEqual(checkPassword({ minLength: 4 }, '😀😀😀'), ['at least 4 characters'], 'length counts characters, not code units');
});

test('self-registration follows the realm policy: allowed at all, and email domain allow list', () => {
  const r = seeded();
  assert.throws(() => r.createUser({ username: 'x', email: 'x@evil.test', selfRegistered: true, attrs: { dept: ['ENG'] } }), /needs an email in: acme.test/);
  assert.ok(r.createUser({ username: 'x', email: 'x@acme.test', selfRegistered: true, attrs: { dept: ['ENG'] } }));
  const closed = make('closed', { ...policy, registrationAllowed: false });
  assert.throws(() => closed.createUser({ username: 'y', selfRegistered: true, attrs: { dept: ['ENG'] } }), /does not allow self-registration/);
  assert.throws(() => r.createUser({ username: 'z', email: 'not-an-email', attrs: { dept: ['ENG'] } }), /not valid/);
});

test('lockout after repeated failures, ending on its own, cleared by a success', () => {
  const r = seeded();
  const u = r.createUser({ username: 'ana', attrs: { dept: ['ENG'] } });
  assert.deepEqual([r.recordFailure(u.id), r.recordFailure(u.id), r.recordFailure(u.id)], [false, false, true]);
  assert.equal(r.isLocked(u.id), true);
  clock.t += 59_999;
  assert.equal(r.isLocked(u.id), true);
  clock.t += 1;
  assert.equal(r.isLocked(u.id), false);
  assert.equal(r.recordFailure(u.id), false, 'the count starts again after the lock ends');
  r.recordSuccess(u.id);
  assert.deepEqual([r.recordFailure(u.id), r.recordFailure(u.id)], [false, false]);
});

test('a disabled user holds no roles', () => {
  const r = seeded();
  const u = r.createUser({ username: 'ana', roles: ['admin'], attrs: { dept: ['ENG'] } });
  r.setEnabled(u.id, false);
  assert.deepEqual(r.effectiveRoles(u.id), []);
  r.setEnabled(u.id, true);
  r.revoke(u.id, 'admin');
  assert.deepEqual(r.effectiveRoles(u.id), ['member']);
  r.grant(u.id, 'editor');
  assert.deepEqual(r.effectiveRoles(u.id), ['editor', 'member']);
  assert.throws(() => r.grant(u.id, 'ghost'), /ghost is not defined/);
});

test('the realm hands rbac a subject, and rbac decides with the realm roles, group attributes and composition', () => {
  const r = seeded();
  const u = r.createUser({ username: 'bo', groups: ['/eng/platform'], attrs: { dept: ['ENG'] } });
  const p = r.rolePolicy([{ role: 'editor', actions: ['edit'], kind: 'page', when: [{ field: 'region', equalsSubject: 'region' }] }, { role: 'member', actions: ['read'], kind: 'page' }]);
  const s = r.subject(u.id);
  assert.deepEqual(s.attrs?.['groups'], ['/eng', '/eng/platform']);
  assert.equal(s.attrs?.['region'], 'us');
  assert.equal(decide(p, s, 'read', 'page').allowed, true);
  assert.equal(decide(p, s, 'edit', 'page', { region: 'us' }).allowed, true);
  assert.equal(decide(p, s, 'edit', 'page', { region: 'emea' }).allowed, false);
  const plain = r.createUser({ username: 'cy', attrs: { dept: ['OPS'] } });
  assert.equal(decide(p, r.subject(plain.id), 'edit', 'page', { region: 'us' }).allowed, false);
});

test('realm names, usernames and the export are well-formed', () => {
  assert.throws(() => make('Bad Realm'), /lower-case letters/);
  const r = seeded();
  assert.throws(() => r.createUser({ username: 'has space', attrs: { dept: ['ENG'] } }), /no spaces/);
  const u = r.createUser({ username: 'ana', attrs: { dept: ['ENG'] } });
  const x = r.export();
  assert.equal(x.name, 'acme');
  assert.deepEqual(x.groups.map((g) => g.path), ['/eng', '/eng/platform']);
  assert.deepEqual(x.users.map((v) => v.id), [u.id]);
  assert.deepEqual(r.findByUsername('ANA')?.id, u.id);
});
