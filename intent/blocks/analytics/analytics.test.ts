import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Analytics } from './index.ts';

const make = () => {
  let t = 0;
  const a = new Analytics({ consented: (id) => !id.startsWith('no'), key: 'k', allow: { '*': ['plan'], upload: ['size'] }, now: () => t });
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
