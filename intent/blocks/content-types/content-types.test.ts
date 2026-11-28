import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentModelError, ContentStore, NotFoundError, Registry, slugify, ValidationFailed, validateFields } from './index.ts';

function model(): Registry {
  const r = new Registry();
  r.defineComponent({ uid: 'shared.seo', fields: { metaTitle: { kind: 'string', required: true, maxLength: 60 }, metaDescription: { kind: 'text', maxLength: 160 } } });
  r.defineComponent({ uid: 'blocks.hero', fields: { heading: { kind: 'string', required: true }, image: { kind: 'media' } } });
  r.defineComponent({ uid: 'blocks.quote', fields: { text: { kind: 'text', required: true }, author: { kind: 'string' } } });
  r.defineComponent({ uid: 'shared.link', fields: { label: { kind: 'string', required: true }, url: { kind: 'string', required: true, regex: '^https?://' } } });
  r.defineType({ uid: 'author', fields: { name: { kind: 'string', required: true }, email: { kind: 'email', unique: true } } });
  r.defineType({
    uid: 'article',
    draftAndPublish: true,
    localized: true,
    fields: {
      title: { kind: 'string', required: true, maxLength: 120 },
      slug: { kind: 'uid', targetField: 'title' },
      views: { kind: 'integer', min: 0, default: 0, localized: false },
      kind: { kind: 'enumeration', values: ['news', 'essay'], default: 'news' },
      seo: { kind: 'component', component: 'shared.seo' },
      links: { kind: 'component', component: 'shared.link', repeatable: true, max: 3 },
      body: { kind: 'dynamiczone', components: ['blocks.hero', 'blocks.quote'] },
      author: { kind: 'relation', target: 'author', relation: 'manyToOne' },
      tags: { kind: 'relation', target: 'author', relation: 'manyToMany' },
      internalNote: { kind: 'text', private: true },
      published_on: { kind: 'date' },
    },
  });
  r.defineType({ uid: 'homepage', kind: 'single', fields: { tagline: { kind: 'string', required: true } } });
  return r;
}
const make = (locales = ['en', 'fr', 'de']) => {
  let t = 1000;
  let n = 0;
  return new ContentStore({ registry: model(), now: () => ++t, newId: () => `doc${++n}`, locales });
};

// ------------------------------------------------------------ registry

test('the registry holds types and components and lists them', () => {
  const r = model();
  assert.deepEqual(r.listTypes(), ['article', 'author', 'homepage']);
  assert.deepEqual(r.listComponents(), ['blocks.hero', 'blocks.quote', 'shared.link', 'shared.seo']);
  assert.equal(r.type('article').localized, true);
  assert.equal(r.type('author').draftAndPublish, false);
  assert.throws(() => r.type('nope'), NotFoundError);
  assert.deepEqual(r.check(), []);
});

test('component reuse: usage says where each component is held', () => {
  const r = model();
  assert.deepEqual(r.usage(), {
    'blocks.hero': ['article.body'],
    'blocks.quote': ['article.body'],
    'shared.link': ['article.links'],
    'shared.seo': ['article.seo'],
  });
});

test('definitions are refused: bad uid, duplicates, reserved and bad field names, missing parts', () => {
  const r = new Registry();
  assert.throws(() => r.defineType({ uid: 'Bad Name', fields: { a: { kind: 'string' } } }), /uid/);
  assert.throws(() => r.defineComponent({ uid: 'nodot', fields: { a: { kind: 'string' } } }), /category.name/);
  r.defineType({ uid: 'a', fields: { x: { kind: 'string' } } });
  assert.throws(() => r.defineType({ uid: 'a', fields: { x: { kind: 'string' } } }), /already defined/);
  assert.throws(() => r.defineType({ uid: 'b', fields: {} }), /at least one field/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { id: { kind: 'string' } } }), /reserved/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { '1x': { kind: 'string' } } }), /not a valid field name/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { x: { kind: 'wat' as never } } }), /unknown field kind/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { x: { kind: 'enumeration' } } }), /needs values/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'uid', targetField: 'zzz' } } }), /not a field/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'relation' } } }), /needs target and relation/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'dynamiczone', components: [] } } }), /needs components/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'integer', min: 5, max: 1 } } }), /min is above max/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'string', regex: '(a+)+$' } } }), /nested quantifier/);
  assert.throws(() => r.defineType({ uid: 'b', fields: { s: { kind: 'string', regex: '(' } } }), /not valid/);
});

test('check() finds references to things that do not exist, and the store will not open on them', () => {
  const r = new Registry();
  r.defineType({ uid: 'post', fields: { by: { kind: 'relation', target: 'person', relation: 'manyToOne' }, hero: { kind: 'component', component: 'x.y' }, zone: { kind: 'dynamiczone', components: ['x.z'] } } });
  assert.deepEqual(r.check(), [
    'post.by: relation target "person" is not a content type',
    'post.hero: component "x.y" is not defined',
    'post.zone: component "x.z" is not defined',
  ]);
  assert.throws(() => new ContentStore({ registry: r, now: () => 0, newId: () => 'x' }), /not sound/);
});

test('components that contain themselves, directly or around a loop, are found', () => {
  const r = new Registry();
  r.defineComponent({ uid: 'a.one', fields: { two: { kind: 'component', component: 'a.two' } } });
  r.defineComponent({ uid: 'a.two', fields: { one: { kind: 'component', component: 'a.one' } } });
  r.defineComponent({ uid: 'a.self', fields: { me: { kind: 'dynamiczone', components: ['a.self'] } } });
  const problems = r.check();
  assert.ok(problems.includes('components contain themselves: a.one > a.two > a.one'));
  assert.ok(problems.includes('components contain themselves: a.self > a.self'));
});

test('exportSchema gives plain data sorted by uid', () => {
  const s = model().exportSchema();
  assert.deepEqual(s.types.map((t) => t.uid), ['article', 'author', 'homepage']);
  assert.equal(s.components.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(s)).types[1].fields.name, { kind: 'string', required: true });
});

// ------------------------------------------------------------ validation

test('every problem is named with its path, including inside components and dynamic zones', () => {
  const r = model();
  const problems = validateFields(r, r.type('article').fields, {
    title: 42,
    views: -1,
    kind: 'poem',
    seo: { metaTitle: 'x'.repeat(61), extra: 1 },
    links: [{ label: 'a', url: 'ftp://x' }, 'no'],
    body: [{ __component: 'blocks.hero' }, { __component: 'blocks.nope' }, { heading: 'no tag' }, 5],
    author: 7,
    tags: 'not-a-list',
    published_on: '2026-02-30',
    nope: true,
  }, true);
  const by = Object.fromEntries(problems.map((p) => [p.path, p.message]));
  assert.equal(by['title'], 'must be text');
  assert.equal(by['views'], 'must be at least 0');
  assert.equal(by['kind'], 'must be one of news, essay');
  assert.equal(by['seo.metaTitle'], 'must be at most 60 characters');
  assert.equal(by['seo.extra'], 'is not a field of this type');
  assert.equal(by['links[0].url'], 'does not match ^https?://');
  assert.equal(by['links[1]'], 'must be an object');
  assert.equal(by['body[0].heading'], 'is required');
  assert.match(by['body[1].__component']!, /must be one of blocks.hero, blocks.quote/);
  assert.match(by['body[2].__component']!, /must be one of/);
  assert.equal(by['body[3]'], 'must be an object');
  assert.equal(by['author'], 'must be an id');
  assert.equal(by['tags'], 'must be a list of ids');
  assert.equal(by['published_on'], 'must be a date like 2026-03-31');
  assert.equal(by['nope'], 'is not a field of this type');
});

test('required is demanded only when asked, and limits on repeatable components are enforced', () => {
  const r = model();
  assert.deepEqual(validateFields(r, r.type('article').fields, {}, false), []);
  assert.deepEqual(validateFields(r, r.type('article').fields, {}, true).map((p) => p.path), ['title']);
  const four = Array.from({ length: 4 }, () => ({ label: 'l', url: 'https://x' }));
  assert.deepEqual(validateFields(r, r.type('article').fields, { links: four }, false), [{ path: 'links', message: 'allows at most 3 items' }]);
});

test('field kinds: email, uid characters, integers, dates, datetimes, json, media', () => {
  const r = new Registry();
  r.defineType({ uid: 't', fields: { e: { kind: 'email' }, u: { kind: 'uid' }, i: { kind: 'integer' }, d: { kind: 'decimal', max: 10 }, dt: { kind: 'datetime' }, j: { kind: 'json' }, m: { kind: 'media' }, ms: { kind: 'media', multiple: true }, b: { kind: 'boolean' } } });
  const f = r.type('t').fields;
  const paths = (d: Record<string, unknown>) => validateFields(r, f, d, false).map((p) => p.path);
  assert.deepEqual(paths({ e: 'nope', u: 'has space', i: 1.5, d: 11, dt: '2026-01-01', j: 1n, m: ['a'], ms: [1], b: 'yes' }), ['e', 'u', 'i', 'd', 'dt', 'j', 'm', 'ms', 'b']);
  assert.deepEqual(paths({ e: 'a@b.co', u: 'a_b-c.d~e', i: 3, d: 9.5, dt: '2026-01-01T10:00:00Z', j: { a: [1] }, m: 'file1', ms: ['a', 'b'], b: false }), []);
});

// ------------------------------------------------------------ store: create, defaults, uid

test('create applies defaults, makes the slug from the title, and keeps slugs unique per locale with -1, -2', () => {
  const s = make();
  const a = s.create('article', { title: 'Hello, World!' });
  assert.equal(a.data['slug'], 'hello-world');
  assert.equal(a.data['views'], 0);
  assert.equal(a.data['kind'], 'news');
  assert.equal(a.status, 'draft');
  assert.equal(a.locale, 'en');
  assert.equal(s.create('article', { title: 'Hello World' }).data['slug'], 'hello-world-1');
  assert.equal(s.create('article', { title: 'hello world' }).data['slug'], 'hello-world-2');
  assert.equal(s.create('article', { title: 'Hello World' }, { locale: 'fr' }).data['slug'], 'hello-world'); // another locale: free
  assert.throws(() => s.create('article', { title: 'x', slug: 'hello-world' }), (e: unknown) => e instanceof ValidationFailed && e.problems[0]!.message === '"hello-world" is already used');
  assert.equal(slugify('Crème Brûlée  & Co.'), 'creme-brulee-co');
});

test('a draft saves with required fields missing, but wrong types are still refused', () => {
  const s = make();
  const e = s.create('article', {});
  assert.equal(e.status, 'draft');
  assert.throws(() => s.create('article', { title: 5 }), ValidationFailed);
  assert.throws(() => s.create('article', { nope: 1 }), /not a field of this type/);
});

test('unique fields are unique in a type, and a type without draft and publish demands required fields at once', () => {
  const s = make();
  s.create('author', { name: 'Ada', email: 'ada@example.org' });
  assert.throws(() => s.create('author', { name: 'Ada 2', email: 'ada@example.org' }), /already used/);
  assert.throws(() => s.create('author', { email: 'x@example.org' }), /name: is required/);
  const a = s.create('author', { name: 'Grace' });
  assert.equal(a.status, 'published');
  assert.notEqual(a.publishedAt, null);
  assert.throws(() => s.update('author', a.documentId, { name: null as never }), /name: is required/);
});

test('a single type has one entry, with a fixed id', () => {
  const s = make();
  const h = s.create('homepage', { tagline: 'Hi' });
  assert.equal(h.documentId, 'single');
  assert.throws(() => s.create('homepage', { tagline: 'Again' }), /single type/);
  assert.equal(s.update('homepage', 'single', { tagline: 'Hello' }).data['tagline'], 'Hello');
});

// ------------------------------------------------------------ draft and publish

test('publish demands what a draft did not; publishing freezes a copy; editing makes it modified; discard goes back', () => {
  const s = make();
  const a = s.create('article', {});
  assert.throws(() => s.publish('article', a.documentId), (e: unknown) => e instanceof ValidationFailed && e.problems.some((p) => p.path === 'title' && p.message === 'is required'));
  s.update('article', a.documentId, { title: 'First' });
  const [p] = s.publish('article', a.documentId);
  assert.equal(p!.status, 'published');
  assert.ok(p!.publishedAt !== null);
  s.update('article', a.documentId, { title: 'First, revised' });
  assert.equal(s.get('article', a.documentId)!.status, 'modified');
  assert.equal(s.get('article', a.documentId)!.data['title'], 'First, revised');
  assert.equal(s.get('article', a.documentId, { status: 'published' })!.data['title'], 'First');
  const back = s.discardDraft('article', a.documentId);
  assert.equal(back.data['title'], 'First');
  assert.equal(back.status, 'published');
});

test('unpublish removes the published copy; reading published then finds nothing; a never-published draft cannot be discarded', () => {
  const s = make();
  const a = s.create('article', { title: 'T' });
  assert.equal(s.get('article', a.documentId, { status: 'published' }), undefined);
  assert.throws(() => s.discardDraft('article', a.documentId), /nothing is published/);
  s.publish('article', a.documentId);
  assert.ok(s.get('article', a.documentId, { status: 'published' }));
  const u = s.unpublish('article', a.documentId);
  assert.equal(u.status, 'draft');
  assert.equal(u.publishedAt, null);
  assert.equal(s.get('article', a.documentId, { status: 'published' }), undefined);
  assert.throws(() => s.publish('author', 'x'), /no draft and publish/);
});

test('list returns what a reader may see: drafts for editors, published only for the public site', () => {
  const s = make();
  const a = s.create('article', { title: 'Live' });
  s.create('article', { title: 'Hidden' });
  s.publish('article', a.documentId);
  assert.deepEqual(s.list('article').map((e) => e.data['title']), ['Live', 'Hidden']);
  assert.deepEqual(s.list('article', { status: 'published' }).map((e) => e.data['title']), ['Live']);
  assert.deepEqual(s.list('article', { where: (e) => e.status === 'draft' }).map((e) => e.data['title']), ['Hidden']);
});

test('private fields are left out when asked', () => {
  const s = make();
  const a = s.create('article', { title: 'T', internalNote: 'do not show' });
  assert.equal(s.get('article', a.documentId)!.data['internalNote'], 'do not show');
  assert.equal('internalNote' in s.get('article', a.documentId, { hidePrivate: true })!.data, false);
});

// ------------------------------------------------------------ localisation

test('locale variants: each has its own status; shared fields are copied on add and kept equal after', () => {
  const s = make();
  const en = s.create('article', { title: 'Hello', views: 5, kind: 'essay' });
  const fr = s.addLocale('article', en.documentId, 'fr', { title: 'Bonjour' });
  assert.equal(fr.documentId, en.documentId);
  assert.equal(fr.locale, 'fr');
  assert.equal(fr.data['views'], 5); // shared field copied from the default locale
  assert.equal(fr.data['kind'], 'news'); // localised fields do not carry over: the French one has its own default
  s.update('article', en.documentId, { views: 9 });
  assert.equal(s.get('article', en.documentId, { locale: 'fr' })!.data['views'], 9);
  s.update('article', en.documentId, { views: 10 }, { locale: 'fr' });
  assert.equal(s.get('article', en.documentId, { locale: 'en' })!.data['views'], 10);
  s.publish('article', en.documentId, { locale: 'fr' });
  assert.deepEqual(s.localesOf('article', en.documentId), [{ locale: 'en', status: 'draft' }, { locale: 'fr', status: 'published' }]);
});

test('adding a variant with a different shared value is refused, and so is a locale that is not enabled or a variant twice', () => {
  const s = make();
  const en = s.create('article', { title: 'Hello', views: 5 });
  assert.throws(() => s.addLocale('article', en.documentId, 'fr', { title: 'x', views: 6 }), /shared by every locale/);
  assert.throws(() => s.addLocale('article', en.documentId, 'es', { title: 'x' }), /not enabled/);
  s.addLocale('article', en.documentId, 'de', { title: 'Hallo' });
  assert.throws(() => s.addLocale('article', en.documentId, 'de', { title: 'again' }), /already has a de variant/);
  assert.throws(() => s.create('article', { title: 'x' }, { locale: 'zz' }), /not enabled/);
  assert.throws(() => s.addLocale('author', 'x', 'fr', {}), /not localized/);
  assert.throws(() => s.create('author', { name: 'x' }, { locale: 'fr' }), /not localized/);
});

test('reading with a fallback chain returns the first locale that has a variant, and says which', () => {
  const s = make();
  const en = s.create('article', { title: 'Hello' });
  s.addLocale('article', en.documentId, 'de', { title: 'Hallo' });
  assert.equal(s.get('article', en.documentId, { locale: 'fr' }), undefined);
  const fb = s.get('article', en.documentId, { locale: 'fr', fallback: ['de', 'en'] })!;
  assert.equal(fb.locale, 'de');
  assert.equal(fb.data['title'], 'Hallo');
  assert.deepEqual(s.list('article', { locale: 'fr' }), []);
  assert.deepEqual(s.list('article', { locale: 'fr', fallback: ['en'] }).map((e) => e.locale), ['en']);
});

test('publishing all locales is all or nothing, and a missing required field names its locale', () => {
  const s = make();
  const en = s.create('article', { title: 'Hello' });
  s.addLocale('article', en.documentId, 'fr', {});
  assert.throws(() => s.publish('article', en.documentId, { allLocales: true }), (e: unknown) => e instanceof ValidationFailed && e.problems.some((p) => p.path === 'fr:title'));
  assert.equal(s.get('article', en.documentId, { locale: 'en' })!.status, 'draft'); // nothing was half published
  s.update('article', en.documentId, { title: 'Bonjour' }, { locale: 'fr' });
  assert.equal(s.publish('article', en.documentId, { allLocales: true }).length, 2);
});

test('deleting one variant keeps the others; deleting the last or the whole document removes it', () => {
  const s = make();
  const en = s.create('article', { title: 'Hello' });
  s.addLocale('article', en.documentId, 'fr', { title: 'Bonjour' });
  assert.equal(s.delete('article', en.documentId, { locale: 'fr' }), 1);
  assert.deepEqual(s.localesOf('article', en.documentId).map((l) => l.locale), ['en']);
  assert.equal(s.delete('article', en.documentId, { locale: 'en' }), 1);
  assert.equal(s.get('article', en.documentId), undefined);
  const b = s.create('article', { title: 'B' });
  s.addLocale('article', b.documentId, 'fr', {});
  assert.equal(s.delete('article', b.documentId), 2);
  assert.throws(() => s.delete('article', b.documentId), NotFoundError);
});

// ------------------------------------------------------------ components and zones in entries

test('an entry with a component, a repeatable component and a dynamic zone saves, publishes, and reads back as written', () => {
  const s = make();
  const body = [{ __component: 'blocks.hero', heading: 'Welcome' }, { __component: 'blocks.quote', text: 'Less is more', author: 'Mies' }, { __component: 'blocks.hero', heading: 'Again' }];
  const a = s.create('article', {
    title: 'Rich',
    seo: { metaTitle: 'Rich page' },
    links: [{ label: 'Home', url: 'https://example.org' }],
    body,
    author: 'a1',
    tags: ['a1', 'a2'],
    published_on: '2026-03-31',
  });
  s.publish('article', a.documentId);
  const got = s.get('article', a.documentId, { status: 'published' })!;
  assert.deepEqual(got.data['body'], body); // order kept
  assert.deepEqual(got.data['seo'], { metaTitle: 'Rich page' });
  const copy = got.data['body'] as { heading?: string }[];
  copy[0]!.heading = 'tampered';
  assert.equal((s.get('article', a.documentId, { status: 'published' })!.data['body'] as { heading: string }[])[0]!.heading, 'Welcome'); // reads are copies
  assert.throws(() => s.update('article', a.documentId, { seo: { metaTitle: 5 } }), (e: unknown) => e instanceof ValidationFailed && e.problems[0]!.path === 'seo.metaTitle');
});

test('a required component field makes publish fail until its required parts are present', () => {
  const s = make();
  const a = s.create('article', { title: 'X', seo: { metaDescription: 'only a description' } });
  assert.throws(() => s.publish('article', a.documentId), (e: unknown) => e instanceof ValidationFailed && e.problems.some((p) => p.path === 'seo.metaTitle'));
  s.update('article', a.documentId, { seo: { metaTitle: 'ok' } });
  assert.equal(s.publish('article', a.documentId)[0]!.status, 'published');
});
