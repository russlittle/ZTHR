import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BpeTokenizer, TokenCountError, VENDORS, countMessages, estimate, estimator, fitMessages, parseTiktokenRanks, promptBudget, truncate, upperBound } from './index.ts';

const bytesKey = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));
const vocabText = (merges: string[]) => {
  const lines: string[] = [];
  for (let b = 0; b < 256; b++) lines.push(`${Buffer.from([b]).toString('base64')} ${b}`);
  merges.forEach((m, i) => lines.push(`${Buffer.from(m).toString('base64')} ${256 + i}`));
  return lines.join('\n');
};
const ranks = (merges: string[]) => parseTiktokenRanks(vocabText(merges));

test('the byte bound is the UTF-8 length and no estimate exceeds it', () => {
  assert.equal(upperBound(''), 0);
  assert.equal(upperBound('abc'), 3);
  assert.equal(upperBound('é'), 2);
  assert.equal(upperBound('日本'), 6);
  assert.equal(upperBound('😀'), 4);
  for (const t of ['a', 'hello world', '日本語のテキスト', '😀😀😀', '12345678901234567890', '\n\n\n']) {
    for (const v of Object.keys(VENDORS)) assert.ok(estimate(t, v) <= upperBound(t), `${v} on ${JSON.stringify(t)}`);
  }
});

test('estimates for plain English land near four characters a token and grow with the text', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog while the rain keeps falling on the quiet town.';
  const n = estimate(sentence, 'openai-o200k');
  assert.ok(n >= 15 && n <= 25, `got ${n}`);
  assert.equal(estimate('', 'anthropic'), 0);
  assert.equal(estimate('a', 'anthropic'), 1);
  assert.ok(estimate(sentence.repeat(3), 'anthropic') > estimate(sentence, 'anthropic') * 2.9);
  assert.equal(estimate('hello', 'generic'), 2, 'five letters at four a token round up to two');
});

test('vendor tables differ, digits and CJK cost what the table says, and a margin pads', () => {
  assert.equal(estimate('1234567890', 'openai-o200k'), 4, 'ten digits in groups of three');
  assert.equal(estimate('1234567890', 'gemini'), 10, 'one token a digit');
  assert.equal(estimate('日本語', 'anthropic'), 4, 'three CJK characters at 1.3 each, rounded up');
  assert.equal(estimate('日本語', 'openai-o200k'), 3, '2.4 rounds up to 3');
  const base = estimate('a longer sentence with several words in it', 'llama3');
  assert.equal(estimate('a longer sentence with several words in it', 'llama3', { safetyMargin: 0.5 }), Math.ceil(base * 1.5) > base ? Math.ceil(base * 1.5) : base);
  assert.throws(() => estimate('x', 'nope'), (e: unknown) => e instanceof TokenCountError && /known: openai-o200k/.test(e.message));
  assert.equal(estimator('anthropic')('hello world'), estimate('hello world', 'anthropic'));
});

test('tiktoken vocabulary text parses to byte keys and refuses bad lines', () => {
  const r = ranks(['th']);
  assert.equal(r.get(bytesKey('th')), 256);
  assert.equal(r.get('A'), 65);
  assert.equal(r.size, 257);
  assert.throws(() => parseTiktokenRanks('not base64 ranks'), /line 1/);
  assert.throws(() => parseTiktokenRanks('QQ== 1\nQQ== 2'), /repeats/);
});

test('BPE merges by lowest rank: "the the" is [the, space, the]; swapping ranks changes the split', () => {
  const t = new BpeTokenizer(ranks(['th', 'he', 'the']));
  assert.deepEqual(t.encode('the'), [258]);
  assert.deepEqual(t.encode('the the'), [258, 32, 258]);
  assert.deepEqual(new BpeTokenizer(ranks(['th', 'he'])).encode('the'), [256, 101], 'th has the lower rank, so it merges first');
  assert.deepEqual(new BpeTokenizer(ranks(['he', 'th'])).encode('the'), [116, 256], 'he has the lower rank, so th can no longer form');
  assert.equal(t.count('the the'), 3);
});

test('BPE round-trips text, including multi-byte characters split across tokens', () => {
  const t = new BpeTokenizer(ranks(['th', 'he', 'the']));
  for (const s of ['', 'the', ' the  the\n', 'héllo wörld', '日本語 😀', 'a\r\nb']) assert.equal(t.decode(t.encode(s)), s, JSON.stringify(s));
  assert.deepEqual(t.encode('é'), [195, 169]);
  assert.equal(t.decode([195]), '�', 'half a character decodes to the replacement mark rather than throwing');
  assert.throws(() => t.decode([9999]), /not a token/);
});

test('special tokens: refused in user text unless allowed, then counted as one', () => {
  const t = new BpeTokenizer(ranks(['th']), { special: { '<|end|>': 1000 } });
  assert.throws(() => t.encode('hi <|end|> there'), /special token/);
  assert.deepEqual(t.encode('a<|end|>b', { allowSpecial: ['<|end|>'] }), [97, 1000, 98]);
  assert.equal(t.decode([97, 1000, 98]), 'a<|end|>b');
  assert.throws(() => new BpeTokenizer(ranks([]), { special: { '<|x|>': 65 } }), /reuses rank/);
});

test('a vocabulary without every single byte is refused', () => {
  const m = new Map<string, number>([['a', 0]]);
  assert.throws(() => new BpeTokenizer(m), /lacks the single byte 0/);
  assert.throws(() => new BpeTokenizer(ranks([]), { split: /x/u }), /g flag/);
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const count = estimator('generic');

test('truncate keeps a head, tail or both ends within the budget, and says when it did nothing', () => {
  const text = words(200);
  assert.deepEqual(truncate('short', 50, { count }), { text: 'short', tokens: count('short'), truncated: false });
  for (const strategy of ['head', 'tail', 'middle'] as const) {
    const r = truncate(text, 40, { count, strategy, marker: ' ... ' });
    assert.ok(r.tokens <= 40, `${strategy} fits: ${r.tokens}`);
    assert.equal(r.tokens, count(r.text));
    assert.equal(r.truncated, true);
  }
  assert.ok(truncate(text, 40, { count, strategy: 'head' }).text.startsWith('word0 word1'));
  assert.ok(truncate(text, 40, { count, strategy: 'tail' }).text.endsWith('word199'));
  const mid = truncate(text, 40, { count, strategy: 'middle', marker: ' ... ' }).text;
  assert.ok(mid.startsWith('word0') && mid.endsWith('word199') && mid.includes(' ... '));
});

test('truncate snaps to a word, sentence or paragraph and never ends mid-word when asked not to', () => {
  const text = 'One fish two fish. Red fish blue fish. Black fish blue fish. Old fish new fish.';
  const sent = truncate(text, 20, { count: upperBound, boundary: 'sentence' });
  assert.equal(sent.text, 'One fish two fish.');
  assert.equal(truncate(text, 14, { count: upperBound, boundary: 'sentence' }).text, 'One fish two', 'no whole sentence fits, so it falls back to a word');
  const word = truncate('alpha beta gamma delta', 13, { count: upperBound, boundary: 'word' });
  assert.equal(word.text, 'alpha beta');
  const para = truncate('First paragraph here.\n\nSecond paragraph is here.\n\nThird.', 50, { count: upperBound, boundary: 'paragraph' });
  assert.equal(para.text, 'First paragraph here.\n\nSecond paragraph is here.');
  assert.equal(truncate('alpha beta gamma', 12, { count: upperBound, strategy: 'tail', boundary: 'word' }).text, 'beta gamma');
});

test('truncate never splits a surrogate pair, and a zero budget or a huge marker gives empty text', () => {
  const r = truncate('😀😀😀😀', 8, { count: upperBound });
  assert.equal(r.text, '😀😀');
  assert.doesNotMatch(r.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.equal(truncate('abc', 0, { count: upperBound }).text, '');
  assert.equal(truncate('a'.repeat(100), 3, { count: upperBound, marker: ' [cut here] ' }).text, '');
  assert.throws(() => truncate('x', -1, { count: upperBound }), TokenCountError);
  assert.throws(() => truncate('x', Number.NaN, { count: upperBound }), TokenCountError);
});

test('fitMessages drops the oldest turns, keeps system and the last message, and counts the chat overhead', () => {
  const msgs = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'a'.repeat(40) },
    { role: 'assistant', content: 'b'.repeat(40) },
    { role: 'user', content: 'c'.repeat(40) },
    { role: 'assistant', content: 'd'.repeat(40) },
    { role: 'user', content: 'latest question' },
  ];
  const o = { count: upperBound, perMessage: 4, perReply: 3 };
  assert.equal(countMessages(msgs, o), 16 + 40 * 4 + 15 + 6 * 4 + 3);
  const r = fitMessages(msgs, 100, o);
  assert.deepEqual(r.messages.map((m) => m.content[0]), ['Y', 'd', 'l'], 'room for one middle message: the newest');
  assert.equal(r.dropped, 3);
  assert.equal(r.shortened, false);
  assert.ok(r.tokens <= 100);
  assert.equal(fitMessages(msgs, 10_000, o).dropped, 0);
});

test('fitMessages shortens the last message from the middle only when nothing else can go', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: words(100) }];
  const o = { count: upperBound, perMessage: 2, perReply: 1 };
  const r = fitMessages(msgs, 80, o);
  assert.equal(r.shortened, true);
  assert.equal(r.messages[0]!.content, 'sys');
  assert.ok(r.tokens <= 80, `fits: ${r.tokens}`);
  assert.ok(r.messages[1]!.content.startsWith('word0') && r.messages[1]!.content.endsWith('word99') && r.messages[1]!.content.includes('[...]'));
  assert.deepEqual(fitMessages([], 5, o), { messages: [], tokens: 1, dropped: 0, shortened: false });
});

test('promptBudget leaves room for the answer and refuses nonsense', () => {
  assert.equal(promptBudget(8000, 1000), 7000);
  assert.throws(() => promptBudget(1000, 1000), /no room/);
  assert.throws(() => promptBudget(0, 0), TokenCountError);
  assert.throws(() => promptBudget(1000.5, 1), TokenCountError);
  assert.ok(VENDORS['gemini']!.contextWindow > VENDORS['anthropic']!.contextWindow);
});
