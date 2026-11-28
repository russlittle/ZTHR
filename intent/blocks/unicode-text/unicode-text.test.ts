import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadText, checkIdentifier, collator, confusable, equalFolded, fold, graphemeLength, graphemes, isMixedScript, isNormalised, lookalikes, normalise, reverse, scriptsOf, skeleton, sortedFor, truncate } from './index.ts';

const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
const from = (hex: string) => String.fromCodePoint(...hex.split(' ').map((h) => parseInt(h, 16)));

test('UCD NormalizationTest: U+1E9B U+0323 in all four forms', () => {
  const s = from('1E9B 0323');
  assert.equal(cps(normalise(s, 'NFC')), '1E9B 0323');
  assert.equal(cps(normalise(s, 'NFD')), '017F 0323 0307');
  assert.equal(cps(normalise(s, 'NFKC')), '1E69');
  assert.equal(cps(normalise(s, 'NFKD')), '0073 0323 0307');
});

test('NFC composes and NFD decomposes; a precomposed and a combined e-acute differ until normalised', () => {
  assert.notEqual('é', 'é');
  assert.equal(normalise('é'), 'é');
  assert.equal(normalise('é', 'NFD'), 'é');
  assert.equal(isNormalised('é'), false);
  assert.equal(isNormalised('é'), true);
  assert.equal(normalise('Ａﬁ', 'NFKC'), 'Afi', 'full-width A and the fi ligature');
  assert.equal(cps(normalise('한', 'NFD')), '1112 1161 11AB', 'Hangul syllable to jamo');
});

test('ill-formed and oversized text is refused', () => {
  assert.throws(() => normalise('a\uD800b'), /lone surrogate/);
  assert.throws(() => graphemes('\uDC00'), BadText);
  assert.throws(() => fold('x'.repeat(1_000_001)), /million/);
  assert.throws(() => normalise(5 as never), /not text/);
});

test('case folding: sharp s, long s, final sigma, ligatures and full-width forms meet in one form', () => {
  assert.equal(fold('Straße'), 'strasse');
  assert.equal(fold('STRASSE'), 'strasse');
  assert.equal(fold('ſ'), 's');
  assert.equal(fold('ΟΔΥΣΣΕΥΣ'), fold('Οδυσσεύς'.replace('ύ', 'υ')));
  assert.equal(fold('ΜΑΪΟΣ'), fold('μαϊος'));
  assert.equal(fold('ＡＢＣ'), 'abc');
  assert.equal(fold('ﬁnd'), 'find');
  assert.ok(equalFolded('Éclair', 'éCLAIR'));
  assert.ok(!equalFolded('resume', 'résumé'));
});

test('final sigma: a word ending in sigma folds the same as its capitals', () => {
  assert.equal(fold('ΟΔΟΣ'), fold('οδος'));
  assert.equal(fold('οδός'), fold('ΟΔΌΣ'));
});

test('graphemes: combining marks, CRLF, emoji with zero-width joiners, flags, skin tones and Hangul', () => {
  assert.deepEqual(graphemes('äb'), ['ä', 'b']);
  assert.deepEqual(graphemes('\r\n'), ['\r\n']);
  assert.equal(graphemeLength('👨‍👩‍👧‍👦'), 1, 'a family is one character');
  assert.equal([...'👨‍👩‍👧‍👦'].length, 7, 'but seven code points');
  assert.equal(graphemeLength('🇺🇸🇫🇷'), 2, 'regional indicators pair up');
  assert.equal(graphemeLength('👍🏽'), 1);
  assert.equal(graphemeLength('한'), 1, 'conjoining Hangul jamo make one syllable');
  assert.equal(graphemeLength('é́́'), 1);
  assert.deepEqual(graphemes(''), []);
});

test('UAX #29 GraphemeBreakTest samples: control and extend behaviour', () => {
  assert.deepEqual(graphemes(from('0020 0020')), [' ', ' '], '÷ 0020 ÷ 0020 ÷');
  assert.deepEqual(graphemes(from('0020 0308 0020')), [from('0020 0308'), ' '], '÷ 0020 × 0308 ÷ 0020 ÷');
  assert.deepEqual(graphemes(from('000D 0308')), ['\r', '̈'], 'a control is never joined to a mark');
  assert.deepEqual(graphemes(from('0061 200D 0062')), [from('0061 200D'), 'b'], 'ZWJ extends the cluster before it');
});

test('truncate never cuts a cluster and counts the ellipsis', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 6), 'hello…');
  assert.equal(truncate('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 2), '👨‍👩‍👧‍👦…');
  assert.equal(truncate('ééé', 2), 'é…');
  assert.throws(() => truncate('x', 0), /at least 1/);
  assert.equal(reverse('a👍🏽é'), 'é👍🏽a');
});

test('collation is by locale: German sorts a-umlaut with a, Swedish after z', () => {
  const list = ['z', 'ä', 'a'];
  assert.deepEqual(sortedFor('de', list), ['a', 'ä', 'z']);
  assert.deepEqual(sortedFor('sv', list), ['a', 'z', 'ä']);
  assert.deepEqual(sortedFor('en', ['b', 'A', 'a', 'B']), ['a', 'A', 'b', 'B']);
  assert.deepEqual(sortedFor('en', ['b', 'A', 'a', 'B'], { upperFirst: true }), ['A', 'a', 'B', 'b']);
});

test('collation options: natural numbers and sensitivity', () => {
  assert.deepEqual(sortedFor('en', ['file10', 'file2', 'file1'], { numeric: true }), ['file1', 'file2', 'file10']);
  assert.deepEqual(sortedFor('en', ['file10', 'file2', 'file1']), ['file1', 'file10', 'file2']);
  assert.equal(collator('en', { sensitivity: 'base' })('résumé', 'RESUME'), 0);
  assert.equal(collator('en', { sensitivity: 'accent' })('a', 'A'), 0);
  assert.notEqual(collator('en', { sensitivity: 'accent' })('a', 'á'), 0);
  assert.throws(() => collator('not a locale!'), /not a valid locale/);
});

test('scripts: single, mixed, and the allowed CJK combinations', () => {
  assert.deepEqual(scriptsOf('paypal-123'), ['Latin']);
  assert.deepEqual(scriptsOf('pаypal'), ['Cyrillic', 'Latin']);
  assert.equal(isMixedScript('pаypal'), true);
  assert.equal(isMixedScript('привет'), false);
  assert.equal(isMixedScript('東京タワーtokyo'), false, 'Japanese with Latin is normal');
  assert.equal(isMixedScript('東京한국'), false);
  assert.equal(isMixedScript('東京привет'), true);
  assert.equal(isMixedScript('abc-123_'), false, 'digits and punctuation are common');
  assert.deepEqual(scriptsOf('é'), ['Latin']);
});

test('skeletons: the classic look-alike attacks share the real name\'s skeleton', () => {
  const latin = 'paypal';
  const cyr = 'раураl';
  assert.notEqual(cyr, latin);
  assert.equal(skeleton(cyr), skeleton(latin));
  assert.ok(confusable('аpple', 'apple'));
  assert.ok(confusable('PAYPAL', 'paypal'));
  assert.ok(confusable('paypa1', 'paypal'), 'digit one for l');
  assert.ok(confusable('paypaI', 'paypal'), 'capital i for l');
  assert.ok(confusable('rnicrosoft', 'microsoft'), 'rn for m');
  assert.ok(confusable('ΑΒΕ', 'ABE'), 'Greek capitals');
  assert.ok(confusable('ｐａｙｐａｌ', 'paypal'), 'full-width');
  assert.ok(confusable('pay​pal', 'paypal'), 'zero-width space');
  assert.ok(!confusable('paypal', 'paypall'));
  assert.ok(!confusable('google', 'goggle'));
});

test('look-alike search finds the names a new one could impersonate, and not itself', () => {
  const existing = ['paypal', 'Alice', 'apple', 'bob'];
  assert.deepEqual(lookalikes('раураl', existing), ['paypal']);
  assert.deepEqual(lookalikes('paypal', existing), [], 'the same name is a duplicate, not a look-alike');
  assert.deepEqual(lookalikes('A1ice', existing), ['Alice']);
  assert.deepEqual(lookalikes('carol', existing), []);
});

test('identifier checks list every problem: invisible, direction controls, mixed scripts, spaces, length, marks', () => {
  assert.deepEqual(checkIdentifier('ana_silva'), []);
  assert.deepEqual(checkIdentifier('Ana', {}).length, 0);
  assert.deepEqual(checkIdentifier('').map((p) => p.code), ['empty']);
  assert.deepEqual(checkIdentifier('an​a').map((p) => p.code), ['invisible']);
  assert.deepEqual(checkIdentifier('an‮a').map((p) => p.code), ['bidi-control']);
  assert.deepEqual(checkIdentifier('pаypal').map((p) => p.code), ['mixed-script']);
  assert.deepEqual(checkIdentifier('éa').map((p) => p.code), ['not-normalised']);
  assert.deepEqual(checkIdentifier('a b').map((p) => p.code), ['whitespace']);
  assert.deepEqual(checkIdentifier('́a').map((p) => p.code), ['starts-with-mark']);
  assert.deepEqual(checkIdentifier('x'.repeat(65)).map((p) => p.code), ['too-long']);
  assert.deepEqual(checkIdentifier('x'.repeat(65), { maxGraphemes: 70 }), []);
  assert.deepEqual(checkIdentifier('\uE000').map((p) => p.code), ['unassigned-or-private']);
  assert.match(checkIdentifier('pаypal')[0]!.message, /Cyrillic, Latin/);
});
