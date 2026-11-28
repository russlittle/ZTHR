import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
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

// ---------------------------------------------------------------- mutation night shift: zips built by hand, limits at their edges, and the wording of every refusal

interface RawEntry {
  name: string;
  data?: string;
  method?: number;
  localExtra?: number;
  centralExtra?: number;
  comment?: number;
  crc?: number;
  csize?: number;
  usize?: number;
  localSig?: number;
  centralSig?: number;
}

/** A zip written byte by byte, so a test can lie about any field the directory carries. */
function rawZip(entries: RawEntry[], o: { eocdComment?: Buffer; cdOffset?: (at: { cd: number; eocd: number }) => number; localOffset?: (at: { eocd: number }) => number } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '');
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const lx = Buffer.alloc(e.localExtra ?? 0, 0x20);
    const crc = e.crc ?? crc32(raw);
    const csize = e.csize ?? body.length;
    const usize = e.usize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(e.localSig ?? 0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(lx.length, 28);
    parts.push(local, name, lx, body);
    const cx = Buffer.alloc(e.centralExtra ?? 0, 0x20);
    const cm = Buffer.alloc(e.comment ?? 0, 0x20);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(e.centralSig ?? 0x02014b50, 0);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(csize, 20);
    c.writeUInt32LE(usize, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(cx.length, 30);
    c.writeUInt16LE(cm.length, 32);
    c.writeUInt32LE(o.localOffset ? o.localOffset({ eocd: -1 }) : offset, 42);
    central.push(c, name, cx, cm);
    offset += 30 + name.length + lx.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = offset + cd.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(o.cdOffset ? o.cdOffset({ cd: offset, eocd }) : offset, 16);
  const comment = o.eocdComment ?? Buffer.alloc(0);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, end, comment]);
}

test('a stored entry, with extra fields and comments in both headers, is read back whole beside the entry after it', () => {
  const z = rawZip([{ name: 'first.txt', data: 'stored bytes', localExtra: 7, centralExtra: 5, comment: 3 }, { name: 'second.txt', data: 'and more', method: 8, localExtra: 2 }, { name: 'third.txt', data: 'last', localExtra: 4, centralExtra: 1 }]);
  const files = unzip(z);
  assert.deepEqual([...files.keys()], ['first.txt', 'second.txt', 'third.txt']);
  assert.equal(files.get('first.txt')!.toString(), 'stored bytes');
  assert.equal(files.get('second.txt')!.toString(), 'and more');
  assert.equal(files.get('third.txt')!.toString(), 'last');
});

test('folder entries are skipped, whatever they declare', () => {
  const files = unzip(rawZip([{ name: 'word/', usize: 0xffffffff }, { name: 'a.txt', data: 'x' }]));
  assert.deepEqual([...files.keys()], ['a.txt']);
});

test('an empty zip, and a zip with the biggest comment a zip may carry, are found; one entry more than allowed is not', () => {
  assert.equal(unzip(rawZip([])).size, 0);
  const z = rawZip([{ name: 'a.txt', data: 'hello' }], { eocdComment: Buffer.alloc(65_535, 0x20) });
  assert.equal(unzip(z).get('a.txt')!.toString(), 'hello');
  assert.throws(() => unzip(Buffer.concat([z, Buffer.from([0x20])])), /not a zip file/, 'the end record is looked for in the last 64 KiB and no further back');
  const four = rawZip(Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  assert.equal(unzip(four, { maxEntries: 4 }).size, 4);
  assert.throws(() => unzip(four, { maxEntries: 3 }), /too many entries \(4\)/);
  assert.throws(() => unzip(Buffer.from('PK')), /not a zip file/);
  assert.throws(() => unzip(Buffer.alloc(21)), /not a zip file/);
  assert.throws(() => unzip(Buffer.alloc(40)), /not a zip file/);
});

test('a damaged directory is refused in its own words, wherever the damage is', () => {
  assert.throws(() => unzip(rawZip([{ name: 'a', data: 'x', centralSig: 0x12345678 }])), /the zip directory is damaged/);
  assert.throws(() => unzip(rawZip([{ name: 'a', data: 'x' }], { cdOffset: ({ eocd }) => eocd + 20 })), /the zip directory is damaged/);
  const z = rawZip([{ name: 'a', data: 'x' }]);
  z.writeUInt16LE(2, z.length - 22 + 10);
  assert.throws(() => unzip(z), /the zip directory is damaged/, 'two entries are promised and one is there');
  assert.throws(() => unzip(rawZip([{ name: 'a', data: 'x', localSig: 0x12345678 }])), /the zip entries are damaged/);
  assert.throws(() => unzip(rawZip([{ name: 'a', data: 'x' }], { localOffset: () => 0x7fffffff })), /the zip entries are damaged/);
});

test('a directory or an entry that sits in the last bytes of the file is read as far as it goes, not refused for being last', () => {
  // The directory entry (46 bytes) lies in the zip comment, ending exactly at the end of the file.
  const base = rawZip([{ name: 'a', data: 'hello' }]);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  const hidden = Buffer.concat([base.subarray(0, base.length), header]);
  const end = hidden.length - 46 - 22;
  hidden.writeUInt16LE(1, end + 10);
  hidden.writeUInt32LE(end + 22, end + 16);
  hidden.writeUInt16LE(46, end + 20);
  assert.deepEqual([...unzip(hidden).entries()].map(([k, v]) => [k, v.length]), [['', 0]]);
  // The local header of an empty entry (30 bytes) lies in the comment too, ending exactly at the end of the file.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const lastLocal = rawZip([{ name: 'e' }], { eocdComment: local, localOffset: () => 0 });
  const at = lastLocal.length - 30;
  lastLocal.writeUInt32LE(at, lastLocal.length - 30 - 22 - 1 - 46 + 42);
  assert.deepEqual([...unzip(lastLocal).entries()].map(([k, v]) => [k, v.length]), [['e', 0]]);
  // The local header is cut short by the end of the file.
  const cut = rawZip([{ name: 'e' }], { eocdComment: local.subarray(0, 4), localOffset: () => 0 });
  cut.writeUInt32LE(cut.length - 4, cut.length - 4 - 22 - 1 - 46 + 42);
  assert.throws(() => unzip(cut), /the zip entries are damaged/);
});

test('the limits are exact: total size, expansion ratio, and the words of each refusal', () => {
  const two = rawZip([{ name: 'a', data: '123456' }, { name: 'b', data: '123456' }]);
  assert.equal(unzip(two, { maxTotalBytes: 12 }).size, 2);
  assert.throws(() => unzip(two, { maxTotalBytes: 11 }), /the contents are too large/);
  assert.throws(() => unzip(rawZip([{ name: 'big', data: 'x', usize: 201 * 1024 * 1024 }])), /the contents are too large/, 'the default ceiling is 200 MB');
  assert.equal(unzip(two, { maxRatio: 1 }).size, 2, 'a stored entry expands by exactly 1');
  assert.throws(() => unzip(rawZip([{ name: 'a', data: 'x', usize: 3 }]), { maxRatio: 2 }), /a expands too much to be a real document/);
  assert.throws(() => unzip(rawZip([{ name: 'bomb.xml', data: '0'.repeat(1_000_000), method: 8 }])), /bomb\.xml expands too much to be a real document/);
  assert.equal(unzip(rawZip([{ name: 'empty' }])).get('empty')!.length, 0);
});

test('entries that lie about themselves are refused in their own words', () => {
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello', csize: 1000, usize: 1000 }])), /a\.txt runs past the end of the file/);
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello', method: 9 }])), /a\.txt uses an unsupported compression method/);
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello hello hello hello', method: 8, usize: 5 }])), /a\.txt is damaged or larger than the directory says/);
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello hello hello hello', method: 8, usize: 100 }])), /a\.txt is not the size the directory says/);
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello', method: 8, csize: 3 }])), /a\.txt is damaged or larger than the directory says/);
  assert.throws(() => unzip(rawZip([{ name: 'a.txt', data: 'hello', crc: 1 }])), /a\.txt is damaged \(its CRC-32 does not match\)/);
});

const para = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${inner}</w:r></w:p>`;
const doc = (...ps: string[]) => docx(zip([{ name: 'word/document.xml', data: `<w:document><w:body>${ps.join('')}</w:body></w:document>` }]));

test('docx: every entity Word writes is decoded, once, and a character that does not exist is refused', () => {
  assert.deepEqual(doc(para('<w:t>&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;lt; &#65;&#x42;&#X43;</w:t>')), [{ text: '<a> "b" \'c\' &lt; ABC' }]);
  assert.deepEqual(doc(para('<w:t>a&#0;b</w:t>')), [{ text: 'a\u0000b' }]);
  assert.deepEqual(doc(para('<w:t>&#1114111;&#x10ffff;</w:t>')), [{ text: '\u{10ffff}\u{10ffff}' }]);
  assert.throws(() => doc(para('<w:t>&#1114112;</w:t>')), /&#1114112; is not a character/);
  assert.throws(() => doc(para('<w:t>&#x110000;</w:t>')), /&#1114112; is not a character/);
  assert.throws(() => doc(para('<w:t>&#99999999;</w:t>')), Refused);
  assert.deepEqual(doc(para('<w:t>&#123456789;</w:t>')), [{ text: '&#123456789;' }], 'a ninth digit is not an entity');
});

test('docx: line breaks of every kind, tabs, and runs with and without attributes', () => {
  assert.deepEqual(doc(para('<w:t>a</w:t><w:br/><w:t>b</w:t><w:br w:type="page"/><w:t xml:space="preserve"> c</w:t><w:cr/><w:t>d</w:t><w:tab/><w:t>e</w:t>')), [{ text: 'a\nb\n c\nd\te' }]);
});

test('docx: a heading is only a style named Heading and a number, and a list is only a numbered paragraph or a List style', () => {
  const styled = (style: string, text = 'x') => doc(para(`<w:t>${text}</w:t>`, `<w:pStyle w:val="${style}"/>`))[0]!;
  assert.deepEqual(styled('Heading1'), { text: 'x', heading: 1 });
  assert.deepEqual(styled('Heading 2'), { text: 'x', heading: 2 });
  assert.deepEqual(styled('heading3'), { text: 'x', heading: 3 });
  for (const plain of ['Normal', 'Subheading1', 'Heading10', 'Heading1Char', 'Heading  4', 'HeadingX']) assert.deepEqual(styled(plain), { text: 'x' }, plain);
  assert.deepEqual(styled('ListParagraph'), { text: 'x', list: true });
  assert.deepEqual(styled('listbullet'), { text: 'x', list: true });
  assert.deepEqual(styled('Checklist'), { text: 'x' });
  assert.deepEqual(styled('Heading1', ''), { text: '', heading: 1 }, 'an empty heading is kept');
});

test('docx: paragraphs with nothing but white space are left out, and an empty heading is not', () => {
  const out = doc(para('<w:t>  </w:t>'), para('<w:t>kept</w:t>'), para('<w:tab/>'), '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr></w:p>', '<w:p/>');
  assert.deepEqual(out, [{ text: 'kept' }, { text: '', heading: 2 }]);
});

test('numbers, strings and the errors Excel stores are read back by their types', () => {
  const rows = xlsx(book('<row r="1"><c r="A1" t="str"><v>a &amp; b</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="str"/><c r="D1" t="b"><v>0</v></c><c r="E1" t="inlineStr"><is><t>inline</t><t/><t>d</t></is></c><c r="F1" t="s"/><c r="G1" t="s"><v>9</v></c><c r="H1"><v>-1.5e2</v></c><c r="I1"/></row>'));
  assert.deepEqual(rows[0]!.rows, [['a & b', '#N/A', null, false, 'inlined', null, '', -150, null]]);
});

test('phonetic guides are dropped wherever they sit, and an empty or unfinished one costs nothing else', () => {
  const sst = (...si: string[]) => ({ name: 'xl/sharedStrings.xml', data: `<sst>${si.map((s) => `<si>${s}</si>`).join('')}</sst>` });
  const cells = '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c t="s"><v>3</v></c><c t="s"><v>4</v></c></row>';
  const out = xlsx(book(cells, [sst('<rPh sb="0" eb="1"><t>ph</t></rPh><t>after</t>', '<t>a</t><rPh></rPh><t>b</t>', '<t>a</t><rPh sb="0"><t>x</t></rPh><t>b</t><rPh><t>y</t></rPh><t>c</t>', '<t>a</t><rPh><t>never closed</t>', '<t>one</t><t/><t>two</t>')]));
  assert.deepEqual(out[0]!.rows, [['after', 'ab', 'abc', 'a', 'onetwo']]);
});

test('attributes may be single-quoted and spaced around the equals sign, and a tag cut off at the end of the part is ignored', () => {
  const z = zip([
    { name: 'xl/workbook.xml', data: "<workbook><sheets><sheet name = 'Q4 sales' r:id = 'rId7' /></sheets></workbook>" },
    { name: 'xl/_rels/workbook.xml.rels', data: "<Relationships><Relationship Id = 'rId7' Target = 'worksheets/data.xml'/></Relationships>" },
    { name: 'xl/worksheets/data.xml', data: "<worksheet><sheetData><row r = '2'><c r = 'B2' t = 'b'><v>1</v></c></row><row><c r=\"A4\"><v>1</v></c><c r=\"B4\"</row>" },
  ]);
  assert.deepEqual(xlsx(z), [{ name: 'Q4 sales', rows: [[], [null, true], [], [1]] }]);
});

test('cells and rows may be empty elements in any form', () => {
  assert.deepEqual(xlsx(book('<row><c/><c></c><c><v>5</v></c><c /></row><row/><row></row><row><c><v>6</v></c></row>'))[0]!.rows, [[null, null, 5, null], [], [], [6]]);
  assert.deepEqual(xlsx(book('<row r="3"><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row><row r="9"/>'))[0]!.rows, [[], [], [1, 2], [3]], 'a row with a number but no cell refs sits at that row; the next row follows it');
  assert.deepEqual(xlsx(book('<rowx r="3"><c><v>1</v></c></rowx><row><c><v>2</v></c></row>'))[0]!.rows, [[2]], '<rowx> is not a <row>');
});

test('sheets are found through the workbook relationships, in any spelling of the target, and a sheet needs both a name and a relationship', () => {
  const wb = '<workbook><sheets><sheet name="One" r:id="rId1"/><sheet name="Two" r:id="rId2"/><sheet name="Three" r:id="rId3"/><sheet name="NoRel" r:id="rId9"/><sheet r:id="rId1"/><sheet name="NoId"/></sheets></workbook>';
  const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/one.xml"/><Relationship Id="rId2" Target="/xl/worksheets/two.xml"/><Relationship Id="rId3" Target="worksheets/xl/three.xml"/><Relationship Id="rId5"/><Relationship Target="worksheets/orphan.xml"/></Relationships>';
  const sheet = (n: string) => `<worksheet><sheetData><row><c><v>${n}</v></c></row></sheetData></worksheet>`;
  const z = zip([
    { name: 'xl/workbook.xml', data: wb }, { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/one.xml', data: sheet('1') }, { name: 'xl/worksheets/two.xml', data: sheet('2') }, { name: 'xl/worksheets/xl/three.xml', data: sheet('3') },
    { name: 'xl/worksheets/sheet1.xml', data: sheet('9') },
  ]);
  assert.deepEqual(xlsx(z), [{ name: 'One', rows: [[1]] }, { name: 'Two', rows: [[2]] }, { name: 'Three', rows: [[3]] }, { name: 'NoRel', rows: [[9]] }]);
  const bare = zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Only" r:id="rId1"/><sheet name="Gone" r:id="rId2"/></sheets></workbook>' }, { name: 'xl/worksheets/sheet1.xml', data: sheet('4') }]);
  assert.deepEqual(xlsx(bare), [{ name: 'Only', rows: [[4]] }, { name: 'Gone', rows: [[4]] }], 'with no relationships part, the first sheet file stands in');
  assert.deepEqual(xlsx(zip([{ name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Lost" r:id="rId1"/></sheets></workbook>' }])), [{ name: 'Lost', rows: [] }], 'a sheet whose part is missing is empty');
  assert.throws(() => xlsx(zip([{ name: 'xl/other.xml', data: '' }])), /not an Excel workbook/);
});

test('cell references and the Excel grid: its last column and row are allowed and nothing past them', () => {
  const at = (r: string, row = '1') => xlsx(book(`<row r="${row}"><c r="${r}"/></row>`))[0]!.rows;
  assert.equal(at('XFD1')[0]!.length, 16_384);
  assert.equal(at('A1048576', '1048576').length, 1_048_576);
  for (const bad of ['XFE1', 'AAAA1', 'ZZZ1', 'A0', 'A1048577', 'A12345678', '!A1', 'A1!', 'a1', '1A', 'A', '']) assert.throws(() => at(bad), Refused, bad);
  assert.throws(() => at('XFE1'), /XFE1 is outside the Excel grid/);
  assert.throws(() => at('A0'), /A0 is outside the Excel grid/);
  assert.throws(() => at('A1048577'), /A1048577 is outside the Excel grid/);
  assert.throws(() => xlsx(book('<row r="0"><c><v>1</v></c></row>')), /A0 is outside the Excel grid/);
  assert.throws(() => xlsx(book('<row r="1048577"><c><v>1</v></c></row>')), /A1048577 is outside the Excel grid/);
  assert.throws(() => at('x'.repeat(100)), (e: Error) => e instanceof Refused && e.message === `${'x'.repeat(20)} is not a cell reference`);
});

test('a row of cells without references may fill the grid but not run past it', () => {
  assert.equal(xlsx(book(`<row>${'<c/>'.repeat(16_384)}</row>`), { maxRatio: 1e9 })[0]!.rows[0]!.length, 16_384);
  assert.throws(() => xlsx(book(`<row>${'<c/>'.repeat(16_385)}</row>`), { maxRatio: 1e9 }), /a row runs past the Excel grid/);
});

test('the cell budget counts the padding of rows and of cells, exactly, and its default is five million', () => {
  const sheet = '<row r="1"><c r="A1"/><c r="D1"/></row><row r="3"><c r="B3"/></row>';
  assert.deepEqual(xlsx(book(sheet), { maxCells: 9 })[0]!.rows, [[null, null, null, null], [], [null, null]]);
  assert.throws(() => xlsx(book(sheet), { maxCells: 8 }), /the sheet has too many cells/);
  assert.throws(() => xlsx(book('<row r="3"><c r="C3"/></row>'), { maxCells: 5 }), /the sheet has too many cells/);
  assert.throws(() => xlsx(book('<row r="3"><c r="C3"/></row>'), { maxCells: 2 }), /the sheet has too many cells/);
  assert.equal(xlsx(book('<row r="3"><c r="C3"/></row>'), { maxCells: 6 })[0]!.rows.length, 3);
  const wide = Array.from({ length: 400 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"/></row>`).join('');
  assert.throws(() => xlsx(book(wide)), /the sheet has too many cells/);
});

test('unclosed and nested-looking tags cost nothing and loop nowhere', () => {
  assert.deepEqual(xlsx(book('<row><c r="A1"><v>1</v></c><c r="B1"</row>'))[0]!.rows, [[1]]);
});

test('a colon inside a name is fine; only a drive letter at the start is a Windows path', () => {
  assert.deepEqual([...unzip(zip([{ name: 'customXml/item:1.xml', data: 'x' }])).keys()], ['customXml/item:1.xml']);
  assert.throws(() => unzip(zip([{ name: 'z:/x', data: 'x' }])), /Windows-style names/);
});

const wrap = (xml: string) => docx(zip([{ name: 'word/document.xml', data: xml }])).map((p) => p.text);
const t = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
const fb = (inner: string) => `<mc:Fallback>${inner}</mc:Fallback>`;

test('docx: a fallback copy is dropped whole wherever it begins, nests, or is left open, and a stray close changes nothing', () => {
  assert.deepEqual(wrap(`${fb(t('hide'))}${t('show')}`), ['show'], 'at the very start of the part');
  assert.deepEqual(wrap(`<w:body>${t('a')}${fb(t('hide'))}${t('b')}</w:body>`), ['a', 'b']);
  assert.deepEqual(wrap(`${fb(`${fb(t('h1'))}${t('h2')}`)}${t('show')}`), ['show'], 'a fallback inside a fallback ends with the outer one');
  assert.deepEqual(wrap(`${fb(`${t('h1')}<mc:Fallback/>${t('h2')}`)}${t('show')}`), ['show'], 'an empty fallback inside one does not end it');
  assert.deepEqual(wrap(`${t('a')}<mc:Fallback/>${t('b')}`), ['a', 'b']);
  assert.deepEqual(wrap(`${t('a')}</mc:Fallback>${t('b')}${fb(t('hide'))}${t('c')}`), ['a', 'b', 'c'], 'a close with nothing open is ignored');
  assert.deepEqual(wrap(`</mc:Fallback>${t('a')}${fb(t('hide'))}${t('c')}`), ['a', 'c'], 'also at the very start');
  assert.deepEqual(wrap(`${t('a')}<mc:Fallback>${t('never closed')}`), ['a'], 'a fallback never closed hides the rest');
  assert.deepEqual(wrap(`<mc:Fallback>${t('never closed')}`), [], 'also from the very start');
  assert.deepEqual(wrap(`${t('a')}<mc:Fallback ${t('cut off')}`), ['a'], 'a tag cut off at the end of the part');
});

test('docx: only <w:p> opens a paragraph, not the elements whose names begin the same way', () => {
  assert.deepEqual(wrap('<w:p><w:r><w:t>A</w:t></w:r><w:pict><w:t>B</w:t></w:pict></w:p>'), ['AB']);
  assert.deepEqual(wrap('<w:p><w:pPr><w:pStyle w:val="x"/></w:pPr><w:r><w:t>A</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>B</w:t></w:r></w:p>'), ['AB']);
  assert.deepEqual(wrap('<w:pict><w:t>x</w:t></w:pict><w:p><w:r><w:t>A</w:t></w:r></w:p>'), ['A']);
  assert.deepEqual(wrap('<w:p w:rsidR="1"><w:r><w:t>A</w:t></w:r></w:p>'), ['A']);
});

test('docx: an empty paragraph element inside a paragraph is its own paragraph and does not swallow the text around it', () => {
  assert.deepEqual(wrap(`<w:p><w:r><w:t>A</w:t></w:r><w:p/><w:r><w:t>B</w:t></w:r></w:p>${t('C')}`), ['AB', 'C']);
  assert.deepEqual(docx(zip([{ name: 'word/document.xml', data: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:p/></w:p><w:p/>' }])), [{ text: '', heading: 1 }]);
});

test('docx: paragraphs read from the very start of the part, even after a stray close', () => {
  assert.deepEqual(wrap(t('first')), ['first']);
  assert.deepEqual(wrap(`</w:p>${t('after a stray close')}`), ['after a stray close']);
  assert.deepEqual(wrap(`${t('a')}</w:p></w:p>${t('b')}`), ['a', 'b']);
  assert.deepEqual(wrap(`<w:p><w:r><w:t>never closed</w:t></w:r>`), []);
  assert.deepEqual(wrap(`${t('a')}<w:p`), ['a'], 'a tag cut off at the end of the part');
  assert.deepEqual(wrap(`${t('a')}<w:p `), ['a']);
});

test('docx: text boxes nest as many deep as Word makes them, each box after the paragraph that holds it and the text around it kept in place', () => {
  const box = (...ps: string[]) => `<w:txbxContent>${ps.join('')}</w:txbxContent>`;
  const run = (s: string) => `<w:r><w:t>${s}</w:t></w:r>`;
  const xml = `<w:p>${run('A')}${box(`<w:p>${run('X')}${box(`<w:p>${run('deep')}</w:p>`)}${run('Y')}</w:p>`)}${run('B')}${box(`<w:p>${run('Z')}</w:p>`)}${run('C')}</w:p>${t('after')}`;
  assert.deepEqual(wrap(xml), ['ABC', 'XY', 'deep', 'Z', 'after']);
});

test('docx: fallbacks one after another each hide their own content and nothing between them', () => {
  assert.deepEqual(wrap(`${fb(t('h1'))}${t('mid')}${fb(t('h2'))}${t('end')}`), ['mid', 'end']);
  assert.deepEqual(wrap(`${t('a')}${fb(t('h1'))}${t('b')}${fb(t('h2'))}${t('c')}${fb(t('h3'))}`), ['a', 'b', 'c']);
  assert.deepEqual(wrap(`${t('a')}<mc:Fallback`), ['a'], 'an opening tag cut off at the end of the part');
});

test('docx: an empty fallback marker inside text leaves the text whole, and a paragraph inside a text run is lifted out of it', () => {
  assert.deepEqual(wrap('<w:p><w:r><w:t>a<mc:Fallback/>b</w:t></w:r></w:p>'), ['ab']);
  assert.deepEqual(wrap('<w:p><w:r><w:t>a<w:p><w:r><w:t>X</w:t></w:r></w:p>b</w:t></w:r></w:p>'), ['ab', 'X']);
  assert.deepEqual(wrap('<w:pPr><w:t>x</w:t></w:p>'), [], 'a close with no paragraph open is ignored, after a <w:pPr> too');
});

test('docx: empty paragraph elements between paragraphs do not reorder them', () => {
  assert.deepEqual(wrap(`${t('first')}<w:p/><w:p/><w:p/>${t('second')}${t('third')}`), ['first', 'second', 'third']);
  const box = '<w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent>';
  assert.deepEqual(wrap(`${t('first')}<w:p/><w:p/><w:p><w:r><w:t>outer</w:t></w:r>${box}</w:p>${t('last')}`), ['first', 'outer', 'boxed', 'last']);
});
