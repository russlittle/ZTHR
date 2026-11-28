/** Fuzz: CSV (blocks/tabular parseCsv, toCsv). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, toCsv } from '../../blocks/tabular/index.ts';
import { bounded, forAll, type Rand } from './harness.ts';

const PIECES = ['a', 'b', 'Z', '0', ' ', '"', '""', ',', '\r', '\n', '\r\n', 'é', 'ß', '😀', '中', '​', '=', '+', '-', '@', '\t', "'", ';'];
const cell = (r: Rand) => (r.bool(0.2) ? '' : r.bool(0.15) ? r.text(1, 6) : r.str(1, 8, PIECES));
const table = (r: Rand, c: (r: Rand) => string = cell) => r.array(1, 6, () => r.array(1, 5, () => c(r)));

/** Shrinking stays inside the domain: at least one row, no empty rows (an empty row has no CSV form). */
const rectangular = (rows: string[][]) => rows.length > 0 && rows.every((r) => r.length > 0);

test('parseCsv(toCsv(rows)) round-trips quotes, commas, CR, LF, unicode and empty cells (300 cases)', async () => {
  await forAll('csv round trip', {
    cases: 300,
    gen: (r) => table(r),
    valid: (rows) => rectangular(rows),
    check: (rows) => assert.deepEqual(parseCsv(toCsv(rows, { defuse: false })), rows),
  });
});

test('round trip keeps a final row that holds one empty cell (200 cases)', async () => {
  await forAll('csv round trip, lone empty last row', {
    cases: 200,
    gen: (r) => [...table(r), ['']],
    valid: (rows) => rectangular(rows) && rows.at(-1)!.length === 1 && rows.at(-1)![0] === '',
    check: (rows) => assert.deepEqual(parseCsv(toCsv(rows, { defuse: false })), rows),
  });
});

test('round trip keeps a first cell that starts with U+FEFF (200 cases)', async () => {
  await forAll('csv round trip, leading BOM', {
    cases: 200,
    gen: (r) => { const t = table(r); t[0]![0] = `\uFEFF${t[0]![0]}`; return t; },
    valid: (rows) => rectangular(rows) && rows[0]![0]!.startsWith('\uFEFF'),
    check: (rows) => assert.deepEqual(parseCsv(toCsv(rows, { defuse: false })), rows),
  });
});

test('defused export: no string cell reads back starting with = + - @ tab or CR (400 cases)', async () => {
  const risky = (r: Rand) => r.pick(['=', '+', '-', '@', '\t', '\r', '\r\n', '\n', '"', ' ', '']) + cell(r);
  await forAll('csv defuse', {
    cases: 400,
    gen: (r) => table(r, risky),
    check: (rows) => {
      const back = parseCsv(toCsv(rows));
      // Every string cell survives (with at most one apostrophe added) and none starts like a formula.
      for (const [ri, row] of back.entries())
        for (const [ci, c] of row.entries()) {
          assert.doesNotMatch(c, /^[=+\-@\t\r]/, `row ${ri} cell ${ci}`);
          const orig = rows[ri]?.[ci];
          if (orig !== undefined) assert.ok(c === orig || c === `'${orig}`, `row ${ri} cell ${ci} changed beyond the apostrophe`);
        }
    },
  });
});

test('defused export also covers values that are not primitive strings but print as formulas (200 cases)', async () => {
  await forAll('csv defuse non-strings', {
    cases: 200,
    gen: (r) => r.array(1, 4, () => r.pick(['=', '+', '@', '-']) + r.str(1, 6, ['1', 'A', '(', ')', 'cmd', '|'])),
    check: (texts) => {
      const values: unknown[] = texts.map((t, i) => (i % 2 ? new String(t) : { toString: () => t }));
      for (const c of parseCsv(toCsv([values]))[0] ?? []) assert.doesNotMatch(c, /^[=+\-@\t\r]/);
    },
    shrink: () => [],
  });
});

test('parseCsv on random junk returns string[][] or throws an Error, and finishes (2000 cases, 8 s deadline)', async () => {
  await bounded({ module: new URL('./csv.jobs.ts', import.meta.url), fn: 'parseJunk', cases: 2000, ms: 8000 });
});
