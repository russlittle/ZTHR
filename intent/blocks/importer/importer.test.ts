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
