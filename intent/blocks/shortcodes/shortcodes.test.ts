import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, escapeHtml, expand, expandTags, has, LimitExceeded, MissingValue, parse, parseAttributes, strip } from './index.ts';
import type { Context, Handlers } from './index.ts';

const h = {
  b: (c: Context) => `<b>${c.content ?? ''}</b>`,
  quote: (c: Context) => `<q cite="${escapeHtml(c.attrs['cite'] ?? '')}">${c.content}</q>`,
  button: (c: Context) => `<a class="${c.positional.includes('primary') ? 'p' : 's'}">${escapeHtml(c.positional[0] ?? '')}</a>`,
  gallery: (c: Context) => `<gallery ids="${c.attrs['ids'] ?? ''}" cols="${c.attrs['columns'] ?? '3'}">`,
};
const out = (text: string, handlers: Handlers = h, o = {}) => expand(text, handlers, o).text;

test('a self-closing and an enclosing shortcode expand with their attributes', () => {
  assert.equal(out('A [gallery ids="1,2,3" columns=2] B'), 'A <gallery ids="1,2,3" cols="2"> B');
  assert.equal(out("[quote cite='Ann Lee']Words[/quote]"), '<q cite="Ann Lee">Words</q>');
  assert.equal(out('[gallery /]'), '<gallery ids="" cols="3">');
  assert.equal(out('[gallery/]'), '<gallery ids="" cols="3">');
  assert.equal(out('[b]x[/b] and [b]y[/b]'), '<b>x</b> and <b>y</b>');
});

test('attributes: named, quoted both ways, unquoted, positional and bare flags', () => {
  const a = parseAttributes(`id=7 title="Two words" alt='single' "first pos" flag x:y="1"`);
  assert.deepEqual(a, { attrs: { id: '7', title: 'Two words', alt: 'single', 'x:y': '1' }, positional: ['first pos', 'flag'] });
  assert.equal(out('[button "Buy now" primary /]'), '<a class="p">Buy now</a>');
  assert.equal(out('[button "Read" /]'), '<a class="s">Read</a>');
  assert.deepEqual(parseAttributes('a=1 a=2').attrs, { a: '2' }, 'the later of two equal names wins');
  assert.deepEqual(parseAttributes('__proto__=x ok=1').attrs, { ok: '1' });
  assert.equal(({} as Record<string, unknown>)['x'], undefined);
  assert.deepEqual(parseAttributes('title="a ] b"').attrs, { title: 'a ] b' });
  assert.throws(() => parseAttributes('a=' + 'x'.repeat(5000)), LimitExceeded);
  assert.throws(() => parseAttributes(Array.from({ length: 60 }, (_, i) => `a${i}=1`).join(' ')), /attributes/);
});

test('brackets that are not registered shortcodes are plain text', () => {
  const t = 'Array [0] and [unknown x=1]y[/unknown] and [b without end and [ ] and [b';
  assert.equal(out(t), 'Array [0] and [unknown x=1]y[/unknown] and [b without end and [ ] and [b');
  assert.equal(out('[b ]x[/b]'), '<b>x</b>');
  assert.equal(out('[bold]x[/bold]'), '[bold]x[/bold]', 'a longer name is a different tag');
  assert.equal(out('[B]x[/B]'), '[B]x[/B]', 'tags are case-sensitive');
  assert.equal(out('[b'), '[b');
  assert.equal(out(''), '');
});

test('escaping: doubled brackets show the shortcode as text', () => {
  assert.equal(out('[[gallery]]'), '[gallery]');
  assert.equal(out('[[gallery ids="1"]]'), '[gallery ids="1"]');
  assert.equal(out('[[b]keep[/b]]'), '[b]keep[/b]');
  assert.equal(out('[[b]x[/b] and [b]y[/b]'), '[[b]x[/b] and <b>y</b>', 'a lone escape opener stays as written and does not swallow what follows');
});

test('nesting: inner content is expanded first, same tag nests, and an unclosed inner tag is self-closing', () => {
  assert.equal(out('[b][quote cite=x]hi [b]there[/b][/quote][/b]'), '<b><q cite="x">hi <b>there</b></q></b>');
  assert.equal(out('[b][b]deep[/b][/b]'), '<b><b>deep</b></b>');
  assert.equal(out('[quote][gallery ids=1]text[/quote]'), '<q cite=""><gallery ids="1" cols="3">text</q>', 'gallery has no closer and is self-closing');
  assert.equal(out('[b]one[/b][/b]'), '<b>one</b>[/b]', 'a stray closer stays as text');
  assert.equal(out('[b]never closed'), '<b></b>never closed', 'an unclosed tag is self-closing');
});

test('a raw handler gets its content exactly as written', () => {
  const handlers = { code: { raw: true, run: (c: Context) => `<pre>${escapeHtml(c.content ?? '')}</pre>` }, b: h.b };
  assert.equal(out('[code][b]x[/b] <i>[/code] [b]y[/b]', handlers), '<pre>[b]x[/b] &lt;i&gt;</pre> <b>y</b>');
});

test('handler output is not scanned again unless the handler asks, so values cannot smuggle shortcodes in', () => {
  const handlers = {
    echo: (c: Context) => c.attrs['v'] ?? '',
    again: { rescan: true, run: (c: Context) => c.attrs['v'] ?? '' },
    b: h.b,
  };
  assert.equal(out('[echo v="[b]x[/b]"]', handlers), '[b]x[/b]');
  assert.equal(out('[again v="[b]x[/b]"]', handlers), '<b>x</b>', 'by request');
  const loop = { loop: { rescan: true, run: () => '[loop]' } };
  const r = expand('[loop]', loop);
  assert.equal(r.text.startsWith('[loop]'), true);
  assert.ok(r.expansions <= 6, `recursion stops at the depth cap, ran ${r.expansions}`);
});

test('limits: depth, number of handler calls, tag count, input size and output size are enforced, never looped', () => {
  const deep = '[b]'.repeat(8) + 'x' + '[/b]'.repeat(8);
  const r = expand(deep, h, { maxDepth: 3 });
  assert.ok(r.errors.some((e) => /nesting deeper than 3/.test(e.message)));
  assert.match(r.text, /<b>/);
  const many = expand('[b]x[/b]'.repeat(10), h, { maxExpansions: 4 });
  assert.equal(many.expansions, 4);
  assert.equal(many.errors.length, 6);
  assert.equal(many.text, '<b>x</b>'.repeat(4) + '[b]x[/b]'.repeat(6));
  const dropped = expand('[b]x[/b]'.repeat(3), h, { maxExpansions: 1, onError: 'drop' });
  assert.equal(dropped.text, '<b>x</b>');
  const tooMany = expand('[b /]'.repeat(600), h);
  assert.equal(tooMany.text, '[b /]'.repeat(600), 'over the tag limit the text is returned as written');
  assert.match(tooMany.errors[0]!.message, /shortcodes/);
  assert.throws(() => parse('x'.repeat(101), ['b'], { maxLength: 100 }), LimitExceeded);
  const big = expand('[b]x[/b]'.repeat(10), { b: () => 'y'.repeat(300) }, { maxOutput: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.text, '[b]x[/b]'.repeat(10), 'a truncated expansion returns the original, not half of a page');
});

test('a handler that throws is reported; the tag stays as written or is dropped; the rest still expands', () => {
  const handlers = { boom: () => { throw new Error('database down'); }, bad: (() => 42) as never, b: h.b };
  const r = expand('[b]1[/b] [boom] [bad] [b]2[/b]', handlers);
  assert.equal(r.text, '<b>1</b> [boom] [bad] <b>2</b>');
  assert.deepEqual(r.errors, [{ tag: 'boom', message: 'database down' }, { tag: 'bad', message: 'a handler must return a string' }]);
  assert.equal(expand('x[boom]y', handlers, { onError: 'drop' }).text, 'xy');
});

test('hostile text does not run anything it should not, and slow shapes stay fast', () => {
  const calls: string[] = [];
  const handlers = { b: (c: Context) => { calls.push(c.tag); return h.b(c); } };
  assert.equal(out('[b onclick="x]"]ok[/b] [b a="b" [b]ok[/b]', handlers), '<b>ok</b> [b a="b" <b>ok</b>');
  assert.equal(out('[constructor] [__proto__] [toString]', handlers), '[constructor] [__proto__] [toString]', 'inherited names are not handlers');
  const t0 = Date.now();
  expand('['.repeat(200_000), h);
  expand('[b '.repeat(60_000), h);
  expand('[b]'.repeat(400) + '[/b]'.repeat(400), h);
  expand('[b a="'.repeat(30_000), h);
  assert.ok(Date.now() - t0 < 3000);
});

test('has, strip and parse expose the structure', () => {
  const text = 'a [quote cite=x]b [gallery ids=1] c[/quote] d [gallery]';
  assert.equal(has(text, 'gallery'), true);
  assert.equal(has(text, 'button'), false);
  assert.equal(has('[quote][gallery][/quote]', 'gallery'), true, 'found inside another');
  assert.equal(strip(text, ['gallery']), 'a [quote cite=x]b  c[/quote] d ');
  assert.equal(strip(text, ['quote']), 'a  d [gallery]');
  assert.equal(strip(text, ['quote'], { keepContent: true }), 'a b [gallery ids=1] c d [gallery]');
  const nodes = parse('x[b k=1]y[/b]', ['b']);
  assert.deepEqual(nodes.map((n) => n.type), ['text', 'shortcode']);
  const sc = nodes[1]!;
  assert.equal(sc.type === 'shortcode' && sc.raw, '[b k=1]y[/b]');
  assert.equal(sc.type === 'shortcode' && sc.rawContent, 'y');
});

test('building a shortcode quotes values safely and refuses what cannot be written', () => {
  assert.equal(build('gallery', { ids: '1,2', title: 'He said "hi"' }), `[gallery ids="1,2" title='He said "hi"' /]`);
  assert.equal(build('b', {}, 'text'), '[b]text[/b]');
  assert.equal(build('quote', { cite: 'Ann' }, 'W'), '[quote cite="Ann"]W[/quote]');
  assert.throws(() => build('a b'), TypeError);
  assert.throws(() => build('a', { 'x y': '1' }), TypeError);
  assert.throws(() => build('a', { x: `it's "both"` }), /both kinds of quote/);
  assert.throws(() => build('a', { x: 'a]b' }), /\]/);
  const round = parse(build('gallery', { ids: '1,2', title: 'He said "hi"' }), ['gallery'])[0]!;
  assert.deepEqual(round.type === 'shortcode' && round.attrs, { ids: '1,2', title: 'He said "hi"' });
});

test('{{short}} tags are replaced with escaped values; unknown names follow the missing policy', () => {
  const v = { name: 'Ann <b>', user: { email: 'a@b.c', n: 3 }, ok: true };
  assert.equal(expandTags('Hi {{name}}, {{ user.email }} #{{user.n}} {{ok}}', v), 'Hi Ann &lt;b&gt;, a@b.c #3 true');
  assert.equal(expandTags('{{nope}} {{user.nope}} {{user}}', v), '{{nope}} {{user.nope}} {{user}}');
  assert.equal(expandTags('[{{nope}}]', v, { missing: 'empty' }), '[]');
  assert.throws(() => expandTags('{{nope}}', v, { missing: 'throw' }), MissingValue);
  assert.equal(expandTags('\\{{name}} and {{name}}', v), '{{name}} and Ann &lt;b&gt;', 'a backslash keeps the tag as written');
  assert.equal(expandTags('{{name', v), '{{name');
  assert.equal(expandTags('{{ constructor }} {{__proto__}} {{user.constructor}}', v), '{{ constructor }} {{__proto__}} {{user.constructor}}', 'only own properties');
  assert.equal(expandTags('<%name%>', v, { open: '<%', close: '%>', escape: (s) => s.toUpperCase() }), 'ANN <B>');
  assert.equal(expandTags('{{a b}} {{1x}}', { a: 1 }), '{{a b}} {{1x}}', 'names are identifiers');
});
