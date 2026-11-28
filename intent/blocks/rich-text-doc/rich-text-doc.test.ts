import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AddMarkStep, AttrStep, InvalidContent, Mapping, ReplaceAroundStep, ReplaceError, ReplaceStep, RemoveMarkStep, Schema, StepMap, Transform, TransformError, basicSchema as S, cut, emptySlice, fragSize, fromHTML, nodeSize, nodesBetween, replace, resolve, slice, sliceOf, stepFromJSON, textBetween, textContent, toHTML } from './index.ts';
import type { Node, Step } from './index.ts';

const t = (s: string, marks?: Parameters<typeof S.text>[1]) => S.text(s, marks);
const p = (...c: Node[]) => S.node('paragraph', undefined, c);
const h = (level: number, ...c: Node[]) => S.node('heading', { level }, c);
const doc = (...c: Node[]) => S.node('doc', undefined, c);
const li = (...c: Node[]) => S.node('list_item', undefined, c);
const ul = (...c: Node[]) => S.node('bullet_list', undefined, c);
const bq = (...c: Node[]) => S.node('blockquote', undefined, c);
const strong = S.mark('strong');
const em = S.mark('em');
const link = (href: string) => S.mark('link', { href });
const same = (a: Node, b: Node) => assert.deepEqual(a, b);
const valid = (d: Node) => assert.deepEqual(S.check(d), []);

function run(d: Node, f: (tr: Transform) => void): Transform {
  const tr = new Transform(S, d);
  f(tr);
  valid(tr.doc);
  return tr;
}
function undo(tr: Transform): Node {
  const back = new Transform(S, tr.doc);
  for (const s of tr.inverted()) back.step(s);
  return back.doc;
}

test('content expressions decide what is valid, and check reports every problem with its path', () => {
  valid(doc(p(t('hi')), h(2, t('x')), ul(li(p()))));
  assert.equal(S.matches('doc', []), false, 'doc needs at least one block');
  assert.equal(S.matches('list_item', [p(), p(), ul(li(p()))]), true);
  assert.equal(S.matches('list_item', [ul(li(p()))]), false, 'a list item starts with a paragraph');
  assert.equal(S.matches('code_block', [t('x'), t('y')]), true);
  assert.equal(S.matches('paragraph', [p()]), false);
  assert.equal(S.matches('horizontal_rule', []), true);
  const bad: Node = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph', content: [] }] }, { type: 'bullet_list', content: [{ type: 'paragraph', content: [] }] }, { type: 'heading', attrs: { level: 9 }, content: [] }] };
  const problems = S.check(bad);
  assert.equal(problems.length >= 3, true);
  assert.ok(problems.some((x) => x.startsWith('/0:') && /invalid content for paragraph/.test(x)));
  assert.ok(problems.some((x) => x.startsWith('/1:') && /bullet_list/.test(x)));
  assert.ok(problems.some((x) => /level/.test(x)));
  assert.deepEqual(S.check({ type: 'paragraph', content: [] }).length, 1, 'the top node must be a doc');
  const two = new Schema({ nodes: { doc: { content: 'a{2,3}' }, a: { content: 'text*', group: 'x' }, text: {} } });
  assert.equal(two.matches('doc', [two.node('a'), two.node('a')]), true);
  assert.equal(two.matches('doc', [two.node('a')]), false);
  assert.equal(two.matches('doc', [two.node('a'), two.node('a'), two.node('a'), two.node('a')]), false);
  assert.throws(() => new Schema({ nodes: { doc: { content: 'nope+' }, text: {} } }), /no node type or group named "nope"/);
  assert.throws(() => new Schema({ nodes: { doc: { content: '(text' }, text: {} } }), InvalidContent);
  assert.throws(() => new Schema({ nodes: { doc: { content: 'text*' } } }), /needs a text node/);
});

test('creating nodes fills attribute defaults and refuses unknown or invalid attributes and bad content', () => {
  assert.deepEqual(S.node('heading').attrs, { level: 1 });
  assert.throws(() => S.node('heading', { level: 7 }), /does not accept that level/);
  assert.throws(() => S.node('heading', { level: 1, id: 'x' }), /no attribute id/);
  assert.throws(() => S.node('image', { alt: 'x' }), /needs the attribute src/);
  assert.throws(() => S.node('image', { src: 'javascript:alert(1)' }), /does not accept that src/);
  assert.throws(() => S.mark('link', { href: 'javascript:alert(1)' }), /does not accept that href/);
  assert.throws(() => S.node('doc', undefined, []), /invalid content for doc/);
  assert.throws(() => S.node('text'), /schema.text/);
  assert.throws(() => S.text(''), /empty text/);
  assert.throws(() => S.node('horizontal_rule', undefined, [p()]), /no content/);
  assert.throws(() => S.node('code_block', undefined, [t('x', [strong])]), /does not allow the strong mark/, 'marks only where the parent allows');
});

test('marks are kept in schema order, without repeats, and excluded marks replace each other', () => {
  const n = S.text('x', [strong, link('https://a.example'), em, strong]);
  assert.deepEqual(n.marks!.map((m) => m.type), ['link', 'em', 'strong']);
  const swapped = S.text('x', [link('https://a.example'), link('https://b.example')]);
  assert.equal(swapped.marks!.length, 1);
  assert.equal(swapped.marks![0]!.attrs!.href, 'https://b.example', 'the later link replaces the earlier');
  const code = S.text('x', [strong, S.mark('code')]);
  assert.deepEqual(code.marks!.map((m) => m.type), ['code'], 'code excludes everything else');
  assert.deepEqual(S.addToSet([S.mark('code')], strong), [S.mark('code')], 'and refuses to be joined');
});

test('sizes and positions: resolve gives depth, index, offsets, and the nodes around a position', () => {
  const d = doc(p(t('ab')), p(t('cd'), S.node('hard_break'), t('e')));
  assert.equal(nodeSize(d.content![0]!), 4);
  assert.equal(fragSize(d.content!), 4 + 6);
  const r0 = resolve(d, 0);
  assert.equal(r0.depth, 0);
  assert.equal(r0.nodeAfter!.type, 'paragraph');
  assert.equal(r0.nodeBefore, null);
  const r2 = resolve(d, 2);
  assert.equal(r2.depth, 1);
  assert.equal(r2.parentOffset, 1);
  assert.equal(r2.textOffset, 1);
  assert.equal(r2.nodeBefore!.text, 'a');
  assert.equal(r2.nodeAfter!.text, 'b');
  assert.equal(r2.start(1), 1);
  assert.equal(r2.end(1), 3);
  assert.equal(r2.before(1), 0);
  assert.equal(r2.after(1), 4);
  const r4 = resolve(d, 4);
  assert.equal(r4.depth, 0);
  assert.equal(r4.index(0), 1);
  const r8 = resolve(d, 8);
  assert.equal(r8.nodeBefore!.type, 'hard_break');
  assert.equal(r8.nodeAfter!.text, 'e');
  assert.equal(resolve(d, 10).depth, 0);
  assert.throws(() => resolve(d, 11), RangeError);
  assert.throws(() => resolve(d, -1), RangeError);
  assert.throws(() => resolve(d, 1.5), RangeError);
  assert.equal(r2.sharedDepth(3), 1);
  assert.equal(r2.sharedDepth(6), 0);
  assert.equal(textBetween(S, d, 0, 10, '|'), 'ab|cde');
  assert.equal(textContent(d), 'abcde');
});

test('slice cuts with open sides, and replace joins them back as ProseMirror does', () => {
  const d = doc(p(t('hello')), p(t('world')));
  const s = sliceOf(d, 3, 10);
  assert.equal(s.openStart, 1);
  assert.equal(s.openEnd, 1);
  assert.equal(textContent({ type: 'doc', content: s.content }), 'llowo');
  // Delete across the paragraphs: they join.
  same(replace(S, d, 3, 10, emptySlice), doc(p(t('herld'))));
  // Put the slice back inside the first paragraph: it splits there and joins at both ends.
  same(replace(S, d, 3, 3, s), doc(p(t('hello')), p(t('wollo')), p(t('world'))));
});

test('replace: inserting a closed block, a split by an open slice, and refusing what the schema forbids', () => {
  const d = doc(p(t('ab')), p(t('cd')));
  same(replace(S, d, 4, 4, slice([p(t('new'))])), doc(p(t('ab')), p(t('new')), p(t('cd'))));
  same(replace(S, d, 2, 2, slice([p(), p()], 1, 1)), doc(p(t('a')), p(t('b')), p(t('cd'))));
  same(replace(S, d, 2, 2, slice([t('x')], 0, 0)), doc(p(t('axb')), p(t('cd'))));
  assert.throws(() => replace(S, d, 0, 0, slice([t('x')])), ReplaceError, 'text cannot sit in a doc');
  assert.throws(() => replace(S, d, 2, 2, slice([p(t('x'))], 2, 0)), /deeper than insertion position/);
  assert.throws(() => replace(S, d, 2, 2, slice([p(t('x'))], 1, 0)), /Inconsistent open depths/);
  assert.throws(() => replace(S, doc(p(t('a'))), 0, 3, emptySlice), /Invalid content for node doc/, 'deleting every block leaves an invalid doc');
  const l = doc(ul(li(p(t('a'))), li(p(t('b')))));
  assert.throws(() => replace(S, l, 2, 2, slice([h(1, t('x'))])), ReplaceError, 'a list holds list items, not headings');
});

test('transform: insert, delete and replace text; every step inverts and the whole undo restores the document', () => {
  const d = doc(p(t('hello world')), p(t('second')));
  const tr = run(d, (x) => {
    x.insertText(7, 'big ');
    x.delete(1, 7);
    x.insert(11, p(t('tail')));
    x.split(4);
    x.replaceWith(1, 2, t('J'));
  });
  assert.equal(tr.steps.length, 5);
  assert.equal(tr.docs.length, 5);
  same(tr.docs[0]!, d);
  same(undo(tr), d);
  assert.equal(textContent(tr.doc), 'Jig worldtailsecond');
  assert.equal(tr.doc.content!.length, 4);
});

test('step maps send positions where they go, say what was deleted, and respect which side to stay on', () => {
  const ins = new StepMap([5, 0, 3]);
  assert.equal(ins.map(5, 1), 8, 'at an insertion, associating right moves past it');
  assert.equal(ins.map(5, -1), 5, 'and associating left stays');
  assert.equal(ins.map(2), 2);
  assert.equal(ins.map(9), 12);
  const del = new StepMap([4, 3, 0]);
  assert.equal(del.map(6), 4);
  assert.equal(del.mapResult(6).deleted, true);
  assert.equal(del.mapResult(6).deletedAcross, true);
  assert.equal(del.mapResult(4, -1).deleted, false, 'the edge before the deleted range is not deleted');
  assert.equal(del.mapResult(7, 1).deleted, false);
  assert.equal(del.mapResult(7, -1).deletedBefore, true);
  assert.equal(del.map(10), 7);
  const inv = del.invert();
  assert.equal(inv.map(4, -1), 4, 'the inverse of a deletion is an insertion: stay left of it');
  assert.equal(inv.map(4, 1), 7, 'or move right past it');
  assert.equal(inv.map(8), 11);
  const calls: number[][] = [];
  new StepMap([2, 1, 4, 10, 3, 0]).forEach((a, b, c, e) => calls.push([a, b, c, e]));
  assert.deepEqual(calls, [[2, 3, 2, 6], [10, 13, 13, 13]]);
});

test('a mapping through a step and its undo recovers a position inside deleted text through the mirror', () => {
  const del = new StepMap([4, 3, 0]);
  const restore = del.invert();
  const plain = new Mapping([del, restore]);
  assert.equal(plain.map(5), 7, 'without mirrors a position inside deleted text collapses to the edge and is then pushed past the restored text');
  assert.equal(plain.map(5, -1), 4);
  const mirrored = new Mapping([del, restore], [0, 1]);
  assert.equal(mirrored.map(5), 5, 'with the undo marked as its mirror, it comes back');
  assert.equal(mirrored.map(2), 2);
  assert.equal(mirrored.map(9), 9);
  assert.equal(mirrored.mapResult(5).deleted, false);
  assert.equal(plain.mapResult(5).deleted, true);
  const m = new Mapping([new StepMap([0, 0, 2]), new StepMap([5, 1, 0])]);
  assert.equal(m.map(5, 1), 6, 'two shifted right by an insertion before it, then one left by a deletion at it');
  assert.equal(m.slice(1).map(5), 5, 'a slice of a mapping starts from its own first map');
});

test('adding and removing marks: only where they are missing, merged ranges, undone exactly', () => {
  const d = doc(p(t('one '), t('two', [strong]), t(' three')), p(t('four')));
  const tr = run(d, (x) => x.addMark(1, 13, em));
  same(tr.doc, doc(p(t('one ', [em]), t('two', [em, strong]), t(' thre', [em]), t('e')), p(t('four'))));
  same(undo(tr), d);
  const tr2 = run(d, (x) => x.addMark(1, 10, strong));
  assert.equal(tr2.steps.length, 2, 'the part that is already strong needs no step: before it and after it');
  const tr3 = run(tr2.doc, (x) => x.removeMark(1, 10, 'strong'));
  same(tr3.doc, doc(p(t('one two three')), p(t('four'))));
  const tr4 = run(d, (x) => x.addMark(1, 4, link('https://a.example')));
  const tr5 = run(tr4.doc, (x) => x.addMark(2, 3, link('https://b.example')));
  assert.deepEqual(tr5.doc.content![0]!.content!.map((n) => [n.text, n.marks?.[0]?.attrs?.href]), [['o', 'https://a.example'], ['n', 'https://b.example'], ['e', 'https://a.example'], [' ', undefined], ['two', undefined], [' three', undefined]], 'a second link replaces the first where it applies');
  same(undo(tr5), tr4.doc);
  const none = run(d, (x) => x.removeMark(1, 5));
  same(none.doc, d);
  assert.equal(none.steps.length, 0, 'nothing to remove, nothing done');
});

test('marks are refused where the parent does not allow them, and mark steps on an empty or reversed range are refused', () => {
  const d = doc(S.node('code_block', undefined, [t('code')]), p(t('text')));
  const tr = run(d, (x) => x.addMark(1, 7, strong));
  same(tr.doc, d);
  assert.equal(tr.steps.length, 0);
  assert.throws(() => new AddMarkStep(5, 2, strong), TransformError);
  assert.throws(() => new ReplaceStep(-1, 2, emptySlice), TransformError);
  assert.throws(() => new ReplaceStep(1.5, 2, emptySlice), TransformError);
  const failing = new Transform(S, d).maybeStep(new ReplaceStep(0, 999, emptySlice));
  assert.ok('failed' in failing);
  assert.throws(() => new Transform(S, d).step(new ReplaceStep(0, 999, emptySlice)), /out of range/);
});

test('split and join: a paragraph splits in two and joins again; splitting a list item two levels deep', () => {
  const d = doc(p(t('hello world')));
  const tr = run(d, (x) => x.split(6));
  same(tr.doc, doc(p(t('hello')), p(t(' world'))));
  const joined = run(tr.doc, (x) => x.join(7));
  same(joined.doc, d);
  same(undo(tr), d);
  const l = doc(ul(li(p(t('ab')))));
  const tl = run(l, (x) => x.split(4, 2));
  same(tl.doc, doc(ul(li(p(t('a'))), li(p(t('b'))))));
  same(undo(tl), l);
  const heading = run(d, (x) => x.split(6, 1, [{ type: 'heading', attrs: { level: 3 } }]));
  same(heading.doc, doc(p(t('hello')), h(3, t(' world'))));
  assert.throws(() => new Transform(S, d).split(6, 5), /cannot split that deep/);
  assert.throws(() => new Transform(S, doc(p(t('a')), h(1, t('b')))).join(3).join(1), TransformError, 'there is nothing to join at the edge of the doc');
});

test('wrap and lift: a paragraph into a blockquote and back; a middle child lifted splits its parent; a bad wrap fails whole', () => {
  const d = doc(p(t('one')), p(t('two')));
  const w = run(d, (x) => x.wrap(0, 10, 'blockquote'));
  same(w.doc, doc(bq(p(t('one')), p(t('two')))));
  same(undo(w), d);
  const lifted = run(w.doc, (x) => x.lift(1, 11));
  same(lifted.doc, d);
  const mid = doc(bq(p(t('a')), p(t('b')), p(t('c'))));
  const lm = run(mid, (x) => x.lift(4, 7));
  same(lm.doc, doc(bq(p(t('a'))), p(t('b')), bq(p(t('c')))));
  same(undo(lm), mid);
  const first = run(mid, (x) => x.lift(1, 4));
  same(first.doc, doc(p(t('a')), bq(p(t('b')), p(t('c')))));
  assert.throws(() => new Transform(S, d).wrap(0, 5, 'bullet_list'), /invalid content for bullet_list/, 'a list wants list items, so the wrap is refused and the doc untouched');
  assert.throws(() => new Transform(S, d).lift(0, 10), /nothing to lift out of/);
  assert.throws(() => new Transform(S, d).lift(1, 4), /Invalid content for node doc/, 'lifting text out of a paragraph would leave text in the doc');
});

test('node attributes: set, inverted, refused when invalid or when no node starts there', () => {
  const d = doc(h(1, t('Title')), p(t('x')));
  const tr = run(d, (x) => x.setNodeAttr(0, 'level', 3));
  same(tr.doc, doc(h(3, t('Title')), p(t('x'))));
  same(undo(tr), d);
  assert.throws(() => new Transform(S, d).setNodeAttr(0, 'level', 12), /does not accept that level/);
  assert.throws(() => new Transform(S, d).setNodeAttr(0, 'colour', 'red'), /no attribute colour/);
  assert.throws(() => new Transform(S, d).setNodeAttr(2, 'level', 2), /No node at attribute step position/);
  assert.throws(() => new Transform(S, d).setNodeAttr(3, 'level', 2), /No node|has no attribute/);
});

test('steps map through earlier changes: shifted when something is inserted before, gone when what they touched was deleted', () => {
  const d = doc(p(t('abcdefgh')));
  const edit = new ReplaceStep(5, 7, slice([t('XY')]));
  const before = new Transform(S, d).insertText(1, '12345');
  const shifted = edit.map(before.mapping) as ReplaceStep;
  assert.equal(shifted.from, 10);
  assert.equal(shifted.to, 12);
  const after = run(before.doc, (x) => x.step(shifted));
  assert.equal(textContent(after.doc), '12345abcdXYgh');
  const wipe = new Transform(S, d).delete(3, 9);
  assert.equal(edit.map(wipe.mapping), null, 'its whole range was deleted');
  const partial = new ReplaceStep(2, 12 - 4, slice([t('Q')])).map(wipe.mapping);
  assert.ok(partial);
  const mk = new AddMarkStep(2, 6, strong).map(new Transform(S, d).delete(1, 3).mapping) as AddMarkStep;
  assert.deepEqual([mk.from, mk.to], [1, 4]);
  assert.equal(new AddMarkStep(4, 6, strong).map(wipe.mapping), null);
  const partialMark = new AddMarkStep(2, 4, strong).map(wipe.mapping) as AddMarkStep;
  assert.deepEqual([partialMark.from, partialMark.to], [2, 3], 'only the part that survives');
  assert.equal(new AttrStep(0, 'level', 2).map(new Transform(S, doc(h(1, t('x')), p(t('y')))).delete(0, 3).mapping), null);
});

test('steps survive a JSON round trip; hostile JSON is refused', () => {
  const d = doc(p(t('hello')));
  const steps: Step[] = [new ReplaceStep(2, 4, slice([t('XYZ', [strong])])), new AddMarkStep(1, 3, em), new RemoveMarkStep(1, 3, em), new AttrStep(0, 'level', 2), new ReplaceAroundStep(0, 7, 0, 7, slice([S.node('blockquote', undefined, [], undefined, { unchecked: true })], 0, 0), 1)];
  for (const s of steps) {
    const back = stepFromJSON(S, JSON.parse(JSON.stringify(s.toJSON())));
    assert.deepEqual(back.toJSON(), s.toJSON());
    assert.equal(back.kind, s.kind);
  }
  const applied = stepFromJSON(S, JSON.parse(JSON.stringify(new ReplaceStep(2, 4, slice([t('XYZ')])).toJSON()))).apply(S, d) as { doc: Node };
  assert.equal(textContent(applied.doc), 'hXYZlo');
  for (const bad of [null, [], 'x', { stepType: 'evil' }, { stepType: 'replace', from: -1, to: 2 }, { stepType: 'replace', from: 1, to: 'a' }, { stepType: 'replace', from: 1, to: 2, slice: { content: [{ type: 'script' }] } }, { stepType: 'replace', from: 1, to: 2, slice: { content: [{ type: 'text', text: 'x', extra: 1 }] } }, { stepType: 'addMark', from: 1, to: 2, mark: { type: 'nope' } }, { stepType: 'attr', pos: 0, attr: 'level', value: { __proto__: 1, a: Infinity } }, { stepType: 'replaceAround', from: 5, to: 2, gapFrom: 0, gapTo: 0, insert: 0 }]) {
    assert.throws(() => stepFromJSON(S, bad), (e) => e instanceof TransformError || e instanceof InvalidContent, JSON.stringify(bad));
  }
});

test('nodeFromJSON normalises good input and refuses unknown keys, types, depth, size and a wrong top node', () => {
  const j = { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c', marks: [{ type: 'strong' }, { type: 'em' }] }] }] };
  const n = S.nodeFromJSON(j);
  assert.deepEqual(n.content![0]!.attrs, { level: 1 }, 'defaults are filled');
  assert.deepEqual(n.content![0]!.content!.map((x) => x.text), ['ab', 'c'], 'adjacent text with the same marks is joined');
  assert.deepEqual(n.content![0]!.content![1]!.marks!.map((m) => m.type), ['em', 'strong'], 'marks are put in schema order');
  assert.deepEqual(S.nodeFromJSON(JSON.parse(JSON.stringify(n))), n);
  const reject = (x: unknown, re: RegExp) => assert.throws(() => S.nodeFromJSON(x), re);
  reject(null, /is an object/);
  reject({ type: 'paragraph', content: [] }, /top node must be a doc/);
  reject({ type: 'doc', content: [{ type: 'paragraph', content: [], onclick: 'x' }] }, /unknown key onclick/);
  reject({ type: 'doc', content: [{ type: 'script' }] }, /unknown node type script/);
  reject({ type: 'doc', content: [] }, /invalid content for doc/);
  reject({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] }, /empty text/);
  reject({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:x' } }] }] }] }, /does not accept that href/);
  reject({ type: 'doc', content: [{ type: 'paragraph', attrs: { a: { b: 1 } }, content: [] }] }, /no attribute a/);
  reject({ type: 'doc', content: 'x' }, /content must be a list/);
  reject({ type: 'doc', content: [{ type: 'paragraph', text: 'x', content: [] }] }, /only text nodes hold text/);
  let deep: unknown = { type: 'paragraph', content: [] };
  for (let i = 0; i < 120; i++) deep = { type: 'blockquote', content: [deep] };
  reject({ type: 'doc', content: [deep] }, /nested deeper than 100/);
  assert.throws(() => S.nodeFromJSON({ type: 'doc', content: Array.from({ length: 50 }, () => ({ type: 'paragraph', content: [] })) }, { maxNodes: 40 }), /more than 40 nodes/);
});

test('HTML out: escaped text and attributes, marks nested in order, unsafe links and images left out', () => {
  const d = doc(h(2, t('A <b> & "c"')), p(t('see ', [em]), t('here', [link('https://example.org/?a=1&b="2"'), strong]), t(' now')), p(t('bad', [S.mark('link', { href: 'https://ok.example' })])), S.node('code_block', undefined, [t('<script>')]), S.node('ordered_list', { start: 3 }, [li(p(t('x')))]), p(S.node('image', { src: 'https://img.example/a.png', alt: 'a"b' }), S.node('hard_break')), S.node('horizontal_rule'));
  const out = toHTML(S, d);
  assert.equal(
    out,
    '<h2>A &lt;b&gt; &amp; "c"</h2><p><em>see </em><a href="https://example.org/?a=1&amp;b=&quot;2&quot;" rel="noopener noreferrer"><strong>here</strong></a> now</p><p><a href="https://ok.example" rel="noopener noreferrer">bad</a></p><pre>&lt;script&gt;</pre><ol start="3"><li><p>x</p></li></ol><p><img src="https://img.example/a.png" alt="a&quot;b"><br></p><hr>',
  );
  const bypass: Node = { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'java\tscript:alert(1)' } }] }] };
  assert.equal(toHTML(S, bypass), '<p>x</p>', 'a link that fails the address check is not written even if it got into the tree');
  assert.equal(toHTML(S, { type: 'paragraph', content: [{ type: 'image', attrs: { src: 'data:text/html,x', alt: '' } }] }), '<p></p>');
});

test('HTML in: sanitised, mapped to nodes and marks, stray text wrapped, the unknown unwrapped, and the result is valid', () => {
  const html = '<script>alert(1)</script>loose text<h1 onclick="x()">Title <i>it</i> <b>bold</b></h1><div><p>one<br>two <a href="javascript:alert(1)">bad</a> <a href="https://example.org" onclick="x">good</a></p></div><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><pre>  keep\n  this</pre><blockquote>quoted</blockquote><img src="javascript:x"><hr><span>tail</span>';
  const d = fromHTML(S, html);
  valid(d);
  const kinds = d.content!.map((n) => n.type);
  assert.deepEqual(kinds, ['paragraph', 'heading', 'paragraph', 'bullet_list', 'code_block', 'blockquote', 'horizontal_rule', 'paragraph']);
  assert.equal(textContent(d.content![0]!), 'loose text');
  assert.equal(d.content![1]!.attrs!.level, 1);
  assert.deepEqual(d.content![1]!.content!.map((n) => [n.text, n.marks?.map((m) => m.type).join()]), [['Title ', undefined], ['it', 'em'], [' ', undefined], ['bold', 'strong']]);
  const p2 = d.content![2]!;
  assert.deepEqual(p2.content!.map((n) => n.type), ['text', 'hard_break', 'text', 'text']);
  assert.equal(p2.content![2]!.text, 'two bad ', 'a link that is refused leaves its text, and plain text around it is joined');
  assert.equal(p2.content!.some((n) => n.marks?.some((m) => m.type === 'link' && String(m.attrs?.href).startsWith('javascript'))), false);
  const good = p2.content!.find((n) => n.marks?.[0]?.type === 'link')!;
  assert.deepEqual([good.text, good.marks![0]!.attrs!.href], ['good', 'https://example.org']);
  assert.equal(textContent(d.content![3]!), 'abc');
  assert.equal(d.content![4]!.content![0]!.text, '  keep\n  this', 'preformatted text keeps its spaces');
  assert.equal(JSON.stringify(d).includes('script'), false);
  assert.equal(JSON.stringify(d).includes('alert(1)'), false, 'the script is gone with its text');
  assert.equal(JSON.stringify(d).includes('javascript'), false);
  const again = fromHTML(S, toHTML(S, d));
  same(again, d);
  const empty = fromHTML(S, '');
  valid(empty);
  assert.equal(empty.content!.length, 1, 'a document is never empty');
  const evil = fromHTML(S, '<p>x<img src=x onerror=alert(1)><iframe src="//evil"></iframe></p>');
  assert.equal(JSON.stringify(evil).includes('onerror'), false);
});

test('random edits always give valid documents, and undoing them always gives back the original', () => {
  let seed = 99;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 25; round++) {
    const start = doc(p(t('alpha beta')), h(2, t('gamma')), bq(p(t('delta')), p(t('epsilon zeta'))), ul(li(p(t('one')), ul(li(p(t('deep'))))), li(p(t('two')))));
    const tr = new Transform(S, start);
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      const size = fragSize(tr.doc.content!);
      const a = rnd(size + 1);
      const b = Math.min(size, a + rnd(6));
      const pick = rnd(5);
      const step: Step =
        pick === 0 ? new ReplaceStep(a, a, slice([t('x')]))
        : pick === 1 ? new ReplaceStep(a, b, emptySlice)
        : pick === 2 ? new AddMarkStep(a, b, rnd(2) ? strong : em)
        : pick === 3 ? new ReplaceStep(a, a, slice([p(), p()], 1, 1))
        : new RemoveMarkStep(a, b, strong);
      const before = tr.doc;
      const res = tr.maybeStep(step);
      if ('failed' in res) same(tr.doc, before);
      else {
        ok++;
        assert.deepEqual(S.check(tr.doc), [], `round ${round} step ${i} ${JSON.stringify(step.toJSON())}`);
      }
    }
    assert.ok(ok > 0);
    same(undo(tr), start);
  }
});

test('nodesBetween and cut visit and cut exactly what overlaps', () => {
  const d = doc(p(t('abc')), p(t('def')));
  const seen: string[] = [];
  nodesBetween(d, 2, 7, (n, pos) => {
    seen.push(`${n.type}@${pos}`);
  });
  assert.deepEqual(seen, ['paragraph@0', 'text@1', 'paragraph@5', 'text@6']);
  const skipped: string[] = [];
  nodesBetween(d, 0, 10, (n) => {
    skipped.push(n.type);
    return n.type === 'paragraph' ? false : undefined;
  });
  assert.deepEqual(skipped, ['paragraph', 'paragraph']);
  assert.deepEqual(cut(d.content!, 2, 7).map((n) => n.type), ['paragraph', 'paragraph']);
  assert.equal(textContent({ type: 'doc', content: cut(d.content!, 2, 7) }), 'bcd');
});
