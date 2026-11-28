import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AS, AS_PUBLIC, ContextLoader, FEDERATION_CONTEXT, JsonLdError, SECURITY, assertSameOrigin, asArray, compact, expand, hasType, idOf, idsOf, normalise, typesOf, type Json,
} from './index.ts';

const code = (c: string) => (e: unknown) => e instanceof JsonLdError && e.code === c;

const mastodonNote = (): Json => ({
  '@context': [AS, SECURITY, { toot: 'http://joinmastodon.org/ns#', sensitive: 'as:sensitive', Hashtag: 'as:Hashtag', discoverable: 'toot:discoverable' }],
  id: 'https://remote.example/users/ana/statuses/1/activity',
  type: 'Create',
  actor: 'https://remote.example/users/ana',
  published: '2024-05-01T12:00:00Z',
  to: [AS_PUBLIC],
  cc: ['https://remote.example/users/ana/followers'],
  object: {
    id: 'https://remote.example/users/ana/statuses/1',
    type: 'Note',
    attributedTo: 'https://remote.example/users/ana',
    content: '<p>Hello</p>',
    contentMap: { en: '<p>Hello</p>', fr: '<p>Bonjour</p>' },
    sensitive: false,
    tag: [{ type: 'Hashtag', href: 'https://remote.example/tags/hi', name: '#hi' }],
  },
});

test('expansion gives full IRIs, arrays everywhere, and typed values and references', async () => {
  const [a] = await expand(mastodonNote());
  const AS_NS = 'https://www.w3.org/ns/activitystreams#';
  assert.equal(a?.['@id'], 'https://remote.example/users/ana/statuses/1/activity');
  assert.deepEqual(a?.['@type'], [`${AS_NS}Create`]);
  assert.deepEqual(a?.[`${AS_NS}actor`], [{ '@id': 'https://remote.example/users/ana' }]);
  assert.deepEqual(a?.[`${AS_NS}published`], [{ '@value': '2024-05-01T12:00:00Z', '@type': 'http://www.w3.org/2001/XMLSchema#dateTime' }]);
  assert.deepEqual(a?.[`${AS_NS}to`], [{ '@id': AS_PUBLIC }]);
  const note = (a?.[`${AS_NS}object`] as Record<string, Json>[])[0] as Record<string, Json>;
  assert.deepEqual(note[`${AS_NS}content`], [{ '@value': '<p>Hello</p>' }, { '@value': '<p>Hello</p>', '@language': 'en' }, { '@value': '<p>Bonjour</p>', '@language': 'fr' }]);
  assert.deepEqual(note[`${AS_NS}sensitive`], [{ '@value': false }]);
});

test('compacting what was expanded gets back the same document, and keeps ids exactly', async () => {
  const doc = mastodonNote() as Record<string, Json>;
  const out = await compact(await expand(doc), FEDERATION_CONTEXT);
  assert.equal(out.id, 'https://remote.example/users/ana/statuses/1/activity');
  assert.equal(out.type, 'Create');
  assert.equal(out.actor, 'https://remote.example/users/ana');
  assert.deepEqual(out.to, AS_PUBLIC); // not shortened to as:Public
  assert.equal(out.published, '2024-05-01T12:00:00Z');
  const note = out.object as Record<string, Json>;
  assert.deepEqual([note.id, note.type, note.attributedTo], ['https://remote.example/users/ana/statuses/1', 'Note', 'https://remote.example/users/ana']);
  assert.deepEqual(note.contentMap, { en: '<p>Hello</p>', fr: '<p>Bonjour</p>' });
  assert.equal(note.sensitive, false);
  assert.equal(note.content, '<p>Hello</p>');
  assert.deepEqual(note.tag, { type: 'as:Hashtag', href: 'https://remote.example/tags/hi', name: '#hi' });
  assert.deepEqual(out['@context'], FEDERATION_CONTEXT);
});

test('extension terms that the context does not define survive a round trip under their own names', async () => {
  const doc = { '@context': AS, id: 'https://a.example/n', type: 'Note', quoteUrl: 'https://a.example/q', 'toot:x': 'y' } as Json;
  const out = await normalise(doc);
  assert.equal(out.quoteUrl, 'https://a.example/q');
  assert.equal(out.type, 'Note');
});

test('different spellings of the same document normalise to the same shape', async () => {
  const a = {
    '@context': AS,
    id: 'https://a.example/n/1',
    type: 'Note',
    attributedTo: { id: 'https://a.example/u', type: 'Person' },
    to: 'https://www.w3.org/ns/activitystreams#Public',
    content: 'hi',
  } as Json;
  const b = {
    '@context': ['https://www.w3.org/ns/activitystreams', SECURITY, { ex: 'https://ex.example/' }],
    '@id': 'https://a.example/n/1',
    '@type': ['Note'],
    'https://www.w3.org/ns/activitystreams#attributedTo': [{ '@id': 'https://a.example/u', '@type': 'Person' }],
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    content: 'hi',
  } as Json;
  const na = await normalise(a);
  const nb = await normalise(b);
  assert.deepEqual(na.attributedTo, { id: 'https://a.example/u', type: 'Person' });
  assert.deepEqual({ ...na, '@context': 0 }, { ...nb, '@context': 0 });
});

test('a context from a URL that is not allowed is refused, and nothing is fetched', async () => {
  let fetched = 0;
  const loader = new ContextLoader({ fetch: async () => (fetched++, { '@context': {} }) });
  await assert.rejects(expand({ '@context': 'https://evil.example/ctx', id: 'https://a.example/x' }, { loader }), code('context-not-allowed'));
  await assert.rejects(expand({ '@context': [AS, 'http://169.254.169.254/latest/meta-data'], id: 'https://a.example/x' }, { loader }), code('context-not-allowed'));
  await assert.rejects(expand({ '@context': { '@vocab': 'http://v.example/' }, id: 'https://a.example/x', n: { '@context': 'https://evil.example/c' } }, { loader }), code('context-not-allowed'));
  assert.equal(fetched, 0);
});

test('an allowed context is fetched once, cached until it expires, and checked on arrival', async () => {
  let t = 0;
  let fetched = 0;
  const ex = 'https://ex.example/context.jsonld';
  const loader = new ContextLoader({ allow: [ex], ttlMs: 1000, now: () => t, fetch: async () => (fetched++, { '@context': { ex: 'https://ex.example/ns#', score: { '@id': 'ex:score', '@type': 'http://www.w3.org/2001/XMLSchema#integer' } } }) });
  const doc = { '@context': ex, id: 'https://a.example/x', score: 5 };
  const [a] = await expand(doc, { loader });
  assert.deepEqual(a?.['https://ex.example/ns#score'], [{ '@value': 5, '@type': 'http://www.w3.org/2001/XMLSchema#integer' }]);
  await expand(doc, { loader });
  assert.equal(fetched, 1);
  await Promise.all([expand(doc, { loader }), expand(doc, { loader })]);
  assert.equal(fetched, 1);
  t = 1500;
  await expand(doc, { loader });
  assert.equal(fetched, 2);
  const bad = new ContextLoader({ allow: [ex], fetch: async () => ({ nope: 1 }) });
  await assert.rejects(expand(doc, { loader: bad }), code('context-invalid'));
  const huge = new ContextLoader({ allow: [ex], maxBytes: 50, fetch: async () => ({ '@context': { a: 'http://a.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }) });
  await assert.rejects(expand(doc, { loader: huge }), code('context-too-large'));
  const noFetch = new ContextLoader({ allow: [ex] });
  await assert.rejects(expand(doc, { loader: noFetch }), code('context-unavailable'));
  assert.equal(loader.size(), 1);
});

test('given documents are served without a fetch, and a context cycle is caught', async () => {
  const a = 'https://ex.example/a';
  const b = 'https://ex.example/b';
  const loader = new ContextLoader({ documents: { [a]: { '@context': [b, { x: 'https://ex.example/x' }] }, [b]: { '@context': [a] } } });
  await assert.rejects(expand({ '@context': a, id: 'https://a.example/n', x: 'v' }, { loader }), code('context-cycle'));
  const deep = new ContextLoader({ documents: { 'https://ex.example/1': { '@context': 'https://ex.example/2' }, 'https://ex.example/2': { '@context': 'https://ex.example/3' }, 'https://ex.example/3': { '@context': 'https://ex.example/4' }, 'https://ex.example/4': { '@context': 'https://ex.example/5' }, 'https://ex.example/5': { '@context': 'https://ex.example/6' }, 'https://ex.example/6': { '@context': {} } } });
  await assert.rejects(expand({ '@context': 'https://ex.example/1', id: 'https://a.example/n' }, { loader: deep }), code('context-depth'));
});

test('a hostile context cannot redefine keywords, use forbidden names, or make a term refer to itself', async () => {
  const bad = async (ctx: Json, c: string) => assert.rejects(expand({ '@context': ctx, id: 'https://a.example/n' }), code(c), JSON.stringify(ctx));
  await bad({ '@id': 'x:y' }, 'keyword-redefinition');
  await bad({ '@type': { '@id': 'http://x.example/t' } }, 'keyword-redefinition');
  await bad({ __proto__x: 1 }, 'invalid-term');
  await bad({ a: 'b', b: 'a' }, 'cyclic-iri-mapping');
  await bad({ a: 'a' }, 'cyclic-iri-mapping');
  await bad({ a: 5 }, 'invalid-term');
  await bad({ a: { '@id': 'http://x.example/a', '@container': '@index' } }, 'unsupported');
  await bad({ a: { '@id': 'http://x.example/a', '@reverse': 'http://x.example/b' } }, 'unsupported');
  await bad({ a: { '@id': 'http://x.example/a', '@context': {} } }, 'unsupported');
  await bad({ a: { '@id': 'http://x.example/a', '@type': '@json' } }, 'unsupported');
  await bad({ a: { '@id': 'http://x.example/a', bogus: 1 } }, 'invalid-term');
  await bad({ plain: {} }, 'invalid-term'); // no IRI and no @vocab
  await bad({ '@vocab': 5 }, 'context-invalid');
  await bad(5 as unknown as Json, 'context-invalid');
  assert.deepEqual(Object.getPrototypeOf(await normalise({ '@context': AS, id: 'https://a.example/n', type: 'Note' })), Object.prototype);
  await assert.rejects(expand({ '@context': { constructor: 'http://x.example/c' }, id: 'https://a.example/n' }), code('invalid-term'));
});

test('the original context is not weakened by a later one: null resets, and terms can be blocked', async () => {
  const [a] = await expand({ '@context': [AS, { name: null }], id: 'https://a.example/n', type: 'Note', name: 'dropped', content: 'kept' });
  assert.equal(a?.['https://www.w3.org/ns/activitystreams#name'], undefined);
  assert.deepEqual(a?.['https://www.w3.org/ns/activitystreams#content'], [{ '@value': 'kept' }]);
  const [b] = await expand({ '@context': [AS, null, { x: 'http://x.example/x' }], id: 'https://a.example/n', type: 'Note', x: 1, content: 'gone' });
  assert.deepEqual(Object.keys(b ?? {}).sort(), ['http://x.example/x']); // id, type and content are no longer terms
});

test('without @vocab a property that is not a term is dropped; with a prefix it is kept', async () => {
  const [a] = await expand({ '@context': { ex: 'http://ex.example/', known: 'ex:known' }, '@id': 'http://a.example/n', known: 1, unknown: 2, 'ex:other': 3 });
  assert.deepEqual(Object.keys(a ?? {}).sort(), ['@id', 'http://ex.example/known', 'http://ex.example/other']);
});

test('compact IRIs, @vocab, @base, languages and lists expand and compact', async () => {
  const doc = {
    '@context': { '@vocab': 'http://v.example/', '@base': 'http://b.example/dir/', '@language': 'en', schema: 'http://schema.org/', author: { '@id': 'schema:author', '@type': '@id' }, items: { '@id': 'http://v.example/items', '@container': '@list' } },
    '@id': 'doc1',
    '@type': 'Thing',
    'schema:name': 'Title',
    author: 'people/ana',
    items: ['a', 'b'],
    other: { '@value': 'bonjour', '@language': 'fr' },
  } as Json;
  const [n] = await expand(doc);
  assert.equal(n?.['@id'], 'http://b.example/dir/doc1');
  assert.deepEqual(n?.['@type'], ['http://v.example/Thing']);
  assert.deepEqual(n?.['http://schema.org/name'], [{ '@value': 'Title', '@language': 'en' }]);
  assert.deepEqual(n?.['http://schema.org/author'], [{ '@id': 'http://b.example/dir/people/ana' }]);
  assert.deepEqual(n?.['http://v.example/items'], [{ '@list': [{ '@value': 'a', '@language': 'en' }, { '@value': 'b', '@language': 'en' }] }]);
  assert.deepEqual(n?.['http://v.example/other'], [{ '@value': 'bonjour', '@language': 'fr' }]);
  const back = await compact([n as NonNullable<typeof n>], doc && (doc as Record<string, Json>)['@context'] as Json);
  assert.equal(back['schema:name'] === undefined, false);
  assert.deepEqual(back.items, ['a', 'b']);
  assert.equal(back.author, 'http://b.example/dir/people/ana');
  assert.equal(back.type === undefined && back['@type'] === 'Thing', true);
});

test('ordered collections keep their order as a list', async () => {
  const doc = { '@context': AS, id: 'https://a.example/outbox', type: 'OrderedCollection', totalItems: 2, orderedItems: [{ id: 'https://a.example/2', type: 'Note' }, 'https://a.example/1'] } as Json;
  const out = await normalise(doc);
  assert.equal(out.totalItems, 2);
  assert.deepEqual(out.orderedItems, [{ id: 'https://a.example/2', type: 'Note' }, 'https://a.example/1']);
  const single = await normalise({ ...(doc as object), orderedItems: ['https://a.example/1'] } as Json);
  assert.deepEqual(single.orderedItems, ['https://a.example/1']); // a list of one stays a list
});

test('several top level nodes make a graph, and a document with @graph expands to its nodes', async () => {
  const graph = { '@context': AS, '@graph': [{ id: 'https://a.example/1', type: 'Note' }, { id: 'https://a.example/2', type: 'Note' }] } as Json;
  assert.equal((await expand(graph)).length, 2);
  const out = await normalise(graph);
  assert.deepEqual((out['@graph'] as Record<string, Json>[]).map((n) => n.id), ['https://a.example/1', 'https://a.example/2']);
  assert.deepEqual(await expand([{ '@context': AS, id: 'https://a.example/1', type: 'Note' }, { '@context': AS, id: 'https://a.example/2', type: 'Note' }]).then((x) => x.length), 2);
  await assert.rejects(normalise({ '@context': AS } as Json), code('empty'));
});

test('invalid documents are refused: bad ids, types, value objects, keywords', async () => {
  const bad = (doc: Json, c: string) => assert.rejects(expand({ '@context': AS, ...(doc as object) } as Json), code(c), JSON.stringify(doc));
  await bad({ id: 5 }, 'invalid-id');
  await bad({ id: 'https://a.example/x', type: 5 }, 'invalid-type');
  await bad({ id: 'https://a.example/x', name: { '@value': { no: 1 } } }, 'invalid-value-object');
  await bad({ id: 'https://a.example/x', name: { '@value': 'x', '@language': 'en', '@type': 'http://t.example/' } }, 'invalid-value-object');
  await bad({ id: 'https://a.example/x', name: { '@value': 5, '@language': 'en' } }, 'invalid-language-tagged-value');
  await bad({ id: 'https://a.example/x', '@bogus': 1 }, 'invalid-keyword');
  await bad({ id: 'https://a.example/x', '@reverse': {} }, 'unsupported');
  await bad({ id: 'https://a.example/x', contentMap: { en: 5 } }, 'invalid-language-map');
  await assert.rejects(expand('nope' as unknown as Json), code('invalid-document'));
});

test('limits stop a document that nests too deep or has too many nodes', async () => {
  let deep: Json = { id: 'https://a.example/leaf', type: 'Note' };
  for (let i = 0; i < 40; i++) deep = { id: `https://a.example/${i}`, type: 'Note', object: deep };
  await assert.rejects(expand({ '@context': AS, ...(deep as object) } as Json), code('too-deep'));
  await expand({ '@context': AS, ...(deep as object) } as Json, { limits: { maxDepth: 100 } });
  const wide = { '@context': AS, id: 'https://a.example/c', type: 'Collection', items: Array.from({ length: 100 }, (_, i) => ({ id: `https://a.example/${i}`, type: 'Note' })) } as Json;
  await assert.rejects(expand(wide, { limits: { maxNodes: 50 } }), code('too-too-large'.slice(4)));
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, `http://x.example/${i}`]));
  await assert.rejects(expand({ '@context': many, id: 'https://a.example/x' }, { limits: { maxTerms: 10 } }), code('context-too-large'));
});

test('helpers read ids and types the way the normal form has them, or the raw form', () => {
  assert.equal(idOf('https://a.example/1'), 'https://a.example/1');
  assert.equal(idOf({ id: 'https://a.example/2' }), 'https://a.example/2');
  assert.equal(idOf({ '@id': 'https://a.example/3' }), 'https://a.example/3');
  assert.equal(idOf({ name: 'x' }), undefined);
  assert.equal(idOf(5), undefined);
  assert.deepEqual(typesOf({ type: 'Note' }), ['Note']);
  assert.deepEqual(typesOf({ '@type': ['Note', 'Mention'] }), ['Note', 'Mention']);
  assert.deepEqual(typesOf('x'), []);
  assert.equal(hasType({ type: ['Person', 'Service'] }, 'Application', 'Service'), true);
  assert.equal(hasType({ type: 'Note' }, 'Person'), false);
  assert.deepEqual(idsOf(['https://a.example/1', { id: 'https://a.example/2' }, { name: 'no id' }, 7]), ['https://a.example/1', 'https://a.example/2']);
  assert.deepEqual(idsOf(undefined), []);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray(['a']), ['a']);
  assert.deepEqual(asArray('a'), ['a']);
});

test('a document may only claim an id on the origin it came from', () => {
  assertSameOrigin({ id: 'https://remote.example/users/ana' }, 'https://remote.example/users/ana');
  assertSameOrigin({ id: 'https://remote.example/users/ana' }, 'https://remote.example/inbox#frag');
  assert.throws(() => assertSameOrigin({ id: 'https://evil.example/users/ana' }, 'https://remote.example/users/ana'), code('origin-mismatch'));
  assert.throws(() => assertSameOrigin({ id: 'http://remote.example/users/ana' }, 'https://remote.example/users/ana'), code('origin-mismatch'));
  assert.throws(() => assertSameOrigin({ id: 'https://remote.example:8443/x' }, 'https://remote.example/x'), code('origin-mismatch'));
  assert.throws(() => assertSameOrigin({ name: 'x' }, 'https://remote.example/'), code('no-id'));
  assert.throws(() => assertSameOrigin({ id: 'not a url' }, 'https://remote.example/'), code('bad-id'));
});

test('a public key block normalises with the security context', async () => {
  const actor = {
    '@context': [AS, SECURITY],
    id: 'https://remote.example/users/ana',
    type: 'Person',
    preferredUsername: 'ana',
    inbox: 'https://remote.example/users/ana/inbox',
    endpoints: { sharedInbox: 'https://remote.example/inbox' },
    publicKey: { id: 'https://remote.example/users/ana#main-key', owner: 'https://remote.example/users/ana', publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' },
  } as Json;
  const n = await normalise(actor);
  const key = n.publicKey as Record<string, Json>;
  assert.deepEqual([key.id, key.owner], ['https://remote.example/users/ana#main-key', 'https://remote.example/users/ana']);
  assert.match(String(key.publicKeyPem), /^-----BEGIN PUBLIC KEY-----/);
  assert.equal((n.endpoints as Record<string, Json>).sharedInbox, 'https://remote.example/inbox');
  assert.equal(n.inbox, 'https://remote.example/users/ana/inbox');
});
