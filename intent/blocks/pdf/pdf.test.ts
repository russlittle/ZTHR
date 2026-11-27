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
