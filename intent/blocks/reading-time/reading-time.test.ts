import assert from 'node:assert/strict';
import { test } from 'node:test';
import { count, excerpt, imageSeconds, InvalidInput, label, listeningTime, readingTime, speedFor, stripHtml } from './index.ts';

const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ');

test('English words are counted by word, with contractions, numbers and hyphens handled', () => {
  assert.equal(count('The quick brown fox').words, 4);
  assert.equal(count("Don't stop, it's 3.5 o'clock").words, 5);
  assert.equal(count('well-known fact').words, 3, 'a hyphenated word is two words by the Unicode rules');
  assert.equal(count('').words, 0);
  assert.equal(count('   \n\t ').words, 0);
  assert.equal(count('... --- !!!').words, 0, 'punctuation is not a word');
});

test('Chinese and Japanese are counted in characters, Thai in words', () => {
  const zh = count('我喜欢读书，也喜欢写作。');
  assert.equal(zh.cjk, 10);
  assert.equal(zh.words, 0);
  const ja = count('私は本を読みます');
  assert.equal(ja.cjk, 8);
  const mixed = count('Hello 世界 and 你好 friends');
  assert.deepEqual({ w: mixed.words, c: mixed.cjk }, { w: 3, c: 4 });
  const th = count('ฉันรักภาษาไทย', { locale: 'th' });
  assert.ok(th.words >= 2 && th.words <= 4, `Thai words found by dictionary, got ${th.words}`);
  assert.equal(th.cjk, 0);
  assert.equal(count('한국어 문장').cjk, 5, 'Hangul syllables count as characters');
});

test('reading time follows the language speed and rounds to whole minutes, never zero for something', () => {
  assert.equal(readingTime(words(238)).seconds, 60);
  assert.equal(readingTime(words(238)).minutes, 1);
  assert.equal(readingTime(words(238 * 5)).minutes, 5);
  assert.equal(readingTime(words(10)).minutes, 1, 'a short text still takes a minute on the badge');
  assert.equal(readingTime('').minutes, 0);
  assert.equal(readingTime(words(179), { locale: 'de' }).seconds, 60, 'German is slower per word');
  assert.equal(readingTime(words(100), { wordsPerMinute: 100 }).seconds, 60, 'a measured speed overrides the default');
  assert.equal(speedFor('fr-CA').words, 214);
  assert.equal(speedFor('xx').words, 238, 'unknown languages use the English speed');
});

test('CJK reading time uses characters per minute and mixed text adds the two', () => {
  const zh = '字'.repeat(255);
  assert.equal(readingTime(zh, { locale: 'zh' }).seconds, 60);
  assert.equal(readingTime('あ'.repeat(357), { locale: 'ja' }).seconds, 60);
  assert.equal(readingTime(`${words(238)} ${zh}`, { locale: 'zh' }).seconds, 120);
});

test('images add twelve seconds for the first, one less each, three at the least', () => {
  assert.equal(imageSeconds(0), 0);
  assert.equal(imageSeconds(1), 12);
  assert.equal(imageSeconds(3), 12 + 11 + 10);
  assert.equal(imageSeconds(10), 12 + 11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3);
  assert.equal(imageSeconds(12), imageSeconds(10) + 6, 'floor of three seconds');
  const html = `<p>${words(238)}</p><img src="a.png"><img src="b.png">`;
  const t = readingTime(html, { html: true });
  assert.equal(t.images, 2);
  assert.equal(t.seconds, 60 + 12 + 11);
  assert.equal(readingTime('<img src="x">', { html: true }).minutes, 1, 'a picture alone is something');
});

test('markup is not read: tags, scripts, styles and comments are dropped and entities decoded', () => {
  const html = '<h1>Title</h1><script>var a = "many many words here";</script><style>p{color:red}</style><!-- hidden comment --><p>Tom &amp; Jerry&nbsp;ran &#8212; fast &#x263A;</p>';
  assert.equal(stripHtml(html).replace(/\s+/g, ' ').trim(), 'Title Tom & Jerry ran — fast ☺');
  assert.equal(count(html, { html: true }).words, 5);
  assert.equal(stripHtml('&#xD800; &#0; &unknown;'), '&#xD800; &#0; &unknown;', 'invalid references stay as written');
  assert.equal(stripHtml('a<b>c</b>d'), 'acd', 'inline tags do not split words');
});

test('listening time uses a speaking rate and ignores images', () => {
  const t = listeningTime(`<p>${words(150)}</p><img src="a">`, { html: true });
  assert.equal(t.seconds, 60);
  assert.equal(t.minutes, 1);
  assert.equal(listeningTime(words(300), { wordsPerMinute: 200 }).seconds, 90);
  assert.equal(label({ ...t, minutes: 5 }), '5 min read');
  assert.equal(label(readingTime('')), '');
  assert.equal(label({ ...t, minutes: 1 }, { one: 'minute', other: 'minutes' }), '1 minute');
});

test('bad speeds and oversized input are refused', () => {
  assert.throws(() => readingTime('a b', { wordsPerMinute: 0 }), InvalidInput);
  assert.throws(() => readingTime('a b', { wordsPerMinute: -5 }), InvalidInput);
  assert.throws(() => readingTime('a b', { wordsPerMinute: Number.NaN }), InvalidInput);
  assert.throws(() => count('x'.repeat(20_000_001)), /longer than/);
  assert.throws(() => count(42 as unknown as string), InvalidInput);
  assert.throws(() => excerpt('abc', { maxChars: 0 }), InvalidInput);
});

test('an excerpt of a short text is the whole text, whitespace tidied', () => {
  assert.deepEqual(excerpt('  Hello \n\n  world.  '), { text: 'Hello world.', truncated: false, cutAt: 'none' });
  assert.deepEqual(excerpt('x'.repeat(160)), { text: 'x'.repeat(160), truncated: false, cutAt: 'none' });
});

test('an excerpt ends at a sentence when one fits late enough, otherwise at a word', () => {
  const text = 'The first sentence is here. The second sentence runs on and on past any sensible limit for a card.';
  const a = excerpt(text, { maxChars: 50 });
  assert.deepEqual(a, { text: 'The first sentence is here.…', truncated: true, cutAt: 'sentence' });
  const b = excerpt(text, { maxChars: 40, sentenceFrom: 0.9 });
  assert.equal(b.cutAt, 'word');
  assert.equal(b.text, 'The first sentence is here. The second…');
  assert.ok([...b.text].length <= 40);
  assert.equal(excerpt('One two three four five six seven', { maxChars: 15, ellipsis: '...' }).text, 'One two...');
});

test('an excerpt never splits a word, a combining accent or an emoji, and never exceeds the limit', () => {
  const text = 'café \u{1F468}‍\u{1F469}‍\u{1F467} family photo of the whole group';
  for (let n = 2; n < 30; n++) {
    const e = excerpt(text, { maxChars: n });
    assert.ok([...new Intl.Segmenter().segment(e.text)].length <= n, `${n}: ${e.text}`);
    assert.doesNotMatch(e.text, /[\ud800-\udbff]$|‍$|́$(?<!é)/u);
    const body = e.text.replace(/…$/u, '');
    assert.ok(text.startsWith(body.trimEnd()), `${n} is a prefix: ${e.text}`);
  }
  assert.equal(excerpt(text, { maxChars: 5 }).text, 'café…', 'the accent stays with its letter');
});

test('one long unbroken word is cut on a character boundary; CJK is cut by character', () => {
  const e = excerpt('a'.repeat(100), { maxChars: 10 });
  assert.deepEqual(e, { text: 'a'.repeat(9) + '…', truncated: true, cutAt: 'character' });
  const z = excerpt('我喜欢读书，也喜欢写作，每天都读很多书。', { maxChars: 8, sentenceFrom: 1 });
  assert.equal(z.truncated, true);
  assert.equal([...z.text].length, 8);
  assert.equal(z.cutAt, 'character');
});

test('maxWords limits words, and HTML excerpts are cut from the plain text', () => {
  const e = excerpt('<p>One two <b>three</b> four five six</p>', { html: true, maxWords: 4, maxChars: 200, sentenceFrom: 1 });
  assert.deepEqual(e, { text: 'One two three four…', truncated: true, cutAt: 'word' });
  assert.equal(excerpt('One two three', { maxWords: 3 }).truncated, false);
  const z = excerpt('一二三四五六七八九十', { maxWords: 4, maxChars: 100 });
  assert.equal(z.text, '一二三四…');
});
