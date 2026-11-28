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

test('CSV reading: an empty text has no rows; a quote inside a bare field is just a character; CR, LF and CRLF each end one row', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('ab"c,d'), [['ab"c', 'd']]);
  assert.deepEqual(parseCsv('a\rb'), [['a'], ['b']]);
  assert.deepEqual(parseCsv('a\r\nb'), [['a'], ['b']]);
  assert.deepEqual(parseCsv('a\n\nb'), [['a'], [''], ['b']], 'a blank line is a row of one empty cell');
  assert.deepEqual(parseCsv('a\r\rb'), [['a'], [''], ['b']]);
  assert.deepEqual(parseCsv('a\rb\rc'), [['a'], ['b'], ['c']], 'a CR not followed by LF does not swallow the next character');
  assert.deepEqual(parseCsv('"ab"'), [['ab']], 'a quoted last field with no newline after it is kept');
  assert.deepEqual(parseCsv('x,"ab"'), [['x', 'ab']]);
});

test('CSV writing: only text that could run as a formula is defused, and only at its start', () => {
  assert.equal(toCsv([['a=b', 'x+1', 'k-2', 'me@x', 'tab\there']]), 'a=b,x+1,k-2,me@x,tab\there');
  for (const lead of ['=', '+', '-', '@', '\t']) assert.equal(toCsv([[`${lead}x`]]), `'${lead}x`, JSON.stringify(lead));
  assert.equal(toCsv([['\rx']]), `"'\rx"`);
  assert.equal(toCsv([['=1', '-2']], { defuse: false }), '=1,-2');
  assert.equal(toCsv([['=1', '-2']], { defuse: true }), "'=1,'-2");
  assert.equal(toCsv([[-3n, 4n, true, false, new Date('2026-01-02T03:04:05Z')]]), '-3,4,true,false,2026-01-02T03:04:05.000Z');
  assert.equal(toCsv([['a﻿b']]), 'a﻿b', 'a U+FEFF that is not first needs no quotes');
});

test('CSV writing: empty cells and one-cell rows', () => {
  assert.equal(toCsv([['a', null, undefined, 'b']]), 'a,,,b');
  assert.equal(toCsv([['', 'x']]), ',x', 'an empty first cell in a longer row is not a one-cell row');
  assert.equal(toCsv([[null]]), '""');
  assert.equal(toCsv([[undefined]]), '""');
  assert.equal(toCsv([[new String('')]]), '""');
  assert.equal(toCsv([['x'], [null], ['y']]), 'x\r\n""\r\ny');
  assert.equal(toCsv([[0]]), '0');
});

test('an empty table imports as nothing', () => {
  assert.deepEqual(importRows([], fields, {}), { good: [], quarantine: [], unmapped: [], renamed: [] });
  assert.deepEqual(importRows([['Email', 'Full name']], fields, { Email: 'email', 'Full name': 'name' }), { good: [], quarantine: [], unmapped: [], renamed: [] });
});

test('a mapping is suggested tier by tier: name, then label, then alias, then a name contained in the header or the header in a name', () => {
  const f = [
    { name: 'id', label: 'Identifier' },
    { name: 'qq', label: 'Account number', aliases: ['acct'] },
    { name: 'phonenumber', label: 'Phone' },
    { name: 'email', label: 'E-mail' },
    { name: 'userid', label: 'User' },
  ];
  const s = (h: string) => suggestMapping([h], f)[h];
  assert.equal(s('ID'), 'id', 'by name, even when too short to be matched by containment');
  assert.equal(s('Account Number'), 'qq', 'by label alone');
  assert.equal(s('account-number'), 'qq', 'punctuation and case are ignored');
  assert.equal(s('Acct'), 'qq', 'by alias alone');
  assert.equal(s('ACCT.'), 'qq');
  assert.equal(s('Customer email'), 'email', 'the header contains the name');
  assert.equal(s('phone'), 'phonenumber', 'the name contains the header');
  assert.equal(s('zzz'), undefined, 'nothing matches: a field with aliases is not matched by chance');
  assert.equal(s('Stryker was here'), undefined, 'a field with no aliases has none to match');
  assert.equal(s('is'), undefined, 'a two-letter header is never matched by containment ("userid" contains "id")');
  assert.equal(s('d'), undefined);
  assert.equal(s('mail'), 'email', 'a three-letter header can be contained');
  assert.equal(s('mai'), 'email');
  assert.equal(suggestMapping(['Postal'], [{ name: 'zip', label: 'Postal' }]).Postal, 'zip');
  assert.equal(suggestMapping(['PostalCode'], [{ name: 'zip', label: 'Postal code' }]).PostalCode, 'zip', 'a label with a space matches the header without one');
  assert.equal(suggestMapping(['Zip Code'], [{ name: 'zip', label: 'Z' }, { name: 'zip2', label: 'Zip code' }])['Zip Code'], 'zip2', 'an exact label beats a field whose name is merely contained, even if listed later');
});

test('a two-letter header is not matched by containment, in either direction', () => {
  assert.equal(suggestMapping(['id'], [{ name: 'userid', label: 'User' }]).id, undefined, 'the name contains the header');
  assert.equal(suggestMapping(['userid'], [{ name: 'id', label: 'Key' }]).userid, 'id', 'while a longer header that contains a short name is matched');
  assert.equal(suggestMapping(['ab'], [{ name: 'xabx', label: 'Key' }]).ab, undefined);
});

test('exact matches beat contained ones, and a field is given to only one header', () => {
  const f = [{ name: 'name', label: 'Name' }, { name: 'username', label: 'User name' }];
  assert.deepEqual(suggestMapping(['Username', 'Name'], f), { Username: 'username', Name: 'name' });
  assert.deepEqual(suggestMapping(['Name', 'Name'], [{ name: 'name', label: 'Name' }]), { Name: 'name', 'Name (2)': undefined });
});

test('imported values are trimmed, short rows are padded in the raw copy, and extra or missing cells are reported', () => {
  const f = [{ name: 'a', label: 'A', required: true }, { name: 'b', label: 'B' }, { name: 'c', label: 'C' }];
  const m = { A: 'a', B: 'b', C: 'c' };
  const r = importRows([['A', 'B', 'C'], ['  x ', ' y\t', ''], ['p'], ['p', 'q', 'r', 's'], ['  ', '\t', ' ']], f, m);
  assert.deepEqual(r.good, [{ a: 'x', b: 'y' }]);
  assert.deepEqual(r.quarantine, [
    { row: 3, raw: { A: 'p', B: '', C: '' }, problems: ['has 1 cells, the header has 3'] },
    { row: 4, raw: { A: 'p', B: 'q', C: 'r' }, problems: ['has 4 cells, the header has 3'] },
  ]);
  assert.deepEqual(r.good.map((g) => Object.keys(g)), [['a', 'b']]);
});

test('a field with no column mapped to it is empty, even when a column is named "undefined"', () => {
  const f = [{ name: 'a', label: 'A', required: true }, { name: 'b', label: 'B' }];
  const r = importRows([['A', 'undefined'], ['x', '5']], f, { A: 'a' });
  assert.deepEqual(r.good, [{ a: 'x' }]);
  assert.deepEqual(r.unmapped, ['undefined']);
});

test('imported records and mappings are plain, writable, configurable data', () => {
  const r = importRows([['Email', 'Full name']], [{ name: 'email', label: 'Email', required: true }, { name: 'name', label: 'Full name' }], { Email: 'email', 'Full name': 'name' });
  assert.deepEqual(r.good, []);
  const g = importRows([['Email'], ['a@x.org']], [{ name: 'email', label: 'Email', required: true }], { Email: 'email' }).good[0]!;
  assert.deepEqual(Object.getOwnPropertyDescriptor(g, 'email'), { value: 'a@x.org', writable: true, enumerable: true, configurable: true });
  const m = suggestMapping(['Email'], [{ name: 'email', label: 'Email' }]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(m, 'Email'), { value: 'email', writable: true, enumerable: true, configurable: true });
  const d = dedupe([{ id: '1', v: 'a' }, { id: '1', v: 'b' }], (x) => x.id).rows[0]!;
  assert.deepEqual(Object.getOwnPropertyDescriptor(d, 'v'), { value: 'a', writable: true, enumerable: true, configurable: true });
});

test('merge rules: first, last, longest, nonEmpty (the default) and a function', () => {
  const rows = [{ k: '1', v: '' }, { k: '1', v: 'ab' }, { k: '1', v: 'abc' }, { k: '1', v: 'xy' }];
  const by = (rule?: 'first' | 'last' | 'longest' | 'nonEmpty' | ((v: unknown[]) => unknown)) => dedupe(rows, (r) => r.k, rule ? { v: rule } : {}).rows[0]!.v;
  assert.equal(by(), 'ab', 'the default keeps the first value that is not empty');
  assert.equal(by('nonEmpty'), 'ab');
  assert.equal(by('first'), '', 'first is the first value, empty or not');
  assert.equal(by('last'), 'xy');
  assert.equal(by('longest'), 'abc');
  assert.deepEqual(by((vals) => vals), ['', 'ab', 'abc', 'xy'], 'a function is given every value, in order, and what it returns is kept');
  assert.equal(dedupe([{ k: '1', v: 'a' }, { k: '1', v: 'b' }, { k: '1', v: 'c' }], (r) => r.k, { v: 'last' }).rows[0]!.v, 'c', 'the last of three, not the second');
  assert.equal(dedupe([{ k: '1', v: 'a' }, { k: '1', v: 'b' }, { k: '1', v: 'c' }], (r) => r.k, { v: 'first' }).rows[0]!.v, 'a');
});

test('merging treats undefined, null and empty text alike as empty, and keeps the first value when all are', () => {
  const pick = (vals: unknown[], rule?: 'first' | 'last' | 'longest' | 'nonEmpty') => {
    const rows = vals.map((v) => ({ k: '1', v }));
    return dedupe(rows, (r) => r.k, rule ? { v: rule } : {}).rows[0]!.v;
  };
  assert.equal(pick([null, 'x']), 'x');
  assert.equal(pick(['', 'x']), 'x');
  assert.equal(pick([undefined, 'x']), 'x');
  assert.equal(pick([undefined, 'x'], 'longest'), 'x');
  assert.equal(pick([null, 'x'], 'longest'), 'x');
  assert.equal(pick([undefined, ''], 'nonEmpty'), '', 'all empty: the first value that is not undefined');
  assert.equal(pick([undefined, ''], 'longest'), '');
  assert.equal(pick([null, ''], 'nonEmpty'), null);
  assert.equal(pick([undefined, null]), null);
  assert.equal(pick([undefined, null], 'first'), undefined, 'first and last are the values as they stand');
  assert.equal(pick([null, undefined], 'last'), undefined);
  assert.equal(pick([null, undefined], 'first'), null);
  const members = dedupe([{ k: '1' }, { k: '1', v: '' }] as Record<string, unknown>[], (r) => String(r.k)).rows[0]!;
  assert.equal(members.v, '', 'a field only some rows have is kept as the empty value they gave');
});

test('JSON lines: one object per line, and nothing at all for no rows', () => {
  assert.equal(toJsonLines([]), '');
  assert.equal(toJsonLines([{ a: 1 }]), '{"a":1}\n');
});

const sheetXml = (x: Buffer) => unzip(x)['xl/worksheets/sheet1.xml']!;

test('a worksheet is exactly its rows and cells: numbers, booleans, text, blanks, a bold first row', () => {
  const x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  assert.equal(
    sheetXml(toXlsx([['n', 1, true], ['t', 2.5, false, null, 'z'], [NaN, Infinity, -Infinity]])),
    `${x}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      '<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">n</t></is></c><c r="B1" s="1"><v>1</v></c><c r="C1" t="b" s="1"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">t</t></is></c><c r="B2"><v>2.5</v></c><c r="C2" t="b"><v>0</v></c><c r="E2" t="inlineStr"><is><t xml:space="preserve">z</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t xml:space="preserve">NaN</t></is></c><c r="B3" t="inlineStr"><is><t xml:space="preserve">Infinity</t></is></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">-Infinity</t></is></c></row>' +
      '</sheetData></worksheet>',
  );
});

test('a workbook has the six parts of an .xlsx, each a well-formed part of the right kind', () => {
  const e = unzip(toXlsx([['a']], 'Data "2026"'));
  assert.deepEqual(Object.keys(e), ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  for (const [name, text] of Object.entries(e)) assert.ok(text.startsWith(head), `${name} starts with the XML declaration`);
  assert.match(e['[Content_Types].xml']!, /^.{55}<Types xmlns="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/content-types"><Default Extension="rels" ContentType="application\/vnd\.openxmlformats-package\.relationships\+xml"\/><Default Extension="xml" ContentType="application\/xml"\/><Override PartName="\/xl\/workbook\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml"\/><Override PartName="\/xl\/worksheets\/sheet1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.worksheet\+xml"\/><Override PartName="\/xl\/styles\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.styles\+xml"\/><\/Types>$/);
  assert.match(e['_rels/.rels']!, /<Relationships xmlns="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/relationships"><Relationship Id="rId1" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/officeDocument" Target="xl\/workbook\.xml"\/><\/Relationships>$/);
  assert.match(e['xl/workbook.xml']!, /<workbook xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main" xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"><sheets><sheet name="Data &quot;2026&quot;" sheetId="1" r:id="rId1"\/><\/sheets><\/workbook>$/);
  assert.match(e['xl/_rels/workbook.xml.rels']!, /<Relationship Id="rId1" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/worksheet" Target="worksheets\/sheet1\.xml"\/><Relationship Id="rId2" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/styles" Target="styles\.xml"\/><\/Relationships>$/);
  assert.match(e['xl/styles.xml']!, /<styleSheet xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"><fonts count="2">.*<b\/>.*<\/fonts>.*<cellXfs count="2">.*applyFont="1"\/><\/cellXfs>.*<\/styleSheet>$/);
  assert.equal(/<sheet name="([^"]*)"/.exec(unzip(toXlsx([['a']]))['xl/workbook.xml']!)![1], 'Sheet1', 'the default sheet name');
});

test('column names run A to Z, AA to ZZ, AAA and on', () => {
  const refs = (n: number) => [...sheetXml(toXlsx([Array.from({ length: n }, (_, i) => i)])).matchAll(/<c r="([A-Z]+)1"/g)].map((m) => m[1]!);
  const r = refs(705);
  assert.deepEqual([r[0], r[25], r[26], r[27], r[51], r[52], r[53], r[77], r[701], r[702], r[703], r[704]], ['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'BB', 'BZ', 'ZZ', 'AAA', 'AAB', 'AAC']);
  assert.equal(new Set(r).size, 705, 'no two columns share a name');
});

test('a row number in a cell reference is the row, counted from 1', () => {
  assert.deepEqual([...sheetXml(toXlsx([['a'], ['b'], ['c']])).matchAll(/<c r="(A\d+)"/g)].map((m) => m[1]), ['A1', 'A2', 'A3']);
  assert.deepEqual([...sheetXml(toXlsx([['a'], ['b']])).matchAll(/<row r="(\d+)"/g)].map((m) => m[1]), ['1', '2']);
});

test('XML-forbidden characters and unpaired surrogates are dropped from cell text, and pairs are kept', () => {
  const text = (s: string) => /<t xml:space="preserve">([^<]*)<\/t>/.exec(sheetXml(toXlsx([[s]])))![1]!;
  assert.equal(text('a\ud83dX'), 'aX', 'a high surrogate with nothing after it');
  assert.equal(text('a\ude00X'), 'aX', 'a low surrogate with nothing before it');
  assert.equal(text('a\ud83d'), 'a', 'a high surrogate at the end');
  assert.equal(text('\ude00a'), 'a', 'a low surrogate at the start');
  assert.equal(text('a😀b'), 'a😀b', 'a pair stays whole');
  assert.equal(text('😀'), '😀');
  assert.equal(text('a\ud83d\ud83dX'), 'aX');
  assert.equal(text('x\u0000\u0008\u000b\u000c\u000e\u001fy\u0009\u000a\u000d'), 'xy\u0009\u000a\u000d', 'tab, line feed and carriage return are allowed');
  assert.equal(text('a￾b￿c'), 'abc');
  assert.equal(text('q"r'), 'q&quot;r', 'a quote is escaped');
});

test('a sheet name: leading and trailing apostrophes and spaces go, at most 31 units are kept, and a cut never ends in a space', () => {
  const name = (s: string) => /<sheet name="([^"]*)"/.exec(unzip(toXlsx([['a']], s))['xl/workbook.xml']!)![1];
  assert.equal(name("''  a"), 'a');
  assert.equal(name("a  ''"), 'a');
  assert.equal(name('a'.repeat(31)), 'a'.repeat(31), '31 units fit');
  assert.equal(name('a'.repeat(32)), 'a'.repeat(31));
  assert.equal(name(`${'a'.repeat(29)}   bbb`), 'a'.repeat(29), 'a cut that lands among spaces drops them all');
  assert.equal(name(`${'a'.repeat(29)}''  bbb`), 'a'.repeat(29));
});

test('text cut to fit a cell is exactly the limit long, ends with the marker, and keeps a pair that fits', () => {
  assert.equal(XLSX_TRUNCATED, '…[truncated]');
  const cut = (s: string) => /<t xml:space="preserve">([^<]*)<\/t>/.exec(sheetXml(toXlsx([[s]], 'S', { long: 'truncate' })))![1]!;
  const room = XLSX_CELL_LIMIT - XLSX_TRUNCATED.length;
  const plain = cut('a'.repeat(XLSX_CELL_LIMIT + 50));
  assert.equal(plain, `${'a'.repeat(room)}${XLSX_TRUNCATED}`);
  assert.equal(plain.length, XLSX_CELL_LIMIT);
  assert.equal(cut(`${'a'.repeat(room - 2)}😀${'z'.repeat(50)}`), `${'a'.repeat(room - 2)}😀${XLSX_TRUNCATED}`, 'a pair that ends exactly at the cut is kept whole');
  assert.equal(cut(`${'a'.repeat(room + 1)}😀${'z'.repeat(50)}`), `${'a'.repeat(room)}${XLSX_TRUNCATED}`, 'a pair after the cut does not cost a character');
  assert.equal(cut(`${'a'.repeat(room - 1)}${'z'.repeat(50)}`), `${'a'.repeat(room - 1)}${XLSX_TRUNCATED}`, 'a character above the surrogate range is not mistaken for half a pair');
  assert.equal(cut(`${'a'.repeat(room - 1)}😀${'z'.repeat(50)}`).length, XLSX_CELL_LIMIT - 1, 'a pair split by the cut is dropped, leaving the text one short');
});
