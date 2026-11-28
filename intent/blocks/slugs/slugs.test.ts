import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvalidSlug, isValidSlug, NotFound, reserved, reservedReason, SlugRegistry, SlugTaken, slugify, transliterate, uniqueSlug } from './index.ts';

test('plain titles become lower-case words joined by hyphens', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  --Foo__Bar--  '), 'foo-bar');
  assert.equal(slugify('One   two\tthree\nfour'), 'one-two-three-four');
  assert.equal(slugify('Version 2.0 (final)'), 'version-2-0-final');
  assert.equal(slugify("It's Bob’s book"), 'its-bobs-book', 'apostrophes vanish instead of splitting words');
  assert.equal(slugify('50% off & more'), '50-percent-off-and-more');
  assert.equal(slugify('Mix_of.separators/and\\slashes'), 'mix-of-separators-and-slashes');
  assert.equal(slugify('Hello World', { separator: '_' }), 'hello_world');
});

test('accents and special letters fold to ASCII', () => {
  assert.equal(slugify('Crème Brûlée à la Mode'), 'creme-brulee-a-la-mode');
  assert.equal(slugify('Straße'), 'strasse');
  assert.equal(slugify('København Ærø Œuvre'), 'kobenhavn-aero-oeuvre');
  assert.equal(slugify('Łódź Đà Nẵng'), 'lodz-da-nang');
  assert.equal(slugify('Þórr and Ðe'), 'thorr-and-de');
  assert.equal(slugify('Ｆｕｌｌｗｉｄｔｈ ①'), 'fullwidth-1', 'compatibility forms are folded');
  assert.equal(slugify('école'), 'ecole', 'combining accents too');
});

test('German umlauts are spelled out only when the locale asks', () => {
  assert.equal(slugify('Müller Böhm Äpfel'), 'muller-bohm-apfel');
  assert.equal(slugify('Müller Böhm Äpfel', { locale: 'de' }), 'mueller-boehm-aepfel');
  assert.equal(slugify('Müller', { locale: 'de-AT' }), 'mueller');
  assert.equal(slugify('Müller', { locale: 'sv' }), 'muller');
});

test('Cyrillic and Greek are romanised; other scripts are dropped or kept on request', () => {
  assert.equal(slugify('Москва — столица России'), 'moskva-stolitsa-rossii');
  assert.equal(slugify('Щука и Ёжик'), 'shchuka-i-yozhik');
  assert.equal(slugify('Ελληνικά'), 'ellinika');
  assert.equal(slugify('Άθηνα'), 'athina', 'Greek tonos is folded');
  assert.equal(slugify('日本語のタイトル'), 'n-a', 'nothing left, so the fallback');
  assert.equal(slugify('日本語のタイトル', { fallback: 'untitled' }), 'untitled');
  assert.equal(slugify('Tokyo 東京 2026'), 'tokyo-2026');
  assert.equal(slugify('Tokyo 東京 2026', { allowUnicode: true }), 'tokyo-東京-2026');
  assert.equal(slugify('Ελληνικά', { allowUnicode: true }), 'ellinika', 'a table beats keeping');
  assert.equal(slugify('Hello 😀 World 🎉'), 'hello-world', 'emoji are dropped');
  assert.equal(transliterate('Ж'), 'Zh');
});

test('long slugs are cut at a word boundary, and never leave a dangling separator', () => {
  assert.equal(slugify('alpha beta gamma delta', { maxLength: 12 }), 'alpha-beta');
  assert.equal(slugify('alpha beta gamma delta', { maxLength: 10 }), 'alpha-beta');
  assert.equal(slugify('alpha beta gamma delta', { maxLength: 11 }), 'alpha-beta', 'cut inside "gamma" falls back to the word before');
  assert.equal(slugify('alpha beta gamma', { maxLength: 16 }), 'alpha-beta-gamma');
  assert.equal(slugify('supercalifragilisticexpialidocious', { maxLength: 10 }), 'supercalif', 'one long word is cut inside it');
  assert.equal(slugify('x'.repeat(500)).length, 80);
  assert.throws(() => slugify('a', { separator: '/' }), InvalidSlug);
  assert.throws(() => slugify('a', { maxLength: 0 }), InvalidSlug);
  assert.equal(slugify('a'.repeat(20_000) + ' b', { maxLength: 5 }), 'aaaaa', 'huge titles are handled');
});

test('well-formed slugs are recognised', () => {
  for (const s of ['a', 'abc-def', 'a1-2b', '2026']) assert.equal(isValidSlug(s), true, s);
  for (const s of ['', 'A', '-a', 'a-', 'a--b', 'a b', 'a_b', 'é']) assert.equal(isValidSlug(s), false, s);
  assert.equal(isValidSlug('東京-2026', { allowUnicode: true }), true);
  assert.equal(isValidSlug('Tokyo', { allowUnicode: true }), false);
});

test('reserved words, device names and bare numbers are refused', () => {
  const r = reserved(['admin', 'API', 'new']);
  assert.match(reservedReason('admin', r)!, /reserved word/);
  assert.match(reservedReason('Api', r)!, /reserved word/, 'case does not matter');
  assert.match(reservedReason('con', r)!, /reserved word/, 'Windows device names');
  assert.match(reservedReason('2026', r)!, /only digits/);
  assert.equal(reservedReason('2026', reserved([], { numeric: false })), null);
  assert.match(reservedReason('_private', r)!, /dot or underscore/);
  assert.equal(reservedReason('administrator', r), null, 'a longer word is fine');
});

test('unique slugs count up, skip reserved names, and keep the suffix inside the length limit', async () => {
  const used = new Set(['hello', 'hello-2', 'hello-3']);
  assert.equal(await uniqueSlug('hello', (s) => used.has(s)), 'hello-4');
  assert.equal(await uniqueSlug('fresh', (s) => used.has(s)), 'fresh');
  assert.equal(await uniqueSlug('admin', () => false, { reserved: reserved(['admin']) }), 'admin-2');
  assert.equal(await uniqueSlug('2026', () => false, { reserved: reserved([]) }), '2026-2');
  const long = 'abcdefghij';
  const taken = new Set([long, 'abcdefgh-2']);
  assert.equal(await uniqueSlug(long, (s) => taken.has(s), { maxLength: 10 }), 'abcdefgh-3', 'the base is cut so the suffixed slug still fits');
  assert.equal(await uniqueSlug('abc-', () => false, { maxLength: 80 }), 'abc-', 'a base is used as given');
  assert.equal(await uniqueSlug('ab', async (s) => s === 'ab', { maxLength: 80 }), 'ab-2', 'the taken check may be asynchronous');
});

test('after the numbered tries a random suffix from the injected randomness is used', async () => {
  const taken = (s: string) => /^x(-\d+)?$/.test(s);
  const slug = await uniqueSlug('x', taken, { attempts: 5, random: () => 0.5 });
  assert.match(slug, /^x-[0-9a-z]{6}$/);
  assert.equal(slug, 'x-' + Math.floor(0.5 * 36 ** 6).toString(36).padStart(6, '0'));
  await assert.rejects(uniqueSlug('x', taken, { attempts: 5 }), /no randomness/);
  await assert.rejects(uniqueSlug('x', () => true, { attempts: 2, random: () => 0.1 }), SlugTaken);
});

test('a record keeps its slug when its title changes; two titles never share a slug in one scope', async () => {
  const reg = new SlugRegistry({ reserved: reserved(['admin']) });
  assert.equal(await reg.assign('p1', 'post', 'Hello World'), 'hello-world');
  assert.equal(await reg.assign('p2', 'post', 'Hello World'), 'hello-world-2');
  assert.equal(await reg.assign('c1', 'category', 'Hello World'), 'hello-world', 'other scopes are separate');
  assert.equal(await reg.assign('p3', 'post', 'Admin'), 'admin-2');
  await assert.rejects(reg.assign('p1', 'post', 'Again'), SlugTaken, 'a record gets one slug');
  assert.equal(reg.get('p1')!.slug, 'hello-world');
  assert.deepEqual(reg.resolve('post', 'HELLO-WORLD'), { kind: 'current', id: 'p1', slug: 'hello-world' }, 'case-insensitive lookup');
  assert.equal(reg.resolve('post', 'nothing'), null);
});

test('renaming leaves a redirect from the old slug, and nobody else can take the old name', async () => {
  const reg = new SlugRegistry();
  await reg.assign('p1', 'post', 'Hello World');
  await reg.assign('p2', 'post', 'Other');
  const r = reg.rename('p1', 'Greetings Earth');
  assert.deepEqual(r, { slug: 'greetings-earth', redirect: { from: 'hello-world', to: 'greetings-earth' } });
  assert.deepEqual(reg.resolve('post', 'hello-world'), { kind: 'redirect', id: 'p1', from: 'hello-world', to: 'greetings-earth' });
  assert.throws(() => reg.rename('p2', 'hello-world'), SlugTaken, 'the old name still belongs to p1');
  assert.equal(await reg.assign('p3', 'post', 'Hello World'), 'hello-world-2', 'a new record does not take it either');
  reg.rename('p1', 'third-name');
  assert.deepEqual(reg.resolve('post', 'hello-world'), { kind: 'redirect', id: 'p1', from: 'hello-world', to: 'third-name' }, 'no chain: the old name points at the newest slug');
  assert.deepEqual(reg.resolve('post', 'greetings-earth'), { kind: 'redirect', id: 'p1', from: 'greetings-earth', to: 'third-name' });
  assert.deepEqual(reg.rename('p1', 'third-name'), { slug: 'third-name', redirect: null });
});

test('renaming back reclaims an old slug; releasing frees it; removing frees everything', async () => {
  const reg = new SlugRegistry();
  await reg.assign('p1', 'post', 'First');
  reg.rename('p1', 'second');
  reg.rename('p1', 'first');
  assert.deepEqual(reg.get('p1')!.history, ['first', 'second'].slice(1), 'first is current again and is no longer an old name');
  assert.deepEqual(reg.resolve('post', 'first'), { kind: 'current', id: 'p1', slug: 'first' });
  assert.equal(reg.release('post', 'second'), true);
  assert.equal(reg.release('post', 'second'), false);
  assert.equal(reg.resolve('post', 'second'), null);
  await reg.assign('p2', 'post', 'Second');
  assert.equal(reg.get('p2')!.slug, 'second', 'a released name can be used');
  assert.equal(reg.remove('p1'), true);
  assert.equal(reg.resolve('post', 'first'), null);
  assert.equal(reg.remove('p1'), false);
  assert.throws(() => reg.rename('nope', 'x'), NotFound);
});

test('renaming to a reserved word is refused; the old-name list is capped', async () => {
  const reg = new SlugRegistry({ reserved: reserved(['admin']), historyLimit: 2 });
  await reg.assign('p1', 'post', 'a1');
  assert.throws(() => reg.rename('p1', 'Admin'), InvalidSlug);
  for (const n of ['a2', 'a3', 'a4']) reg.rename('p1', n);
  assert.deepEqual(reg.get('p1')!.history, ['a2', 'a3']);
  assert.equal(reg.resolve('post', 'a1'), null, 'the oldest fell off the list and is free');
  assert.equal(reg.resolve('post', 'a3')?.kind, 'redirect');
});

test('the registry saves and restores exactly, and a bad snapshot is refused', async () => {
  const reg = new SlugRegistry();
  await reg.assign('p1', 'post', 'One');
  await reg.assign('p2', 'post', 'Two');
  reg.rename('p1', 'uno');
  const snap = reg.snapshot();
  const back = SlugRegistry.restore(snap);
  assert.deepEqual(back.snapshot(), snap);
  assert.deepEqual(back.resolve('post', 'one'), { kind: 'redirect', id: 'p1', from: 'one', to: 'uno' });
  assert.throws(() => SlugRegistry.restore([...snap, { id: 'p9', scope: 'post', slug: 'two', history: [] }]), SlugTaken);
  assert.throws(() => SlugRegistry.restore([{ id: 'a', scope: 's', slug: 'x', history: ['y'] }, { id: 'b', scope: 's', slug: 'y', history: [] }]), SlugTaken);
});
