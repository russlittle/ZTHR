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

test('only the five predefined entities and character references are references: any other is refused', () => {
  for (const e of ['lol2', 'AMP', 'Xxe', 'x_y', 'a.b', 'a-b', 'Lt', 'e1', 'constructor', 'toString', '__proto__'])
    for (const src of [`<a>&${e};</a>`, `<a b="&${e};"/>`]) assert.throws(() => parseXml(src), BadXml, src);
  assert.throws(() => parseXml('<a>fish & chips</a>'), BadXml, 'a bare ampersand');
  assert.throws(() => parseXml('<a>&amp</a>'), BadXml, 'a reference without its semicolon');
  assert.equal(parseXml('<a b="&lt;&#38;&#x26;">&quot;&apos;&gt;</a>').text, `"'>`);
  assert.equal(parseXml('<a b="&lt;&#38;&#x26;"/>').attrs['b'], '<&&');
});

test('maxBytes counts UTF-8 bytes, not UTF-16 units', () => {
  const src = `<a>${'€'.repeat(100)}</a>`;
  assert.equal(src.length, 107);
  assert.equal(Buffer.byteLength(src), 307);
  assert.throws(() => parseXml(src, { maxBytes: 200 }), /too large/);
  assert.equal(parseXml(src, { maxBytes: 307 }).text.length, 100);
  assert.throws(() => parseXml(`<a>${'😀'.repeat(60)}</a>`, { maxBytes: 200 }), /too large/, '4 bytes in 2 units');
});

test('character references to characters outside XML’s Char production are refused, in text and attributes', () => {
  for (const cp of [0, 1, 8, 0x0b, 0x0c, 0x1f, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff, 0x110000])
    for (const ref of [`&#${cp};`, `&#x${cp.toString(16)};`])
      for (const src of [`<a>${ref}</a>`, `<a b="${ref}"/>`]) assert.throws(() => parseXml(src), BadXml, src);
  assert.equal(parseXml('<a>&#9;&#xA;&#13;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x10FFFF;</a>').text, '\t\n\r ퟿�\u{10000}\u{10FFFF}');
});

test('prefixes named like Object.prototype members are undeclared unless declared, and then plain strings', () => {
  for (const p of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    assert.throws(() => parseXml(`<${p}:a/>`), BadXml, `undeclared ${p}`);
    assert.throws(() => parseXml(`<a ${p}:x="v"/>`), BadXml, `undeclared ${p} on an attribute`);
    const el = parseXml(`<a xmlns:${p}="urn:x" ${p}:x="v"><${p}:b/></a>`);
    assert.equal(el.children[0]!.ns, 'urn:x');
    assert.deepEqual(Object.entries(el.attrs), [['{urn:x}x', 'v']]);
  }
  const proto = parseXml('<a __proto__="v"/>');
  assert.deepEqual(Object.entries(proto.attrs), [['__proto__', 'v']], 'an attribute named __proto__ is kept as an attribute');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('many namespace declarations with many children, and one huge run of attribute text, parse in linear time', () => {
  for (const k of [4000, 8000]) {
    const src = `<r${Array.from({ length: k }, (_, i) => ` xmlns:p${i}="u"`).join('')}>${'<a/>'.repeat(k)}</r>`;
    const t = performance.now();
    assert.equal(parseXml(src).children.length, k);
    const took = performance.now() - t;
    assert.ok(took < 250, `k=${k} took ${took.toFixed(0)} ms`);
  }
  for (const ch of ['x', 'a:b', '-']) {
    const t = performance.now();
    assert.throws(() => parseXml(`<a ${ch.repeat(Math.ceil(60_000 / ch.length))}/>`), BadXml);
    const took = performance.now() - t;
    assert.ok(took < 250, `a 60 kB run of ${ch} took ${took.toFixed(0)} ms`);
  }
  // Prefixes declared further up still resolve below, and a nearer declaration hides a farther one.
  const deep = parseXml('<a xmlns:p="u1" xmlns="d"><b xmlns:p="u2"><p:c/></b><p:e/><f/></a>');
  assert.deepEqual(
    [deep.children[0]!.children[0]!.ns, deep.children[1]!.ns, deep.children[2]!.ns, deep.children[0]!.ns],
    ['u2', 'u1', 'd', 'd'],
  );
});
