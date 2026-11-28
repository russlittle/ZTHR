import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Consent } from './index.ts';

test('agreement is by version; a new version needing agreement makes it due again', () => {
  let now = new Date('2026-11-01T00:00:00Z');
  const c = new Consent(() => now);
  c.publish({ doc: 'terms', version: 1, effective: '2026-01-01', requiresAgreement: true, required: true, summary: 'first' });
  c.publish({ doc: 'marketing', version: 1, effective: '2026-01-01', requiresAgreement: true, required: false, summary: 'news' });
  assert.deepEqual(c.due('ana').map((v) => v.doc), ['terms']);
  c.agree('ana', 'terms', 'sign-up form');
  assert.deepEqual(c.due('ana'), []);
  assert.equal(c.allowed('ana', 'marketing'), false, 'optional consent defaults to no');
  c.publish({ doc: 'terms', version: 2, effective: '2026-12-01', requiresAgreement: true, required: true, summary: 'new fees' });
  assert.equal(c.allowed('ana', 'terms'), true, 'not due before the new version takes effect');
  now = new Date('2026-12-02T00:00:00Z');
  assert.deepEqual(c.standing('ana', 'terms'), { given: true, version: 1, current: false });
  c.agree('ana', 'terms', 'banner');
  assert.equal(c.standing('ana', 'terms').version, 2);
  c.publish({ doc: 'terms', version: 3, effective: '2026-12-01', requiresAgreement: false, required: true, summary: 'typo' });
  assert.equal(c.allowed('ana', 'terms'), true, 'a minor version does not ask again');
  assert.throws(() => c.publish({ doc: 'terms', version: 2, effective: '2027-01-01', requiresAgreement: false, required: true, summary: '' }), /already at version 3/);
});

test('withdrawing is a new record, as easy as giving; required terms cannot be withdrawn piecemeal', () => {
  const c = new Consent(() => new Date('2026-11-01T00:00:00Z'));
  c.publish({ doc: 'marketing', version: 1, effective: '2026-01-01', requiresAgreement: true, required: false, summary: '' });
  c.publish({ doc: 'terms', version: 1, effective: '2026-01-01', requiresAgreement: true, required: true, summary: '' });
  c.agree('ben', 'marketing', 'settings');
  assert.equal(c.allowed('ben', 'marketing'), true);
  c.withdraw('ben', 'marketing', 'one-click link');
  assert.equal(c.allowed('ben', 'marketing'), false);
  assert.deepEqual(c.history('ben').map((r) => r.given), [true, false], 'the earlier record is kept');
  assert.throws(() => c.withdraw('ben', 'terms', 'settings'), /closing the account/);
  assert.throws(() => c.agree('ben', 'cookies', 'banner'), /no version/);
});

test('a version number cannot be reused or go backwards while a newer version is still waiting to take effect', () => {
  const c = new Consent(() => new Date('2026-11-01T00:00:00Z'));
  c.publish({ doc: 'terms', version: 1, effective: '2026-01-01', requiresAgreement: true, required: true, summary: '' });
  c.publish({ doc: 'terms', version: 2, effective: '2026-12-01', requiresAgreement: true, required: true, summary: 'new fees' });
  assert.throws(() => c.publish({ doc: 'terms', version: 2, effective: '2026-12-15', requiresAgreement: false, required: true, summary: 'other' }), /already at version 2/);
});
