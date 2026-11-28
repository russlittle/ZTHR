import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffReadings, same } from '../src/diff.ts';
import { checkReading, type Reading } from '../src/frame.ts';
import { hitStatements, loadLexicon, resolveTerms } from '../src/lexicon.ts';

const base: Reading = {
  family: 'a',
  problem: 'students get their power shut off after missing bills',
  why: 'stay housed and in school',
  outcomes: ['no shut-off from a missed due date'],
  people: [{ name: 'student', side: 'primary' }],
  measures: [{ text: 'shut-offs avoided', tolerance: 'none in a term' }],
  constraints: ['never message during quiet hours'],
  nonGoals: [],
};

test('a reading must match the schema exactly, or it is not a reading', () => {
  assert.equal(checkReading(base).ok, true);
  const extra = checkReading({ ...base, mood: 'happy' });
  assert.equal(extra.ok, false);
  assert.deepEqual(!extra.ok && extra.problems, ['unexpected field mood']);
  const bad = checkReading({ ...base, measures: [{ text: 'x' }], people: [{ name: 'p', side: 'neither' }], outcomes: 'one' });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.problems.length, 3);
  assert.equal(checkReading(null).ok, false);
  assert.equal(checkReading([]).ok, false);
});

test('phrasings that carry the same meaning agree; different ones do not', () => {
  assert.equal(same('no shut-off from a missed due date', 'No shutoffs from missed due dates'), true);
  assert.equal(same('no shut off from a missed due date', 'no shut offs from missed due dates'), true);
  assert.equal(same('stay housed and in school', 'keep students in school'), false);
  assert.equal(same('', ''), true);
});

test('two readings that agree raise no question, and what they agree on is kept as an assumption from both families', () => {
  const r = diffReadings(base, { ...base, family: 'b' });
  assert.deepEqual(r.questions, []);
  assert.ok(r.agreed.every((s) => s.state === 'assumed' && s.supplied.kind === 'parse'));
  assert.deepEqual(r.agreed.map((s) => s.slot), ['problem', 'why', 'outcome', 'constraints', 'people', 'measures']);
});

test('each difference becomes one question, with both readings and what it protects', () => {
  const b: Reading = {
    ...base,
    family: 'b',
    why: 'avoid late fees',
    outcomes: ['no shut-off from a missed due date', 'staff see who is struggling'],
    measures: [{ text: 'shut-offs avoided', tolerance: 'fewer than last term' }],
  };
  const r = diffReadings(base, b);
  assert.deepEqual(
    r.questions.map((q) => [q.slot, q.choices]),
    [
      ['why', ['stay housed and in school', 'avoid late fees']],
      ['outcome', ['staff see who is struggling']],
      ['measures', ['none in a term', 'fewer than last term']],
    ],
  );
  assert.ok(r.questions.every((q) => q.protects.length > 0 && q.origin === 'diff'));
  assert.equal(r.questions[0]!.consequence, 'high');
});

test('two readings from the same family are refused', () => {
  assert.throws(() => diffReadings(base, base), /two families are required/);
});

test('the lexicon resolves human terms with the person\'s own words, once each, as assumptions', () => {
  const hits = resolveTerms(loadLexicon(), [
    { text: 'Make it feel calm, not scary.', origin: { path: 'rough.md', line: 3 } },
    { text: 'It should be snappy on a phone' },
    { text: 'Calm again here' },
  ]);
  assert.deepEqual(hits.map((h) => [h.term.term, h.words]), [
    ['calm', 'calm'],
    ['snappy', 'snappy'],
    ['on a phone', 'on a phone'],
  ]);
  assert.deepEqual(hits[0]!.origin, { path: 'rough.md', line: 3 });
  const st = hitStatements(hits);
  assert.ok(st.every((s) => s.state === 'assumed' && s.words));
  assert.ok(st.some((s) => s.slot === 'measures' && s.tolerance === 'within 100 milliseconds'));
  assert.match(st[0]!.text, /^"calm", read as soft colours/);
});

test('words the lexicon does not know resolve to nothing, never to a guess', () => {
  assert.deepEqual(resolveTerms(loadLexicon(), [{ text: 'It should sparkle like a geode' }]), []);
});

test('planted: a family name that is not a plain name makes the reading unknown', async () => {
  const { checkReading } = await import('../src/frame.ts');
  const r = { family: '<img src=x onerror=alert(1)>', problem: 'p', why: 'w', outcomes: [], people: [], measures: [], constraints: [], nonGoals: [] };
  assert.equal(checkReading(r).ok, false);
  assert.equal(checkReading({ ...r, family: 'gemini 2.5' }).ok, true);
});
