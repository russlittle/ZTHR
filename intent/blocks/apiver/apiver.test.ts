import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Versions } from './index.ts';

type User = Record<string, unknown>;
const v = new Versions(
  '2025-01-01',
  [
    { version: '2026-06-01', description: 'name split into display_name; email moved under contact', down: (b) => {
      const { display_name, contact, ...rest } = b as User;
      return { ...rest, name: display_name, email: (contact as User | undefined)?.email };
    } },
    { version: '2026-11-01', description: 'amounts are minor units, not decimals', paths: /^\/invoices/, down: (b) => ({ ...(b as User), amount: ((b as User).amount as number) / 100 }) },
  ],
  { lifecycle: [{ version: '2025-01-01', deprecated: '2026-06-01', sunset: '2026-12-31' }], notes: 'https://docs.example.org/changes' },
);

test('a pinned client gets the shape it was written for, through each change in turn', () => {
  const now = { id: 1, display_name: 'Ana', contact: { email: 'a@x.org' } };
  assert.deepEqual(v.render(now, '/users/1', '2026-11-01'), now);
  assert.deepEqual(v.render(now, '/users/1', '2025-01-01'), { id: 1, name: 'Ana', email: 'a@x.org' });
  assert.deepEqual(v.render({ amount: 1250 }, '/invoices/9', '2026-06-01'), { amount: 12.5 });
  assert.deepEqual(v.render({ amount: 1250 }, '/payouts/9', '2026-06-01'), { amount: 1250 }, 'the change only applies to its paths');
  assert.deepEqual(v.pick(undefined, '2026-06-01'), { version: '2026-06-01' });
  assert.deepEqual(v.pick(undefined), { version: '2026-11-01' });
  const bad = v.pick('2024-13-01');
  assert.ok('problem' in bad && bad.problem.status === 400);
});

test('deprecated versions say so with standard headers, and are refused after sunset; stragglers are listed', () => {
  const r = v.headers('2025-01-01', '2026-11-26');
  assert.ok('headers' in r);
  assert.equal(r.headers.deprecation, '@1780272000');
  assert.equal(r.headers.sunset, 'Thu, 31 Dec 2026 00:00:00 GMT');
  assert.match(r.headers.link!, /rel="deprecation"/);
  assert.deepEqual(v.headers('2026-11-01', '2026-11-26'), { headers: { 'api-version': '2026-11-01' } });
  const gone = v.headers('2025-01-01', '2026-12-31');
  assert.ok('problem' in gone && gone.problem.status === 410);
  assert.deepEqual(v.stragglers([{ account: 'b', version: '2025-01-01' }, { account: 'a', version: '2025-01-01' }, { account: 'a', version: '2026-11-01' }, { account: 'b', version: '2025-01-01' }]), { '2025-01-01': ['a', 'b'] });
  assert.throws(() => new Versions('2025-01-01', [{ version: '2025-01-01', description: '', down: (b) => b }], { notes: '' }), /share a version/);
});

test('a version with a sunset but no deprecation date still announces and enforces its sunset', () => {
  const w = new Versions('2025-01-01', [{ version: '2026-01-01', description: 'x', down: (b) => b }], { lifecycle: [{ version: '2025-01-01', sunset: '2026-12-31' }], notes: 'https://docs.example.org' });
  const r = w.headers('2025-01-01', '2026-11-26');
  assert.ok('headers' in r && r.headers.sunset === 'Thu, 31 Dec 2026 00:00:00 GMT');
  assert.equal('headers' in r && r.headers.deprecation, undefined);
  const gone = w.headers('2025-01-01', '2027-01-02');
  assert.ok('problem' in gone && gone.problem.status === 410);
});

test('lifecycle dates that are not dates, or name unknown versions, are refused up front', () => {
  assert.throws(() => new Versions('2025-01-01', [], { lifecycle: [{ version: '2025-01-01', deprecated: 'soon' }], notes: '' }), /not a date/);
  assert.throws(() => new Versions('2025-01-01', [], { lifecycle: [{ version: '2025-01-01', sunset: '2026-02-30' }], notes: '' }), /not a date/);
  assert.throws(() => new Versions('2025-01-01', [], { lifecycle: [{ version: '2024-01-01', deprecated: '2025-01-01' }], notes: '' }), /not a version/);
});
