/** Fuzz: the safe XML reader behind blocks/dav (parseXml). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadXml, parseXml } from '../../blocks/dav/index.ts';
import { bounded, forAll } from './harness.ts';
import { checkTree, soup } from './dav.jobs.ts';

const jobs = new URL('./dav.jobs.ts', import.meta.url);

test('random and damaged XML: a sound tree (string ns, names, attributes; within maxDepth) or BadXml, never another error (5000 cases, 9 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'randomXml', cases: 5000, ms: 9000 });
});

const DECLS = ['<!DOCTYPE a>', '<!doctype a [ <!ENTITY x "y"> ]>', '<!DOCTYPE a SYSTEM "http://169.254.169.254/">', '<!ENTITY % p SYSTEM "file:///etc/passwd">', '<!DocType a [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>'];

test('a DOCTYPE or ENTITY declaration anywhere is refused (600 cases)', async () => {
  await forAll('dav doctype', {
    cases: 600,
    gen: (r) => {
      const body = `<a>${soup(r, 1)}</a>`;
      const at = r.int(0, body.length);
      return body.slice(0, at) + r.pick(DECLS) + body.slice(at);
    },
    shrink: () => [],
    check: (src) => assert.throws(() => parseXml(src), BadXml),
  });
});

test('an entity in lower-case letters other than the five predefined is refused (300 cases)', async () => {
  await forAll('dav unknown lower-case entities', {
    cases: 300,
    gen: (r) => {
      const e = r.str(1, 8, ['a', 'b', 'x', 'e', 'n', 'p', 'l', 'o']);
      return ['lt', 'gt', 'amp', 'quot', 'apos'].includes(e) ? '<a>&xxe;</a>' : r.bool() ? `<a>&${e};</a>` : `<a b="&${e};"/>`;
    },
    shrink: () => [],
    check: (src) => assert.throws(() => parseXml(src), BadXml),
  });
});

test('any other entity-shaped reference (digits, capitals, _ . -) is refused, not kept as literal text (300 cases)', { todo: 'unescape only matches &[a-z]+; so &lol2;, &AMP;, &Xxe; and &x_y; are neither refused nor expanded: they pass through as literal text' }, async () => {
  await forAll('dav other entities', {
    cases: 300,
    gen: (r) => {
      const e = r.pick(['lol2', 'AMP', 'Xxe', 'x_y', 'a.b', 'a-b', 'Lt', 'e1']);
      return r.bool() ? `<a>&${e};</a>` : `<a b="&${e};"/>`;
    },
    shrink: () => [],
    check: (src) => assert.throws(() => parseXml(src), BadXml),
  });
});

test('nesting deeper than maxDepth is refused; at or under it is read (400 cases)', async () => {
  await forAll('dav depth', {
    cases: 400,
    gen: (r) => ({ depth: r.int(1, 200), maxDepth: r.int(1, 100), selfClose: r.bool(), name: r.pick(['a', 'D:p']) }),
    shrink: () => [],
    check: ({ depth, maxDepth, selfClose, name }) => {
      const open = `<${name}${name.startsWith('D:') ? ' xmlns:D="DAV:"' : ''}>`;
      const inner = selfClose ? `<${name}${name.startsWith('D:') ? ' xmlns:D="DAV:"' : ''}/>` : `${open}</${name}>`;
      const src = `${open.repeat(depth - 1)}${inner}${`</${name}>`.repeat(depth - 1)}`;
      if (depth > maxDepth) assert.throws(() => parseXml(src, { maxDepth }), BadXml);
      else checkTree(parseXml(src, { maxDepth }), maxDepth);
    },
  });
});

test('a document longer than maxBytes characters is refused before parsing (300 cases)', async () => {
  await forAll('dav size in characters', {
    cases: 300,
    gen: (r) => ({ n: r.int(0, 3000), maxBytes: r.int(10, 2000) }),
    shrink: () => [],
    check: ({ n, maxBytes }) => {
      const src = `<a>${'x'.repeat(n)}</a>`;
      if (src.length > maxBytes) assert.throws(() => parseXml(src, { maxBytes }), /too large/);
      else assert.equal(parseXml(src, { maxBytes }).text.length, n);
    },
  });
});

test('maxBytes bounds UTF-8 bytes, not UTF-16 units: multi-byte text past the cap is refused (300 cases)', { todo: 'parseXml compares src.length (UTF-16 code units) with maxBytes, so text of multi-byte characters (é is 2 bytes in 1 unit, € and 中 3 bytes in 1 unit) up to 3x the byte cap is accepted' }, async () => {
  await forAll('dav size in bytes', {
    cases: 300,
    gen: (r) => ({ n: r.int(1, 1500), ch: r.pick(['€', '中', 'é', '😀']), maxBytes: r.int(100, 2000) }),
    shrink: () => [],
    check: ({ n, ch, maxBytes }) => {
      const src = `<a>${ch.repeat(n)}</a>`;
      if (Buffer.byteLength(src) > maxBytes) assert.throws(() => parseXml(src, { maxBytes }), BadXml);
    },
  });
});

test('character references to characters XML forbids (NUL, C0 controls, surrogates, U+FFFE/FFFF) are refused (300 cases)', { todo: 'unescape accepts any code point up to 0x10FFFF, so &#0;, &#x1;, &#xD800; and &#xFFFE; put NUL, controls and lone surrogates into the text' }, async () => {
  await forAll('dav forbidden character references', {
    cases: 300,
    gen: (r) => {
      const cp = r.pick([0, 1, 8, 0x0b, 0x1f, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff]);
      const ref = r.bool() ? `&#${cp};` : `&#x${cp.toString(16)};`;
      return r.bool() ? `<a>${ref}</a>` : `<a b="${ref}"/>`;
    },
    shrink: () => [],
    check: (src) => assert.throws(() => parseXml(src), BadXml),
  });
});

test('element and attribute prefixes named like Object.prototype members resolve to strings or are refused (300 cases)', { todo: 'the namespace scope is a plain object, so an undeclared prefix "constructor" or "toString" resolves to a Function, and "__proto__" (declared or not) to Object.prototype, giving El.ns that is not a string instead of "undeclared prefix"' }, async () => {
  await bounded({ module: jobs, fn: 'prototypePrefixes', cases: 300, ms: 5000 });
});

test('one start tag with a 30-60 kB attribute run is parsed or refused in under 250 ms (4 cases, 2 s deadline)', async () => {
  await bounded({ module: jobs, fn: 'hugeAttribute', cases: 4, ms: 2000 });
});

test('thousands of namespace declarations with thousands of children parse in under 250 ms (3 cases, 2 s deadline)', { todo: 'each element copies its parent scope ({...scope}) and walks it, so k declarations times k children is O(k^2): k=4000 (72 kB) takes about 3 s, k=8000 (144 kB) about 14 s' }, async () => {
  await bounded({ module: jobs, fn: 'manyNamespaces', cases: 3, ms: 2000 });
});
