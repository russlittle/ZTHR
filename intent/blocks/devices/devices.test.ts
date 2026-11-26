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
