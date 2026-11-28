import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watch } from './index.ts';

const DAY = 86_400_000;
const now = 100 * DAY;

test('each item gets the alert its kind and its date call for, most urgent first', () => {
  const a = watch([
    { what: 'zthr.ai certificate', kind: 'certificate', expiresAt: now + 20 * DAY, owner: 'ops' },
    { what: 'zthr.ai domain', kind: 'domain', expiresAt: now + 200 * DAY, owner: 'ops' },
    { what: 'deploy token', kind: 'token', expiresAt: now - 2 * DAY, owner: 'ops' },
    { what: 'signing key', kind: 'key', expiresAt: now + 10 * DAY, owner: 'ops' },
  ], now);
  assert.deepEqual(a.map((x) => [x.what, x.level]), [['deploy token', 'critical'], ['signing key', 'warn'], ['zthr.ai certificate', 'notice']]);
  assert.equal(a[0]!.text, 'deploy token expired 2 days ago');
});

test('an item no one owns is a finding of its own', () => {
  const a = watch([{ what: 'security.txt', kind: 'security contact', expiresAt: now + 365 * DAY }], now);
  assert.deepEqual(a.map((x) => x.text), ['security.txt has no owner to renew it']);
  assert.equal(watch([{ what: 't', kind: 'token', expiresAt: now + 1 * DAY + 1, owner: 'x' }], now)[0]!.text, 't expires in 1 day');
});
