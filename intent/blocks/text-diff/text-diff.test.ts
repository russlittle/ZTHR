import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PatchConflict, PatchError, TooLarge, applyPatch, diffChars, diffLines, diffTokens, diffWords, findMoves, hunks, inlineModel, parsePatch, reversePatch, sideBySide, sideText, splitLines, stats, tokenizeWords, unified,
} from './index.ts';
import type { Seg } from './index.ts';

const lcs = (a: readonly string[], b: readonly string[]): number => {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
};
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
/** Rebuild b from a and the segments: equal and deleted items come from a, inserted ones from b. */
const rebuild = (a: readonly string[], b: readonly string[], segs: readonly Seg[]): { fromA: string[]; fromB: string[] } => {
  const fromA: string[] = []; const fromB: string[] = [];
  for (const s of segs) {
    if (s.type !== 'insert') fromA.push(...a.slice(s.aStart, s.aStart + s.len));
    if (s.type !== 'delete') fromB.push(...b.slice(s.bStart, s.bStart + s.len));
  }
  return { fromA, fromB };
};

test('the example from Myers\' paper has an edit distance of 5', () => {
  const a = [...'ABCABBA']; const b = [...'CBABAC'];
  const d = diffTokens(a, b);
  const edits = d.segs.filter((s) => s.type !== 'equal').reduce((n, s) => n + s.len, 0);
  assert.equal(edits, 5);
  assert.equal(d.segs.filter((s) => s.type === 'equal').reduce((n, s) => n + s.len, 0), 4, 'the longest common subsequence is 4 long');
  assert.equal(d.approximate, false);
});

test('on random sequences the diff is minimal (as long as the LCS) and rebuilds both sides', () => {
  const r = rng(42);
  for (let n = 0; n < 300; n++) {
    const alphabet = 1 + Math.floor(r() * 5);
    const mk = () => Array.from({ length: Math.floor(r() * 30) }, () => String.fromCharCode(97 + Math.floor(r() * alphabet)));
    const a = mk(); const b = mk();
    const d = diffTokens(a, b);
    const { fromA, fromB } = rebuild(a, b, d.segs);
    assert.deepEqual(fromA, a); assert.deepEqual(fromB, b);
    const equal = d.segs.filter((s) => s.type === 'equal').reduce((k, s) => k + s.len, 0);
    assert.equal(equal, lcs(a, b), `${a.join('')} vs ${b.join('')}`);
    for (let i = 1; i < d.segs.length; i++) assert.notEqual(d.segs[i]!.type === 'equal' && d.segs[i - 1]!.type === 'equal', true, 'equal runs are merged');
  }
});

test('large inputs with a few edits are quick and exact', () => {
  const a = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b.splice(1000, 1); b.splice(20_000, 0, 'new line'); b[40_000] = 'changed';
  const d = diffTokens(a, b);
  assert.deepEqual(stats(d), { additions: 2, deletions: 2, unchanged: 49_998, similarity: (49_998 * 2) / (49_998 * 2 + 4) });
  assert.equal(d.approximate, false);
});

test('unified output matches GNU diff -u', () => {
  const lines = (s: string) => s.split('|').join('\n') + '\n';
  assert.equal(unified(lines('a|b|c|d|e|f|g|h'), lines('a|b|c|D|e|f|g|h')), '--- a\n+++ b\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n');
  assert.equal(unified('', lines('one|two')), '--- a\n+++ b\n@@ -0,0 +1,2 @@\n+one\n+two\n');
  assert.equal(unified(lines('one|two'), ''), '--- a\n+++ b\n@@ -1,2 +0,0 @@\n-one\n-two\n');
  assert.equal(unified(lines('one|two'), lines('one')), '--- a\n+++ b\n@@ -1,2 +1 @@\n one\n-two\n');
  assert.equal(unified('x\ny', 'x\ny\nz\n'), '--- a\n+++ b\n@@ -1,2 +1,3 @@\n x\n-y\n\\ No newline at end of file\n+y\n+z\n');
  assert.equal(unified('x\ny\nz\n', 'x\ny'), '--- a\n+++ b\n@@ -1,3 +1,2 @@\n x\n-y\n-z\n+y\n\\ No newline at end of file\n');
  assert.equal(unified('same\n', 'same\n'), '', 'nothing to say when nothing differs');
  assert.equal(unified('a\n', 'b\n', { oldName: 'old.txt', newName: 'new.txt' }).split('\n').slice(0, 2).join('|'), '--- old.txt|+++ new.txt');
});

test('close changes share a hunk and distant ones get their own, with the context asked for', () => {
  const base = Array.from({ length: 30 }, (_, i) => `l${i + 1}`);
  const edit = (...at: number[]) => base.map((l, i) => (at.includes(i + 1) ? `${l}!` : l)).join('\n') + '\n';
  const text = base.join('\n') + '\n';
  const h = (e: string, ctx?: number) => hunks(diffLines(text, e), ctx).map((x) => [x.oldStart, x.oldLines]);
  assert.deepEqual(h(edit(10, 16)), [[7, 13]]);
  assert.deepEqual(h(edit(10, 17)), [[7, 14]], 'six unchanged lines between is still within twice the context');
  assert.deepEqual(h(edit(10, 18)), [[7, 7], [15, 7]], 'seven unchanged lines between is just too far');
  assert.deepEqual(h(edit(10, 18), 4), [[6, 17]]);
  assert.deepEqual(h(edit(10), 0), [[10, 1]]);
  assert.deepEqual(h(edit(1)), [[1, 4]]);
  assert.deepEqual(h(edit(30)), [[27, 4]]);
  assert.throws(() => hunks(diffLines('a', 'b'), -1), /context/);
});

test('a patch read back and applied gives the new text; reversed, the old text', () => {
  const r = rng(7);
  for (let n = 0; n < 200; n++) {
    const mk = () => Array.from({ length: Math.floor(r() * 25) }, () => `w${Math.floor(r() * 6)}`).join('\n');
    const a = mk() + (r() < 0.7 ? '\n' : ''); const b = mk() + (r() < 0.7 ? '\n' : '');
    const text = unified(a, b, { context: Math.floor(r() * 4) });
    if (text === '') { assert.equal(a, b); continue; }
    const [p] = parsePatch(text);
    assert.equal(applyPatch(a, p!), b, `forward ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    assert.equal(applyPatch(b, reversePatch(p!)), a, 'backward');
  }
});

test('a hunk finds its place when lines were added above, and a changed context is a conflict', () => {
  const a = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const b = a.replace('line 30\n', 'LINE 30\n');
  const p = parsePatch(unified(a, b))[0]!;
  const shifted = `new 1\nnew 2\nnew 3\n${a}`;
  assert.equal(applyPatch(shifted, p), `new 1\nnew 2\nnew 3\n${b}`);
  assert.throws(() => applyPatch(shifted, p, { maxOffset: 2 }), PatchConflict);
  assert.throws(() => applyPatch(a.replace('line 29', 'edited'), p), (e: unknown) => e instanceof PatchConflict && e.hunk === 0);
  assert.ok(applyPatch(a.replace('line 29\n', 'line 29  \n'), p, { compare: { ignoreWhitespace: 'eol' } }).includes('LINE 30'), 'compare options relax matching');
  assert.throws(() => applyPatch(a.replace('line 29\n', 'line 29  \n'), p), PatchConflict);
  assert.throws(() => applyPatch(b, p), PatchConflict, 'applying twice does not apply twice');
  assert.throws(() => applyPatch('line 0\n', parsePatch(unified('x\n', 'y\n'))[0]!), PatchConflict);
});

test('patch text from other tools is read: headers, tabs, sections, markers', () => {
  const text = `diff --git a/f.txt b/f.txt
index 83db48f..bf2a3c1 100644
--- a/f.txt\t2024-01-01 00:00:00
+++ b/f.txt\t2024-01-02 00:00:00
@@ -1,3 +1,3 @@ function main
 one
-two
+TWO
 three
`;
  const [p] = parsePatch(text);
  assert.deepEqual([p!.oldName, p!.newName, p!.hunks[0]!.section, p!.hunks[0]!.lines.length], ['a/f.txt', 'b/f.txt', 'function main', 4]);
  assert.equal(applyPatch('one\ntwo\nthree\n', p!), 'one\nTWO\nthree\n');
  assert.equal(parsePatch(`${text}--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n`).length, 2);
});

test('broken or hostile patches are refused before anything is applied', () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => parsePatch(t), (e: unknown) => (e instanceof PatchError || e instanceof TooLarge) && re.test((e as Error).message), t);
  bad('just text\n', /no file patch/);
  bad('--- a\n+++ b\n@@ nonsense @@\n', /hunk header/);
  bad('--- a\n+++ b\n@@ -1,2 +1,2 @@\n x\n', /says 2 old and 2 new lines but has 1 and 1/);
  bad('--- a\n+++ b\n@@ -1 +1 @@\n?x\n', /must start with/);
  bad('--- a\n+++ b\n@@ -1,99999999 +1 @@\n x\n', /more lines than the limit/);
  bad('--- a\n+++ b\n@@ -1 +1 @@\n\\ No newline at end of file\n', /no line before/);
  assert.throws(() => parsePatch('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'.repeat(3), { maxHunks: 2 }), TooLarge);
  assert.throws(() => parsePatch('x\n'.repeat(11), { maxLines: 10 }), TooLarge);
});

test('options: ignore case, whitespace in its several senses, and carriage returns', () => {
  const n = (a: string, b: string, o = {}) => stats(diffLines(a, b, o)).additions;
  assert.equal(n('Hello\n', 'hello\n'), 1);
  assert.equal(n('Hello\n', 'hello\n', { ignoreCase: true }), 0);
  assert.equal(n('a  b\n', 'a b\n'), 1);
  assert.equal(n('a  b\n', 'a b\n', { ignoreWhitespace: 'change' }), 0);
  assert.equal(n('a b\n', 'ab\n', { ignoreWhitespace: 'change' }), 1);
  assert.equal(n('a b\n', 'ab\n', { ignoreWhitespace: 'all' }), 0);
  assert.equal(n('x  \n', 'x\n'), 1);
  assert.equal(n('x  \n', 'x\n', { ignoreWhitespace: 'eol' }), 0);
  assert.equal(n(' x\n', 'x\n', { ignoreWhitespace: 'eol' }), 1, 'leading space still counts');
  assert.equal(n('a\r\nb\r\n', 'a\nb\n'), 2, 'CRLF and LF are different lines by default');
  assert.equal(n('a\r\nb\r\n', 'a\nb\n', { ignoreWhitespace: 'eol' }), 0);
  assert.deepEqual(splitLines('a\nb'), { lines: ['a', 'b'], endsWithNewline: false });
  assert.deepEqual(splitLines('a\n\n'), { lines: ['a', ''], endsWithNewline: true });
  assert.deepEqual(splitLines(''), { lines: [], endsWithNewline: true });
});

test('word and character diffs show what changed and rebuild both texts', () => {
  const parts = diffWords('the quick brown fox', 'the slow brown dog');
  assert.deepEqual(parts, [
    { type: 'equal', text: 'the ' }, { type: 'delete', text: 'quick' }, { type: 'insert', text: 'slow' }, { type: 'equal', text: ' brown ' }, { type: 'delete', text: 'fox' }, { type: 'insert', text: 'dog' },
  ]);
  assert.deepEqual(tokenizeWords("it's 3.14"), ['it', "'", 's', ' ', '3', '.', '14']);
  const r = rng(3);
  for (let i = 0; i < 100; i++) {
    const mk = () => Array.from({ length: Math.floor(r() * 12) }, () => ['foo', 'bar', ' ', ', ', 'x1', 'été'][Math.floor(r() * 6)]).join('');
    const a = mk(); const b = mk();
    const w = diffWords(a, b); const c = diffChars(a, b);
    assert.deepEqual([sideText(w, 'old'), sideText(w, 'new'), sideText(c, 'old'), sideText(c, 'new')], [a, b, a, b]);
  }
  const chars = diffChars('a\u{1F600}b', 'a\u{1F601}b');
  assert.deepEqual(chars, [{ type: 'equal', text: 'a' }, { type: 'delete', text: '\u{1F600}' }, { type: 'insert', text: '\u{1F601}' }, { type: 'equal', text: 'b' }], 'a code point is never split');
  assert.deepEqual(diffChars('kitten', 'sitting').map((p) => `${p.type[0]}:${p.text}`), ['d:k', 'i:s', 'e:itt', 'd:e', 'i:i', 'e:n', 'i:g']);
});

test('side by side pairs replaced lines, marks the words inside, and folds long unchanged stretches', () => {
  const a = 'keep 1\nthe quick brown fox\ndrop me\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\n';
  const b = 'keep 1\nthe slow brown fox\nkeep 2\nkeep 3\nkeep 4\nkeep 5\nkeep 6\nadded\n';
  const m = sideBySide(a, b);
  assert.deepEqual(m.rows.map((r) => r.kind), ['equal', 'change', 'delete', 'equal', 'equal', 'equal', 'equal', 'equal', 'insert']);
  const ch = m.rows[1]!;
  assert.ok(ch.kind === 'change');
  assert.deepEqual(ch.left.parts, [{ type: 'equal', text: 'the ' }, { type: 'delete', text: 'quick' }, { type: 'insert', text: 'slow' }, { type: 'equal', text: ' brown fox' }]);
  assert.deepEqual([ch.left.no, ch.right.no], [2, 2]);
  assert.deepEqual(m.stats, { additions: 2, deletions: 2, unchanged: 6, similarity: 12 / 16 });
  const folded = sideBySide(a, b, { context: 1 });
  assert.deepEqual(folded.rows.map((r) => r.kind), ['equal', 'change', 'delete', 'equal', 'gap', 'equal', 'insert']);
  assert.deepEqual(folded.rows.find((r) => r.kind === 'gap'), { kind: 'gap', skipped: 3 });
  const unlike = sideBySide('abcdefghij\n', 'zyxwvutsrq\n');
  assert.ok(unlike.rows[0]!.kind === 'change' && unlike.rows[0]!.left.parts === undefined, 'lines with nothing in common are replaced, not word-diffed');
  const off = sideBySide('a b c\n', 'a x c\n', { intraline: false });
  assert.ok(off.rows[0]!.kind === 'change' && off.rows[0]!.left.parts === undefined);
});

test('the inline model gives one column with changed words in place', () => {
  const m = inlineModel('one\nthe cat sat\nthree\n', 'one\nthe dog sat\nthree\nfour\n');
  assert.deepEqual(m.lines.map((l) => l.kind), ['equal', 'change', 'equal', 'insert']);
  const c = m.lines[1]!;
  assert.ok(c.kind === 'change');
  assert.deepEqual(c.parts.map((p) => `${p.type[0]}:${p.text}`), ['e:the ', 'd:cat', 'i:dog', 'e: sat']);
  assert.deepEqual(m.lines[3], { kind: 'insert', newNo: 4, text: 'four' });
  assert.deepEqual(inlineModel('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nD\ne\nf\ng\n', { context: 1 }).lines.map((l) => l.kind), ['gap', 'equal', 'delete', 'insert', 'equal', 'gap']);
});

test('a block of lines moved to another place is pointed out, and small or blank ones are not', () => {
  const block = ['function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i.price;', '  return sum;', '}'];
  const middle = ['m one', 'm two', 'm three', 'm four', 'm five', 'm six', 'm seven', 'm eight'];
  // the diff keeps the longer stretch in place, so the block is the part that moves
  const a = ['header', ...block, ...middle, 'footer'].join('\n') + '\n';
  const b = ['header', ...middle, ...block, 'footer'].join('\n') + '\n';
  const d = diffLines(a, b);
  const moves = findMoves(d);
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0]!.from, moves[0]!.to], [{ aStart: 1, len: 5 }, { bStart: 9, len: 5 }]);
  const rows = sideBySide(a, b, { moves: true }).rows;
  assert.equal(rows.filter((r) => r.kind === 'delete' && r.left.moved === 1).length, 5);
  assert.equal(rows.filter((r) => r.kind === 'insert' && r.right.moved === 1).length, 5);
  const small = diffLines('x\n111\n222\n333\nm1\nm2\nm3\nm4\ny\n', 'x\nm1\nm2\nm3\nm4\n111\n222\n333\ny\n');
  assert.deepEqual(findMoves(small, { minLines: 3, minChars: 20 }), [], 'nine characters in three lines is too little to call a move');
  assert.equal(findMoves(small, { minLines: 3, minChars: 9 }).length, 1);
  assert.deepEqual(findMoves(small, { minLines: 4, minChars: 1 }), [], 'and a block must be as many lines as asked');
  assert.deepEqual(findMoves(diffLines('p\n\n\n\n\nq\n', 'p\nq\n\n\n\n\n')), [], 'blank lines are never a block');
  assert.deepEqual(findMoves(diffLines(a, a)), []);
  assert.equal(sideBySide(a, b).moves.length, 0, 'moves are only looked for when asked');
});

test('limits: too much text is refused, and too much work gives a correct coarse diff that says so', () => {
  assert.throws(() => diffLines('x'.repeat(101), '', { maxBytes: 100 }), TooLarge);
  assert.throws(() => diffLines('a\n'.repeat(11), '', { maxLines: 10 }), TooLarge);
  assert.throws(() => diffWords('x'.repeat(11), '', { maxChars: 10 }), TooLarge);
  const r = rng(11);
  const a = Array.from({ length: 400 }, () => `k${Math.floor(r() * 50)}`).join('\n') + '\n';
  const b = Array.from({ length: 400 }, () => `k${Math.floor(r() * 50)}`).join('\n') + '\n';
  const exact = diffLines(a, b);
  const coarse = diffLines(a, b, { maxWork: 500 });
  assert.equal(exact.approximate, false);
  assert.equal(coarse.approximate, true);
  assert.ok(stats(coarse).unchanged <= stats(exact).unchanged);
  const [p] = parsePatch(unified(a, b, { maxWork: 500 }));
  assert.equal(applyPatch(a, p!), b, 'a coarse diff still turns a into b');
  assert.equal(sideBySide(a, b, { maxWork: 500 }).approximate, true);
});

test('similarity and counts', () => {
  assert.deepEqual(stats(diffLines('a\nb\nc\nd\n', 'a\nb\nc\nd\n')), { additions: 0, deletions: 0, unchanged: 4, similarity: 1 });
  assert.deepEqual(stats(diffLines('', '')), { additions: 0, deletions: 0, unchanged: 0, similarity: 1 });
  assert.deepEqual(stats(diffLines('a\n', 'b\n')), { additions: 1, deletions: 1, unchanged: 0, similarity: 0 });
  assert.equal(stats(diffLines('a\nb\n', 'a\nc\n')).similarity, 0.5);
});
