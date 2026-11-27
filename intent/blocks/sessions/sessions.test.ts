import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Expired, Sessions, base32, checkCode, enrol, hotp, recoveryCodes, totp, unbase32, useRecovery } from './index.ts';

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
