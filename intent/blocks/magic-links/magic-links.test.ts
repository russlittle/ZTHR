import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Limited, MagicLinks, MemoryStore, NotValid, maskSubject } from './index.ts';
import type { Ask } from './index.ts';

const SECRET = 'long-enough-0123456';
let seed = 0;
const det = (n: number) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  return b;
};
const make = (o: Partial<ConstructorParameters<typeof MagicLinks>[0]> = {}) => {
  const t = { now: 1_000_000 };
  const store = new MemoryStore();
  const m = new MagicLinks({ secret: SECRET, now: () => t.now, store, random: det, ...o });
  return { m, t, store };
};
const ask = (o: Partial<Ask> = {}): Ask => ({ subject: 'ana@example.org', purpose: 'sign-in', device: 'dev-1', address: '203.0.113.5', ...o });
const reason = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof NotValid, String(e));
    return e.reason;
  }
  return 'ok';
};

test('a link is issued, redeemed once, and says who and what it was for', () => {
  const { m, t } = make();
  const l = m.issue(ask({ context: { next: '/inbox' } }));
  assert.match(l.secret, /^[A-Za-z0-9_-]{43}$/, '256 bits, url-safe');
  assert.equal(l.expiresAt, 1_000_000 + 15 * 60_000);
  t.now += 1000;
  assert.deepEqual(m.redeem(l.secret, 'sign-in', 'dev-1', '198.51.100.1'), { subject: 'ana@example.org', purpose: 'sign-in', context: { next: '/inbox' }, issuedAt: 1_000_000 });
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-1', '198.51.100.1')), 'used', 'one time only');
});

test('the store holds hashes, never the token, the code or the device id', () => {
  const { m, store } = make();
  const l = m.issue(ask());
  const c = m.issue(ask({ subject: 'bo@example.org', kind: 'code' }));
  const dump = JSON.stringify(store.all());
  assert.ok(!dump.includes(l.secret));
  assert.ok(!dump.includes(c.secret));
  assert.ok(!dump.includes('dev-1'));
  assert.equal(store.all().length, 2);
});

test('expiry: good up to the last millisecond, refused at the limit', () => {
  const { m, t } = make({ linkTtlMs: 60_000 });
  const l = m.issue(ask());
  t.now += 59_999;
  assert.equal(reason(() => m.peek(l.secret, 'sign-in', 'dev-1', 'a')), 'ok');
  t.now += 1;
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-1', 'a')), 'expired');
});

test('a token made for one purpose does not work for another, and is not spent by the attempt', () => {
  const { m } = make();
  const l = m.issue(ask({ purpose: 'sign-in' }));
  assert.equal(reason(() => m.redeem(l.secret, 'delete-account', 'dev-1', 'a')), 'wrong_purpose');
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-1', 'a')), 'ok');
});

test('device binding: another browser is refused, and a stolen link attempt does not spend it', () => {
  const { m } = make();
  const l = m.issue(ask());
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-2', 'attacker')), 'wrong_device');
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-1', 'owner')), 'ok');
});

test('peek spends nothing, so a mail scanner opening the link does no harm, and it masks the address', () => {
  const { m } = make();
  const l = m.issue(ask());
  for (let i = 0; i < 3; i++) assert.deepEqual(m.peek(l.secret, 'sign-in', 'dev-1', 'scanner'), { subject: 'a***@example.org', purpose: 'sign-in' });
  assert.equal(reason(() => m.redeem(l.secret, 'sign-in', 'dev-1', 'person')), 'ok');
  assert.equal(reason(() => m.peek(l.secret, 'sign-in', 'dev-1', 'scanner')), 'used');
  assert.equal(maskSubject('x'), 'x***');
  assert.equal(maskSubject('ana.lopez@example.org'), 'a***@example.org');
});

test('asking again replaces the earlier link; only the newest works', () => {
  const { m, t } = make({ perSubject: { burst: 5, perSecond: 1 } });
  const first = m.issue(ask());
  t.now += 1000;
  const second = m.issue(ask());
  assert.equal(reason(() => m.redeem(first.secret, 'sign-in', 'dev-1', 'a')), 'revoked');
  assert.equal(reason(() => m.redeem(second.secret, 'sign-in', 'dev-1', 'a')), 'ok');
  const other = m.issue(ask({ purpose: 'verify-email' }));
  m.issue(ask());
  assert.equal(reason(() => m.redeem(other.secret, 'verify-email', 'dev-1', 'a')), 'ok', 'another purpose is left alone');
});

test('the email address is compared as a person would: case and spaces do not make a second account', () => {
  const { m } = make();
  const l = m.issue(ask({ subject: '  Ana@Example.ORG ' }));
  assert.equal(m.redeem(l.secret, 'sign-in', 'dev-1', 'a').subject, 'ana@example.org');
});

test('a code is six digits, zero-padded, uniform, and checked against that person only', () => {
  const { m } = make({ random: () => Buffer.from([0, 0, 0, 42]) });
  const c = m.issue(ask({ kind: 'code' }));
  assert.equal(c.secret, '000042');
  assert.equal(reason(() => m.redeemCode('bo@example.org', '000042', 'sign-in', 'dev-1', 'a')), 'unknown', 'not another person\'s');
  assert.equal(reason(() => m.redeemCode('ana@example.org', '000042', 'sign-in', 'dev-1', 'a')), 'ok');
  assert.equal(reason(() => m.redeemCode('ana@example.org', '000042', 'sign-in', 'dev-1', 'a')), 'unknown', 'spent');
  assert.equal(c.expiresAt, 1_000_000 + 10 * 60_000);
});

test('modulo bias is avoided: values from the uneven tail of the range are redrawn', () => {
  const draws = [Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0, 0, 0x03, 0xe9])];
  let i = 0;
  const { m } = make({ random: (n) => (n === 4 ? draws[Math.min(i++, 1)]! : det(n)) });
  assert.equal(m.issue(ask({ kind: 'code' })).secret, '001001', '4294967295 is in the tail (it would favour low digits) and is thrown away; 1001 mod 10^6 is kept');
});

test('a code dies after five wrong guesses, even if the right one follows', () => {
  const { m } = make({ random: () => Buffer.from([0, 0, 0, 7]) });
  const c = m.issue(ask({ kind: 'code' }));
  for (let i = 0; i < 4; i++) assert.equal(reason(() => m.redeemCode('ana@example.org', '111111', 'sign-in', 'dev-1', 'a')), 'unknown');
  assert.equal(reason(() => m.redeemCode('ana@example.org', '222222', 'sign-in', 'dev-1', 'a')), 'locked');
  assert.equal(reason(() => m.redeemCode('ana@example.org', c.secret, 'sign-in', 'dev-1', 'a')), 'unknown', 'the right code no longer opens it');
  assert.equal(reason(() => m.redeemCode('ana@example.org', '12ab56', 'sign-in', 'dev-1', 'a')), 'unknown', 'not even digits');
});

test('a code is bound to the device that asked too', () => {
  const { m } = make();
  const c = m.issue(ask({ kind: 'code' }));
  assert.equal(reason(() => m.redeemCode('ana@example.org', c.secret, 'sign-in', 'dev-9', 'a')), 'wrong_device');
  assert.equal(reason(() => m.redeemCode('ana@example.org', c.secret, 'sign-in', 'dev-1', 'a')), 'ok');
});

test('asking is throttled per person and per address, and the refusal says how long to wait', () => {
  const { m, t } = make();
  for (let i = 0; i < 3; i++) m.issue(ask({ address: `10.0.0.${i}` }));
  assert.throws(() => m.issue(ask({ address: '10.0.0.9' })), (e: Limited) => e instanceof Limited && e.retryAfterMs === 60_000);
  m.issue(ask({ subject: 'bo@example.org', address: '10.0.0.9' }));
  t.now += 60_000;
  m.issue(ask({ address: '10.0.0.9' }));
  const burst = make({ perAddress: { burst: 2, perSecond: 0.01 } }).m;
  burst.issue(ask({ subject: 'a@x.org', address: 'same' }));
  burst.issue(ask({ subject: 'b@x.org', address: 'same' }));
  assert.throws(() => burst.issue(ask({ subject: 'c@x.org', address: 'same' })), /from this address/);
});

test('an address that keeps presenting invalid tokens is cut off, even for good ones', () => {
  const { m } = make({ failuresPerAddress: { limit: 3, windowMs: 60_000 } });
  const good = m.issue(ask());
  for (let i = 0; i < 3; i++) assert.equal(reason(() => m.redeem(`guess-${i}`, 'sign-in', 'dev-1', 'bad')), 'unknown');
  assert.throws(() => m.redeem(good.secret, 'sign-in', 'dev-1', 'bad'), Limited);
  assert.equal(reason(() => m.redeem(good.secret, 'sign-in', 'dev-1', 'fine')), 'ok');
});

test('a token that is nearly right, or of another shape, finds nothing', () => {
  const { m } = make();
  const l = m.issue(ask());
  for (const bad of [l.secret.slice(0, -1) + (l.secret.endsWith('A') ? 'B' : 'A'), l.secret + 'A', '', ' ' + l.secret]) assert.equal(reason(() => m.redeem(bad, 'sign-in', 'dev-1', 'a')), 'unknown');
});

test('one message for every failure, so the page does not tell a guesser which part was right', () => {
  const { m } = make();
  const l = m.issue(ask());
  const messages = new Set<string>();
  for (const f of [() => m.redeem('nope', 'sign-in', 'dev-1', 'x'), () => m.redeem(l.secret, 'other', 'dev-1', 'x'), () => m.redeem(l.secret, 'sign-in', 'dev-2', 'x')])
    try {
      f();
    } catch (e) {
      messages.add((e as Error).message);
    }
  assert.equal(messages.size, 1);
});

test('revoke cancels what is outstanding for a person; sweep forgets what is long done', () => {
  const { m, t, store } = make({ perSubject: { burst: 10, perSecond: 1 } });
  const a = m.issue(ask());
  const b = m.issue(ask({ purpose: 'verify-email' }));
  m.issue(ask({ subject: 'bo@example.org' }));
  assert.equal(m.revoke('ANA@example.org', 'sign-in'), 1);
  assert.equal(reason(() => m.redeem(a.secret, 'sign-in', 'dev-1', 'a')), 'revoked');
  assert.equal(m.revoke('ana@example.org'), 1, 'the rest of that person\'s');
  assert.equal(reason(() => m.redeem(b.secret, 'verify-email', 'dev-1', 'a')), 'revoked');
  assert.equal(m.sweep(), 0);
  t.now += 15 * 60_000 + 24 * 3600_000;
  assert.equal(m.sweep(), 3);
  assert.equal(store.all().length, 0);
});

test('linkUrl keeps the token in the fragment and insists on https', () => {
  const { m } = make();
  assert.equal(m.linkUrl('https://app.example.org/auth/confirm?x=1', 'TOKEN'), 'https://app.example.org/auth/confirm?x=1#t=TOKEN');
  assert.equal(m.linkUrl('http://localhost:3000/auth', 'T'), 'http://localhost:3000/auth#t=T');
  assert.throws(() => m.linkUrl('http://app.example.org/auth', 'T'), /https/);
});

test('bad setup and bad requests are refused up front', () => {
  assert.throws(() => new MagicLinks({ secret: 'short' }), RangeError);
  assert.throws(() => new MagicLinks({ secret: SECRET, codeDigits: 4 }), RangeError);
  const { m } = make();
  assert.throws(() => m.issue(ask({ subject: '  ' })), RangeError);
  assert.throws(() => m.issue(ask({ device: '' })), RangeError);
});
