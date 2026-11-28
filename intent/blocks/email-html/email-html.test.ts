import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, inlineCss, rewriteLinks, toText, darkModeHints, supportReport, parseHtml, serialize, safeUrl, parseCss, parseSelector, specificity, misleadingLinks, decodeEntities, wrapText, prepareEmail, EmailHtmlError } from './index.ts';

test('sanitize removes scripts, handlers, frames and forms with their content', () => {
  const out = sanitize('<p onclick="x()">hi</p><script>alert(1)</script><iframe src="http://e"></iframe><form><input></form><object data="x"></object>');
  assert.equal(out, '<p>hi</p>');
});

test('sanitize refuses javascript: URLs even when disguised', () => {
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' \u0001javascript:x', 'jav&#x09;ascript:x', 'vbscript:x', 'data:text/html;base64,AAAA']) {
    const out = sanitize(`<a href="${u}">x</a>`);
    assert.ok(!/href/.test(out), u);
  }
  assert.match(sanitize('<a href="https://ok.example/p?a=1&amp;b=2">x</a>'), /href="https:\/\/ok.example\/p\?a=1&amp;b=2"/);
  assert.match(sanitize('<a href="mailto:a@b.example">x</a>'), /mailto:a@b.example/);
});

test('safeUrl rules for images', () => {
  assert.equal(safeUrl('cid:logo', { image: true }), true);
  assert.equal(safeUrl('data:image/png;base64,AAAA', { image: true }), false);
  assert.equal(safeUrl('data:image/png;base64,AAAA', { image: true, allowDataImage: true }), true);
  assert.equal(safeUrl('data:image/svg+xml;base64,AAAA', { image: true, allowDataImage: true }), false);
  assert.equal(safeUrl('//evil.example/x'), false);
});

test('sanitize filters styles: unknown properties, expression and non-http url() go', () => {
  const out = sanitize('<div style="color: red; position: fixed; background: url(javascript:x); width: expression(alert(1)); margin: 0">a</div>');
  assert.equal(out, '<div style="color: red; margin: 0">a</div>');
});

test('sanitize unwraps unknown tags, keeps text, and hardens target=_blank', () => {
  assert.equal(sanitize('<blink>hi <b>there</b></blink>'), 'hi <b>there</b>');
  assert.match(sanitize('<a href="https://x.example" target="_top">a</a>'), /target="_blank" rel="noopener noreferrer"/);
});

test('sanitize keeps media and font-face in a style block but drops @import and bad urls', () => {
  const out = sanitize('<html><head><style>@import url(http://e/x.css); p{color:red} @media (max-width:600px){p{color:blue}} a{background:url(javascript:x)}</style></head><body><p>x</p></body></html>');
  assert.match(out, /p \{ color: red \}/);
  assert.match(out, /@media/);
  assert.ok(!/@import|javascript/.test(out));
});

test('sanitize drops conditional comments that carry active content, keeps harmless ones', () => {
  assert.match(sanitize('<!--[if mso]><table><tr><td>x</td></tr></table><![endif]-->'), /\[if mso\]/);
  assert.ok(!/if mso/.test(sanitize('<!--[if mso]><script>x</script><![endif]-->')));
  assert.ok(!/ordinary/.test(sanitize('<!-- ordinary -->')));
});

test('parser tolerates broken markup, decodes entities, caps depth', () => {
  assert.equal(serialize(parseHtml('<p>one<p>two')), '<p>one</p><p>two</p>');
  assert.equal(serialize(parseHtml('<ul><li>a<li>b</ul>')), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(decodeEntities('&lt;&#65;&#x42;&amp;&nbsp;&bogus;&#0;'), '<AB& &bogus;�');
  assert.throws(() => parseHtml('<div>'.repeat(300)), EmailHtmlError);
  assert.throws(() => parseHtml('x'.repeat(2 * 1024 * 1024 + 1)), EmailHtmlError);
});

test('inlineCss applies specificity, order and important', () => {
  const html = '<style>p{color:red} .a{color:green} #i{color:blue} p{margin:1px} p.b{color:black !important} .a{color:pink}</style><p class="a" id="i">x</p><p class="b a">y</p>';
  const out = inlineCss(html).html;
  assert.match(out, /<p class="a" id="i" style="color: blue; margin: 1px">x<\/p>/);
  assert.match(out, /<p class="b a" style="color: black !important; margin: 1px">y<\/p>/);
  assert.ok(!/<style/.test(out));
});

test('inlineCss: own style attribute beats rules unless the rule is important', () => {
  const out = inlineCss('<style>p{color:red;margin:0} p{width:10px !important}</style><p style="color:blue;width:5px">x</p>').html;
  assert.match(out, /color: blue/);
  assert.match(out, /width: 10px !important/);
  assert.match(out, /margin: 0/);
});

test('inlineCss handles combinators and attribute selectors', () => {
  const html = '<style>div > p{color:red} table td{padding:2px} h1 + p{margin:0} a[href^="https"]{color:green} li:first-child{font-weight:bold}</style><div><p>a</p></div><table><tr><td>c</td></tr></table><h1>t</h1><p>after</p><a href="https://x">l</a><ul><li>1</li><li>2</li></ul>';
  const out = inlineCss(html).html;
  assert.match(out, /<div><p style="color: red">a<\/p><\/div>/);
  assert.match(out, /<td style="padding: 2px">/);
  assert.match(out, /<h1>t<\/h1><p style="margin: 0">after/);
  assert.match(out, /<a href="https:\/\/x" style="color: green">/);
  assert.match(out, /<li style="font-weight: bold">1<\/li><li>2/);
});

test('inlineCss retains media queries, hover rules and font-face; drops @import with a warning', () => {
  const r = inlineCss('<html><head><style>@import url(a.css); a:hover{color:red} @media (max-width:600px){.x{width:100%}} @font-face{font-family:F;src:url(f.woff)} p{color:red}</style></head><body><p>x</p></body></html>');
  assert.match(r.retainedCss, /@media/);
  assert.match(r.retainedCss, /a:hover/);
  assert.match(r.retainedCss, /@font-face/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.html, /<head><style>.*@media.*<\/style><\/head>/s);
  assert.match(r.html, /<p style="color: red">/);
});

test('selector parsing and specificity', () => {
  assert.deepEqual(specificity(parseSelector('#a .b p')!), [1, 1, 1]);
  assert.deepEqual(specificity(parseSelector('a[href].x:first-child')!), [0, 3, 1]);
  assert.equal(parseSelector('a:hover'), undefined);
  assert.equal(parseSelector('p::before'), undefined);
  assert.equal(parseCss('p{color:red;;bad} a{}').rules.length, 1);
});

test('rewriteLinks rewrites http links only and honours data-no-track', () => {
  const html = '<a href="https://a.example/x">A</a><a href="mailto:x@y.example">M</a><a href="#top">T</a><a href="tel:+1">P</a><a data-no-track href="https://b.example">N</a>';
  const seen: string[] = [];
  const out = rewriteLinks(html, (u, c) => {
    seen.push(`${u}|${c.text}`);
    return `https://t.example/c?u=${encodeURIComponent(u)}`;
  });
  assert.deepEqual(seen, ['https://a.example/x|A']);
  assert.match(out, /href="https:\/\/t.example\/c\?u=https%3A%2F%2Fa.example%2Fx"/);
  assert.match(out, /href="mailto:x@y.example"/);
  assert.match(out, /href="https:\/\/b.example"/);
  assert.throws(() => rewriteLinks('<a href="https://a.example">x</a>', () => 'javascript:alert(1)'), EmailHtmlError);
});

test('misleadingLinks flags text that shows a different host', () => {
  const m = misleadingLinks('<a href="https://evil.example/x">www.bank.example</a><a href="https://www.bank.example/x">bank.example</a><a href="https://x.example">click</a>');
  assert.equal(m.length, 1);
  assert.equal(m[0]!.href, 'https://evil.example/x');
});

test('toText: headings, lists, links, images, breaks, hidden preheader', () => {
  const html = '<div style="display:none">preheader</div><h1>Hello</h1><p>Visit <a href="https://x.example/p">our site</a> now.<br>Bye</p><ul><li>one</li><li>two</li></ul><ol start="3"><li>c</li></ol><img src="a.png" alt="Logo"><hr><p><a href="https://y.example">https://y.example</a></p>';
  const t = toText(html);
  assert.ok(!t.includes('preheader'));
  assert.match(t, /^HELLO\n=====\n\nVisit our site \(https:\/\/x.example\/p\) now\.\nBye\n\n- one\n- two\n\n3\. c\n/);
  assert.match(t, /\[Logo\]/);
  assert.match(t, /----------------------------------------\n\nhttps:\/\/y.example\n$/);
});

test('toText: tables as rows, layout tables as paragraphs, wrapping at 78', () => {
  const data = toText('<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Pen</td><td>2</td></tr></table>');
  assert.equal(data, 'Item | Qty\nPen | 2\n');
  const layout = toText('<table><tr><td>First</td></tr><tr><td>Second</td></tr></table>');
  assert.equal(layout, 'First\n\nSecond\n');
  const long = toText(`<p>${'word '.repeat(40)}</p>`);
  for (const l of long.split('\n')) assert.ok(l.length <= 78);
  assert.equal(wrapText('- ' + 'aa '.repeat(40).trim(), 30).split('\n')[1]!.startsWith('  '), true);
});

test('darkModeHints adds meta, color-scheme and an Outlook twin', () => {
  const out = darkModeHints('<html><head><title>t</title></head><body><p class="t">x</p></body></html>', { '.t': 'color: #eee; background-color: #111' });
  assert.match(out, /<meta name="color-scheme" content="light dark">/);
  assert.match(out, /@media \(prefers-color-scheme: dark\) \{ \.t \{ color: #eee !important; background-color: #111 !important \} \}/);
  assert.match(out, /\[data-ogsc\] \.t \{ color: #eee !important \}/);
  assert.match(out, /\[data-ogsb\] \.t \{ background-color: #111 !important \}/);
  assert.throws(() => darkModeHints('<p>x</p>', { 'a{}<script>': 'color:red' }), EmailHtmlError);
});

test('supportReport finds problems and orders by severity', () => {
  const html = '<html><head><style>.a{display:flex;color:var(--x)} .b{border-radius:4px}</style></head><body><div class="a"><img src="x.png"></div><form><input></form></body></html>';
  const r = supportReport(html);
  const names = r.map((f) => f.feature);
  assert.ok(names.includes('display: flex / grid'));
  assert.ok(names.includes('CSS variables (var())'));
  assert.ok(names.includes('<form> and form controls'));
  assert.ok(names.includes('image without alt text'));
  assert.ok(names.includes('no lang attribute on <html>'));
  assert.equal(r[0]!.severity, 'error');
  assert.deepEqual(r.map((f) => f.severity), [...r.map((f) => f.severity)].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
});

test('supportReport warns before Gmail clips at 102 KB', () => {
  const big = `<table><tr><td>${'x'.repeat(103 * 1024)}</td></tr></table>`;
  assert.ok(supportReport(big).some((f) => f.severity === 'error' && /KB/.test(f.feature)));
  const near = `<table><tr><td>${'x'.repeat(95 * 1024)}</td></tr></table>`;
  assert.ok(supportReport(near).some((f) => f.severity === 'warning' && /KB/.test(f.feature)));
});

test('prepareEmail runs the whole pipeline and cannot be talked into script by the input', () => {
  const r = prepareEmail('<html lang="en"><head><style>p{color:red}</style><script>x()</script></head><body><table><tr><td><p onmouseover="x()">Hi <a href="https://a.example">link</a></p></td></tr></table></body></html>', {
    dark: { p: 'color:#fff' },
    rewrite: (u) => `https://t.example/?u=${encodeURIComponent(u)}`,
  });
  assert.ok(!/script|onmouseover/.test(r.html));
  assert.match(r.html, /<p style="color: red">/);
  assert.match(r.html, /prefers-color-scheme/);
  assert.match(r.html, /t\.example/);
  assert.match(r.text, /Hi link \(https:\/\/t\.example/);
});
