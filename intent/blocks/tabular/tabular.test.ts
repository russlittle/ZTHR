import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { dedupe, distinctHeaders, importRows, parseCsv, suggestMapping, toCsv, toJsonLines, toXlsx, XLSX_CELL_LIMIT, XLSX_TRUNCATED, zip } from './index.ts';

test('CSV round-trips RFC 4180 quoting, and defuses formulas on the way out', () => {
  const text = '﻿name,note\r\n"Smith, Ana","said ""hi""\nthen left"\r\nBen,\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [['name', 'note'], ['Smith, Ana', 'said "hi"\nthen left'], ['Ben', '']]);
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.equal(toCsv([['=HYPERLINK("x")', -3, '-3']]), `"'=HYPERLINK(""x"")",-3,'-3`);
  assert.throws(() => parseCsv('"open'), /never closed/);
  assert.deepEqual(parseCsv('a;b', ';'), [['a', 'b']]);
});

const fields = [
  { name: 'email', label: 'Email', aliases: ['e-mail address'], required: true, parse: (v: string) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('not an email address');
    return v.toLowerCase();
  } },
  { name: 'name', label: 'Full name', required: true },
  { name: 'age', label: 'Age', parse: (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error('not a whole number');
    return n;
  } },
];

test('an import suggests a mapping, keeps good rows, and quarantines bad ones with row numbers and reasons', () => {
  const t = parseCsv('E-mail Address,Full Name,AGE,Shoe\nana@x.org,Ana,40,9\nnot-an-email,,old,\n,,,\nben@x.org,Ben,,10\n');
  const m = suggestMapping(t[0]!, fields);
  assert.deepEqual(m, { 'E-mail Address': 'email', 'Full Name': 'name', AGE: 'age', Shoe: undefined });
  const r = importRows(t, fields, m);
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana', age: 40 }, { email: 'ben@x.org', name: 'Ben' }]);
  assert.deepEqual(r.quarantine.map((q) => [q.row, q.problems]), [[3, ['Email: not an email address', 'Full name is empty', 'Age: not a whole number']]]);
  assert.deepEqual(r.unmapped, ['Shoe']);
  assert.throws(() => importRows(t, fields, { AGE: 'age' }), /no column is mapped to Email, Full name/);
});

test('duplicates merge by rules and say where each merged row came from', () => {
  const rows = [{ email: 'a@x', name: 'A', phone: '' }, { email: 'b@x', name: 'B', phone: '1' }, { email: 'A@x', name: 'Ana Smith', phone: '555' }];
  const d = dedupe(rows, (r) => r.email.toLowerCase(), { name: 'longest' });
  assert.deepEqual(d.rows[0], { email: 'a@x', name: 'Ana Smith', phone: '555' });
  assert.deepEqual(d.merged, [{ key: 'a@x', from: [0, 2] }]);
  assert.equal(toJsonLines([{ a: 1 }, { a: 2 }]), '{"a":1}\n{"a":2}\n');
});

test('xlsx is a valid zip with the sheet inside, numbers kept as numbers and text escaped', () => {
  const x = toXlsx([['Name', 'Amount'], ['A & B <co>', 12.5]]);
  assert.equal(x.readUInt32LE(0), 0x04034b50);
  assert.equal(x.readUInt32LE(x.length - 22), 0x06054b50);
  const entries: Record<string, string> = {};
  let p = 0;
  while (x.readUInt32LE(p) === 0x04034b50) {
    const size = x.readUInt32LE(p + 18);
    const nlen = x.readUInt16LE(p + 26);
    const name = x.subarray(p + 30, p + 30 + nlen).toString();
    entries[name] = inflateRawSync(x.subarray(p + 30 + nlen, p + 30 + nlen + size)).toString();
    p += 30 + nlen + size;
  }
  assert.equal(Object.keys(entries).length, 6);
  const sheet = entries['xl/worksheets/sheet1.xml']!;
  assert.match(sheet, /<c r="B2"><v>12\.5<\/v><\/c>/);
  assert.match(sheet, /A &amp; B &lt;co&gt;/);
  assert.equal(zip([]).length, 22);
});

const unzip = (x: Buffer) => {
  const entries: Record<string, string> = {};
  let p = 0;
  while (x.readUInt32LE(p) === 0x04034b50) {
    const size = x.readUInt32LE(p + 18);
    const nlen = x.readUInt16LE(p + 26);
    entries[x.subarray(p + 30, p + 30 + nlen).toString()] = inflateRawSync(x.subarray(p + 30 + nlen, p + 30 + nlen + size)).toString();
    p += 30 + nlen + size;
  }
  return entries;
};

test('xlsx text never carries characters XML forbids, and the sheet name is one Excel accepts', () => {
  const e = unzip(toXlsx([['x￾y￿z']], "'Q3/Q4: sales? [draft]*\\'"));
  assert.match(e['xl/worksheets/sheet1.xml']!, /<t xml:space="preserve">xyz<\/t>/);
  const name = /<sheet name="([^"]*)"/.exec(e['xl/workbook.xml']!)![1]!;
  assert.doesNotMatch(name, /[\\/?*:[\]]|^'|'$/);
  assert.equal(name, 'Q3 Q4  sales   draft');
  assert.equal(/<sheet name="([^"]*)"/.exec(unzip(toXlsx([['a']], '///'))['xl/workbook.xml']!)![1], 'Sheet1', 'a name with nothing left falls back');
  assert.equal(/<sheet name="([^"]*)"/.exec(unzip(toXlsx([['a']], `${'a'.repeat(30)}😀`))['xl/workbook.xml']!)![1], 'a'.repeat(30), 'cutting to 31 never splits a character');
});

test('dedupe leaves a row with no duplicate as it was, empty strings included', () => {
  const rows = [{ email: 'a@x', phone: '' }, { email: 'b@x', phone: '' }, { email: 'b@x', phone: '' }];
  assert.deepEqual(dedupe(rows, (r) => r.email).rows, [{ email: 'a@x', phone: '' }, { email: 'b@x', phone: '' }]);
  assert.deepEqual(dedupe(rows, (r) => r.email, { phone: 'longest' }).rows[0], { email: 'a@x', phone: '' });
});

test('keys named like object properties stay plain data in imports and merges', () => {
  const rows = [JSON.parse('{"id":"1","__proto__":{"admin":true}}') as Record<string, unknown>, JSON.parse('{"id":"1","__proto__":{"admin":true}}') as Record<string, unknown>];
  const merged = dedupe(rows, (r) => String(r.id)).rows[0]!;
  assert.equal(merged.admin, undefined, 'no inherited admin flag');
  assert.deepEqual(Object.keys(merged), ['id', '__proto__']);
  const t = parseCsv('email,constructor,__proto__\na@x.org,yes,no\n');
  const r = importRows(t, [{ name: 'email', label: 'Email', required: true }], { email: 'email' });
  assert.deepEqual(r.unmapped, ['constructor', '__proto__']);
  assert.equal(r.good.length, 1);
  const bad = importRows(parseCsv('email,__proto__\n,x\n'), [{ name: 'email', label: 'Email', required: true }], { email: 'email' });
  assert.deepEqual(Object.entries(bad.quarantine[0]!.raw), [['email', ''], ['__proto__', 'x']]);
  assert.deepEqual(Object.entries(suggestMapping(['__proto__', 'constructor'], [{ name: 'email', label: 'Email' }])), [['__proto__', undefined], ['constructor', undefined]]);
});

test('an empty value in xlsx is a blank cell, not a cell holding empty text', () => {
  const sheet = unzip(toXlsx([['a', null, undefined, 'd']]))['xl/worksheets/sheet1.xml']!;
  assert.doesNotMatch(sheet, /r="B1"|r="C1"/);
  assert.match(sheet, /r="D1"/);
});

test('a final row of one empty cell survives a CSV round trip', () => {
  const rows = [['a', 'b'], ['']];
  assert.equal(toCsv(rows), 'a,b\r\n""');
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv(toCsv([['']])), [['']]);
  assert.deepEqual(parseCsv(toCsv([['x'], [''], ['y']])), [['x'], [''], ['y']]);
});

test('a first cell that starts with U+FEFF is quoted, so it reads back whole; a byte-order mark before the text is still dropped', () => {
  const rows = [['﻿id', 'x']];
  assert.equal(toCsv(rows), '"﻿id",x');
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv(`﻿${toCsv(rows)}`), rows, 'a real mark in front of a quoted cell is dropped, the cell kept');
});

test('defusing covers String objects and any object that prints as a formula, not only primitive strings', () => {
  const evil = { toString: () => '=cmd|"/c calc"!A1' };
  const back = parseCsv(toCsv([[new String('=1+1'), evil, new String('@SUM(A1)'), -3, 3n, true]]))[0]!;
  assert.deepEqual(back, ["'=1+1", `'=cmd|"/c calc"!A1`, "'@SUM(A1)", '-3', '3', 'true']);
});

test('xlsx refuses text past the 32,767-character cell limit, or cuts it with a marker when told to', () => {
  const long = 'a'.repeat(XLSX_CELL_LIMIT + 1);
  assert.throws(() => toXlsx([['ok'], ['x', long]]), /cell B2 holds 32768 characters, more than the 32767/);
  assert.doesNotThrow(() => toXlsx([['a'.repeat(XLSX_CELL_LIMIT)]]), 'exactly at the limit is kept');
  assert.doesNotThrow(() => toXlsx([[`${'a'.repeat(XLSX_CELL_LIMIT)}\u0000`]]), 'forbidden characters are dropped before counting');
  const t = /<t xml:space="preserve">([^<]*)<\/t>/.exec(unzip(toXlsx([[`${'a'.repeat(XLSX_CELL_LIMIT - XLSX_TRUNCATED.length - 1)}😀${'tail'.repeat(10)}`]], 'S', { long: 'truncate' }))['xl/worksheets/sheet1.xml']!)![1]!;
  assert.ok(t.length <= XLSX_CELL_LIMIT);
  assert.ok(t.endsWith(XLSX_TRUNCATED));
  assert.doesNotMatch(t, /[\ud800-\udbff](?![\udc00-\udfff])/, 'never splits a character');
});

test('headers that repeat are told apart and reported, so no column overwrites another', () => {
  assert.deepEqual(distinctHeaders(['Name', 'Name', 'Name (2)', 'Name']), {
    headers: ['Name', 'Name (3)', 'Name (2)', 'Name (4)'],
    renamed: [{ column: 1, header: 'Name', as: 'Name (3)' }, { column: 3, header: 'Name', as: 'Name (4)' }],
  });
  const t = parseCsv('Email,Name,Name\nana@x.org,Ana,Smith\n');
  const m = suggestMapping(t[0]!, fields);
  assert.deepEqual(m, { Email: 'email', Name: 'name', 'Name (2)': undefined });
  const r = importRows(t, fields, m);
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana' }]);
  assert.deepEqual(r.renamed, [{ column: 2, header: 'Name', as: 'Name (2)' }]);
  assert.deepEqual(r.unmapped, ['Name (2)']);
  const bad = importRows(parseCsv('Email,Name,Name\n,Ana,Smith\n'), fields, m);
  assert.deepEqual(bad.quarantine[0]!.raw, { Email: '', Name: 'Ana', 'Name (2)': 'Smith' }, 'both values are kept in the raw row');
});

test('xlsx keeps negative zero as negative zero', async () => {
  const { xlsx } = await import('../docparse/index.ts');
  const v = xlsx(toXlsx([[-0, 0]]))[0]!.rows[0]!;
  assert.ok(Object.is(v[0], -0), 'minus zero reads back as minus zero');
  assert.ok(Object.is(v[1], 0), 'plus zero stays plus zero');
});
