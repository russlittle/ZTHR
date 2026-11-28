import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadIf, BadXml, DAV, STATUS, child, children, depth, destination, el, encodePath, escapeText, escapeXml, httpDate, ifHolds, ifTokens, key, keyOf, multistatus, netPropChanges, overwrite, parseIf, parseXml, propfindRequest, proppatchOps, proppatchRequest, statusLine, timeout, writeXml } from './index.ts';

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

const REFUSED = 'the request body is not acceptable XML: ';
/** What a body is refused with, or null when it is read. */
const why = (src: string, o?: { maxBytes?: number; maxDepth?: number }) => {
  try {
    parseXml(src, o);
    return null;
  } catch (e) {
    assert.ok(e instanceof BadXml, `${src}: ${String(e)}`);
    return e.message;
  }
};

test('every refusal says why, after the same fixed lead-in', () => {
  assert.equal(why('<a><!--<!DOCTYPE x>--></a>'), `${REFUSED}document type declarations are not accepted`);
  assert.equal(why('<x:a/>'), `${REFUSED}undeclared prefix x`);
  assert.equal(why('<a/>x'), `${REFUSED}text outside the root element`);
  assert.equal(why('x<a/>'), `${REFUSED}text outside the root element`);
  assert.equal(why('<a><?pi</a>'), `${REFUSED}unclosed processing instruction`);
  assert.equal(why('<a><!-- x</a>'), `${REFUSED}unclosed comment`);
  assert.equal(why('<a><![CDATA[x</a>'), `${REFUSED}unclosed CDATA`);
  assert.equal(why('<a></a'), `${REFUSED}unclosed end tag`);
  assert.equal(why('<a></b>'), `${REFUSED}unexpected </b>`);
  assert.equal(why('</a>'), `${REFUSED}unexpected </a>`);
  assert.equal(why('<a/><b/>'), `${REFUSED}more than one root element`);
  assert.equal(why('<a'), `${REFUSED}unclosed start tag`);
  assert.equal(why('<a b="x>'), `${REFUSED}unclosed start tag`);
  assert.equal(why('<>'), `${REFUSED}a tag without a name`);
  assert.equal(why('< a/>'), `${REFUSED}a tag without a name`);
  assert.equal(why('<a><b><c/></b></a>', { maxDepth: 2 }), `${REFUSED}nested too deeply`);
  assert.equal(why('<a>'), `${REFUSED}<a> is not closed`);
  assert.equal(why('<a><b>'), `${REFUSED}<b> is not closed`, 'the innermost open element is the one named');
  assert.equal(why(''), `${REFUSED}no root element`);
  assert.equal(why('<?xml version="1.0"?><!-- nothing -->'), `${REFUSED}no root element`);
  assert.equal(why('   \n'), `${REFUSED}no root element`);
});

test('a document type or entity declaration is refused wherever it appears, in any letter case', () => {
  for (const src of ['<a><!-- <!DOCTYPE x> --></a>', '<a><!-- <!doctype x> --></a>', '<a><![CDATA[<!ENTITY x "y">]]></a>', '<a><?pi <!Entity?></a>']) assert.equal(why(src), `${REFUSED}document type declarations are not accepted`, src);
  assert.equal(parseXml('<a>&lt;!DOCTYPE</a>').text, '<!DOCTYPE', 'an escaped one is only text');
});

test('whitespace and comments around and inside the root are fine; text outside it is not', () => {
  assert.equal(parseXml('<a/>\n').name, 'a');
  assert.equal(parseXml('<?xml version="1.0"?>\n<a/>\n').name, 'a');
  assert.equal(parseXml('  <!-- before --> <a/> <!-- after --> \n').name, 'a');
  const r = parseXml('<a>x<!-- <b> -->y<!----><c/></a>');
  assert.equal(r.text, 'xy');
  assert.deepEqual(r.children.map((c) => c.name), ['c']);
  assert.equal(parseXml('<a><!-- c --></a>').text, '', 'the comment text is not content');
  assert.equal(parseXml('<a><?pi x?>t</a>').text, 't', 'nor is a processing instruction');
});

test('CDATA is character data, so it cannot stand outside the root element', () => {
  assert.equal(why('<![CDATA[x]]><a/>'), `${REFUSED}text outside the root element`);
  assert.equal(why('<a/><![CDATA[x]]>'), `${REFUSED}text outside the root element`);
});

test('an end tag may have whitespace before its >, and must name the element it closes', () => {
  assert.equal(parseXml('<a></a >').name, 'a');
  assert.equal(parseXml('<a></a\n>').name, 'a');
  assert.equal(why('<a><b></a></b>'), `${REFUSED}unexpected </a>`);
});

test('a > inside a quoted attribute value does not end the tag, whichever quote is used', () => {
  const r = parseXml(`<a b="x>y" c='1>2' d="it's > x" e='say "hi" > x'/>`);
  assert.deepEqual(Object.entries(r.attrs), [['b', 'x>y'], ['c', '1>2'], ['d', "it's > x"], ['e', 'say "hi" > x']]);
  const r2 = parseXml(`<a b=">">t</a>`);
  assert.equal(r2.attrs['b'], '>');
  assert.equal(r2.text, 't');
});

test('namespace declarations are not attributes, and an unprefixed attribute is in no namespace', () => {
  const r = parseXml('<a xmlns="urn:d" xmlns:p="urn:p" b="1" p:c="2"/>');
  assert.equal(r.ns, 'urn:d');
  assert.deepEqual(Object.entries(r.attrs), [['b', '1'], ['{urn:p}c', '2']]);
  assert.equal(parseXml('<a b="urn:x"/>').ns, '', 'an attribute value is never a namespace');
  assert.equal(parseXml('<a x:b="urn:x" xmlns:x="urn:y"/>').ns, '');
  assert.equal(parseXml('<a xmlns="urn:d" xmlns:p="urn:p"><b/></a>').children[0]!.ns, 'urn:d');
});

test('nesting is limited to maxDepth elements, counting the root', () => {
  const nest = (n: number) => `${'<a>'.repeat(n - 1)}<a/>${'</a>'.repeat(n - 1)}`;
  assert.equal(why(nest(3), { maxDepth: 3 }), null);
  assert.equal(why(nest(4), { maxDepth: 3 }), `${REFUSED}nested too deeply`);
  assert.equal(why(nest(64)), null, 'the default allows 64');
  assert.equal(why(nest(65)), `${REFUSED}nested too deeply`);
});

test('what is read is a tree: an empty element has no children and no text, and children keep document order', () => {
  const r = parseXml('<a><b/><c>t</c><d></d></a>');
  assert.deepEqual(r.children.map((c) => [c.name, c.text, c.children.length]), [['b', '', 0], ['c', 't', 0], ['d', '', 0]]);
  const lone = parseXml('<a/>');
  assert.deepEqual([lone.ns, lone.name, lone.text, lone.children, Object.entries(lone.attrs)], ['', 'a', '', [], []]);
});

test('child and children find elements by namespace and name together', () => {
  const r = parseXml('<r xmlns="DAV:" xmlns:z="urn:z"><p>1</p><z:p>2</z:p><q>3</q><p>4</p><z:q>5</z:q></r>');
  assert.deepEqual(children(r, DAV, 'p').map((c) => c.text), ['1', '4']);
  assert.deepEqual(children(r, 'urn:z', 'p').map((c) => c.text), ['2']);
  assert.deepEqual(children(r, DAV, 'q').map((c) => c.text), ['3']);
  assert.deepEqual(children(r, 'urn:z', 'nope'), []);
  assert.deepEqual(children(r, 'urn:nope', 'p'), []);
  assert.equal(child(r, 'urn:z', 'p')!.text, '2', 'the first match in that namespace, not the first of that name');
  assert.equal(child(r, DAV, 'p')!.text, '1');
  assert.equal(child(r, DAV, 'nope'), undefined);
  assert.equal(child(r, 'urn:nope', 'q'), undefined);
});

test('a property key is {namespace}name', () => {
  assert.equal(key(DAV, 'getetag'), '{DAV:}getetag');
  assert.equal(key('', 'x'), '{}x');
  assert.equal(keyOf({ ns: OC, name: 'fileid' }), '{http://owncloud.org/ns}fileid');
});

test('text escapes <, > and &; an attribute value also escapes both quotes', () => {
  assert.equal(escapeText(`a&b<c>d"e'f`), `a&amp;b&lt;c&gt;d"e'f`);
  assert.equal(escapeText('&&'), '&amp;&amp;');
  assert.equal(escapeXml(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
  assert.equal(escapeXml('plain'), 'plain');
});

test('writeXml writes exactly this: stable prefixes, attributes escaped, empty elements self-closed', () => {
  const head = '<?xml version="1.0" encoding="UTF-8"?>\n';
  assert.equal(writeXml(el(DAV, 'a')), `${head}<d:a xmlns:d="DAV:"/>`, 'd is DAV: unless told otherwise');
  assert.equal(writeXml(el(DAV, 'a', '')), `${head}<d:a xmlns:d="DAV:"/>`, 'empty text is an empty element');
  assert.equal(writeXml(el(DAV, 'a', [])), `${head}<d:a xmlns:d="DAV:"/>`);
  assert.equal(writeXml(el(DAV, 'a', 't<&')), `${head}<d:a xmlns:d="DAV:">t&lt;&amp;</d:a>`);
  assert.equal(writeXml(el(DAV, 'a', [el(DAV, 'b', '1'), el('urn:other', 'c', '2'), el(DAV, 'd')])), `${head}<d:a xmlns:d="DAV:" xmlns:x1="urn:other"><d:b>1</d:b><x1:c>2</x1:c><d:d/></d:a>`);
  assert.equal(writeXml(el(DAV, 'a', 't', { x: '1', y: `"&<'` })), `${head}<d:a xmlns:d="DAV:" x="1" y="&quot;&amp;&lt;&apos;">t</d:a>`);
  assert.equal(writeXml(el(DAV, 'a', [el(DAV, 'b', undefined, { k: 'v' })])), `${head}<d:a xmlns:d="DAV:"><d:b k="v"/></d:a>`);
  assert.deepEqual(el(DAV, 'a', 't', { k: 'v' }).attrs, { k: 'v' });
  assert.equal(el(DAV, 'a', 't').attrs, undefined);
  assert.equal(writeXml(el('', 'a', [el('', 'b', 'v')])), `${head}<a><b>v</b></a>`);
});

test('status lines name the status the way HTTP does', () => {
  const names: [number, string][] = [[200, 'OK'], [201, 'Created'], [204, 'No Content'], [207, 'Multi-Status'], [403, 'Forbidden'], [404, 'Not Found'], [409, 'Conflict'], [412, 'Precondition Failed'], [423, 'Locked'], [424, 'Failed Dependency'], [507, 'Insufficient Storage']];
  for (const [code, name] of names) {
    assert.equal(STATUS[code], name);
    assert.equal(statusLine(code), `HTTP/1.1 ${code} ${name}`);
  }
  assert.equal(statusLine(299), 'HTTP/1.1 299', 'an unknown status has no reason phrase and no trailing space');
});

test('a multistatus leaves out a propstat with no properties', () => {
  const x = multistatus([{ href: '/x', propstats: [{ status: 200, props: [el(DAV, 'getetag', '"e"')] }, { status: 404, props: [] }] }]);
  assert.ok(!x.includes('404'), x);
  assert.equal(x.match(/<d:propstat>/g)!.length, 1);
  const only = multistatus([{ href: '/x', propstats: [{ status: 404, props: [] }] }]);
  assert.ok(!only.includes('propstat'), only);
  assert.match(only, /<d:response><d:href>\/x<\/d:href><\/d:response>/);
});

test('a PROPFIND is for DAV:propfind and nothing else, and says which of three things it wants', () => {
  assert.deepEqual(propfindRequest('  \n\t '), { kind: 'allprop' }, 'a blank body is an empty body');
  assert.deepEqual(propfindRequest('<propfind xmlns="DAV:"><propname/></propfind>'), { kind: 'propname' });
  assert.deepEqual(propfindRequest('<propfind xmlns="DAV:"><allprop/></propfind>'), { kind: 'allprop' });
  assert.deepEqual(propfindRequest('<propfind xmlns="DAV:"/>'), { kind: 'allprop' });
  assert.deepEqual(propfindRequest('<propfind xmlns="DAV:" xmlns:o="urn:o"><o:propname/></propfind>'), { kind: 'allprop' }, 'a propname in another namespace is not DAV:propname');
  assert.deepEqual(propfindRequest('<propfind xmlns="DAV:"><prop/></propfind>'), { kind: 'prop', props: [] });
  const not = `${REFUSED}the body is not a propfind`;
  for (const src of ['<propfind xmlns="urn:other"/>', '<propfind/>', '<d:foo xmlns:d="DAV:"/>', '<propertyupdate xmlns="DAV:"/>']) assert.throws(() => propfindRequest(src), { message: not }, src);
});

test('a PROPPATCH is for DAV:propertyupdate; only DAV:set and DAV:remove with a DAV:prop do anything', () => {
  const not = `${REFUSED}the body is not a propertyupdate`;
  for (const src of ['<propertyupdate xmlns="urn:other"/>', '<propertyupdate/>', '<d:foo xmlns:d="DAV:"/>', '<propfind xmlns="DAV:"/>']) {
    assert.throws(() => proppatchOps(src), { message: not }, src);
    assert.throws(() => proppatchRequest(src), { message: not }, src);
  }
  assert.deepEqual(proppatchOps('<propertyupdate xmlns="DAV:"/>'), []);
  assert.deepEqual(proppatchOps('<propertyupdate xmlns="DAV:"><set/><remove/></propertyupdate>'), [], 'an instruction without a prop does nothing');
  const other = '<propertyupdate xmlns="DAV:" xmlns:z="urn:z"><z:set><prop><z:p>1</z:p></prop></z:set><z:remove><prop><z:p/></prop></z:remove><foo><prop><z:p>2</z:p></prop></foo><bar><prop><z:p/></prop></bar></propertyupdate>';
  assert.deepEqual(proppatchOps(other), [], 'set and remove in another namespace, or another name, are not instructions');
  assert.deepEqual(proppatchRequest(other), { set: [], remove: [] });
});

test('a set value is its text without the whitespace around it', () => {
  const ops = proppatchOps('<propertyupdate xmlns="DAV:" xmlns:z="urn:z"><set><prop><z:p>\n  x y  \n</z:p><z:q>   </z:q></prop></set></propertyupdate>');
  assert.deepEqual(ops, [
    { op: 'set', ns: 'urn:z', name: 'p', value: 'x y' },
    { op: 'set', ns: 'urn:z', name: 'q', value: '' },
  ]);
});

test('Depth is 0, 1 or infinity in any letter case and around spaces; anything else is the fallback', () => {
  assert.equal(depth('infinity', 1), 'infinity');
  assert.equal(depth('Infinity', 0), 'infinity');
  assert.equal(depth(' INFINITY ', 1), 'infinity');
  assert.equal(depth(' 0 ', 1), 0);
  assert.equal(depth(' 1 ', 0), 1);
  assert.equal(depth('2', 0), 0);
  assert.equal(depth('', 1), 1);
  assert.equal(depth(null, 0), 0);
});

test('a Destination that is missing or cannot be read is no destination', () => {
  assert.equal(destination(undefined, 'h', '/'), null);
  assert.equal(destination(null, 'h', '/'), null);
  assert.equal(destination('', 'h', '/'), null);
  assert.equal(destination('http://', 'h', '/'), null, 'not a URL');
  assert.equal(destination('http://h/%zz', 'h', '/'), null, 'a bad percent escape');
  assert.equal(destination('http://h/%E0%A4%A', 'h', '/'), null, 'a truncated UTF-8 escape');
  assert.equal(destination('http://h/a%20b', 'h', '/'), '/a b');
  assert.equal(destination('/a/b', 'h', '/'), '/a/b', 'a path alone is on this server');
});

test('paths keep the reserved characters rawurlencode encodes, in upper case hex', () => {
  assert.equal(encodePath('/a*b!c'), '/a%2Ab%21c');
  assert.equal(encodePath("/()'*"), '/%28%29%27%2A');
});

test('an HTTP date is the UTC time of seconds since the epoch', () => {
  assert.equal(httpDate(0), 'Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(httpDate(1_700_000_000), 'Tue, 14 Nov 2023 22:13:20 GMT');
  assert.equal(httpDate(1_700_000_000.5), 'Tue, 14 Nov 2023 22:13:20 GMT');
});
