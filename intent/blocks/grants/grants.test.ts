import assert from 'node:assert/strict';
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
