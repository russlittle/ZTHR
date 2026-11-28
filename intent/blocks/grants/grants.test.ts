import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { ALL, CREATE, DELETE, FILE_MAX, Grants, READ, Refused, SHARE, Throttled, UPDATE, checkPassword, hashPassword, linkToken, memoryGrants } from './index.ts';

const setup = (o = {}) => {
  let t = 1000;
  return { g: new Grants(memoryGrants(), { now: () => t, attempts: 3, windowMs: 100, ...o }), tick: (ms: number) => (t += ms) };
};
const folder = { resource: 10, resourceKind: 'folder' as const, by: 'ana', giverHas: ALL };

test('a grant can never give more than the giver has, and needs share permission to exist', async () => {
  const { g } = setup();
  await assert.rejects(g.create({ ...folder, giverHas: READ | UPDATE, kind: 'person', to: 'ben', permissions: READ | DELETE }), Refused);
  await assert.rejects(g.create({ ...folder, giverHas: READ, kind: 'person', to: 'ben', permissions: READ }), Refused);
  const ok = await g.create({ ...folder, giverHas: READ | SHARE, kind: 'person', to: 'ben', permissions: READ });
  assert.equal(ok.permissions, READ);
});

test('a file grant is cut to what a file can have', async () => {
  const { g } = setup();
  const x = await g.create({ ...folder, resourceKind: 'file', kind: 'person', to: 'ben', permissions: READ | UPDATE | CREATE | SHARE });
  assert.equal(x.permissions, (READ | UPDATE | SHARE) & FILE_MAX);
});

test('what a person may do is the union of grants on the resource and above it, for them and their groups', async () => {
  const { g } = setup();
  await g.create({ ...folder, resource: 1, kind: 'person', to: 'ben', permissions: READ });
  await g.create({ ...folder, resource: 2, kind: 'group', to: 'team', permissions: READ | CREATE });
  await g.create({ ...folder, resource: 3, kind: 'person', to: 'cy', permissions: ALL });
  const chain = [
    { id: 3, kind: 'folder' as const },
    { id: 2, kind: 'folder' as const },
    { id: 1, kind: 'folder' as const },
  ];
  assert.equal(await g.effective('ben', ['team'], chain), READ | CREATE);
  assert.equal(await g.effective('ben', [], chain), READ);
  assert.equal(await g.effective('dee', [], chain), 0);
});

test('a link with a password opens only with it, and wrong guesses are throttled per link', async () => {
  const { g, tick } = setup();
  const l = await g.create({ ...folder, kind: 'link', password: 'correct horse' });
  assert.match(l.token!, /^[a-zA-Z0-9]{15}$/);
  assert.ok(!JSON.stringify(l).includes('correct horse'), 'the password is never stored');
  await assert.rejects(g.open(l.token!), Refused);
  await assert.rejects(g.open(l.token!, 'nope'), Refused);
  await assert.rejects(g.open(l.token!, 'nope'), Refused);
  await assert.rejects(g.open(l.token!, 'correct horse'), Throttled, 'even the right password waits once the window is full');
  tick(101);
  assert.equal((await g.open(l.token!, 'correct horse')).id, l.id);
});

test('an expired link stops working at once, and the sweep removes it', async () => {
  const { g, tick } = setup();
  const l = await g.create({ ...folder, kind: 'link', expires: 2000 });
  assert.ok(await g.open(l.token!));
  tick(1000);
  await assert.rejects(g.open(l.token!), Refused);
  assert.equal(await g.sweep(async () => true), 1);
  await assert.rejects(g.create({ ...folder, kind: 'link', expires: 10 }), Refused, 'an expiry in the past is refused');
});

test('the deployment can require link passwords, with a minimum length', async () => {
  const { g } = setup({ requireLinkPassword: true, minPasswordLength: 10 });
  await assert.rejects(g.create({ ...folder, kind: 'link' }), Refused);
  await assert.rejects(g.create({ ...folder, kind: 'link', password: 'short' }), Refused);
  const l = await g.create({ ...folder, kind: 'link', password: 'long enough pw' });
  await assert.rejects(g.update(l.id, 'ana', ALL, { password: null }), Refused);
});

test('only the giver changes or revokes a grant; a grant on a removed resource is swept', async () => {
  const { g } = setup();
  const x = await g.create({ ...folder, kind: 'person', to: 'ben' });
  await assert.rejects(g.revoke(x.id, 'ben'), Refused);
  const u = await g.update(x.id, 'ana', ALL, { permissions: READ, note: 'for the trip' });
  assert.equal(u.permissions, READ);
  assert.equal(u.note, 'for the trip');
  assert.equal(await g.sweep(async () => false), 1);
});

test('passwords hash with a salt, so the same password hashes differently and still checks', async () => {
  const a = await hashPassword('pw-12345');
  const b = await hashPassword('pw-12345');
  assert.notEqual(a, b);
  assert.ok(await checkPassword('pw-12345', a));
  assert.ok(!(await checkPassword('pw-12346', a)));
  assert.notEqual(linkToken(), linkToken());
});

test('given the owner, effective() caps each reshare by what its giver still has, so lowering or revoking cuts it', async () => {
  const { g } = setup();
  // Ana owns folder 1 with file 2 in it; she shares the folder with Ben, who reshares it with Cy.
  const chain = [
    { id: 2, kind: 'file' as const },
    { id: 1, kind: 'folder' as const },
  ];
  const groups: Record<string, string[]> = { ana: [], ben: [], cy: [] };
  const o = { owner: 'ana', groupsOf: async (p: string) => groups[p] };
  const toBen = await g.create({ ...folder, resource: 1, kind: 'person', to: 'ben', permissions: ALL });
  await g.create({ ...folder, resource: 1, by: 'ben', giverHas: ALL, kind: 'person', to: 'cy', permissions: ALL });
  assert.equal(await g.effective('cy', [], chain.slice(1), o), ALL);
  assert.equal(await g.effective('cy', [], chain, o), ALL & ~CREATE, 'a file inside a shared folder may be deleted, not created in');
  await g.update(toBen.id, 'ana', ALL, { permissions: READ | SHARE });
  assert.equal(await g.effective('cy', [], chain.slice(1), o), READ | SHARE, 'Ben has only read and share now, so Cy too');
  assert.equal(await g.effective('ana', [], chain, o), ALL, 'the owner may do everything');
  delete groups['ben'];
  assert.equal(await g.effective('cy', [], chain.slice(1), o), 0, 'a giver who is gone gives nothing');
  groups['ben'] = [];
  await g.revoke(toBen.id, 'ana');
  assert.equal(await g.effective('cy', [], chain.slice(1), o), 0, 'revoking Ben’s share ends Cy’s');
  await g.create({ ...folder, resource: 2, resourceKind: 'file', kind: 'person', to: 'cy', permissions: READ | UPDATE });
  assert.equal(await g.effective('cy', [], chain, o), READ | UPDATE, 'a file shared by itself');
});

const refusedWith = (p: Promise<unknown>, why: string) => assert.rejects(p, (e: unknown) => e instanceof Refused && e.why === why);
const chainOf = (...c: [number, 'file' | 'folder'][]) => c.map(([id, kind]) => ({ id, kind }));

test('the memory store hands out ascending ids, and keeps, replaces and forgets grants', async () => {
  const s = memoryGrants();
  assert.equal(await s.nextId(), 1);
  assert.equal(await s.nextId(), 2);
  const mk = (id: number) => ({ id, resource: 1, resourceKind: 'folder' as const, by: 'a', kind: 'person' as const, to: 'b', permissions: READ, created: 0 });
  await s.set(mk(1));
  await s.set(mk(2));
  assert.equal((await s.all()).length, 2);
  await s.delete(1);
  assert.deepEqual((await s.all()).map((x) => x.id), [2]);
  assert.equal(await s.get(1), undefined);
  assert.equal((await s.get(2))!.id, 2);
  const { g } = setup();
  assert.equal((await g.create({ ...folder, kind: 'person', to: 'ben' })).id, 1);
  assert.equal((await g.create({ ...folder, kind: 'person', to: 'cy' })).id, 2);
});

test('a throttled link says in words how long to wait', () => {
  const e = new Throttled(1500);
  assert.equal(e.message, 'too many wrong passwords; try again in 2 s');
  assert.equal(e.retryAfterMs, 1500);
  assert.equal(new Throttled(60_000).message, 'too many wrong passwords; try again in 60 s');
});

test('a stored password that is not a well-formed scrypt hash never checks', async () => {
  const good = await hashPassword('pw-12345');
  const [, salt, h] = good.split('$');
  assert.ok(await checkPassword('pw-12345', good));
  assert.equal(await checkPassword('pw-12345', `bcrypt$${salt}$${h}`), false, 'another algorithm');
  assert.equal(await checkPassword('pw-12345', `$${salt}$${h}`), false, 'no algorithm');
  assert.equal(await checkPassword('pw-12345', 'scrypt'), false, 'nothing after the algorithm');
  assert.equal(await checkPassword('pw-12345', `scrypt$${salt}$`), false, 'no hash');
  assert.equal(await checkPassword('pw-12345', ''), false);
  const noSalt = scryptSync('pw-12345', Buffer.alloc(0), 32).toString('base64');
  assert.equal(await checkPassword('pw-12345', `scrypt$$${noSalt}`), false, 'no salt, even though the hash matches an empty one');
});

test('a grant is refused, with the reason, when it has no read, unknown bits, more than the giver has, or no share right', async () => {
  const { g } = setup();
  const p = { ...folder, kind: 'person' as const, to: 'ben' };
  await refusedWith(g.create({ ...p, permissions: UPDATE }), 'a grant must at least allow reading');
  await refusedWith(g.create({ ...p, permissions: READ | 64 }), 'unknown permission bits');
  await refusedWith(g.create({ ...p, giverHas: READ | SHARE, permissions: READ | UPDATE }), 'a grant cannot give more than the giver has');
  await refusedWith(g.create({ ...p, giverHas: READ | UPDATE }), 'the giver may not share this');
  const x = await g.create({ ...p, permissions: READ });
  await refusedWith(g.update(x.id, 'ana', READ | SHARE, { permissions: READ | DELETE }), 'a grant cannot give more than the giver has');
  await refusedWith(g.update(x.id, 'ana', ALL, { permissions: UPDATE }), 'a grant must at least allow reading');
  await refusedWith(g.update(x.id, 'ana', ALL, { permissions: READ | 64 }), 'unknown permission bits');
});

test('a grant to a person or group must name them, and a person cannot share with themselves', async () => {
  const { g } = setup();
  await refusedWith(g.create({ ...folder, kind: 'person' }), 'a grant to a person or group names them');
  await refusedWith(g.create({ ...folder, kind: 'group', to: '' }), 'a grant to a person or group names them');
  await refusedWith(g.create({ ...folder, kind: 'person', to: 'ana' }), 'a person cannot share with themselves');
  const toGroup = await g.create({ ...folder, kind: 'group', to: 'ana' });
  assert.equal(toGroup.to, 'ana', 'a group may share a name with a person');
  const link = await g.create({ ...folder, kind: 'link' });
  assert.equal('to' in link, false, 'a link names no one');
});

test('what a grant gets when permissions are not named depends on what it is and what it is on', async () => {
  const { g } = setup();
  assert.equal((await g.create({ ...folder, kind: 'person', to: 'ben' })).permissions, ALL);
  assert.equal((await g.create({ ...folder, kind: 'group', to: 'team' })).permissions, ALL);
  assert.equal((await g.create({ ...folder, kind: 'link' })).permissions, READ);
  assert.equal((await g.create({ ...folder, resourceKind: 'file', kind: 'link' })).permissions, READ);
  assert.equal((await g.create({ ...folder, resourceKind: 'file', kind: 'person', to: 'ben' })).permissions, FILE_MAX);
  const limited = await g.create({ ...folder, resourceKind: 'file', giverHas: FILE_MAX, kind: 'person', to: 'ben' });
  assert.equal(limited.permissions, FILE_MAX, 'a giver with all a file can have gives all a file can have');
});

test('an expiry must be in the future; a grant keeps only the fields it was given', async () => {
  const { g } = setup();
  await refusedWith(g.create({ ...folder, kind: 'link', expires: 1000 }), 'the expiry is in the past');
  await refusedWith(g.create({ ...folder, kind: 'link', expires: 999 }), 'the expiry is in the past');
  const ok = await g.create({ ...folder, kind: 'link', expires: 1001, note: 'for the trip', label: 'trip' });
  assert.equal(ok.expires, 1001);
  assert.equal(ok.note, 'for the trip');
  assert.equal(ok.label, 'trip');
  assert.equal(ok.created, 1000);
  const bare = await g.create({ ...folder, kind: 'person', to: 'ben' });
  for (const k of ['expires', 'note', 'label', 'token', 'passwordHash']) assert.equal(k in bare, false, `a person grant has no ${k}`);
  const plainLink = await g.create({ ...folder, kind: 'link' });
  assert.equal('token' in plainLink, true);
  for (const k of ['expires', 'note', 'label', 'passwordHash']) assert.equal(k in plainLink, false, `a link with none given has no ${k}`);
});

test('link passwords: none or empty means none, a short one is refused with the minimum, only links take one', async () => {
  const { g } = setup();
  const empty = await g.create({ ...folder, kind: 'link', password: '' });
  assert.equal('passwordHash' in empty, false);
  await refusedWith(g.create({ ...folder, kind: 'link', password: '1234567' }), 'a link password needs at least 8 characters');
  const exact = await g.create({ ...folder, kind: 'link', password: '12345678' });
  assert.ok(exact.passwordHash);
  const { g: g10 } = setup({ minPasswordLength: 10 });
  await refusedWith(g10.create({ ...folder, kind: 'link', password: '123456789' }), 'a link password needs at least 10 characters');
  assert.ok((await g10.create({ ...folder, kind: 'link', password: '1234567890' })).passwordHash);
  const { g: req } = setup({ requireLinkPassword: true });
  await refusedWith(req.create({ ...folder, kind: 'link' }), 'a link needs a password here');
  await refusedWith(req.create({ ...folder, kind: 'link', password: '' }), 'a link needs a password here');
  const person = await req.create({ ...folder, kind: 'person', to: 'ben', password: 'x' });
  assert.equal('passwordHash' in person, false, 'a person grant has no password, and needs none');
});

test('updating changes only what is given, and clears what is set to null', async () => {
  const { g } = setup();
  const l = await g.create({ ...folder, kind: 'link', password: 'correct horse', expires: 5000, note: 'n', label: 'L' });
  const noteOnly = await g.update(l.id, 'ana', ALL, { note: 'n2' });
  assert.equal(noteOnly.permissions, READ);
  assert.equal(noteOnly.passwordHash, l.passwordHash);
  assert.equal(noteOnly.expires, 5000);
  assert.equal(noteOnly.label, 'L');
  assert.equal(noteOnly.note, 'n2');
  const labelOnly = await g.update(l.id, 'ana', ALL, { label: 'L2' });
  assert.equal(labelOnly.note, 'n2');
  assert.equal(labelOnly.label, 'L2');
  assert.equal((await g.update(l.id, 'ana', ALL, { permissions: READ | UPDATE })).permissions, READ | UPDATE);
  assert.equal((await g.update(l.id, 'ana', ALL, { expires: 9000 })).expires, 9000);
  const nothing = await g.update(l.id, 'ana', ALL, {});
  assert.equal(nothing.expires, 9000);
  assert.equal(nothing.permissions, READ | UPDATE);
  assert.ok(nothing.passwordHash);
  assert.deepEqual(await g.get(l.id), nothing, 'what is returned is what is stored');
  const noExpiry = await g.update(l.id, 'ana', ALL, { expires: null });
  assert.equal('expires' in noExpiry, false);
  assert.equal('expires' in (await g.get(l.id))!, false);
  const noPassword = await g.update(l.id, 'ana', ALL, { password: null });
  assert.equal('passwordHash' in noPassword, false);
  assert.equal((await g.open(l.token!)).id, l.id, 'with no password it opens for anyone');
  const again = await g.update(l.id, 'ana', ALL, { note: 'n3' });
  assert.equal('passwordHash' in again, false, 'and stays open');
  assert.equal('expires' in again, false);
});

test('a new password replaces the old one, an empty one removes it, and a short one is refused', async () => {
  const { g } = setup();
  const l = await g.create({ ...folder, kind: 'link', password: 'correct horse' });
  const changed = await g.update(l.id, 'ana', ALL, { password: 'brand new pass' });
  assert.notEqual(changed.passwordHash, l.passwordHash);
  await assert.rejects(g.open(l.token!, 'correct horse'), Refused);
  assert.equal((await g.open(l.token!, 'brand new pass')).id, l.id);
  await refusedWith(g.update(l.id, 'ana', ALL, { password: 'short' }), 'a link password needs at least 8 characters');
  const cleared = await g.update(l.id, 'ana', ALL, { password: '' });
  assert.equal('passwordHash' in cleared, false);
});

test('where a password is required, removing it from a link is refused, but a person grant never had one', async () => {
  const { g } = setup({ requireLinkPassword: true });
  const l = await g.create({ ...folder, kind: 'link', password: 'long enough pw' });
  await refusedWith(g.update(l.id, 'ana', ALL, { password: null }), 'a link needs a password here');
  const p = await g.create({ ...folder, kind: 'person', to: 'ben' });
  const u = await g.update(p.id, 'ana', ALL, { password: null });
  assert.equal('passwordHash' in u, false);
  const { g: open } = setup();
  const l2 = await open.create({ ...folder, kind: 'link', password: 'long enough pw' });
  assert.equal('passwordHash' in (await open.update(l2.id, 'ana', ALL, { password: null })), false, 'when not required, a link may be opened up');
});

test('a new expiry must be in the future, and null removes it', async () => {
  const { g } = setup();
  const l = await g.create({ ...folder, kind: 'link', expires: 5000 });
  await refusedWith(g.update(l.id, 'ana', ALL, { expires: 1000 }), 'the expiry is in the past');
  await refusedWith(g.update(l.id, 'ana', ALL, { expires: 500 }), 'the expiry is in the past');
  assert.equal((await g.update(l.id, 'ana', ALL, { expires: 1001 })).expires, 1001);
  assert.equal((await g.get(l.id))!.expires, 1001);
  assert.equal('expires' in (await g.update(l.id, 'ana', ALL, { expires: null })), false);
});

test('only the giver may change or revoke a grant, and a grant that is not there is refused the same way', async () => {
  const { g } = setup();
  const x = await g.create({ ...folder, kind: 'person', to: 'ben' });
  const why = 'no such grant of yours';
  await refusedWith(g.update(x.id, 'ben', ALL, { note: 'mine now' }), why);
  await refusedWith(g.update(999, 'ana', ALL, { note: 'x' }), why);
  await refusedWith(g.revoke(x.id, 'ben'), why);
  await refusedWith(g.revoke(999, 'ana'), why);
  assert.equal((await g.get(x.id))!.note, undefined);
  await g.revoke(x.id, 'ana');
  assert.equal(await g.get(x.id), undefined);
  assert.deepEqual(await g.live(), []);
});

test('live grants are those not expired, in order of id, and can be filtered', async () => {
  const s = memoryGrants();
  const backwards = { ...s, all: async () => (await s.all()).reverse() };
  let t = 1000;
  const g = new Grants(backwards, { now: () => t });
  const a = await g.create({ ...folder, kind: 'person', to: 'ben' });
  const b = await g.create({ ...folder, kind: 'person', to: 'cy', expires: 2000 });
  const c = await g.create({ ...folder, kind: 'group', to: 'team', expires: 3000 });
  const d = await g.create({ ...folder, kind: 'person', to: 'dee', expires: 1500 });
  assert.deepEqual((await g.live()).map((x) => x.id), [a.id, b.id, c.id, d.id]);
  assert.deepEqual((await g.live((x) => x.kind === 'person')).map((x) => x.id), [a.id, b.id, d.id]);
  t = 1500;
  assert.deepEqual((await g.live()).map((x) => x.id), [a.id, b.id, c.id], 'it stops at the very moment of its expiry');
  t = 2000;
  assert.deepEqual((await g.live()).map((x) => x.id), [a.id, c.id]);
  t = 5000;
  assert.deepEqual((await g.live()).map((x) => x.id), [a.id]);
  assert.equal((await s.all()).length, 4, 'expired ones stay in the store for the sweep');
});

test('a single grant is found while it is in force, and not before, after, or when it never was', async () => {
  const { g, tick } = setup();
  const forever = await g.create({ ...folder, kind: 'person', to: 'ben' });
  const timed = await g.create({ ...folder, kind: 'person', to: 'cy', expires: 2000 });
  assert.equal((await g.get(forever.id))!.id, forever.id);
  assert.equal((await g.get(timed.id))!.id, timed.id);
  assert.equal(await g.get(999), undefined);
  tick(999);
  assert.equal((await g.get(timed.id))!.id, timed.id, 'one moment before it expires');
  tick(1);
  assert.equal(await g.get(timed.id), undefined, 'at the moment it expires');
  assert.equal((await g.get(forever.id))!.id, forever.id);
});

test('a token finds its own link and nothing else', async () => {
  const s = memoryGrants();
  const { g } = (() => {
    const g = new Grants(s, { now: () => 1000, attempts: 3, windowMs: 100 });
    return { g };
  })();
  const one = await g.create({ ...folder, kind: 'link' });
  const two = await g.create({ ...folder, kind: 'link' });
  assert.equal((await g.byToken(two.token!))!.id, two.id);
  assert.equal((await g.byToken(one.token!))!.id, one.id);
  assert.equal(await g.byToken('not-a-token'), undefined);
  await s.set({ id: 50, resource: 10, resourceKind: 'folder', by: 'ana', kind: 'person', to: 'ben', permissions: READ, token: 'stray', created: 0 });
  assert.equal(await g.byToken('stray'), undefined, 'only links are opened by token');
  await refusedWith(g.open('stray'), 'no such link, or it expired');
  await refusedWith(g.open('not-a-token'), 'no such link, or it expired');
  assert.equal((await g.open(two.token!)).id, two.id, 'a link with no password opens for anyone');
});

test('wrong passwords say so, and the wait is what is left of the window, ending exactly when the window does', async () => {
  const { g, tick } = setup();
  const l = await g.create({ ...folder, kind: 'link', password: 'correct horse' });
  await refusedWith(g.open(l.token!), 'the password is wrong');
  await refusedWith(g.open(l.token!, 'nope'), 'the password is wrong');
  await refusedWith(g.open(l.token!, 'nope again'), 'the password is wrong');
  tick(30);
  await assert.rejects(g.open(l.token!, 'correct horse'), (e: unknown) => e instanceof Throttled && e.retryAfterMs === 70 && e.message === 'too many wrong passwords; try again in 1 s');
  tick(69);
  await assert.rejects(g.open(l.token!, 'correct horse'), (e: unknown) => e instanceof Throttled && e.retryAfterMs === 1);
  tick(1);
  assert.equal((await g.open(l.token!, 'correct horse')).id, l.id, 'a failure counts for the window and not a moment longer');
  await refusedWith(g.open(l.token!, 'nope'), 'the password is wrong');
  assert.equal((await g.open(l.token!, 'correct horse')).id, l.id, 'a right password clears the count');
});

test('a grant reaches the person it names, or the groups it names, and no one else', async () => {
  const { g } = setup();
  await g.create({ ...folder, kind: 'person', to: 'team', permissions: READ | UPDATE });
  await g.create({ ...folder, kind: 'group', to: 'ben', permissions: READ | CREATE });
  const chain = chainOf([10, 'folder']);
  assert.equal(await g.effective('ben', [], chain), 0, 'a group named like a person is not that person');
  assert.equal(await g.effective('ben', ['team'], chain), 0, 'a person named like a group is not that group');
  assert.equal(await g.effective('team', [], chain), READ | UPDATE);
  assert.equal(await g.effective('cy', ['ben'], chain), READ | CREATE);
  await g.create({ ...folder, kind: 'link', permissions: READ | DELETE });
  assert.equal(await g.effective('cy', [''], chain), 0, 'a link is not counted');
});

test('without the owner, effective() is the plain union, cut to what a file can have when the thing is a file', async () => {
  const { g } = setup();
  await g.create({ ...folder, resource: 1, kind: 'person', to: 'ben', permissions: ALL });
  assert.equal(await g.effective('ben', [], chainOf([2, 'file'], [1, 'folder'])), FILE_MAX);
  assert.equal(await g.effective('ben', [], chainOf([2, 'folder'], [1, 'folder'])), ALL);
  assert.equal(await g.effective('ben', [], []), 0);
});

test('the sweep removes expired grants and grants on gone resources, and nothing else', async () => {
  const { g, tick } = setup();
  const keep = await g.create({ ...folder, resource: 10, kind: 'person', to: 'ben' });
  const later = await g.create({ ...folder, resource: 10, kind: 'person', to: 'cy', expires: 5000 });
  const soon = await g.create({ ...folder, resource: 10, kind: 'person', to: 'dee', expires: 1500 });
  const gone = await g.create({ ...folder, resource: 11, kind: 'person', to: 'eve' });
  assert.equal(await g.sweep(async () => true), 0, 'nothing is expired or gone yet');
  assert.equal((await g.live()).length, 4);
  tick(500);
  assert.equal(await g.sweep(async (r) => r !== 11), 2, 'one expired this very moment, one on a gone resource');
  assert.deepEqual((await g.live()).map((x) => x.id), [keep.id, later.id]);
  assert.equal(await g.get(soon.id), undefined);
  assert.equal(await g.get(gone.id), undefined);
  assert.equal(await g.sweep(async () => true), 0);
});
