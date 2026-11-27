import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache } from './index.ts';

test('a hundred callers at once cause one load; failures are not cached', async () => {
  const c = new Cache<number>({ ttlMs: 1000 });
  let loads = 0;
  const slow = () => new Promise<number>((r) => setTimeout(() => r(++loads), 5));
  const all = await Promise.all(Array.from({ length: 100 }, () => c.get('k', slow)));
  assert.equal(loads, 1);
  assert.ok(all.every((v) => v === 1));
  await assert.rejects(c.get('bad', () => Promise.reject(new Error('down'))), /down/);
  assert.equal(await c.get('bad', async () => 9), 9, 'the next caller tries again');
  assert.equal(c.stats.failures, 1);
});

test('stale values are served while one refresh runs; expiry, tags and size limits drop entries', async () => {
  let t = 0;
  let v = 1;
  const c = new Cache<number>({ ttlMs: 100, staleMs: 100, max: 3, now: () => t });
  const load = async () => v;
  assert.equal(await c.get('a', load, ['user:1']), 1);
  v = 2;
  t = 150;
  assert.equal(await c.get('a', load), 1, 'stale, served at once');
  await new Promise((r) => setImmediate(r));
  assert.equal(await c.get('a', load), 2, 'refreshed behind the scenes');
  t = 1000;
  v = 3;
  assert.equal(await c.get('a', load, ['user:1']), 3, 'past the stale limit it waits for a fresh value');
  await c.get('b', load, ['user:1']);
  assert.equal(c.invalidateTag('user:1'), 2);
  for (const k of ['x', 'y', 'z']) await c.get(k, load);
  await c.get('x', load);
  await c.get('w', load);
  assert.equal(c.size, 3);
  assert.equal(c.stats.loads, 8);
  v = 4;
  assert.equal(await c.get('x', load), 3, 'recently used x stayed');
  assert.equal(await c.get('y', load), 4, 'least recently used y was dropped');
  assert.ok(c.hitRate() > 0);
});
