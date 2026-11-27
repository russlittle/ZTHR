import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { dedupe, importRows, parseCsv, suggestMapping, toCsv, toJsonLines, toXlsx, zip } from './index.ts';

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
