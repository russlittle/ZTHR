import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatchBook, MatchError, ProviderDown, RateLimited, TwinProvider, comparable, rank, score, type Candidate, type Query, type TwinRecord } from './index.ts';

const CATALOGUE: TwinRecord[] = [
  { provider: 'x', id: 'm1', kind: 'movie', title: 'The Matrix', year: 1999, creators: ['Lana Wachowski', 'Lilly Wachowski'], runtimeMin: 136, popularity: 0.9, externalIds: { imdb: 'tt0133093' }, fields: { overview: 'A hacker learns the truth.' } },
  { provider: 'x', id: 'm2', kind: 'movie', title: 'The Matrix Reloaded', year: 2003, creators: ['Lana Wachowski'], runtimeMin: 138 },
  { provider: 'x', id: 'm3', kind: 'movie', title: 'The Matrix Revolutions', year: 2003, runtimeMin: 129 },
  { provider: 'x', id: 'm4', kind: 'movie', title: 'Matrix', year: 1993 },
  { provider: 'x', id: 'a1', kind: 'movie', title: 'Alien', year: 1979, creators: ['Ridley Scott'] },
  { provider: 'x', id: 'a2', kind: 'movie', title: 'Aliens', year: 1986, creators: ['James Cameron'] },
  { provider: 'x', id: 'a3', kind: 'movie', title: 'Alien 3', year: 1992, creators: ['David Fincher'] },
  { provider: 'x', id: 'a4', kind: 'movie', title: 'Alien: Resurrection', year: 1997 },
  { provider: 'x', id: 'h1', kind: 'movie', title: 'Heat', year: 1995, creators: ['Michael Mann'] },
  { provider: 'x', id: 'h2', kind: 'movie', title: 'Heat', year: 1986, creators: ['Dick Richards'] },
  { provider: 'x', id: 'am', kind: 'movie', title: 'Amélie', aliases: ["Le Fabuleux Destin d'Amélie Poulain"], year: 2001 },
  { provider: 'x', id: 'b1', kind: 'album', title: 'Kind of Blue', year: 1959, creators: ['Miles Davis'] },
  { provider: 'x', id: 'b2', kind: 'album', title: 'Blue', year: 1971, creators: ['Joni Mitchell'] },
];
const twin = () => new TwinProvider('x', CATALOGUE);
const movie = (title: string, o: Partial<Query> = {}): Query => ({ kind: 'movie', title, ...o });
const cand = (id: string): Candidate => CATALOGUE.find((c) => c.id === id)!;
const book = () => new MatchBook({ now: () => 5000 });

test('titles compare without case, accents, punctuation or a leading article', () => {
  assert.equal(comparable('The Matrix'), 'matrix');
  assert.equal(comparable('  AMÉLIE!! '), 'amelie');
  assert.equal(comparable('Der Untergang'), 'untergang');
  assert.equal(score(movie('matrix'), cand('m1')).parts.title, 1);
  assert.equal(score(movie('THE MATRIX!'), cand('m1')).parts.title, 1);
});

test('a clear match is automatic and says why', () => {
  const { ranked, decision } = rank(movie('The Matrix', { year: 1999 }), CATALOGUE.filter((c) => c.kind === 'movie'));
  assert.equal(decision.kind, 'auto');
  assert.equal(ranked[0]!.candidate.id, 'm1');
  assert.ok(ranked[0]!.score >= 0.98, String(ranked[0]!.score));
  assert.deepEqual(ranked[0]!.reasons, ['title is the same', 'same year']);
  assert.ok(ranked[1]!.score < 0.8, 'the sequels are well behind');
});

test('two films with the same title go to a person, until the year or a creator settles it', () => {
  const movies = CATALOGUE.filter((c) => c.kind === 'movie');
  const bare = rank(movie('Heat'), movies);
  assert.equal(bare.decision.kind, 'review');
  assert.deepEqual(bare.decision.kind === 'review' ? bare.decision.options.map((o) => o.candidate.id) : [], ['h1', 'h2']);
  const withYear = rank(movie('Heat', { year: 1995 }), movies);
  assert.equal(withYear.decision.kind, 'auto');
  assert.equal(withYear.decision.kind === 'auto' && withYear.decision.best.candidate.id, 'h1');
  const withDirector = rank(movie('Heat', { creators: ['Michael Mann'] }), movies);
  assert.equal(withDirector.decision.kind, 'auto');
  assert.equal(withDirector.decision.kind === 'auto' && withDirector.decision.best.candidate.id, 'h1');
  assert.equal(rank(movie('Matrix'), movies).decision.kind, 'review', '"Matrix" is exactly two titles once the article is ignored');
});

test('a different sequel number counts against a match', () => {
  const movies = CATALOGUE.filter((c) => c.kind === 'movie');
  const a3 = rank(movie('Alien 3', { year: 1992 }), movies);
  assert.equal(a3.decision.kind === 'auto' && a3.decision.best.candidate.id, 'a3');
  const a1 = rank(movie('Alien', { year: 1979 }), movies);
  assert.equal(a1.decision.kind === 'auto' && a1.decision.best.candidate.id, 'a1');
  assert.ok(score(movie('Alien'), cand('a3')).score < score(movie('Alien'), cand('a1')).score);
  assert.ok(score(movie('Alien 3'), cand('a1')).reasons.some((r) => r.includes('the number differs')));
});

test('aliases, a missing subtitle and reordered words still match', () => {
  const movies = CATALOGUE.filter((c) => c.kind === 'movie');
  const alias = rank(movie("Le Fabuleux Destin d'Amelie Poulain", { year: 2001 }), movies);
  assert.equal(alias.decision.kind === 'auto' && alias.decision.best.candidate.id, 'am');
  assert.ok(alias.ranked[0]!.reasons[0]!.startsWith('matches the alias'));
  const part = score(movie('Resurrection', { year: 1997 }), cand('a4'));
  assert.equal(part.parts.title, 0.9);
  assert.ok(part.reasons[0]!.includes('part of the title'));
  assert.ok(score(movie('Reloaded Matrix'), cand('m2')).parts.title! >= 0.95, 'words in another order');
});

test('year tolerance: one year off still matches, three off never matches without a person', () => {
  const movies = CATALOGUE.filter((c) => c.kind === 'movie');
  assert.equal(rank(movie('The Matrix', { year: 2000 }), movies).decision.kind, 'auto');
  const far = rank(movie('The Matrix', { year: 2002 }), movies);
  assert.equal(far.decision.kind, 'review');
  assert.ok(far.ranked.find((r) => r.candidate.id === 'm1')!.score <= 0.7, 'three years off is capped');
  assert.equal(score(movie('The Matrix', { year: 2001 }), cand('m1')).parts.year, 0.3);
});

test('an outside id that matches is certain; another kind never matches; nothing plausible is none', () => {
  const s = score({ kind: 'movie', title: 'zzz unrelated', externalIds: { imdb: 'TT0133093' } }, cand('m1'));
  assert.deepEqual([s.score, s.reasons], [1, ['the imdb id TT0133093 matches']]);
  const r = rank({ kind: 'movie', title: 'whatever', externalIds: { imdb: 'tt0133093' } }, CATALOGUE.filter((c) => c.kind === 'movie'));
  assert.equal(r.decision.kind === 'auto' && r.decision.best.candidate.id, 'm1');
  assert.equal(score({ kind: 'album', title: 'The Matrix' }, cand('m1')).score, 0);
  assert.equal(rank(movie('Zzzzzz'), CATALOGUE).decision.kind, 'none');
  assert.equal(rank(movie('The Matrix'), []).decision.kind, 'none');
  const wrongId = score({ kind: 'movie', title: 'The Matrix', externalIds: { imdb: 'tt9999999' } }, cand('m1'));
  assert.ok(wrongId.score > 0.9 && !wrongId.reasons.some((r) => r.includes(' id ')), 'a different id does not rule it out, the file may be tagged wrongly');
});

test('creators and runtime add evidence only when both sides have them', () => {
  assert.equal(score(movie('Heat', { creators: ['michael mann'] }), cand('h1')).parts.creators, 1);
  assert.ok(score(movie('Heat', { creators: ['Dick Richards'] }), cand('h1')).parts.creators! < 0.5);
  assert.equal(score(movie('The Matrix', { runtimeMin: 138 }), cand('m1')).parts.runtime, 1, 'within 5%');
  assert.equal(score(movie('The Matrix', { runtimeMin: 120 }), cand('m1')).parts.runtime, 0.6);
  assert.equal(score(movie('The Matrix', { runtimeMin: 60 }), cand('m1')).parts.runtime, 0);
  assert.equal(score(movie('The Matrix'), cand('m1')).parts.year, undefined);
  assert.equal(score(movie('Matrix', { year: 1999 }), cand('m4')).parts.year, 0, 'a year both sides have is compared even when far apart');
});

test('searching records an automatic match, asks for review, or leaves it unmatched', async () => {
  const b = book();
  const p = twin();
  const a = await b.match('/movies/matrix.mkv', movie('The Matrix', { year: 1999 }), p);
  assert.deepEqual([a.status, a.status === 'matched' && a.match.state, a.status === 'matched' && a.match.id], ['matched', 'auto', 'm1']);
  const r = await b.match('/movies/heat.mkv', movie('Heat'), p);
  assert.equal(r.status, 'review');
  assert.deepEqual(r.status === 'review' && r.match.options!.map((o) => o.candidate.id), ['h1', 'h2']);
  const n = await b.match('/movies/zz.mkv', movie('Qqqq'), p);
  assert.equal(n.status, 'unmatched');
  assert.equal(b.get('/movies/heat.mkv')!.state, 'review');
  assert.deepEqual(b.history('/movies/matrix.mkv').map((h) => h.what.split(' ')[0]), ['auto']);
});

test('a person’s choice is final: it is never searched again, and rejecting a candidate keeps it out', async () => {
  const b = book();
  const p = twin();
  await b.match('heat', movie('Heat'), p);
  b.choose('heat', { provider: 'x', id: 'h2' }, 'ann');
  const kept = await b.match('heat', movie('Heat', { year: 1995 }), p);
  assert.equal(kept.status, 'kept');
  assert.equal(kept.status === 'kept' && kept.match.id, 'h2');
  assert.equal(p.searches.length, 1, 'no second search');
  assert.throws(() => b.reject('heat', { provider: 'x', id: 'h2' }, 'ann'), /choose another first/);
  b.clear('heat');
  const again = await b.match('heat', movie('Heat', { year: 1995 }), p);
  assert.equal(again.status, 'matched');
  b.reject('heat', { provider: 'x', id: 'h1' }, 'ann');
  assert.equal(b.get('heat')!.state, 'unmatched', 'the automatic match is withdrawn');
  const noH1 = await b.match('heat', movie('Heat', { year: 1995 }), p);
  assert.notEqual(noH1.status === 'matched' && noH1.match.id, 'h1', 'a rejected candidate is not picked again');
  b.choose('heat', { provider: 'x', id: 'h1' }, 'ann');
  assert.equal(b.get('heat')!.id, 'h1', 'a person can still choose it');
});

test('rate limits and outages come back as outcomes, and change nothing', async () => {
  const b = book();
  const p = twin();
  p.failNext(new RateLimited(5000), new ProviderDown('503'));
  assert.deepEqual(await b.match('m', movie('The Matrix', { year: 1999 }), p), { status: 'retry', afterMs: 5000 });
  assert.deepEqual(await b.match('m', movie('The Matrix', { year: 1999 }), p), { status: 'down', why: '503' });
  assert.equal(b.get('m')!.state, 'unmatched');
  assert.equal((await b.match('m', movie('The Matrix', { year: 1999 }), p)).status, 'matched');
  p.failNext(new RateLimited(1));
  await assert.rejects(() => b.match('x', movie('Q'), { ...p, name: 'x', search: () => Promise.reject(new TypeError('bug')), get: p.get.bind(p) }), TypeError, 'a bug is not hidden as an outage');
});

test('a refresh changes only what is not locked and not edited here', async () => {
  const b = book();
  const p = twin();
  await b.match('m', movie('The Matrix', { year: 1999 }), p);
  const first = await b.refreshFrom('m', p);
  assert.deepEqual(first, { applied: ['overview', 'title', 'year'], keptLocked: [], keptLocal: [] });
  assert.equal(b.fields('m').overview, 'A hacker learns the truth.');
  b.edit('m', 'overview', 'My own summary');
  p.correct('m1', { overview: 'Reworded by the provider', title: 'The Matrix (1999)' });
  const second = await b.refreshFrom('m', p);
  assert.deepEqual(second, { applied: ['title'], keptLocked: ['overview'], keptLocal: [] });
  assert.deepEqual([b.fields('m').overview, b.fields('m').title], ['My own summary', 'The Matrix (1999)']);
  assert.deepEqual(b.locks('m'), { all: false, fields: ['overview'] });
  b.unlock('m', 'overview');
  p.correct('m1', { overview: 'Reworded again' });
  const third = await b.refreshFrom('m', p);
  assert.deepEqual(third, { applied: [], keptLocked: [], keptLocal: ['overview'] }, 'a local change since the last refresh is kept');
  assert.equal(await b.refreshFrom('nothing', p), undefined);
});

test('a manual choice locks everything against refresh until it is unlocked', async () => {
  const b = book();
  const p = twin();
  b.choose('m', { provider: 'x', id: 'm1' }, 'ann');
  assert.deepEqual(b.locks('m'), { all: true, fields: [] });
  const r = await b.refreshFrom('m', p);
  assert.deepEqual(r, { applied: [], keptLocked: ['overview', 'title', 'year'], keptLocal: [] });
  assert.deepEqual(b.fields('m'), {});
  assert.throws(() => b.unlock('m', 'title'), /unlock all/);
  b.unlock('m');
  assert.deepEqual((await b.refreshFrom('m', p))!.applied, ['overview', 'title', 'year']);
  const c = book();
  c.choose('n', { provider: 'x', id: 'm1' }, 'ann', { lock: ['title'] });
  assert.deepEqual((await c.refreshFrom('n', p))!.applied, ['overview', 'year'], 'only the named field is locked');
});

test('hostile input is refused', async () => {
  const b = book();
  assert.throws(() => b.edit('', 'f', 1), MatchError);
  assert.throws(() => b.edit('m', '__proto__', 1), /not a field/);
  assert.throws(() => b.choose('x'.repeat(501), { provider: 'x', id: 'm1' }, 'ann'), /1 to 500/);
  b.choose('m', { provider: 'x', id: 'm1' }, 'ann');
  assert.throws(() => b.refresh('m', { id: 'other', updated: '', fields: {} }), /matched to m1/);
  assert.doesNotThrow(() => b.refresh('m', { id: 'm1', updated: '', fields: JSON.parse('{"__proto__": 1}') as Record<string, unknown> }));
  assert.deepEqual(b.fields('m'), {});
  assert.throws(() => comparable('x'.repeat(10_001)), /10,000/);
});
