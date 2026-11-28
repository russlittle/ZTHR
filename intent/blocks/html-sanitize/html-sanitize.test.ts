import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASIC, PLAIN, RICH, TooLarge, cleanStyle, cleanUrl, decodeEntities, escapeAttr, sanitize, toText, type Policy } from './index.ts';

const clean = (html: string, p: Policy = RICH) => sanitize(html, p);
/** Nothing in the output may let script run: no script tag, no handler, no javascript: scheme. */
const inert = (out: string) => !/<script|<iframe|<object|<embed|<svg|<math|<style|\son\w+\s*=|javascript:|vbscript:|data:text/i.test(out);

test('allowed markup passes through unchanged and is canonical', () => {
  assert.equal(clean('<p>Hello <b>world</b> and <em>you</em>.</p>'), '<p>Hello <b>world</b> and <em>you</em>.</p>');
  assert.equal(clean('<ul><li>one</li><li>two</li></ul>'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(clean('<P CLASS=x><B>Loud</B></P>'), '<p><b>Loud</b></p>', 'tags are lower-cased and class is dropped by default');
  assert.equal(clean('line<br/>two<hr>'), 'line<br>two<hr>');
  assert.equal(clean('<h1 title="T">x</h1>'), '<h1 title="T">x</h1>');
});

test('text is escaped, entities are normalised, and a stray < is just a character', () => {
  assert.equal(clean('1 < 2 && 3 > 2'), '1 &lt; 2 &amp;&amp; 3 &gt; 2');
  assert.equal(clean('a &amp; b &lt;script&gt; &copy; &#x41; &#66; &bogus;'), 'a &amp; b &lt;script&gt; © A B &amp;bogus;');
  assert.equal(clean('<<b>x</b>'), '&lt;<b>x</b>');
  assert.equal(clean('a<3 b'), 'a&lt;3 b');
  assert.equal(clean('&lt;img src=x onerror=alert(1)&gt;'), '&lt;img src=x onerror=alert(1)&gt;', 'escaped markup stays text');
  assert.equal(decodeEntities('&#0; &#xD800; &#x110000;'), '� � �');
  assert.equal(escapeAttr(`"'<>&\``), '&quot;&#39;&lt;&gt;&amp;&#96;');
});

test('script, style, iframe and the other containers are removed with their content', () => {
  assert.equal(clean('a<script>alert(1)</script>b'), 'ab');
  assert.equal(clean('a<SCRIPT SRC=//evil/x.js></SCRIPT>b'), 'ab');
  assert.equal(clean('a<style>@import "x"; body{}</style>b'), 'ab');
  assert.equal(clean('a<iframe src="https://evil"></iframe>b'), 'ab');
  assert.equal(clean('a<object data=x><param name=a></object>b<embed src=x>c'), 'abc');
  assert.equal(clean('a<form action=/x><input name=q><button>go</button></form>b'), 'ab');
  assert.equal(clean('a<template><img src=x onerror=alert(1)></template>b'), 'ab');
  assert.equal(clean('a<svg onload=alert(1)><script>alert(2)</script><circle/></svg>b'), 'ab');
  assert.equal(clean('a<math><mi xlink:href="javascript:alert(1)">x</mi></math>b'), 'ab');
  assert.equal(clean('a<meta http-equiv=refresh content="0;url=javascript:alert(1)"><link rel=stylesheet href=x><base href=//evil/>b'), 'ab');
  assert.equal(clean('a<textarea><img src=x onerror=1></textarea>b<title><b>t</b></title>c'), 'abc');
});

test('unknown tags are unwrapped, their text kept', () => {
  assert.equal(clean('<blink>hi</blink> <marquee>there</marquee> <custom-el a=b>x</custom-el>'), 'hi there x');
  assert.equal(clean('<section><article><p>kept</p></article></section>', BASIC), '<p>kept</p>');
  assert.equal(clean('<b>a</b><i>b</i>', PLAIN), 'ab');
});

test('event handlers and dangerous attributes never survive, whatever the spelling', () => {
  for (const html of ['<img src=x onerror=alert(1)>', '<img/src=x/onerror=alert(1)>', '<IMG SRC=x ONERROR=alert(1)>', '<img src="x" onerror = "alert(1)">', '<img src=x onerror=alert(1)//', '<img src=x\nonerror\n=\nalert(1)>', '<img src=x onload=1 onclick=2 onmouseover=3>', '<details open ontoggle=alert(1)>x</details>', '<a href=/ onclick=alert(1)>x</a>', '<p onmouseover=alert(1) style="x">hi</p>', '<img src=x srcset="javascript:alert(1) 1x">', '<a href=/ formaction=javascript:alert(1)>x</a>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>']) {
    const out = clean(html);
    assert.ok(inert(out), `${html} => ${out}`);
  }
  assert.equal(clean('<img src=x onerror=alert(1)>'), '<img src="x" loading="lazy" referrerpolicy="no-referrer">');
  assert.equal(clean('<img src=x onerror=alert(1)//'), '', 'an unfinished tag at the end is discarded whole');
  assert.equal(clean('<a href="/ok" id="x" name="y" tabindex=1 data-evil=1 contenteditable>t</a>'), '<a href="/ok" rel="noopener noreferrer">t</a>');
});

test('URLs: schemes are checked after a browser\'s cleaning, so disguises do not work', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'jav&#x61;script:alert(1)', '&#106;avascript:alert(1)', 'javascript&colon;alert(1)', '&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)', '\u0001javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'file:///etc/passwd', 'blob:https://x/1', 'about:blank', 'http:///evil', 'https:evil.com']) {
    const out = clean(`<a href="${href.replace(/"/g, '&quot;')}">x</a>`);
    assert.equal(out, '<a>x</a>'.replace('<a>', '<a>'), `${JSON.stringify(href)} => ${out}`);
  }
  assert.equal(clean('<a href="https://example.org/a?b=1&c=2#d">x</a>'), '<a href="https://example.org/a?b=1&amp;c=2#d" rel="noopener noreferrer">x</a>');
  assert.equal(clean('<a href="MAILTO:a@b.example">x</a>'), '<a href="MAILTO:a@b.example" rel="noopener noreferrer">x</a>');
  assert.equal(clean('<a href="tel:+15550100">x</a>'), '<a href="tel:+15550100" rel="noopener noreferrer">x</a>');
  assert.equal(clean('<a href="tel:+15550100">x</a>', BASIC), '<a>x</a>', 'the basic policy has no tel:');
});

test('relative URLs are fine; protocol-relative ones (even with backslashes) are not unless allowed', () => {
  for (const href of ['/path/x', './x', '../x', 'x/y', '?q=1', '#top', 'a:b'.replace('a:b', 'page.html')]) assert.match(clean(`<a href="${href}">x</a>`), /^<a href="[^"]+" rel/, href);
  for (const href of ['//evil.example/x', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '\n//evil.example']) assert.equal(clean(`<a href="${href}">x</a>`), '<a>x</a>', JSON.stringify(href));
  assert.match(clean('<a href="//cdn.example/x">x</a>', { ...RICH, allowProtocolRelative: true }), /href="\/\/cdn.example\/x"/);
  assert.equal(clean('<a href="/x">x</a>', { ...RICH, allowRelative: false }), '<a>x</a>');
});

test('links get rel=noopener noreferrer, target is limited to _blank, nofollow on request', () => {
  assert.equal(clean('<a href="https://x.example" target="_blank" rel="opener">x</a>'), '<a href="https://x.example" rel="noopener noreferrer" target="_blank">x</a>');
  assert.equal(clean('<a href="https://x.example" target="_top">x</a>'), '<a href="https://x.example" rel="noopener noreferrer">x</a>');
  assert.equal(clean('<a href="https://x.example" target="_blank">x</a>', BASIC), '<a href="https://x.example" rel="noopener noreferrer nofollow">x</a>', 'BASIC does not allow target at all, and adds nofollow');
  assert.equal(clean('<a name="anchor">x</a>'), '<a>x</a>');
});

test('images: http(s) sources only, no source no image, small base64 images only when allowed', () => {
  assert.equal(clean('<img src="https://x.example/a.png" alt="A &quot;pic&quot;" width="10" height="abc">'), '<img src="https://x.example/a.png" alt="A &quot;pic&quot;" width="10" loading="lazy" referrerpolicy="no-referrer">');
  assert.equal(clean('<img alt="nothing">'), '');
  assert.equal(clean('<img src="javascript:alert(1)">'), '');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(clean(`<img src="${png}">`), '', 'data images are off by default');
  assert.match(clean(`<img src="${png}">`, { ...RICH, allowDataImages: true }), /src="data:image\/png;base64,iVBORw0KGgo="/);
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,@@@', 'data:image/png,<script>']) assert.equal(clean(`<img src="${bad}">`, { ...RICH, allowDataImages: true }), '', bad);
  assert.equal(clean(`<img src="data:image/png;base64,${'A'.repeat(400)}">`, { ...RICH, allowDataImages: true, maxDataImageBytes: 100 }), '', 'too big');
});

test('style: dropped by default; with an allow-list only plain values of listed properties survive', () => {
  assert.equal(clean('<p style="color:red">x</p>'), '<p>x</p>');
  const pol: Policy = { ...RICH, tags: { ...RICH.tags, p: ['style'], span: ['style'] }, styleProperties: ['color', 'text-align', 'font-weight'] };
  assert.equal(clean('<p style="color: red; text-align:center; position:fixed; font-weight: 700">x</p>', pol), '<p style="color: red; text-align: center; font-weight: 700">x</p>');
  assert.equal(clean('<span style="color:red;background:url(javascript:alert(1))">x</span>', pol), '<span style="color: red">x</span>');
  for (const v of ['color:expression(alert(1))', 'color:\\72 ed', 'color:red/*x*/', 'color:url(x)', 'color:javascript:x', 'color:red !important', 'color:red;;;', 'color:' + 'a'.repeat(200)]) {
    const out = cleanStyle(v, ['color']);
    assert.ok(out === null || out === 'color: red', `${v} => ${out}`);
    if (v !== 'color:red;;;') assert.equal(out, null, v);
  }
  assert.equal(cleanStyle('color:&#x72;ed', ['color']), 'color: red', 'entities are decoded first, then judged');
  assert.equal(cleanStyle('color:red;color:blue', ['color']), 'color: red; color: blue');
});

test('class names: allowed only from a list', () => {
  const pol: Policy = { ...RICH, tags: { ...RICH.tags, div: ['class'], span: ['class'] }, classes: ['note', 'hl-*'] };
  assert.equal(clean('<div class="note evil hl-yellow x y">x</div>', pol), '<div class="note hl-yellow">x</div>');
  assert.equal(clean('<span class="evil">x</span>', pol), '<span>x</span>');
  assert.equal(clean('<span class="note&quot; onmouseover=&quot;x">x</span>', pol), '<span>x</span>');
});

test('mutation XSS and parser-confusion vectors come out inert', () => {
  const vectors = [
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '<svg><p><style><a title="</style><img src onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<<script>script>alert(1)<</script>/script>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
    '<a href="x"><!--</a><img src=x onerror=alert(1)>-->',
    '<!--><img src=x onerror=alert(1)>-->',
    '<!---><img src=x onerror=alert(1)>',
    '<!-- --!><img src=x onerror=alert(1)>',
    '<![CDATA[<img src=x onerror=alert(1)>]]>',
    '<?xml ><img src=x onerror=alert(1)>',
    '</ img src=x onerror=alert(1)>',
    '<img src=x onerror=alert(1) <b>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<plaintext><img src=x onerror=alert(1)>',
    '<img src="x" alt="`onerror=alert(1)">',
    '<p title="a" title="b" onclick=1>x</p>',
    '<scr\u0000ipt>alert(1)</scr\u0000ipt>',
    '<img src=x onerror=&#97;lert(1)>',
    '<a href="x" style=x:expression(alert(1))>y</a>',
    '<div style="background:url(\'javascript:alert(1)\')">x</div>',
    '<select><template><style></select><img src=x onerror=alert(1)>',
  ];
  for (const v of vectors) {
    for (const p of [BASIC, RICH]) {
      const out = clean(v, p);
      assert.ok(inert(out), `${JSON.stringify(v)} => ${out}`);
      // Sanitising again changes nothing: the output is already canonical and safe.
      assert.equal(clean(out, p), out, `not stable: ${out}`);
    }
  }
  assert.equal(clean('<!--><img src=x onerror=alert(1)>-->'), '<img src="x" loading="lazy" referrerpolicy="no-referrer">--&gt;', 'the empty comment ends at once, as in a browser; the image stays but its handler is gone');
  assert.equal(clean('<p title="a" title="b" onclick=1>x</p>'), '<p title="a">x</p>', 'the first of two equal attributes wins');
  assert.equal(clean('<scr\u0000ipt>alert(1)</scr\u0000ipt>'), 'alert(1)', 'a NUL does not hide the tag; it is no script element, only text');
});

test('the output is balanced: open elements are closed, stray end tags ignored, depth and size limited', () => {
  assert.equal(clean('<p><b>one<i>two'), '<p><b>one<i>two</i></b></p>');
  assert.equal(clean('x</p></b></div>y'), 'xy');
  assert.equal(clean('<b><i>x</b>y</i>'), '<b><i>x</i></b>y');
  assert.equal(clean('<div>'.repeat(100) + 'deep' + '</div>'.repeat(100), { ...RICH, maxDepth: 5 }), '<div>'.repeat(5) + 'deep' + '</div>'.repeat(5));
  assert.throws(() => clean('x'.repeat(2000), { ...RICH, maxInput: 1000 }), TooLarge);
  assert.throws(() => clean('<b>x</b>'.repeat(100), { ...RICH, maxNodes: 50 }), /more than 50 nodes/);
  assert.equal(clean('<div>a</div>'.repeat(3) + '<br>'.repeat(3)).length > 0, true);
  assert.equal(clean(''), '');
});

test('cleanUrl directly: the cleaned URL is returned, or null', () => {
  const o = { schemes: ['http', 'https'] };
  assert.equal(cleanUrl('https://a.example/x', o), 'https://a.example/x');
  assert.equal(cleanUrl(' \thttps://a.example/x\n ', o), 'https://a.example/x');
  assert.equal(cleanUrl('ftp://a.example', o), null);
  assert.equal(cleanUrl('/x', { ...o, allowRelative: false }), null);
  assert.equal(cleanUrl('x'.repeat(9000), o), null);
  assert.equal(cleanUrl('https://a.example/\u0007x', o), null);
  assert.equal(cleanUrl('https://a.example/\u0007', o), 'https://a.example/', 'control characters at the ends are trimmed, as a browser does');
});

test('text extraction: blocks become lines, scripts vanish, entities decode, links can be shown', () => {
  const html = '<h1>Title</h1><p>Hello&nbsp;<b>wor</b>ld &amp; <a href="https://x.example/a">friends</a></p><script>alert(1)</script><style>p{}</style><ul><li>one</li><li>two</li></ul><p>last<br>line</p>';
  assert.equal(toText(html), 'Title\nHello world & friends\n- one\n- two\nlast\nline'.replace('Hello world', 'Hello world'));
  assert.equal(toText(html, { links: true }).split('\n')[1], 'Hello world & friends (https://x.example/a)');
  assert.equal(toText('<a href="javascript:alert(1)">bad</a>', { links: true }), 'bad');
  assert.equal(toText('a<div>b</div>c'), 'a\nb\nc');
  assert.equal(toText('<p>one</p><p></p><p></p><p></p><p>two</p>'), 'one\n\ntwo'.replace('\n\n', '\n'));
  assert.equal(toText('x'.repeat(50), { maxLength: 10 }), 'xxxxxxxxx…');
  assert.equal(toText('<!-- hidden --><p>shown</p><svg><text>no</text></svg>'), 'shown');
  assert.throws(() => toText('x'.repeat(1_000_001)), TooLarge);
});
