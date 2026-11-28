import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Devices, FlowGone, NotSignedIn, memoryDevices } from './index.ts';

const setup = () => {
  let t = 0;
  const store = memoryDevices();
  return { d: new Devices(store, { now: () => t, flowMs: 1000, touchMs: 100 }), store, tick: (ms: number) => (t += ms) };
};

test('an app password signs in only its own user, and is kept only as a hash', async () => {
  const { d, store } = setup();
  const { password } = await d.issue('ana', 'Ana laptop');
  assert.ok(password.length >= 64);
  assert.equal((await d.verify('ana', password)).name, 'Ana laptop');
  await assert.rejects(d.verify('ben', password), NotSignedIn);
  await assert.rejects(d.verify('ana', `${password}x`), NotSignedIn);
  assert.ok(!JSON.stringify(await store.all()).includes(password));
});

test('revoking one device leaves the others signed in', async () => {
  const { d } = setup();
  const a = await d.issue('ana', 'laptop');
  const b = await d.issue('ana', 'phone');
  await d.revoke('ana', a.device.id);
  await assert.rejects(d.verify('ana', a.password), NotSignedIn);
  assert.ok(await d.verify('ana', b.password));
  await d.revoke('ben', b.device.id);
  assert.ok(await d.verify('ana', b.password), 'nobody revokes another person’s device');
});

test('a device marked for wipe cannot sign in, is told to erase itself, and goes when it reports back', async () => {
  const { d } = setup();
  const a = await d.issue('ana', 'lost phone');
  assert.equal(await d.mustWipe(a.password), false);
  await d.markWipe('ana', a.device.id);
  await assert.rejects(d.verify('ana', a.password), NotSignedIn);
  assert.equal(await d.mustWipe(a.password), true);
  assert.equal(await d.wiped(a.password), true);
  assert.equal((await d.list('ana')).length, 0);
});

test('the login flow hands the password over once, to the poller, after the person approves', async () => {
  const { d } = setup();
  const f = await d.startFlow('Nextcloud desktop on mac');
  assert.equal(await d.poll(f.poll), null);
  await assert.rejects(d.approve(f.poll, 'ana'), FlowGone, 'the poll token cannot approve');
  await d.approve(f.login, 'ana');
  const got = await d.poll(f.poll);
  assert.equal(got?.user, 'ana');
  assert.ok(await d.verify('ana', got!.password));
  await assert.rejects(d.poll(f.poll), FlowGone, 'a second poll gets nothing');
  assert.equal((await d.list('ana'))[0]?.name, 'Nextcloud desktop on mac');
});

test('a flow nobody finishes expires', async () => {
  const { d, tick } = setup();
  const f = await d.startFlow('x');
  tick(1001);
  await assert.rejects(d.approve(f.login, 'ana'), FlowGone);
  await assert.rejects(d.poll(f.poll), FlowGone);
});

test('last used is written at most once per interval', async () => {
  const { d, tick } = setup();
  const a = await d.issue('ana', 'x');
  tick(50);
  assert.equal((await d.verify('ana', a.password)).lastUsed, 0);
  tick(100);
  assert.equal((await d.verify('ana', a.password)).lastUsed, 150);
});

test('each device signs in with its own password and ids count up from one', async () => {
  const { d } = setup();
  const a = await d.issue('ana', 'laptop');
  const b = await d.issue('ana', 'phone');
  const c = await d.issue('ana', 'tablet');
  assert.deepEqual([a.device.id, b.device.id, c.device.id], [1, 2, 3]);
  assert.equal((await d.verify('ana', b.password)).id, 2);
  assert.equal((await d.verify('ana', c.password)).id, 3);
  assert.equal((await d.verify('ana', a.password)).id, 1);
});

test('a store that answers with the wrong device cannot sign anyone in', async () => {
  const real = memoryDevices();
  const d = new Devices({ ...real, byHash: async () => (await real.all())[0] });
  const a = await d.issue('ana', 'laptop');
  const b = await d.issue('ana', 'phone');
  await assert.rejects(d.verify('ana', b.password), NotSignedIn);
  assert.equal((await d.verify('ana', a.password)).id, 1);
  const short = new Devices({ ...real, byHash: async () => ({ ...(await real.all())[0]!, hash: 'abc' }) });
  await assert.rejects(short.verify('ana', a.password), NotSignedIn);
  const flipped = new Devices({ ...real, byHash: async () => ({ ...(await real.all())[0]!, hash: '0'.repeat(64) }) });
  await assert.rejects(flipped.verify('ana', a.password), NotSignedIn);
});

test('the refusals say what happened', async () => {
  const { d } = setup();
  await assert.rejects(d.verify('ana', 'nope'), { message: 'that name and app password do not sign in' });
  await assert.rejects(d.poll('nope'), { message: 'that sign-in is finished, expired, or never started' });
});

test('device and app names are cut to 120 characters, and an empty one is called "unnamed device"', async () => {
  const { d } = setup();
  assert.equal((await d.issue('ana', 'n'.repeat(200))).device.name, 'n'.repeat(120));
  assert.equal((await d.issue('ana', 'n'.repeat(120))).device.name, 'n'.repeat(120));
  assert.equal((await d.issue('ana', '')).device.name, 'unnamed device');
  assert.equal((await d.startFlow('c'.repeat(200))).client, 'c'.repeat(120));
  assert.equal((await d.startFlow('')).client, 'unnamed device');
  const f = await d.startFlow('');
  await d.approve(f.login, 'ana');
  assert.equal((await d.list('ana')).at(-1)?.name, 'unnamed device');
});

test('by default a sign-in flow lasts twenty minutes', async () => {
  let t = 1_000_000;
  const d = new Devices(memoryDevices(), { now: () => t });
  const f = await d.startFlow('x');
  t += 19 * 60_000;
  assert.equal(await d.poll(f.poll), null);
  t += 60_000;
  assert.equal(await d.poll(f.poll), null, 'exactly twenty minutes is still alive');
  t += 1;
  await assert.rejects(d.poll(f.poll), FlowGone);
});

test('a flow is alive up to and including its limit, measured from when it started', async () => {
  const { d, tick } = setup();
  tick(500);
  const f = await d.startFlow('x');
  tick(100);
  assert.equal(await d.poll(f.poll), null);
  tick(900);
  assert.equal(await d.poll(f.poll), null, 'exactly the limit is still alive');
  tick(1);
  await assert.rejects(d.poll(f.poll), FlowGone);
});

test('the login token cannot be used to poll', async () => {
  const { d } = setup();
  const f = await d.startFlow('x');
  await assert.rejects(d.poll(f.login), FlowGone);
  await d.approve(f.login, 'ana');
  await assert.rejects(d.poll(f.login), FlowGone);
  assert.equal((await d.poll(f.poll))?.user, 'ana');
});

test('last used is written only once more than the interval has passed, counted from the last write', async () => {
  const { d, tick } = setup();
  const a = await d.issue('ana', 'x');
  tick(100);
  assert.equal((await d.verify('ana', a.password)).lastUsed, 0, 'exactly the interval is not enough');
  tick(1);
  assert.equal((await d.verify('ana', a.password)).lastUsed, 101);
  tick(10);
  assert.equal((await d.verify('ana', a.password)).lastUsed, 101, 'a recent write is not repeated');
  assert.equal((await d.list('ana'))[0]?.lastUsed, 101);
});

test('a person lists only their own devices, oldest first, whatever order the store gives them', async () => {
  const real = memoryDevices();
  const d = new Devices({ ...real, all: async () => (await real.all()).reverse() });
  await d.issue('ana', 'one');
  await d.issue('ben', 'other');
  await d.issue('ana', 'two');
  await d.issue('ana', 'three');
  await d.issue('ben', 'another');
  assert.deepEqual((await d.list('ana')).map((x) => x.name), ['one', 'two', 'three']);
  assert.deepEqual((await d.list('ben')).map((x) => x.name), ['other', 'another']);
  assert.deepEqual(await d.list('cy'), []);
});

test('revoking removes exactly the named device of the named person, and an unknown one does nothing', async () => {
  const { d, store } = setup();
  const a = await d.issue('ana', 'laptop');
  const b = await d.issue('ana', 'phone');
  const c = await d.issue('ben', 'tablet');
  await d.revoke('ana', 99);
  await d.revoke('ben', b.device.id);
  assert.equal((await store.all()).length, 3);
  await d.revoke('ana', b.device.id);
  assert.deepEqual((await d.list('ana')).map((x) => x.id), [a.device.id]);
  assert.ok(await d.verify('ben', c.password));
  assert.ok(await d.verify('ana', a.password));
  await assert.rejects(d.verify('ana', b.password), NotSignedIn);
});

test('marking for wipe touches exactly the named device of the named person, and an unknown one adds nothing', async () => {
  const { d, store } = setup();
  const a = await d.issue('ana', 'laptop');
  const b = await d.issue('ana', 'phone');
  const c = await d.issue('ben', 'tablet');
  await d.markWipe('ana', 99);
  assert.equal((await store.all()).length, 3);
  await d.markWipe('ben', b.device.id);
  assert.equal(await d.mustWipe(a.password), false);
  assert.equal(await d.mustWipe(b.password), false);
  assert.equal(await d.mustWipe(c.password), false);
  await d.markWipe('ana', b.device.id);
  assert.equal(await d.mustWipe(a.password), false);
  assert.equal(await d.mustWipe(b.password), true);
  assert.equal(await d.mustWipe(c.password), false);
  assert.ok(await d.verify('ana', a.password));
  assert.ok(await d.verify('ben', c.password));
  assert.equal((await store.all()).length, 3);
});

test('an unknown password is not told to wipe, and reporting a wipe that was never asked for removes nothing', async () => {
  const { d, store } = setup();
  const a = await d.issue('ana', 'laptop');
  assert.equal(await d.mustWipe('not a password'), false);
  assert.equal(await d.wiped('not a password'), false);
  assert.equal(await d.wiped(a.password), false);
  assert.equal((await store.all()).length, 1);
  assert.ok(await d.verify('ana', a.password));
});
