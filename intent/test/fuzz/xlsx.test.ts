/** Fuzz: xlsx (blocks/tabular toXlsx writer + blocks/docparse xlsx reader). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xlsx } from '../../blocks/docparse/index.ts';
import { toXlsx } from '../../blocks/tabular/index.ts';
import { forAll, type Rand } from './harness.ts';

type Cell = string | number | boolean | null;

const PIECES = ['a', 'Z', ' ', '  ', '&', '&amp;', '&lt;', '&#60;', '&#x41;', '<', '>', '</t>', '<t>', '"', "'", ']]>', '\n', '\r\n', '\t', 'é', '中', '😀', '=1+1', 'TRUE', '1', '0.5', ''];
/** XML-legal text: no C0 controls except tab, LF, CR; no U+FFFE/FFFF; no lone surrogates. */
const legal = (r: Rand) => (r.bool(0.7) ? r.str(1, 8, PIECES) : r.text(1, 8).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, 'x'));
const num = (r: Rand): number => r.pick([() => r.int(-1000, 1000), () => r.next() * 1e6 - 5e5, () => r.pick([1e21, 1e-7, 123456789012345, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE, 1.7976931348623157e308, 0.1 + 0.2]), () => -r.next() * 1e-3])();
const cell = (r: Rand): Cell => {
  const k = r.int(0, 9);
  return k < 4 ? legal(r) : k < 7 ? num(r) : k < 9 ? r.bool() : null;
};
const table = (r: Rand) => r.array(0, 6, () => r.array(0, 6, () => cell(r)));

/** What the reader gives back: blanks stay null inside a row; trailing blanks and trailing blank rows are not there. */
const expected = (rows: Cell[][]) => {
  const out = rows.map((row) => {
    const r = [...row];
    while (r.length && r.at(-1) === null) r.pop();
    return r;
  });
  // A sheet ends at its last cell: wholly blank rows at the end are not rows.
  while (out.length && out.at(-1)!.length === 0) out.pop();
  return out;
};

test('xlsx(toXlsx(rows)) round-trips random tables of strings, numbers, booleans and blanks (300 cases)', async () => {
  await forAll('xlsx round trip', {
    cases: 300,
    gen: table,
    check: (rows) => {
      const sheets = xlsx(toXlsx(rows));
      assert.equal(sheets.length, 1);
      assert.deepEqual(sheets[0]!.rows, expected(rows));
    },
  });
});

test('-0 written to xlsx reads back as -0 (1 case)', { todo: 'toXlsx writes -0 as "0" (template string), so it reads back as +0' }, async () => {
  await forAll('xlsx negative zero', {
    cases: 1,
    gen: () => [[-0]],
    shrink: () => [],
    check: (rows) => assert.ok(Object.is(xlsx(toXlsx(rows))[0]!.rows[0]![0], -0)),
  });
});

test('text with XML-forbidden characters reads back with exactly those characters removed (200 cases)', async () => {
  const bad = ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u001f', '￾', '￿', '\ud800', '\udfff'];
  await forAll('xlsx forbidden characters', {
    cases: 200,
    gen: (r) => [[r.str(1, 10, [...bad, 'a', 'é', '😀', ' '])]],
    check: (rows) => {
      const text = rows[0]![0]!;
      const want = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
      const got = xlsx(toXlsx(rows))[0]!.rows;
      assert.deepEqual(got, [[want]]);
    },
  });
});

test('any sheet name comes back as one Excel accepts: 1 to 31 units, none of \\ / ? * : [ ] (300 cases)', async () => {
  await forAll('xlsx sheet name', {
    cases: 300,
    gen: (r) => r.str(0, 40, ['a', ' ', "'", '\\', '/', '?', '*', ':', '[', ']', '&', '"', '<', 'é', '😀', 'Q4']),
    check: (name) => {
      const got = xlsx(toXlsx([['x']], name))[0]!.name;
      assert.ok(got.length >= 1 && got.length <= 31, `length ${got.length}: ${JSON.stringify(got)}`);
      assert.doesNotMatch(got, /[\\/?*:[\]]|^'|'$/);
      assert.doesNotMatch(got, /[\ud800-\udbff]$/, 'cut inside a surrogate pair');
    },
  });
});
