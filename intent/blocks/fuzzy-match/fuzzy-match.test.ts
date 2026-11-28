import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TooLong, TrigramIndex, allowedEdits, damerauLevenshtein, jaro, jaroWinkler, levenshtein, metaphone, normalise, osa, similarity, soundex, suggest, tokenSet, tokenSort, trigramSimilarity, trigrams } from './index.ts';

const close = (a: number, b: number, eps = 0.0001) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('Levenshtein: the textbook cases', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('flaw', 'lawn'), 2);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('same', 'same'), 0);
  assert.equal(levenshtein('Saturday', 'Sunday'), 3);
  assert.equal(levenshtein('😀a', '😀b'), 1, 'counts characters, not code units');
});

test('Levenshtein with a cut-off stops early and reports "more than max"', () => {
  assert.equal(levenshtein('kitten', 'sitting', 3), 3);
  assert.equal(levenshtein('kitten', 'sitting', 2), 3);
  assert.equal(levenshtein('abcdef', 'uvwxyz', 1), 2);
  assert.equal(levenshtein('a', 'abcdefgh', 2), 3);
});

test('the transposition cases that separate OSA from true Damerau-Levenshtein', () => {
  assert.equal(levenshtein('ca', 'abc'), 3);
  assert.equal(osa('ca', 'abc'), 3);
  assert.equal(damerauLevenshtein('ca', 'abc'), 2);
  assert.equal(damerauLevenshtein('teh', 'the'), 1);
  assert.equal(osa('teh', 'the'), 1);
  assert.equal(damerauLevenshtein('abcd', 'acbd'), 1);
  assert.equal(damerauLevenshtein('kitten', 'sitting'), 3);
  assert.equal(damerauLevenshtein('', ''), 0);
  assert.equal(damerauLevenshtein('abc', ''), 3);
});

test('Jaro and Jaro-Winkler published examples', () => {
  close(jaro('MARTHA', 'MARHTA'), 0.9444);
  close(jaroWinkler('MARTHA', 'MARHTA'), 0.9611);
  close(jaro('DIXON', 'DICKSONX'), 0.7667);
  close(jaroWinkler('DIXON', 'DICKSONX'), 0.8133);
  assert.equal(jaro('', ''), 1);
  assert.equal(jaro('abc', ''), 0);
  assert.equal(jaro('abc', 'xyz'), 0);
  assert.equal(jaroWinkler('same', 'same'), 1);
});

test('trigrams follow pg_trgm: two spaces before each word, one after', () => {
  assert.deepEqual([...trigrams('word')].sort(), ['  w', ' wo', 'ord', 'rd ', 'wor']);
  assert.deepEqual([...trigrams('cat dog')].sort(), ['  c', '  d', ' ca', ' do', 'at ', 'cat', 'dog', 'og ']);
  assert.deepEqual([...trigrams('Cat, DOG!')].sort(), [...trigrams('cat dog')].sort(), 'punctuation and case do not matter');
});

test('pg_trgm documentation values: similarity(word, two words) is 0.36363636', () => {
  close(trigramSimilarity('word', 'two words'), 0.36363636, 1e-7);
  assert.equal(trigramSimilarity('same', 'SAME'), 1);
  assert.equal(trigramSimilarity('abc', 'xyz'), 0);
  assert.equal(trigramSimilarity('', ''), 1);
});

test('Soundex: the standard vectors', () => {
  const v: [string, string][] = [['Robert', 'R163'], ['Rupert', 'R163'], ['Rubin', 'R150'], ['Ashcraft', 'A261'], ['Ashcroft', 'A261'], ['Tymczak', 'T522'], ['Pfister', 'P236'], ['Honeyman', 'H555'], ['Lee', 'L000'], ['Gutierrez', 'G362'], ['Jackson', 'J250']];
  for (const [w, k] of v) assert.equal(soundex(w), k, w);
  assert.equal(soundex(''), '');
  assert.equal(soundex('123'), '');
  assert.equal(soundex('Müller'), soundex('Muller'));
});

test('Metaphone: silent letters, ph, th, sh, and the sounds that share a key', () => {
  assert.equal(metaphone('Knight'), 'NT');
  assert.equal(metaphone('Phone'), 'FN');
  assert.equal(metaphone('Wright'), 'RT');
  assert.equal(metaphone('Shaw'), 'X');
  assert.equal(metaphone('Thing'), '0NK');
  assert.equal(metaphone('Xavier'), 'SFR');
  assert.equal(metaphone('Smith'), metaphone('Smyth'));
  assert.equal(metaphone('Science'), 'SNS');
  assert.equal(metaphone(''), '');
});

test('token sort: the same words in another order; token set: extra words do not hurt', () => {
  assert.equal(tokenSort('Smith, John', 'John Smith'), 1);
  assert.equal(tokenSort('new york mets', 'mets new york'), 1);
  assert.equal(tokenSet('John Smith', 'Smith, John Q. Public'), 1);
  assert.ok(tokenSet('John Smith', 'Jane Doe') < 0.4);
  assert.ok(tokenSort('John Smith', 'Jon Smith') > 0.85);
  assert.equal(tokenSet('', ''), 1);
});

test('similarity ignores case, accents and punctuation', () => {
  assert.equal(similarity('Café Münster', 'cafe  munster!'), 1);
  assert.equal(normalise('Straße—Nr. 5'), 'strasse nr 5');
  close(similarity('kitten', 'sitting'), 1 - 3 / 7);
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('abc', 'xyz'), 0);
});

test('the trigram index finds candidates ranked best first, and updates on change and removal', () => {
  const ix = new TrigramIndex();
  for (const [id, t] of [['1', 'Acme Corporation'], ['2', 'Acme Corp.'], ['3', 'Globex Industries'], ['4', 'Initech']] as const) ix.add(id, t);
  assert.equal(ix.size, 4);
  const hits = ix.search('acme corp', { threshold: 0.3 });
  assert.deepEqual(hits.map((h) => h.id), ['2', '1']);
  assert.equal(hits[0]!.score, 1);
  assert.deepEqual(ix.search('globex', { threshold: 0.3 }).map((h) => h.id), ['3']);
  assert.deepEqual(ix.search('zzzz'), []);
  ix.add('2', 'Totally Different');
  assert.deepEqual(ix.search('acme corp', { threshold: 0.3 }).map((h) => h.id), ['1']);
  ix.remove('1');
  assert.deepEqual(ix.search('acme corp', { threshold: 0.3 }), []);
  assert.equal(ix.search('industries', { limit: 1 }).length, 1);
});

test('allowed edits grow with the length of the word', () => {
  assert.deepEqual([3, 4, 6, 7, 10, 11].map(allowedEdits), [0, 1, 1, 2, 2, 3]);
});

test('suggestions: the typo, the swap, the prefix and the sound-alike are found and explained', () => {
  const names = ['Catherine', 'Katherine', 'Kathryn', 'Cathedral', 'Robert', 'Rupert', 'Smith', 'Smythe'];
  const s = suggest('Katharine', names);
  assert.equal(s[0]!.text, 'Katherine');
  assert.match(s[0]!.why.join(), /1 edit away/);
  assert.ok(s.some((x) => x.text === 'Catherine'));
  assert.ok(!s.some((x) => x.text === 'Robert'));
  assert.equal(suggest('Robrt', names)[0]!.text, 'Robert');
  assert.equal(suggest('Rbert', names)[0]!.text, 'Robert');
  assert.deepEqual(suggest('smith', names, { limit: 1 }).map((x) => [x.text, x.score]), [['Smith', 1]]);
  assert.ok(suggest('Smyth', names).some((x) => x.text === 'Smythe'));
  const pre = suggest('cathe', names);
  assert.ok(pre.map((x) => x.text).includes('Cathedral'));
  assert.match(pre.find((x) => x.text === 'Cathedral')!.why.join(), /starts with/);
});

test('suggestions: exact after folding scores 1, duplicates are not repeated, nothing is returned below the threshold', () => {
  assert.deepEqual(suggest('CAFÉ', ['cafe', 'cafe']), [{ text: 'cafe', score: 1, why: ['same after ignoring case, accents and punctuation'] }]);
  assert.deepEqual(suggest('qwerty', ['banana', 'orange']), []);
  assert.ok(suggest('qwerty', ['banana'], { threshold: 0 }).length === 1);
  assert.deepEqual(suggest('x', []), []);
});

test('suggestions with names in another order and with extras', () => {
  const r = suggest('smith john', ['John Smith', 'Jane Smith', 'Johnson']);
  assert.equal(r[0]!.text, 'John Smith');
  assert.match(r[0]!.why.join(), /different order/);
});

test('oversized input is refused before it can cost quadratic time', () => {
  const big = 'a'.repeat(10_001);
  assert.throws(() => levenshtein(big, 'a'), TooLong);
  assert.throws(() => damerauLevenshtein('a', big), TooLong);
  assert.throws(() => osa(big, big), TooLong);
  assert.throws(() => jaro(big, 'a'), TooLong);
  assert.throws(() => normalise(big), TooLong);
  assert.throws(() => similarity(big, 'a'), TooLong);
});
