import assert from 'node:assert/strict';
import { test } from 'node:test';
import { child, children, parseXml } from '../dav/index.ts';
import { BadVCard, CardDav, makeCard, parseVCard, textOf, writeVCard } from './index.ts';
import type { Reply } from './index.ts';

const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"';
const BOOK = '/addressbooks/ana/contacts/';

const setup = (o: ConstructorParameters<typeof CardDav>[0] = {}) => {
  const dav = new CardDav({ now: () => 1_800_000_000_000, ...o });
  dav.create(BOOK, { displayName: 'Contacts' });
  const req = (method: string, path: string, body = '', headers: Record<string, string> = {}): Reply => dav.handle({ method, path, headers, body });
  const put = (name: string, text: string, h: Record<string, string> = {}) => req('PUT', `${BOOK}${name}`, text, { 'content-type': 'text/vcard; charset=utf-8', ...h });
  return { dav, req, put };
};
const responses = (r: Reply) => children(parseXml(r.body), 'DAV:', 'response').map((x) => ({ href: child(x, 'DAV:', 'href')!.text, status: child(x, 'DAV:', 'status')?.text, el: x }));
const names = (r: Reply) => responses(r).map((x) => x.href.replace(BOOK, ''));
const query = (filter: string, attrs = '', extra = '', prop = '<d:getetag/>') => `<c:addressbook-query ${NS}><d:prop>${prop}</d:prop><c:filter${attrs}>${filter}</c:filter>${extra}</c:addressbook-query>`;

const ana = makeCard({ uid: 'u-ana', fn: 'Ana Álvarez', n: ['Álvarez', 'Ana'], emails: ['ana@example.org', 'a.alvarez@work.example'], tels: ['+1 555 0100'], org: 'Acme, Inc.' });
const bo = makeCard({ uid: 'u-bo', fn: 'Bo Straße', n: ['Straße', 'Bo'], emails: ['bo@example.org'], org: 'Globex' });
const cy = makeCard({ uid: 'u-cy', fn: 'Cy Jones', version: '3.0', n: ['Jones', 'Cy'], emails: ['cy@elsewhere.test'] });

test('a vCard is read with groups, parameters, folded lines and escapes, and written back the same', () => {
  const text = ['BEGIN:VCARD', 'VERSION:4.0', 'FN:Ana', ' María', 'item1.EMAIL;TYPE="work,home";PREF=1:ana@example.org', 'NOTE:one\\, two\; three\\nfour', 'ADR;TYPE=home:;;1 Main St;Dayton;OH;45402;USA', 'UID:abc', 'END:VCARD', ''].join('\r\n');
  const c = parseVCard(text);
  assert.equal(c.props.length, 6);
  assert.equal(textOf(c.props[1]!), 'AnaMaría', 'a fold continues the line');
  const email = c.props[2]!;
  assert.equal(email.group, 'item1');
  assert.deepEqual(email.params.TYPE, ['work', 'home']);
  assert.deepEqual(email.params.PREF, ['1']);
  assert.equal(textOf(c.props[3]!), 'one, two; three\nfour');
  assert.equal(textOf(c.props[4]!), ';;1 Main St;Dayton;OH;45402;USA');
  const again = parseVCard(writeVCard(c));
  assert.deepEqual(again, c);
});

test('writing folds long lines at 75 bytes without cutting a character in half', () => {
  const long = makeCard({ uid: 'x', fn: 'é'.repeat(100) });
  for (const line of long.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line.length.toString());
  const back = parseVCard(long);
  assert.equal(textOf(back.props.find((p) => p.name === 'FN')!), 'é'.repeat(100));
});

test('hostile vCards are refused: no begin or end, a second card, control characters, bad names, size', () => {
  const ok = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:A\r\nUID:1\r\nEND:VCARD\r\n';
  assert.doesNotThrow(() => parseVCard(ok));
  assert.throws(() => parseVCard('VERSION:4.0\r\nEND:VCARD'), /begins with/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nVERSION:4.0'), /ends with/);
  assert.throws(() => parseVCard(`${ok}${ok}`), BadVCard);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nBEGIN:VCARD\r\nEND:VCARD\r\nEND:VCARD'), /one vCard/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nFN:A\u0000B\r\nEND:VCARD'), /control/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nno colon here\r\nEND:VCARD'), /not a property/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nF N:x\r\nEND:VCARD'), /not a property name/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nTEL;TY PE=x:1\r\nEND:VCARD'), /not a parameter name/);
  assert.throws(() => parseVCard('BEGIN:VCARD\r\nTEL;TYPE="x:1\r\nEND:VCARD'), BadVCard);
  assert.throws(() => parseVCard(ok, { maxBytes: 20 }), /too large/);
  assert.throws(() => parseVCard(`BEGIN:VCARD\r\n${'A:1\r\n'.repeat(20)}END:VCARD`, { maxLines: 10 }), /too many lines/);
  const hostile = parseVCard('BEGIN:VCARD\r\nX-CONSTRUCTOR;CONSTRUCTOR=x;TOSTRING=y:1\r\nEND:VCARD').props[0]!;
  assert.equal(Object.getPrototypeOf(hostile.params), null, 'parameter names cannot reach the prototype');
  assert.deepEqual(Object.keys(hostile.params), ['CONSTRUCTOR', 'TOSTRING']);
});

test('OPTIONS advertises addressbook; MKCOL makes an address book from an extended MKCOL body and refuses other kinds', () => {
  const { req, dav } = setup();
  const o = req('OPTIONS', BOOK);
  assert.match(o.headers.dav!, /addressbook/);
  const body = (rt: string) => `<d:mkcol ${NS}><d:set><d:prop><d:resourcetype><d:collection/>${rt}</d:resourcetype><d:displayname>Friends</d:displayname><c:addressbook-description>People</c:addressbook-description></d:prop></d:set></d:mkcol>`;
  const made = req('MKCOL', '/addressbooks/ana/friends/', body('<c:addressbook/>'));
  assert.equal(made.status, 201);
  assert.equal(dav.book('/addressbooks/ana/friends/').displayName, 'Friends');
  assert.equal(dav.book('/addressbooks/ana/friends/').description, 'People');
  assert.equal(req('MKCOL', '/addressbooks/ana/friends/', body('<c:addressbook/>')).status, 405, 'it exists');
  const other = req('MKCOL', '/addressbooks/ana/x/', body(''));
  assert.equal(other.status, 403);
  assert.match(other.body, /valid-resourcetype/);
  assert.equal(req('MKCOL', '/elsewhere/x/', '').status, 404);
  assert.equal(req('MKCOL', '/addressbooks/../etc/', '').status, 404);
});

test('PUT stores a card with an ETag, and the preconditions of RFC 6352 are enforced with their DAV error elements', () => {
  const { put, req } = setup({ maxResourceBytes: 600 });
  const r = put('ana.vcf', ana);
  assert.equal(r.status, 201);
  assert.match(r.headers.etag!, /^"[0-9a-f]{16}"$/);
  assert.equal(put('ana.vcf', ana).status, 204, 'the same name again replaces');
  const dup = put('other.vcf', ana);
  assert.equal(dup.status, 403);
  assert.match(dup.body, /no-uid-conflict/);
  assert.match(dup.body, new RegExp(`${BOOK}ana.vcf`));
  assert.match(put('x.vcf', 'not a card').body, /supported-address-data/);
  assert.match(put('x.vcf', 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN:A\r\nUID:z\r\nEND:VCARD\r\n').body, /supported-address-data/);
  assert.match(put('x.vcf', 'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:z\r\nEND:VCARD\r\n').body, /valid-address-data/);
  assert.match(put('x.vcf', 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:A\r\nEND:VCARD\r\n').body, /valid-address-data/);
  assert.match(put('x.vcf', makeCard({ uid: 'big', fn: 'B'.repeat(700) })).body, /max-resource-size/);
  assert.equal(put('a/b.vcf', ana).status, 404, 'no such address book');
  assert.equal(put('..vcf', makeCard({ uid: 'q', fn: 'Q' })).status, 201, 'dots in a plain name are fine');
  assert.equal(put('bad name.vcf', makeCard({ uid: 'r', fn: 'R' })).status, 403);
  assert.equal(put('x.txt', makeCard({ uid: 's', fn: 'S' })).status, 403);
  assert.equal(req('PUT', `${BOOK}t.vcf`, makeCard({ uid: 't', fn: 'T' }), { 'content-type': 'text/plain' }).status, 415);
});

test('If-Match and If-None-Match protect against lost updates', () => {
  const { put, req } = setup();
  const etag = put('ana.vcf', ana).headers.etag!;
  assert.equal(put('ana.vcf', ana, { 'if-none-match': '*' }).status, 412);
  assert.equal(put('new.vcf', bo, { 'if-none-match': '*' }).status, 201);
  assert.equal(put('ana.vcf', ana.replace('Ana', 'Anna'), { 'if-match': '"stale"' }).status, 412);
  assert.equal(put('ana.vcf', ana.replace('Ana', 'Anna'), { 'if-match': etag }).status, 204);
  assert.equal(put('ghost.vcf', cy, { 'if-match': '*' }).status, 412);
  assert.equal(req('DELETE', `${BOOK}ana.vcf`, '', { 'if-match': etag }).status, 412, 'the card changed since');
  assert.equal(req('DELETE', `${BOOK}ana.vcf`, '', { 'if-match': req('GET', `${BOOK}ana.vcf`).headers.etag! }).status, 204);
  assert.equal(req('GET', `${BOOK}ana.vcf`).status, 404);
  assert.equal(req('DELETE', `${BOOK}ana.vcf`).status, 404);
});

test('GET and HEAD return the card with its version; PROPFIND lists the address book and its cards', () => {
  const { put, req } = setup();
  put('ana.vcf', ana);
  put('cy.vcf', cy);
  const g = req('GET', `${BOOK}cy.vcf`);
  assert.equal(g.headers['content-type'], 'text/vcard; charset=utf-8; version=3.0');
  assert.equal(g.body, cy);
  assert.equal(req('HEAD', `${BOOK}cy.vcf`).body, '');
  const pf = req('PROPFIND', BOOK, `<d:propfind ${NS}><d:prop><d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><c:supported-address-data/><c:max-resource-size/><d:getetag/></d:prop></d:propfind>`, { depth: '1' });
  assert.equal(pf.status, 207);
  const rs = responses(pf);
  assert.deepEqual(rs.map((r) => r.href), [BOOK, `${BOOK}ana.vcf`, `${BOOK}cy.vcf`]);
  const root = child(child(rs[0]!.el, 'DAV:', 'propstat')!, 'DAV:', 'prop')!;
  assert.ok(child(child(root, 'DAV:', 'resourcetype')!, 'urn:ietf:params:xml:ns:carddav', 'addressbook'));
  assert.equal(child(root, 'DAV:', 'displayname')!.text, 'Contacts');
  assert.equal(child(root, 'http://calendarserver.org/ns/', 'getctag')!.text, `${BOOK}@2`);
  assert.equal(child(root, 'DAV:', 'sync-token')!.text, 'urn:carddav-sync:2');
  assert.deepEqual(children(child(root, 'urn:ietf:params:xml:ns:carddav', 'supported-address-data')!, 'urn:ietf:params:xml:ns:carddav', 'address-data-type').map((t) => t.attrs.version), ['3.0', '4.0']);
  assert.equal(child(root, 'urn:ietf:params:xml:ns:carddav', 'max-resource-size')!.text, '1000000');
  assert.equal(req('PROPFIND', BOOK, '', { depth: 'infinity' }).status, 403);
  const missing = responses(req('PROPFIND', BOOK, `<d:propfind ${NS}><d:prop><d:nothing/></d:prop></d:propfind>`));
  assert.match(child(missing[0]!.el, 'DAV:', 'propstat')!.children.at(-1)!.text, /404/);
});

test('addressbook-query: contains, equals, starts-with, ends-with and negation, case-insensitive and across accents of case', () => {
  const { put, req } = setup();
  put('ana.vcf', ana);
  put('bo.vcf', bo);
  put('cy.vcf', cy);
  const pf = (name: string, tm: string, a = '') => `<c:prop-filter name="${name}"${a}>${tm}</c:prop-filter>`;
  const run = (f: string, attrs = '') => names(req('REPORT', BOOK, query(f, attrs)));
  assert.deepEqual(run(pf('FN', '<c:text-match>ANA</c:text-match>')), ['ana.vcf'], 'contains is the default and ignores case');
  assert.deepEqual(run(pf('FN', '<c:text-match match-type="equals">cy jones</c:text-match>')), ['cy.vcf']);
  assert.deepEqual(run(pf('FN', '<c:text-match match-type="equals">cy</c:text-match>')), []);
  assert.deepEqual(run(pf('EMAIL', '<c:text-match match-type="starts-with">bo@</c:text-match>')), ['bo.vcf']);
  assert.deepEqual(run(pf('EMAIL', '<c:text-match match-type="ends-with">.test</c:text-match>')), ['cy.vcf']);
  assert.deepEqual(run(pf('FN', '<c:text-match negate-condition="yes">ana</c:text-match>')), ['bo.vcf', 'cy.vcf']);
  assert.deepEqual(run(pf('FN', '<c:text-match>strasse</c:text-match>')), ['bo.vcf'], 'unicode-casemap folds ß to ss');
  assert.deepEqual(run(pf('FN', '<c:text-match collation="i;octet">strasse</c:text-match>')), []);
  assert.deepEqual(run(pf('FN', '<c:text-match collation="i;octet">Straße</c:text-match>')), ['bo.vcf']);
  assert.deepEqual(run(pf('FN', '<c:text-match collation="i;ascii-casemap">álvarez</c:text-match>')), [], 'ascii-casemap folds only a-z, so á is not Á');
  assert.deepEqual(run(pf('FN', '<c:text-match collation="i;ascii-casemap">ÁLVAREZ</c:text-match>')), ['ana.vcf']);
  assert.deepEqual(run(pf('FN', '<c:text-match>ÁLVAREZ</c:text-match>')), ['ana.vcf']);
  assert.deepEqual(run(pf('N', '<c:text-match match-type="starts-with">Jones;</c:text-match>')), ['cy.vcf'], 'a structured value is matched with its semicolons');
  assert.deepEqual(run(pf('ORG', '<c:text-match match-type="equals">Acme, Inc.</c:text-match>')), ['ana.vcf'], 'escapes are resolved first');
  assert.equal(req('REPORT', BOOK, query(pf('FN', '<c:text-match collation="i;nope">x</c:text-match>'))).status, 403);
  assert.equal(req('REPORT', BOOK, query(pf('FN', '<c:text-match match-type="regex">x</c:text-match>'))).status, 400);
});

test('prop-filter: is-not-defined, param-filter, and anyof against allof', () => {
  const { put, req } = setup();
  put('ana.vcf', ana);
  put('bo.vcf', bo);
  put('cy.vcf', cy);
  const run = (f: string, attrs = '') => names(req('REPORT', BOOK, query(f, attrs)));
  assert.deepEqual(run('<c:prop-filter name="TEL"><c:is-not-defined/></c:prop-filter>'), ['bo.vcf', 'cy.vcf']);
  assert.deepEqual(run('<c:prop-filter name="TEL"/>'), ['ana.vcf'], 'a prop-filter with no tests matches any card that has the property');
  assert.deepEqual(run('<c:prop-filter name="EMAIL"><c:param-filter name="TYPE"><c:text-match match-type="equals">work</c:text-match></c:param-filter></c:prop-filter>'), ['ana.vcf', 'bo.vcf', 'cy.vcf']);
  assert.deepEqual(run('<c:prop-filter name="TEL"><c:param-filter name="TYPE"><c:text-match>home</c:text-match></c:param-filter></c:prop-filter>'), []);
  assert.deepEqual(run('<c:prop-filter name="TEL"><c:param-filter name="PREF"><c:is-not-defined/></c:param-filter></c:prop-filter>'), ['ana.vcf']);
  const two = '<c:prop-filter name="FN"><c:text-match>ana</c:text-match></c:prop-filter><c:prop-filter name="EMAIL"><c:text-match>elsewhere</c:text-match></c:prop-filter>';
  assert.deepEqual(run(two, ' test="anyof"'), ['ana.vcf', 'cy.vcf']);
  assert.deepEqual(run(two, ' test="allof"'), []);
  const same = '<c:prop-filter name="EMAIL" test="allof"><c:text-match>ana</c:text-match><c:text-match>work.example</c:text-match></c:prop-filter>';
  assert.deepEqual(run(same), [], 'allof inside one property means one value must satisfy both');
  assert.deepEqual(run('<c:prop-filter name="EMAIL" test="anyof"><c:text-match>ana@</c:text-match><c:text-match>work.example</c:text-match></c:prop-filter>'), ['ana.vcf']);
  assert.deepEqual(names(req('REPORT', BOOK, query(''))), ['ana.vcf', 'bo.vcf', 'cy.vcf'], 'no prop-filter matches every card');
});

test('address-data returns only the properties asked for, and refuses conversions it cannot do', () => {
  const { put, req } = setup();
  put('ana.vcf', ana);
  const r = req('REPORT', BOOK, query('', '', '', '<d:getetag/><c:address-data><c:prop name="FN"/><c:prop name="email"/></c:address-data>'));
  const data = child(child(child(responses(r)[0]!.el, 'DAV:', 'propstat')!, 'DAV:', 'prop')!, 'urn:ietf:params:xml:ns:carddav', 'address-data')!.text;
  const card = parseVCard(data);
  assert.deepEqual(card.props.map((p) => p.name), ['VERSION', 'FN', 'EMAIL', 'EMAIL']);
  const all = req('REPORT', BOOK, query('', '', '', '<c:address-data/>'));
  assert.equal(child(child(child(responses(all)[0]!.el, 'DAV:', 'propstat')!, 'DAV:', 'prop')!, 'urn:ietf:params:xml:ns:carddav', 'address-data')!.text, ana);
  const conv = req('REPORT', BOOK, query('', '', '', '<c:address-data content-type="text/vcard" version="3.0"/>'));
  assert.equal(conv.status, 403);
  assert.match(conv.body, /supported-address-data-conversion/);
});

test('a limit returns that many matches and says there are more', () => {
  const { put, req } = setup();
  for (const [i, n] of ['a', 'b', 'c'].entries()) put(`${n}.vcf`, makeCard({ uid: `u${i}`, fn: `Person ${n}` }));
  const r = req('REPORT', BOOK, query('<c:prop-filter name="FN"><c:text-match>person</c:text-match></c:prop-filter>', '', '<c:limit><c:nresults>2</c:nresults></c:limit>'));
  const rs = responses(r);
  assert.deepEqual(rs.map((x) => x.href), [`${BOOK}a.vcf`, `${BOOK}b.vcf`, BOOK]);
  assert.match(rs[2]!.status!, /507/);
  const none = req('REPORT', BOOK, query('', '', '<c:limit><c:nresults>x</c:nresults></c:limit>'));
  assert.equal(none.status, 400);
  assert.equal(req('REPORT', BOOK, `<c:addressbook-query ${NS}><d:prop><d:getetag/></d:prop></c:addressbook-query>`).status, 400, 'a filter is required');
});

test('addressbook-multiget returns what was asked for and 404 for what is missing or outside the book', () => {
  const { put, req } = setup();
  put('ana.vcf', ana);
  const mg = `<c:addressbook-multiget ${NS}><d:prop><d:getetag/></d:prop><d:href>${BOOK}ana.vcf</d:href><d:href>${BOOK}gone.vcf</d:href><d:href>/addressbooks/bob/contacts/ana.vcf</d:href><d:href>${BOOK}../x.vcf</d:href></c:addressbook-multiget>`;
  const rs = responses(req('REPORT', BOOK, mg));
  assert.equal(rs.length, 4);
  assert.ok(child(rs[0]!.el, 'DAV:', 'propstat'));
  assert.deepEqual(rs.slice(1).map((r) => r.status), ['HTTP/1.1 404 Not Found', 'HTTP/1.1 404 Not Found', 'HTTP/1.1 404 Not Found']);
  assert.equal(req('REPORT', BOOK, `<c:addressbook-multiget ${NS}><d:href>%zz</d:href></c:addressbook-multiget>`).status, 400);
});

test('sync-collection: everything first, then only changes, deletions as 404, and an old or foreign token is refused', () => {
  const { put, req, dav } = setup({ logSize: 3 });
  const sync = (tok: string, extra = '') => req('REPORT', BOOK, `<d:sync-collection ${NS}><d:sync-token>${tok}</d:sync-token><d:sync-level>1</d:sync-level>${extra}<d:prop><d:getetag/></d:prop></d:sync-collection>`);
  put('a.vcf', makeCard({ uid: '1', fn: 'A' }));
  put('b.vcf', makeCard({ uid: '2', fn: 'B' }));
  const first = sync('');
  assert.equal(first.status, 207);
  assert.deepEqual(names(first), ['a.vcf', 'b.vcf']);
  const token = child(parseXml(first.body), 'DAV:', 'sync-token')!.text;
  assert.equal(token, 'urn:carddav-sync:2');
  put('c.vcf', makeCard({ uid: '3', fn: 'C' }));
  req('DELETE', `${BOOK}a.vcf`);
  put('b.vcf', makeCard({ uid: '2', fn: 'B2' }));
  const next = sync(token);
  const rs = responses(next);
  assert.deepEqual(rs.map((r) => [r.href.replace(BOOK, ''), r.status ?? 'ok']), [['a.vcf', 'HTTP/1.1 404 Not Found'], ['b.vcf', 'ok'], ['c.vcf', 'ok']]);
  assert.equal(child(parseXml(next.body), 'DAV:', 'sync-token')!.text, 'urn:carddav-sync:5');
  assert.equal(names(sync('urn:carddav-sync:5')).length, 0);
  const old = sync('urn:carddav-sync:1');
  assert.equal(old.status, 403, 'the log kept only the last 3 changes');
  assert.match(old.body, /valid-sync-token/);
  assert.equal(sync('urn:carddav-sync:99').status, 403);
  assert.equal(sync('https://evil.example/token').status, 403);
  assert.equal(dav.ctag(dav.book(BOOK)), `${BOOK}@5`);
  assert.equal(sync('', '<d:limit><d:nresults>1</d:nresults></d:limit>').status, 507);
});

test('PROPPATCH changes the name and description and refuses protected properties, all or nothing', () => {
  const { req, dav } = setup();
  const ok = req('PROPPATCH', BOOK, `<d:propertyupdate ${NS}><d:set><d:prop><d:displayname>Renamed</d:displayname><c:addressbook-description>About</c:addressbook-description></d:prop></d:set></d:propertyupdate>`);
  assert.equal(ok.status, 207);
  assert.equal(dav.book(BOOK).displayName, 'Renamed');
  assert.equal(dav.book(BOOK).description, 'About');
  const bad = req('PROPPATCH', BOOK, `<d:propertyupdate ${NS}><d:set><d:prop><d:displayname>Half</d:displayname><cs:getctag>x</cs:getctag></d:prop></d:set></d:propertyupdate>`);
  assert.equal(bad.status, 403);
  assert.equal(dav.book(BOOK).displayName, 'Renamed', 'nothing was applied');
  req('PROPPATCH', BOOK, `<d:propertyupdate ${NS}><d:remove><d:prop><c:addressbook-description/></d:prop></d:remove></d:propertyupdate>`);
  assert.equal(dav.book(BOOK).description, undefined);
});

test('XML that tries entity tricks is refused, and unknown methods and reports are answered plainly', () => {
  const { req, put } = setup();
  put('ana.vcf', ana);
  const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><c:addressbook-query ${NS}><d:prop><d:getetag/></d:prop><c:filter/></c:addressbook-query>`;
  const r = req('REPORT', BOOK, evil);
  assert.equal(r.status, 400);
  assert.match(r.body, /document type declarations/);
  assert.equal(req('PATCH', BOOK).status, 405);
  assert.match(req('PATCH', BOOK).headers.allow!, /REPORT/);
  const unk = req('REPORT', BOOK, `<c:free-busy-query ${NS}/>`);
  assert.equal(unk.status, 403);
  assert.match(unk.body, /supported-report/);
});

test('an address book holds only so many cards, and is private to its path', () => {
  const { put, dav } = setup({ maxCards: 2 });
  assert.equal(put('a.vcf', makeCard({ uid: '1', fn: 'A' })).status, 201);
  assert.equal(put('b.vcf', makeCard({ uid: '2', fn: 'B' })).status, 201);
  assert.equal(put('c.vcf', makeCard({ uid: '3', fn: 'C' })).status, 507);
  assert.equal(put('b.vcf', makeCard({ uid: '2', fn: 'B again' })).status, 204, 'replacing is not adding');
  dav.create('/addressbooks/bob/contacts/');
  assert.equal(dav.book('/addressbooks/bob/contacts/').resources.size, 0);
  assert.throws(() => dav.book('/addressbooks/cy/contacts/'), /no address book/);
});
