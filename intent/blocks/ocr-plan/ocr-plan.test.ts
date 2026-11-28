import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentStream, DEFAULT_THRESHOLDS, gradeWord, helveticaWidth, judgePage, OcrInputRefused, pageText, parseAlto, parseHocr, pdfString, planTextLayer, runOcr, tesseractArgs, TwinOcr } from './index.ts';

const HOCR = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta name='ocr-system' content='tesseract 5'/></head><body>
<div class='ocr_page' id='page_1' title='image "scan.png"; bbox 0 0 2550 3300; ppageno 0; scan_res 300 300'>
 <div class='ocr_carea' id='block_1_1' title="bbox 300 300 1400 420">
  <p class='ocr_par' id='par_1_1'>
   <span class='ocr_line' id='line_1_1' title="bbox 300 300 1400 360; baseline 0 -12; x_size 40">
    <span class='ocrx_word' id='word_1_1' title='bbox 300 300 600 360; x_wconf 96'>Hello</span>
    <span class='ocrx_word' id='word_1_2' title='bbox 640 300 1000 360; x_wconf 71'><strong>W&amp;orld</strong></span>
    <span class='ocrx_word' id='word_1_3' title='bbox 1040 300 1400 360; x_wconf 31'>sm&#x101;sh</span>
   </span>
   <span class='ocr_line' id='line_1_2' title="bbox 300 380 900 440">
    <span class='ocrx_word' id='word_1_4' title='bbox 300 380 900 440; x_wconf 88'>Second</span>
   </span>
  </p>
 </div>
</div></body></html>`;

const ALTO = `<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://www.loc.gov/standards/alto/ns-v4#"><Description><MeasurementUnit>mm10</MeasurementUnit></Description>
<Layout><Page ID="P1" WIDTH="2100" HEIGHT="2970"><PrintSpace><TextBlock><TextLine>
<String CONTENT="Dear" HPOS="200" VPOS="300" WIDTH="300" HEIGHT="100" WC="0.99"/>
<SP WIDTH="20" HPOS="500" VPOS="300"/>
<String CONTENT="Sir&amp;Madam" HPOS="520" VPOS="300" WIDTH="700" HEIGHT="100" WC="0.45"/>
</TextLine></TextBlock></PrintSpace></Page></Layout></alto>`;

const word = (text: string, conf: number, box: [number, number, number, number] = [0, 0, 100, 20]) => ({ text, conf, box });

test('hOCR is read into lines, words, boxes and confidences, with entities decoded', () => {
  const [p] = parseHocr(HOCR);
  assert.equal(p!.width, 2550);
  assert.equal(p!.height, 3300);
  assert.equal(p!.dpi, 300);
  assert.equal(p!.unit, 'pixel');
  assert.equal(p!.lines.length, 2);
  assert.deepEqual(p!.lines[0]!.words.map((w) => w.text), ['Hello', 'W&orld', 'smāsh']);
  assert.deepEqual(p!.lines[0]!.words.map((w) => w.conf), [96, 71, 31]);
  assert.deepEqual(p!.lines[0]!.words[1]!.box, [640, 300, 1000, 360]);
  assert.equal(pageText(p!, DEFAULT_THRESHOLDS, true), 'Hello W&orld smāsh\nSecond');
});

test('a word without confidence reads as zero and hOCR with no page is refused', () => {
  const [p] = parseHocr(`<div class="ocr_page" title="bbox 0 0 100 100"><span class="ocr_line"><span class="ocrx_word" title="bbox 1 1 50 20">bare</span></span></div>`);
  assert.equal(p!.lines[0]!.words[0]!.conf, 0);
  assert.throws(() => parseHocr('<html><body>nothing</body></html>'), OcrInputRefused);
  assert.throws(() => parseHocr(`<span class="ocrx_word" title="bbox 1 1 2 2">x</span>`), /outside any page/);
});

test('hOCR with an entity declaration, an unterminated tag or oversize input is refused', () => {
  assert.throws(() => parseHocr(`<!DOCTYPE html [<!ENTITY x "boom">]><div class="ocr_page" title="bbox 0 0 1 1">&x;</div>`), /entity declarations/);
  assert.throws(() => parseHocr('<div class="ocr_page" title="bbox 0 0 1 1"'), /unterminated tag/);
  assert.throws(() => parseHocr(' '.repeat(20_000_001)), /too large/);
  const [p] = parseHocr(`<div class="ocr_page" title="bbox 0 0 10 10"><span class="ocr_line"><span class="ocrx_word" title="bbox 0 0 5 5; x_wconf 90">&bogus; &#0; &#xD800;</span></span></div>`);
  assert.equal(p!.lines[0]!.words[0]!.text, '&bogus; � �', 'unknown or invalid references are not expanded');
});

test('ALTO is read with its unit, boxes from position and size, and confidence on a 0 to 100 scale', () => {
  const [p] = parseAlto(ALTO);
  assert.equal(p!.id, 'P1');
  assert.equal(p!.unit, 'mm10');
  assert.deepEqual(p!.lines[0]!.words.map((w) => w.text), ['Dear', 'Sir&Madam']);
  assert.deepEqual(p!.lines[0]!.words[0]!.box, [200, 300, 500, 400]);
  assert.deepEqual(p!.lines[0]!.words.map((w) => w.conf), [99, 45]);
});

test('ALTO refuses a DOCTYPE, entities, an unknown unit, a String without a box and an empty file', () => {
  assert.throws(() => parseAlto(`<!DOCTYPE alto SYSTEM "x.dtd"><alto/>`), /DOCTYPE/);
  assert.throws(() => parseAlto(`<!DOCTYPE a [<!ENTITY e "x">]><alto/>`), OcrInputRefused);
  assert.throws(() => parseAlto(ALTO.replace('mm10', 'furlongs')), /unknown MeasurementUnit/);
  assert.throws(() => parseAlto(ALTO.replace('HPOS="200" ', '')), /without a box/);
  assert.throws(() => parseAlto('<alto></alto>'), /no Page/);
});

test('words are graded at the thresholds, exactly on the boundary', () => {
  const t = DEFAULT_THRESHOLDS;
  assert.deepEqual([100, 80, 79.9, 60, 59.9, 0].map((c) => gradeWord(word('x', c), t)), ['accepted', 'accepted', 'review', 'review', 'dropped', 'dropped']);
});

test('a page goes to a person when its mean is low, too many words are doubtful, or it is empty', () => {
  const [p] = parseHocr(HOCR);
  const v = judgePage(p!);
  assert.deepEqual([v.words, v.accepted, v.review, v.dropped], [4, 2, 1, 1]);
  assert.equal(v.needsPerson, true);
  assert.ok(v.reasons.some((r) => r.startsWith('50% of words are below 80')));
  const good = judgePage({ id: 'g', width: 10, height: 10, unit: 'pixel', dpi: 300, lines: [{ words: [word('clean', 95), word('text', 90)] }] });
  assert.deepEqual([good.needsPerson, good.meanConf], [false, 92.78], 'weighted by characters: (95*5 + 90*4) / 9');
  assert.deepEqual(judgePage({ id: 'e', width: 1, height: 1, unit: 'pixel', dpi: 300, lines: [] }).reasons, ['no text was found']);
  const lowMean = judgePage({ id: 'l', width: 1, height: 1, unit: 'pixel', dpi: 300, lines: [{ words: [word('aaaaaaaaaa', 65), word('b', 99)] }] }, { ...DEFAULT_THRESHOLDS, maxLowFraction: 1 });
  assert.match(lowMean.reasons[0]!, /mean confidence 68\.09 is below 75/);
});

test('page text leaves out dropped words unless asked', () => {
  const [p] = parseHocr(HOCR);
  assert.equal(pageText(p!), 'Hello W&orld\nSecond');
});

test('the twin engine answers through the same interface, and the pipeline reads either format', async () => {
  const twin = new TwinOcr({ a: { format: 'hocr', body: HOCR }, b: { format: 'alto', body: ALTO } });
  const r = await runOcr(twin, [{ id: 'a', bytes: new Uint8Array(1) }, { id: 'b', bytes: new Uint8Array(1) }], { lang: 'eng+deu' });
  assert.deepEqual(r.pages.map((p) => [p.id, p.ok, p.attempts]), [['a', true, 1], ['b', true, 1]]);
  assert.deepEqual(twin.calls, [{ id: 'a', lang: 'eng+deu' }, { id: 'b', lang: 'eng+deu' }]);
  assert.deepEqual(r.needingPerson, ['a', 'b']);
  assert.equal(r.pages[0]!.page!.id, 'a');
});

test('a failing page is retried, then reported, and the others still run', async () => {
  const twin = new TwinOcr({ a: { format: 'hocr', body: HOCR }, b: { format: 'hocr', body: HOCR } }, { a: 2, b: 5 });
  const r = await runOcr(twin, [{ id: 'a', bytes: new Uint8Array(1) }, { id: 'b', bytes: new Uint8Array(1) }, { id: 'c', bytes: new Uint8Array(1) }], { retries: 2 });
  assert.deepEqual(r.pages.map((p) => [p.id, p.ok, p.attempts]), [['a', true, 3], ['b', false, 3], ['c', false, 3]]);
  assert.equal(r.pages[1]!.error, 'engine busy');
  assert.equal(r.pages[2]!.error, 'no scripted answer for c');
  assert.deepEqual(r.failed, ['b', 'c']);
});

test('hostile engine output is not retried', async () => {
  const twin = new TwinOcr({ a: { format: 'alto', body: '<!DOCTYPE x><alto/>' } });
  const r = await runOcr(twin, [{ id: 'a', bytes: new Uint8Array(1) }], { retries: 4 });
  assert.equal(r.pages[0]!.attempts, 1);
  assert.match(r.pages[0]!.error!, /DOCTYPE/);
});

test('Helvetica widths match the published metrics', () => {
  assert.equal(helveticaWidth('Hello', 1000), 2278);
  assert.equal(helveticaWidth(' ', 12), 3.336);
  assert.equal(helveticaWidth('中', 1000), 556, 'a character it has no width for counts as an average one');
});

test('the PDF plan converts pixels to points, flips the y axis, scales words to their boxes and skips dropped ones', () => {
  const [p] = parseHocr(HOCR);
  const plan = planTextLayer([p!]);
  const pg = plan.pages[0]!;
  assert.deepEqual([pg.widthPt, pg.heightPt, pg.skipped], [612, 792, 1]);
  assert.deepEqual(pg.words.map((w) => w.text), ['Hello', 'W&orld', 'Second']);
  const hello = pg.words[0]!;
  assert.equal(hello.x, 72);
  assert.equal(hello.y, 708.48);
  assert.equal(hello.fontSize, 15.16);
  assert.equal(hello.scale, Math.round(((300 * 0.24) / helveticaWidth('Hello', 60 * 0.24 / 0.95)) * 10000) / 100);
  assert.deepEqual(pg.words.map((w) => w.review), [false, true, false]);
});

test('ALTO in tenths of a millimetre lands on an A4 page in points', () => {
  const plan = planTextLayer(parseAlto(ALTO));
  assert.deepEqual([plan.pages[0]!.widthPt, plan.pages[0]!.heightPt], [595.28, 841.89]);
});

test('PDF strings escape what would end them and mark what WinAnsi cannot hold', () => {
  assert.deepEqual(pdfString('a(b)c\\d'), { literal: '(a\\(b\\)c\\\\d)', lossy: false });
  assert.deepEqual(pdfString('café'), { literal: '(caf\\351)', lossy: false });
  assert.deepEqual(pdfString('ā\n'), { literal: '(??)', lossy: true });
});

test('the content stream is invisible text, one positioned word at a time', () => {
  const stream = contentStream({ id: 'p', widthPt: 100, heightPt: 100, skipped: 0, words: [{ text: 'a(b', x: 10, y: 20.5, fontSize: 12, scale: 95.5, review: false }] });
  assert.equal(stream, ['BT', '3 Tr', '/F1 12 Tf', '95.5 Tz', '1 0 0 1 10 20.5 Tm', '(a\\(b) Tj', 'ET'].join('\n'));
});

test('the tesseract argument list is built from checked language codes only', () => {
  assert.deepEqual(tesseractArgs('eng+deu', 300), ['stdin', 'stdout', '-l', 'eng+deu', '--dpi', '300', 'hocr']);
  assert.deepEqual(tesseractArgs('chi_sim'), ['stdin', 'stdout', '-l', 'chi_sim', 'hocr']);
  assert.throws(() => tesseractArgs('eng; rm -rf /'), RangeError);
  assert.throws(() => tesseractArgs('--oem 1'), RangeError);
});
