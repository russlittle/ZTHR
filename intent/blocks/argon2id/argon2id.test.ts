import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeCrypto from 'node:crypto';
import { blake2b, hPrime, argon2, argon2id, argon2Async, argon2idAsync, checkParams, encode, parseEncoded, equalBytes, Argon2Refused, Argon2OutOfTime, DEFAULT_LIMITS, PRESETS } from './index.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fill = (n: number, x: number) => new Uint8Array(n).fill(x);
const utf8 = (s: string) => new TextEncoder().encode(s);
const rfc = { memoryKiB: 32, passes: 3, lanes: 4, tagLength: 32, secret: fill(8, 3), associatedData: fill(12, 4) };

test('BLAKE2b RFC 7693 appendix A: "abc"', () => {
  assert.equal(hex(blake2b(utf8('abc'))), 'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
});

test('BLAKE2b of the empty message', () => {
  assert.equal(hex(blake2b(new Uint8Array(0))), '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce');
});

test('BLAKE2b agrees with node blake2b512 at block boundaries', () => {
  for (const n of [1, 63, 64, 127, 128, 129, 255, 256, 257, 1000, 5000]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
    assert.equal(hex(blake2b(data)), nodeCrypto.createHash('blake2b512').update(data).digest('hex'), `n=${n}`);
  }
});

test('BLAKE2b with a key and shorter outputs', () => {
  const key = Uint8Array.from({ length: 64 }, (_, i) => i);
  assert.equal(hex(blake2b(new Uint8Array(0), 64, key)), '10ebb67700b1868efb4417987acf4690ae9d972fb7a590c2f02871799aaa4786b5e996e8f0f4eb981fc214b005f42d2ff4233499391653df7aefcbc13fc51568');
  const short = blake2b(utf8('abc'), 20);
  assert.equal(short.length, 20);
  assert.equal(hex(short), '384264f676f39536840523f284921cdc68b6846b');
  assert.notEqual(hex(short), hex(blake2b(utf8('abc'), 64).subarray(0, 20)), 'output length is part of the parameter block');
  assert.throws(() => blake2b(utf8('x'), 0), RangeError);
  assert.throws(() => blake2b(utf8('x'), 65), RangeError);
  assert.throws(() => blake2b(utf8('x'), 32, new Uint8Array(65)), RangeError);
});

test('H-prime produces the requested length, long and short, and is deterministic', () => {
  for (const n of [1, 32, 64, 65, 96, 100, 1024]) {
    const a = hPrime(utf8('input'), n);
    assert.equal(a.length, n);
    assert.equal(hex(a), hex(hPrime(utf8('input'), n)));
  }
  assert.notEqual(hex(hPrime(utf8('input'), 100).subarray(0, 32)), hex(hPrime(utf8('input'), 101).subarray(0, 32)));
  assert.throws(() => hPrime(utf8('x'), 0), RangeError);
});

test('RFC 9106 section 5.3 Argon2id vector', () => {
  assert.equal(hex(argon2id(fill(32, 1), fill(16, 2), rfc)), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});

test('RFC 9106 section 5.1 Argon2d vector', () => {
  assert.equal(hex(argon2(fill(32, 1), fill(16, 2), rfc, { variant: 'argon2d' })), '512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb');
});

test('RFC 9106 section 5.2 Argon2i vector', () => {
  assert.equal(hex(argon2(fill(32, 1), fill(16, 2), rfc, { variant: 'argon2i' })), 'c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8');
});

test('agrees with node crypto.argon2 when this node has it', { skip: typeof (nodeCrypto as Record<string, unknown>).argon2Sync !== 'function' }, () => {
  const ref = (nodeCrypto as unknown as { argon2Sync: (alg: string, o: Record<string, unknown>) => Buffer }).argon2Sync('argon2id', { message: Buffer.from('pw'), nonce: Buffer.alloc(16, 9), parallelism: 2, tagLength: 24, memory: 64, passes: 2 });
  assert.equal(hex(argon2id(utf8('pw'), fill(16, 9), { memoryKiB: 64, passes: 2, lanes: 2, tagLength: 24 })), ref.toString('hex'));
});

test('every input matters: password, salt, secret, data, each cost parameter, tag length', () => {
  const base = { memoryKiB: 64, passes: 2, lanes: 2, tagLength: 32 };
  const ref = hex(argon2id(utf8('pw'), fill(16, 1), base));
  const variants = [
    argon2id(utf8('pW'), fill(16, 1), base),
    argon2id(utf8('pw'), fill(16, 2), base),
    argon2id(utf8('pw'), fill(16, 1), { ...base, secret: fill(1, 1) }),
    argon2id(utf8('pw'), fill(16, 1), { ...base, associatedData: fill(1, 1) }),
    argon2id(utf8('pw'), fill(16, 1), { ...base, memoryKiB: 72 }),
    argon2id(utf8('pw'), fill(16, 1), { ...base, passes: 3 }),
    argon2id(utf8('pw'), fill(16, 1), { ...base, lanes: 1 }),
    argon2id(utf8('pw'), fill(16, 1), { ...base, tagLength: 33 }),
  ].map(hex);
  assert.equal(new Set([ref, ...variants]).size, 9);
});

test('the variants differ, and a long tag (over 64 bytes) works', () => {
  const p = { memoryKiB: 64, passes: 1, lanes: 1, tagLength: 100 };
  const d = argon2(utf8('x'), fill(16, 0), p, { variant: 'argon2d' });
  const i = argon2(utf8('x'), fill(16, 0), p, { variant: 'argon2i' });
  const id = argon2(utf8('x'), fill(16, 0), p, { variant: 'argon2id' });
  assert.equal(d.length, 100);
  assert.equal(new Set([hex(d), hex(i), hex(id)]).size, 3);
});

test('many blocks per segment and more than 128 (address block refresh) are deterministic', () => {
  const p = { memoryKiB: 4096, passes: 2, lanes: 1, tagLength: 32 };
  const a = argon2id(utf8('x'), fill(16, 5), p);
  assert.equal(hex(a), hex(argon2id(utf8('x'), fill(16, 5), p)));
});

test('async form gives the same bytes and yields to the event loop', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  const a = await argon2idAsync(fill(32, 1), fill(16, 2), rfc);
  clearInterval(timer);
  assert.equal(hex(a), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  assert.ok(ticks >= 1, 'the loop ran during the hash');
  assert.equal(hex(await argon2Async(fill(32, 1), fill(16, 2), rfc, { variant: 'argon2d' })), '512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb');
});

test('limits refuse out-of-range parameters before allocating memory', () => {
  const salt = fill(16, 1);
  const pw = utf8('x');
  const ok = { memoryKiB: 64, passes: 1, lanes: 1 };
  assert.doesNotThrow(() => checkParams(ok, salt, pw));
  const bad: [Record<string, number>, RegExp][] = [
    [{ memoryKiB: DEFAULT_LIMITS.maxMemoryKiB + 1 }, /over the limit/],
    [{ memoryKiB: 4 }, /at least 8/],
    [{ passes: 0 }, /passes/],
    [{ passes: 11 }, /passes/],
    [{ lanes: 0 }, /lanes/],
    [{ lanes: 17 }, /lanes/],
    [{ tagLength: 3 }, /tag length/],
    [{ memoryKiB: 64.5 }, /memory/],
  ];
  for (const [o, re] of bad) assert.throws(() => checkParams({ ...ok, ...o }, salt, pw), (e: unknown) => e instanceof Argon2Refused && re.test(e.message), JSON.stringify(o));
  assert.throws(() => checkParams(ok, fill(4, 1), pw), /salt/);
  assert.throws(() => checkParams(ok, salt, new Uint8Array(DEFAULT_LIMITS.maxInputBytes + 1)), /size limit/);
  assert.throws(() => argon2id(pw, salt, { ...ok, memoryKiB: 1 << 30 }), Argon2Refused);
  assert.doesNotThrow(() => checkParams(PRESETS.uniform, salt, pw, { ...DEFAULT_LIMITS, maxMemoryKiB: 2 * 1024 * 1024 }));
  assert.throws(() => checkParams(PRESETS.uniform, salt, pw), Argon2Refused);
  assert.doesNotThrow(() => checkParams(PRESETS.constrained, salt, pw));
});

test('time budget aborts with an injected clock', async () => {
  let t = 0;
  const now = () => (t += 100);
  const limits = { ...DEFAULT_LIMITS, budgetMs: 250 };
  assert.throws(() => argon2id(fill(32, 1), fill(16, 2), rfc, { limits, now }), Argon2OutOfTime);
  t = 0;
  await assert.rejects(() => argon2idAsync(fill(32, 1), fill(16, 2), rfc, { limits, now }), Argon2OutOfTime);
  t = 0;
  assert.equal(hex(argon2id(fill(32, 1), fill(16, 2), rfc, { limits: { ...DEFAULT_LIMITS, budgetMs: 1e9 }, now })).slice(0, 8), '0d640df5');
});

test('encoded form round-trips and refuses junk', () => {
  const salt = fill(16, 2);
  const tag = argon2id(utf8('pw'), salt, { memoryKiB: 64, passes: 2, lanes: 2 });
  const s = encode('argon2id', { memoryKiB: 64, passes: 2, lanes: 2 }, salt, tag);
  assert.match(s, /^\$argon2id\$v=19\$m=64,t=2,p=2\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  const back = parseEncoded(s);
  assert.equal(back.variant, 'argon2id');
  assert.deepEqual(back.params, { memoryKiB: 64, passes: 2, lanes: 2, tagLength: 32 });
  assert.equal(hex(back.salt), hex(salt));
  assert.equal(hex(back.tag), hex(tag));
  for (const bad of ['', '$argon2id$v=16$m=64,t=2,p=2$AAAA$AAAA', '$argon2x$v=19$m=1,t=1,p=1$AA$AA', '$argon2id$v=19$m=64,t=2$AAAA$AAAA', 'x$argon2id$v=19$m=64,t=2,p=2$AAAA$AAAA']) assert.throws(() => parseEncoded(bad), Argon2Refused, bad);
});

test('equalBytes compares content and length', () => {
  assert.equal(equalBytes(fill(4, 1), fill(4, 1)), true);
  assert.equal(equalBytes(fill(4, 1), fill(5, 1)), false);
  assert.equal(equalBytes(fill(4, 1), Uint8Array.from([1, 1, 1, 2])), false);
  assert.equal(equalBytes(new Uint8Array(0), new Uint8Array(0)), true);
});
