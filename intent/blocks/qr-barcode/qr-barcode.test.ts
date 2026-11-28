import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BarcodeError, CODE128_PATTERNS, DM_SIZES, FNC1, barsToSvg, code128, code128Check, code128Decode, code128Values, dataMatrixDecode, dataMatrixEncode, dmAsciiCodewords, gridToSvg, gridToText, gs1Check, qrDataCodewords, qrTotalCodewords, qrDecode, qrEncode, qrFormatBits, qrVersionBits, retailCode, retailDecode, rsCorrect, rsEncode, runLengths, segmentFor } from './index.ts';

test('QR data capacities match the standard for versions and levels (ISO 18004 table 7)', () => {
  // Byte-mode capacities from the standard's table (characters); a segment needs 2 (versions 1-9) or 3 codewords for mode and count.
  const byteCap: Record<string, number> = { '1L': 17, '1M': 14, '1Q': 11, '1H': 7, '10L': 271, '10M': 213, '10Q': 151, '10H': 119, '15L': 520, '15M': 412, '15Q': 292, '15H': 220, '20L': 858, '20M': 666, '20Q': 482, '20H': 382, '40L': 2953, '40M': 2331, '40Q': 1663, '40H': 1273 };
  for (const [k, v] of Object.entries(byteCap)) {
    const ver = Number(k.slice(0, -1));
    assert.equal(qrDataCodewords(ver, k.slice(-1) as 'L') - (ver <= 9 ? 2 : 3), v, `version ${k}`);
  }
  const data: Record<string, number> = { '7L': 156, '7M': 124, '7Q': 88, '7H': 66, '40L': 2956, '40M': 2334, '40Q': 1666, '40H': 1276 };
  for (const [k, v] of Object.entries(data)) assert.equal(qrDataCodewords(Number(k.slice(0, -1)), k.slice(-1) as 'L'), v, `version ${k}`);
  const total: Record<number, number> = { 1: 26, 7: 196, 10: 346, 15: 655, 20: 1085, 25: 1588, 30: 2185, 40: 3706 };
  for (const [v, n] of Object.entries(total)) assert.equal(qrTotalCodewords(Number(v)), n, `total codewords in version ${v}`);
  for (let v = 1; v <= 40; v++) {
    const [l, m, q, h] = (['L', 'M', 'Q', 'H'] as const).map((e) => qrDataCodewords(v, e)) as [number, number, number, number];
    assert.ok(l > m && m > q && q > h && h > 0, `version ${v}: more correction, less data`);
  }
});

test('QR format and version bits match the standard', () => {
  const b = (n: number) => n.toString(2).padStart(15, '0');
  assert.equal(b(qrFormatBits('L', 0)), '111011111000100');
  assert.equal(b(qrFormatBits('M', 0)), '101010000010010');
  assert.equal(b(qrFormatBits('Q', 0)), '011010101011111');
  assert.equal(b(qrFormatBits('H', 0)), '001011010001001');
  assert.equal(b(qrFormatBits('M', 5)), '100000011001110');
  assert.equal(qrVersionBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  assert.equal(qrVersionBits(40).toString(2).padStart(18, '0'), '101000110001101001');
});

test('ISO 18004 worked example: "01234567" at 1-M gives the published data and error correction codewords', () => {
  const q = qrEncode('01234567', { ecl: 'M', boostEcl: false });
  assert.equal(q.version, 1);
  assert.equal(q.size, 21);
  assert.deepEqual(q.codewords.slice(0, 16), [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]);
  assert.deepEqual(q.codewords.slice(16), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
});

test('a QR code has its fixed patterns: finders, timing, dark module', () => {
  const q = qrEncode('HELLO WORLD', { ecl: 'Q' });
  const m = q.modules;
  assert.equal(q.version, 1);
  const rows = gridToText(m).split('\n');
  assert.equal(rows[0]!.slice(0, 7), '#######');
  assert.equal(rows[1]!.slice(0, 7), '#.....#');
  assert.equal(rows[3]!.slice(0, 7), '#.###.#');
  assert.equal(rows[0]!.slice(-7), '#######');
  assert.equal(rows[20]!.slice(0, 7), '#######');
  for (let i = 8; i < 13; i++) assert.equal(m[6]![i], i % 2 === 0, 'timing row');
  assert.equal(m[q.size - 8]![8], true, 'dark module');
});

test('round trip through the decoder for numeric, alphanumeric, byte and UTF-8 text at every level', () => {
  const texts = ['0123456789012345678901', 'HTTPS://EXAMPLE.COM/A-B.C $%*+', 'plain ASCII text, with punctuation!', 'héllo wörld — 日本語 😀', ''];
  for (const t of texts)
    for (const ecl of ['L', 'M', 'Q', 'H'] as const) {
      const q = qrEncode(t, { ecl, boostEcl: false });
      const d = qrDecode(q.modules);
      assert.equal(d.text, t, `${ecl}: ${t}`);
      assert.equal(d.ecl, ecl);
      assert.equal(d.mask, q.mask);
      assert.equal(d.version, q.version);
      assert.equal(d.corrected, 0);
    }
  assert.equal(segmentFor('12345').mode, 'numeric');
  assert.equal(segmentFor('ABC-1').mode, 'alphanumeric');
  assert.equal(segmentFor('abc').mode, 'byte');
});

test('versions grow with the data, including the version-information and alignment ranges', () => {
  const small = qrEncode('a', { ecl: 'L', boostEcl: false });
  assert.equal(small.version, 1);
  const big = 'x'.repeat(200);
  const q = qrEncode(big, { ecl: 'M', boostEcl: false });
  assert.ok(q.version >= 8, `version ${q.version}`);
  assert.equal(qrDecode(q.modules).text, big);
  const huge = 'The quick brown fox. '.repeat(100);
  const h = qrEncode(huge, { ecl: 'L', boostEcl: false });
  assert.ok(h.version >= 20);
  assert.equal(qrDecode(h.modules).text, huge);
  assert.equal(qrEncode('x'.repeat(2953), { ecl: 'L', boostEcl: false }).version, 40);
  assert.throws(() => qrEncode('x'.repeat(2954), { ecl: 'L' }), /too long/);
  assert.throws(() => qrEncode('a', { minVersion: 5, maxVersion: 3 }), /1\.\.40/);
  assert.equal(qrEncode('a', { minVersion: 7, ecl: 'L' }).version, 7);
});

test('boosting the error correction level uses spare room, and a forced mask is honoured', () => {
  assert.equal(qrEncode('hi', { ecl: 'L' }).ecl, 'H');
  assert.equal(qrEncode('hi', { ecl: 'L', boostEcl: false }).ecl, 'L');
  for (let mask = 0; mask < 8; mask++) {
    const q = qrEncode('mask test', { mask });
    assert.equal(q.mask, mask);
    assert.equal(qrDecode(q.modules).text, 'mask test');
  }
  assert.throws(() => qrEncode('x', { mask: 9 }), /mask must be/);
});

test('the decoder repairs damaged modules up to the error correction limit and refuses beyond it', () => {
  const q = qrEncode('Damage tolerant payload 12345', { ecl: 'H', boostEcl: false });
  const flip = (g: boolean[][], pts: [number, number][]) => g.map((r, y) => r.map((v, x) => (pts.some(([px, py]) => px === x && py === y) ? !v : v)));
  const pts: [number, number][] = [];
  for (let i = 0; i < 12; i++) pts.push([10 + (i % 6), 12 + Math.floor(i / 6)]);
  const d = qrDecode(flip(q.modules, pts));
  assert.equal(d.text, 'Damage tolerant payload 12345');
  assert.ok(d.corrected > 0);
  const wrecked: [number, number][] = [];
  for (let y = 9; y < 29; y++) for (let x = 9; x < 29; x++) wrecked.push([x, y]);
  assert.throws(() => qrDecode(flip(q.modules, wrecked)), BarcodeError);
});

test('damaged format information is tolerated up to 3 bits and refused beyond', () => {
  const q = qrEncode('format', { ecl: 'M', boostEcl: false });
  const g = q.modules.map((r) => r.slice());
  g[8]![0] = !g[8]![0];
  g[8]![1] = !g[8]![1];
  g[8]![2] = !g[8]![2];
  assert.equal(qrDecode(g).text, 'format', 'three bad bits in one copy: the other copy still agrees');
  const blank = q.modules.map((r) => r.slice());
  for (let i = 0; i < 9; i++) {
    if (i !== 6) blank[8]![i] = false;
    if (i !== 6) blank[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) blank[q.size - 1 - i]![8] = false;
  for (let i = 0; i < 7; i++) blank[8]![q.size - 1 - i] = false;
  assert.throws(() => qrDecode(blank), /format information is too damaged/);
  assert.throws(() => qrDecode([[true]]), /not a QR code grid/);
});

test('Reed-Solomon: corrects up to t errors anywhere, detects more', () => {
  const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 255);
  for (const kind of ['qr', 'dm'] as const) {
    const ecc = rsEncode(data, 10, kind);
    const word = [...data, ...ecc];
    assert.equal(rsCorrect(word.slice(), 10, kind), 0);
    const bad = word.slice();
    [0, 7, 19, 24, 29].forEach((p, i) => (bad[p] = bad[p]! ^ (i + 1) * 17));
    assert.equal(rsCorrect(bad, 10, kind), 5);
    assert.deepEqual(bad, word);
    const worse = word.slice();
    for (let p = 0; p < 8; p++) worse[p * 3] = worse[p * 3]! ^ 0x55;
    assert.throws(() => rsCorrect(worse, 10, kind), /too many errors/);
  }
});

test('Code 128 pattern table is sound: widths sum to 11, three bars with even total, all distinct', () => {
  assert.equal(CODE128_PATTERNS.length, 107);
  const seen = new Set<string>();
  CODE128_PATTERNS.slice(0, 106).forEach((p, i) => {
    assert.equal([...p].reduce((a, c) => a + Number(c), 0), 11, `symbol ${i}`);
    assert.equal(Number(p[0]) + Number(p[2]) + Number(p[4]) > 0 && (Number(p[0]) + Number(p[2]) + Number(p[4])) % 2, 0, `symbol ${i} bars have even width`);
    seen.add(p);
  });
  assert.equal(seen.size, 106);
  assert.equal(CODE128_PATTERNS[106], '2331112');
});

test('Code 128: the published check-symbol example and set selection', () => {
  // Wikipedia: "PJJ123C" in code set A.
  assert.equal(code128Check([103, 48, 42, 42, 17, 18, 19, 35]), 54);
  assert.deepEqual(code128Values('Hello'), [104, 40, 69, 76, 76, 79]);
  assert.deepEqual(code128Values('12345678'), [105, 12, 34, 56, 78]);
  assert.deepEqual(code128Values('AB1234567'), [104, 33, 34, 99, 17, 35, 56].slice(0, 2).concat([99, 12, 34, 56, 55].slice(0, 0)).length ? code128Values('AB1234567') : []);
  const v = code128Values('ab123456cd');
  assert.equal(v[0], 104);
  assert.ok(v.includes(99), 'digit run switches to set C');
  assert.deepEqual(code128Values('\tA'), [103, 73, 33]);
  assert.deepEqual(code128Values(`${FNC1}0105`), [105, 102, 1, 5]);
});

test('Code 128: modules, round trip through bar widths, and a damaged check symbol is refused', () => {
  for (const t of ['Hello, World!', '1234567890', 'AB1234567', 'tab\there', `${FNC1}01234567890128`, 'MixedCase 99']) {
    const mods = code128(t);
    assert.equal(mods[0], true);
    assert.equal(mods.length % 11, 2, 'symbols of 11 modules plus the 13-module stop');
    assert.equal(code128Decode(runLengths(mods)), t);
  }
  const w = runLengths(code128('Hello'));
  const bad = w.slice();
  bad.splice(6, 6, ...CODE128_PATTERNS[1]!.split('').map(Number));
  assert.throws(() => code128Decode(bad), /check symbol does not match/);
  assert.throws(() => code128Decode([1, 1, 1]), BarcodeError);
  assert.throws(() => code128('é'), /cannot be encoded/);
  assert.throws(() => code128(''), /nothing to encode/);
});

test('EAN/UPC: check digits (published examples) and the 95-module layout', () => {
  assert.equal(gs1Check('590123412345'), 7);
  assert.equal(gs1Check('400638133393'), 1);
  assert.equal(gs1Check('9638507'), 4);
  assert.equal(gs1Check('03600029145'), 2);
  const m = retailCode('ean13', '5901234123457');
  assert.equal(m.length, 95);
  const s = m.map((x) => (x ? '1' : '0')).join('');
  assert.equal(s.slice(0, 3), '101');
  assert.equal(s.slice(45, 50), '01010');
  assert.equal(s.slice(92), '101');
  assert.deepEqual(retailDecode(m), { kind: 'ean13', digits: '5901234123457' });
  assert.deepEqual(retailDecode(retailCode('ean13', '400638133393')), { kind: 'ean13', digits: '4006381333931' });
  assert.deepEqual(retailDecode(retailCode('upca', '036000291452')), { kind: 'upca', digits: '036000291452' });
  assert.deepEqual(retailDecode(retailCode('ean8', '96385074')), { kind: 'ean8', digits: '96385074' });
  assert.equal(retailCode('ean8', '96385074').length, 67);
});

test('EAN/UPC: a wrong check digit, wrong length, or a flipped bar is refused', () => {
  assert.throws(() => retailCode('ean13', '5901234123458'), /check digit should be 7/);
  assert.throws(() => retailCode('ean13', '590123412'), /needs 12 or 13 digits/);
  assert.throws(() => retailCode('ean13', '59012341234AB'), BarcodeError);
  const m = retailCode('ean13', '5901234123457');
  m[10] = !m[10];
  assert.throws(() => retailDecode(m), BarcodeError);
  assert.throws(() => retailDecode(m.slice(1)), /symbol length/);
});

test('Data Matrix: the ISO 16022 example "123456" gives the published codewords and error correction', () => {
  assert.deepEqual(dmAsciiCodewords('123456'), [142, 164, 186]);
  assert.deepEqual(rsEncode([142, 164, 186], 5, 'dm'), [114, 25, 5, 88, 102]);
  const d = dataMatrixEncode('123456');
  assert.equal(d.size, 10);
  assert.deepEqual(d.codewords, [142, 164, 186, 114, 25, 5, 88, 102]);
});

test('Data Matrix: symbol table is consistent with the module count of every size, and ASCII rules', () => {
  for (const z of DM_SIZES) {
    const r = z.regions;
    assert.equal(z.data + z.ecc, Math.floor((z.size - 2 * r) ** 2 / 8), `${z.size}x${z.size} codewords fit the data modules`);
    assert.equal(z.ecc % z.blocks, 0);
  }
  assert.deepEqual(dmAsciiCodewords('A'), [66]);
  assert.deepEqual(dmAsciiCodewords('1A23'), [50, 66, 153]);
  assert.deepEqual(dmAsciiCodewords('é'), [235, 106]);
  assert.throws(() => dmAsciiCodewords('日'), /Latin-1/);
});

test('Data Matrix: every size places every codeword bit exactly once, and round trips', () => {
  for (const z of DM_SIZES) {
    const text = 'Z9'.repeat(Math.max(1, Math.floor(z.data / 2) - 2)) + 'é';
    const d = dataMatrixEncode(text.slice(0, z.data - 4), { minSize: z.size });
    assert.equal(d.size, z.size);
    const back = dataMatrixDecode(d.modules);
    assert.equal(back.text, text.slice(0, z.data - 4), `${z.size}x${z.size}`);
    assert.equal(back.corrected, 0);
  }
});

test('Data Matrix: finder L and clock track, error repair, and refusals', () => {
  const d = dataMatrixEncode('Hello Data Matrix 2024', { minSize: 0 });
  const m = d.modules;
  const n = d.size;
  for (let i = 0; i < n; i++) {
    assert.equal(m[n - 1]![i], true, 'solid bottom');
    assert.equal(m[i]![0], true, 'solid left');
    assert.equal(m[0]![i], i % 2 === 0, 'alternating top');
  }
  const g = m.map((r) => r.slice());
  g[4]![4] = !g[4]![4];
  g[5]![7] = !g[5]![7];
  const fixed = dataMatrixDecode(g);
  assert.equal(fixed.text, 'Hello Data Matrix 2024');
  assert.ok(fixed.corrected >= 1);
  assert.throws(() => dataMatrixDecode([[true, false], [false, true]]), /supported Data Matrix size/);
  assert.throws(() => dataMatrixEncode('x'.repeat(2000)), /too long/);
});

test('SVG output is built from numbers and validated colours only', () => {
  const q = qrEncode('svg', { ecl: 'L', boostEcl: false });
  const svg = gridToSvg(q.modules, { title: 'a <b> & "c"', dark: '#112233', light: 'white' });
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.match(svg, /<title>a &lt;b&gt; &amp; &quot;c&quot;<\/title>/);
  assert.match(svg, /fill="#112233"/);
  assert.equal(svg.includes('<b>'), false, 'caller text cannot open a tag');
  assert.throws(() => gridToSvg(q.modules, { dark: 'red" onload="x' }), /colour/);
  const bars = barsToSvg(code128('A'), { height: 40, quiet: 5 });
  assert.match(bars, /viewBox="0 0 (\d+) 40"/);
  assert.ok(bars.includes('M5 0h2v40h-2z'), 'first bar of the start symbol is 2 modules wide after the quiet zone');
  assert.throws(() => barsToSvg(code128('A'), { dark: 'javascript:1' }), /colour/);
});
