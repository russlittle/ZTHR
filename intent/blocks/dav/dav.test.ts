import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadXml, DAV, depth, destination, el, encodePath, ifTokens, multistatus, overwrite, parseXml, propfindRequest, proppatchRequest, timeout, writeXml } from './index.ts';

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
