import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { pdf } from '../pdf/index.ts';
import { Encrypted, Name, PdfDocument, PdfError, PdfString, Ref, UnsupportedFilter, decodeStream, execute, itemsToText, mergePlan, parseObjectText, parseRanges, parseToUnicode, rotatePlan, splitPlan } from './index.ts';
import type { Dict, Stream } from './index.ts';

const lat = (s: string) => Buffer.from(s, 'latin1');

/** A small PDF written by hand: numbered object bodies, a classic cross-reference table, and the given trailer entries. */
const handmade = (objs: Record<number, string | Buffer>, trailer = '/Root 1 0 R', o: { header?: string } = {}): Buffer => {
  const parts: Buffer[] = [lat(o.header ?? '%PDF-1.7\n')];
  let len = parts[0]!.length;
  const offs: Record<number, number> = {};
  const max = Math.max(...Object.keys(objs).map(Number));
  for (const n of Object.keys(objs).map(Number)) {
    offs[n] = len;
    const b = Buffer.concat([lat(`${n} 0 obj\n`), Buffer.isBuffer(objs[n]) ? (objs[n] as Buffer) : lat(objs[n] as string), lat('\nendobj\n')]);
    parts.push(b);
    len += b.length;
  }
  let x = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) x += n in offs ? `${String(offs[n]).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
  parts.push(lat(`${x}trailer\n<< /Size ${max + 1} ${trailer} >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
};
const stream = (dict: string, data: string | Buffer) => Buffer.concat([lat(`<< ${dict} /Length ${Buffer.byteLength(data as string)} >>\nstream\n`), Buffer.isBuffer(data) ? data : lat(data), lat('\nendstream')]);

const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
const onePage = (content: string, extra = '', res = '/Resources << /Font << /F1 5 0 R >> >>') =>
  handmade({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${res} /Contents 4 0 R ${extra} >>`,
    4: stream('', content),
    5: font,
  });

const qpdf = (b: Buffer): string | undefined => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfparse-'));
  try {
    const f = join(dir, 'x.pdf');
    writeFileSync(f, b);
    const r = spawnSync('qpdf', ['--check', f], { encoding: 'utf8' });
    if (r.error) return undefined;
    return r.status === 0 || r.status === 3 ? `${r.status}:${r.stdout}${r.stderr}` : `FAIL ${r.status}: ${r.stdout}${r.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const checked = (b: Buffer, what: string) => {
  const r = qpdf(b);
  if (r !== undefined) assert.ok(r.startsWith('0:'), `${what}: ${r}`);
};

const threePages = () => pdf([{ h: 'Alpha page' }, { p: 'First (page) body \\ text.' }, { space: 700 }, { h: 'Beta page' }, { p: 'Second page body.' }, { space: 700 }, { h: 'Gamma page' }, { p: 'Third page body.' }], { title: 'Three', author: 'Ana' });

test('object syntax: strings with escapes and nesting, hex, names with #xx, numbers, references, comments, nested containers', () => {
  const o = parseObjectText('<< /A (a\\(b\\)\\n\\101 (nested) c\\\nd) /B <48656C6C6F2> /C /Name#20With#23 /D [1 -2 3.5 .25 +7 true false null 12 0 R] % a comment\n /E << /F [ << /G 1 >> ] >> >>') as Dict;
  assert.equal((o.get('A') as PdfString).bytes.toString('latin1'), 'a(b)\nA (nested) cd');
  assert.deepEqual((o.get('B') as PdfString).bytes, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20]), 'an odd hex digit is completed with 0');
  assert.equal((o.get('C') as Name).name, 'Name With#');
  const d = o.get('D') as unknown[];
  assert.deepEqual(d.slice(0, 8), [1, -2, 3.5, 0.25, 7, true, false, null]);
  assert.ok(d[8] instanceof Ref && d[8].num === 12 && d[8].gen === 0);
  assert.equal((((o.get('E') as Dict).get('F') as Dict[])[0]!).get('G'), 1);
});

test('object syntax errors are errors, not hangs: unclosed things, junk, nesting bombs', () => {
  for (const bad of ['(never ends', '<< /A 1', '[1 2', '<48 6', '<< 1 2 >>', '<< /A >>', '@@', '[1 foo]']) assert.throws(() => parseObjectText(bad), PdfError, bad);
  assert.throws(() => parseObjectText('['.repeat(2000)), /nested too deeply/);
});

test('a PDF made by the pdf block: pages, document info, text by page, and positions', () => {
  const doc = PdfDocument.open(threePages());
  assert.equal(doc.version, '1.7');
  assert.equal(doc.rebuilt, false);
  assert.equal(doc.pageCount, 3);
  assert.deepEqual(doc.info(), { title: 'Three', author: 'Ana', producer: 'zthr pdf' });
  assert.equal(doc.encryption(), undefined);
  assert.match(doc.pageText(0), /^Alpha page\nFirst \(page\) body \\ text\.\n1 of 3$/);
  assert.match(doc.pageText(1), /^Beta page\nSecond page body\.\n2 of 3$/);
  const items = doc.pageItems(0);
  const head = items.find((i) => i.text === 'Alpha page')!;
  assert.deepEqual([head.x, head.size, head.page, head.font], [56, 16, 0, 'F2']);
  const body = items.find((i) => i.text.startsWith('First'))!;
  assert.ok(head.y > body.y, 'the heading is above the body');
  assert.equal(body.size, 11);
  assert.ok(body.x2 > body.x);
  assert.equal(doc.text().split('\n\n').length, 3);
  assert.equal(doc.pages()[0]!.width.toFixed(2), '595.28');
});

test('text operators: Td, TD, T*, Tm, TJ kerning, quote operators, and graphics-state scaling', () => {
  const doc = PdfDocument.open(onePage(`BT /F1 12 Tf 14 TL 100 700 Td (Line one) Tj 0 -14 Td (Line two) Tj T* (Line three) Tj (Four) ' ET
BT /F1 10 Tf 1 0 0 1 300 500 Tm [(W) 80 (ord) -600 (gap)] TJ ET
q 2 0 0 2 0 0 cm BT /F1 10 Tf 50 100 Td (Scaled) Tj ET Q
BT /F1 9 Tf 0 -20 TD (After TD) Tj ET`));
  const by = (t: string) => doc.pageItems(0).find((i) => i.text === t)!;
  assert.deepEqual([by('Line one').x, by('Line one').y], [100, 700]);
  assert.deepEqual([by('Line two').x, by('Line two').y], [100, 686]);
  assert.deepEqual([by('Line three').x, by('Line three').y], [100, 672]);
  assert.deepEqual([by('Four').y], [658]);
  assert.deepEqual([by('W').x, by('W').y], [300, 500]);
  assert.ok(by('ord').x < 300 + 10 * 0.5 && by('ord').x > 300 + 4, 'a positive TJ number pulls the next text back');
  assert.ok(by('gap').x - by('ord').x > 5, 'a large negative number pushes it out');
  assert.deepEqual([by('Scaled').x, by('Scaled').y, by('Scaled').size], [100, 200, 20]);
  assert.deepEqual([by('After TD').x, by('After TD').y], [0, -20]);
});

test('lines are assembled by baseline, left to right, with a space only where there is a gap', () => {
  const t = (text: string, x: number, y: number, x2: number) => ({ text, x, y, x2, size: 10, font: 'F', page: 0 });
  assert.equal(itemsToText([t('world', 60, 100, 90), t('Hello', 10, 100.3, 50), t('next', 10, 80, 30)]), 'Hello world\nnext');
  assert.equal(itemsToText([t('Hel', 10, 100, 25), t('lo', 25.5, 100, 35)]), 'Hello', 'no gap, no space');
  assert.equal(itemsToText([]), '');
});

test('fonts: a ToUnicode map with ranges and two-byte codes, /Differences, and MacRoman', () => {
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0041> <00E9> endbfchar
1 beginbfrange <0010> <0012> <0061> endbfrange
1 beginbfrange <0020> <0021> [<0058> <0059005A>] endbfrange
endcmap`;
  const parsed = parseToUnicode(cmap);
  assert.equal(parsed.twoByte, true);
  assert.deepEqual([...parsed.map].map(([k, v]) => [k, v]), [[3, ' '], [0x41, 'é'], [0x10, 'a'], [0x11, 'b'], [0x12, 'c'], [0x20, 'X'], [0x21, 'YZ']]);
  const doc = handmade({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R /F2 7 0 R /F3 8 0 R >> >> /Contents 4 0 R >>',
    4: stream('', 'BT /F1 12 Tf 10 700 Td <0010001100120003004100200021> Tj ET BT /F2 12 Tf 10 650 Td (a\\001b\\002) Tj ET BT /F3 12 Tf 10 600 Td (caf\\216) Tj ET'),
    5: '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>',
    6: stream('', cmap),
    7: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [1 /fi /Euro 2 /eacute] >> >>',
    8: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>',
  });
  const d = PdfDocument.open(doc);
  const texts = d.pageItems(0).map((i) => i.text);
  assert.deepEqual(texts, ['abc éXYZ', 'aﬁbé'.replace('é', 'é'), 'café']);
});

test('a page tree inherits Resources, MediaBox and Rotate from above, nests, and a loop is refused', () => {
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 /MediaBox [0 0 100 200] /Rotate 90 /Resources << /Font << /F1 9 0 R >> >> >>',
    3: '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 /MediaBox [0 0 300 400] >>',
    4: '<< /Type /Page /Parent 3 0 R /Contents 7 0 R >>',
    5: '<< /Type /Page /Parent 3 0 R /Rotate 0 /Contents 8 0 R >>',
    6: '<< /Type /Page /Parent 2 0 R /CropBox [10 10 60 60] /Contents 8 0 R >>',
    7: stream('', 'BT /F1 12 Tf 10 10 Td (first) Tj ET'),
    8: stream('', 'BT /F1 12 Tf 10 10 Td (other) Tj ET'),
    9: font,
  };
  const d = PdfDocument.open(handmade(objs));
  assert.deepEqual(d.pages().map((p) => [p.width, p.height, p.rotate]), [[300, 400, 90], [300, 400, 0], [50, 50, 90]]);
  assert.equal(d.pageText(0), 'first', 'the font came from the root of the tree');
  const loop = { ...objs, 3: '<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>' };
  assert.throws(() => PdfDocument.open(handmade(loop)).pages(), /loops back/);
});

test('an incremental update: the newest version of an object wins, found through Prev', () => {
  const base = onePage('BT /F1 12 Tf 10 10 Td (original) Tj ET');
  const startOld = Number(/startxref\n(\d+)/.exec(base.toString('latin1'))![1]);
  const body = stream('', 'BT /F1 12 Tf 10 10 Td (revised) Tj ET');
  const at = base.length;
  const obj = Buffer.concat([lat('4 0 obj\n'), body, lat('\nendobj\n')]);
  const x = at + obj.length;
  const upd = Buffer.concat([base, obj, lat(`xref\n4 1\n${String(at).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${startOld} >>\nstartxref\n${x}\n%%EOF\n`)]);
  const d = PdfDocument.open(upd);
  assert.equal(d.rebuilt, false);
  assert.equal(d.pageText(0), 'revised');
  assert.equal(PdfDocument.open(base).pageText(0), 'original');
  const loop = Buffer.from(upd.toString('latin1').replace(`/Prev ${startOld}`, `/Prev ${x}`), 'latin1');
  assert.equal(PdfDocument.open(loop).rebuilt, true, 'a Prev loop is damage, and the file is rebuilt by scanning');
});

test('a cross-reference stream with PNG predictor and a compressed object stream', () => {
  const objs: [number, string][] = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'], [5, font]];
  let table = '';
  let body = '';
  for (const [n, s] of objs) {
    table += `${n} ${body.length} `;
    body += `${s} `;
  }
  const objstm = deflateSync(lat(table + body));
  const header = lat('%PDF-1.5\n%\xe2\xe3\n');
  const content = deflateSync(lat('BT /F1 12 Tf 20 20 Td (compressed) Tj ET'));
  const p4 = Buffer.concat([lat(`4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, lat('\nendstream\nendobj\n')]);
  const p6 = Buffer.concat([lat(`6 0 obj\n<< /Type /ObjStm /N ${objs.length} /First ${table.length} /Filter /FlateDecode /Length ${objstm.length} >>\nstream\n`), objstm, lat('\nendstream\nendobj\n')]);
  const o4 = header.length;
  const o6 = o4 + p4.length;
  const o7 = o6 + p6.length;
  // rows: type(1) offset(2) gen/index(1)
  const rows = [[0, 0, 255], [2, 6, 0], [2, 6, 1], [2, 6, 2], [1, o4, 0], [2, 6, 3], [1, o6, 0], [1, o7, 0]];
  // PNG "Up" predictor, 4 columns: each row is the difference from the one above.
  const plain = Buffer.concat(rows.map((r) => Buffer.from([r[0]!, r[1]! >> 8, r[1]! & 255, r[2]!])));
  const predicted = Buffer.concat(rows.map((_r, i) => Buffer.concat([Buffer.from([2]), Buffer.from(plain.subarray(i * 4, i * 4 + 4).map((v, k) => (v - (i ? plain[(i - 1) * 4 + k]! : 0)) & 255))])));
  const xs = deflateSync(predicted);
  const p7 = Buffer.concat([lat(`7 0 obj\n<< /Type /XRef /Size 8 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >> /Length ${xs.length} >>\nstream\n`), xs, lat('\nendstream\nendobj\n')]);
  const file = Buffer.concat([header, p4, p6, p7, lat(`startxref\n${o7}\n%%EOF\n`)]);
  const d = PdfDocument.open(file);
  assert.equal(d.rebuilt, false);
  assert.equal(d.version, '1.5');
  assert.equal(d.pageCount, 1);
  assert.equal(d.pageText(0), 'compressed');
});

test('a damaged file is rebuilt by scanning: a bad startxref, a truncated tail, objects in a stream found again', () => {
  const good = onePage('BT /F1 12 Tf 10 10 Td (survivor) Tj ET');
  const s = good.toString('latin1');
  const badStart = Buffer.from(s.replace(/startxref\n\d+/, 'startxref\n999999'), 'latin1');
  const a = PdfDocument.open(badStart);
  assert.deepEqual([a.rebuilt, a.pageText(0)], [true, 'survivor']);
  const cut = good.subarray(0, s.indexOf('xref\n0 6'));
  assert.equal(PdfDocument.open(cut).rebuilt, true, 'no trailer at all: the catalog is found by its type');
  assert.equal(PdfDocument.open(cut).pageText(0), 'survivor');
  const wrongOffsets = Buffer.from(s.replace(/(\d{10}) 00000 n/, '0000000009 00000 n'), 'latin1');
  assert.equal(PdfDocument.open(wrongOffsets).pageText(0), 'survivor');
  assert.throws(() => PdfDocument.open(lat('%PDF-1.4\n1 0 obj\n<< /Foo 1 >>\nendobj\n')), /catalog/);
  assert.throws(() => PdfDocument.open(lat('hello, this is not a PDF')), /no %PDF- header/);
});

test('a stream whose /Length is wrong or indirect is still read to its endstream', () => {
  const doc = handmade({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
    4: lat('<< /Length 5 0 R >>\nstream\nBT /F1 12 Tf 10 10 Td (indirect) Tj ET\nendstream'),
    5: '9999',
    6: font,
  });
  assert.equal(PdfDocument.open(doc).pageText(0), 'indirect');
});

test('stream filters: ASCIIHex, ASCII85, RunLength and Flate in a chain; predictors; the unsupported are named', () => {
  const mk = (filter: string, raw: Buffer, parms = ''): Stream => ({ dict: parseObjectText(`<< /Filter ${filter} ${parms} >>`) as Dict, raw });
  assert.equal(decodeStream(mk('/ASCIIHexDecode', lat('48 65 6C6c 6F>'))).toString(), 'Hello');
  assert.equal(decodeStream(mk('/ASCIIHexDecode', lat('48656C6C6F2>'))).toString('latin1'), 'Hello ');
  assert.equal(decodeStream(mk('/ASCII85Decode', lat('87cURD]i,"Ebo80~>'))).toString(), 'Hello World!');
  assert.equal(decodeStream(mk('/ASCII85Decode', lat('z~>'))).length, 4);
  assert.equal(decodeStream(mk('/RunLengthDecode', Buffer.from([2, 65, 66, 67, 254, 68, 128]))).toString(), 'ABCDDD');
  assert.equal(decodeStream(mk('[/ASCII85Decode /FlateDecode]', lat(`${deflateSync(lat('chained')).toString('latin1').length ? a85(deflateSync(lat('chained'))) : ''}`))).toString(), 'chained');
  assert.throws(() => decodeStream(mk('/DCTDecode', Buffer.alloc(4))), (e) => e instanceof UnsupportedFilter && e.filter === 'DCTDecode');
  assert.throws(() => decodeStream(mk('/ASCII85Decode', lat('abÿcd'))), PdfError);
  assert.throws(() => decodeStream(mk('/FlateDecode', lat('not zlib'))), /cannot be inflated/);
});

/** ASCII85 for the chain test above. */
function a85(b: Buffer): string {
  let out = '';
  for (let i = 0; i < b.length; i += 4) {
    const chunk = b.subarray(i, i + 4);
    const pad = 4 - chunk.length;
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
    if (v === 0 && !pad) out += 'z';
    else {
      let s = '';
      for (let k = 0; k < 5; k++) {
        s = String.fromCharCode((v % 85) + 33) + s;
        v = Math.floor(v / 85);
      }
      out += s.slice(0, 5 - pad);
    }
  }
  return `${out}~>`;
}

test('decompression bombs are stopped at the limit, not inflated', () => {
  const bomb = deflateSync(Buffer.alloc(50 * 1024 * 1024));
  assert.ok(bomb.length < 100_000, 'a small file...');
  const s: Stream = { dict: parseObjectText('<< /Filter /FlateDecode >>') as Dict, raw: bomb };
  assert.throws(() => decodeStream(s, 1024 * 1024), /expands past the limit/);
  assert.equal(decodeStream(s, 64 * 1024 * 1024).length, 50 * 1024 * 1024);
  const doc = handmade({
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    4: Buffer.concat([lat(`<< /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`), bomb, lat('\nendstream')]),
  });
  assert.deepEqual(PdfDocument.open(doc, { maxStreamBytes: 1 << 20 }).pageItems(0), [], 'a page whose content will not decode has no text, and the rest of the file is still readable');
});

test('a page with an unsupported image filter still gives its text; other pages are unaffected', () => {
  const d = PdfDocument.open(
    handmade({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 6 0 R >> /XObject << /Im 5 0 R >> >> /Contents [4 0 R] >>',
      4: stream('', 'q /Im Do Q BT /F1 10 Tf 5 5 Td (with image) Tj ET BI /W 1 /H 1 ID \u0001EI BT (hidden?) Tj ET EI'),
      5: lat('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode /Length 3 >>\nstream\nabc\nendstream'),
      6: font,
    }),
  );
  assert.equal(d.pageText(0), 'with image');
});

test('a form XObject contributes its text, placed by its matrix', () => {
  const d = PdfDocument.open(
    handmade({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>',
      4: stream('', 'q 1 0 0 1 100 200 cm /Fm Do Q'),
      5: stream('/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 20] /Resources << /Font << /F1 6 0 R >> >>', 'BT /F1 10 Tf 0 0 Td (in a form) Tj ET'),
      6: font,
    }),
  );
  const [it] = d.pageItems(0);
  assert.deepEqual([it!.text, it!.x, it!.y], ['in a form', 110, 220]);
});

test('encrypted files are recognised and described, and refused for text and edits', () => {
  const enc = handmade({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>', 4: stream('', 'BT (x) Tj ET'), 5: '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 >> >> /O (x) /U (y) /P -4 >>' }, '/Root 1 0 R /Encrypt 5 0 R');
  const d = PdfDocument.open(enc);
  assert.deepEqual(d.encryption(), { filter: 'Standard', version: 4, revision: 4, keyBits: 128, method: 'AES-128' });
  assert.throws(() => d.pageText(0), Encrypted);
  assert.throws(() => execute(splitPlan(1, { every: 1 }), [d]), Encrypted);
  assert.equal(d.pageCount, 1, 'the structure can still be read');
  assert.equal(PdfDocument.open(threePages()).encryption(), undefined);
});

test('limits: file size, object count, page count', () => {
  assert.throws(() => PdfDocument.open(threePages(), { maxBytes: 100 }), /over 100 bytes/);
  assert.throws(() => PdfDocument.open(threePages(), { maxPages: 2 }).pages(), /too many pages/);
  const many = handmade(Object.fromEntries([[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [] /Count 0 >>'], ...Array.from({ length: 50 }, (_, i) => [i + 3, '1'])]));
  const damaged = many.subarray(0, many.toString('latin1').indexOf('xref\n0'));
  assert.throws(() => PdfDocument.open(damaged, { maxObjects: 10 }), /too many objects/);
  assert.equal(PdfDocument.open(damaged, { maxObjects: 100 }).objectCount, 52);
});

test('page ranges: one-based, inclusive, open-ended, in the order written, and refused when wrong', () => {
  assert.deepEqual(parseRanges('1-3,5,7-', 8), [0, 1, 2, 4, 6, 7]);
  assert.deepEqual(parseRanges('3,1', 3), [2, 0]);
  assert.deepEqual(parseRanges('-2', 5), [0, 1]);
  for (const bad of ['0', '4', '2-1', '1-9', 'a', '', '1,,2', '--']) assert.throws(() => parseRanges(bad, 3), PdfError, bad);
});

test('plans: split by count and by ranges, merge, rotate', () => {
  assert.deepEqual(splitPlan(5, { every: 2 }).outputs.map((o) => o.pages.map((p) => p.page)), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(splitPlan(5, { ranges: '1-2;4,5' }).outputs.map((o) => o.pages.map((p) => p.page)), [[0, 1], [3, 4]]);
  assert.throws(() => splitPlan(5, { every: 0 }), PdfError);
  assert.deepEqual(mergePlan([2, 1]).outputs[0]!.pages, [{ doc: 0, page: 0 }, { doc: 0, page: 1 }, { doc: 1, page: 0 }]);
  assert.deepEqual(rotatePlan(3, -90, '2').outputs[0]!.pages.map((p) => p.rotate), [0, 270, 0]);
  assert.throws(() => rotatePlan(3, 45), /multiple of 90/);
});

test('split: each piece is a valid PDF with its own pages and nothing from the others', () => {
  const src = PdfDocument.open(threePages());
  const out = execute(splitPlan(3, { every: 1 }), [src]);
  assert.equal(out.length, 3);
  out.forEach((o, i) => {
    const d = PdfDocument.open(o.pdf);
    assert.equal(d.rebuilt, false);
    assert.equal(d.pageCount, 1);
    assert.match(d.pageText(0), new RegExp(['Alpha', 'Beta', 'Gamma'][i]!));
    assert.ok(!['Alpha', 'Beta', 'Gamma'].filter((_x, j) => j !== i).some((w) => d.pageText(0).includes(w)), 'no text from the others');
    assert.ok(o.pdf.length < threePages().length, 'smaller than the whole');
    checked(o.pdf, o.name);
  });
  const reordered = execute(splitPlan(3, { ranges: '3,1' }), [src])[0]!;
  const d = PdfDocument.open(reordered.pdf);
  assert.deepEqual([d.pageText(0).split('\n')[0], d.pageText(1).split('\n')[0]], ['Gamma page', 'Alpha page']);
  checked(reordered.pdf, 'reordered');
});

test('a page that inherited its fonts from the page tree keeps them when split out', () => {
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >> >>',
    3: '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    4: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    5: stream('', 'BT /F1 12 Tf 10 10 Td (one) Tj ET'),
    6: stream('', 'BT /F1 12 Tf 10 10 Td (two) Tj ET'),
    7: font,
  };
  const src = PdfDocument.open(handmade(objs));
  const [second] = execute(splitPlan(2, { ranges: '2' }), [src]);
  const d = PdfDocument.open(second!.pdf);
  assert.deepEqual([d.pageText(0), d.pages()[0]!.width], ['two', 300]);
  checked(second!.pdf, 'inherited');
});

test('merge: two documents become one in order, each page keeping its own text', () => {
  const a = PdfDocument.open(threePages());
  const b = PdfDocument.open(onePage('BT /F1 12 Tf 10 10 Td (appended page) Tj ET'));
  const [m] = execute(mergePlan([a.pageCount, b.pageCount]), [a, b]);
  const d = PdfDocument.open(m!.pdf);
  assert.equal(d.pageCount, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => d.pageText(i).split('\n')[0]), ['Alpha page', 'Beta page', 'Gamma page', 'appended page']);
  assert.equal(d.version, '1.7');
  checked(m!.pdf, 'merged');
});

test('rotate: the turn is added to what each page already had, only on the chosen pages', () => {
  const src = PdfDocument.open(handmade({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', 3: '<< /Type /Page /Parent 2 0 R /Rotate 90 /MediaBox [0 0 10 10] >>', 4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>' }));
  const [r] = execute(rotatePlan(2, 270, '1'), [src]);
  assert.deepEqual(PdfDocument.open(r!.pdf).pages().map((p) => p.rotate), [0, 0], '90 + 270 is a full turn');
  const [s] = execute(rotatePlan(2, 90), [src]);
  assert.deepEqual(PdfDocument.open(s!.pdf).pages().map((p) => p.rotate), [180, 90]);
  checked(s!.pdf, 'rotated');
});

test('copying does not drag the source document along: links to other pages are cut, and no stray pages appear', () => {
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Annots [6 0 R 8 0 R] /Contents 5 0 R >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R >>',
    5: stream('', 'q Q'),
    6: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [4 0 R /Fit] /P 3 0 R >>',
    8: '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) /P 3 0 R >>',
  };
  const src = PdfDocument.open(handmade(objs));
  const [o] = execute(splitPlan(2, { ranges: '1' }), [src]);
  const d = PdfDocument.open(o!.pdf);
  assert.equal(d.pageCount, 1);
  assert.ok(d.objectCount <= 8, `only what page 1 needs: ${d.objectCount}`);
  const annots = d.pages()[0]!.dict.get('Annots') as Ref[];
  assert.equal(annots.length, 2);
  assert.equal(((d.get(annots[0]!) as Dict).get('Dest') as unknown[])[0], null, 'the link to the other page now goes nowhere');
  assert.equal((d.get(annots[1]!) as Dict).get('P'), null);
  assert.equal(((d.get(annots[1]!) as Dict).get('Contents') as PdfString).text, 'note');
  checked(o!.pdf, 'annots');
});

test('plans that name pages that are not there, or nothing, are refused', () => {
  const src = PdfDocument.open(threePages());
  assert.throws(() => execute({ outputs: [{ name: 'x', pages: [{ doc: 0, page: 9 }] }] }, [src]), /no page 10/);
  assert.throws(() => execute({ outputs: [{ name: 'x', pages: [] }] }, [src]), /no pages/);
  assert.throws(() => execute({ outputs: [{ name: 'x', pages: [{ doc: 3, page: 0 }] }] }, [src]), /document 4/);
});
