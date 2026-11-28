import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Analytics } from './index.ts';

const make = () => {
  let t = 0;
  const a = new Analytics({ consented: (id) => !id.startsWith('no'), key: 'k', events: ['open', 'visit', 'signup', 'upload', 'constructor'], allow: { '*': ['plan'], upload: ['size'] }, now: () => t });
  return { a, at: (n: number) => (t = n) };
};

test('nothing is kept without consent, ids are pseudonymous, and only allowed properties survive', () => {
  const { a } = make();
  assert.equal(a.track('no-ana', 'open'), false);
  a.track('u1', 'upload', { size: 3, plan: 'pro', email: 'ana@x.org', note: { x: 1 } });
  assert.deepEqual(a.events[0]!.props, { size: 3, plan: 'pro' });
  assert.notEqual(a.events[0]!.who, 'u1');
  assert.equal(a.events[0]!.who, a.pseudonym('u1'));
  assert.deepEqual(a.dropped, { noConsent: 1, props: 2 });
  assert.equal(a.forget('u1'), 1);
  assert.equal(a.events.length, 0);
});

test('funnels count steps in order within a time limit, suppress small counts, and journeys show common paths', () => {
  const { a, at } = make();
  for (let i = 0; i < 10; i++) {
    at(i * 1000);
    a.track(`p${i}`, 'visit');
    if (i < 8) at(i * 1000 + 100), a.track(`p${i}`, 'signup');
    if (i < 5) at(i * 1000 + 200), a.track(`p${i}`, 'upload');
    if (i === 9) at(i * 1000 + 999_999), a.track(`p${i}`, 'signup');
  }
  at(50_000);
  a.track('p0', 'upload');
  assert.deepEqual(a.funnel(['visit', 'signup', 'upload'], 60_000), [
    { step: 'visit', people: 10 },
    { step: 'signup', people: 8, dropFromPrevious: 20 },
    { step: 'upload', people: 5, dropFromPrevious: 37.5 },
  ].map((x) => ({ dropFromPrevious: null, ...x })));
  assert.deepEqual(a.funnel(['visit', 'signup', 'upload'], 60_000, 6).map((x) => x.people), [10, 8, null], 'five is under the threshold');
  assert.deepEqual(a.journeys('visit', 3), [{ path: 'visit → signup → upload', people: 5 }]);
});

test('a heavy user does not make funnels quadratic', () => {
  const { a, at } = make();
  for (let i = 0; i < 40_000; i++) at(i), a.track('busy', 'visit');
  const t0 = performance.now();
  assert.deepEqual(a.funnel(['visit', 'signup'], 10_000_000, 1).map((x) => x.people), [1, null]);
  assert.ok(performance.now() - t0 < 2_000, `${Math.round(performance.now() - t0)} ms`);
});

test('event names that are also Object properties do not break tracking', () => {
  const { a } = make();
  assert.equal(a.track('u1', 'constructor', { plan: 'pro' }), true);
  assert.deepEqual(a.events[0]!.props, { plan: 'pro' });
});

test('only declared event names are recorded; any other is dropped and counted, never stored', () => {
  const { a } = make();
  assert.equal(a.track('u1', 'searched for ana@x.org'), false);
  assert.equal(a.track('u1', 'Upload'), false, 'names match exactly');
  assert.equal(a.track('u1', 'toString'), false, 'a name like an Object property is not declared by being one');
  assert.equal(a.track('u1', 'upload', { size: 1 }), true);
  assert.deepEqual(a.events.map((e) => e.name), ['upload']);
  assert.equal(a.unknownNames, 3);
  assert.doesNotMatch(JSON.stringify(a), /ana@x\.org/, 'the unknown name is not kept anywhere');
  assert.equal(new Analytics({ consented: () => true, key: 'k', events: [], allow: {} }).track('u1', 'visit'), false, 'an empty list records nothing');
});
