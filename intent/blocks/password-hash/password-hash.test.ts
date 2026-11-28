import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PasswordHasher, derive, PasswordRefused, OWASP, type Config } from './index.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);
const cheap = { argon2: { memoryKiB: 32, passes: 1, lanes: 1 }, scrypt: { ln: 4, r: 8, p: 1 }, pbkdf2: { iterations: 1000 } };
const PEPPER = Buffer.alloc(32, 7).toString('base64');
const PEPPER2 = Buffer.alloc(32, 9).toString('base64');
let ctr = 0;
const random = (n: number) => Uint8Array.from({ length: n }, (_, i) => (ctr * 31 + i * 7 + 1) & 0xff);
const mk = (o: Partial<Config> = {}) => new PasswordHasher({ algorithm: 'argon2id', ...cheap, random: (n) => (ctr++, random(n)), ...o });

test('PBKDF2-HMAC-SHA256 RFC 7914 section 11 vector', async () => {
  const k = await derive(utf8('passwd'), utf8('salt'), { algorithm: 'pbkdf2-sha256', tagBytes: 64, pbkdf2: { iterations: 1 } });
  assert.equal(hex(k), '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
});

test('scrypt RFC 7914 section 12 vectors', async () => {
  assert.equal(hex(await derive(new Uint8Array(0), new Uint8Array(0), { algorithm: 'scrypt', tagBytes: 64, scrypt: { ln: 4, r: 1, p: 1 } })), '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906');
  assert.equal(hex(await derive(utf8('password'), utf8('NaCl'), { algorithm: 'scrypt', tagBytes: 64, scrypt: { ln: 10, r: 8, p: 16 } })), 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640');
});

test('PBKDF2-HMAC-SHA512 agrees with a known vector (RFC 6070 style, 1 iteration)', async () => {
  const k = await derive(utf8('password'), utf8('salt'), { algorithm: 'pbkdf2-sha512', tagBytes: 64, pbkdf2: { iterations: 1 } });
  assert.equal(hex(k), '867f70cf1ade02cff3752599a3a53dc4af34c7a669815ae5d513554e1c8cf252c02d470a285a0501bad999bfe943c08f050235d7d68b1da55e63f73b60a57fce');
});

test('each algorithm hashes and verifies, wrong password fails', async () => {
  for (const algorithm of ['argon2id', 'scrypt', 'pbkdf2-sha256', 'pbkdf2-sha512'] as const) {
    const h = mk({ algorithm });
    const s = await h.hash('correct horse');
    assert.match(s, /^zthr1:-:\$(argon2id|scrypt|pbkdf2-sha256|pbkdf2-sha512)\$/, algorithm);
    assert.deepEqual(await h.verify('correct horse', s), { ok: true });
    assert.deepEqual(await h.verify('correct horsf', s), { ok: false, reason: 'mismatch' });
    assert.equal(h.needsRehash(s), false);
  }
});

test('salts differ per hash and the same password gives different strings', async () => {
  const h = new PasswordHasher({ algorithm: 'pbkdf2-sha256', pbkdf2: { iterations: 1000 } });
  const a = await h.hash('pw');
  const b = await h.hash('pw');
  assert.notEqual(a, b);
});

test('unicode is normalised: composed and decomposed forms are the same password', async () => {
  const h = mk();
  const s = await h.hash('café-pass');
  assert.equal((await h.verify('café-pass', s)).ok, true);
});

test('pepper changes the hash, is needed to verify, and its id is stored', async () => {
  const withPepper = mk({ peppers: { p1: PEPPER }, currentPepper: 'p1' });
  const without = mk();
  const s = await withPepper.hash('pw');
  assert.match(s, /^zthr1:p1:/);
  assert.equal((await withPepper.verify('pw', s)).ok, true);
  const gone = mk();
  assert.deepEqual(await gone.verify('pw', s), { ok: false, reason: 'unknown-pepper' });
  const wrong = mk({ peppers: { p1: PEPPER2 }, currentPepper: 'p1' });
  assert.deepEqual(await wrong.verify('pw', s), { ok: false, reason: 'mismatch' });
  assert.equal((await without.verify('pw', s.replace('zthr1:p1:', 'zthr1:-:'))).ok, false, 'a peppered hash does not verify as unpeppered');
});

test('pepper rotation: old records verify and come back with a rehash under the new pepper', async () => {
  const v1 = mk({ peppers: { p1: PEPPER }, currentPepper: 'p1' });
  const s1 = await v1.hash('pw');
  const v2 = mk({ peppers: { p1: PEPPER, p2: PEPPER2 }, currentPepper: 'p2' });
  assert.equal(v2.needsRehash(s1), true);
  const r = await v2.verify('pw', s1);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.rehash?.startsWith('zthr1:p2:'));
  assert.deepEqual(await v2.verify('pw', (r as { rehash: string }).rehash), { ok: true });
});

test('rehash on login: weaker cost, other algorithm, and no rehash for stronger-or-equal', async () => {
  const weak = mk({ argon2: { memoryKiB: 32, passes: 1, lanes: 1 } });
  const s = await weak.hash('pw');
  const stronger = mk({ argon2: { memoryKiB: 64, passes: 2, lanes: 1 } });
  const r = await stronger.verify('pw', s);
  assert.ok(r.ok && r.rehash);
  assert.equal(stronger.needsRehash((r as { rehash: string }).rehash), false);
  assert.equal(weak.needsRehash((r as { rehash: string }).rehash), false, 'a stronger hash is not downgraded');
  const toScrypt = mk({ algorithm: 'scrypt' });
  const r2 = await toScrypt.verify('pw', s);
  assert.ok(r2.ok && r2.rehash?.includes('$scrypt$'));
  assert.deepEqual(await toScrypt.verify('nope', s), { ok: false, reason: 'mismatch' }, 'no rehash on a failed login');
});

test('a longer tag or salt in the config triggers rehash', async () => {
  const s = await mk().hash('pw');
  assert.equal(mk({ tagBytes: 48 }).needsRehash(s), true);
  assert.equal(mk({ saltBytes: 32 }).needsRehash(s), true);
});

test('missing, malformed and over-long inputs fail with a reason and never throw', async () => {
  const h = mk();
  assert.deepEqual(await h.verify('pw', undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(await h.verify('pw', null), { ok: false, reason: 'missing' });
  for (const bad of ['', 'plaintext', '$argon2id$v=19$m=32,t=1,p=1$AAAAAAAAAAAA$AAAA', 'zthr1:-:$bcrypt$x', 'zthr1:-:$argon2id$v=19$m=32,t=1,p=1$AAAA$' + 'A'.repeat(2000)]) {
    assert.deepEqual(await h.verify('pw', bad), { ok: false, reason: 'malformed' }, bad.slice(0, 40));
  }
  assert.deepEqual(await h.verify('x'.repeat(2000), await h.hash('pw')), { ok: false, reason: 'refused' });
  await assert.rejects(() => h.hash('x'.repeat(2000)), PasswordRefused);
});

test('a tampered record cannot demand more than the ceilings', async () => {
  const h = mk();
  const evil = [
    'zthr1:-:$argon2id$v=19$m=4194304,t=1,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'zthr1:-:$scrypt$ln=30,r=8,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'zthr1:-:$pbkdf2-sha256$i=2000000000$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'zthr1:-:$argon2id$v=19$m=32,t=1,p=1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ];
  const t0 = Date.now();
  for (const e of evil) assert.deepEqual(await h.verify('pw', e), { ok: false, reason: 'malformed' });
  assert.ok(Date.now() - t0 < 5000, 'refused before any expensive work');
});

test('configuration beyond the ceilings or with a bad pepper is refused at construction', () => {
  assert.throws(() => mk({ argon2: { memoryKiB: 1 << 22, passes: 1, lanes: 1 } }), PasswordRefused);
  assert.throws(() => mk({ algorithm: 'scrypt', scrypt: { ln: 25, r: 8, p: 1 } }), PasswordRefused);
  assert.throws(() => mk({ algorithm: 'pbkdf2-sha256', pbkdf2: { iterations: 1e9 } }), PasswordRefused);
  assert.throws(() => mk({ peppers: { p1: Buffer.alloc(8).toString('base64') }, currentPepper: 'p1' }), PasswordRefused);
  assert.throws(() => mk({ peppers: { 'bad id!': PEPPER } }), PasswordRefused);
  assert.throws(() => mk({ currentPepper: 'nope' }), PasswordRefused);
  assert.throws(() => mk({ tagBytes: 8 }), PasswordRefused);
});

test('failure paths cost about what a success does (timing equalisation)', async () => {
  const h = new PasswordHasher({ algorithm: 'pbkdf2-sha256', pbkdf2: { iterations: 120_000 } });
  const s = await h.hash('pw');
  const time = async (f: () => Promise<unknown>) => {
    const ts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = process.hrtime.bigint();
      await f();
      ts.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return Math.min(...ts);
  };
  await h.verify('pw', s); // warm the decoy
  const real = await time(() => h.verify('wrong', s));
  const missing = await time(() => h.verify('wrong', undefined));
  const bad = await time(() => h.verify('wrong', 'junk'));
  for (const t of [missing, bad]) assert.ok(t > real * 0.4 && t < real * 2.5, `real ${real.toFixed(1)} ms vs ${t.toFixed(1)} ms`);
});

test('calibrate reports milliseconds per hash from the injected clock', async () => {
  const h2 = new PasswordHasher({ algorithm: 'pbkdf2-sha256', pbkdf2: { iterations: 10 }, now: (() => { let x = 0; return () => (x += 90); })() });
  assert.equal(await h2.calibrate(3), 30, 'two clock reads, 90 ms apart, over three runs');
});

test('OWASP presets are the documented minimums', () => {
  assert.deepEqual(OWASP.argon2, { memoryKiB: 19456, passes: 2, lanes: 1 });
  assert.equal(OWASP.scrypt.ln, 17);
  assert.equal(OWASP.pbkdf2Sha256.iterations, 600_000);
  assert.equal(OWASP.pbkdf2Sha512.iterations, 210_000);
});
