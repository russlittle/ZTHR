import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { DEFAULT_POLICY, Expired, Sessions, base32, checkCode, enrol, hashRecovery, hotp, matchesRecovery, recoveryCodes, totp, unbase32, useRecovery } from './index.ts';

test('RFC 6238 test vectors: the codes match the published values for SHA-1, SHA-256 and SHA-512', () => {
  const s1 = Buffer.from('12345678901234567890');
  const s256 = Buffer.from('12345678901234567890123456789012');
  const s512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
  const vectors: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, a, b, c] of vectors) {
    assert.equal(totp(s1, t * 1000, { digits: 8 }), a, `sha1 at ${t}`);
    assert.equal(totp(s256, t * 1000, { digits: 8, algo: 'sha256' }), b, `sha256 at ${t}`);
    assert.equal(totp(s512, t * 1000, { digits: 8, algo: 'sha512' }), c, `sha512 at ${t}`);
  }
  assert.equal(hotp(s1, 0), '755224', 'RFC 4226 counter 0');
});

test('a code is accepted one step either side for drift, and never twice', () => {
  const { secret, uri } = enrol('ana@example.org', 'Files');
  assert.match(uri, /^otpauth:\/\/totp\/Files%3Aana%40example\.org\?secret=[A-Z2-7]{32}&issuer=Files/);
  assert.deepEqual(unbase32(base32(Buffer.from('hello'))), Buffer.from('hello'));
  const t = 1_700_000_000_000;
  const now = totp(unbase32(secret), t);
  const step = checkCode(secret, now, t);
  assert.equal(step, Math.floor(t / 30_000));
  assert.equal(checkCode(secret, now, t, step!), null, 'the same code cannot be used again');
  assert.notEqual(checkCode(secret, totp(unbase32(secret), t - 30_000), t), null, 'the previous step is allowed');
  assert.equal(checkCode(secret, totp(unbase32(secret), t - 90_000), t), null, 'three steps ago is too old');
  assert.equal(checkCode(secret, '12345', t), null);
});

test('recovery codes are shown once, kept as hashes, and each works once', () => {
  const { codes, hashes } = recoveryCodes();
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0]!, /^\d{5}-\d{5}$/);
  const left = useRecovery(codes[3]!, hashes)!;
  assert.equal(left.length, 9);
  assert.equal(useRecovery(codes[3]!, left), null);
});

test('sessions end when idle or at their absolute limit, warn first, and end everywhere at once', () => {
  let t = 0;
  const s = new Sessions({ policy: { idleMs: 1000, absoluteMs: 5000, warnMs: 200 }, now: () => t });
  const a = s.start('ana', 'laptop');
  t = 900;
  assert.deepEqual(s.warning(a.id), { secondsLeft: 1, canExtend: true });
  s.use(a.id);
  t = 1500;
  assert.equal(s.warning(a.id), null, 'activity pushed the end back');
  for (t = 1500; t < 4800; t += 800) s.use(a.id);
  t = 4850;
  assert.equal(s.warning(a.id)?.canExtend, false, 'near the absolute limit, staying active cannot extend it');
  t = 5000;
  assert.throws(() => s.use(a.id), /time limit/);
  const b = s.start('ana', 'phone');
  t += 1001;
  assert.throws(() => s.use(b.id), Expired);
  s.start('ana', 'x');
  const keep = s.start('ana', 'y');
  s.start('ben', 'z');
  assert.equal(s.endAll('ana', keep.id), 1);
  assert.deepEqual(s.list('ana').map((x) => x.device), ['y']);
});

test('ended sessions are not listed as signed in, and abandoned ones do not pile up', () => {
  let t = 0;
  const s = new Sessions({ policy: { idleMs: 1000, absoluteMs: 5000, warnMs: 200 }, now: () => t });
  s.start('ana', 'laptop');
  t = 2000;
  assert.deepEqual(s.list('ana'), [], 'idle past its limit, it has ended');
  for (let i = 0; i < 50; i++) s.start(`u${i}`, 'd');
  t = 10_000;
  s.start('ben', 'phone');
  assert.equal(s.all.size, 1, 'sessions nobody came back to are swept as new ones start');
});

test('a recovery code typed without its hyphen, or with spaces, still works', () => {
  const { codes, hashes } = recoveryCodes();
  assert.equal(useRecovery(codes[0]!.replace('-', ''), hashes)?.length, 9);
  assert.equal(useRecovery(` ${codes[1]!.replace('-', ' ')} `, hashes)?.length, 9);
});

test('recovery codes are kept as salted scrypt hashes, so a leaked list cannot be looked up or brute-forced cheaply', () => {
  const { codes, hashes } = recoveryCodes(2);
  const plain = createHash('sha256').update(codes[0]!).digest('hex');
  assert.ok(!hashes.includes(plain), 'not the bare SHA-256 of the code');
  assert.match(hashes[0]!, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(hashRecovery(codes[0]!), hashRecovery(codes[0]!), 'a fresh salt each time');
  assert.equal(useRecovery(codes[0]!, hashes)?.length, 1);
  const peppered = recoveryCodes(1, { pepper: 'server-secret' });
  assert.equal(useRecovery(peppered.codes[0]!, peppered.hashes), null, 'without the pepper the code does not match');
  assert.deepEqual(useRecovery(peppered.codes[0]!, peppered.hashes, { pepper: 'server-secret' }), []);
  assert.equal(useRecovery(codes[0]!, ['scrypt$1099511627776$8$1$AAAA$AAAA']), null, 'a stored hash naming an absurd cost is refused, not run');
});

const POLICY = { idleMs: 1000, absoluteMs: 5000, warnMs: 200 };
const clocked = (policy = POLICY) => {
  const clock = { t: 0 };
  return { clock, s: new Sessions({ policy, now: () => clock.t }) };
};

test('the default policy is 30 minutes idle, 12 hours absolute, a 2 minute warning, and a session starts without a second factor', () => {
  assert.deepEqual(DEFAULT_POLICY, { idleMs: 1_800_000, absoluteMs: 43_200_000, warnMs: 120_000 });
  const clock = { t: 0 };
  const s = new Sessions({ now: () => clock.t });
  const a = s.start('ana', 'laptop');
  assert.equal(a.mfa, false);
  assert.equal(s.start('ana', 'phone', true).mfa, true);
  clock.t = 29 * 60_000;
  assert.equal(s.use(a.id).id, a.id, 'still signed in after 29 idle minutes');
  clock.t += 30 * 60_000;
  assert.throws(() => s.use(a.id), /without activity/, 'signed out after 30 idle minutes');
});

test('use says why a person is signed out, and exactly when', () => {
  const { clock, s } = clocked();
  const exact = (m: string) => (e: unknown) => e instanceof Expired && e.message === m;
  assert.throws(() => s.use('no-such-session'), exact('you are signed out'));
  const a = s.start('ana', 'laptop');
  clock.t = 999;
  assert.equal(s.use(a.id).lastSeen, 999);
  clock.t = 1998;
  assert.equal(s.use(a.id).lastSeen, 1998, 'activity just before the idle limit keeps it going');
  clock.t = 2997;
  s.use(a.id);
  clock.t = 3996;
  s.use(a.id);
  clock.t = 4995;
  assert.equal(s.use(a.id).id, a.id);
  const b = s.start('ana', 'phone');
  clock.t += 1000;
  assert.throws(() => s.use(b.id), exact('you were signed out after a while without activity'));
  assert.equal(s.all.has(b.id), false, 'an expired session is forgotten');
});

test('end signs one session out, and nothing else', () => {
  const { s } = clocked();
  const a = s.start('ana', 'laptop');
  const b = s.start('ana', 'phone');
  s.end(a.id);
  assert.equal(s.all.has(a.id), false);
  assert.throws(() => s.use(a.id), /signed out/);
  assert.equal(s.use(b.id).id, b.id);
});

test('the warning appears from the warning time up to the end, and never for an unknown or ended session', () => {
  const { clock, s } = clocked();
  assert.equal(s.warning('nope'), null);
  const a = s.start('ana', 'laptop');
  clock.t = 799;
  assert.equal(s.warning(a.id), null, 'more than the warning time left');
  clock.t = 800;
  assert.deepEqual(s.warning(a.id), { secondsLeft: 1, canExtend: true }, 'exactly the warning time left');
  clock.t = 999;
  assert.deepEqual(s.warning(a.id), { secondsLeft: 1, canExtend: true });
  clock.t = 1000;
  assert.equal(s.warning(a.id), null, 'at the end there is nothing left to warn about');
  clock.t = 1100;
  assert.equal(s.warning(a.id), null, 'and after it, nothing either');
});

test('a session whose idle limit coincides with its absolute limit cannot be extended by staying active', () => {
  const { clock, s } = clocked();
  const a = s.start('ana', 'laptop');
  for (clock.t = 900; clock.t <= 3600; clock.t += 900) s.use(a.id);
  clock.t = 4000;
  assert.equal(s.use(a.id).lastSeen, 4000);
  clock.t = 4850;
  assert.deepEqual(s.warning(a.id), { secondsLeft: 1, canExtend: false });
});

test('sweep forgets exactly the sessions that have ended, and says how many', () => {
  const { clock, s } = clocked();
  s.start('ana', 'laptop');
  s.start('ben', 'phone');
  clock.t = 500;
  assert.equal(s.sweep(), 0);
  assert.equal(s.all.size, 2, 'live sessions stay');
  clock.t = 999;
  assert.equal(s.sweep(), 0);
  clock.t = 1000;
  assert.equal(s.sweep(), 2, 'a session has ended at the very instant of its limit');
  assert.equal(s.all.size, 0);
});

test('starting a session sweeps abandoned ones, but only once per idle period', () => {
  const { clock, s } = clocked();
  const x = s.start('ana', 'laptop');
  clock.t = 500;
  s.sweep();
  clock.t = 1100;
  s.start('ben', 'phone');
  assert.equal(s.all.has(x.id), true, 'swept 600ms ago, so not swept again yet');
  clock.t = 1500;
  s.start('cy', 'tablet');
  assert.equal(s.all.has(x.id), false, 'a full idle period after the last sweep it is swept');
  assert.equal(s.all.size, 2);
});

test('a person\'s sessions are listed most recently used first, and not at the instant they end', () => {
  const { clock, s } = clocked({ idleMs: 10_000, absoluteMs: 100_000, warnMs: 200 });
  const a = s.start('ana', 'a');
  clock.t = 1;
  const b = s.start('ana', 'b');
  clock.t = 2;
  const c = s.start('ana', 'c');
  clock.t = 10;
  s.use(c.id);
  clock.t = 20;
  s.use(a.id);
  clock.t = 30;
  s.use(b.id);
  assert.deepEqual(s.list('ana').map((x) => x.device), ['b', 'a', 'c']);
  const short = clocked();
  short.s.start('ana', 'x');
  short.clock.t = 999;
  assert.equal(short.s.list('ana').length, 1);
  short.clock.t = 1000;
  assert.equal(short.s.list('ana').length, 0);
});

test('base32 matches RFC 4648, ignores padding, spaces, hyphens and case, and refuses other characters', () => {
  const vectors: [string, string][] = [['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [plain, enc] of vectors) {
    assert.equal(base32(Buffer.from(plain)), enc);
    assert.equal(unbase32(enc).toString(), plain);
  }
  assert.equal(unbase32('mzxq====').toString(), 'fo');
  assert.equal(unbase32('mzxw 6ytb-oi==').toString(), 'foobar');
  assert.throws(() => unbase32('MZ1!'), (e: unknown) => e instanceof Error && e.message === 'not base32');
});

test('a code must be exactly six digits, and a code from before the last used step is fine', () => {
  const { secret } = enrol('ana@example.org', 'Files');
  const t = 1_700_000_000_000;
  const code = totp(unbase32(secret), t);
  const step = Math.floor(t / 30_000);
  assert.equal(checkCode(secret, `x${code}`, t), null);
  assert.equal(checkCode(secret, `${code}x`, t), null);
  assert.equal(checkCode(secret, code, t, step - 5), step, 'an older last-used step does not block a newer code');
  assert.equal(checkCode(secret, code, t, step), null);
  assert.equal(checkCode(secret, totp(unbase32(secret), t + 30_000), t), step + 1, 'the next step is allowed too');
  assert.equal(checkCode(secret, totp(unbase32(secret), t - 30_000), t), step - 1);
});

const KDF = { N: 1024 };
const hashOf = (stored: string) => Buffer.from(stored.split('$')[5]!, 'base64url');
const saltOf = (stored: string) => Buffer.from(stored.split('$')[4]!, 'base64url');

test('a recovery code is hashed in its canonical form with the cost it names, so the hash can be reproduced independently', () => {
  const stored = hashRecovery('1234567890', KDF);
  assert.deepEqual(hashOf(stored), scryptSync('12345-67890', saltOf(stored), 32, { N: 1024, r: 8, p: 1 }));
  const other = hashRecovery('12345 67890', { N: 2048, r: 4, p: 2 });
  assert.match(other, /^scrypt\$2048\$4\$2\$/);
  assert.deepEqual(hashOf(other), scryptSync('12345-67890', saltOf(other), 32, { N: 2048, r: 4, p: 2 }));
  const word = hashRecovery('  open-sesame ', KDF);
  assert.deepEqual(hashOf(word), scryptSync('open-sesame', saltOf(word), 32, { N: 1024, r: 8, p: 1 }), 'a code that is not ten digits is kept as typed, trimmed');
  assert.equal(matchesRecovery('open-sesame  ', word), true);
});

test('only ten digits are re-spaced: longer or lettered codes are compared as typed', () => {
  const hyphenated = hashRecovery('abc12-34567890', KDF);
  assert.equal(matchesRecovery('abc1234567890', hyphenated), false);
  const long = hashRecovery('12345-678901234', KDF);
  assert.equal(matchesRecovery('12345678901234', long), false);
  assert.equal(matchesRecovery('12345-678901234', long), true);
});

test('recovery codes are always ten digits, with leading zeros kept', () => {
  const { codes } = recoveryCodes(600, KDF);
  assert.ok(codes.every((c) => /^\d{5}-\d{5}$/.test(c)));
});

test('a stored recovery hash is run only when it is well formed and its cost is within bounds', () => {
  const code = '12345-67890';
  const good = hashRecovery(code, KDF);
  assert.equal(matchesRecovery(code, good), true);
  assert.equal(matchesRecovery(code, `x${good}`), false, 'nothing may precede it');
  assert.equal(matchesRecovery(code, `${good}!`), false, 'nothing may follow it');
  assert.equal(matchesRecovery(code, 'garbage'), false);
  assert.equal(matchesRecovery(code, 'scrypt$1024$8$1$AAAA$AAAA'), false, 'a short hash is not a match, and does not crash');
  assert.equal(matchesRecovery(code, 'scrypt$3000$8$1$AAAA$AAAA'), false, 'a cost that is not a power of two is refused');
  assert.equal(matchesRecovery(code, 'scrypt$1024$0$1$AAAA$AAAA'), false);
  assert.equal(matchesRecovery(code, 'scrypt$1024$8$0$AAAA$AAAA'), false);
  const cost = (o: { N?: number; r?: number; p?: number }) => matchesRecovery(code, hashRecovery(code, o));
  assert.equal(cost({ N: 512 }), false, 'below 2^10 is too cheap to trust');
  assert.equal(cost({ N: 1024 }), true);
  assert.equal(cost({ N: 1024, r: 1 }), true);
  assert.equal(cost({ N: 1024, r: 16 }), true, 'a two-digit r is read whole');
  assert.equal(cost({ N: 1024, r: 32 }), true);
  assert.equal(cost({ N: 1024, r: 33 }), false);
  assert.equal(cost({ N: 1024, p: 10 }), true, 'a two-digit p is read whole');
  assert.equal(cost({ N: 1024, p: 16 }), true);
  assert.equal(cost({ N: 1024, p: 17 }), false);
  assert.equal(cost({ N: 2 ** 20, r: 2 }), true, 'exactly 2^20 is the largest accepted');
});

test('using a recovery code removes the first matching hash only', () => {
  const code = '12345-67890';
  const h1 = hashRecovery(code, KDF);
  const h2 = hashRecovery(code, KDF);
  const h3 = hashRecovery('11111-22222', KDF);
  assert.deepEqual(useRecovery(code, [h1, h2, h3]), [h2, h3]);
  assert.deepEqual(useRecovery(code, [h3, h1, h2]), [h3, h2]);
});
