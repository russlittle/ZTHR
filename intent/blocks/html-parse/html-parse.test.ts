import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, decodeEntities, diff, elements, InvalidSelector, LimitExceeded, matches, parse, query, queryOne, serialize, text, tokenize, walk } from './index.ts';

const html = (s: string) => serialize(parse(s));

test('a well-formed fragment becomes a tree and serialises back unchanged', () => {
  const src = '<div id="a" class="x y"><p>Hello <b>world</b>!</p><img src="i.png" alt="pic"><!-- note --></div>';
  const doc = parse(src);
  assert.equal(doc.children.length, 1);
  const div = doc.children[0]!;
  assert.equal(div.type === 'element' && div.tag, 'div');
  assert.equal(serialize(doc), src);
  assert.equal(text(doc), 'Hello world!');
  assert.equal(attr(div as never, 'CLASS'), 'x y', 'attribute names are case-insensitive');
});

test('tag and attribute names fold to lower case; the first duplicate attribute wins; valueless and unquoted forms read', () => {
  const doc = parse('<A HREF=x.html Title=\'q"t\' data-a="1" data-a="2" hidden disabled=>t</A>');
  const a = doc.children[0] as never as { tag: string; attrs: { name: string; value: string }[] };
  assert.equal(a.tag, 'a');
  assert.deepEqual(a.attrs, [
    { name: 'href', value: 'x.html' },
    { name: 'title', value: 'q"t' },
    { name: 'data-a', value: '1' },
    { name: 'hidden', value: '' },
    { name: 'disabled', value: '' },
  ]);
  assert.equal(serialize(doc), '<a href="x.html" title="q&quot;t" data-a="1" hidden="" disabled="">t</a>');
});

test('character references: named, decimal, hex, Windows-1252 range, invalid and unknown', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &copy; &hellip;'), 'a & b <c> "d" © …');
  assert.equal(decodeEntities('&#65;&#x42;&#X43;'), 'ABC');
  assert.equal(decodeEntities('&#x80; &#150;'), '€ –', 'numeric 0x80-0x9F read as Windows-1252');
  assert.equal(decodeEntities('&#0; &#xD800; &#x110000;'), '� � �');
  assert.equal(decodeEntities('&nosuch; & &amp &#;'), '&nosuch; & &amp &#;', 'unknown and unfinished stay as written');
  assert.equal(decodeEntities('&constructor; &__proto__; &toString;'), '&constructor; &__proto__; &toString;', 'names are looked up as own keys only');
  assert.equal(decodeEntities('&#128512;'), '\u{1F600}');
});

test('script and style are raw text; title and textarea decode but hold no tags', () => {
  const doc = parse('<script>if (a<b && c>d) { "</div>" }</script><style>a>b{x:"&amp;"}</style><title>A &amp; <b>B</title><textarea><p>&lt;</textarea>');
  const [s, st, ti, ta] = doc.children as never as { tag: string; children: { type: string; value: string }[] }[];
  assert.equal(s!.children[0]!.value, 'if (a<b && c>d) { "</div>" }');
  assert.equal(st!.children[0]!.value, 'a>b{x:"&amp;"}', 'no decoding in style');
  assert.equal(ti!.children.length, 1);
  assert.equal(ti!.children[0]!.value, 'A & <b>B');
  assert.equal(ta!.children[0]!.value, '<p><');
  assert.equal(parse('<script>x</SCRIPT >y').children.length, 2, 'the end tag is found case-insensitively with trailing space');
  assert.equal(parse('<script>a</scripty>b</script>').children.length, 1, '</scripty> does not end a script');
});

test('comments, doctype, bogus comments and processing instructions never become elements', () => {
  const doc = parse('<!DOCTYPE html><!-- a --><!--><!---><?php echo 1 ?><![CDATA[x]]></ 3>text');
  const kinds = doc.children.map((c) => c.type);
  assert.deepEqual(kinds, ['doctype', 'comment', 'comment', 'comment', 'comment', 'comment', 'comment', 'text']);
  assert.equal((doc.children[0] as never as { name: string }).name, 'html');
  assert.equal(serialize(parse('<!-- a --> --> b')), '<!-- a --> --&gt; b');
  const unterminated = parse('x<!-- never closed <b>');
  assert.equal(unterminated.children.length, 2);
  assert.equal(elements(unterminated).length, 0);
});

test('malformed markup: a stray < is text, a cut-off tag is dropped, unknown end tags are ignored', () => {
  assert.equal(html('1 < 2 and 3 <4'), '1 &lt; 2 and 3 &lt;4');
  assert.equal(html('a < b'), 'a &lt; b');
  assert.equal(html('before<div class="x'), 'before', 'a tag the input ends inside is dropped');
  assert.equal(html('<p>one</span>two</p>'), '<p>onetwo</p>');
  assert.equal(html('<p>x</p></p>'), '<p>x</p><p></p>', 'a stray </p> makes an empty paragraph, as browsers do');
  assert.equal(html('a</br>b'), 'a<br>b');
});

test('implied end tags: paragraphs, list items, definition lists, table cells and options', () => {
  assert.equal(html('<p>one<p>two<div>three</div>'), '<p>one</p><p>two</p><div>three</div>');
  assert.equal(html('<ul><li>a<li>b<ul><li>c</ul><li>d</ul>'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
  assert.equal(html('<dl><dt>t<dd>d<dt>u</dl>'), '<dl><dt>t</dt><dd>d</dd><dt>u</dt></dl>');
  assert.equal(html('<table><tr><td>1<td>2<tr><td>3</table>'), '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>');
  assert.equal(html('<select><option>a<option>b<optgroup><option>c</select>'), '<select><option>a</option><option>b</option><optgroup><option>c</option></optgroup></select>');
  assert.equal(html('<h1>a<h2>b'), '<h1>a</h1><h2>b</h2>');
});

test('an end tag closes the nearest open match but not across a table cell', () => {
  assert.equal(html('<div><span><b>x</div>y'), '<div><span><b>x</b></span></div>y');
  assert.equal(html('<table><tr><td><b>x</td></tr></table>after</b>'), '<table><tr><td><b>x</b></td></tr></table>after');
  assert.equal(html('<td><span>a</td>b</span>'), '<td><span>a</span></td>b', 'a </span> outside the cell does not reach inside it');
  assert.equal(html('<b>x</i>y</b>'), '<b>xy</b>');
  assert.equal(html('<p>a<br/>b<hr/>c</p>'), '<p>a<br>b</p><hr>c<p></p>');
});

test('self-closing syntax is honoured for void elements and foreign content only', () => {
  assert.equal(html('<div/>x</div>'), '<div>x</div>', 'a slash on a normal element means nothing');
  assert.equal(html('<svg><path d="M0"/><circle/></svg>'), '<svg><path d="M0"></path><circle></circle></svg>');
  assert.equal(elements(parse('<svg><g/><g/></svg>')).filter((e) => e.tag === 'g').every((g) => g.parent?.type === 'element' && g.parent.tag === 'svg'), true);
  assert.equal(html('<input value=a/>'), '<input value="a/">', 'a slash inside an unquoted value is part of it');
});

test('selectors: type, id, class, attributes and every attribute operator', () => {
  const doc = parse('<div id="main" class="box wide"><a href="http://x.org/a.pdf" lang="en-GB" rel="nofollow noopener">A</a><a href="/b" lang="fr">B</a><span data-k="Hello">S</span></div>');
  assert.equal(query(doc, 'div#main.box.wide').length, 1);
  assert.equal(query(doc, '.wide').length, 1);
  assert.equal(query(doc, 'a[href]').length, 2);
  assert.equal(query(doc, 'a[lang=fr]').length, 1);
  assert.equal(query(doc, 'a[lang|=en]').length, 1);
  assert.equal(query(doc, '[rel~=noopener]').length, 1);
  assert.equal(query(doc, 'a[href^="http"]').length, 1);
  assert.equal(query(doc, 'a[href$=".pdf"]').length, 1);
  assert.equal(query(doc, 'a[href*="x.org"]').length, 1);
  assert.equal(query(doc, '[data-k="hello" i]').length, 1);
  assert.equal(query(doc, '[data-k="hello"]').length, 0);
  assert.equal(query(doc, '[rel~=""]').length, 0, 'an empty value matches nothing');
  assert.equal(query(doc, 'a, span').length, 3);
  assert.deepEqual(query(doc, 'span, a').map((e) => e.tag), ['a', 'a', 'span'], 'document order, each once');
});

test('selectors: combinators and structural pseudo-classes', () => {
  const doc = parse('<ul id="u"><li>1</li><li class="k">2</li><li>3</li><li>4<ul><li>5</li></ul></li></ul><p></p><p>x</p>');
  assert.equal(query(doc, 'ul li').length, 5);
  assert.equal(query(doc, 'ul > li').length, 5);
  assert.equal(query(doc, '#u > li').length, 4, 'child combinator is one level');
  assert.equal(query(doc, 'li + li').length, 3);
  assert.equal(query(doc, '.k ~ li').length, 2);
  assert.deepEqual(query(doc, 'li:first-child').map((e) => text(e)), ['1', '5']);
  assert.deepEqual(query(doc, '#u > li:last-child').map((e) => text(e)), ['45']);
  assert.deepEqual(query(doc, '#u > li:nth-child(2)').map((e) => text(e)), ['2']);
  assert.deepEqual(query(doc, '#u > li:nth-child(odd)').map((e) => text(e)), ['1', '3']);
  assert.deepEqual(query(doc, '#u > li:nth-child(2n+2)').map((e) => text(e)), ['2', '45']);
  assert.deepEqual(query(doc, '#u > li:not(.k):not(:first-child)').map((e) => text(e)), ['3', '45']);
  assert.equal(query(doc, 'p:empty').length, 1);
  assert.equal(query(doc, 'ul > li:only-child').length, 1);
  assert.equal(queryOne(doc, 'h1'), null);
  assert.equal(matches(query(doc, '.k')[0]!, 'ul > li.k'), true);
});

test('bad selectors are refused with a plain message', () => {
  const doc = parse('<p>x</p>');
  for (const bad of ['', '  ', 'p >', '> p', 'p,', ',p', '[a', 'p:hover', ':nth-child(x)', '#', '.', 'p[a=]b', 'p::before', 'a'.repeat(2001)])
    assert.throws(() => query(doc, bad), InvalidSelector, JSON.stringify(bad.slice(0, 20)));
});

test('serialising escapes so that hostile text cannot become markup, and the result re-parses to the same thing', () => {
  const hostile = '<script>alert(1)</script> & "quotes"  ';
  const doc = parse(`<p title="${'&lt;x&gt; &quot;y&quot;'}">${'&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes" &nbsp;'}</p>`);
  const out = serialize(doc);
  assert.equal(out, '<p title="<x> &quot;y&quot;">&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes" &nbsp;</p>');
  assert.equal(text(doc), hostile);
  assert.equal(serialize(parse(out)), out, 'serialise, parse, serialise is stable');
  const built = parse('<p></p>');
  (built.children[0] as never as { children: unknown[] }).children.push({ type: 'text', value: hostile, parent: built.children[0] });
  assert.equal(serialize(built), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes" &nbsp;</p>');
  assert.equal(serialize({ type: 'element', tag: 'a b', attrs: [], children: [], parent: null }), '&lt;a b&gt;', 'a tag name that is not one is shown as text');
  assert.equal(
    serialize({ type: 'element', tag: 'i', attrs: [{ name: 'on"x', value: 'v' }, { name: 'ok', value: 'v"' }], children: [], parent: null }),
    '<i ok="v&quot;"></i>',
    'an attribute name that cannot be written is dropped',
  );
});

test('hostile sizes are refused: input, depth, node count, attributes per tag', () => {
  assert.throws(() => parse('x'.repeat(101), { maxLength: 100 }), LimitExceeded);
  assert.throws(() => parse('<div>'.repeat(600)), /levels of nesting/);
  assert.equal(parse('<div>'.repeat(500)).children.length, 1, 'inside the default depth it is fine');
  assert.throws(() => parse('<b>x</b>'.repeat(10), { maxNodes: 15 }), /nodes/);
  const many = '<a ' + Array.from({ length: 300 }, (_, i) => `a${i}=1`).join(' ') + '>';
  assert.throws(() => parse(many), /attributes on one tag/);
  assert.throws(() => parse('', { maxDepth: 100_000 }), RangeError);
  // Linear time on the shapes that make naive parsers slow.
  const t0 = Date.now();
  parse('<a '.repeat(50_000));
  parse('<!--'.repeat(50_000));
  parse('&'.repeat(200_000));
  parse('<p>'.repeat(400) + '<td>'.repeat(50_000));
  assert.ok(Date.now() - t0 < 3000, 'pathological inputs finish quickly');
});

test('tokenize lists tokens without building a tree', () => {
  assert.deepEqual(tokenize('<a href=x>t</a><br/>'), [
    { kind: 'start', tag: 'a', attrs: [{ name: 'href', value: 'x' }], selfClosing: false },
    { kind: 'text', value: 't' },
    { kind: 'end', tag: 'a' },
    { kind: 'start', tag: 'br', attrs: [], selfClosing: true },
  ]);
});

test('walk visits in document order; text ignores comments', () => {
  const doc = parse('<a>1<b>2</b><!--x-->3</a>');
  assert.deepEqual([...walk(doc)].map((n) => (n.type === 'element' ? `<${n.tag}>` : n.type === 'text' ? n.value : '#')), ['<a>', '1', '<b>', '2', '#', '3']);
  assert.equal(text(doc), '123');
});

test('diff reports added, removed and changed parts, ignoring whitespace and attribute order', () => {
  const a = parse('<div class="a" id="x">\n <p>one</p>\n<p>two</p><span>s</span></div>');
  const same = parse('<div id="x" class="a"><p>one</p> <p>two</p><span>s</span></div>');
  assert.deepEqual(diff(a, same), []);
  const b = parse('<div class="b" id="x"><p>one</p><p>TWO</p><em>new</em><span>s</span></div>');
  assert.deepEqual(diff(a, b), [
    { path: '/div[1]', kind: 'changed-attributes', before: 'class="a" id="x"', after: 'class="b" id="x"' },
    { path: '/div[1]/p[2]/text()', kind: 'changed-text', before: 'two', after: 'TWO' },
    { path: '/div[1]/em[1]', kind: 'added', after: '<em>new</em>' },
  ]);
  assert.deepEqual(diff(parse('<p>a</p><p>b</p>'), parse('<p>b</p>')), [{ path: '/p[1]', kind: 'removed', before: '<p>a</p>' }]);
  assert.deepEqual(diff(parse('<b>x</b>'), parse('<i>x</i>')), [{ path: '/b[1]', kind: 'changed-tag', before: 'b', after: 'i' }]);
});
