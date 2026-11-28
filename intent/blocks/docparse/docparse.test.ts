import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toXlsx, zip } from '../tabular/index.ts';
import { Refused, docx, unzip, xlsx } from './index.ts';

test('xlsx: reads back what the tabular block writes, and shared strings from other writers', () => {
  const book = toXlsx([['Name', 'Amount', 'Paid'], ['A & B', 12.5, true], ['Ö', -3, false]], 'Q4 & more');
  assert.deepEqual(xlsx(book), [{ name: 'Q4 & more', rows: [['Name', 'Amount', 'Paid'], ['A & B', 12.5, true], ['Ö', -3, false]] }]);
  const shared = zip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>hello</t></si><si><r><t>rich </t></r><r><t>text</t></r></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="3"><c r="B3"><v>7</v></c></row></sheetData></worksheet>' },
  ]);
  assert.deepEqual(xlsx(shared)[0]!.rows, [['hello', null, 'rich text'], [], [null, 7]]);
});

test('docx: paragraphs, headings, list items, tabs and entities', () => {
  const body = '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan &amp; scope</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">First </w:t></w:r><w:r><w:t>para</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p>' +
    '<w:p/>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>An item</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  assert.deepEqual(docx(zip([{ name: 'word/document.xml', data: body }])), [{ text: 'Plan & scope', heading: 1 }, { text: 'First para\ttabbed' }, { text: 'An item', list: true }]);
  assert.throws(() => docx(zip([{ name: 'x.xml', data: '' }])), /not a Word document/);
});

test('zip bombs, unsafe paths and junk are refused', () => {
  assert.throws(() => unzip(zip([{ name: 'big.xml', data: '0'.repeat(5_000_000) }])), Refused);
  assert.throws(() => unzip(zip([{ name: '../../etc/passwd', data: 'x' }])), /unsafe path/);
  assert.throws(() => unzip(zip([{ name: '/abs', data: 'x' }])), /unsafe path/);
  assert.throws(() => unzip(Buffer.from('not a zip at all, sorry')), /not a zip/);
  assert.throws(() => unzip(zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: 'x' }))), { maxEntries: 4 }), /too many entries/);
  const damaged = zip([{ name: 'a.txt', data: 'hello hello hello' }]);
  damaged.writeUInt32LE(99, damaged.length - 22 + 16 - 0);
  assert.throws(() => unzip(damaged), Refused);
});

const book = (sheet: string, extra: { name: string; data: string }[] = []) => zip([
  { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet sheetId="1" r:id="rId1" name="S"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>' },
  { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>` },
  ...extra,
]);

test('cell references beyond the Excel grid, and sheets that pad out to millions of cells, are refused', () => {
  assert.throws(() => xlsx(book('<row r="1"><c r="ZZZZZZZZ1"><v>1</v></c></row>')), Refused);
  assert.throws(() => xlsx(book('<row r="99999999"><c r="A99999999"><v>1</v></c></row>')), Refused);
  const wide = Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"/></row>`).join('');
  assert.throws(() => xlsx(book(wide), { maxCells: 1_000_000 }), /too many cells/);
});

test('cells without a reference, attributes in any order, and phonetic guides are read as Excel does', () => {
  const sst = { name: 'xl/sharedStrings.xml', data: '<sst><si><r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si></sst>' };
  const rows = xlsx(book('<row><c t="s"><v>0</v></c><c><v>2</v></c></row><row><c s="1" r="B2" t="b"><v>1</v></c></row>', [sst]));
  assert.deepEqual(rows, [{ name: 'S', rows: [['東京', 2], [null, true]] }]);
});

test('hostile or damaged zips are refused, never crash with another error', () => {
  assert.throws(() => unzip(Buffer.from('PK')), Refused);
  const lying = zip([{ name: 'a.txt', data: 'hello hello hello hello' }]);
  const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(5, cd + 24);
  assert.throws(() => unzip(lying), Refused);
  const far = zip([{ name: 'a.txt', data: 'x' }]);
  far.writeUInt32LE(0x7fffffff, far.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 42);
  assert.throws(() => unzip(far), Refused);
  assert.throws(() => docx(zip([{ name: 'word/document.xml', data: '<w:p><w:t>&#x110000;</w:t></w:p>' }])), Refused);
});

test('unclosed tags do not make parsing quadratic', () => {
  const junk = Array.from({ length: 40_000 }, (_, i) => `<w:p w:rsid="${((i * 2654435761) >>> 0).toString(16)}">`).join('');
  let t0 = performance.now();
  docx(zip([{ name: 'word/document.xml', data: `<w:document><w:p><w:t>a</w:t></w:p>${junk}` }]));
  assert.ok(performance.now() - t0 < 1_000, `docx ${Math.round(performance.now() - t0)} ms`);
  const cells = Array.from({ length: 40_000 }, (_, i) => `<c r="A${i + 1}" s="${i}">`).join('');
  t0 = performance.now();
  xlsx(book(`<row>${cells}</row>`));
  assert.ok(performance.now() - t0 < 1_000, `xlsx ${Math.round(performance.now() - t0)} ms`);
});

test('an entry whose bytes do not match its CRC-32 is refused, not returned corrupted', () => {
  const z = zip([{ name: 'a.txt', data: 'hello hello hello' }]);
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE((z.readUInt32LE(cd + 16) ^ 1) >>> 0, cd + 16);
  assert.throws(() => unzip(z), /CRC|damaged/);
});

test('docx: a text box inside a paragraph is read whole, as its own paragraphs, once', () => {
  const box = (text: string) => `<w:txbxContent><w:p><w:r><w:t>${text} one</w:t></w:r></w:p><w:p><w:r><w:t>${text} two</w:t></w:r></w:p></w:txbxContent>`;
  const body = '<w:document><w:body>' +
    '<w:p><w:r><w:t>Before </w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' + box('Box') + '</w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict>' + box('Box') + '</w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>after</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Next</w:t></w:r></w:p>' +
    '</w:body></w:document>';
  assert.deepEqual(docx(zip([{ name: 'word/document.xml', data: body }])), [{ text: 'Before after' }, { text: 'Box one' }, { text: 'Box two' }, { text: 'Next', heading: 2 }]);
});

test('a zip holding two entries with the same name is refused', () => {
  assert.throws(() => unzip(zip([{ name: 'word/document.xml', data: 'a' }, { name: 'word/document.xml', data: 'b' }])), /word\/document\.xml appears more than once/);
  assert.throws(() => unzip(zip([{ name: 'word/document.xml', data: 'a' }, { name: 'Word/Document.xml', data: 'b' }])), /appears more than once/, 'Office part names ignore case');
  assert.equal(unzip(zip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y' }])).size, 2);
});

test('nested paragraphs and fallbacks are scanned in linear time', () => {
  const n = 40_000;
  for (const xml of ['</w:p>'.repeat(n) + '<w:pPr>'.repeat(n), '<w:p>'.repeat(n) + '</w:p>'.repeat(n), '<mc:Fallback>'.repeat(n) + '</mc:Fallback>'.repeat(n), '<w:pPr>'.repeat(n) + '</w:p>'.repeat(n)]) {
    const started = performance.now();
    docx(zip([{ name: 'word/document.xml', data: `<w:document><w:body>${xml}</w:body></w:document>` }]), { maxRatio: 1e9 });
    assert.ok(performance.now() - started < 1500, `${xml.slice(0, 14)}… took too long`);
  }
});

test('unzip refuses Windows-absolute and backslash names', () => {
  for (const name of ['\\evil', '\\\\srv\\share\\x', 'C:\\Windows\\x', 'C:/x', 'c:x', 'a\\b']) {
    assert.throws(() => unzip(zip([{ name, data: 'x' }])), (e: Error) => e instanceof Refused && /unsafe path/.test(e.message) && /Windows/.test(e.message), name);
  }
  assert.deepEqual([...unzip(zip([{ name: 'a/b.xml', data: 'x' }])).keys()], ['a/b.xml']);
});
