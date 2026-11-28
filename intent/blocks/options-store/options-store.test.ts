import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidValue, memoryBackend, NotLoaded, OptionsStore, ScopeNotAllowed, UnknownOption, VersionConflict, scopeKind } from './index.ts';
import type { Backend, Change, OptionDef } from './index.ts';

const defs: OptionDef[] = [
  { key: 'site.title', type: 'string', default: 'Untitled', autoload: true, maxLength: 20 },
  { key: 'posts.per_page', type: 'integer', default: 10, min: 1, max: 100, scopes: ['site', 'tenant'] },
  { key: 'ui.theme', type: 'enum', default: 'light', values: ['light', 'dark'], autoload: true, scopes: ['site', 'tenant', 'user'] },
  { key: 'mail.enabled', type: 'boolean', default: false, scopes: ['site', 'tenant'] },
  { key: 'tax.rate', type: 'number', default: 0.2, min: 0, max: 1, scopes: ['site', 'tenant'] },
  { key: 'menu.links', type: 'json', default: [], scopes: ['site'] },
  { key: 'smtp.token', type: 'string', default: '', secret: true },
  { key: 'site.slogan', type: 'string', default: '', validate: (v) => (typeof v === 'string' && /<script/i.test(v) ? 'no scripts in the slogan' : null) },
];
const make = (backend: Backend = memoryBackend(), now = () => 1_000) => ({ store: new OptionsStore(defs, { backend, now }), backend });

test('an option nobody set answers with its default and says so', async () => {
  const { store } = make();
  assert.deepEqual(await store.resolve('posts.per_page'), { value: 10, source: 'default' });
  assert.equal(await store.get('site.title'), 'Untitled');
  assert.deepEqual(await store.get('menu.links'), []);
});

test('scopes: the most specific scope that has a value wins, and each falls back to the next', async () => {
  const { store } = make();
  await store.set('ui.theme', 'site', 'dark');
  assert.deepEqual(await store.resolve('ui.theme', ['user:7', 'tenant:acme', 'site']), { value: 'dark', source: 'site', version: 1 });
  await store.set('ui.theme', 'tenant:acme', 'light');
  assert.equal((await store.resolve('ui.theme', ['user:7', 'tenant:acme', 'site'])).source, 'tenant:acme');
  await store.set('ui.theme', 'user:7', 'dark');
  assert.deepEqual(await store.resolve('ui.theme', ['user:7', 'tenant:acme', 'site']), { value: 'dark', source: 'user:7', version: 1 });
  assert.equal((await store.resolve('ui.theme', ['user:8', 'tenant:acme', 'site'])).value, 'light', 'another user sees the tenant value');
  await store.reset('ui.theme', 'user:7');
  assert.equal((await store.resolve('ui.theme', ['user:7', 'tenant:acme', 'site'])).source, 'tenant:acme');
});

test('values are checked against the declaration, with a reason', async () => {
  const { store } = make();
  const bad: [string, string, unknown, RegExp][] = [
    ['posts.per_page', 'site', 0, /at least 1/],
    ['posts.per_page', 'site', 101, /at most 100/],
    ['posts.per_page', 'site', 2.5, /whole number/],
    ['posts.per_page', 'site', '5', /must be a number/],
    ['posts.per_page', 'site', Number.NaN, /must be a number/],
    ['site.title', 'site', 'x'.repeat(21), /longer than 20/],
    ['site.title', 'site', 5, /must be text/],
    ['ui.theme', 'site', 'blue', /one of light, dark/],
    ['mail.enabled', 'site', 'yes', /true or false/],
    ['tax.rate', 'site', 1.5, /at most 1/],
    ['menu.links', 'site', { f: () => 1 }.f, /JSON/],
    ['menu.links', 'site', 10n, /JSON/],
    ['site.slogan', 'site', '<script>x</script>', /no scripts/],
  ];
  for (const [key, scope, value, why] of bad) await assert.rejects(store.set(key, scope, value), (e: Error) => e instanceof InvalidValue && why.test(e.message), `${key} ${String(value)}`);
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  await assert.rejects(store.set('menu.links', 'site', circular), /JSON/);
  await assert.rejects(store.set('menu.links', 'site', 'x'.repeat(70_000)), /larger than/);
  assert.equal((await store.set('posts.per_page', 'site', 25)).value, 25);
});

test('unknown options and scopes that an option does not allow are refused', async () => {
  const { store } = make();
  await assert.rejects(store.get('nope'), UnknownOption);
  await assert.rejects(store.set('nope', 'site', 1), UnknownOption);
  await assert.rejects(store.set('site.title', 'user:1', 'x'), ScopeNotAllowed);
  await assert.rejects(store.set('posts.per_page', 'user:1', 5), /set at site, tenant/);
  await assert.rejects(store.reset('site.title', 'tenant:a'), ScopeNotAllowed);
  assert.equal(await store.get('site.title', ['user:1', 'site']), 'Untitled', 'a read skips scopes the option does not use');
  assert.equal(scopeKind('tenant:acme'), 'tenant');
  assert.equal(scopeKind('site'), 'site');
  for (const bad of ['', 'Site', 'tenant:', 'tenant:a b', 'tenant:a:b', ':x', 'a'.repeat(5) + ':' + 'b'.repeat(200)]) assert.throws(() => scopeKind(bad), InvalidValue, bad);
});

test('declarations are checked when the store is built', () => {
  const be = memoryBackend();
  const build = (d: OptionDef[]) => new OptionsStore(d, { backend: be });
  assert.throws(() => build([{ key: 'A', type: 'string', default: '' }]), /lower-case/);
  assert.throws(() => build([{ key: 'a', type: 'string', default: '' }, { key: 'a', type: 'string', default: '' }]), /declared twice/);
  assert.throws(() => build([{ key: 'a', type: 'integer', default: 'x' }]), /default is wrong: it must be a number/);
  assert.throws(() => build([{ key: 'a', type: 'integer', default: 5, max: 3 }]), /default is wrong/);
  assert.throws(() => build([{ key: 'a', type: 'enum', default: 'x' }]), /needs its values/);
  assert.throws(() => build([{ key: 'a', type: 'enum', default: 'y', values: ['x'] }]), /default is wrong/);
  assert.throws(() => build([{ key: 'a', type: 'string', default: '', scopes: ['Bad Kind'] }]), /not a scope kind/);
});

test('autoload options are read in one call per scope and then synchronously', async () => {
  let reads = 0;
  const inner = memoryBackend();
  const counting: Backend = { ...inner, read: (...a) => (reads++, inner.read(...a)), readMany: (...a) => (reads++, inner.readMany(...a)) };
  const { store } = make(counting);
  await store.set('site.title', 'site', 'Hello');
  await store.set('ui.theme', 'user:1', 'dark');
  const fresh = new OptionsStore(defs, { backend: counting });
  reads = 0;
  assert.equal(await fresh.preload(['user:1', 'site']), 2 + 1, 'two autoload options at site, and the theme at user');
  assert.equal(reads, 2, 'one backend call per scope');
  assert.equal(fresh.getSync('site.title', ['user:1', 'site']), 'Hello');
  assert.deepEqual(fresh.resolveSync('ui.theme', ['user:1', 'site']), { value: 'dark', source: 'user:1', version: 1 });
  assert.equal(fresh.getSync('ui.theme', ['site']), 'light', 'no site value: the default');
  assert.equal(reads, 2, 'no more backend calls');
  assert.throws(() => fresh.getSync('ui.theme', ['user:9', 'site']), NotLoaded);
  assert.throws(() => fresh.getSync('posts.per_page'), /not an autoload option/);
  await fresh.set('site.title', 'site', 'Changed');
  assert.equal(fresh.getSync('site.title'), 'Changed', 'a write updates the loaded copy');
  await fresh.reset('site.title', 'site');
  assert.equal(fresh.getSync('site.title'), 'Untitled');
});

test('other options are cached: one read however many ask, and a write drops the cached value', async () => {
  let reads = 0;
  const inner = memoryBackend();
  const counting: Backend = { ...inner, read: (...a) => (reads++, inner.read(...a)) };
  const { store } = make(counting);
  await store.set('posts.per_page', 'site', 20);
  reads = 0;
  const all = await Promise.all(Array.from({ length: 50 }, () => store.get('posts.per_page')));
  assert.ok(all.every((v) => v === 20));
  assert.equal(reads, 1, 'fifty readers, one load');
  await store.get('posts.per_page');
  assert.equal(reads, 1, 'cached');
  await store.set('posts.per_page', 'site', 30);
  assert.equal(await store.get('posts.per_page'), 30, 'the write dropped the cached 20');
  await inner.write('site', 'posts.per_page', 40, undefined, { at: 1 });
  assert.equal(await store.get('posts.per_page'), 30, 'another process wrote: not seen until the entry expires...');
  store.forget('posts.per_page');
  assert.equal(await store.get('posts.per_page'), 40, '...or is forgotten');
});

test('the cache entry expires with time, so another process\'s write is seen within the ttl', async () => {
  let t = 0;
  const be = memoryBackend();
  const store = new OptionsStore(defs, { backend: be, now: () => t, ttlMs: 1000 });
  assert.equal(await store.get('posts.per_page'), 10);
  await be.write('site', 'posts.per_page', 55, undefined, { at: 0 });
  assert.equal(await store.get('posts.per_page'), 10);
  t = 1500;
  assert.equal(await store.get('posts.per_page'), 55);
});

test('stored values are copied: changing what you read or wrote changes nothing', async () => {
  const { store } = make();
  const links = [{ label: 'Home', href: '/' }];
  await store.set('menu.links', 'site', links);
  links.push({ label: 'Hacked', href: '/x' });
  const read = (await store.get<{ label: string; href: string }[]>('menu.links'))!;
  assert.equal(read.length, 1);
  read.push({ label: 'Also', href: '/y' });
  assert.equal((await store.get<unknown[]>('menu.links')).length, 1);
  const d = await store.get<unknown[]>('menu.links', ['tenant:none']);
  assert.equal(d.length, 0);
  d.push(1);
  assert.deepEqual(await store.get('menu.links', ['tenant:none']), [], 'the default is never altered by a caller');
});

test('versions: a stale write is refused, and update retries until it wins', async () => {
  const { store } = make();
  const first = await store.set('posts.per_page', 'site', 10, { expectedVersion: null });
  assert.equal(first.version, 1);
  await assert.rejects(store.set('posts.per_page', 'site', 11, { expectedVersion: null }), VersionConflict, 'it already exists');
  const second = await store.set('posts.per_page', 'site', 12, { expectedVersion: 1 });
  assert.equal(second.version, 2);
  await assert.rejects(store.set('posts.per_page', 'site', 13, { expectedVersion: 1 }), VersionConflict, 'someone wrote since version 1');
  assert.equal((await store.resolve('posts.per_page')).version, 2);
  // Twenty concurrent increments all land.
  await Promise.all(Array.from({ length: 20 }, () => store.update('posts.per_page', 'site', (v) => (v as number) + 1, { attempts: 40 })));
  assert.equal(await store.get('posts.per_page'), 32);
  await assert.rejects(store.update('posts.per_page', 'site', () => 'x'), InvalidValue);
});

test('change events fire after the write with old and new values; listeners can stop; secrets are redacted', async () => {
  let t = 5;
  const { store } = make(memoryBackend(), () => t);
  const seen: Change[] = [];
  const all: string[] = [];
  const stop = store.on('posts.per_page', (c) => void seen.push(c));
  store.on('*', (c) => void all.push(`${c.kind}:${c.key}@${c.scope}`));
  await store.set('posts.per_page', 'site', 20, { by: 'ann' });
  t = 9;
  await store.set('posts.per_page', 'tenant:a', 30);
  await store.reset('posts.per_page', 'site', { by: 'bob' });
  assert.deepEqual(seen.map((c) => [c.kind, c.scope, c.old, c.value, c.version, c.at, c.by]), [
    ['set', 'site', 10, 20, 1, 5, 'ann'],
    ['set', 'tenant:a', 10, 30, 1, 9, undefined],
    ['reset', 'site', 20, 10, 2, 9, 'bob'],
  ]);
  stop();
  await store.set('posts.per_page', 'site', 21);
  assert.equal(seen.length, 3);
  assert.equal(all.length, 4);
  const secrets: Change[] = [];
  store.on('smtp.token', (c) => void secrets.push(c));
  await store.set('smtp.token', 'site', 'abc');
  await store.set('smtp.token', 'site', 'def');
  assert.deepEqual(secrets.map((c) => [c.old, c.value]), [['[redacted]', '[redacted]'], ['[redacted]', '[redacted]']]);
  assert.equal(await store.get('smtp.token'), 'def', 'the real value is stored');
  assert.throws(() => store.on('nope', () => {}), UnknownOption);
  await store.reset('posts.per_page', 'tenant:zzz');
  assert.equal(all.length, 6, 'a reset of nothing sends no event');
});

test('a listener that fails or hangs on a throw does not undo or block the write', async () => {
  const { store } = make();
  store.on('mail.enabled', () => {
    throw new Error('listener broke');
  });
  store.on('mail.enabled', async () => {
    await Promise.reject(new Error('async broke'));
  });
  const ok: boolean[] = [];
  store.on('mail.enabled', (c) => void ok.push(c.value as boolean));
  const row = await store.set('mail.enabled', 'site', true);
  assert.equal(row.value, true);
  assert.deepEqual(ok, [true], 'the other listeners still ran');
  assert.deepEqual(store.listenerErrors.map((e) => e.message), ['listener broke', 'async broke']);
  assert.equal(await store.get('mail.enabled'), true);
});

test('listing and export hide secrets; restore is all or nothing', async () => {
  const { store } = make();
  await store.set('smtp.token', 'site', 'abc');
  await store.set('site.title', 'site', 'Hi');
  const all = await store.all(['site']);
  assert.deepEqual(all['smtp.token'], { value: '[redacted]', source: 'site', version: 1 });
  assert.deepEqual(all['site.title'], { value: 'Hi', source: 'site', version: 1 });
  assert.deepEqual(all['posts.per_page'], { value: 10, source: 'default' });
  assert.equal((await store.all(['site'], { includeSecrets: true }))['smtp.token']!.value, 'abc');
  assert.deepEqual(await store.snapshot('site'), { 'site.title': 'Hi', 'smtp.token': '[redacted]' });
  assert.deepEqual(await store.snapshot('site', { includeSecrets: true }), { 'site.title': 'Hi', 'smtp.token': 'abc' });
  await assert.rejects(store.restore('tenant:a', { 'posts.per_page': 50, 'mail.enabled': 'maybe' }), InvalidValue);
  assert.equal(await store.get('posts.per_page', ['tenant:a']), 10, 'nothing was written');
  assert.equal(await store.restore('tenant:a', { 'posts.per_page': 50, 'tax.rate': 0.5 }), 2);
  assert.deepEqual(await store.snapshot('tenant:a'), { 'posts.per_page': 50, 'tax.rate': 0.5 });
  await assert.rejects(store.restore('tenant:a', { 'site.title': 'x' }), ScopeNotAllowed);
});

test('a stored value that no longer fits the declaration is skipped, not served', async () => {
  const be = memoryBackend();
  await be.write('site', 'posts.per_page', 5000, undefined, { at: 1 });
  await be.write('site', 'ui.theme', 'purple', undefined, { at: 1 });
  const store = new OptionsStore(defs, { backend: be });
  assert.equal(await store.get('posts.per_page'), 10, 'the default, not the out-of-range 5000');
  await store.preload(['site']);
  assert.equal(store.getSync('ui.theme'), 'light');
  assert.deepEqual(await store.snapshot('site'), {});
});
