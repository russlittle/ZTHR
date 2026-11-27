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
