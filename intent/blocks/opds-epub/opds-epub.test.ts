import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipBuffer } from '../zip-write/index.ts';
import {
  EpubError, OpdsError, OPDS_ACQ, acquisitionFeed, buildEpub, chapters, entryFromEpub, navigationFeed, openEpub, openSearchDescription, opds2, pageLinks, parseClock, parseOpds, resolveHref, safeHref, toIsbn13,
} from './index.ts';
import type { BookEntry } from './index.ts';

const T = Date.parse('2026-03-01T10:00:00Z');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const book = (o: Partial<Parameters<typeof buildEpub>[0]> = {}) =>
  buildEpub({
    title: 'The Long Way & Back', identifier: 'urn:uuid:11111111-2222-3333-4444-555555555555', language: 'en-GB', creators: ['Ada Lovelace', 'Grace Hopper'], publisher: 'Small Press', date: '2019-03-04', description: 'A <b>fine</b> book.',
    subjects: ['Travel', 'Fiction'], series: { name: 'Roads', index: 2 }, modified: T, cover: { data: PNG, mediaType: 'image/png' },
    chapters: [{ title: 'Start', body: '<p>one</p>' }, { title: 'Middle & End', body: '<p>two</p>' }], ...o,
  });

const raw = (files: Record<string, string | Buffer>, order?: string[]) =>
  zipBuffer((order ?? Object.keys(files)).map((name) => ({ name, data: files[name]!, method: name === 'mimetype' ? ('store' as const) : ('deflate' as const) })), { now: new Date(T) });

const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const epub2 = (opf: string, extra: Record<string, string | Buffer> = {}) => raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER, 'OPS/book.opf': opf, ...extra });

const OPF2 = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>Old Book</dc:title><dc:creator opf:role="aut" opf:file-as="Doe, Jane">Jane Doe</dc:creator><dc:creator opf:role="trl">T. Ranslator</dc:creator>
<dc:identifier id="bid" opf:scheme="ISBN">0-306-40615-2</dc:identifier><dc:language>fr_CA</dc:language>
<meta name="cover" content="img"/><meta name="calibre:series" content="Saga"/><meta name="calibre:series_index" content="3.5"/></metadata>
<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="text/c%201.html" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.html" media-type="application/xhtml+xml"/><item id="img" href="cover.jpg" media-type="image/jpeg"/></manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2" linear="no"/><itemref idref="ghost"/></spine></package>`;
const NCX = `<?xml version="1.0"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd"><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="a" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="text/c%201.html"/><navPoint id="b" playOrder="2"><navLabel><text>Deep</text></navLabel><content src="text/c2.html#sec"/></navPoint></navPoint></navMap></ncx>`;

test('ISBN: validation and conversion', () => {
  assert.equal(toIsbn13('0-306-40615-2'), '9780306406157');
  assert.equal(toIsbn13('urn:isbn:978-0-306-40615-7'), '9780306406157');
  assert.equal(toIsbn13('080442957X'), '9780804429573');
  assert.equal(toIsbn13('0-306-40615-3'), undefined);
  assert.equal(toIsbn13('hello'), undefined);
});

test('resolveHref: relative, encoded, fragments, and no climbing out', () => {
  assert.deepEqual(resolveHref('OPS/book.opf', 'text/c%201.html#a'), { path: 'OPS/text/c 1.html', fragment: 'a' });
  assert.deepEqual(resolveHref('OPS/text/c.html', '../img/x.png?v=1'), { path: 'OPS/img/x.png' });
  assert.deepEqual(resolveHref('OPS/book.opf', '/abs.xhtml'), { path: 'abs.xhtml' });
  assert.deepEqual(resolveHref('a.opf', 'https://x.test/b'), { external: 'https://x.test/b' });
  assert.throws(() => resolveHref('a.opf', '../../etc/passwd'), EpubError);
  assert.throws(() => resolveHref('a/b.opf', 'x\\y'), EpubError);
  assert.throws(() => resolveHref('a.opf', '%ZZ'), EpubError);
});

test('parseClock reads the duration forms audiobooks use', () => {
  assert.equal(parseClock('1:02:03.5'), 3723.5);
  assert.equal(parseClock('02:03'), 123);
  assert.equal(parseClock('1949.357s'), 1949.357);
  assert.equal(parseClock('1h2min3s'), 3723);
  assert.equal(parseClock('1500ms'), 1.5);
  assert.equal(parseClock('soon'), undefined);
});

test('a built EPUB reads back: metadata, spine, cover, nav', async () => {
  const e = openEpub(await book());
  assert.equal(e.version, '3.0');
  assert.equal(e.metadata.title, 'The Long Way & Back');
  assert.deepEqual(e.metadata.creators.map((c) => c.name), ['Ada Lovelace', 'Grace Hopper']);
  assert.equal(e.metadata.language, 'en-gb');
  assert.equal(e.metadata.publisher, 'Small Press');
  assert.equal(e.metadata.date, '2019-03-04');
  assert.equal(e.metadata.description, 'A <b>fine</b> book.'.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  assert.deepEqual(e.metadata.subjects, ['Travel', 'Fiction']);
  assert.deepEqual(e.metadata.series, { name: 'Roads', index: 2 });
  assert.equal(e.metadata.modified, '2026-03-01T10:00:00Z');
  assert.equal(e.metadata.uniqueIdentifier, 'urn:uuid:11111111-2222-3333-4444-555555555555');
  assert.deepEqual(e.spine.map((s) => s.path), ['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml']);
  assert.equal(e.cover?.path, 'OEBPS/cover.png');
  assert.deepEqual(e.read(e.cover!.path), PNG);
  assert.equal(e.tocSource, 'nav');
  assert.deepEqual(e.toc.map((t) => t.title), ['Start', 'Middle & End']);
  assert.deepEqual(chapters(e).map((c) => c.title), ['Start', 'Middle & End']);
  assert.deepEqual(e.warnings, []);
  assert.equal(e.drm, false);
  assert.equal(e.isAudiobook, false);
});

test('an EPUB 2 book: roles, file-as, ISBN, calibre series, meta cover, NCX with fragments', async () => {
  const e = openEpub(await epub2(OPF2, { 'OPS/toc.ncx': NCX, 'OPS/cover.jpg': 'jpg', 'OPS/text/c 1.html': '<html/>', 'OPS/text/c2.html': '<html/>' }));
  assert.equal(e.version, '2.0');
  assert.deepEqual(e.metadata.creators, [{ name: 'Jane Doe', role: 'aut', fileAs: 'Doe, Jane' }, { name: 'T. Ranslator', role: 'trl' }]);
  assert.equal(e.metadata.isbn, '9780306406157');
  assert.equal(e.metadata.uniqueIdentifier, '0-306-40615-2');
  assert.equal(e.metadata.language, 'fr-ca');
  assert.deepEqual(e.metadata.series, { name: 'Saga', index: 3.5 });
  assert.equal(e.cover?.path, 'OPS/cover.jpg');
  assert.deepEqual(e.spine.map((s) => [s.path, s.linear]), [['OPS/text/c 1.html', true], ['OPS/text/c2.html', false]]);
  assert.ok(e.warnings.some((w) => /ghost/.test(w)));
  assert.equal(e.tocSource, 'ncx');
  assert.equal(e.toc[0]!.title, 'Part One');
  assert.equal(e.toc[0]!.path, 'OPS/text/c 1.html');
  assert.deepEqual(e.toc[0]!.children.map((c) => [c.title, c.path, c.fragment]), [['Deep', 'OPS/text/c2.html', 'sec']]);
});

test('EPUB 3 refinements: subtitle, collection, narrator, duration, file-as, role', async () => {
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="u">urn:isbn:9780306406157</dc:identifier><dc:title id="t1">Big Title</dc:title><meta refines="#t1" property="title-type">main</meta>
<dc:title id="t2">The Small Part</dc:title><meta refines="#t2" property="title-type">subtitle</meta>
<dc:creator id="a1">Zed Writer</dc:creator><meta refines="#a1" property="role" scheme="marc:relators">aut</meta><meta refines="#a1" property="file-as">Writer, Zed</meta>
<dc:contributor id="n1">Una Voice</dc:contributor><meta refines="#n1" property="role">nrt</meta>
<dc:language>en</dc:language><meta property="belongs-to-collection" id="c">Epics</meta><meta refines="#c" property="collection-type">series</meta><meta refines="#c" property="group-position">1</meta>
<meta property="media:duration">1:30:00</meta><meta refines="#a1" property="media:duration">0:10:00</meta></metadata>
<manifest><item id="a1x" href="a.mp3" media-type="audio/mpeg"/><item id="a2x" href="b.mp3" media-type="audio/mpeg"/></manifest><spine><itemref idref="a1x"/><itemref idref="a2x"/></spine></package>`;
  const e = openEpub(await epub2(opf));
  assert.equal(e.metadata.title, 'Big Title');
  assert.equal(e.metadata.subtitle, 'The Small Part');
  assert.deepEqual(e.metadata.creators, [{ name: 'Zed Writer', role: 'aut', fileAs: 'Writer, Zed' }]);
  assert.deepEqual(e.metadata.narrators, ['Una Voice']);
  assert.deepEqual(e.metadata.series, { name: 'Epics', index: 1 });
  assert.equal(e.metadata.durationSec, 5400);
  assert.equal(e.metadata.isbn, '9780306406157');
  assert.equal(e.isAudiobook, true);
  assert.equal(entryFromEpub(e, { id: 'x', updated: T, downloadHref: '/b' }).title, 'Big Title: The Small Part');
});

test('container problems are named', async () => {
  assert.throws(() => openEpub(Buffer.from('not a zip')), EpubError);
  await assert.rejects(async () => openEpub(await raw({ 'META-INF/container.xml': CONTAINER })), /no mimetype/);
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'text/plain' })), /not application\/epub\+zip/);
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip' })), /container\.xml/);
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': '<container><rootfiles/></container>' })), /names no package/);
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER })), /not in the archive/);
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER, 'OPS/book.opf': '<package' })), /not well-formed/);
  const c2 = CONTAINER.replace('OPS/book.opf', '../../x.opf');
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': c2 })), /climbs out/);
});

test('a mimetype that is not first or is compressed only warns', async () => {
  const z = await raw({ 'META-INF/container.xml': CONTAINER, mimetype: 'application/epub+zip', 'OPS/book.opf': OPF2 }, ['META-INF/container.xml', 'mimetype', 'OPS/book.opf']);
  assert.ok(openEpub(z).warnings.some((w) => /not the first/.test(w)));
});

test('hostile XML and archives: DTD with entities, bombs, big entries', async () => {
  const evil = OPF2.replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE package [<!ENTITY x SYSTEM "file:///etc/passwd">]>');
  await assert.rejects(async () => openEpub(await raw({ mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER, 'OPS/book.opf': evil })), /not well-formed/);
  const bomb = await epub2(OPF2, { 'OPS/zeros.bin': Buffer.alloc(5_000_000) });
  const e = openEpub(bomb);
  assert.throws(() => e.read('OPS/zeros.bin'), /thousand times/);
  assert.throws(() => openEpub(bomb, { maxEntryBytes: 1000 }).read('OPS/zeros.bin'), /larger than/);
  assert.throws(() => openEpub(bomb, { maxEntries: 2 }), /too many files/);
  assert.throws(() => openEpub(bomb, { maxTotalBytes: 1000 }), /larger than allowed/);
  assert.throws(() => e.read('nope'), /not in the archive/);
});

test('encryption: font obfuscation is not DRM, anything else is', async () => {
  const enc = (alg: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${alg}"/><enc:CipherData><enc:CipherReference URI="x"/></enc:CipherData></enc:EncryptedData></encryption>`;
  assert.equal(openEpub(await epub2(OPF2, { 'META-INF/encryption.xml': enc('http://www.idpf.org/2008/embedding') })).drm, false);
  assert.equal(openEpub(await epub2(OPF2, { 'META-INF/encryption.xml': enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc') })).drm, true);
  assert.equal(openEpub(await epub2(OPF2, { 'META-INF/rights.xml': '<rights/>' })).drm, true);
});

test('writing refuses a book with nothing to read', async () => {
  await assert.rejects(book({ chapters: [] }), EpubError);
  await assert.rejects(book({ title: ' ' }), EpubError);
  await assert.rejects(book({ language: 'not a tag' }), EpubError);
  await assert.rejects(book({ modified: 'yesterday' }), EpubError);
});

const bk = (n: number, o: Partial<BookEntry> = {}): BookEntry => ({
  id: `urn:book:${n}`, title: `Book ${n} <1>`, updated: T, authors: [{ name: 'A & B' }], summary: 'Fun & games', categories: ['Fiction'], language: 'en', publisher: 'P', issued: '2020',
  identifiers: ['urn:isbn:9780306406157'], cover: '/c/1.png', thumbnail: '/t/1.jpg', series: { name: 'Roads', index: 2, href: '/series/roads' },
  acquisitions: [{ href: '/dl/1.epub', type: 'application/epub+zip', length: 1234 }, { href: '/buy/1', type: 'text/html', kind: 'buy', price: { value: '4.99', currency: 'EUR' } }], ...o,
});
const HEAD = { id: 'urn:cat:all', title: 'All "books"', updated: T, self: '/opds/all?page=2', start: '/opds', up: '/opds', search: '/opds/search.xml' };

test('navigation feed: escapes, kinds, rels, counts, and reads back', () => {
  const x = navigationFeed(HEAD, [
    { id: 'urn:n:1', title: 'New & noteworthy', updated: T, href: '/opds/new', kind: 'acquisition', rel: 'new', content: '5 <books>', count: 5 },
    { id: 'urn:n:2', title: 'Authors', updated: T, href: '/opds/authors' },
  ]);
  assert.match(x, /title>All "books"<\/title>/);
  assert.match(x, /New &amp; noteworthy/);
  assert.match(x, /rel="http:\/\/opds-spec\.org\/sort\/new"/);
  assert.match(x, /thr:count="5"/);
  const f = parseOpds(x, 'https://lib.test/opds');
  assert.equal(f.kind, 'navigation');
  assert.equal(f.title, 'All "books"');
  assert.deepEqual(f.entries.map((e) => e.title), ['New & noteworthy', 'Authors']);
  assert.equal(f.entries[0]!.links[0]!.href, 'https://lib.test/opds/new');
  assert.equal(f.entries[0]!.links[0]!.count, 5);
  assert.equal(f.entries[0]!.isBook, false);
});

test('acquisition feed: books, facets, paging, and reads back', () => {
  const paging = { page: 2, pageSize: 2, total: 5, href: (n: number) => `/opds/all?page=${n}` };
  const x = acquisitionFeed(HEAD, [bk(1), bk(2, { cover: '', thumbnail: '', series: undefined as never })], { paging, facets: [{ title: 'English', href: '/opds/all?lang=en', group: 'Language', active: true, count: 3 }, { title: 'French', href: '/opds/all?lang=fr', group: 'Language' }] });
  assert.match(x, /opensearch:totalResults>5</);
  assert.match(x, /opensearch:startIndex>3</);
  assert.match(x, /opds:facetGroup="Language" opds:activeFacet="true" thr:count="3"/);
  assert.match(x, /<opds:price currencycode="EUR">4\.99<\/opds:price>/);
  assert.match(x, /length="1234"/);
  const f = parseOpds(x, 'https://lib.test/opds/all?page=2');
  assert.equal(f.kind, 'acquisition');
  assert.equal(f.totalResults, 5);
  assert.equal(f.next, 'https://lib.test/opds/all?page=3');
  assert.deepEqual(f.entries[0]!.authors, ['A & B']);
  assert.equal(f.entries[0]!.title, 'Book 1 <1>');
  assert.ok(f.entries[0]!.isBook);
  const dl = f.entries[0]!.links.find((l) => l.rel === 'http://opds-spec.org/acquisition')!;
  assert.deepEqual([dl.href, dl.type, dl.length], ['https://lib.test/dl/1.epub', 'application/epub+zip', 1234]);
  assert.equal(f.links.filter((l) => l.facetGroup === 'Language').length, 2);
  assert.equal(f.links.find((l) => l.title === 'English')!.active, true);
  assert.equal(f.dropped, 0);
});

test('paging links: edges and errors', () => {
  const h = (n: number) => `/p/${n}`;
  assert.deepEqual(pageLinks({ page: 1, pageSize: 10, total: 0, href: h }).map((l) => l.rel), ['first', 'last']);
  assert.deepEqual(pageLinks({ page: 1, pageSize: 10, total: 25, href: h }).map((l) => l.rel), ['first', 'next', 'last']);
  assert.deepEqual(pageLinks({ page: 3, pageSize: 10, total: 25, href: h }).map((l) => l.rel), ['first', 'previous', 'last']);
  assert.throws(() => pageLinks({ page: 4, pageSize: 10, total: 25, href: h }), OpdsError);
  assert.throws(() => pageLinks({ page: 0, pageSize: 10, total: 25, href: h }), OpdsError);
});

test('links are checked on the way out and the way in', () => {
  assert.equal(safeHref('/a b'.replace(' ', '%20')), '/a%20b');
  assert.throws(() => safeHref('javascript:alert(1)'), OpdsError);
  assert.throws(() => safeHref('data:text/html,x'), OpdsError);
  assert.throws(() => safeHref('/a b'), OpdsError);
  assert.throws(() => acquisitionFeed(HEAD, [bk(1, { cover: 'javascript:x' })]), OpdsError);
  assert.throws(() => acquisitionFeed(HEAD, [bk(1, { acquisitions: [] })]), /nothing to download/);
  assert.throws(() => acquisitionFeed({ ...HEAD, updated: 'someday' }, []), OpdsError);
  const bad = acquisitionFeed(HEAD, [bk(1)]).replace('/dl/1.epub', 'file:///etc/passwd').replace('/c/1.png', 'javascript:alert(1)'.replace(/:/, '&#58;'));
  const f = parseOpds(bad, 'https://lib.test/');
  assert.equal(f.dropped, 2);
  assert.ok(!f.entries[0]!.links.some((l) => /^(file|javascript)/.test(l.href)));
});

test('parseOpds refuses what is not a catalogue and DTDs', () => {
  assert.throws(() => parseOpds('<rss/>', 'https://x.test/'), /not an Atom feed/);
  assert.throws(() => parseOpds('nope', 'https://x.test/'), OpdsError);
  assert.throws(() => parseOpds('<!DOCTYPE feed [<!ENTITY a "b">]><feed xmlns="http://www.w3.org/2005/Atom"/>', 'https://x.test/'), OpdsError);
});

test('OpenSearch description and an entry made from a real EPUB', async () => {
  const d = openSearchDescription('My "Library"', '/opds/search?q={searchTerms}&p={startPage?}');
  assert.match(d, /ShortName>My "Library"</);
  assert.match(d, /template="\/opds\/search\?q=\{searchTerms\}&amp;p=\{startPage\?\}"/);
  assert.throws(() => openSearchDescription('x', '/search'), OpdsError);
  const e = openEpub(await book());
  const entry = entryFromEpub(e, { id: 'urn:b:1', updated: T, downloadHref: '/dl/1', length: 99, coverHref: '/c/1.png' });
  assert.deepEqual(entry.authors, [{ name: 'Ada Lovelace' }, { name: 'Grace Hopper' }]);
  assert.deepEqual(entry.series, { name: 'Roads', index: 2 });
  const f = parseOpds(acquisitionFeed(HEAD, [entry]), 'https://lib.test/');
  assert.equal(f.entries[0]!.title, 'The Long Way & Back');
  assert.ok(f.entries[0]!.links.some((l) => l.rel === 'http://opds-spec.org/image' && l.type === 'image/png'));
  assert.equal(OPDS_ACQ.includes('acquisition'), true);
});

test('OPDS 2.0 JSON carries the same feed', () => {
  const j = opds2(HEAD, { books: [bk(1)], paging: { page: 1, pageSize: 2, total: 5, href: (n) => `/o?page=${n}` }, facets: [{ title: 'English', href: '/o?l=en', group: 'Language', count: 3 }], nav: [{ id: 'x', title: 'Home', updated: T, href: '/o', rel: 'start' }] });
  assert.equal(j.metadata.numberOfItems, 5);
  assert.deepEqual(j.links.map((l) => l.rel), ['self', 'first', 'next', 'last']);
  assert.equal(j.publications![0]!.metadata.title, 'Book 1 <1>');
  assert.deepEqual(j.publications![0]!.links.map((l) => l.rel), ['http://opds-spec.org/acquisition', 'http://opds-spec.org/acquisition/buy']);
  assert.equal(j.publications![0]!.images!.length, 2);
  assert.equal(j.facets![0]!.links[0]!.properties!.numberOfItems, 3);
  assert.equal(j.navigation![0]!.rel, 'start');
  assert.throws(() => opds2({ ...HEAD, self: 'javascript:1' }, {}), OpdsError);
});
