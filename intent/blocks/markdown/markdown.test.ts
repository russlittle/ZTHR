import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownError, collect, escapeHtml, frontMatter, headingIds, parse, parseWithFrontMatter, render, safeUrl, slugify, textContent, toHtml, walk } from './index.ts';

const cases = (title: string, rows: [string, string][], o: Parameters<typeof toHtml>[1] = {}) =>
  test(title, () => {
    for (const [md, html] of rows) assert.equal(toHtml(md, o), html, JSON.stringify(md));
  });

cases('CommonMark spec: headings, thematic breaks and code', [
  ['# foo\n## foo\n### foo', '<h1>foo</h1>\n<h2>foo</h2>\n<h3>foo</h3>\n'],
  ['####### foo', '<p>####### foo</p>\n'],
  ['#5 bolt', '<p>#5 bolt</p>\n'],
  ['# foo ##\n## foo #####   \n### foo ### b', '<h1>foo</h1>\n<h2>foo</h2>\n<h3>foo ### b</h3>\n'],
  ['## \n#\n### ###', '<h2></h2>\n<h1></h1>\n<h3></h3>\n'],
  ['Foo *bar*\n=========\n\nFoo *bar*\n---------', '<h1>Foo <em>bar</em></h1>\n<h2>Foo <em>bar</em></h2>\n'],
  ['***\n---\n___', '<hr />\n<hr />\n<hr />\n'],
  ['--\n**\n__', '<p>--\n**\n__</p>\n'],
  ['    a simple\n      indented code block', '<pre><code>a simple\n  indented code block\n</code></pre>\n'],
  ['```\n<\n >\n```', '<pre><code>&lt;\n &gt;\n</code></pre>\n'],
  ['~~~\naaa\n```\n~~~', '<pre><code>aaa\n```\n</code></pre>\n'],
  ['```ruby\ndef foo(x)\n  return 3\nend\n```', '<pre><code class="language-ruby">def foo(x)\n  return 3\nend\n</code></pre>\n'],
  ['```\naaa', '<pre><code>aaa\n</code></pre>\n'],
  ['```\n```', '<pre><code></code></pre>\n'],
  ['``` aa ```\nfoo', '<p><code>aa</code>\nfoo</p>\n'],
]);

cases('CommonMark spec: paragraphs, quotes and lists', [
  ['aaa\n\nbbb', '<p>aaa</p>\n<p>bbb</p>\n'],
  ['aaa\n bbb\n    ccc', '<p>aaa\nbbb\nccc</p>\n'],
  ['> # Foo\n> bar\n> baz', '<blockquote>\n<h1>Foo</h1>\n<p>bar\nbaz</p>\n</blockquote>\n'],
  ['> bar\nbaz\n> foo', '<blockquote>\n<p>bar\nbaz\nfoo</p>\n</blockquote>\n'],
  ['> foo\n\n> bar', '<blockquote>\n<p>foo</p>\n</blockquote>\n<blockquote>\n<p>bar</p>\n</blockquote>\n'],
  ['> > > foo\nbar', '<blockquote>\n<blockquote>\n<blockquote>\n<p>foo\nbar</p>\n</blockquote>\n</blockquote>\n</blockquote>\n'],
  ['- foo\n- bar\n- baz', '<ul>\n<li>foo</li>\n<li>bar</li>\n<li>baz</li>\n</ul>\n'],
  ['1. a\n2. b', '<ol>\n<li>a</li>\n<li>b</li>\n</ol>\n'],
  ['3. a\n4. b', '<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>\n'],
  ['- foo\n\n- bar', '<ul>\n<li>\n<p>foo</p>\n</li>\n<li>\n<p>bar</p>\n</li>\n</ul>\n'],
  ['- a\n  - b\n  - c\n- d', '<ul>\n<li>a\n<ul>\n<li>b</li>\n<li>c</li>\n</ul>\n</li>\n<li>d</li>\n</ul>\n'],
  ['- foo\n- bar\n+ baz', '<ul>\n<li>foo</li>\n<li>bar</li>\n</ul>\n<ul>\n<li>baz</li>\n</ul>\n'],
  ['1. foo\n2. bar\n3) baz', '<ol>\n<li>foo</li>\n<li>bar</li>\n</ol>\n<ol start="3">\n<li>baz</li>\n</ol>\n'],
  ['The number of windows in my house is\n14.  The number of doors is 6.', '<p>The number of windows in my house is\n14.  The number of doors is 6.</p>\n'],
  ['- a\n- ```\n  b\n  ```\n- c', '<ul>\n<li>a</li>\n<li>\n<pre><code>b\n</code></pre>\n</li>\n<li>c</li>\n</ul>\n'],
  ['-\n  foo\n-\n  ```\n  bar\n  ```', '<ul>\n<li>foo</li>\n<li>\n<pre><code>bar\n</code></pre>\n</li>\n</ul>\n'],
  ['- foo\n  bar', '<ul>\n<li>foo\nbar</li>\n</ul>\n'],
]);

cases('CommonMark spec: inlines', [
  ['`foo`', '<p><code>foo</code></p>\n'],
  ['`` foo ` bar ``', '<p><code>foo ` bar</code></p>\n'],
  ['`foo   bar \nbaz`', '<p><code>foo   bar  baz</code></p>\n'],
  ['`foo', '<p>`foo</p>\n'],
  ['*foo bar*', '<p><em>foo bar</em></p>\n'],
  ['a * foo bar*', '<p>a * foo bar*</p>\n'],
  ['_foo bar_', '<p><em>foo bar</em></p>\n'],
  ['foo_bar_', '<p>foo_bar_</p>\n'],
  ['5*6*78', '<p>5<em>6</em>78</p>\n'],
  ['**foo bar**', '<p><strong>foo bar</strong></p>\n'],
  ['foo**bar**', '<p>foo<strong>bar</strong></p>\n'],
  ['***strong emph***', '<p><em><strong>strong emph</strong></em></p>\n'],
  ['*foo **bar** baz*', '<p><em>foo <strong>bar</strong> baz</em></p>\n'],
  ['**foo*', '<p>*<em>foo</em></p>\n'],
  ['*foo**', '<p><em>foo</em>*</p>\n'],
  ['[link](/uri "title")', '<p><a href="/uri" title="title">link</a></p>\n'],
  ['[link](/uri)', '<p><a href="/uri">link</a></p>\n'],
  ['[link]()', '<p><a href="">link</a></p>\n'],
  ['[link](</my uri>)', '<p><a href="/my%20uri">link</a></p>\n'],
  ['[a](<b)c>)', '<p><a href="b)c">a</a></p>\n'],
  ['[link](foo(and(bar)))', '<p><a href="foo(and(bar))">link</a></p>\n'],
  ['[foo [bar](/uri)](/uri)', '<p>[foo <a href="/uri">bar</a>](/uri)</p>\n'],
  ['[foo]: /url "title"\n\n[foo]', '<p><a href="/url" title="title">foo</a></p>\n'],
  ['[foo][bar]\n\n[bar]: /url', '<p><a href="/url">foo</a></p>\n'],
  ['[Foo]\n\n[foo]: /url', '<p><a href="/url">Foo</a></p>\n'],
  ['[foo]: /a\n[foo]: /b\n\n[foo]', '<p><a href="/a">foo</a></p>\n'],
  ['[nope]', '<p>[nope]</p>\n'],
  ['![foo](/url "title")', '<p><img src="/url" alt="foo" title="title" /></p>\n'],
  ['![foo *bar*]\n\n[foo *bar*]: train.jpg "train"', '<p><img src="train.jpg" alt="foo bar" title="train" /></p>\n'],
  ['<http://foo.bar.baz>', '<p><a href="http://foo.bar.baz">http://foo.bar.baz</a></p>\n'],
  ['<foo@bar.example.com>', '<p><a href="mailto:foo@bar.example.com">foo@bar.example.com</a></p>\n'],
  ['foo  \nbaz', '<p>foo<br />\nbaz</p>\n'],
  ['foo\\\nbaz', '<p>foo<br />\nbaz</p>\n'],
  ['foo\nbaz', '<p>foo\nbaz</p>\n'],
  ['\\*not emphasized*', '<p>*not emphasized*</p>\n'],
  ['&copy; &amp; &#35; &#X22; &nosuchentity;', '<p>© &amp; # &quot; &amp;nosuchentity;</p>\n'],
]);

cases('GitHub extensions: tables, task lists, strikethrough, autolinks, footnotes', [
  ['| a | b |\n| - | - |\n| 1 | 2 |', '<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>\n'],
  ['| a | b | c |\n|:--|:-:|--:|\n| x |', '<table>\n<thead>\n<tr>\n<th align="left">a</th>\n<th align="center">b</th>\n<th align="right">c</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td align="left">x</td>\n<td align="center"></td>\n<td align="right"></td>\n</tr>\n</tbody>\n</table>\n'],
  ['| a |\n| - |\n| x \\| y |', '<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>x | y</td>\n</tr>\n</tbody>\n</table>\n'],
  ['| a | b |\n| - |\n| 1 | 2 |', '<p>| a | b |\n| - |\n| 1 | 2 |</p>\n'],
  ['- [ ] foo\n- [x] bar', '<ul>\n<li><input disabled="" type="checkbox"> foo</li>\n<li><input checked="" disabled="" type="checkbox"> bar</li>\n</ul>\n'],
  ['- [x]no space', '<ul>\n<li>[x]no space</li>\n</ul>\n'],
  ['~~Hi~~ Hello, ~there~ world!', '<p><del>Hi</del> Hello, <del>there</del> world!</p>\n'],
  ['a ~~~three~~~', '<p>a ~~~three~~~</p>\n'],
  ['www.commonmark.org and https://example.com/a?b=1.', '<p><a href="http://www.commonmark.org">www.commonmark.org</a> and <a href="https://example.com/a?b=1">https://example.com/a?b=1</a>.</p>\n'],
  ['(see https://example.com/a_(b))', '<p>(see <a href="https://example.com/a_(b)">https://example.com/a_(b)</a>)</p>\n'],
  ['Here[^1] and again[^1].\n\n[^1]: The note.', '<p>Here<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup> and again<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>.</p>\n<section class="footnotes">\n<ol>\n<li id="fn-1">\n<p>The note. <a href="#fnref-1" class="footnote-backref">↩</a></p>\n</li>\n</ol>\n</section>\n'],
  ['No ref[^missing].', '<p>No ref[^missing].</p>\n'],
]);

test('raw HTML is shown as text by default, can be dropped, or sent through a sanitiser you supply', () => {
  assert.equal(toHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
  assert.equal(toHtml('hi <img src=x onerror=alert(1)> there'), '<p>hi &lt;img src=x onerror=alert(1)&gt; there</p>\n');
  assert.equal(toHtml('<div>\nraw\n</div>\n\nafter', { rawHtml: 'omit' }), '<p>after</p>\n');
  assert.equal(toHtml('a <b>bold</b>', { rawHtml: (h) => (h === '<b>' || h === '</b>' ? h : '') }), '<p>a <b>bold</b></p>\n');
  assert.equal(toHtml('<!-- note -->\ntext'), '<p>&lt;!-- note --&gt;</p>\n<p>text</p>\n');
});

test('dangerous link and image schemes are never written; relative and safe ones are', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'vbscript:x', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd']) {
    const html = toHtml(`[x](<${bad}>) ![i](<${bad}>)`);
    assert.ok(!/href=|src=/.test(html), `${bad} -> ${html}`);
  }
  assert.equal(safeUrl('https://a.example/x?y=1#z'), 'https://a.example/x?y=1#z');
  assert.equal(safeUrl('mailto:a@b.example'), 'mailto:a@b.example');
  assert.equal(safeUrl('/relative/path'), '/relative/path');
  assert.equal(safeUrl('#frag'), '#frag');
  assert.equal(safeUrl('a b"c'), 'a%20b%22c');
  assert.equal(safeUrl('100%'), '100%25');
  assert.equal(toHtml('[x](https://a.example/"onmouseover="alert(1))'), '<p><a href="https://a.example/%22onmouseover=%22alert(1)">x</a></p>\n');
  assert.equal(toHtml('[a "b" <c>](/u "t\\"<")'), '<p><a href="/u" title="t&quot;&lt;">a &quot;b&quot; <c></a></p>\n'.replace('<c>', '&lt;c&gt;'));
});

test('external links can be marked, and attribute values are escaped', () => {
  assert.equal(toHtml('[x](https://e.example)', { externalLinks: true }), '<p><a href="https://e.example" target="_blank" rel="nofollow noopener">x</a></p>\n');
  assert.equal(toHtml('[x](/local)', { externalLinks: true }), '<p><a href="/local">x</a></p>\n');
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('positions: every block says where it came from, even nested', () => {
  const t = parse('# Title\n\nSome *text*\nmore\n\n> quoted\n\n- a\n- b\n\n```js\ncode\n```\n');
  const [h, p, q, l, c] = t.children!;
  assert.deepEqual(h!.position, { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } });
  assert.deepEqual(p!.position, { start: { line: 3, column: 1 }, end: { line: 4, column: 5 } });
  assert.deepEqual(q!.position!.start, { line: 6, column: 1 });
  assert.deepEqual(q!.children![0]!.position, { start: { line: 6, column: 3 }, end: { line: 6, column: 9 } });
  assert.deepEqual([l!.position!.start.line, l!.position!.end.line], [8, 9]);
  assert.deepEqual(l!.children![1]!.position!.start, { line: 9, column: 1 });
  assert.deepEqual([c!.position!.start.line, c!.position!.end.line], [11, 13]);
  assert.equal(c!.lang, 'js');
});

test('lists know whether they are tight, and positions decide it', () => {
  const tight = parse('- a\n- b\n  - c\n').children![0]!;
  assert.equal(tight.tight, true);
  const loose = parse('- a\n\n- b\n').children![0]!;
  assert.equal(loose.tight, false);
  const looseInner = parse('- a\n\n  b\n- c\n').children![0]!;
  assert.equal(looseInner.tight, false);
  const blankInCode = parse('- ```\n  a\n\n  b\n  ```\n- c\n').children![0]!;
  assert.equal(blankInCode.tight, true, 'a blank line inside a code block does not loosen the list');
});

test('the walker visits in order, can skip subtrees, and collect and textContent work', () => {
  const t = parse('# Hi *there*\n\n- one\n- two **bold**\n');
  const seen: string[] = [];
  walk(t, { enter: (n) => { seen.push(n.type); return n.type === 'list' ? false : undefined; } });
  assert.deepEqual(seen, ['document', 'heading', 'text', 'emphasis', 'text', 'list']);
  assert.equal(collect(t, 'strong').length, 1);
  assert.equal(textContent(t.children![0]!), 'Hi there');
  assert.equal(textContent(t.children![1]!), 'one\ntwo bold');
});

test('heading ids are stable, unique, and unicode-aware', () => {
  assert.equal(slugify('Hello, World! 2'), 'hello-world-2');
  assert.equal(slugify('Café au lait'), 'café-au-lait');
  assert.equal(slugify('日本語 の 見出し'), '日本語-の-見出し');
  assert.equal(slugify('!!!'), 'section');
  const t = parse('# Intro\n## Intro\n## Intro\n### Intro 1\n# Intro 2\n');
  assert.deepEqual(headingIds(t).map((h) => h.id), ['intro', 'intro-1', 'intro-2', 'intro-1-1', 'intro-2-1']);
  assert.equal(render(parse('# A b\n'), { headingIds: true }), '<h1 id="a-b">A b</h1>\n');
});

test('front matter: scalars, lists and quoting; garbage and prototype keys are refused; body lines are mapped back', () => {
  const src = '---\ntitle: "Hello: world"\ndraft: true\nweight: 3\ntags: [a, b, 4]\nauthors:\n  - Ana\n  - Bo\nsummary:\n---\n# Body\n';
  const fm = frontMatter(src);
  assert.deepEqual({ ...fm.data }, { title: 'Hello: world', draft: true, weight: 3, tags: ['a', 'b', 4], authors: ['Ana', 'Bo'], summary: null });
  assert.equal(fm.body, '# Body\n');
  assert.equal(fm.lines, 10);
  const r = parseWithFrontMatter(src);
  assert.equal(r.tree.children![0]!.position!.start.line, 11);
  assert.deepEqual(frontMatter('no front matter\n').data, {});
  assert.equal(frontMatter('---\nnot closed\n').body, '---\nnot closed\n');
  assert.throws(() => frontMatter('---\n???\n---\n'), MarkdownError);
  assert.throws(() => frontMatter('---\n__proto__: x\n---\n'), /not allowed/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('hostile input: deep nesting, huge input, unclosed constructs and delimiter floods stay bounded', () => {
  assert.throws(() => parse('>'.repeat(40) + ' x'), (e: Error) => e instanceof MarkdownError && /nesting/.test(e.message));
  assert.throws(() => parse('x'.repeat(100), { maxLength: 50 }), /limit/);
  const t0 = Date.now();
  toHtml('*a '.repeat(20000));
  toHtml('['.repeat(20000));
  toHtml('`'.repeat(20000) + 'x');
  toHtml('- '.repeat(20) + 'x');
  toHtml('![a](' + '('.repeat(5000));
  assert.ok(Date.now() - t0 < 5000, 'finished quickly');
  assert.equal(toHtml('\u0000'), '<p>�</p>\n');
  assert.equal(toHtml(''), '');
  assert.equal(toHtml('a\r\nb\rc'), '<p>a\nb\nc</p>\n');
});

test('tabs in indentation work as four-column stops', () => {
  assert.equal(toHtml('\tfoo\tbaz'), '<pre><code>foo\tbaz\n</code></pre>\n');
  assert.equal(toHtml('-\tfoo'), '<ul>\n<li>foo</li>\n</ul>\n');
});
