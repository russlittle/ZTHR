import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Path, Svg, SvgError, circle, el, escapeAttr, escapeText, estimateTextWidth, group, labelled, line, num, paint, parsePath, pathEl, polygon, polyline, rect, serializePath, text, write } from './index.ts';

/** A small well-formedness check: tags nest and close, attributes are quoted and unique, and no stray "<" or "&" remains. */
function wellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    consumed += m[0].length;
    if (m[5] !== undefined) {
      assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(m[5]), `bare ampersand in text: ${m[5]}`);
      continue;
    }
    const names = [...m[3]!.matchAll(/\s+([\w:-]+)=/g)].map((x) => x[1]);
    assert.equal(new Set(names).size, names.length, `duplicate attribute in ${m[0]}`);
    if (m[1]) assert.equal(stack.pop(), m[2], `mismatched </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]!);
  }
  assert.equal(consumed, body.length, 'unparsed content left in the document');
  assert.deepEqual(stack, [], 'unclosed elements');
}

test('numbers: bounded precision, no trailing zeros, no -0, never NaN or infinity', () => {
  assert.equal(num(1), '1');
  assert.equal(num(1.5), '1.5');
  assert.equal(num(1 / 3), '0.333');
  assert.equal(num(1 / 3, 1), '0.3');
  assert.equal(num(-0.0001), '0');
  assert.equal(num(-0), '0');
  assert.equal(num(100), '100');
  assert.equal(num(2.0005, 3), '2.001');
  assert.throws(() => num(Number.NaN), /not a finite number/);
  assert.throws(() => num(Number.POSITIVE_INFINITY), SvgError);
});

test('escaping: text, attributes, characters XML cannot hold and unpaired surrogates', () => {
  assert.equal(escapeText('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(escapeAttr(`"quoted" & 'single'\n<tag>`), '&quot;quoted&quot; &amp; &apos;single&apos;&#10;&lt;tag&gt;');
  assert.equal(escapeText('a\u0000b\u0008c\u001fd'), 'abcd');
  assert.equal(escapeText('ok\ud800x\udc00y'), 'okxy', 'lone surrogates are dropped');
  assert.equal(escapeText('pair 😀 stays'), 'pair 😀 stays');
  assert.equal(escapeText('tab\tnewline\nstay'), 'tab\tnewline\nstay');
});

test('a document needs a title or must say it is decorative; its size and language are checked', () => {
  assert.throws(() => new Svg({ width: 10, height: 10 }), /needs a title/);
  assert.throws(() => new Svg({ width: 10, height: 10, title: '  ' }), /needs a title/);
  assert.throws(() => new Svg({ width: 0, height: 10, title: 't' }), /positive/);
  assert.throws(() => new Svg({ width: 10, height: Number.NaN, title: 't' }), /positive/);
  assert.throws(() => new Svg({ width: 10, height: 10, title: 't', lang: 'not a tag!' }), /language tag/);
  assert.throws(() => new Svg({ width: 10, height: 10, title: 't', idPrefix: '1bad' }), /idPrefix/);
  assert.doesNotThrow(() => new Svg({ width: 10, height: 10, decorative: true }));
});

test('the document wrapper: namespace, viewBox, role, title and description tied by aria-labelledby', () => {
  const s = new Svg({ width: 200, height: 100, title: 'Sales by month', desc: 'Sales rose from 3 in January to 9 in June.', lang: 'en' });
  s.add(rect(0, 0, 200, 100, { fill: '#eee' }));
  assert.equal(
    s.toString(),
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100" role="img" aria-labelledby="title desc" lang="en"><title id="title">Sales by month</title><desc id="desc">Sales rose from 3 in January to 9 in June.</desc><rect x="0" y="0" width="200" height="100" fill="#eee"/></svg>',
  );
});

test('a decorative picture is hidden from assistive technology and has no title; prefixes keep ids apart', () => {
  const d = new Svg({ width: 5, height: 5, decorative: true }).toString();
  assert.match(d, /aria-hidden="true"/);
  assert.ok(!d.includes('<title') && !d.includes('role='));
  const a = new Svg({ width: 5, height: 5, title: 'A', desc: 'about A', idPrefix: 'chart1' });
  const p = a.linearGradient('fill', [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }]);
  assert.equal(p, 'url(#chart1-fill)');
  assert.match(a.toString(), /aria-labelledby="chart1-title chart1-desc"/);
  assert.match(a.toString(), /<title id="chart1-title">A<\/title>/);
});

test('only the closed list of elements can be made: no script, foreignObject, animation or images', () => {
  for (const tag of ['script', 'foreignObject', 'animate', 'set', 'image', 'a', 'style', 'iframe']) assert.throws(() => el(tag), /not an element this writer can produce/, tag);
  assert.equal(write(el('g', { id: 'x' })), '<g id="x"/>');
});

test('attributes: event handlers, script URLs, external references and unsafe styles are refused', () => {
  assert.throws(() => el('rect', { onclick: 'alert(1)' }), /event-handler/);
  assert.throws(() => el('rect', { onLoad: 'x' }), /event-handler/);
  assert.throws(() => el('rect', { 'x y': '1' }), /not an attribute name/);
  assert.throws(() => el('rect', { '"><script>': '1' }), /not an attribute name/);
  assert.throws(() => el('use', { href: 'https://evil.example/x.svg#a' }), /may only point to an element in this document/);
  assert.throws(() => el('use', { 'xlink:href': 'javascript:alert(1)' }), /this document/);
  assert.equal(write(el('use', { href: '#sym' })), '<use href="#sym"/>');
  assert.throws(() => el('rect', { style: 'fill:url(http://evil/x)' }), /may not load anything/);
  assert.throws(() => el('rect', { style: '@import "x.css"' }), /may not load/);
  assert.equal(write(el('rect', { style: 'fill:url(#g)' })), '<rect style="fill:url(#g)"/>');
  assert.throws(() => el('rect', { 'data-x': 'javascript:alert(1)' }), /script or data URL/);
});

test('paints: colours, keywords and local gradients pass; anything that could load or inject is refused', () => {
  for (const ok of ['red', '#fff', '#1a2b3c4d', 'rgb(1, 2, 3)', 'hsl(120 50% 50% / 0.5)', 'none', 'currentColor', 'url(#g1)', 'url(#g1) red']) assert.equal(paint(ok), ok);
  for (const bad of ['url(http://x/y)', 'url(#g"onload="x)', 'red; background:url(x)', 'javascript:1', '#12', 'rgb(1,2,3);x', '']) assert.throws(() => paint(bad), SvgError, bad);
  assert.throws(() => rect(0, 0, 1, 1, { fill: 'url(https://evil/x)' }), /not a colour/);
});

test('the path builder writes compact, exact path data and refuses a path that does not start with a moveto', () => {
  const p = new Path().moveTo(10, 20).lineTo(30.5, -40).horizontalBy(5).verticalTo(7).curveTo(1, 2, 3, 4, 5, 6).smoothCurveTo(7, 8, 9, 10).quadTo(1, 1, 2, 2).smoothQuadTo(3, 3).arcTo(5, 5, 0, true, false, 10, 10).close();
  assert.equal(p.toString(), 'M10 20L30.5-40h5V7C1 2 3 4 5 6S7 8 9 10Q1 1 2 2T3 3A5 5 0 1 0 10 10Z');
  assert.throws(() => new Path().lineTo(1, 1), /begin with moveTo/);
  assert.throws(() => new Path().moveTo(1, Number.NaN), /not a finite number/);
  assert.throws(() => new Path().moveTo(0, 0).arcTo(-1, 1, 0, false, false, 1, 1), /negative/);
  assert.equal(new Path().moveTo(1 / 3, 2 / 3).toString(2), 'M0.33 0.67');
});

test('the path parser reads what browsers read: implicit repeats, compact arc flags, exponents and odd separators', () => {
  assert.deepEqual(parsePath('M10,20 30,40 50 60'), [{ command: 'M', args: [10, 20] }, { command: 'L', args: [30, 40] }, { command: 'L', args: [50, 60] }]);
  assert.deepEqual(parsePath('m1 2 3 4'), [{ command: 'm', args: [1, 2] }, { command: 'l', args: [3, 4] }]);
  assert.deepEqual(parsePath('M0 0a1 1 0 00.5.5'), [{ command: 'M', args: [0, 0] }, { command: 'a', args: [1, 1, 0, 0, 0, 0.5, 0.5] }]);
  assert.deepEqual(parsePath('M1e1-2.5E-1L.5.25'), [{ command: 'M', args: [10, -0.25] }, { command: 'L', args: [0.5, 0.25] }]);
  assert.deepEqual(parsePath('M0 0h1 2 3z'), [{ command: 'M', args: [0, 0] }, { command: 'h', args: [1] }, { command: 'h', args: [2] }, { command: 'h', args: [3] }, { command: 'z', args: [] }]);
  assert.deepEqual(parsePath('  '), []);
});

test('the path parser refuses malformed data with the offset', () => {
  assert.throws(() => parsePath('L1 1'), /begin with a moveto/);
  assert.throws(() => parsePath('M1'), /expected a number at offset 2/);
  assert.throws(() => parsePath('M1 1 X 2 2'), /"X" is not a path command/);
  assert.throws(() => parsePath('M0 0 A1 1 0 2 0 5 5'), /arc flag must be 0 or 1/);
  assert.throws(() => parsePath('M0 0 A-1 1 0 0 0 5 5'), /negative/);
  assert.throws(() => parsePath('M0 0 Z 5 5'), /unexpected "5"/);
  assert.throws(() => parsePath('M0 0 L1 1 <script>'), SvgError);
});

test('parsing then serialising normalises, and a second round changes nothing', () => {
  const messy = 'M 10,20 30,40 L50 60 c1,2 3,4 5,6 z';
  const once = serializePath(parsePath(messy));
  assert.equal(once, 'M10 20L30 40L50 60c1 2 3 4 5 6z');
  assert.equal(serializePath(parsePath(once)), once);
  assert.equal(pathEl('M 1,1 2,2').attrs['d'], 'M1 1L2 2');
  assert.throws(() => pathEl('garbage'), SvgError);
});

test('convenience paths: through points and a rounded rectangle that ends where it began', () => {
  assert.equal(Path.through([[0, 0], [10, 0], [10, 10]], true).toString(), 'M0 0L10 0L10 10Z');
  assert.equal(Path.through([]).toString(), '');
  const r = Path.roundedRect(0, 0, 100, 50, 10).toString();
  assert.equal(r, 'M10 0H90A10 10 0 0 1 100 10V40A10 10 0 0 1 90 50H10A10 10 0 0 1 0 40V10A10 10 0 0 1 10 0Z');
  assert.equal(Path.roundedRect(0, 0, 10, 10, 999).segments.filter((s) => s.command === 'A').length, 4, 'the radius is clamped to half the side');
  assert.equal(Path.roundedRect(0, 0, 10, 10, 0).toString(), 'M0 0H10V10H0V0Z');
});

test('gradients: stops are checked, the paint comes back, and ids cannot be used twice', () => {
  const s = new Svg({ width: 10, height: 10, title: 't' });
  const g = s.linearGradient('sky', [{ offset: 0, color: '#08f' }, { offset: 0.5, color: '#fff', opacity: 0.5 }, { offset: 1, color: 'rgb(0,0,0)' }], { x2: 0, y2: 1 });
  assert.equal(g, 'url(#sky)');
  s.add(rect(0, 0, 10, 10, { fill: g }));
  const out = s.toString();
  assert.match(out, /<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#08f"\/><stop offset="0.5" stop-color="#fff" stop-opacity="0.5"\/><stop offset="1" stop-color="rgb\(0,0,0\)"\/><\/linearGradient><\/defs>/);
  assert.match(out, /<rect x="0" y="0" width="10" height="10" fill="url\(#sky\)"\/>/);
  assert.throws(() => s.linearGradient('sky', [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }]), /already used/);
  assert.throws(() => s.linearGradient('one', [{ offset: 0, color: 'red' }]), /at least two stops/);
  assert.throws(() => s.linearGradient('two', [{ offset: 0.8, color: 'red' }, { offset: 0.2, color: 'blue' }]), /must not decrease/);
  assert.throws(() => s.radialGradient('three', [{ offset: 0, color: 'red' }, { offset: 1.5, color: 'blue' }]), /between 0 and 1/);
  assert.throws(() => s.linearGradient('four', [{ offset: 0, color: 'url(http://x)' }, { offset: 1, color: 'blue' }]), /not a colour/);
  assert.equal(s.radialGradient('glow', [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }], { r: 0.7 }), 'url(#glow)');
  assert.equal(s.clipPath('box', rect(0, 0, 5, 5)), 'url(#box)');
  assert.equal(s.nextId('tick'), 'tick-1');
});

test('text: escaped, multi-line becomes tspans, and markup in it stays text', () => {
  assert.equal(write(text('Q1 <b>& more</b>', 5, 10, { 'font-size': 12, 'text-anchor': 'middle' })), '<text x="5" y="10" font-size="12" text-anchor="middle">Q1 &lt;b&gt;&amp; more&lt;/b&gt;</text>');
  assert.equal(write(text('one\ntwo\r\nthree', 0, 10)), '<text x="0" y="10"><tspan x="0" dy="0">one</tspan><tspan x="0" dy="1.2em">two</tspan><tspan x="0" dy="1.2em">three</tspan></text>');
  const s = new Svg({ width: 9, height: 9, title: '</title><script>alert(1)</script>' });
  assert.ok(!s.toString().includes('<script>'));
  assert.match(s.toString(), /&lt;\/title&gt;&lt;script&gt;/);
});

test('shapes: polylines and polygons write points, negative sizes are refused, groups carry titles for assistive technology', () => {
  assert.equal(write(polyline([[0, 0], [1.23456, 2]])), '<polyline points="0,0 1.235,2" fill="none"/>');
  assert.equal(write(polygon([[0, 0], [4, 0], [2, 3]], { fill: 'red' })), '<polygon points="0,0 4,0 2,3" fill="red"/>');
  assert.equal(write(line(0, 0, 5, 5, { stroke: '#000', 'stroke-width': 0.5 })), '<line x1="0" y1="0" x2="5" y2="5" stroke="#000" stroke-width="0.5"/>');
  assert.throws(() => rect(0, 0, -1, 5), /negative/);
  assert.throws(() => circle(0, 0, -2), /negative/);
  assert.equal(write(labelled(group({ id: 'bar-3' }, circle(1, 1, 1)), 'March', 'Value 7')), '<g id="bar-3" role="img"><title>March</title><desc>Value 7</desc><circle cx="1" cy="1" r="1"/></g>');
});

test('output is well-formed and deterministic, plain or indented, with an optional XML declaration', () => {
  const build = () => {
    const s = new Svg({ width: 120, height: 60, title: 'Demo & <test>', desc: 'A "demo"', background: '#fff', idPrefix: 'd' });
    const g = s.linearGradient('g', [{ offset: 0, color: '#f00' }, { offset: 1, color: '#00f' }]);
    s.add(group({ 'clip-path': s.clipPath('c', rect(0, 0, 100, 50)) }, rect(10, 10, 80, 30, { fill: g, rx: 4 }), text("it's <1> & 'ok'", 20, 30), pathEl(Path.roundedRect(1, 1, 5, 5, 1), { fill: 'none', stroke: 'black' })));
    return s;
  };
  const plain = build().toString();
  assert.equal(plain, build().toString());
  wellFormed(plain);
  const pretty = build().toString({ pretty: true, xmlDeclaration: true });
  assert.ok(pretty.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg '));
  assert.ok(pretty.endsWith('</svg>\n'));
  wellFormed(pretty);
  assert.equal(pretty.replace(/^<\?xml[^>]*\?>\n/, '').replace(/\n\s*/g, ''), plain, 'indentation adds only whitespace between elements');
  assert.match(pretty, /\n {2}<title id="d-title">Demo &amp; &lt;test&gt;<\/title>/);
});

test('text width estimates grow with length and size, and wide characters count more than narrow ones', () => {
  assert.equal(estimateTextWidth('', 12), 0);
  assert.ok(estimateTextWidth('iiii', 10) < estimateTextWidth('nnnn', 10));
  assert.ok(estimateTextWidth('nnnn', 10) < estimateTextWidth('MMMM', 10));
  assert.equal(estimateTextWidth('abcd', 20), 2 * estimateTextWidth('abcd', 10));
  assert.equal(estimateTextWidth('日本', 10), 20);
  assert.ok(Math.abs(estimateTextWidth('Hello', 10) - (0.68 + 0.54 + 0.28 + 0.28 + 0.54) * 10) < 1e-9);
});
