import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdf, width, winAnsi, wrap } from './index.ts';

test('wrapping respects the width, and long words are broken', () => {
  const lines = wrap('The quick brown fox jumps over the lazy dog again and again', 11, 120);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => width(l, 11) <= 120));
  assert.ok(wrap('x'.repeat(200), 11, 100).every((l) => width(l, 11) <= 100));
  assert.equal(winAnsi('“smart” — quotes… 日本'), '"smart" - quotes... ??');
});

test('a well-formed PDF: every cross-reference offset points at its object, text is escaped, pages are numbered', () => {
  const rows = [['Item', 'Note'], ...Array.from({ length: 80 }, (_, i) => [`Row ${i}`, i % 7 ? 'short' : 'a much longer note that will wrap onto a second line in this narrow column'])];
  const b = pdf([{ h: 'Quarterly (draft) report' }, { p: 'Back\\slash and (brackets) are escaped.' }, { table: rows, widths: [1, 2] }], { title: 'Report', author: 'Ana' });
  const s = b.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.7'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)/.exec(s)![1]);
  assert.ok(s.slice(start).startsWith('xref'));
  const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.ok(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} at ${off}`));
  assert.match(s, /\(Quarterly \\\(draft\\\) report\) Tj/);
  assert.match(s, /\(Back\\\\slash and \\\(brackets\\\) are escaped\.\) Tj/);
  const count = Number(/\/Type \/Pages \/Kids \[[^\]]+\] \/Count (\d+)/.exec(s)![1]);
  assert.ok(count >= 2, 'the table runs onto more pages');
  assert.match(s, new RegExp(`\\(${count} of ${count}\\) Tj`));
  assert.equal((s.match(/\(Item\) Tj/g) ?? []).length, count, 'the header row repeats on every page');
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const at = m.index! + m[0].length;
    assert.equal(s.slice(at + Number(m[1]), at + Number(m[1]) + 10), '\nendstream');
  }
});

const ys = (s: string) => [...s.matchAll(/ ([\d.]+) Td /g)].map((m) => Number(m[1]));

test('C1 control characters do not turn into WinAnsi symbols', () => {
  assert.equal(winAnsi('a\u0080b\u0099c\u007f'), 'a?b?c?');
  assert.equal(winAnsi('café ÿ'), 'café ÿ');
});

test('a table row taller than a page continues on the next page instead of running off the bottom', () => {
  const b = pdf([{ table: [['A', 'B'], ['x', 'long '.repeat(3000)]] }], { title: 'T' });
  const s = b.toString('latin1');
  const footerY = 28;
  assert.ok(ys(s).filter((y) => y !== footerY).every((y) => y >= 56 + 24 - 13), `lowest text at ${Math.min(...ys(s))}`);
  assert.ok(Number(/\/Count (\d+)/.exec(s)![1]) >= 2);
  assert.equal((s.match(/long/g) ?? []).length, 3000, 'every word is drawn once');
});

test('an empty table and a very long table are handled', () => {
  assert.ok(pdf([{ table: [] }], { title: 'T' }).toString('latin1').includes('%%EOF'));
  const rows = Array.from({ length: 150_000 }, (_, i) => [`${i}`]);
  assert.ok(pdf([{ table: rows }], { title: 'T' }).length > 0);
});

/** The y of every line of text placed on each page, footer left out. */
const placed = (buf: Buffer) =>
  [...buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => [...m[1]!.matchAll(/ Tf [\d.]+ ([-\d.]+) Td/g)].map((t) => Number(t[1])).slice(0, -1));

test('a heading taller than a page continues on the next page, never below the bottom margin', () => {
  const buf = pdf([{ p: 'Intro' }, { h: Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ') }, { p: 'After' }], { title: 'T' });
  const pages = placed(buf);
  assert.ok(pages.length >= 2, 'the heading spans pages');
  for (const ys of pages) for (const y of ys) assert.ok(y >= 56 && y <= 841.89 - 56, `text at y=${y} is off the page`);
  assert.equal(pages.flat().length, wrap(Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '), 16, 595.28 - 112, true).length + 2, 'every line is drawn');
});

test('a negative or non-finite space block is refused, rather than pushing text off the top', () => {
  assert.throws(() => pdf([{ space: -500 }, { p: 'x' }], { title: 'T' }), /space block must be zero or more points, not -500/);
  assert.throws(() => pdf([{ space: Number.NaN }], { title: 'T' }), /zero or more/);
  assert.throws(() => pdf([{ space: Infinity }], { title: 'T' }), /zero or more/);
  for (const y of placed(pdf([{ space: 0 }, { space: 2000 }, { p: 'x' }], { title: 'T' })).flat()) assert.ok(y <= 841.89 - 56);
});

/** Every content stream of a PDF as its list of drawing operations, footer included. */
const streamOps = (buf: Buffer) => [...buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]!.split('\n'));
/** The text drawn at each step, as "font size x y text", footer left out. */
const drawn = (buf: Buffer) =>
  streamOps(buf).map((ops) =>
    ops
      .slice(0, -1)
      .filter((o) => o.startsWith('BT'))
      .map((o) => o.replace(/^BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([-\d.]+) Td \((.*)\) Tj ET$/, '$1 $2 $3 $4 $5')),
  );
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('text width uses the Helvetica advance widths, with a fallback for anything outside printable ASCII, and bold is 6% wider', () => {
  near(width('A', 10), 6.67);
  near(width(' ', 10), 2.78);
  near(width('~', 10), 5.84);
  near(width('\x7f', 10), 5.56);
  near(width('\x1f', 10), 5.56);
  near(width('é', 10), 5.56);
  near(width('', 10), 0);
  near(width('AB', 20), 0.667 * 20 + 0.667 * 20);
  near(width('A', 10, true), 6.67 * 1.06);
  near(width('Hello', 12), (722 + 556 + 222 + 222 + 556) * 0.012);
});

test('typographic quotes, dashes and ellipses become their plain equivalents', () => {
  assert.equal(winAnsi('it’s ‘quoted’ and “double” – dash — dash …'), `it's 'quoted' and "double" - dash - dash ...`);
  assert.equal(winAnsi('plain'), 'plain');
});

test('wrapping gives exact lines: words stay whole, a line may fill the width exactly, and spaces never start or end a line', () => {
  const w = (s: string) => width(s, 10);
  assert.deepEqual(wrap('ab cd', 10, w('ab cd')), ['ab cd']);
  assert.deepEqual(wrap('ab cd', 10, w('ab cd') - 0.01), ['ab', 'cd']);
  assert.deepEqual(wrap('x yy', 10, w('yy')), ['x', 'yy']);
  assert.deepEqual(wrap('a ', 10, 100), ['a']);
  assert.deepEqual(wrap('  a   b\t c  ', 10, 100), ['a b c']);
  assert.deepEqual(wrap('a\n\nb', 10, 100), ['a', '', 'b']);
  assert.deepEqual(wrap('', 10, 100), ['']);
  assert.deepEqual(wrap('one two three four', 10, w('one two')), ['one two', 'three', 'four']);
});

test('a word longer than the line is cut into pieces that each fill the line, and a letter wider than the line still gets a line', () => {
  const w = (s: string) => width(s, 10);
  assert.deepEqual(wrap('AAAAA', 10, w('AA')), ['AA', 'AA', 'A']);
  assert.deepEqual(wrap('AAAA', 10, w('AA')), ['AA', 'AA']);
  assert.deepEqual(wrap('x AAAAA', 10, w('AA')), ['x', 'AA', 'AA', 'A']);
  assert.deepEqual(wrap('xy ABCDE', 10, w('ABC')), ['xy', 'ABC', 'DE']);
  assert.deepEqual(wrap('WW', 10, 1).filter(Boolean), ['W', 'W']);
  assert.deepEqual(wrap('ab WW', 10, 1).filter(Boolean), ['a', 'b', 'W', 'W']);
});

test('bold text wraps sooner than regular text, and regular is the default', () => {
  const regular = width('aaa bbb', 10);
  assert.deepEqual(wrap('aaa bbb', 10, regular), ['aaa bbb']);
  assert.deepEqual(wrap('aaa bbb', 10, regular, false), ['aaa bbb']);
  assert.deepEqual(wrap('aaa bbb', 10, regular, true), ['aaa', 'bbb']);
});

test('a small document is written byte for byte as expected', () => {
  const buf = pdf([{ h: 'Title' }, { p: 'Hello (world)' }, { space: 100 }, { table: [['A', 'B'], ['x', 'y']], widths: [1, 3] }], { title: 'T', author: 'Ana' });
  const expected = [
    '%PDF-1.7',
    '%\xe2\xe3\xcf\xd3',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R /Lang (en) >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [6 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    'endobj',
    '4 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    'endobj',
    '5 0 obj',
    '<< /Length 368 >>',
    'stream',
    'BT /F2 16 Tf 56.00 763.89 Td (Title) Tj ET',
    'BT /F1 11 Tf 56.00 740.89 Td (Hello \\(world\\)) Tj ET',
    'BT /F2 10 Tf 60.00 618.89 Td (A) Tj ET',
    'BT /F2 10 Tf 180.82 618.89 Td (B) Tj ET',
    '0.6 w 56 615.89 m 539.28 615.89 l S',
    'BT /F1 10 Tf 60.00 599.89 Td (x) Tj ET',
    'BT /F1 10 Tf 180.82 599.89 Td (y) Tj ET',
    '0.6 w 56 596.89 m 539.28 596.89 l S',
    'BT /F1 9 Tf 286.38 28.00 Td (1 of 1) Tj ET',
    'endstream',
    'endobj',
    '6 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 5 0 R >>',
    'endobj',
    '7 0 obj',
    '<< /Title (T) /Author (Ana) /Producer (zthr pdf) >>',
    'endobj',
    'xref',
    '0 8',
    '0000000000 65535 f ',
    '0000000015 00000 n ',
    '0000000075 00000 n ',
    '0000000132 00000 n ',
    '0000000229 00000 n ',
    '0000000331 00000 n ',
    '0000000750 00000 n ',
    '0000000892 00000 n ',
    'trailer',
    '<< /Size 8 /Root 1 0 R /Info 7 0 R >>',
    'startxref',
    '959',
    '%%EOF',
    '',
  ].join('\n');
  assert.equal(buf.toString('latin1'), expected);
  assert.equal(buf.length, expected.length, 'one byte per character');
});

test('Letter pages are 612 by 792 and the default is A4; the author is optional', () => {
  const letter = pdf([{ p: 'x' }], { title: 'T', size: 'Letter' }).toString('latin1');
  assert.ok(letter.includes('/MediaBox [0 0 612 792]'));
  assert.ok(letter.includes('BT /F1 9 Tf 294.74 28.00 Td (1 of 1) Tj ET'));
  assert.ok(letter.includes('BT /F1 11 Tf 56.00 721.00 Td (x) Tj ET'));
  const a4 = pdf([{ p: 'x' }], { title: 'T', size: 'A4' }).toString('latin1');
  assert.ok(a4.includes('/MediaBox [0 0 595.28 841.89]'));
  assert.ok(a4.includes('<< /Title (T) /Producer (zthr pdf) >>'));
  assert.ok(!a4.includes('/Author'));
  assert.ok(pdf([], { title: 'T', author: '' }).toString('latin1').includes('<< /Title (T) /Producer (zthr pdf) >>'));
  assert.ok(pdf([], { title: 'A (b)', author: 'C\\D' }).toString('latin1').includes('<< /Title (A \\(b\\)) /Author (C\\\\D) /Producer (zthr pdf) >>'));
});

test('lines are set at the right distances: a heading, paragraphs and space blocks stack from the top margin', () => {
  const one = drawn(pdf([{ h: 'Head' }, { p: 'one' }, { p: 'two' }, { space: 0 }, { p: 'three' }, { space: 20 }, { p: 'four' }], { title: 'T' }))[0];
  assert.deepEqual(one, ['F2 16 56.00 763.89 Head', 'F1 11 56.00 740.89 one', 'F1 11 56.00 719.89 two', 'F1 11 56.00 698.89 three', 'F1 11 56.00 657.89 four']);
  const wrapped = drawn(pdf([{ p: 'a\nb' }, { h: 'Two\nlines' }, { p: 'c' }], { title: 'T' }))[0];
  assert.deepEqual(wrapped, ['F1 11 56.00 770.89 a', 'F1 11 56.00 755.89 b', 'F2 16 56.00 727.89 Two', 'F2 16 56.00 709.89 lines', 'F1 11 56.00 686.89 c']);
});

test('text wraps at the page width less both margins, on A4 and on Letter', () => {
  const text = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
  for (const [size, pw] of [['A4', 595.28], ['Letter', 612]] as const) {
    const lines = drawn(pdf([{ p: text }], { title: 'T', size })).flat().map((l) => l.split(' ').slice(4).join(' '));
    assert.deepEqual(lines, wrap(text, 11, pw - 112));
  }
  const heading = drawn(pdf([{ h: text }], { title: 'T' })).flat().map((l) => l.split(' ').slice(4).join(' '));
  assert.deepEqual(heading, wrap(text, 16, 595.28 - 112, true));
});

test('a heading is measured in bold when it wraps', () => {
  const h = Array.from({ length: 20 }, () => 'aaaa').join(' ');
  const regular = wrap(h, 16, 595.28 - 112);
  const bold = wrap(h, 16, 595.28 - 112, true);
  assert.notDeepEqual(regular, bold);
  assert.deepEqual(drawn(pdf([{ h }], { title: 'T' })).flat().map((l) => l.split(' ').slice(4).join(' ')), bold);
});

test('a new page starts when the next line would fall within 24 points of the bottom margin', () => {
  const lines = 'x\n'.repeat(59) + 'x';
  const pages = drawn(pdf([{ p: lines }], { title: 'T' }));
  assert.equal(pages[0]!.length, 47);
  assert.equal(pages[0]![46], 'F1 11 56.00 80.89 x');
  assert.equal(pages[1]![0], 'F1 11 56.00 770.89 x');
  assert.equal(pages.length, 2);
  // On Letter a line can land exactly on the limit (95 - 15 = 80) and stays; one point lower it moves over.
  const fits = drawn(pdf([{ space: 641 }, { p: 'x' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(fits, [['F1 11 56.00 80.00 x']]);
  const over = drawn(pdf([{ space: 642 }, { p: 'x' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(over, [[], ['F1 11 56.00 721.00 x']]);
});

test('a heading that will not fit whole starts on a fresh page; one that just fits stays', () => {
  // A one-line heading needs 28 points: it fits from y=108 and not from y=107.
  const stays = drawn(pdf([{ space: 628 }, { h: 'H' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(stays, [['F2 16 56.00 86.00 H']]);
  const moves = drawn(pdf([{ space: 629 }, { h: 'H' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(moves, [[], ['F2 16 56.00 714.00 H']]);
  // Two lines need 48.
  const two = drawn(pdf([{ space: 608 }, { h: 'H\nI' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(two, [['F2 16 56.00 106.00 H', 'F2 16 56.00 88.00 I']]);
  const twoMoves = drawn(pdf([{ space: 609 }, { h: 'H\nI' }], { title: 'T', size: 'Letter' }));
  assert.deepEqual(twoMoves, [[], ['F2 16 56.00 714.00 H', 'F2 16 56.00 696.00 I']]);
});

test('a document with accented text still has a correct length and cross-reference table, one byte per character', () => {
  const buf = pdf([{ p: 'café ÿ ñ' }, { p: 'second' }], { title: 'Crème', author: 'Zoë', footer: (p, n) => `é ${p}/${n}` });
  const s = buf.toString('latin1');
  assert.deepEqual([...buf.subarray(9, 14)], [0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  assert.ok(buf.includes(Buffer.from('(café ÿ ñ) Tj', 'latin1')));
  const m = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(s)!;
  assert.equal(Number(m[1]), buf.subarray(buf.indexOf('stream\n') + 7).indexOf('\nendstream'));
  const start = Number(/startxref\n(\d+)/.exec(s)![1]);
  assert.equal(buf.subarray(start, start + 4).toString('latin1'), 'xref');
  const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((e) => Number(e[1]));
  assert.equal(entries.length, 7);
  entries.forEach((off, i) => assert.equal(buf.subarray(off, off + `${i + 1} 0 obj`.length).toString('latin1'), `${i + 1} 0 obj`));
  assert.equal(entries[0], 15);
  assert.ok(s.includes('(é 1/1) Tj'));
});

test('several pages: objects, kids, count and numbering are consistent, and a custom footer gets the page and the total', () => {
  const calls: [number, number][] = [];
  const buf = pdf([{ p: 'x\n'.repeat(100) }], { title: 'T', footer: (p, n) => (calls.push([p, n]), `p(${p})/${n}`) });
  const s = buf.toString('latin1');
  assert.deepEqual(calls, [[1, 3], [2, 3], [3, 3]]);
  assert.ok(s.includes('/Kids [6 0 R 8 0 R 10 0 R] /Count 3'));
  assert.ok(s.includes('<< /Size 12 /Root 1 0 R /Info 11 0 R >>'));
  assert.ok(s.includes('0 12\n0000000000 65535 f \n'));
  assert.ok(s.includes('/Parent 2 0 R'));
  for (const [i, k] of [[1, 5], [2, 7], [3, 9]] as const) assert.ok(s.includes(`/Contents ${k} 0 R >>`), `page ${i}`);
  assert.deepEqual(streamOps(buf).map((ops) => ops.at(-1)), [
    'BT /F1 9 Tf 285.89 28.00 Td (p\\(1\\)/3) Tj ET',
    'BT /F1 9 Tf 285.89 28.00 Td (p\\(2\\)/3) Tj ET',
    'BT /F1 9 Tf 285.89 28.00 Td (p\\(3\\)/3) Tj ET',
  ]);
  const plain = streamOps(pdf([{ p: 'x\n'.repeat(100) }], { title: 'T' })).map((ops) => ops.at(-1)!.replace(/^.*\(/, ''));
  assert.deepEqual(plain, ['1 of 3) Tj ET', '2 of 3) Tj ET', '3 of 3) Tj ET']);
});

test('a space block of zero or more points moves down by exactly that much', () => {
  assert.deepEqual(drawn(pdf([{ space: 100 }, { p: 'x' }], { title: 'T' })), [['F1 11 56.00 670.89 x']]);
  assert.deepEqual(drawn(pdf([{ space: 0 }, { p: 'x' }], { title: 'T' })), [['F1 11 56.00 770.89 x']]);
  assert.deepEqual(drawn(pdf([{ space: 0.5 }, { p: 'x' }], { title: 'T' })), [['F1 11 56.00 770.39 x']]);
  assert.throws(() => pdf([{ space: -1 }], { title: 'T' }), /a space block must be zero or more points, not -1$/);
});

/** Each page's drawing as short strings: "F2 10 60.00 113.00 text" for text and "rule 110.00" for a line under a row; footer left out. */
const compact = (buf: Buffer) =>
  streamOps(buf).map((ops) =>
    ops.slice(0, -1).map((o) => {
      const t = /^BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([-\d.]+) Td \((.*)\) Tj ET$/.exec(o);
      if (t) return `${t[1]} ${t[2]} ${t[3]} ${t[4]} ${t[5]}`;
      const r = /^0\.6 w 56 ([-\d.]+) m 556\.00 ([-\d.]+) l S$/.exec(o);
      return r && r[1] === r[2] ? `rule ${r[1]}` : `?? ${o}`;
    }),
  );
const LETTER = { title: 'T', size: 'Letter' } as const;
/** Spacing that leaves the next block starting at y on a Letter page (the top of the text area is 736). */
const down = (y: number): { space: number } => ({ space: 736 - y });

test('table cells hold text at the column positions, wrap within the column less 4 points each side, and rows are as tall as their tallest cell', () => {
  const ops = compact(pdf([{ table: [['Name', 'Note'], ['a', 'b\nc\nd'], ['e']], widths: [1, 4] }], LETTER))[0]!;
  assert.deepEqual(ops, [
    'F2 10 60.00 720.00 Name',
    'F2 10 160.00 720.00 Note',
    'rule 717.00',
    'F1 10 60.00 701.00 a',
    'F1 10 160.00 701.00 b',
    'F1 10 160.00 688.00 c',
    'F1 10 160.00 675.00 d',
    'rule 672.00',
    'F1 10 60.00 656.00 e',
    'F1 10 160.00 656.00 ',
    'rule 653.00',
  ]);
  // A cell of 89 letters is 494.84 points wide: too wide for a 500-point column less its 8 points of padding.
  assert.deepEqual(compact(pdf([{ table: [['h'], ['a'.repeat(88)], ['a'.repeat(89)]] }], LETTER))[0]!.slice(2), [`F1 10 60.00 701.00 ${'a'.repeat(88)}`, 'rule 698.00', `F1 10 60.00 682.00 ${'a'.repeat(88)}`, 'F1 10 60.00 669.00 a', 'rule 666.00']);
  assert.deepEqual(compact(pdf([{ table: [['h', 'i'], ['x']] }], LETTER))[0]!.slice(-3), ['F1 10 60.00 701.00 x', 'F1 10 310.00 701.00 ', 'rule 698.00']);
});

test('after a table the next block starts 10 points below it, and an empty table leaves no trace', () => {
  assert.deepEqual(compact(pdf([{ table: [['h']] }, { p: 'after' }], LETTER))[0], ['F2 10 60.00 720.00 h', 'rule 717.00', 'F1 11 56.00 692.00 after']);
  assert.deepEqual(compact(pdf([{ table: [] }, { p: 'after' }], LETTER))[0], ['F1 11 56.00 721.00 after']);
  assert.deepEqual(compact(pdf([{ table: [] }], LETTER)), [[]]);
});

test('new pages hold exactly what was drawn on them, nothing else', () => {
  const buf = pdf([{ p: 'x\n'.repeat(60) + 'x' }], { title: 'T' });
  const raw = streamOps(buf);
  assert.equal(raw.length, 2);
  assert.ok(raw[1]!.every((o) => /^BT \/F1 (11|9) Tf [\d.]+ [\d.]+ Td \(.*\) Tj ET$/.test(o)), raw[1]!.join('|'));
  assert.equal(raw[1]!.length, 14 + 1, '14 lines and the footer');
});

test('a row that does not fit what is left of the page moves whole to the next page, under a repeated header', () => {
  const top = down(129); // the header takes 19 points, leaving y = 110
  const moved = (rows: string[][]) => compact(pdf([top, { table: [['H'], ...rows] }], LETTER));
  const header2 = ['F2 10 60.00 720.00 H', 'rule 717.00'];
  // A row of 2 lines needs 32 points: from 110 it leaves 78, below the 80 limit.
  assert.deepEqual(moved([['a'.repeat(89)]]), [['F2 10 60.00 113.00 H', 'rule 110.00'], [...header2, `F1 10 60.00 701.00 ${'a'.repeat(88)}`, 'F1 10 60.00 688.00 a', 'rule 685.00']]);
  // Its tallest cell decides, not its shortest.
  for (const row of [['a\nb\nc', 'x'], ['x', 'a\nb\nc']]) {
    const pages = compact(pdf([top, { table: [['H', 'I'], row] }], LETTER));
    assert.equal(pages.length, 2, 'the three-line row moves whole');
    assert.equal(pages[0]!.length, 3);
    assert.equal(pages[1]!.filter((o) => /[abc]$/.test(o)).length, 3);
  }
  // A row of one line fits, leaving 91.
  assert.deepEqual(moved([['a']]), [['F2 10 60.00 113.00 H', 'rule 110.00', 'F1 10 60.00 94.00 a', 'rule 91.00']]);
  // Width is measured with the regular font for body rows: 88 letters fit one line, so the row fits.
  assert.deepEqual(moved([['a'.repeat(88)]]).length, 1);
  // A row exactly as tall as the room left stays: from y=99 a one-line row ends on the limit of 80.
  assert.deepEqual(compact(pdf([down(137), { table: [['H'], ['a'], ['b']] }], LETTER)), [['F2 10 60.00 121.00 H', 'rule 118.00', 'F1 10 60.00 102.00 a', 'rule 99.00', 'F1 10 60.00 83.00 b', 'rule 80.00']]);
  // A row taller than the room left by a little more than the allowance for padding still moves.
  const two = compact(pdf([down(124), { table: [['H'], ['a\nb']] }], LETTER));
  assert.equal(two.length, 2);
  assert.deepEqual(two[1]!.slice(2), ['F1 10 60.00 701.00 a', 'F1 10 60.00 688.00 b', 'rule 685.00']);
});

test('a missing cell in a short row is empty and takes no space', () => {
  const moved = compact(pdf([down(129), { table: [['H1', 'H2', 'H3'], ['a']], widths: [10, 10, 2] }], LETTER));
  assert.equal(moved.length, 1, 'the row still fits, as a one-line row');
  assert.deepEqual(moved[0]!.slice(-4), ['F1 10 60.00 94.00 a', 'F1 10 287.27 94.00 ', 'F1 10 514.55 94.00 ', 'rule 91.00']);
});

test('a row fits on a fresh page, unless it is more than 46 lines tall, in which case it starts where it is and continues', () => {
  const rows = (n: number) => [['H'], [Array.from({ length: n }, (_, i) => `l${i}`).join('\n')]];
  // 46 lines need 604 points and fit on a page: from y=110 they move whole.
  const moves = compact(pdf([down(129), { table: rows(46) }], LETTER));
  assert.equal(moves.length, 2);
  assert.deepEqual(moves[0], ['F2 10 60.00 113.00 H', 'rule 110.00']);
  assert.equal(moves[1]!.length, 2 + 46 + 1);
  // 47 lines need 617 points, more than a page leaves: they start on this page (one line fits) and carry on after the header.
  const splits = compact(pdf([down(129), { table: rows(47) }], LETTER));
  assert.equal(splits.length, 2);
  assert.deepEqual(splits[0], ['F2 10 60.00 113.00 H', 'rule 110.00', 'F1 10 60.00 94.00 l0', 'rule 91.00']);
  assert.deepEqual(splits[1]!.slice(0, 4), ['F2 10 60.00 720.00 H', 'rule 717.00', 'F1 10 60.00 701.00 l1', 'F1 10 60.00 688.00 l2']);
  assert.equal(splits[1]!.length, 2 + 46 + 1);
});

test('a row taller than a page continues on the next page below the repeated header, and what follows starts under it', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
  const pages = compact(pdf([{ table: [['H'], [lines]] }, { p: 'after' }], LETTER));
  assert.equal(pages.length, 3);
  const text = (p: string[]) => p.filter((o) => o.startsWith('F1')).map((o) => o.split(' ').slice(2).join(' '));
  // Page 1: header, then 48 lines (the room under it) ending at y=90, and the line under the part-row.
  assert.deepEqual(pages[0]!.slice(0, 3), ['F2 10 60.00 720.00 H', 'rule 717.00', 'F1 10 60.00 701.00 l0']);
  assert.deepEqual(pages[0]!.slice(-2), ['F1 10 60.00 90.00 l47', 'rule 87.00']);
  assert.equal(text(pages[0]!).length, 48);
  // Page 2: the header repeated in bold, then the next 48 lines.
  assert.deepEqual(pages[1]!.slice(0, 3), ['F2 10 60.00 720.00 H', 'rule 717.00', 'F1 10 60.00 701.00 l48']);
  assert.deepEqual(pages[1]!.slice(-2), ['F1 10 60.00 90.00 l95', 'rule 87.00']);
  // Page 3: the last 4 lines, the table's end, and the paragraph 10 + 15 points below the last rule.
  assert.deepEqual(pages[2]!, ['F2 10 60.00 720.00 H', 'rule 717.00', 'F1 10 60.00 701.00 l96', 'F1 10 60.00 688.00 l97', 'F1 10 60.00 675.00 l98', 'F1 10 60.00 662.00 l99', 'rule 659.00', 'F1 11 56.00 634.00 after']);
});

test('a one-line room is used: a tall row starting where exactly one line fits draws it there', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n');
  const pages = compact(pdf([down(129), { table: [['H'], [lines]] }], LETTER));
  assert.deepEqual(pages[0]!.slice(2), ['F1 10 60.00 94.00 l0', 'rule 91.00']);
  const lower = compact(pdf([down(128), { table: [['H'], [lines]] }], LETTER));
  assert.deepEqual(lower[0]!.slice(2), ['F1 10 60.00 93.00 l0', 'rule 90.00']);
  // With y=91 no line fits any more (a line needs 19 points above the limit of 80 plus 6 below it), so the row begins on the next page.
  const none = compact(pdf([down(129), { table: [['H'], ['a'], [lines]] }], LETTER));
  assert.deepEqual(none[0]!, ['F2 10 60.00 113.00 H', 'rule 110.00', 'F1 10 60.00 94.00 a', 'rule 91.00']);
  assert.deepEqual(none[1]!.slice(0, 3), ['F2 10 60.00 720.00 H', 'rule 717.00', 'F1 10 60.00 701.00 l0']);
});

test('the header repeats on later pages unless it is so tall (17 lines or more) that it would take much of each page', () => {
  const body = Array.from({ length: 100 }, (_, i) => [`r${i}`]);
  const headerWith = (lines: number) => Array.from({ length: lines }, (_, i) => `h${i}`).join('\n');
  const countOf = (buf: Buffer, what: string) => compact(buf).map((p) => p.filter((o) => o.endsWith(` ${what}`)).length);
  const small = pdf([{ table: [[headerWith(16)], ...body] }], LETTER);
  const smallPages = compact(small).length;
  assert.ok(smallPages >= 3);
  assert.deepEqual(countOf(small, 'h0'), Array(smallPages).fill(1));
  assert.deepEqual(countOf(small, 'h15'), Array(smallPages).fill(1));
  const tall = pdf([{ table: [[headerWith(17)], ...body] }], LETTER);
  const tallPages = compact(tall).length;
  assert.ok(tallPages >= 3);
  assert.deepEqual(countOf(tall, 'h0'), [1, ...Array(tallPages - 1).fill(0)]);
  // The header is judged in bold: 17 words that fit two to a line in regular type, but one to a line in bold.
  const word = 'a'.repeat(43);
  const wide = Array.from({ length: 17 }, () => word).join(' ');
  assert.equal(wrap(wide, 10, 492).length, 9);
  assert.equal(wrap(wide, 10, 492, true).length, 17);
  const bold = pdf([{ table: [[wide], ...body] }], LETTER);
  assert.deepEqual(countOf(bold, word), [17, ...Array(compact(bold).length - 1).fill(0)]);
});

test('a header taller than the room at the start continues on the next page, once, and is not repeated again', () => {
  const header = Array.from({ length: 5 }, (_, i) => `h${i}`).join('\n');
  const pages = compact(pdf([down(129), { table: [[header], ['x']] }], LETTER));
  assert.deepEqual(pages[0], ['F2 10 60.00 113.00 h0', 'F2 10 60.00 100.00 h1', 'F2 10 60.00 87.00 h2', 'rule 84.00']);
  assert.deepEqual(pages[1], ['F2 10 60.00 720.00 h3', 'F2 10 60.00 707.00 h4', 'rule 704.00', 'F1 10 60.00 688.00 x', 'rule 685.00']);
});

test('a tall header is not repeated above rows that continue, and body rows are regular, never bold', () => {
  const header = Array.from({ length: 17 }, (_, i) => `h${i}`).join('\n');
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
  const pages = compact(pdf([{ table: [[header], [lines]] }], LETTER));
  assert.ok(pages.length >= 3);
  assert.equal(pages.flat().filter((o) => o.startsWith('F2')).length, 17);
  assert.ok(pages.flat().filter((o) => o.startsWith('F1')).length === 100);
  assert.ok(pages.slice(1).every((p) => p[0]!.startsWith('F1')));
});
