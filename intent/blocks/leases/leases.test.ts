import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Held, Leases, NoLease, memoryLeases } from './index.ts';

const setup = () => {
  let t = 0;
  return { l: new Leases(memoryLeases(), { now: () => t, maxMs: 1000 }), tick: (ms: number) => (t += ms) };
};

test('one holder at a time; the holder may change it, others are told who holds it', async () => {
  const { l } = setup();
  const a = await l.acquire('/ana/x.txt', 'ana', { holder: 'Ana (desktop)' });
  await assert.rejects(l.acquire('ana/x.txt', 'ben'), (e: Held) => e instanceof Held && e.by.holder === 'Ana (desktop)');
  await l.mayChange('/ana/x.txt', { owner: 'ben', tokens: [a.token] });
  await assert.rejects(l.mayChange('/ana/x.txt', { owner: 'ben' }), Held);
  await l.mayChange('/ana/x.txt', { owner: 'ana', ownerMay: true });
});

test('a lease ends on its own, so a crashed holder never locks anyone out for good', async () => {
  const { l, tick } = setup();
  await l.acquire('/x', 'ana', { ms: 100 });
  tick(101);
  assert.equal(await l.heldOn('/x'), undefined);
  await l.acquire('/x', 'ben');
});

test('an ask for longer than the limit is cut to the limit; refresh extends it', async () => {
  const { l, tick } = setup();
  const a = await l.acquire('/x', 'ana', { ms: 10_000_000 });
  assert.equal(a.until, 1000);
  tick(900);
  const r = await l.refresh(a.token);
  assert.equal(r.until, 1900);
  tick(1001);
  await assert.rejects(l.refresh(a.token), NoLease);
});

test('a deep lease on a folder covers everything below it, and blocks deep leases above it', async () => {
  const { l } = setup();
  await l.acquire('/a/b', 'ana', { deep: true });
  await assert.rejects(l.acquire('/a/b/c', 'ben'), Held);
  await assert.rejects(l.acquire('/a', 'ben', { deep: true }), Held, 'a deep lease above would cover what Ana holds');
  await l.acquire('/a', 'ben');
  await l.acquire('/a/bc', 'ben', { deep: true });
});

test('only the owner releases; a rename moves the hold with the resource', async () => {
  const { l } = setup();
  const a = await l.acquire('/a/x', 'ana');
  await assert.rejects(l.release(a.token, 'ben'), Held);
  await l.rename('/a', '/b');
  assert.equal((await l.heldOn('/b/x'))?.token, a.token);
  assert.equal(await l.heldOn('/a/x'), undefined);
  await l.release(a.token, 'ana');
  await l.release(a.token, 'ana');
  assert.equal(await l.heldOn('/b/x'), undefined);
});

test('two asks at the same moment: exactly one wins', async () => {
  const { l } = setup();
  const r = await Promise.allSettled([l.acquire('/x', 'ana'), l.acquire('/x', 'ben'), l.acquire('/x', 'cy')]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
});
