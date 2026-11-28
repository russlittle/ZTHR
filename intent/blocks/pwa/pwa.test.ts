import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OfflineQueue, checkManifest, worker, type Manifest } from './index.ts';

const good: Manifest = { name: 'Files', short_name: 'Files', start_url: '/apps/files', scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#14324a', icons: [{ src: '/i/192.png', sizes: '192x192', type: 'image/png' }, { src: '/i/512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] };

test('the manifest check lists what would stop installation', () => {
  assert.deepEqual(checkManifest(good), []);
  assert.deepEqual(checkManifest({ ...good, short_name: 'My Files Cloud', start_url: '/x', scope: '/app/', display: 'browser', theme_color: 'navy', icons: [{ src: '/i.png', sizes: '192x192', type: 'image/png' }] }), [
    'the short name "My Files Cloud" is over 12 characters and will be cut on home screens',
    'the start URL must be inside the scope',
    'display "browser" cannot be installed as an app',
    'an icon of 512x512 is needed',
    'add a maskable icon so it is not boxed on Android',
    'navy is not a #rrggbb colour',
  ]);
});

test('the worker is valid JavaScript carrying the plan', () => {
  const src = worker({ version: 'v42', precache: ['/app.js', '/app.css'], offline: '/offline.html', routes: [{ match: '^/assets/', strategy: 'cacheFirst' }, { match: '^/api/', strategy: 'networkOnly' }, { match: '^/', strategy: 'networkFirst' }] });
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /"\^\/api\/","networkOnly"/);
  assert.match(src, /caches\.match\(OFF\)/);
});

test('offline changes replay in order, stop while still offline, and set aside what the server refuses', async () => {
  const q = new OfflineQueue(() => new Date('2026-11-26T00:00:00Z'));
  q.add('POST', '/api/folders', { name: 'A' });
  q.add('PATCH', '/api/files/1', { name: 'renamed' });
  q.add('DELETE', '/api/files/2');
  const seen: string[] = [];
  let online = false;
  const send = async (x: { key: string; path: string }) => {
    if (!online) throw new Error('offline');
    seen.push(x.path);
    return x.path === '/api/files/1' ? { status: 409, detail: 'someone else renamed it' } : { status: 201 };
  };
  assert.deepEqual(await q.replay(send), { sent: 0, refused: 0, waiting: 3 });
  online = true;
  assert.deepEqual(await q.replay(send), { sent: 2, refused: 1, waiting: 0 });
  assert.deepEqual(seen, ['/api/folders', '/api/files/1', '/api/files/2']);
  assert.equal(q.needsYou()[0]!.refused!.detail, 'someone else renamed it');
  assert.equal(new Set(q.items.map((x) => x.key)).size, q.items.length);
  q.drop(q.needsYou()[0]!.key);
  assert.equal(q.items.length, 0);
});

test('activating a version deletes every other version’s caches, even one whose name ends the same way', async () => {
  const src = worker({ version: 'v2', precache: ['/app.js'], offline: '/offline.html', routes: [{ match: '^/assets/', strategy: 'cacheFirst' }, { match: '^/img/', strategy: 'staleWhileRevalidate', cache: 'images' }] });
  const names = new Set(['pre-v12', 'rt-v12', 'pre-v2', 'rt-v2', 'images', 'pre-v1']);
  const handlers: Record<string, (e: { waitUntil: (p: Promise<unknown>) => void }) => void> = {};
  const self = { addEventListener: (k: string, f: (e: { waitUntil: (p: Promise<unknown>) => void }) => void) => void (handlers[k] = f), clients: { claim: async () => {} }, skipWaiting: async () => {} };
  const caches = { keys: async () => [...names], delete: async (k: string) => names.delete(k) };
  new Function('self', 'caches', 'location', src)(self, caches, { origin: 'https://x' });
  let done!: Promise<unknown>;
  handlers.activate!({ waitUntil: (p) => void (done = p) });
  await done;
  assert.deepEqual([...names].sort(), ['images', 'pre-v2', 'rt-v2']);
});

test('idempotency keys are unique across queues, so two devices offline at the same moment never share one', () => {
  const at = () => new Date('2026-11-26T00:00:00Z');
  const a = new OfflineQueue(at).add('POST', '/api/folders', { name: 'A' });
  const b = new OfflineQueue(at).add('POST', '/api/folders', { name: 'B' });
  assert.notEqual(a.key, b.key);
});

test('every cache write is held in the fetch event’s waitUntil, so the worker lives until the response is stored', async () => {
  const src = worker({ version: 'v3', precache: [], offline: '/offline.html', routes: [{ match: '^/assets/', strategy: 'cacheFirst' }, { match: '^/img/', strategy: 'staleWhileRevalidate' }, { match: '^/', strategy: 'networkFirst' }] });
  type Ev = { request: { url: string; method: string; mode: string }; respondWith: (p: Promise<unknown>) => void; waitUntil: (p: Promise<unknown>) => void };
  const handlers: Record<string, (e: Ev) => void> = {};
  const self = { addEventListener: (k: string, f: (e: Ev) => void) => void (handlers[k] = f), clients: { claim: async () => {} }, skipWaiting: async () => {} };
  const stored = new Map<string, unknown>();
  const caches = {
    keys: async () => [],
    delete: async () => true,
    match: async (r: { url: string } | string) => stored.get(typeof r === 'string' ? r : r.url),
    open: async () => ({ put: (r: { url: string }, res: unknown) => new Promise<void>((done) => setTimeout(() => void (stored.set(r.url, res), done()), 5)) }),
  };
  const fetch = async (r: { url: string }) => ({ ok: true, url: r.url, clone() { return { copy: r.url }; } });
  new Function('self', 'caches', 'location', 'fetch', 'Response', src)(self, caches, { origin: 'https://x' }, fetch, { error: () => 'error' });
  for (const path of ['/assets/app.js', '/img/cat.png', '/page']) {
    const url = `https://x${path}`;
    const lifetime: Promise<unknown>[] = [];
    let response!: Promise<unknown>;
    handlers.fetch!({ request: { url, method: 'GET', mode: 'no-cors' }, respondWith: (p) => void (response = p), waitUntil: (p) => void lifetime.push(p) });
    await response;
    // Like the browser, settle every promise the event asked to be kept alive for, including ones added meanwhile.
    for (let i = 0; i < lifetime.length; i++) await lifetime[i];
    assert.ok(lifetime.length > 0, `${path}: the write is held in waitUntil`);
    assert.deepEqual(stored.get(url), { copy: url }, `${path}: stored by the time the event's lifetime ends`);
  }
});
