import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadIf, BadXml, DAV, depth, destination, el, encodePath, ifHolds, ifTokens, multistatus, netPropChanges, overwrite, parseIf, parseXml, propfindRequest, proppatchOps, proppatchRequest, timeout, writeXml } from './index.ts';

const OC = 'http://owncloud.org/ns';

test('a PROPFIND body resolves prefixes to namespaces, whatever prefixes the client chose', () => {
  const a = propfindRequest('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getetag/><oc:fileid/></d:prop></d:propfind>');
  const b = propfindRequest('<propfind xmlns="DAV:"><prop><getetag/><x:fileid xmlns:x="http://owncloud.org/ns"/></prop></propfind>');
  assert.deepEqual(a, b);
  assert.deepEqual(a, { kind: 'prop', props: [{ ns: DAV, name: 'getetag' }, { ns: OC, name: 'fileid' }] });
  assert.deepEqual(propfindRequest(''), { kind: 'allprop' });
});

test('document type declarations are refused, so no external entity is ever read', () => {
  const xxe = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:propfind xmlns:d="DAV:">&x;</d:propfind>';
  assert.throws(() => parseXml(xxe), BadXml);
  assert.throws(() => parseXml('<a>&nope;</a>'), BadXml);
  assert.throws(() => parseXml('<a><b></a>'), BadXml);
  assert.throws(() => parseXml('<x:a/>'), BadXml, 'an undeclared prefix');
  assert.throws(() => parseXml(`${'<a>'.repeat(100)}${'</a>'.repeat(100)}`), BadXml, 'too deep');
});

test('text, entities, character references and CDATA read back exactly', () => {
  const r = parseXml('<a>x &amp; y &#233; &#x1F600; <![CDATA[<raw>]]></a>');
  assert.equal(r.text, 'x & y é 😀 <raw>');
});

test('a PROPPATCH lists what is set with its value and what is removed', () => {
  const r = proppatchRequest('<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set><d:remove><d:prop><oc:tags/></d:prop></d:remove></d:propertyupdate>');
  assert.deepEqual(r, { set: [{ ns: OC, name: 'favorite', value: '1' }], remove: [{ ns: OC, name: 'tags' }] });
});

test('a multistatus groups found and missing properties, escapes text, and parses back', () => {
  const x = multistatus(
    [
      {
        href: '/remote.php/dav/files/ana/a%20b.txt',
        propstats: [
          { status: 200, props: [el(DAV, 'getetag', '"e<1>"'), el(OC, 'fileid', '7')] },
          { status: 404, props: [el(OC, 'nope')] },
        ],
      },
    ],
    { [DAV]: 'd', [OC]: 'oc' },
  );
  assert.match(x, /<d:multistatus xmlns:d="DAV:" xmlns:oc="http:\/\/owncloud.org\/ns">/);
  assert.match(x, /<d:getetag>"e&lt;1&gt;"<\/d:getetag>/, 'quotes stay literal in text, as Nextcloud writes etags');
  assert.match(x, /HTTP\/1.1 404 Not Found/);
  const back = parseXml(x);
  assert.equal(back.children[0]!.children.length, 3);
});

test('an unknown namespace gets its own declared prefix', () => {
  const x = writeXml(el(DAV, 'a', [el('urn:other', 'b', 'v')]));
  assert.match(x, /xmlns:x1="urn:other"/);
  assert.equal(parseXml(x).children[0]!.ns, 'urn:other');
});

test('WebDAV headers: depth, overwrite, destination, lock tokens, timeout', () => {
  assert.equal(depth('0'), 0);
  assert.equal(depth('1'), 1);
  assert.equal(depth(undefined), 'infinity');
  assert.equal(depth('bogus', 1), 1);
  assert.equal(overwrite('F'), false);
  assert.equal(overwrite(undefined), true);
  assert.equal(destination('http://h/remote.php/dav/files/ana/new%20name.txt', 'h', '/remote.php/dav/files/ana'), '/new name.txt');
  assert.equal(destination('http://evil/remote.php/dav/files/ana/x', 'h', '/remote.php/dav/files/ana'), null, 'another host is refused');
  assert.equal(destination('/remote.php/dav/files/ben/x', 'h', '/remote.php/dav/files/ana'), null, 'another base is refused');
  assert.deepEqual(ifTokens('(<opaquelocktoken:abc>) (<opaquelocktoken:def>)'), ['opaquelocktoken:abc', 'opaquelocktoken:def']);
  assert.equal(timeout('Second-60', 3_600_000), 60_000);
  assert.equal(timeout('Infinite', 3_600_000), 3_600_000);
});

test('paths are encoded step by step like rawurlencode', () => {
  assert.equal(encodePath("/a b/c's (1).txt"), '/a%20b/c%27s%20%281%29.txt');
  assert.equal(encodePath('/ü/€'), '/%C3%BC/%E2%82%AC');
});

test('a Destination under a base that only begins like it is not under it', () => {
  const base = '/remote.php/dav/files/ana';
  assert.equal(destination('http://h/remote.php/dav/files/anabel/x.txt', 'h', base), null, 'anabel is not under ana');
  assert.equal(destination('http://h/remote.php/dav/files/ana', 'h', base), '/', 'the base itself is its root');
  assert.equal(destination('http://h/remote.php/dav/files/ana/', 'h', base), '/');
  assert.equal(destination('http://h/remote.php/dav/files/ana/x', 'h', base), '/x');
});

test('element and attribute names must be XML names, so nothing read can break the XML written back', () => {
  for (const bad of ['<d:prop xmlns:d="DAV:"><d:a"b/></d:prop>', '<a<b/>', '<a&b/>', '<a b<c="1"/>', '<a b&c="1"/>', '<a b"c="1"/>', '<1a/>', '<-a/>', '<a:b:c xmlns:a="u"/>', '<a junk b="1"/>', '<a b="1" b="2"/>'])
    assert.throws(() => parseXml(bad), BadXml, bad);
  // Names from other scripts and with dots, dashes and digits after the first character are names.
  const ok = parseXml('<x:été-1.b xmlns:x="urn:u" x:ü_2="v"><_a/></x:été-1.b>');
  assert.equal(ok.name, 'été-1.b');
  assert.equal(ok.attrs['{urn:u}ü_2'], 'v');
  assert.equal(propfindRequest('<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>').kind, 'prop');
});

test('If headers: tagged and untagged lists, Not, state tokens and etags', () => {
  assert.deepEqual(parseIf('(<opaquelocktoken:a> ["e1"])'), [{ conditions: [{ not: false, token: 'opaquelocktoken:a' }, { not: false, etag: '"e1"' }] }]);
  assert.deepEqual(parseIf('<http://h/x> (Not <DAV:no-lock> [W/"e2"]) (<urn:t>)'), [
    { resource: 'http://h/x', conditions: [{ not: true, token: 'DAV:no-lock' }, { not: false, etag: 'W/"e2"' }] },
    { resource: 'http://h/x', conditions: [{ not: false, token: 'urn:t' }] },
  ]);
  assert.equal(parseIf(undefined), null);
  assert.throws(() => parseIf('(<a>'), BadIf);
  assert.throws(() => parseIf('nonsense'), BadIf);
  assert.throws(() => parseIf('()'), BadIf);
  const state = (r?: string) => (r === 'http://h/x' ? { etag: '"e2"', tokens: [] } : { etag: '"e1"', tokens: ['opaquelocktoken:a'] });
  assert.equal(ifHolds(parseIf('(<opaquelocktoken:a>)')!, state), true);
  assert.equal(ifHolds(parseIf('(<opaquelocktoken:b>)')!, state), false, 'a token that is not the lock on it');
  assert.equal(ifHolds(parseIf('(["e1"])')!, state), true);
  assert.equal(ifHolds(parseIf('(["e9"])')!, state), false, 'an etag that changed');
  assert.equal(ifHolds(parseIf('(["e9"]) (<opaquelocktoken:a>)')!, state), true, 'any one list holding is enough');
  assert.equal(ifHolds(parseIf('(<opaquelocktoken:a> ["e9"])')!, state), false, 'every condition in a list must hold');
  assert.equal(ifHolds(parseIf('(Not <DAV:no-lock> ["e1"])')!, state), true);
  assert.equal(ifHolds(parseIf('<http://h/x> ([W/"e2"])')!, state), true, 'a weak etag compares by its value');
  assert.equal(ifHolds(parseIf('(Not ["e1"])')!, state), false);
  assert.equal(ifHolds(parseIf('(["e1"])')!, () => ({ tokens: [] })), false, 'nothing there has no etag');
});

test('a prefix bound to an empty namespace is an invalid declaration (litmus propfind_invalid2)', () => {
  assert.throws(() => propfindRequest('<?xml version="1.0"?><propfind xmlns="DAV:"><prop><bar:foo xmlns:bar=""/></prop></propfind>'), BadXml);
  assert.throws(() => parseXml('<a xmlns:xml="urn:not-xml"/>'), BadXml);
  // Undeclaring the default namespace is allowed: the element is then in no namespace.
  assert.equal(parseXml('<a xmlns="DAV:"><b xmlns=""/></a>').children[0]!.ns, '');
});

test('a property in no namespace is written without a prefix and parses back in no namespace (litmus propnullns)', () => {
  const x = multistatus([{ href: '/x', propstats: [{ status: 200, props: [el('', 'nonamespace', 'randomvalue'), el('urn:u', 'other', 'v')] }] }]);
  assert.ok(!/xmlns:\w+=""/.test(x), `no prefix is bound to the empty namespace: ${x}`);
  const prop = parseXml(x).children[0]!.children[1]!.children[0]!;
  assert.deepEqual(
    prop.children.map((c) => [c.ns, c.name, c.text]),
    [
      ['', 'nonamespace', 'randomvalue'],
      ['urn:u', 'other', 'v'],
    ],
  );
});

test('PROPPATCH instructions apply in document order: a remove then a set leaves the property set (litmus propremoveset)', () => {
  const ops = proppatchOps('<propertyupdate xmlns="DAV:" xmlns:z="urn:z"><remove><prop><z:removeset/></prop></remove><set><prop><z:removeset>x</z:removeset></prop></set></propertyupdate>');
  assert.deepEqual(ops, [
    { op: 'remove', ns: 'urn:z', name: 'removeset' },
    { op: 'set', ns: 'urn:z', name: 'removeset', value: 'x' },
  ]);
  assert.deepEqual(netPropChanges(ops), { set: { '{urn:z}removeset': 'x' }, clear: [] });
  const back = proppatchOps('<propertyupdate xmlns="DAV:" xmlns:z="urn:z"><set><prop><z:p>x</z:p></prop></set><remove><prop><z:p/></prop></remove></propertyupdate>');
  assert.deepEqual(netPropChanges(back), { set: {}, clear: ['{urn:z}p'] });
});
