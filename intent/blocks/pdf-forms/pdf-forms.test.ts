import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pdf } from '../pdf/index.ts';
import { FormError, FormsError, addFields, appearanceMatrix, displayed, fill, flatten, missingRequired, pageGeometry, pageRefs, placement, readDoc, readForm, serialize } from './index.ts';
import type { PageGeometry, PdfDict } from './index.ts';

const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');

function stream(dictBody: string, data: string): string {
  return `<< ${dictBody} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
}

/** A classic PDF from numbered object bodies. */
function build(objs: Record<number, string>, root = 1): Buffer {
  const max = Math.max(...Object.keys(objs).map(Number));
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs: Record<number, number> = {};
  for (let n = 1; n <= max; n++) {
    if (objs[n] === undefined) continue;
    offs[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const x = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) out += offs[n] === undefined ? '0000000000 00000 f \n' : `${String(offs[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${max + 1} /Root ${root} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const FORM_XOBJ = (w: number, h: number, body: string) => stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${w} ${h}]`, body);
const W = '/Type /Annot /Subtype /Widget';

/** A two-page application form with every kind of field. */
function formPdf(over: Record<number, string> = {}): Buffer {
  return build({
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 20 0 R 25 0 R 31 0 R 32 0 R 40 0 R 33 0 R 50 0 R] /DR << /Font << /Helv 5 0 R >> >> /DA (/Helv 0 Tf 0 g) >> >>',
    2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 20 0 R 26 0 R 27 0 R 31 0 R 32 0 R 40 0 R] >>',
    4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate 90 /Contents 6 0 R /Annots [33 0 R 51 0 R 52 0 R 53 0 R] >>',
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    6: stream('', 'BT /F1 12 Tf 50 750 Td (Application form) Tj ET'),
    10: `<< ${W} /FT /Tx /T (name) /Rect [100 700 300 720] /MaxLen 20 /DA (/Helv 12 Tf 0 g) /Ff 2 /P 3 0 R /F 4 >>`,
    11: `<< ${W} /FT /Tx /T (zip) /Rect [100 660 200 680] /MaxLen 5 /Ff 16777216 /DA (/Helv 12 Tf 0 g) /MK << /BC [0] >> >>`,
    12: `<< ${W} /FT /Tx /T (notes) /Rect [100 560 300 640] /Ff 4096 /DA (/Helv 10 Tf 0 g) >>`,
    13: `<< ${W} /FT /Tx /T (ref) /Rect [100 530 300 550] /Ff 1 /V (R-1) >>`,
    14: `<< ${W} /FT /Tx /T (pin) /Rect [320 700 400 720] /Ff 8192 /DA (/Helv 12 Tf 0 g) >>`,
    20: `<< ${W} /FT /Btn /T (agree) /Rect [100 500 114 514] /V /Off /AS /Off /AP << /N << /Yes 23 0 R /Off 24 0 R >> >> >>`,
    23: FORM_XOBJ(14, 14, '0 0 14 14 re S 2 2 m 12 12 l S'),
    24: FORM_XOBJ(14, 14, '0 0 14 14 re S'),
    25: '<< /FT /Btn /Ff 32768 /T (plan) /Kids [26 0 R 27 0 R] /V /Off >>',
    26: `<< ${W} /Parent 25 0 R /Rect [100 470 114 484] /AS /Off /AP << /N << /basic 23 0 R /Off 24 0 R >> >> >>`,
    27: `<< ${W} /Parent 25 0 R /Rect [200 470 214 484] /AS /Off /AP << /N << /pro 23 0 R /Off 24 0 R >> >> >>`,
    31: `<< ${W} /FT /Ch /Ff 131072 /T (country) /Rect [100 430 300 450] /Opt [[(us) (United States)] [(ca) (Canada)]] /DA (/Helv 12 Tf 0 g) >>`,
    32: `<< ${W} /FT /Ch /Ff 2097152 /T (langs) /Rect [100 350 300 420] /Opt [(en) (fr) (de)] /DA (/Helv 10 Tf 0 g) >>`,
    33: `<< ${W} /FT /Tx /T (second) /Rect [100 100 300 120] /DA (/Helv 12 Tf 0 g) >>`,
    40: `<< ${W} /FT /Sig /T (sig) /Rect [100 300 300 340] >>`,
    50: '<< /T (person) /Kids [52 0 R 53 0 R] /FT /Tx >>',
    51: '<< >>',
    52: `<< ${W} /Parent 50 0 R /T (first) /Rect [320 600 400 620] /DA (/Helv 12 Tf 0 g) >>`,
    53: `<< ${W} /Parent 50 0 R /T (last) /Rect [320 570 400 590] /DA (/Helv 12 Tf 0 g) >>`,
    ...over,
  });
}

const get = (b: Uint8Array, name: string) => readForm(b).fields.find((f) => f.name === name)!;

test('the form is read: types, flags, limits, options, and which page each widget is on', () => {
  const form = readForm(formPdf());
  assert.equal(form.pages, 2);
  assert.equal(form.needAppearances, false);
  assert.deepEqual(form.fields.map((f) => [f.name, f.type]), [
    ['name', 'text'], ['zip', 'text'], ['notes', 'text'], ['ref', 'text'], ['pin', 'text'], ['agree', 'checkbox'], ['plan', 'radio'], ['country', 'combo'], ['langs', 'list'], ['sig', 'signature'], ['second', 'text'],
    ['person.first', 'text'], ['person.last', 'text'],
  ]);
  const name = form.fields[0]!;
  assert.deepEqual([name.required, name.maxLen, name.readOnly, name.value], [true, 20, false, null]);
  assert.deepEqual(name.widgets, [{ object: 10, page: 0, rect: [100, 700, 300, 720], onState: null }]);
  const zip = form.fields[1]!;
  assert.deepEqual([zip.comb, zip.maxLen], [true, 5]);
  assert.equal(form.fields[2]!.multiline, true);
  assert.deepEqual([form.fields[3]!.readOnly, form.fields[3]!.value], [true, 'R-1']);
  assert.equal(form.fields[4]!.password, true);
  assert.deepEqual(form.fields[5]!.widgets[0]!.onState, 'Yes');
  assert.equal(form.fields[5]!.value, null, '/Off is no value');
  assert.deepEqual(form.fields[6]!.widgets.map((w) => w.onState), ['basic', 'pro']);
  assert.deepEqual(form.fields[7]!.options, [{ value: 'us', label: 'United States' }, { value: 'ca', label: 'Canada' }]);
  assert.deepEqual([form.fields[8]!.multiSelect, form.fields[8]!.options.map((o) => o.value)], [true, ['en', 'fr', 'de']]);
  assert.equal(form.fields[10]!.widgets[0]!.page, 1);
  assert.equal(form.fields[11]!.widgets[0]!.page, 1);
  const unlisted = readForm(formPdf({ 4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate 90 /Contents 6 0 R /Annots [33 0 R 53 0 R] >>' }));
  assert.equal(unlisted.fields.find((f) => f.name === 'person.first')!.widgets[0]!.page, null, 'a widget no page lists has no page');
});

test('filling text puts the value in the field and draws it, as an update after the original bytes', () => {
  const src = formPdf();
  const { pdf: out, filled } = fill(src, { name: 'Ana Rivera' });
  assert.deepEqual(filled, ['name']);
  assert.equal(Buffer.compare(Buffer.from(out).subarray(0, src.length), src), 0);
  assert.equal(get(out, 'name').value, 'Ana Rivera');
  const t = latin(out).slice(src.length);
  assert.match(t, /\(Ana Rivera\) Tj/);
  assert.match(t, /\/BBox \[0 0 200 20\]/);
  assert.match(t, /\/Tx BMC/);
  assert.match(t, /\/Prev \d+/);
  const d = readDoc(out);
  const w = d.get(10) as PdfDict;
  const ap = d.resolve(w.entries.get('AP')) as PdfDict;
  assert.equal(serialize(ap.entries.get('N')!).endsWith(' 0 R'), true);
});

test('text is placed by alignment, and long text in an automatic size shrinks to fit', () => {
  const src = formPdf({ 10: `<< ${W} /FT /Tx /T (name) /Rect [100 700 300 720] /MaxLen 20 /DA (/Helv 0 Tf 0 g) /Q 2 /Ff 2 /P 3 0 R /F 4 >>` });
  const short = latin(fill(src, { name: 'Hi' }).pdf).slice(src.length);
  const m = /BT \/F0 ([\d.]+) Tf 0 g ([\d.]+) ([\d.]+) Td \(Hi\) Tj ET/.exec(short)!;
  assert.equal(m[1], '12', 'automatic size is the height less margins, capped at 12');
  const x = Number(m[2]);
  assert.ok(x > 170 && x < 200, `right aligned near the right edge, got ${x}`);
  const long = latin(fill(src, { name: 'MMMMMMMMMMMMMMMMMMMM' }).pdf).slice(src.length);
  assert.ok(Number(/Tf/.exec(long) && /BT \/F0 ([\d.]+) Tf/.exec(long)![1]) < 12, 'shrunk');
});

test('every problem is reported at once, and nothing is written when there is any', () => {
  const src = formPdf();
  let err: unknown;
  try {
    fill(src, { name: 'x'.repeat(21), nope: 'a', ref: 'changed', zip: 'ab\ncd', agree: 'maybe', country: 'mx', langs: ['en', 'zz'], sig: 'text', plan: 'gold', notes: 5 as unknown as string });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof FormError);
  assert.ok(err instanceof FormsError);
  const probs = Object.fromEntries((err as FormError).problems.map((p) => [p.field, p.why]));
  assert.equal(probs.name, 'the value has 21 characters; at most 20 fit');
  assert.equal(probs.nope, 'there is no field with that name');
  assert.equal(probs.ref, 'the field is read-only');
  assert.equal(probs.zip, 'a single-line field cannot hold a line break');
  assert.equal(probs.agree, 'a check box is true, false or "Yes"');
  assert.equal(probs.country, 'not among the options: mx');
  assert.equal(probs.langs, 'not among the options: zz');
  assert.equal(probs.sig, 'a signature field is signed, not filled');
  assert.equal(probs.plan, 'choose one of: basic, pro');
  assert.equal(probs.notes, 'a text field takes text');
  assert.equal((err as FormError).problems.length, 10);
  assert.throws(() => fill(src, { zip: 'a\nb' }), /cannot hold a line break/);
  assert.throws(() => fill(src, { country: ['us', 'ca'] }), /only one option/);
});

test('comb fields put one character in each cell', () => {
  const src = formPdf();
  const t = latin(fill(src, { zip: '45402' }).pdf).slice(src.length);
  const cells = [...t.matchAll(/BT \/F0 12 Tf 0 g ([\d.]+) [\d.]+ Td \((\d)\) Tj ET/g)];
  assert.deepEqual(cells.map((m) => m[2]), ['4', '5', '4', '0', '2']);
  const xs = cells.map((m) => Number(m[1]));
  xs.forEach((x, i) => assert.ok(x > i * 20 && x < (i + 1) * 20, `character ${i} is inside its 20-point cell: ${x}`));
  assert.match(t, /0 G 1 w/, 'the border from /MK is drawn');
  assert.throws(() => fill(src, { zip: '454021' }), /at most 5 fit/);
});

test('multiline text wraps inside the box and keeps its line breaks', () => {
  const src = formPdf();
  const text = 'First line\nA much longer second line that cannot possibly fit within a box two hundred points wide';
  const t = latin(fill(src, { notes: text }).pdf).slice(src.length);
  const lines = [...t.matchAll(/Td \(([^)]*)\) Tj/g)].map((m) => m[1]);
  assert.equal(lines[0], 'First line');
  assert.ok(lines.length >= 3, `wrapped into ${lines.length} lines`);
  assert.equal(lines.slice(1).join(' '), 'A much longer second line that cannot possibly fit within a box two hundred points wide');
  assert.equal(get(fill(src, { notes: text }).pdf, 'notes').value, text);
});

test('password fields show bullets in the appearance and keep the real value', () => {
  const src = formPdf();
  const out = fill(src, { pin: 's3cret' }).pdf;
  assert.match(latin(out).slice(src.length), /\(\*{6}\) Tj/);
  assert.ok(!latin(out).slice(src.length).includes('(s3cret) Tj'));
  assert.equal(get(out, 'pin').value, 's3cret');
});

test('characters outside the drawn font are shown as ? but the value keeps them', () => {
  const src = formPdf();
  const out = fill(src, { name: 'Zoë ✓' }).pdf;
  assert.equal(get(out, 'name').value, 'Zoë ✓');
  assert.ok(latin(out).slice(src.length).includes('(Zo\xeb ?) Tj'));
});

test('check boxes and radio groups switch states, and only the chosen button shows', () => {
  const src = formPdf();
  const on = fill(src, { agree: true, plan: 'pro' }).pdf;
  assert.equal(get(on, 'agree').value, 'Yes');
  assert.equal(get(on, 'plan').value, 'pro');
  const d = readDoc(on);
  assert.equal(serialize((d.get(20) as PdfDict).entries.get('AS')!), '/Yes');
  assert.equal(serialize((d.get(26) as PdfDict).entries.get('AS')!), '/Off');
  assert.equal(serialize((d.get(27) as PdfDict).entries.get('AS')!), '/pro');
  const off = fill(on, { agree: false, plan: null }).pdf;
  assert.equal(get(off, 'agree').value, null);
  assert.equal(get(off, 'plan').value, null);
  assert.equal(serialize((readDoc(off).get(27) as PdfDict).entries.get('AS')!), '/Off');
  assert.equal(get(fill(src, { agree: 'Yes' }).pdf, 'agree').value, 'Yes', 'the state name works as true');
});

test('a check box with no drawings gets some, so it shows in every viewer', () => {
  const bare = formPdf({ 20: `<< ${W} /FT /Btn /T (agree) /Rect [100 500 114 514] /V /Off >>` });
  assert.equal(get(bare, 'agree').widgets[0]!.onState, null);
  const out = fill(bare, { agree: true }).pdf;
  const t = latin(out).slice(bare.length);
  assert.match(t, /\/N <<\/Off \d+ 0 R \/Yes \d+ 0 R>>|\/N <<\/Yes \d+ 0 R \/Off \d+ 0 R>>/);
  assert.match(t, /1 J 1 j/, 'the tick is drawn from lines');
});

test('choice fields: the export value is stored, the label is drawn, and lists highlight the choice', () => {
  const src = formPdf();
  const out = fill(src, { country: 'ca', langs: ['en', 'de'] }).pdf;
  assert.equal(get(out, 'country').value, 'ca');
  assert.deepEqual(get(out, 'langs').value, ['en', 'de']);
  const t = latin(out).slice(src.length);
  assert.match(t, /\(Canada\) Tj/);
  assert.match(t, /\/I \[0 2\]/);
  assert.match(t, /0\.6 0\.75 0\.85 rg/);
  assert.match(t, /\(fr\) Tj/);
  const editable = Buffer.from(latin(formPdf()).replace('/Ff 131072', '/Ff 393216'), 'latin1');
  assert.equal(get(fill(editable, { country: 'Mexico' }).pdf, 'country').value, 'Mexico', 'an editable combo takes any text');
});

test('fields in a name hierarchy are filled by their full name', () => {
  const out = fill(formPdf(), { 'person.first': 'Ana', 'person.last': 'Rivera' }).pdf;
  assert.equal(get(out, 'person.first').value, 'Ana');
  assert.equal(get(out, 'person.last').value, 'Rivera');
});

test('lock marks filled fields read-only, and a second fill is then refused', () => {
  const out = fill(formPdf(), { name: 'Ana' }, { lock: true }).pdf;
  assert.equal(get(out, 'name').readOnly, true);
  assert.throws(() => fill(out, { name: 'Eve' }), /read-only/);
});

test('fills accumulate: each is another update, and earlier values stay', () => {
  const a = fill(formPdf(), { name: 'Ana' }).pdf;
  const b = fill(a, { zip: '45402' }).pdf;
  const c = fill(b, { name: 'Ana R' }).pdf;
  assert.equal(get(c, 'name').value, 'Ana R');
  assert.equal(get(c, 'zip').value, '45402');
  assert.equal(Buffer.compare(Buffer.from(c).subarray(0, a.length), Buffer.from(a)), 0);
  assert.equal(fill(c, {}).pdf, c, 'nothing to fill, nothing written');
});

test('required fields still empty are listed', () => {
  const form = readForm(formPdf());
  assert.deepEqual(missingRequired(form), ['name']);
  assert.deepEqual(missingRequired(form, { name: 'Ana' }), []);
  assert.deepEqual(missingRequired(readForm(fill(formPdf(), { name: 'Ana' }).pdf)), []);
  assert.deepEqual(missingRequired(form, { name: '' }), ['name']);
});

test('flattening draws the filled values into the page and removes the field', () => {
  const filled = fill(formPdf(), { name: 'Ana Rivera', agree: true, plan: 'basic', country: 'us' }).pdf;
  const r = flatten(filled, ['name', 'agree', 'plan', 'country']);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.flattened, ['name', 'agree', 'plan', 'country']);
  const after = readForm(r.pdf).fields.map((f) => f.name);
  assert.deepEqual(after, ['zip', 'notes', 'ref', 'pin', 'langs', 'sig', 'second', 'person.first', 'person.last']);
  const d = readDoc(r.pdf);
  const page = d.get(3) as PdfDict;
  const annots = d.resolve(page.entries.get('Annots')) as unknown[];
  assert.equal(annots.length, 11 - 5, 'name, agree, both radio widgets, and country are gone from the page');
  const contents = d.resolve(page.entries.get('Contents')) as unknown[];
  assert.equal(contents.length, 4, 'q, the old content, Q, and the drawing');
  const t = latin(r.pdf);
  assert.match(t, /\/FlatFm0 Do Q/);
  assert.match(t, /\/FlatFm3 Do Q/);
  assert.match(serialize((d.resolve(page.entries.get('Resources')) as PdfDict).entries.get('XObject')!), /FlatFm0 \d+ 0 R/);
  assert.ok(serialize((d.resolve(page.entries.get('Resources')) as PdfDict).entries.get('Font')!).includes('F1'), 'the page\'s own fonts stay');
  assert.match(t, /q 1 0 0 1 100 700 cm \/FlatFm0 Do Q/, 'the name field\'s drawing sits at its rectangle');
});

test('a field showing nothing (a button that is off) is flattened by removing it; one with no drawing at all is left alone', () => {
  const r = flatten(formPdf(), ['agree', 'plan', 'name']);
  assert.deepEqual(r.flattened, ['agree', 'plan']);
  assert.deepEqual(r.skipped, [{ field: 'name', why: 'the widget has no appearance to draw' }]);
  assert.equal(readForm(r.pdf).fields.some((f) => f.name === 'agree'), false);
  assert.equal(readForm(r.pdf).fields.some((f) => f.name === 'name'), true);
});

test('flattening everything that can be drawn leaves a plain page; signature fields stay put', () => {
  const full = fill(formPdf(), { name: 'Ana', zip: '45402', notes: 'hello', pin: '1', country: 'ca', langs: ['fr'], second: 'two', 'person.first': 'A', 'person.last': 'B', agree: true, plan: 'pro' }).pdf;
  const r = flatten(full);
  assert.deepEqual(r.skipped, [{ field: 'ref', why: 'the widget has no appearance to draw' }, { field: 'sig', why: 'a signature field is not flattened' }]);
  assert.ok(r.flattened.includes('name') && r.flattened.includes('second'));
  const rem = readForm(r.pdf).fields.map((f) => f.name);
  assert.deepEqual(rem.filter((n) => n !== 'ref' && n !== 'sig'), []);
  const d = readDoc(r.pdf);
  assert.ok((d.get(1) as PdfDict).entries.has('AcroForm'), 'the form stays while a field remains');
  assert.throws(() => flatten(full, ['missing']), /no field with that name/);
});

test('flattening a document with no fields changes nothing', () => {
  const plain = pdf([{ p: 'hello' }], { title: 't' });
  assert.deepEqual(flatten(plain), { pdf: plain, flattened: [], skipped: [] });
});

test('flattening removes the form from the catalog when every field is gone', () => {
  const only = addFields(pdf([{ p: 'hello' }], { title: 't' }), [{ name: 'a', type: 'text', page: 0, rect: [50, 50, 150, 70], value: 'x' }]);
  const r = flatten(only);
  assert.deepEqual(r.flattened, ['a']);
  assert.equal((readDoc(r.pdf).get(1) as PdfDict).entries.has('AcroForm'), false);
  assert.equal(readForm(r.pdf).fields.length, 0);
});

test('an appearance is fitted to its rectangle by the standard matrix algorithm', () => {
  assert.deepEqual(appearanceMatrix([0, 0, 10, 10], [], [100, 200, 120, 230]), [2, 0, 0, 3, 100, 200]);
  assert.deepEqual(appearanceMatrix([5, 5, 15, 15], [1, 0, 0, 1, 0, 0], [0, 0, 10, 10]), [1, 0, 0, 1, -5, -5]);
  // A quarter turn: the box 10 wide and 20 tall becomes 20 wide and 10 tall, then is fitted to the rectangle.
  const m = appearanceMatrix([0, 0, 10, 20], [0, 1, -1, 0, 0, 0], [0, 0, 40, 20]);
  assert.deepEqual(m, [2, 0, 0, 2, 40, 0]);
  assert.deepEqual(appearanceMatrix([0, 0, 0, 0], [], [1, 2, 3, 4]), [1, 0, 0, 1, 1, 2], 'an empty box does not divide by zero');
});

const letter = (over: Partial<PageGeometry> = {}): PageGeometry => ({ box: [0, 0, 612, 792], rotate: 0, userUnit: 1, ...over });

test('placement from the top-left of the displayed page, in several units', () => {
  assert.deepEqual(placement(letter(), { x: 72, y: 72, width: 100, height: 20 }), [72, 700, 172, 720]);
  assert.deepEqual(placement(letter(), { x: 96, y: 96, width: 200, height: 40, unit: 'px' }), [72, 690, 222, 720]);
  assert.deepEqual(placement(letter(), { x: 1, y: 1, width: 1, height: 0.5, unit: 'in' }), [72, 684, 144, 720]);
  assert.deepEqual(placement(letter(), { x: 0, y: 0, width: 0.5, height: 0.5, unit: 'fraction' }), [0, 396, 306, 792]);
  assert.deepEqual(placement(letter(), { x: 25.4, y: 25.4, width: 25.4, height: 25.4, unit: 'mm' }), [72, 648, 144, 720]);
  assert.deepEqual(placement(letter(), { x: 10, y: 10, width: 50, height: 30, fromBottom: true }), [10, 10, 60, 40]);
});

test('placement respects crop boxes, user units and every rotation', () => {
  assert.deepEqual(placement(letter({ box: [50, 100, 350, 500] }), { x: 0, y: 0, width: 100, height: 50 }), [50, 450, 150, 500]);
  assert.deepEqual(placement(letter({ userUnit: 2 }), { x: 0, y: 0, width: 72, height: 72 }), [0, 756, 36, 792]);
  // Page 600 wide and 800 tall, shown turned 90 degrees clockwise: it displays 800 wide and 600 tall.
  const r90 = letter({ box: [0, 0, 600, 800], rotate: 90 });
  assert.deepEqual(placement(r90, { x: 0, y: 0, width: 100, height: 50 }), [0, 0, 50, 100], 'turning a page clockwise sends its bottom-left corner to the top-left');
  assert.deepEqual(placement(r90, { x: 700, y: 550, width: 100, height: 50 }), [550, 700, 600, 800], 'and its top-right corner to the bottom-right');
  const r180 = letter({ box: [0, 0, 600, 800], rotate: 180 });
  assert.deepEqual(placement(r180, { x: 0, y: 0, width: 100, height: 50 }), [500, 0, 600, 50]);
  const r270 = letter({ box: [0, 0, 600, 800], rotate: 270 });
  assert.deepEqual(placement(r270, { x: 0, y: 0, width: 100, height: 50 }), [550, 700, 600, 800], 'a quarter turn the other way sends its top-right corner to the top-left');
  assert.throws(() => placement(letter(), { x: 600, y: 0, width: 50, height: 10 }), /not on the page/);
  assert.throws(() => placement(letter(), { x: 0, y: 0, width: 0, height: 10 }), /above zero/);
  assert.throws(() => placement(letter(), { x: NaN, y: 0, width: 5, height: 10 }), /finite/);
});

test('placement and display are inverses on every rotation', () => {
  for (const rotate of [0, 90, 180, 270] as const) {
    const g = letter({ box: [10, 20, 610, 820], rotate });
    const spec = { x: 40, y: 70, width: 120, height: 30 };
    const rect = placement(g, spec);
    assert.deepEqual(displayed(g, rect), spec, `rotation ${rotate}`);
  }
});

test('page geometry is read from the page, with inherited boxes and rotation', () => {
  const src = formPdf();
  assert.deepEqual(pageGeometry(src, 0), { box: [0, 0, 612, 792], rotate: 0, userUnit: 1 });
  assert.deepEqual(pageGeometry(src, 1), { box: [0, 0, 600, 800], rotate: 90, userUnit: 1 });
  assert.throws(() => pageGeometry(src, 2), /there is no page 3/);
  const inherited = formPdf({ 2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 300 400] /CropBox [10 10 200 300] >>', 3: '<< /Type /Page /Parent 2 0 R /Contents 6 0 R /Annots [10 0 R] >>' });
  assert.deepEqual(pageGeometry(inherited, 0).box, [10, 10, 200, 300]);
  const odd = formPdf({ 4: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate 45 /Contents 6 0 R /Annots [33 0 R 51 0 R] >>' });
  assert.throws(() => pageGeometry(odd, 1), /not a multiple of 90/);
});

test('fields are added where asked, on a document with no form, and can be filled afterwards', () => {
  const plain = pdf([{ h: 'Contract' }, { p: 'Sign below.' }], { title: 'Contract', size: 'Letter' });
  const geometry = pageGeometry(plain, 0);
  const out = addFields(plain, [
    { name: 'signer_name', type: 'text', page: 0, at: { x: 72, y: 500, width: 200, height: 22 }, required: true, tooltip: 'Your full name' },
    { name: 'agree', type: 'checkbox', page: 0, rect: [72, 200, 86, 214] },
    { name: 'signature', type: 'signature', page: 0, at: { x: 72, y: 600, width: 180, height: 50 } },
  ]);
  assert.equal(Buffer.compare(Buffer.from(out).subarray(0, plain.length), plain), 0);
  const form = readForm(out);
  assert.deepEqual(form.fields.map((f) => [f.name, f.type, f.required]), [['signer_name', 'text', true], ['agree', 'checkbox', false], ['signature', 'signature', false]]);
  assert.deepEqual(form.fields[0]!.widgets[0]!.rect, placement(geometry, { x: 72, y: 500, width: 200, height: 22 }));
  assert.deepEqual(form.fields[0]!.widgets[0]!.rect, [72, 270, 272, 292]);
  assert.equal(form.fields[0]!.widgets[0]!.page, 0);
  assert.equal(form.fields[1]!.widgets[0]!.onState, 'Yes');
  const t = latin(out);
  assert.match(t, /\/SigFlags 1/);
  assert.match(t, /\/Helv <</);
  assert.match(t, /\/TU \(Your full name\)/);
  const filled = fill(out, { signer_name: 'Ana Rivera', agree: true }).pdf;
  assert.equal(get(filled, 'signer_name').value, 'Ana Rivera');
  assert.equal(get(filled, 'agree').value, 'Yes');
  assert.equal(flatten(filled).flattened.length, 2);
});

test('adding fields to a form that exists keeps what it had', () => {
  const out = addFields(formPdf(), [{ name: 'extra', type: 'text', page: 1, at: { x: 10, y: 10, width: 100, height: 20 }, multiline: true, maxLen: 50 }]);
  const form = readForm(out);
  assert.equal(form.fields.length, 14);
  const extra = get(out, 'extra');
  assert.deepEqual([extra.multiline, extra.maxLen, extra.widgets[0]!.page], [true, 50, 1]);
  assert.deepEqual(extra.widgets[0]!.rect, placement(pageGeometry(formPdf(), 1), { x: 10, y: 10, width: 100, height: 20 }));
  assert.equal(get(out, 'name').widgets[0]!.page, 0);
  const d = readDoc(out);
  assert.equal(serialize(((d.get(1) as PdfDict).entries.get('AcroForm') as PdfDict).entries.get('DA')!), '(/Helv 0 Tf 0 g)');
});

test('bad new fields are refused together, before anything is written', () => {
  const src = formPdf();
  let err: FormError | undefined;
  try {
    addFields(src, [{ name: 'name', type: 'text', page: 0, rect: [0, 0, 5, 5] }, { name: 'a.b', type: 'text', page: 0, rect: [0, 0, 5, 5] }, { name: 'x', type: 'text', page: 0 }, { name: 'y', type: 'text', page: 0, rect: [0, 0, 5, 5], maxLen: 0 }, { name: 'z', type: 'checkbox', page: 0, rect: [0, 0, 5, 5], value: 'q' }, { name: 'name', type: 'text', page: 0, rect: [0, 0, 5, 5] }]);
  } catch (e) {
    err = e as FormError;
  }
  assert.deepEqual(err!.problems.map((p) => p.why), ['a field with this name already exists', 'a field name is not empty and has no dots', 'give a rect or a place (at)', 'maxLen is a whole number above zero', 'only text fields start with a value', 'a field with this name already exists']);
  assert.throws(() => addFields(src, [{ name: 'p', type: 'text', page: 7, rect: [0, 0, 5, 5] }]), /there is no page 8/);
  assert.throws(() => addFields(src, [{ name: 'p', type: 'text', page: 0, rect: [10, 10, 10, 20] }]), /no size/);
  assert.equal(addFields(src, []), src);
});

test('a document that already uses a cross-reference stream gets its update the same way', () => {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /DR << /Font << /Helv 5 0 R >> >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>',
    `<< ${W} /FT /Tx /T (t) /Rect [10 10 150 30] /DA (/Helv 12 Tf 0 g) >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = Buffer.from('%PDF-1.5\n', 'latin1');
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')]);
  });
  const xoff = out.length;
  const rows = [0, 0, 0, 0, 0, 0, ...offs.flatMap((o) => [1, (o >> 24) & 255, (o >> 16) & 255, (o >> 8) & 255, o & 255, 0, 0]), 1, 0, 0, (xoff >> 8) & 255, xoff & 255, 0, 0].slice(0);
  const table = [0, 0, 0, 0, 0, 255, 255, ...rows.slice(6)].slice(0, 7 + 7 * 5 + 7);
  out = Buffer.concat([out, Buffer.from(`6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R /Length ${table.length} >>\nstream\n`, 'latin1'), Buffer.from(table), Buffer.from(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`, 'latin1')]);
  assert.equal(readDoc(out).usesXrefStream, true);
  const filled = fill(out, { t: 'stream form' }).pdf;
  assert.equal(get(filled, 't').value, 'stream form');
  assert.match(latin(filled).slice(out.length), /\/Type \/XRef/);
  assert.ok(!latin(filled).slice(out.length).includes('\ntrailer\n'));
  assert.equal(get(fill(filled, { t: 'again' }).pdf, 't').value, 'again');
});

test('hostile structure: a field tree that loops, an encrypted file, and not-a-PDF are handled', () => {
  const loop = formPdf({ 50: '<< /T (person) /Kids [52 0 R 53 0 R 50 0 R] /FT /Tx >>' });
  assert.equal(readForm(loop).fields.length, 13);
  const kidsOfSelf = formPdf({ 52: `<< ${W} /Parent 50 0 R /Kids [52 0 R] /T (first) /Rect [320 600 400 620] >>` });
  assert.ok(readForm(kidsOfSelf).fields.length >= 11);
  const enc = Buffer.from(latin(formPdf()).replace(/trailer\n<< /, 'trailer\n<< /Encrypt 9 0 R '), 'latin1');
  assert.throws(() => readForm(enc), /encrypted/);
  assert.throws(() => readForm(Buffer.from('nothing like a pdf, sorry about that')), /not a PDF/);
  assert.equal(readForm(pdf([{ p: 'plain' }], { title: 't' })).fields.length, 0);
});
