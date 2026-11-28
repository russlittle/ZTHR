import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Index, fold, snippet, stem, typedToward, words, type Doc } from './index.ts';

const idx = () => {
  const i = new Index({ weights: { title: 3, body: 1 } });
  i.add({ id: 'd1', fields: { title: 'Quarterly budget', body: 'The budget for the café renovation, approved by finance.' }, facets: { kind: 'doc', team: 'ops' } });
  i.add({ id: 'd2', fields: { title: 'Renovation photos', body: 'Photos of the cafe. Budget mentioned once.' }, facets: { kind: 'image', team: 'ops' } });
  i.add({ id: 'd3', fields: { title: 'Secret plans', body: 'budget budget budget' }, facets: { kind: 'doc', team: 'board' } });
  i.add({ id: 'd4', fields: { title: 'Holiday rota', body: 'Who is on call over the holidays.' }, facets: { kind: 'doc', team: 'ops' } });
  return i;
};
const all = () => true;

test('folding and stemming', () => {
  assert.equal(fold('Café ÉCOLE'), 'cafe ecole');
  assert.deepEqual(words('The cats, and the dogs!').map(stem), ['cat', 'dog']);
  assert.equal(stem('policies'), 'policy');
});

test('title matches outrank body matches; accents and plurals match; nothing the person cannot see comes back', () => {
  const i = idx();
  const r = i.search('budgets cafe ', { canSee: (id) => id !== 'd3', facets: ['kind'] });
  assert.deepEqual(r.hits.map((h) => h.id), ['d1', 'd2']);
  assert.deepEqual(r.facets, { kind: { doc: 1, image: 1 } });
  assert.match(r.hits[0]!.snippet, /<mark>budget<\/mark>/);
  assert.match(r.hits[0]!.snippet, /<mark>café<\/mark>/);
});

test('the last word matches as a prefix while typing; phrases match in order; filters narrow', () => {
  const i = idx();
  assert.deepEqual(i.search('holi', { canSee: all }).hits.map((h) => h.id), ['d4']);
  assert.deepEqual(i.search('holi ', { canSee: all }).hits.map((h) => h.id), [], 'a finished word is matched whole');
  assert.deepEqual(i.search('"budget for the cafe"', { canSee: all }).hits.map((h) => h.id), ['d1']);
  assert.deepEqual(i.search('"cafe budget"', { canSee: all }).hits.map((h) => h.id), ['d2']);
  assert.deepEqual(i.search('budget ', { canSee: all, filters: { kind: 'doc', team: 'ops' } }).hits.map((h) => h.id), ['d1']);
  i.remove('d1');
  assert.equal(i.size, 3);
  assert.deepEqual(i.search('quarterly ', { canSee: all }).hits, []);
  i.add({ id: 'd5', fields: { title: 'Pasted', body: '<script>alert(1)</script> invoice' } });
  const sn = i.search('invoice ', { canSee: all }).hits[0]!.snippet;
  assert.equal(sn.includes('<script>'), false);
  assert.match(sn, /&#60;script&#62;/);
});

test('the word being typed still matches as a prefix when an earlier word repeats', () => {
  const once = idx().search('budget quart', { canSee: all }).hits[0]!;
  const twice = idx().search('budget budgets quart', { canSee: all }).hits[0]!;
  assert.equal(twice.id, 'd1');
  assert.equal(twice.score, once.score, 'the same words, the same score');
});

test('the word being typed narrows the results like every other word', () => {
  assert.deepEqual(idx().search('budget holi', { canSee: all }).hits.map((h) => h.id), [], 'no document has budget and a word starting holi');
  assert.deepEqual(idx().search('budget quart', { canSee: all }).hits.map((h) => h.id), ['d1']);
});

test('a phrase must sit inside one field, not run from the end of the title into the body', () => {
  const i = new Index();
  i.add({ id: 'x', fields: { title: 'Annual budget', body: 'Review notes' } });
  assert.deepEqual(i.search('"budget review"', { canSee: all }).hits, []);
});

test('fields named like object properties are indexed with weight 1', () => {
  const i = new Index({ weights: { title: 2 } });
  i.add({ id: 'x', fields: { constructor: 'scaffold hire' } });
  const [h] = i.search('scaffold ', { canSee: all }).hits;
  assert.ok(h && Number.isFinite(h.score) && h.score > 0, String(h?.score));
});

test('a word typed past its stem keeps matching until it is finished ("budgete" on the way to "budgeted")', () => {
  const ids = (q: string) => idx().search(q, { canSee: all }).hits.map((h) => h.id).sort();
  const want = ['d1', 'd2', 'd3'];
  for (const q of ['budg', 'budget', 'budgete', 'budgeted']) assert.deepEqual(ids(q), want, q);
  assert.deepEqual(ids('budgetx'), [], 'not a way any ending starts');
  assert.match(idx().search('budgete', { canSee: all }).hits[0]!.snippet, /<mark>budget<\/mark>/i);
  const i = new Index();
  i.add({ id: 's', fields: { body: 'Case studies and classes' } });
  for (const q of ['studi', 'studie', 'classe']) assert.deepEqual(i.search(q, { canSee: all }).hits.map((h) => h.id), ['s'], q);
  assert.equal(typedToward('budgete', 'budget'), true);
  assert.equal(typedToward('budgetes', 'budget'), false, 'a whole ending typed is a finished word, stemmed as one');
});

test('facet values named like Object.prototype members are counted as plain values', () => {
  const i = new Index();
  const vals = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'constructor'];
  vals.forEach((v, n) => i.add({ id: `p${n}`, fields: { title: 'apple' }, facets: { kind: v } }));
  const c = i.search('apple', { canSee: () => true, facets: ['kind'] }).facets.kind!;
  assert.equal(Object.getOwnPropertyDescriptor(c, 'constructor')!.value, 2);
  for (const v of ['__proto__', 'toString', 'hasOwnProperty', 'valueOf']) assert.equal(Object.getOwnPropertyDescriptor(c, v)!.value, 1, v);
  assert.equal(Object.keys(c).length, 5);
});

/** BM25 worked out from the documents alone, so the index's scores can be checked against the definition. */
function bm25(docs: readonly Doc[], weights: Record<string, number>, terms: readonly string[], k1 = 1.2, b = 0.75): Map<string, number> {
  const tf = new Map<string, Map<string, number>>();
  const len = new Map<string, number>();
  for (const d of docs) {
    let n = 0;
    for (const [f, text] of Object.entries(d.fields)) {
      for (const t of words(text).map(stem)) {
        const m = tf.get(t) ?? new Map<string, number>();
        m.set(d.id, (m.get(d.id) ?? 0) + (weights[f] ?? 1));
        tf.set(t, m);
        n++;
      }
    }
    len.set(d.id, n);
  }
  const N = docs.length;
  const avg = [...len.values()].reduce((x, y) => x + y, 0) / N;
  const out = new Map<string, number>();
  for (const t of terms) {
    const posting = tf.get(t);
    if (!posting) continue;
    const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
    for (const [id, f] of posting) out.set(id, (out.get(id) ?? 0) + (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * len.get(id)!) / avg)));
  }
  return out;
}

const corpus: Doc[] = [
  { id: 'a', fields: { title: 'Budget review', body: 'The budget notes for the quarter planning meeting and the budget timeline.' } },
  { id: 'b', fields: { title: 'Roadmap', body: 'Budget and timeline, with notes.' } },
  { id: 'c', fields: { title: 'Lunch menu', body: 'Soup salad bread cheese olives and a long list of other things to eat on the day.' } },
  { id: 'd', fields: { title: 'Budget', body: '' } },
  { id: 'e', fields: { title: 'Overruns', body: 'Budgetary overrun, budgetary risk.' } },
];
const W = { title: 3 };
const built = (docs: readonly Doc[] = corpus) => {
  const i = new Index({ weights: W, k1: 1.5, b: 0.6 });
  for (const d of docs) i.add(d);
  return i;
};
const scoresOf = (i: Index, q: string) => new Map(i.search(q, { canSee: all, limit: 100 }).hits.map((h) => [h.id, h.score] as const));
const sameScores = (got: Map<string, number>, want: Map<string, number>, msg: string) => {
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `${msg}: same documents`);
  for (const [id, w] of want) assert.ok(Math.abs(got.get(id)! - w) < 1e-9, `${msg}: ${id} scored ${got.get(id)}, BM25 says ${w}`);
};

const only = (m: Map<string, number>, ids: string[]) => new Map([...m].filter(([id]) => ids.includes(id)));

test('scores are BM25: idf, weighted term frequency, length against the average, k1 and b', () => {
  const i = built();
  sameScores(scoresOf(i, 'budget '), only(bm25(corpus, W, ['budget'], 1.5, 0.6), ['a', 'b', 'd']), 'one word');
  sameScores(scoresOf(i, 'budget notes '), only(bm25(corpus, W, ['budget', stem('notes')], 1.5, 0.6), ['a', 'b']), 'two words');
  const plain = new Index();
  for (const d of corpus) plain.add(d);
  sameScores(scoresOf(plain, 'budget '), only(bm25(corpus, {}, ['budget']), ['a', 'b', 'd']), 'default weights, k1 and b');
});

test('removing a document leaves the index scoring as if it had never been added; adding it again changes nothing', () => {
  const extra: Doc = { id: 'z', fields: { title: 'Zebra', body: 'a very long body of text about budget budget and many many other unrelated things' } };
  const i = built();
  i.add(extra);
  i.remove('z');
  assert.equal(i.size, corpus.length);
  sameScores(scoresOf(i, 'budget '), only(bm25(corpus, W, ['budget'], 1.5, 0.6), ['a', 'b', 'd']), 'after remove');
  const j = built();
  j.add(corpus[0]!);
  j.add(corpus[0]!);
  assert.equal(j.size, corpus.length);
  sameScores(scoresOf(j, 'budget '), only(bm25(corpus, W, ['budget'], 1.5, 0.6), ['a', 'b', 'd']), 'after adding a document twice');
  j.remove('nobody');
  assert.equal(j.size, corpus.length);
  sameScores(scoresOf(j, 'budget '), only(bm25(corpus, W, ['budget'], 1.5, 0.6), ['a', 'b', 'd']), 'after removing a stranger');
});

test('removing one document does not take a shared word away from the others', () => {
  const i = built();
  i.remove('a');
  assert.deepEqual(i.search('budget ', { canSee: all }).hits.map((h) => h.id).sort(), ['b', 'd']);
  i.remove('b');
  i.remove('d');
  assert.deepEqual(i.search('budget ', { canSee: all }).hits, []);
  assert.deepEqual(i.search('budgetary ', { canSee: all }).hits.map((h) => h.id), ['e']);
});

test('a word being typed scores as the words it can become, no others', () => {
  const i = built();
  const typed = scoresOf(i, 'budg');
  sameScores(typed, only(bm25(corpus, W, ['budget', 'budgetary'], 1.5, 0.6), ['a', 'b', 'd', 'e']), 'budg');
  sameScores(scoresOf(i, 'budgets'), only(bm25(corpus, W, ['budget'], 1.5, 0.6), ['a', 'b', 'd']), 'a typed plural is its stem, whole');
  sameScores(scoresOf(i, 'notes budg'), only(bm25(corpus, W, [stem('notes'), 'budget', 'budgetary'], 1.5, 0.6), ['a', 'b']), 'a finished word and one being typed');
});

test('a word typed again is a finished word, the same as with a space after it', () => {
  const i = new Index();
  i.add({ id: 'p', fields: { title: 'Budget notes', body: 'budgetary risk' } });
  i.add({ id: 'q', fields: { title: 'Budget notes', body: 'other things entirely' } });
  i.add({ id: 'r', fields: { title: 'Lunch', body: 'budgetary menu' } });
  for (const [typed, done] of [['budget budget', 'budget budget '], ['budgets budget', 'budgets budget '], ['"budget notes" budget', '"budget notes" budget '], ['"budget notes" budgets', '"budget notes" budgets ']]) {
    const t = i.search(typed!, { canSee: all });
    const d = i.search(done!, { canSee: all });
    assert.ok(d.hits.length > 0, done);
    assert.deepEqual(t.hits.map((h) => h.id), d.hits.map((h) => h.id), typed);
    sameScores(new Map(t.hits.map((h) => [h.id, h.score] as const)), new Map(d.hits.map((h) => [h.id, h.score] as const)), String(typed));
  }
  assert.deepEqual(i.search('budget budget', { canSee: all }).hits.map((h) => h.id), ['p', 'q'], 'budgetary is not budget');
  assert.deepEqual(i.search('budget budg', { canSee: all }).hits.map((h) => h.id), ['p', 'q'], 'a different word being typed is still a prefix');
  assert.deepEqual(i.search('"budget notes" thin', { canSee: all }).hits.map((h) => h.id), ['q'], 'and so is one typed after a phrase');
  assert.deepEqual(i.search('"budget notes" thin ', { canSee: all }).hits.map((h) => h.id), [], 'until it is finished');
});

test('what the person is allowed to see is all they get back, in the hits, the total and the facets', () => {
  const i = new Index();
  i.add({ id: 'p', fields: { title: 'Plan' }, facets: { kind: 'doc' } });
  i.add({ id: 'q', fields: { title: 'Plan' }, facets: { kind: 'doc' } });
  const r = i.search('plan ', { canSee: (id) => id !== 'p', facets: ['kind'] });
  assert.deepEqual(r.hits.map((h) => h.id), ['q']);
  assert.equal(r.total, 1);
  assert.deepEqual(r.facets, { kind: { doc: 1 } });
  assert.deepEqual(i.search('plan ', { canSee: () => false }).hits, []);
});

test('every word of a finished query is required, the last one included', () => {
  const r = idx().search('budget cafe ', { canSee: all });
  assert.deepEqual(r.hits.map((h) => h.id), ['d1', 'd2'], 'd3 has budget but not cafe');
});

test('a document without facets is simply not in a filter, and is counted under no facet', () => {
  const i = idx();
  i.add({ id: 'bare', fields: { title: 'Budget bare' } });
  const r = i.search('budget ', { canSee: all, filters: { kind: 'doc' }, facets: ['kind', 'constructor', 'toString'] });
  assert.deepEqual(r.hits.map((h) => h.id).sort(), ['d1', 'd3']);
  assert.deepEqual(r.facets, { kind: { doc: 2 }, constructor: {}, toString: {} });
  assert.deepEqual(i.search('budget ', { canSee: all, facets: ['kind'] }).facets, { kind: { doc: 2, image: 1 } }, 'bare is counted nowhere');
  assert.deepEqual(i.search('budget ', { canSee: all }).facets, {}, 'no facets asked for, none given');
});

test('a facet with an empty value is not counted, and counts stay ordinary properties', () => {
  const i = new Index();
  i.add({ id: 'x', fields: { title: 'thing' }, facets: { kind: '' } });
  i.add({ id: 'y', fields: { title: 'thing' }, facets: { kind: 'a' } });
  i.add({ id: 'z', fields: { title: 'thing' }, facets: { kind: 'a' } });
  const c = i.search('thing ', { canSee: all, facets: ['kind'] }).facets.kind!;
  assert.deepEqual(Object.keys(c), ['a']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(c, 'a'), { value: 2, writable: true, enumerable: true, configurable: true });
});

test('results come best score first, equal scores in id order, and no more than the limit (twenty unless told)', () => {
  const i = new Index();
  i.add({ id: 'c', fields: { title: 'plan' } });
  i.add({ id: 'a', fields: { title: 'plan' } });
  i.add({ id: 'low', fields: { title: 'plan', body: 'one two three four five six seven eight' } });
  i.add({ id: 'high', fields: { title: 'plan plan plan' } });
  i.add({ id: 'b', fields: { title: 'plan' } });
  const r = i.search('plan ', { canSee: all });
  assert.deepEqual(r.hits.map((h) => h.id), ['high', 'a', 'b', 'c', 'low']);
  const two = i.search('plan ', { canSee: all, limit: 2 });
  assert.deepEqual(two.hits.map((h) => h.id), ['high', 'a']);
  assert.equal(two.total, 5, 'the total is of all matches, not of the page');
  const big = new Index();
  for (let n = 0; n < 25; n++) big.add({ id: `n${String(n).padStart(2, '0')}`, fields: { title: 'plan' } });
  const page = big.search('plan ', { canSee: all });
  assert.equal(page.hits.length, 20);
  assert.equal(page.total, 25);
  assert.equal(big.search('plan ', { canSee: all, limit: 0 }).hits.length, 0);
});

test('a quoted phrase is taken out of the words around it, even when nothing separates them', () => {
  const ids = (q: string) => idx().search(q, { canSee: all }).hits.map((h) => h.id);
  assert.deepEqual(ids('photos"cafe budget"renovation '), ['d2']);
  assert.deepEqual(ids('renovation "cafe budget" photos '), ['d2']);
});

test('a query ending in a closing quote is finished: its last plain word is not a prefix', () => {
  const i = new Index();
  i.add({ id: 'one', fields: { body: 'catalog of big dog photos' } });
  i.add({ id: 'two', fields: { body: 'cat and big dog photos' } });
  assert.deepEqual(i.search('cat "big dog"', { canSee: all }).hits.map((h) => h.id), ['two']);
  assert.deepEqual(i.search('cat "big dog" ', { canSee: all }).hits.map((h) => h.id), ['two']);
  assert.deepEqual(i.search('cat', { canSee: all }).hits.map((h) => h.id).sort(), ['one', 'two'], 'while typing, cat is a prefix');
});

test('a query that is only a phrase has no word being typed, so nothing but the phrase is marked', () => {
  const i = new Index();
  i.add({ id: 'x', fields: { body: 'cat catalog' } });
  assert.equal(i.search('"cat"!', { canSee: all }).hits[0]!.snippet, '<mark>cat</mark> catalog');
  assert.equal(i.search('"cat" ', { canSee: all }).hits[0]!.snippet, '<mark>cat</mark> catalog');
});

test('a filter leaves out documents that have no facets at all', () => {
  const i = new Index();
  i.add({ id: 'bare', fields: { title: 'plan' } });
  i.add({ id: 'tagged', fields: { title: 'plan' }, facets: { kind: 'doc' } });
  assert.deepEqual(i.search('plan ', { canSee: all, filters: { kind: 'doc' } }).hits.map((h) => h.id), ['tagged']);
});

test('the endings the stemmer takes off need three letters left', () => {
  assert.equal(stem('ties'), 'tie');
  assert.equal(stem('goes'), 'goe');
  assert.equal(stem('pies'), 'pie');
  assert.equal(stem('ring'), 'ring');
  assert.equal(stem('bus'), 'bus');
  assert.equal(stem('studies'), 'study');
  assert.equal(stem('glasses'), 'glass');
  assert.equal(stem('quickly'), 'quick');
});

test('typedToward: a typed word must start with the stem, and be on its way to a real ending', () => {
  assert.equal(typedToward('cate', 'cat'), true, 'a three-letter stem is enough');
  assert.equal(typedToward('xxxxxxe', 'budget'), false, 'the typed word has to start with the stem');
  assert.equal(typedToward('studie', 'study'), true);
  assert.equal(typedToward('bleedl', 'bleed'), false, 'bleedly stems to ble, so bleedl is not on the way to the word bleed');
  assert.equal(typedToward('budgetx', 'budget'), false);
  assert.equal(typedToward('budget', 'budget'), true);
  assert.equal(typedToward('budg', 'budget'), true);
});

test('a snippet marks the words that matched and nothing else, a word with punctuation stuck to it counts as the word', () => {
  const marks = new Set(['budget', 'q3']);
  assert.equal(snippet('Sign off the (budget), then q3, plan.', marks), 'Sign off the <mark>(budget),</mark> then <mark>q3,</mark> plan.');
  assert.equal(snippet('Café budget', new Set(['cafe'])), '<mark>Café</mark> budget');
  assert.equal(snippet('Budget cafe', new Set(), 'budg'), '<mark>Budget</mark> cafe', 'a word being typed marks words that start with it');
  assert.equal(snippet('the budget cafe', new Set(), 'get'), 'the budget cafe', 'and not words that merely end with it');
  assert.equal(snippet('Budget cafe', new Set(), 'budgete'), '<mark>Budget</mark> cafe', 'or the word it is on the way to');
  assert.equal(snippet('Budget cafe', new Set()), 'Budget cafe');
  assert.equal(snippet('x — y', new Set(['x'])), '<mark>x</mark> — y');
});

test('a snippet joins the fields with a dash and escapes what it was given', () => {
  const i = new Index();
  i.add({ id: 'f', fields: { title: 'Alpha', body: 'beta <b>bold</b> & "quoted"' } });
  assert.equal(i.search('alpha ', { canSee: all }).hits[0]!.snippet, '<mark>Alpha</mark> — beta &#60;b&#62;bold&#60;/b&#62; &#38; &#34;quoted&#34;');
});

test('a snippet with no word to mark still shows the start of the text', () => {
  const i = new Index();
  i.add({ id: 'h', fields: { body: 'a well-known fact' } });
  assert.equal(i.search('known ', { canSee: all }).hits[0]!.snippet, 'a well-known fact');
  assert.equal(snippet('nothing marked here', new Set(['absent'])), 'nothing marked here');
});

test('a snippet opens about a third of its width before the first match, and says so', () => {
  const text = `${'word '.repeat(30)}needle tail`;
  assert.equal(snippet(text, new Set(['needle'])), `…${'word '.repeat(11)}<mark>needle</mark> tail`);
  assert.equal(snippet('needle first', new Set(['needle'])), '<mark>needle</mark> first', 'a match at the start needs no lead-in');
  assert.equal(snippet('word needle', new Set(['needle'])), 'word <mark>needle</mark>', 'a short lead-in is shown whole');
});

test('a snippet stops at its width and says so; text that fits is shown whole', () => {
  assert.equal(snippet(`needle${' word'.repeat(60)}`, new Set(['needle'])), `<mark>needle</mark>${' word'.repeat(31)}…`);
  assert.equal(snippet(`needle${' word'.repeat(30)}    tail`, new Set(['needle'])), `<mark>needle</mark>${' word'.repeat(30)}…`, 'a cut that lands on white space is trimmed');
  assert.equal(snippet(`needle${' word'.repeat(20)}`, new Set(['needle'])), `<mark>needle</mark>${' word'.repeat(20)}`);
  assert.equal(snippet(`needle${' word'.repeat(30)}   x`, new Set(['needle']), undefined, 200), `<mark>needle</mark>${' word'.repeat(30)}   x`, 'the width can be asked for');
});

test('runs of white space are one gap when working out how much lead-in to show', () => {
  const text = `${'word          '.repeat(8)}needle`;
  assert.equal(snippet(text, new Set(['needle'])), `…${'word          '.repeat(4)}<mark>needle</mark>`);
});

test('a snippet that reaches back to the very start of the text has nothing left out, so no ellipsis', () => {
  assert.equal(snippet(`${'word '.repeat(11)}needle tail`, new Set(['needle'])), `${'word '.repeat(11)}<mark>needle</mark> tail`);
  assert.equal(snippet(`${'word '.repeat(12)}needle tail`, new Set(['needle'])), `…${'word '.repeat(11)}<mark>needle</mark> tail`);
});

test('the white space before a match counts toward the snippet width, run of spaces or not', () => {
  const gap = ' '.repeat(20);
  const text = `word${gap}word${gap}word${gap}needle${' word'.repeat(40)}`;
  assert.equal(snippet(text, new Set(['needle'])), `…word${gap}word${gap}<mark>needle</mark>${' word'.repeat(17)}…`);
});
