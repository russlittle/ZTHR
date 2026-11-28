import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessibleName, check, composite, contrastRatio, focusOrder, formatReport, luminance, parseColor } from './index.ts';
import { parse, query } from '../html-parse/index.ts';

const rules = (html: string, o = {}) => check(html, o).findings.map((f) => f.rule);
const only = (html: string, rule: string, o = {}) => check(html, o).findings.filter((f) => f.rule === rule);

test('contrast ratios match the WCAG definition at its known points', () => {
  const white = { r: 255, g: 255, b: 255 };
  assert.equal(contrastRatio({ r: 0, g: 0, b: 0 }, white), 21);
  assert.equal(contrastRatio(white, white), 1);
  assert.equal(contrastRatio(parseColor('#767676')!, white).toFixed(2), '4.54');
  assert.equal(contrastRatio(parseColor('#777777')!, white).toFixed(2), '4.48');
  assert.equal(contrastRatio(parseColor('#ff0000')!, white).toFixed(2), '4.00');
  assert.equal(contrastRatio(parseColor('#595959')!, white).toFixed(2), '7.00');
  assert.equal(luminance({ r: 255, g: 255, b: 255 }), 1);
  assert.equal(luminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(contrastRatio(white, parseColor('#767676')!), contrastRatio(parseColor('#767676')!, white), 'order does not matter');
});

test('colours read in every common form, and unknown ones are not guessed', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#336699'), { r: 51, g: 102, b: 153, a: 1 });
  assert.deepEqual(parseColor('#33669980'), { r: 51, g: 102, b: 153, a: 128 / 255 });
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseColor('hsl(120 100% 25%)'), { r: 0, g: 128, b: 0, a: 1 });
  assert.deepEqual(parseColor('NAVY'), { r: 0, g: 0, b: 128, a: 1 });
  for (const bad of ['', 'notacolor', '#12', '#12345', 'rgb(1,2)', 'var(--x)', 'currentcolor', 'rebeccapurple']) assert.equal(parseColor(bad), null, bad);
  assert.deepEqual(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 }), { r: 128, g: 128, b: 128, a: 1 });
});

test('low contrast text is found with its ratio; the large-text allowance and AAA level apply', () => {
  const grey = '<p style="color:#777777">Quiet text</p>';
  const f = only(grey, 'color-contrast');
  assert.equal(f.length, 1);
  assert.match(f[0]!.message, /^The contrast ratio is 4\.48:1; 4\.5:1 is needed for text\./);
  assert.equal(f[0]!.wcag, '1.4.3');
  assert.deepEqual(rules('<p style="color:#767676">Fine</p>'), []);
  assert.deepEqual(rules('<p style="color:#777777;font-size:24px">Large</p>'), [], 'large text needs only 3:1');
  assert.deepEqual(rules('<p style="color:#777777;font-size:19px;font-weight:700">Bold large</p>'), []);
  assert.equal(only('<p style="color:#777777;font-size:17px;font-weight:700">Bold, not large</p>', 'color-contrast').length, 1);
  assert.equal(only('<p style="color:#767676">AAA</p>', 'color-contrast', { level: 'AAA' })[0]?.wcag, '1.4.6');
  const h = only('<h1 style="color:#aaaaaa">Big heading</h1>', 'color-contrast');
  assert.equal(h.length, 1, '#aaa on white is 2.32:1, below even the large-text 3:1');
  assert.match(h[0]!.message, /3:1 is needed for large text/);
});

test('contrast follows inherited colour, backgrounds on ancestors, transparency, and gives up on images', () => {
  assert.equal(only('<div style="background:#000000"><p style="color:#222222">dark on dark</p></div>', 'color-contrast').length, 1);
  assert.deepEqual(rules('<div style="background-color:#000"><p style="color:#fff">light on dark</p></div>'), []);
  assert.equal(only('<div style="color:#999999"><section><p>inherits</p></section></div>', 'color-contrast').length, 1, 'colour inherited from an ancestor');
  assert.equal(only('<div style="background:rgba(0,0,0,0.1)"><p style="color:#8a8a8a">over translucent</p></div>', 'color-contrast').length, 1, 'composited over white first');
  assert.deepEqual(rules('<div style="background-image:url(a.png)"><p style="color:#999">unknown backdrop</p></div>'), [], 'not judged when the backdrop is unknown');
  assert.deepEqual(rules('<p style="color:var(--x)">custom property</p>'), [], 'not judged when the colour is not known');
  assert.deepEqual(rules('<p>no colours declared at all</p>'), []);
  assert.deepEqual(rules('<p hidden style="color:#fefefe">hidden</p><p style="display:none;color:#fefefe">gone</p>'), []);
});

test('images need alt text; a file name is not a description; decorative images are allowed', () => {
  assert.deepEqual(only('<img src="a.png">', 'image-alt').map((f) => f.impact), ['critical']);
  assert.deepEqual(rules('<img src="a.png" alt="">'), [], 'empty alt marks it decorative');
  assert.deepEqual(rules('<img src="a.png" role="presentation">'), []);
  assert.deepEqual(rules('<img src="a.png" aria-label="Logo">'), []);
  assert.equal(only('<img src="a.png" alt="IMG_0042.jpg">', 'image-alt-filename').length, 1);
  assert.equal(only('<img src="a.png" alt="image">', 'image-alt-filename').length, 1);
  assert.deepEqual(rules('<img src="a.png" alt="A red kite over a field">'), []);
  assert.equal(only('<input type="image" src="go.png">', 'input-image-alt').length, 1);
  assert.deepEqual(rules('<input type="image" src="go.png" alt="Search">'), []);
  assert.equal(only('<img src="a.png" alt="" aria-label="x">', 'image-alt-conflict').length, 1);
});

test('links, buttons, frames and fields need names', () => {
  assert.equal(only('<a href="/x"></a>', 'link-name').length, 1);
  assert.deepEqual(rules('<a href="/x"><img src="i.png" alt="Home"></a>'), []);
  assert.equal(only('<a href="/x"><img src="i.png" alt=""></a>', 'link-name').length, 1);
  assert.equal(only('<a href="/x">click here</a>', 'link-purpose').length, 1);
  assert.deepEqual(rules('<a name="anchor"></a>'), [], 'an anchor with no href is not a link');
  assert.equal(only('<button></button>', 'button-name').length, 1);
  assert.deepEqual(rules('<button>Save</button><button aria-label="Close">x</button><input type="submit"><div role="button" aria-label="Go"></div>'), []);
  assert.equal(only('<div role="button"></div>', 'button-name').length, 1);
  assert.equal(only('<iframe src="https://x.test"></iframe>', 'frame-title').length, 1);
  assert.deepEqual(rules('<iframe title="Map" src="https://x.test"></iframe>'), []);
  assert.equal(only('<input type="text" id="n">', 'label').length, 1);
  assert.match(only('<input type="text" placeholder="Name">', 'label')[0]!.message, /placeholder/);
  assert.deepEqual(rules('<label for="n">Name</label><input id="n"><label>Mail <input type="email"></label><input aria-label="Q"><input type="hidden" name="t"><select aria-labelledby="l"></select><span id="l">Pick</span>'), []);
  assert.equal(only('<select></select><textarea></textarea>', 'label').length, 2);
});

test('the accessible name uses labelledby first, ignores hidden content, and counts child images', () => {
  const doc = parse('<span id="a">Alpha</span><span id="b" hidden>Hidden</span><button id="x" aria-labelledby="a b" aria-label="Zed">T</button><button id="y" aria-label="Zed">T</button><button id="z">Go <span hidden>no</span><img alt="now" src="i"> <i aria-hidden="true">x</i></button><a id="t" href="/" title="Titled"></a>');
  const name = (id: string) => accessibleName(query(doc, `#${id}`)[0]!, doc);
  assert.equal(name('x'), 'Alpha Hidden', 'labelledby may name from a hidden element, and beats aria-label');
  assert.equal(name('y'), 'Zed');
  assert.equal(name('z'), 'Go now');
  assert.equal(name('t'), 'Titled');
});

test('references to ids that do not exist, and duplicate ids, are reported', () => {
  assert.equal(only('<input aria-labelledby="nope" aria-label="x">', 'aria-reference').length, 1);
  assert.equal(only('<label for="ghost">x</label>', 'label-for').length, 1);
  const dup = only('<div id="a"></div><p id="a"></p><i id="a"></i>', 'duplicate-id');
  assert.equal(dup.length, 2);
  assert.match(dup[0]!.message, /"a" is used more than once/);
});

test('ARIA misuse: unknown roles and attributes, hidden but focusable, presentational controls', () => {
  assert.equal(only('<div role="buton">x</div>', 'aria-role').length, 1);
  assert.deepEqual(rules('<div role="navigation search">x</div>'), [], 'the first known role in the list is used');
  assert.equal(only('<div aria-lable="x">x</div>', 'aria-attr').length, 1);
  assert.deepEqual(rules('<div aria-live="polite" aria-atomic="true">x</div>'), []);
  assert.equal(only('<div aria-hidden="true"><a href="/x">x</a></div>', 'aria-hidden-focus').length, 1);
  assert.deepEqual(rules('<div aria-hidden="true"><a href="/x" tabindex="-1">x</a></div>'), []);
  assert.equal(only('<button role="presentation">x</button>', 'presentation-focusable').length, 1);
  assert.equal(only('<a href="/x">go <button>b</button></a>', 'nested-interactive').length, 1);
  assert.equal(only('<div role="checkbox"></div>', 'aria-name').length, 1);
});

test('tab order: positive tabindex is flagged and goes first; hidden and disabled things are skipped', () => {
  const html = '<a href="/1" id="one">1</a><button id="two" tabindex="3">2</button><input id="three" tabindex="1"><div id="four" tabindex="0">4</div><span id="five" tabindex="-1">5</span><button id="six" disabled>6</button><a id="seven">7</a><div hidden><a href="/h" id="eight">8</a></div><input type="hidden" id="nine"><a href="/10" id="ten">10</a>';
  const order = focusOrder(parse(html)).map((e) => e.attrs.find((a) => a.name === 'id')!.value);
  assert.deepEqual(order, ['three', 'two', 'one', 'four', 'ten']);
  const f = only(html, 'tabindex-positive');
  assert.equal(f.length, 2);
  assert.equal(f[0]!.impact, 'serious');
});

test('headings: skipped levels, empty headings, extra h1', () => {
  assert.deepEqual(rules('<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2>'), []);
  const skip = only('<h1>A</h1><h3>C</h3>', 'heading-order');
  assert.equal(skip.length, 1);
  assert.match(skip[0]!.message, /h1 to h3/);
  assert.equal(only('<h2></h2><h2><span hidden>x</span></h2>', 'empty-heading').length, 2);
  assert.equal(only('<h1>A</h1><h1>B</h1>', 'multiple-h1').length, 1);
  assert.deepEqual(rules('<h2>Starts at two</h2><h3>ok</h3>'), [], 'a fragment may start at any level');
});

test('landmarks: one main, labelled duplicate navs, one banner; a full page needs a main', () => {
  assert.equal(only('<main>a</main><main>b</main>', 'landmark-one-main').length, 1);
  assert.equal(only('<nav><a href="/">Home</a></nav><nav><a href="/x">X</a></nav>', 'landmark-unique').length, 2);
  assert.deepEqual(rules('<nav aria-label="Main"><a href="/">Home</a></nav><nav aria-label="Footer"><a href="/x">X</a></nav>'), []);
  assert.equal(only('<header>a</header><header>b</header>', 'landmark-banner').length, 1);
  assert.deepEqual(rules('<article><header>a</header></article><header>top</header>'), [], 'a header inside an article is not a banner');
  assert.equal(only('<p>x</p>', 'landmark-one-main', { fullPage: true }).length, 1);
  assert.equal(only('<form></form><form></form>', 'landmark-unique').length, 2);
});

test('a whole page needs a language, a title and a zoomable viewport', () => {
  const good = '<html lang="en-GB"><head><title>Page</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main><h1>x</h1></main></body></html>';
  assert.deepEqual(rules(good, { fullPage: true }), []);
  assert.deepEqual(rules('<html><head><title></title></head><body></body></html>'), ['html-lang', 'document-title']);
  assert.equal(only('<html lang="english please"><head><title>T</title></head></html>', 'html-lang-valid').length, 1);
  assert.equal(only('<meta name="viewport" content="width=device-width, user-scalable=no">', 'viewport-zoom')[0]?.impact, 'critical');
  assert.equal(only('<meta name="viewport" content="width=device-width, maximum-scale=1">', 'viewport-zoom').length, 1);
  assert.deepEqual(rules('<meta name="viewport" content="width=device-width, maximum-scale=5">'), []);
  assert.equal(only('<meta http-equiv="refresh" content="5; url=/x">', 'meta-refresh').length, 1);
  assert.deepEqual(rules('<meta http-equiv="refresh" content="0; url=/x">'), [], 'an immediate redirect is allowed');
});

test('video needs captions, data tables need headers, lists need list items', () => {
  assert.equal(only('<video src="v.mp4" controls></video>', 'video-captions').length, 1);
  assert.deepEqual(rules('<video controls><track kind="captions" src="c.vtt"></video>'), []);
  assert.equal(only('<audio src="a.mp3" autoplay></audio>', 'media-autoplay').length, 1);
  assert.equal(only('<table><tr><td>1</td></tr></table>', 'table-headers').length, 1);
  assert.deepEqual(rules('<table><tr><th>A</th></tr><tr><td>1</td></tr></table>'), []);
  assert.deepEqual(rules('<table role="presentation"><tr><td>layout</td></tr></table>'), []);
  assert.equal(only('<ul><div>x</div></ul>', 'list-children').length, 1);
  assert.equal(only('<div><li>x</li></div>', 'li-parent').length, 1);
});

test('the report counts by impact, sorts the worst first, says where, and can skip rules', () => {
  const r = check('<main id="m"><img src="a.png"><h1>T</h1><h3>U</h3><a href="/x">more</a></main>');
  assert.deepEqual(r.counts, { critical: 1, serious: 0, moderate: 1, minor: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => f.rule), ['image-alt', 'heading-order', 'link-purpose']);
  assert.equal(r.findings[0]!.where, 'main#m > img');
  assert.equal(r.findings[0]!.html, '<img src="a.png">');
  assert.equal(check('<img src="a.png">', { skip: ['image-alt'] }).findings.length, 0);
  const clean = check('<main><h1>T</h1><p>Hello</p></main>');
  assert.equal(clean.ok, true);
  assert.equal(formatReport(clean), 'No accessibility problems found in 3 elements.');
  assert.equal(formatReport(r).split('\n')[0], '3 problems: 1 critical, 1 moderate, 1 minor');
  assert.match(formatReport(r), /\[critical\] image-alt \(WCAG 1\.1\.1\) main#m > img:/);
});

test('hostile markup does not break the checker, and its text stays text', () => {
  const r = check('<img src=x onerror="alert(1)"><a href="javascript:alert(1)"><script>alert(1)</script></a>' + '<div>'.repeat(200) + '<p style="color:' + 'x'.repeat(10_000) + '">t</p>');
  assert.ok(r.findings.some((f) => f.rule === 'image-alt'));
  assert.ok(r.findings.every((f) => f.html.length <= 160), 'tags in the report are capped');
  assert.equal(r.findings.some((f) => f.rule === 'color-contrast'), false);
});
