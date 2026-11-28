import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Content, ContentError, canonicalLocale, maskPlaceholders, unmaskPlaceholders } from './index.ts';
import type { Options, Translator } from './index.ts';

const schema = {
  fields: [
    { name: 'title', translatable: true, required: true, maxLength: 40 },
    { name: 'slug', translatable: true },
    { name: 'body', translatable: true },
    { name: 'price', translatable: false },
  ],
  slugField: 'slug',
} as const;

const make = (o: Partial<Options> = {}) => {
  let t = 100;
  return new Content({ schema, sourceLocale: 'en', locales: ['fr', 'fr-CA', 'es', 'ar', 'nb', 'no'], now: () => ++t, ...o });
};

const seeded = (o: Partial<Options> = {}) => {
  const c = make(o);
  c.create('a1', { title: 'Hello world', slug: 'hello-world', body: 'Welcome, {name}! See <b>this</b> at https://x.example/a?b=1.', price: '10' });
  return c;
};

const publish = (c: Content, id: string, locale: string, values: Record<string, string>, by = 'tara', reviewer = 'rex') => {
  c.setTranslation(id, locale, values, by);
  c.submit(id, locale, by);
  c.approve(id, locale, reviewer);
};

test('language tags are put in canonical form and bad ones refused', () => {
  assert.equal(canonicalLocale('fr-ca'), 'fr-CA');
  assert.equal(canonicalLocale('zh-hant-tw'), 'zh-Hant-TW');
  for (const bad of ['', 'fr_CA', 'x', 'fr CA', '12', 'a'.repeat(40)]) assert.throws(() => canonicalLocale(bad), ContentError, bad);
  assert.equal(make({ locales: ['FR-ca'] }).chainFor('fr-CA')[0], 'fr-CA');
});

test('the schema is checked when the store is made', () => {
  assert.throws(() => make({ schema: { fields: [{ name: 'a', translatable: true }, { name: 'a', translatable: true }] } }), /declared twice/);
  assert.throws(() => make({ schema: { fields: [{ name: 'slug', translatable: false }], slugField: 'slug' } }), /slug field must be a translatable/);
  assert.throws(() => make({ schema: { fields: [{ name: '__proto__', translatable: true }] } }), /not a usable field name/);
});

test('the source is split into shared and translatable fields, and refuses unknown or missing ones', () => {
  const c = make();
  assert.throws(() => c.create('x', { slug: 'x' }), /source needs: title/);
  assert.throws(() => c.create('x', { title: 'T', nope: 'y' }), /no field "nope"/);
  assert.throws(() => c.create('x', { title: 'x'.repeat(41) }), /longer than 40/);
  c.create('x', { title: 'T', price: '5' });
  assert.throws(() => c.create('x', { title: 'T' }), /already exists/);
  assert.throws(() => c.resolve('nothing', 'fr'), /no content/);
  assert.equal(c.resolve('x', 'fr').fields.price, '5');
});

test('with no translation the source is shown, field by field, and the result says so', () => {
  const c = seeded();
  const r = c.resolve('a1', 'fr');
  assert.equal(r.fields.title, 'Hello world');
  assert.deepEqual(r.from, { title: 'en', slug: 'en', body: 'en' });
  assert.deepEqual(r.fallbackFields, ['title', 'slug', 'body']);
  assert.equal(r.complete, false);
  assert.equal(r.dir, 'ltr');
  assert.equal(c.resolve('a1', 'ar').dir, 'rtl');
  const own = c.resolve('a1', 'en');
  assert.equal(own.complete, true);
  assert.deepEqual(own.fallbackFields, []);
});

test('a draft is not shown; an approved translation is, and the reviewer cannot be the translator', () => {
  const c = seeded();
  c.setTranslation('a1', 'fr', { title: 'Bonjour le monde' }, 'tara');
  assert.equal(c.resolve('a1', 'fr').fields.title, 'Hello world', 'a draft is not published');
  assert.throws(() => c.approve('a1', 'fr', 'rex'), /only a translation in review/);
  c.submit('a1', 'fr', 'tara');
  assert.throws(() => c.approve('a1', 'fr', 'tara'), /translated it cannot approve/);
  assert.equal(c.approve('a1', 'fr', 'rex').state, 'approved');
  const r = c.resolve('a1', 'fr');
  assert.equal(r.fields.title, 'Bonjour le monde');
  assert.equal(r.from.title, 'fr');
  assert.equal(r.from.body, 'en');
  assert.deepEqual(r.fallbackFields, ['slug', 'body']);
  assert.equal(c.variantOf('a1', 'fr')?.reviewer, 'rex');
  assert.deepEqual(c.variantOf('a1', 'fr')?.log.map((l) => l.action), ['edited', 'submitted', 'approved']);
});

test('submitting needs every required field, and sending back needs a reason and returns to draft', () => {
  const c = seeded();
  c.setTranslation('a1', 'fr', { body: 'Bienvenue' }, 'tara');
  assert.throws(() => c.submit('a1', 'fr', 'tara'), /still missing: title/);
  c.setTranslation('a1', 'fr', { title: 'Bonjour' }, 'tara');
  c.submit('a1', 'fr', 'tara');
  assert.throws(() => c.submit('a1', 'fr', 'tara'), /in-review translation cannot be submitted/);
  assert.throws(() => c.reject('a1', 'fr', 'rex', '  '), /say why/);
  const v = c.reject('a1', 'fr', 'rex', 'Too formal');
  assert.equal(v.state, 'draft');
  assert.equal(v.rejected?.reason, 'Too formal');
  assert.throws(() => c.reject('a1', 'fr', 'rex', 'again'), /only a translation in review/);
  assert.throws(() => c.submit('zz' as never, 'fr', 'x'), /no content/);
  assert.throws(() => c.submit('a1', 'es', 'x'), /no translation to submit/);
});

test('editing an approved translation sends it back to draft, so nothing unreviewed is ever shown', () => {
  const c = seeded();
  publish(c, 'a1', 'fr', { title: 'Bonjour' });
  assert.equal(c.resolve('a1', 'fr').fields.title, 'Bonjour');
  c.setTranslation('a1', 'fr', { title: 'Salut' }, 'tara');
  assert.equal(c.variantOf('a1', 'fr')?.state, 'draft');
  assert.equal(c.variantOf('a1', 'fr')?.reviewer, undefined);
  assert.equal(c.resolve('a1', 'fr').fields.title, 'Hello world');
});

test('fallback goes along the language chain per field, then to configured fallbacks, then the source', () => {
  const c = seeded();
  publish(c, 'a1', 'fr', { title: 'Bonjour', body: 'Bienvenue, {name} !' });
  publish(c, 'a1', 'fr-CA', { title: 'Allo' });
  const r = c.resolve('a1', 'fr-CA');
  assert.deepEqual(r.from, { title: 'fr-CA', slug: 'en', body: 'fr' });
  assert.equal(r.fields.body, 'Bienvenue, {name} !');
  assert.deepEqual(c.chainFor('fr-CA'), ['fr-CA', 'fr', 'en']);
  const n = seeded({ fallbacks: { nb: ['no'], no: ['nb'] } });
  publish(n, 'a1', 'no', { title: 'Hei' });
  assert.deepEqual(n.chainFor('nb'), ['nb', 'no', 'en']);
  assert.equal(n.resolve('a1', 'nb').fields.title, 'Hei');
  assert.throws(() => n.resolve('a1', 'de'), /not one of the languages/);
});

test('when the source changes, only the fields written from the old text go stale, and approval waits', () => {
  const c = seeded();
  publish(c, 'a1', 'fr', { title: 'Bonjour', body: 'Bienvenue' });
  assert.deepEqual(c.staleFields('a1', 'fr'), []);
  assert.deepEqual(c.updateSource('a1', { title: 'Hello there' }), ['title']);
  assert.deepEqual(c.staleFields('a1', 'fr'), ['title']);
  assert.equal(c.resolve('a1', 'fr').fields.title, 'Bonjour', 'the old translation is shown until redone');
  assert.deepEqual(c.updateSource('a1', { title: 'Hello there' }), ['title'], 'saving the same text changes nothing');
  assert.deepEqual(c.updateSource('a1', { price: '12' }), ['title'], 'a shared field does not make anything stale');
  assert.equal(c.resolve('a1', 'fr').fields.price, '12');
  c.setTranslation('a1', 'fr', { body: 'Bienvenue !' }, 'tara');
  c.submit('a1', 'fr', 'tara');
  assert.throws(() => c.approve('a1', 'fr', 'rex'), /source changed since these were written: title/);
  c.setTranslation('a1', 'fr', { title: 'Salut' }, 'tara');
  assert.deepEqual(c.staleFields('a1', 'fr'), []);
  c.submit('a1', 'fr', 'tara');
  assert.equal(c.approve('a1', 'fr', 'rex').state, 'approved');
  const strict = seeded({ serveStale: false });
  publish(strict, 'a1', 'fr', { title: 'Bonjour' });
  strict.updateSource('a1', { title: 'Hello there' });
  assert.equal(strict.resolve('a1', 'fr').fields.title, 'Hello there', 'with serveStale off, the source is shown instead');
});

test('slugs are unique per language, checked for shape, freed when changed, and found again', () => {
  const c = seeded();
  c.create('a2', { title: 'Other', slug: 'other' });
  assert.throws(() => c.create('a3', { title: 'Dup', slug: 'hello-world' }), /used by a1/);
  assert.throws(() => c.updateSource('a2', { slug: 'hello-world' }), /used by a1/);
  assert.throws(() => c.updateSource('a2', { slug: 'Not A Slug' }), /lower-case words joined by hyphens/);
  c.setTranslation('a1', 'fr', { slug: 'bonjour-le-monde' }, 'tara');
  assert.throws(() => c.setTranslation('a2', 'fr', { slug: 'bonjour-le-monde' }, 'tara'), /fr slug "bonjour-le-monde" is used by a1/);
  c.setTranslation('a2', 'es', { slug: 'bonjour-le-monde' }, 'tara');
  assert.equal(c.findBySlug('fr', 'bonjour-le-monde'), 'a1');
  assert.equal(c.findBySlug('es', 'bonjour-le-monde'), 'a2');
  c.setTranslation('a1', 'fr', { slug: 'salut' }, 'tara');
  assert.equal(c.findBySlug('fr', 'bonjour-le-monde'), undefined);
  assert.equal(c.findBySlug('fr', 'salut'), 'a1');
  c.setTranslation('a1', 'ar', { slug: 'مرحبا' }, 'tara');
  assert.equal(c.findBySlug('ar', 'مرحبا'), 'a1', 'letters of any script are fine');
  c.updateSource('a2', { slug: 'renamed' });
  assert.equal(c.findBySlug('en', 'other'), undefined);
  assert.equal(c.findBySlug('en', 'renamed'), 'a2');
});

test('translations are for translatable fields of the source language only', () => {
  const c = seeded();
  assert.throws(() => c.setTranslation('a1', 'en', { title: 'x' }, 'tara'), /source language/);
  assert.throws(() => c.setTranslation('a1', 'fr', { price: '1' }, 'tara'), /same in every language/);
  assert.throws(() => c.setTranslation('a1', 'fr', { title: 'x'.repeat(41) }, 'tara'), /longer than 40/);
  assert.throws(() => c.setTranslation('a1', 'fr', { nope: 'x' }, 'tara'), /no field "nope"/);
  assert.throws(() => c.setTranslation('a1', 'fr', { ['__proto__']: 'x' }, 'tara'), /no field/);
  c.create('b', { title: 'No body' });
  assert.throws(() => c.setTranslation('b', 'fr', { body: 'x' }, 'tara'), /no source text to translate/);
  c.setTranslation('a1', 'fr', { title: 'Bonjour' }, 'tara');
  c.setTranslation('a1', 'fr', { title: '' }, 'tara');
  assert.equal(c.variantOf('a1', 'fr')?.fields.title, undefined, 'an empty text removes the translation of the field');
});

// ------------------------------------------------------------ machine translation

test('placeholders, tags and links are masked, and any loss is detected on the way back', () => {
  const src = 'Hi {name}, {{ count }} items for %s at <a href="x">https://x.example/p?q=1</a>.';
  const { masked, tokens } = maskPlaceholders(src);
  assert.ok(!masked.includes('{name}') && !masked.includes('https') && !masked.includes('<a'));
  assert.deepEqual(tokens, ['{{ count }}', '{name}', '%s', '<a href="x">', '</a>', 'https://x.example/p?q=1']);
  assert.equal(unmaskPlaceholders(masked, tokens), src);
  assert.equal(unmaskPlaceholders(masked.replace('⟦0⟧', ''), tokens), undefined, 'one lost');
  assert.equal(unmaskPlaceholders(`${masked} ⟦0⟧`, tokens), undefined, 'one repeated');
  assert.equal(unmaskPlaceholders(`${masked} ⟦99⟧`, tokens), undefined, 'one invented');
  assert.equal(unmaskPlaceholders('plain', []), 'plain');
});

const fr: Translator = async ({ texts }) => Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.replace('Hello world', 'Bonjour le monde').replace('Welcome,', 'Bienvenue,')]));

test('machine translation fills empty fields, shows the translator only masked text, and stays "machine" until a person edits', async () => {
  const c = seeded();
  const seen: Record<string, string>[] = [];
  const r = await c.machineTranslate('a1', 'fr', async (req) => {
    seen.push({ ...req.texts });
    assert.equal(req.from, 'en');
    assert.equal(req.to, 'fr');
    return fr(req);
  });
  assert.deepEqual(r.filled, ['title', 'slug', 'body']);
  assert.ok(!seen[0]!.body!.includes('{name}') && !seen[0]!.body!.includes('https://'));
  assert.equal(c.variantOf('a1', 'fr')?.state, 'machine');
  assert.equal(c.variantOf('a1', 'fr')?.fields.body?.text, 'Bienvenue, {name}! See <b>this</b> at https://x.example/a?b=1.');
  assert.equal(c.variantOf('a1', 'fr')?.fields.title?.origin, 'machine');
  assert.equal(c.resolve('a1', 'fr').fields.title, 'Hello world', 'machine text is not published by default');
  const open = seeded({ publish: ['approved', 'machine'] });
  await open.machineTranslate('a1', 'fr', fr);
  assert.equal(open.resolve('a1', 'fr').fields.title, 'Bonjour le monde');
  open.setTranslation('a1', 'fr', { title: 'Bonjour tout le monde' }, 'tara');
  assert.equal(open.variantOf('a1', 'fr')?.state, 'draft');
  assert.equal(open.variantOf('a1', 'fr')?.fields.title?.origin, 'human');
});

test('machine translation never overwrites a person, unless told to, and redoes only stale machine fields', async () => {
  const c = seeded();
  c.setTranslation('a1', 'fr', { title: 'Mon titre' }, 'tara');
  const calls: string[][] = [];
  const spy: Translator = async (req) => {
    calls.push(Object.keys(req.texts));
    return fr(req);
  };
  const r1 = await c.machineTranslate('a1', 'fr', spy);
  assert.deepEqual(r1.kept, ['title']);
  assert.deepEqual(r1.filled, ['slug', 'body']);
  assert.equal(c.variantOf('a1', 'fr')?.fields.title?.text, 'Mon titre');
  assert.equal(c.variantOf('a1', 'fr')?.state, 'draft', 'a human draft stays a draft');
  const r2 = await c.machineTranslate('a1', 'fr', spy);
  assert.deepEqual(r2, { filled: [], rejected: [], kept: ['title', 'slug', 'body'] });
  assert.equal(calls.length, 1, 'nothing was sent the second time');
  c.updateSource('a1', { body: 'Welcome back, {name}!' });
  const r3 = await c.machineTranslate('a1', 'fr', spy);
  assert.deepEqual(r3.filled, ['body']);
  assert.deepEqual(calls[1], ['body']);
  const r4 = await c.machineTranslate('a1', 'fr', spy, { overwriteHuman: true });
  assert.deepEqual(r4.filled, ['title']);
  assert.equal(c.variantOf('a1', 'fr')?.fields.title?.text, 'Bonjour le monde');
});

test('machine output that loses a placeholder, is empty, too long, or a bad slug is rejected field by field', async () => {
  const c = seeded();
  const bad: Translator = async ({ texts }) => ({ title: 'x'.repeat(41), slug: 'Not A Slug', body: texts.body!.replace(/⟦\d+⟧/, '') });
  const r = await c.machineTranslate('a1', 'fr', bad);
  assert.deepEqual(r.filled, []);
  assert.deepEqual(r.rejected.map((x) => x.field), ['title', 'slug', 'body']);
  assert.match(r.rejected[0]!.why, /longer than 40/);
  assert.match(r.rejected[1]!.why, /not a usable slug/);
  assert.match(r.rejected[2]!.why, /placeholder, tag or link was lost/);
  assert.equal(c.variantOf('a1', 'fr')?.state === undefined || Object.keys(c.variantOf('a1', 'fr')!.fields).length === 0, true, 'nothing was stored');
  const empty = await c.machineTranslate('a1', 'es', async () => ({}));
  assert.deepEqual(empty.rejected.map((x) => x.why), ['the translator returned nothing', 'the translator returned nothing', 'the translator returned nothing']);
  const taken = seeded();
  taken.setTranslation('a1', 'fr', { slug: 'salut' }, 'tara');
  taken.create('a2', { title: 'Two', slug: 'two' });
  const t = await taken.machineTranslate('a2', 'fr', async () => ({ title: 'Deux', slug: 'salut' }));
  assert.deepEqual(t.filled, ['title']);
  assert.match(t.rejected[0]!.why, /used by a1/);
  await assert.rejects(() => c.machineTranslate('a1', 'en', fr), /source language/);
});

// ------------------------------------------------------------ views and reports

test('alternates list the published languages and an x-default, with each language slug', () => {
  const c = seeded();
  publish(c, 'a1', 'fr', { title: 'Bonjour', slug: 'bonjour' });
  c.setTranslation('a1', 'es', { title: 'Hola', slug: 'hola' }, 'tara');
  assert.deepEqual(c.alternates('a1'), [
    { hreflang: 'en', locale: 'en', slug: 'hello-world' },
    { hreflang: 'fr', locale: 'fr', slug: 'bonjour' },
    { hreflang: 'x-default', locale: 'en', slug: 'hello-world' },
  ]);
});

test('the report counts each state per language and the to-do list says what is left and why', () => {
  const c = seeded();
  c.create('a2', { title: 'Second', body: 'More' });
  c.create('a3', { title: 'Third' });
  publish(c, 'a1', 'fr', { title: 'Bonjour' });
  c.setTranslation('a2', 'fr', { title: 'Deuxieme' }, 'tara');
  c.setTranslation('a3', 'es', { title: 'Tercero' }, 'tara');
  c.submit('a3', 'es', 'tara');
  c.updateSource('a1', { title: 'Hello again' });
  const rep = c.report();
  const f = rep.find((x) => x.locale === 'fr')!;
  assert.deepEqual({ ...f, percent: undefined }, { locale: 'fr', items: 3, approved: 1, inReview: 0, draft: 1, machine: 0, missing: 1, stale: 1, percent: undefined });
  assert.equal(f.percent, 0, 'an approved translation with a stale field does not count as complete');
  const es = rep.find((x) => x.locale === 'es')!;
  assert.equal(es.inReview, 1);
  assert.equal(es.missing, 2);
  assert.deepEqual(rep.map((x) => x.locale), ['fr', 'fr-CA', 'es', 'ar', 'nb', 'no']);
  assert.deepEqual(c.todo('fr'), [{ contentId: 'a1', reason: 'stale', fields: ['title'] }, { contentId: 'a2', reason: 'unreviewed', fields: [] }, { contentId: 'a3', reason: 'missing', fields: ['title'] }]);
  assert.deepEqual(c.status('a1').find((s) => s.locale === 'fr'), { locale: 'fr', state: 'approved', missing: [], stale: ['title'] });
  assert.equal(c.status('a1')[0]?.state, 'source');
});

test('an empty store reports full completeness rather than dividing by zero', () => {
  assert.equal(make().report().every((r) => r.percent === 1 && r.items === 0), true);
});
