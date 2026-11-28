import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toXlsx, zip, type Field } from '../tabular/index.ts';
import { Refused, decode, importFrom, read } from './index.ts';

const fields: Field[] = [
  { name: 'email', label: 'Email', aliases: ['e-mail', 'mail'], required: true, parse: (v) => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('not an email address');
    return v.toLowerCase();
  } },
  { name: 'name', label: 'Name', aliases: ['full name'], required: true },
  { name: 'age', label: 'Age', parse: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error('not a whole number');
    return n;
  } },
];

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const utf16 = (s: string, be: boolean) => {
  const b = Buffer.from(s, 'utf16le');
  if (be) b.swap16();
  return new Uint8Array(Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), b]));
};

test('CSV: columns are matched, good rows kept, and bad rows quarantined by row number with every problem', () => {
  const r = importFrom({ bytes: bytes('E-mail,Full name,Age,Shoe\nana@x.org,Ana,40,9\nnope,,old,\n,,,\nben@x.org,Ben,,10\n'), name: 'people.csv' }, fields);
  assert.equal(r.kind, 'csv');
  assert.equal(r.encoding, 'utf-8');
  assert.deepEqual(r.mapping, { 'E-mail': 'email', 'Full name': 'name', Age: 'age', Shoe: undefined });
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana', age: 40 }, { email: 'ben@x.org', name: 'Ben' }]);
  assert.deepEqual(r.quarantine, [{ at: 3, where: 'row 3', raw: { 'E-mail': 'nope', 'Full name': '', Age: 'old', Shoe: '' }, problems: ['Email: not an email address', 'Name is empty', 'Age: not a whole number'] }]);
  assert.deepEqual(r.unmapped, ['Shoe']);
  assert.equal(r.summary, 'Read a CSV file: 2 records ready, 1 row needs fixing (row 3).');
});

test('encodings: UTF-8 with and without BOM, UTF-16 LE and BE with BOM; anything else is refused', () => {
  const csv = 'Email\tName\nzoë@x.org\tZoë\n';
  assert.deepEqual(decode(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('a')])), { text: 'a', encoding: 'utf-8 with BOM' });
  for (const [b, enc] of [[bytes(csv), 'utf-8'], [new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(csv)]), 'utf-8 with BOM'], [utf16(csv, false), 'utf-16le'], [utf16(csv, true), 'utf-16be']] as const) {
    const r = importFrom({ bytes: b }, fields);
    assert.equal(r.kind, 'tsv', enc);
    assert.equal(r.encoding, enc);
    assert.deepEqual(r.good, [{ email: 'zoë@x.org', name: 'Zoë' }], enc);
  }
  assert.throws(() => read({ bytes: new Uint8Array([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0xe9, 0x74, 0xe9]) }), /not UTF-8 text\. Save it as CSV UTF-8/);
  assert.throws(() => read({ bytes: new Uint8Array(Buffer.from('Name\nAna\n', 'utf16le')) }), /UTF-16 without a byte-order mark/);
  assert.throws(() => read({ bytes: new Uint8Array([0xff, 0xfe, 0x41]) }), /half way through a character/);
});

test('separators: semicolons and tabs are detected, and the file name is a hint', () => {
  assert.deepEqual(read({ text: 'Email;Name\na@x.org;A\n' }).headers, ['Email', 'Name']);
  const t = read({ text: 'Email,Name\ta\nx,y\tb\n', name: 'x.tsv' });
  assert.equal(t.kind, 'tsv');
  assert.deepEqual(t.headers, ['Email,Name', 'a']);
  assert.throws(() => read({ text: 'a,b\n"open,2\n' }), /never closed/);
});

test('xlsx: the first sheet with cells is read, a named sheet can be chosen, and row numbers match the sheet', () => {
  const book = toXlsx([['Email', 'Name', 'Age'], ['ana@x.org', 'Ana', 40], ['bad', 'Ben', 3.5]], 'People');
  const r = importFrom({ bytes: book, name: 'people.xlsx' }, fields);
  assert.equal(r.kind, 'xlsx');
  assert.deepEqual(r.sheets, ['People']);
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana', age: 40 }]);
  assert.deepEqual(r.quarantine.map((q) => [q.where, q.problems]), [['row 3', ['Email: not an email address', 'Age: not a whole number']]]);
  assert.throws(() => read({ bytes: book, sheet: 'Other' }), /no sheet called "Other"\. Its sheets are People\./);
  const offset = zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Blank" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Email</t></is></c><c r="B3" t="inlineStr"><is><t>Name</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>' },
  ]);
  const t = read({ bytes: offset });
  assert.deepEqual([t.headers, t.rows, t.at], [['Email', 'Name'], [['x', '']], [4]]);
  assert.throws(() => read({ bytes: zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets></sheets></workbook>' }]) }), /Every sheet in this workbook is empty/);
});

const docxOf = (paras: string[]) => zip([{ name: 'word/document.xml', data: `<w:document><w:body>${paras.join('')}</w:body></w:document>` }]);
const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const tabbed = (...cells: string[]) => `<w:p><w:r>${cells.map((c) => `<w:t>${c}</w:t>`).join('<w:tab/>')}</w:r></w:p>`;

test('docx: tab-separated paragraphs are a table; other paragraphs are one row each, under their heading', () => {
  const t = read({ bytes: docxOf([tabbed('Email', 'Name'), tabbed('a@x.org', 'Ana'), tabbed('b@x.org', 'Ben')]) });
  assert.deepEqual([t.kind, t.headers, t.rows], ['docx', ['Email', 'Name'], [['a@x.org', 'Ana'], ['b@x.org', 'Ben']]]);
  const h = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Day one</w:t></w:r></w:p>';
  const notes = read({ bytes: docxOf([h, p('Arrive'), p('Lunch')]) });
  assert.deepEqual([notes.headers, notes.rows, notes.at, notes.unit], [['Text', 'Section'], [['Arrive', 'Day one'], ['Lunch', 'Day one']], [2, 3], 'paragraph']);
  assert.deepEqual(read({ bytes: docxOf([p('Only')]) }).headers, ['Text']);
});

test('JSON arrays and JSON lines: keys become columns, and items that are not records are quarantined by position', () => {
  const r = importFrom({ text: '[{"email":"a@x.org","name":"A","age":30},{"email":"b@x.org","name":"B","tags":["x"]},7]' }, fields);
  assert.equal(r.kind, 'json');
  assert.deepEqual(r.headers, ['email', 'name', 'age', 'tags']);
  assert.deepEqual(r.good, [{ email: 'a@x.org', name: 'A', age: 30 }, { email: 'b@x.org', name: 'B' }]);
  assert.deepEqual(r.quarantine.map((q) => [q.where, q.problems]), [['item 3', ['is not a record with named fields']]]);
  const l = importFrom({ bytes: bytes('{"email":"a@x.org","name":"A"}\n\n{broken\n{"email":"bad","name":"B"}\n"str"\n') }, fields);
  assert.equal(l.kind, 'jsonl');
  assert.deepEqual(l.good, [{ email: 'a@x.org', name: 'A' }]);
  assert.deepEqual(l.quarantine.map((q) => [q.where, q.problems]), [['line 3', ['is not valid JSON']], ['line 4', ['Email: not an email address']], ['line 5', ['is not a record with named fields']]]);
  assert.match(l.summary, /1 record ready, 3 lines need fixing \(line 3, line 4, line 5\)/);
  assert.throws(() => read({ text: '[1, 2' }), /not valid JSON/);
  assert.deepEqual(read({ text: '{"a":1}\n' }).rows, [['1']], 'a single object is one line of JSON lines');
  assert.throws(() => read({ text: '{"a":1' }), /None of the lines could be read; the first problem is line 1, which is not valid JSON\./);
});

test('vCard: folded lines, escapes, several addresses and phones, and a name built from N when FN is missing', () => {
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ana Okafor', 'N:Okafor;Ana;;;', 'EMAIL;TYPE=work:ana@x.org', 'item1.EMAIL:ana.home@x.org', 'TEL;TYPE=cell:+1 555 0100', 'ORG:Acme\\, Inc.;Research', 'NOTE:first line\\nsecond', ' continued', 'END:VCARD', 'BEGIN:VCARD', 'N:Nguyen;Ben', 'EMAIL:not-an-email', 'END:VCARD', ''].join('\r\n');
  const t = read({ bytes: bytes(vcf), name: 'contacts.vcf' });
  assert.equal(t.kind, 'vcard');
  assert.deepEqual(t.headers, ['Name', 'Given name', 'Family name', 'Email', 'Other emails', 'Phone', 'Organization', 'Note']);
  assert.deepEqual(t.rows[0], ['Ana Okafor', 'Ana', 'Okafor', 'ana@x.org', 'ana.home@x.org', '+1 555 0100', 'Acme, Inc., Research', 'first line\nsecondcontinued']);
  assert.deepEqual(t.rows[1]!.slice(0, 4), ['Ben Nguyen', 'Ben', 'Nguyen', 'not-an-email']);
  const r = importFrom({ text: vcf }, fields);
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana Okafor' }]);
  assert.deepEqual(r.quarantine.map((q) => [q.where, q.problems]), [['contact 2', ['Email: not an email address']]]);
  assert.throws(() => read({ text: 'BEGIN:VCARD\nFN:A\n' }), /no END:VCARD/);
});

test('iCalendar: events with UTC, local and all-day times; alarms and time zone blocks are not events', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Europe/London', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:1@x', 'SUMMARY:Board\\, quarterly', 'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', 'RRULE:FREQ=MONTHLY', 'BEGIN:VALARM', 'SUMMARY:alarm text', 'END:VALARM', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:2@x', 'SUMMARY:Lunch', 'DTSTART;TZID=Europe/London:20261202T120000', 'LOCATION:Café', 'STATUS:CONFIRMED', 'END:VEVENT', 'BEGIN:VEVENT', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261225', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  const t = read({ text: ics });
  assert.equal(t.kind, 'ical');
  assert.deepEqual(t.headers, ['Summary', 'Starts', 'Ends', 'Time zone', 'All day', 'Location', 'Repeats', 'Status', 'UID']);
  assert.deepEqual(t.rows, [
    ['Board, quarterly', '2026-12-01T09:00:00Z', '2026-12-01T10:00:00Z', 'UTC', '', '', 'FREQ=MONTHLY', '', '1@x'],
    ['Lunch', '2026-12-02T12:00:00', '', 'Europe/London', '', 'Café', '', 'confirmed', '2@x'],
    ['Holiday', '2026-12-25', '', '', 'yes', '', '', '', ''],
  ]);
  assert.deepEqual(t.at, [1, 2, 3]);
  assert.throws(() => read({ text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\n' }), /inside a VEVENT that is never closed/);
});

test('pasted tables and address lists go through magic paste; links and prose are refused with what to do', () => {
  const r = importFrom({ text: 'Name\tEmail\nAna\tana@x.org\nBen\tben@x\n', pasted: true }, fields);
  assert.equal(r.kind, 'pasted table');
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana' }]);
  assert.deepEqual(r.quarantine.map((q) => q.where), ['row 3']);
  const e = read({ text: 'ana@x.org, Ben <BEN@x.org>; ana@x.org', pasted: true });
  assert.deepEqual([e.kind, e.headers, e.rows, e.skipped], ['pasted emails', ['Email'], [['ana@x.org'], ['ben@x.org']], [{ at: 3, raw: 'Ben', problem: 'is not an email address' }]]);
  assert.throws(() => read({ text: 'https://example.com/sheet', pasted: true }), /That is a link, not data/);
  assert.throws(() => read({ text: 'hello there, how are you', pasted: true }), /not a table or a list of email addresses/);
  assert.throws(() => read({ text: '   ', pasted: true }), /Nothing was pasted/);
});

test('limits and refusals: size, rows, columns, empty input, header only, binary formats, other zips, unmapped required fields', () => {
  assert.throws(() => read({ bytes: bytes('a\n'.repeat(100)) }, { maxBytes: 50 }), /The file is 200 bytes; the limit is 50\. Split it/);
  assert.throws(() => read({ text: 'Email\n' + 'a@x.org\n'.repeat(11) }, { maxRows: 10 }), /There are 11 rows; the limit is 10\./);
  assert.throws(() => read({ text: Array.from({ length: 6 }, (_, i) => `c${i}`).join(',') + '\n1,2,3,4,5,6\n' }, { maxColumns: 5 }), /There are 6 columns; the limit is 5\./);
  assert.throws(() => read({}), /Nothing was given to import/);
  assert.throws(() => read({ bytes: new Uint8Array() }), /The file is empty/);
  assert.throws(() => read({ text: 'Email,Name\n' }), /header row but no rows under it/);
  assert.throws(() => read({ bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) }), /older Excel \(\.xls\)/);
  assert.throws(() => read({ bytes: bytes('%PDF-1.7 ...') }), /PDF files cannot be imported/);
  assert.throws(() => read({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) }), /This is an image/);
  assert.throws(() => read({ bytes: zip([{ name: 'readme.txt', data: 'hi' }]) }), /not a spreadsheet \(\.xlsx\) or a Word document/);
  assert.throws(() => read({ bytes: zip([{ name: '../evil', data: 'x' }]) }), /could not be opened safely: unsafe path/);
  assert.throws(() => importFrom({ text: 'Age\n3\n' }, fields), (e: unknown) => e instanceof Refused && e.message === 'No column is mapped to Email, Name. Choose which column holds it and try again.');
  assert.throws(() => importFrom({ text: 'A,B\n1,2\n' }, fields, { mapping: { A: 'email', B: 'shoe' } }), /names shoe, which is not a field/);
});

test('blank and repeated headers get usable names, and an explicit mapping is used as given', () => {
  const t = read({ text: 'Name,,Name\nA,x,B\n' });
  assert.deepEqual(t.headers, ['Name', 'Column 2', 'Name (2)']);
  const r = importFrom({ text: 'who,addr\nAna,ana@x.org\n' }, fields, { mapping: { who: 'name', addr: 'email' } });
  assert.deepEqual(r.good, [{ email: 'ana@x.org', name: 'Ana' }]);
  assert.equal(r.summary, 'Read a CSV file: 1 record ready.');
});

// ---------------------------------------------------------------------------------------------------------------
// Boundaries and edge cases: each case below states one thing a person relies on.
// ---------------------------------------------------------------------------------------------------------------

test('encodings: bytes that only look like the start of a byte-order mark are not treated as one', () => {
  const notText = (...b: number[]) => assert.throws(() => decode(new Uint8Array(b)), /not UTF-8 text/, b.map((x) => x.toString(16)).join(' '));
  // Two of the three UTF-8 BOM bytes in any combination are still invalid UTF-8, never a BOM.
  notText(0x41, 0x42, 0xbf);
  notText(0x41, 0xbb, 0xbf);
  notText(0xef, 0x41, 0xbf);
  notText(0xef, 0xbb, 0x41);
  // One of the two UTF-16 BOM bytes is not a UTF-16 BOM either.
  notText(0xff, 0x41, 0x42, 0x43);
  notText(0x41, 0xfe, 0x42, 0x43);
  notText(0xfe, 0x41, 0x42, 0x43);
  notText(0x41, 0xff, 0x42, 0x43);
});

test('encodings: UTF-16 text with an unpaired surrogate is refused with advice, not an internal error', () => {
  assert.throws(() => decode(new Uint8Array([0xff, 0xfe, 0x00, 0xd8])), (e: unknown) => e instanceof Refused && /UTF-16/.test(e.message));
  assert.throws(() => decode(new Uint8Array([0xfe, 0xff, 0xd8, 0x00])), (e: unknown) => e instanceof Refused && /UTF-16/.test(e.message));
});

test('binary formats: JPEG and GIF images are refused as images, and a zip signature of exactly four bytes is a zip', () => {
  assert.throws(() => read({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) }), /This is an image/);
  assert.throws(() => read({ bytes: bytes('GIF89a\u0001\u0000') }), /This is an image/);
  assert.throws(() => read({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }), /could not be opened safely/);
});

test('limits: a value exactly at the limit is accepted, one over is refused, and pasted text says so', () => {
  assert.equal(read({ text: 'a\n1\n' }, { maxBytes: 4 }).rows.length, 1);
  assert.throws(() => read({ text: 'a\n1\n' }, { maxBytes: 3 }), /The file is 4 bytes; the limit is 3\./);
  assert.throws(() => read({ text: 'a\n1\n', pasted: true }, { maxBytes: 3 }), /The pasted text is 4 bytes; the limit is 3\./);
  assert.equal(read({ text: 'a,b\n1,2\n' }, { maxColumns: 2 }).headers.length, 2);
  assert.equal(read({ text: 'a\n1\n2\n' }, { maxRows: 2 }).rows.length, 2);
});

test('empty input: empty bytes, blank text and pasted-nothing each say what is missing', () => {
  assert.throws(() => read({ bytes: new Uint8Array(), pasted: true }), /The file is empty\./);
  assert.throws(() => read({ text: '  \n ' }), /The file is empty\./);
  assert.throws(() => read({ text: '' }), /The file is empty\./);
});

test('separators: the first line decides, the file name extension is a strong hint, and ties go to comma', () => {
  const kindOf = (text: string, name?: string) => read({ text, ...(name ? { name } : {}) }).kind;
  // The first line only, with LF line endings: later lines do not outvote it.
  assert.deepEqual(read({ text: 'a;b\n1,2,3,4,5\n' }).headers, ['a', 'b']);
  // A single column that happens to contain a semicolon later on stays a single column.
  const single = read({ text: 'Name\nAna; Smith\n' });
  assert.deepEqual([single.kind, single.headers, single.rows], ['csv', ['Name'], [['Ana; Smith']]]);
  // Tabs beat fewer commas; semicolons beat tabs when there are more of them; a tab/semicolon tie goes to tabs.
  assert.equal(kindOf('a\tb\tc,d\n1\t2\t3,4\n'), 'tsv');
  assert.deepEqual(read({ text: 'a\tb;c;d\n1\t2;3;4\n' }).headers, ['a\tb', 'c', 'd']);
  assert.equal(kindOf('a\tb;c\n1\t2;3\n'), 'tsv');
  // A tie between semicolons and commas goes to comma, in auto-detection and for .csv files.
  assert.deepEqual(read({ text: 'a;b,c\n1;2,3\n' }).headers, ['a;b', 'c']);
  assert.deepEqual(read({ text: 'a;b,c\n1;2,3\n', name: 'x.csv' }).headers, ['a;b', 'c']);
  // .csv: semicolons win only when there are more of them, and tabs are not considered at all.
  assert.deepEqual(read({ text: 'a;b\n1;2\n', name: 'x.csv' }).headers, ['a', 'b']);
  assert.deepEqual([kindOf('a\tb\tc,d\n1\t2\t3,4\n', 'x.csv'), read({ text: 'a\tb\tc,d\n1\t2\t3,4\n', name: 'x.csv' }).headers], ['csv', ['a\tb\tc', 'd']]);
  // .tsv and .tab are tab-separated whatever the text looks like; only the last extension counts.
  assert.equal(kindOf('a,b,c\n1,2,3\n', 'x.tab'), 'tsv');
  assert.equal(kindOf('a,b,c\n1,2,3\n', 'X.TSV'), 'tsv');
  assert.equal(kindOf('a\tb\n1\t2\n', 'data.csv.txt'), 'tsv');
  // A name with no extension is no hint.
  assert.equal(kindOf('a,b\n1,2\n', 'people'), 'csv');
});

test('text: a leading byte-order mark character is dropped, leading blank space is ignored, and a BOM inside a cell stays', () => {
  assert.deepEqual(read({ text: '﻿Name,Email\nA,b\n' }).headers, ['Name', 'Email']);
  assert.deepEqual(read({ text: 'Name,Email\nA﻿B,c\n' }).rows, [['A﻿B', 'c']]);
  assert.equal(read({ text: '\n  [{"a":1}]' }).kind, 'json');
  assert.equal(read({ text: '\n\n {"a":1}\n' }).kind, 'jsonl');
  assert.equal(read({ text: '\n  BEGIN:VCARD\nFN:A\nEND:VCARD\n' }).kind, 'vcard');
});

test('text: BEGIN:VCARD and BEGIN:VCALENDAR only make a contacts or calendar file when they open the file', () => {
  const a = read({ text: 'Name,Note\nAna,see BEGIN:VCARD docs\n' });
  assert.deepEqual([a.kind, a.rows], ['csv', [['Ana', 'see BEGIN:VCARD docs']]]);
  const b = read({ text: 'Name,Note\nAna,see BEGIN:VCALENDAR docs\n' });
  assert.deepEqual([b.kind, b.rows], ['csv', [['Ana', 'see BEGIN:VCALENDAR docs']]]);
});

test('table positions: every kind of table reports where its rows were, counted the way its source counts', () => {
  const csv = read({ text: 'a,b\n1,2\n3,4\n' });
  assert.deepEqual([csv.at, csv.unit, csv.skipped], [[2, 3], 'row', []]);
  const pasted = read({ text: 'Name\tEmail\nAna\ta@x.org\nBen\tb@x.org\n', pasted: true });
  assert.deepEqual([pasted.kind, pasted.at, pasted.unit, pasted.skipped], ['pasted table', [2, 3], 'row', []]);
  const emails = read({ text: 'ana@x.org, Ben <BEN@x.org>; Cy; ana@x.org', pasted: true });
  assert.deepEqual([emails.at, emails.unit, emails.skipped.map((s) => [s.at, s.raw])], [[1, 2], 'item', [[3, 'Ben'], [4, 'Cy']]]);
  const json = read({ text: '[{"a":1},{"a":2}]' });
  assert.deepEqual([json.at, json.unit], [[1, 2], 'item']);
  const jl = read({ text: '{"a":1}\n\n{"a":2}\n' });
  assert.deepEqual([jl.at, jl.unit], [[1, 3], 'line']);
});

test('headers: surrounding spaces are removed, blank names are numbered, an all-blank header row is refused', () => {
  assert.deepEqual(read({ text: ' Name , Age \n1,2\n' }).headers, ['Name', 'Age']);
  assert.deepEqual(read({ text: 'Name,   ,Age\n1,2,3\n' }).headers, ['Name', 'Column 2', 'Age']);
  assert.throws(() => read({ text: ',\n1,2\n' }), /^.*No columns were found in the csv data\. The first row should name the columns\.$/);
  assert.throws(() => read({ text: '  ,   \n1,2\n' }), /No columns were found in the csv data\. The first row should name the columns\./);
});

test('JSON: null stays an empty cell, nested values are written as JSON, and a null item is quarantined by position', () => {
  const t = read({ text: '[{"a":null,"b":[1,2],"c":{"d":1},"e":5,"f":true},null]' });
  assert.deepEqual(t.rows, [['', '[1,2]', '{"d":1}', '5', 'true']]);
  assert.deepEqual(t.skipped, [{ at: 2, raw: '', problem: 'is not a record with named fields' }]);
  const q = importFrom({ text: '[7, {"email":"bad","name":"B"}, {"email":"c@x.org","name":"C"}, {"email":"worse","name":"D"}]' }, fields);
  assert.deepEqual(q.quarantine.map((x) => x.where), ['item 1', 'item 2', 'item 4']);
  assert.deepEqual(q.quarantine[0]!.raw, { email: '7' }, 'a skipped item is shown under the first column name');
});

test('JSON lines: a line of only spaces is blank, not a broken record', () => {
  const l = read({ text: '{"a":1}\n   \n{"a":2}\n' });
  assert.deepEqual([l.rows, l.at, l.skipped], [[['1'], ['2']], [1, 3], []]);
});

test('summary: wording for each kind of source, plural and singular, and the five-problem cut-off', () => {
  const ok = (input: Parameters<typeof importFrom>[0]) => importFrom(input, fields).summary;
  assert.equal(ok({ text: 'Email\tName\na@x.org\tA\nb@x.org\tB\n' }), 'Read a tab-separated file: all 2 records ready.');
  assert.equal(ok({ text: '[{"email":"a@x.org","name":"A"}]' }), 'Read a JSON list: 1 record ready.');
  assert.equal(ok({ text: '{"email":"a@x.org","name":"A"}\n{"email":"b@x.org","name":"B"}\n' }), 'Read a JSON lines file: all 2 records ready.');
  assert.equal(ok({ text: 'Name\tEmail\nAna\ta@x.org\n', pasted: true }), 'Read a pasted table: 1 record ready.');
  assert.equal(ok({ text: 'BEGIN:VCARD\nFN:A\nEMAIL:a@x.org\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEMAIL:b@x.org\nEND:VCARD\n' }), 'Read a contacts file: all 2 records ready.');
  assert.equal(ok({ bytes: docxOf([tabbed('Email', 'Name'), tabbed('a@x.org', 'Ana')]) }), 'Read a Word document: 1 record ready.');
  assert.equal(ok({ bytes: toXlsx([['Email', 'Name'], ['a@x.org', 'Ana'], ['b@x.org', 'Ben']]) }), 'Read a spreadsheet: all 2 records ready.');
  assert.equal(importFrom({ text: 'a@x.org, b@x.org', pasted: true }, [{ name: 'email', label: 'Email', required: true }]).summary, 'Read a pasted list of addresses: all 2 records ready.');
  const ics = importFrom({ text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Lunch\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:\nLOCATION:Room\nEND:VEVENT\nEND:VCALENDAR\n' }, [{ name: 'title', label: 'Summary', required: true }, { name: 'where', label: 'Location' }]);
  assert.equal(ics.summary, 'Read a calendar file: 1 record ready, 1 event needs fixing (event 2).');
  const rows = (n: number) => 'Email,Name\n' + Array.from({ length: n }, (_, i) => `bad${i},X`).join('\n') + '\n';
  assert.equal(importFrom({ text: rows(5) }, fields).summary, 'Read a CSV file: 0 records ready, 5 rows need fixing (row 2, row 3, row 4, row 5, row 6).');
  assert.equal(importFrom({ text: rows(6) }, fields).summary, 'Read a CSV file: 0 records ready, 6 rows need fixing (row 2, row 3, row 4, row 5, row 6, …).');
});

test('mapping: several unknown field names are all listed', () => {
  assert.throws(() => importFrom({ text: 'A,B\n1,2\n' }, fields, { mapping: { A: 'shoe', B: 'boot' } }), (e: unknown) => e instanceof Refused && e.message === 'The mapping names shoe, boot, which are not fields here.');
});

test('docx: headings are not table rows, a table needs two or more rows, and every row must have the same columns', () => {
  const h = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const withHeading = read({ bytes: docxOf([h('Contacts'), tabbed('Email', 'Name'), tabbed('a@x.org', 'Ana')]) });
  assert.deepEqual([withHeading.headers, withHeading.rows, withHeading.at, withHeading.unit, withHeading.skipped], [['Email', 'Name'], [['a@x.org', 'Ana']], [2], 'paragraph', []]);
  const two = read({ bytes: docxOf([tabbed('Email', 'Name'), tabbed('a@x.org', 'Ana')]) });
  assert.deepEqual([two.headers, two.rows], [['Email', 'Name'], [['a@x.org', 'Ana']]]);
  const one = read({ bytes: docxOf([tabbed('Email', 'Name')]) });
  assert.deepEqual([one.headers, one.rows, one.kind], [['Text'], [['Email\tName']], 'docx']);
  const ragged = read({ bytes: docxOf([tabbed('a', 'b'), tabbed('c', 'd'), p('e')]) });
  assert.deepEqual([ragged.headers, ragged.rows.length], [['Text'], 3]);
  const raggedLater = read({ bytes: docxOf([tabbed('a', 'b'), p('e'), tabbed('c', 'd')]) });
  assert.deepEqual(raggedLater.headers, ['Text']);
  assert.throws(() => read({ bytes: docxOf([h('Only a heading')]) }), /header row but no rows under it/);
  const intro = read({ bytes: docxOf([p('Intro'), h('  Day one  '), p('  Arrive  ')]) });
  assert.deepEqual([intro.kind, intro.headers, intro.rows, intro.at, intro.skipped], ['docx', ['Text', 'Section'], [['Intro', ''], ['Arrive', 'Day one']], [1, 3], []]);
  const spaced = (...cells: string[]) => `<w:p><w:r>${cells.map((c) => `<w:t xml:space="preserve">${c}</w:t>`).join('<w:tab/>')}</w:r></w:p>`;
  const padded = read({ bytes: docxOf([spaced(' Email ', ' Name '), spaced(' a@x.org ', ' Ana ')]) });
  assert.deepEqual([padded.headers, padded.rows], [['Email', 'Name'], [['a@x.org', 'Ana']]], 'spaces around table cells are not part of the value');
  const plain = read({ bytes: docxOf([p('  First  '), p('Second')]) });
  assert.deepEqual([plain.headers, plain.rows, plain.at, plain.skipped], [['Text'], [['First'], ['Second']], [1, 2], []]);
});

// An .xlsx workbook built by hand, so cells can be blank, missing or empty text.
const sheetXml = (rows: Record<string, string | null>[]) => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${Object.entries(r).map(([col, v]) => (v === null ? `<c r="${col}${i + 1}"/>` : `<c r="${col}${i + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
const bookOf = (sheets: [string, string][]) => zip([
  { name: 'xl/workbook.xml', data: `<workbook><sheets>${sheets.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
  { name: 'xl/_rels/workbook.xml.rels', data: `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
  ...sheets.map(([, xml], i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml })),
]);

test('xlsx: a named sheet is read in place of the first, and the sheet names are listed when it is missing', () => {
  const book = bookOf([['Alpha', sheetXml([{ A: 'a1' }, { A: 'a2' }])], ['Beta', sheetXml([{ A: 'b1' }, { A: 'b2' }])]]);
  assert.deepEqual([read({ bytes: book }).headers, read({ bytes: book }).sheets], [['a1'], ['Alpha', 'Beta']]);
  assert.deepEqual(read({ bytes: book, sheet: 'Beta' }).headers, ['b1']);
  assert.throws(() => read({ bytes: book, sheet: 'Gamma' }), (e: unknown) => e instanceof Refused && e.message === 'This workbook has no sheet called "Gamma". Its sheets are Alpha, Beta.');
});

test('xlsx: a sheet counts as empty when its cells are missing or hold empty text, and the first sheet with real content is read', () => {
  const book = bookOf([
    ['Nothing', sheetXml([{ A: null, B: null }])],
    ['Blank text', sheetXml([{ A: '', B: '' }])],
    ['Real', sheetXml([{ A: null, B: 'Email' }, { A: null, B: 'x' }])],
  ]);
  const t = read({ bytes: book });
  assert.deepEqual([t.headers, t.rows, t.at], [['Column 1', 'Email'], [['', 'x']], [2]]);
});

test('xlsx: a cell with something in it is enough to make a sheet non-empty, even when other cells in its row are empty', () => {
  const book = bookOf([['Gaps', sheetXml([{ A: 'Email', B: null }, { A: 'x', B: null }])]]);
  const t = read({ bytes: book });
  assert.deepEqual([t.headers, t.rows], [['Email', 'Column 2'], [['x', '']]]);
});

test('xlsx: leading and trailing blank rows are dropped, rows with some cells empty are kept, and gaps become empty cells', () => {
  const book = bookOf([['Data', sheetXml([
    { A: null, B: '' },
    { A: 'Email', B: 'Name', C: 'Age' },
    { A: 'a@x.org', B: '', C: '3' },
    { A: '', B: 'only name', C: null },
    { A: null, B: '' },
    { A: '', B: null, C: '' },
  ])]]);
  const t = read({ bytes: book });
  assert.deepEqual(t.headers, ['Email', 'Name', 'Age']);
  assert.deepEqual(t.rows, [['a@x.org', '', '3'], ['', 'only name', '']]);
  assert.deepEqual(t.at, [3, 4]);
  assert.deepEqual([t.kind, t.unit, t.skipped], ['xlsx', 'row', []]);
});

test('xlsx: a sheet the person names that has no cells is refused as having no columns', () => {
  const book = bookOf([['Real', sheetXml([{ A: 'x' }, { A: 'y' }])], ['Empty', '<worksheet><sheetData></sheetData></worksheet>']]);
  assert.throws(() => read({ bytes: book, sheet: 'Empty' }), /No columns were found in the xlsx data/);
  const blank = bookOf([['Blank', sheetXml([{ A: '', B: null }, { A: null }])]]);
  assert.throws(() => read({ bytes: blank, sheet: 'Blank' }), /No columns were found in the xlsx data/);
});

test('vCard: every property, escapes, extra emails and phones, only the first address, and lines that are not properties', () => {
  const vcf = [
    '  BEGIN:VCARD  ',
    'FN:  Dr. Ana Okafor',
    'N:Okafor;Ana;;;',
    'EMAIL:  a1@x.org',
    'EMAIL:a2@x.org',
    'EMAIL:a3@x.org',
    'TEL:  tel:+1 555 0100',
    'TEL:+1 555 0101',
    'TEL:0 tel:9',
    'ORG:Acme ; ;Research ',
    'TITLE:  Director',
    'ADR:;;1 Main St;Dayton;OH;45402;USA',
    'ADR:;;2 Other St;Xenia;OH;45385;USA',
    'BDAY:  1980-01-02',
    'TITLEX',
    'NAB',
    'BEGIN:X-AGENT',
    'END:X-AGENT',
    'X-KIND:vcard',
    'NOTE:a\\Nb\\nc\\;d\\,e\\\\f',
    'URL:http://x.org',
    'END:VCARD  ',
    'FN:Stray outside any card',
    'BEGIN:VCARD',
    'N:Nguyen;;;;',
    'END:VCARD',
    'BEGIN:VCARD',
    'N:Cher',
    'END:VCARD',
  ].join('\n');
  const t = read({ text: vcf });
  assert.deepEqual(t.headers, ['Name', 'Given name', 'Family name', 'Email', 'Other emails', 'Phone', 'Other phones', 'Organization', 'Title', 'Address', 'Birthday', 'Note']);
  assert.deepEqual(t.rows[0], ['Dr. Ana Okafor', 'Ana', 'Okafor', 'a1@x.org', 'a2@x.org, a3@x.org', '+1 555 0100', '+1 555 0101, 0 tel:9', 'Acme, Research', 'Director', '1 Main St, Dayton, OH, 45402, USA', '1980-01-02', 'a\nb\nc;d,e\\f']);
  assert.deepEqual(t.rows[1], ['Nguyen', '', 'Nguyen', '', '', '', '', '', '', '', '', '']);
  assert.deepEqual(t.rows[2], ['Cher', '', 'Cher', '', '', '', '', '', '', '', '', '']);
  assert.equal(t.rows.length, 3);
  assert.deepEqual([t.at, t.unit, t.skipped], [[1, 2, 3], 'contact', []]);
});

test('vCard: a property parameter value may contain a colon when it is quoted', () => {
  const t = read({ text: 'BEGIN:VCARD\nFN:A\nEMAIL;X-LABEL="a:b":x@y.org\nEND:VCARD\n' });
  assert.deepEqual(t.rows, [['A', 'x@y.org']]);
});

test('iCalendar: every property, parameter forms, odd date values, alarms inside an event, and the place an unclosed block is reported', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT  ',
    'UID:1@x',
    'BEGIN:VALARM',
    'END:VALARM',
    'SUMMARY:After alarm',
    'DESCRIPTION:Line one\\nLine two\\, and more',
    'DTSTART:20261202T120000Z',
    'DTEND:20261203',
    'ATTENDEE:mailto:z@x.org',
    'END:VEVENT  ',
    'BEGIN:VEVENT',
    'SUMMARY:Local',
    'DTSTART:20261202T120000',
    'DTEND:  20261202T130000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Spaced date',
    'DTSTART:  20261225',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Prefix junk',
    'DTSTART:X20261225',
    'DTEND:20261225T130000Zjunk',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Prefix junk 2',
    'DTSTART:X20261202T120000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Free text',
    'DTSTART;TZID=Europe/London:next tuesday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Free text no zone',
    'DTSTART:next week',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Bare parameter',
    'DTSTART;TZID:20261202T120000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Quoted zone',
    'DTSTART;TZID="Europe/Paris":20261202T120000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Inner quote',
    'DTSTART;TZID=x"y"z:20261202T120000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  const t = read({ text: ics });
  assert.equal(t.kind, 'ical');
  assert.deepEqual(t.headers, ['Summary', 'Starts', 'Ends', 'Time zone', 'All day', 'Description', 'UID']);
  const byName = Object.fromEntries(t.rows.map((r) => [r[0]!, r]));
  assert.deepEqual(byName['After alarm'], ['After alarm', '2026-12-02T12:00:00Z', '2026-12-03', 'UTC', '', 'Line one\nLine two, and more', '1@x']);
  assert.deepEqual(byName['Local'], ['Local', '2026-12-02T12:00:00', '2026-12-02T13:00:00', '', '', '', '']);
  assert.deepEqual(byName['Spaced date'], ['Spaced date', '2026-12-25', '', '', 'yes', '', '']);
  assert.deepEqual(byName['Prefix junk'], ['Prefix junk', 'X20261225', '20261225T130000Zjunk', '', '', '', '']);
  assert.deepEqual(byName['Prefix junk 2'], ['Prefix junk 2', 'X20261202T120000Z', '', '', '', '', '']);
  assert.deepEqual(byName['Free text'], ['Free text', 'next tuesday', '', 'Europe/London', '', '', '']);
  assert.deepEqual(byName['Free text no zone'], ['Free text no zone', 'next week', '', '', '', '', '']);
  assert.deepEqual(byName['Bare parameter'], ['Bare parameter', '2026-12-02T12:00:00', '', '', '', '', '']);
  assert.deepEqual(byName['Quoted zone'], ['Quoted zone', '2026-12-02T12:00:00', '', 'Europe/Paris', '', '', '']);
  assert.deepEqual(byName['Inner quote'], ['Inner quote', '2026-12-02T12:00:00', '', 'x"y"z', '', '', '']);
  assert.deepEqual([t.unit, t.skipped, t.at], ['event', [], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  assert.throws(() => read({ text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nBEGIN:VALARM\n' }), /inside a VALARM that is never closed/);
});

test('iCalendar: a property line with no colon is not a property', () => {
  const t = read({ text: 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Real\nUIDX\nLOCATIONX\nEND:VEVENT\nEND:VCALENDAR\n' });
  assert.deepEqual([t.headers, t.rows], [['Summary'], [['Real']]]);
});
