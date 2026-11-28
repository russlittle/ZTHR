import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ShareError, gfMul, gfDiv, gfAdd, split, combine, verify, encodeShare, decodeShare, describeShare, splitText, combineText } from './index.ts';
import type { Share } from './index.ts';

const prng = (seed: number) => {
  let n = 0;
  return (bytes: number) => {
    const out = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 32) createHash('sha256').update(`${seed}:${n++}`).digest().copy(out, i, 0, Math.min(32, bytes - i));
    return out;
  };
};
const subsetsOf = <T>(a: readonly T[], k: number): T[][] => {
  const out: T[][] = [];
  const walk = (s: number, cur: T[]) => { if (cur.length === k) return void out.push([...cur]); for (let i = s; i < a.length; i++) { cur.push(a[i]!); walk(i + 1, cur); cur.pop(); } };
  walk(0, []);
  return out;
};

test('GF(256) uses the AES polynomial: published products and inverses', () => {
  assert.equal(gfMul(0x53, 0xca), 0x01);
  assert.equal(gfMul(0x57, 0x83), 0xc1);
  assert.equal(gfMul(0x57, 0x13), 0xfe);
  assert.equal(gfMul(0, 7), 0);
  assert.equal(gfAdd(0x57, 0x83), 0xd4);
  assert.equal(gfDiv(0x01, 0x53), 0xca);
  assert.throws(() => gfDiv(1, 0), ShareError);
});

test('the field is closed: x * x^-1 is 1 for every non-zero x, and multiplication commutes', () => {
  for (let a = 1; a < 256; a++) assert.equal(gfMul(a, gfDiv(1, a)), 1);
  for (let a = 0; a < 256; a += 17) for (let b = 0; b < 256; b += 13) assert.equal(gfMul(a, b), gfMul(b, a));
});

test('any k of n shares rebuild the secret, for every subset of 3-of-5', () => {
  const secret = Buffer.from('correct horse battery staple', 'utf8');
  const shares = split(secret, 3, 5, prng(1));
  assert.equal(shares.length, 5);
  for (const sub of subsetsOf(shares, 3)) assert.deepEqual(combine(sub), secret);
  for (const sub of subsetsOf(shares, 4)) assert.deepEqual(combine(sub), secret);
  assert.deepEqual(combine(shares), secret);
});

test('fewer than k shares are refused, and k-1 shares fit every possible secret byte', () => {
  const shares = split(Buffer.from([0x42]), 3, 5, prng(2));
  assert.throws(() => combine(shares.slice(0, 2)), /2 of the 3/);
  // With 2 of 3 shares, for every candidate secret there is a degree-2 polynomial through both points and (0, candidate): no information.
  const [a, b] = shares as [Share, Share];
  const seen = new Set<number>();
  for (let s = 0; s < 256; s++) {
    // Solve y = s + c1 x + c2 x^2 through the two known points: exists uniquely for each s.
    const d1 = a.data[0]! ^ s, d2 = b.data[0]! ^ s;
    const det = gfMul(a.x, gfMul(b.x, a.x ^ b.x));
    const c2 = gfDiv(gfMul(d2, a.x) ^ gfMul(d1, b.x), det);
    const c1 = gfDiv(d1 ^ gfMul(c2, gfMul(a.x, a.x)), a.x);
    assert.equal(s ^ gfMul(c1, b.x) ^ gfMul(c2, gfMul(b.x, b.x)), b.data[0]);
    seen.add(s);
  }
  assert.equal(seen.size, 256);
});

test('splitting is deterministic under a fixed random source and varies with a different one', () => {
  const secret = Buffer.from('abc');
  const a = split(secret, 2, 3, prng(5)).map(encodeShare);
  assert.deepEqual(split(secret, 2, 3, prng(5)).map(encodeShare), a);
  assert.notDeepEqual(split(secret, 2, 3, prng(6)).map(encodeShare), a);
  const live = split(secret, 2, 3).map(encodeShare);
  assert.notDeepEqual(split(secret, 2, 3).map(encodeShare), live);
});

test('k = n = 2, k = 2 of 255, and every secret byte value survive', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const two = split(all, 2, 2, prng(3));
  assert.deepEqual(combine(two), all);
  const many = split(Buffer.from('x'), 2, 255, prng(4));
  assert.equal(many.length, 255);
  assert.equal(many[254]!.x, 255);
  assert.deepEqual(combine([many[0]!, many[254]!]), Buffer.from('x'));
});

test('bad parameters and empty or huge secrets are refused', () => {
  const s = Buffer.from('s');
  assert.throws(() => split(s, 1, 3), /2 <= k <= n/);
  assert.throws(() => split(s, 4, 3), ShareError);
  assert.throws(() => split(s, 2, 256), ShareError);
  assert.throws(() => split(s, 2.5, 3), ShareError);
  assert.throws(() => split(Buffer.alloc(0), 2, 3), /no secret/);
  assert.throws(() => split(Buffer.alloc((1 << 20) + 1), 2, 3), /too large/);
  assert.throws(() => split(s, 2, 3, () => Buffer.alloc(1)), /too few bytes/);
});

test('shares of different sets, repeated shares and out-of-range numbers are refused', () => {
  const a = split(Buffer.from('one'), 2, 3, prng(7));
  const b = split(Buffer.from('two'), 2, 3, prng(8));
  assert.throws(() => combine([a[0]!, b[1]!]), /not from the same set/);
  assert.throws(() => combine([a[0]!, a[0]!]), /twice/);
  assert.throws(() => combine([a[0]!, { ...a[1]!, x: 0 }]), /out of range/);
  assert.throws(() => combine([]), /no shares/);
});

test('a wrong share is caught by the commitment instead of returning garbage', () => {
  const secret = Buffer.from('launch codes');
  const shares = split(secret, 3, 5, prng(9));
  const corrupt = { ...shares[1]!, data: Buffer.from(shares[1]!.data) };
  corrupt.data[0] = corrupt.data[0]! ^ 0x01;
  assert.throws(() => combine([shares[0]!, corrupt, shares[2]!]), /do not rebuild/);
  assert.deepEqual(combine([shares[0]!, shares[3]!, shares[2]!]), secret);
});

test('verify passes a sound set and names the share that disagrees', () => {
  const shares = split(Buffer.from('a secret worth keeping'), 3, 6, prng(10));
  assert.deepEqual(verify(shares), { ok: true, problems: [], suspect: [] });
  const bad = { ...shares[4]!, data: Buffer.from(shares[4]!.data) };
  bad.data[3] = bad.data[3]! ^ 0x80;
  const v = verify([...shares.slice(0, 4), bad, shares[5]!]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.suspect, [5]);
  assert.match(v.problems[0]!, /share 5 disagrees/);
});

test('verify with exactly k shares relies on the commitment, and reports too few or mixed sets', () => {
  const shares = split(Buffer.from('s3cr3t'), 3, 5, prng(11));
  assert.equal(verify(shares.slice(0, 3)).ok, true);
  const bad = { ...shares[0]!, data: Buffer.from(shares[0]!.data) };
  bad.data[0] = bad.data[0]! ^ 1;
  const v = verify([bad, shares[1]!, shares[2]!]);
  assert.equal(v.ok, false);
  assert.match(v.problems[0]!, /no group/);
  assert.match(verify(shares.slice(0, 2)).problems[0]!, /2 of the 3/);
  assert.match(verify([shares[0]!, split(Buffer.from('z'), 3, 5, prng(12))[1]!]).problems[0]!, /same set/);
});

test('text form round trips and carries the threshold, number and set', () => {
  const [s1] = split(Buffer.from('hello'), 2, 3, prng(13)) as [Share];
  const text = encodeShare(s1);
  assert.match(text, /^zs1-[0-9a-f]{12}-2-3-1-[0-9a-f]{10}-[0-9a-f]{32}-[0-9a-f]{8}$/);
  const back = decodeShare(`  ${text.toUpperCase()}\n`);
  assert.deepEqual(back, s1);
  assert.equal(describeShare(back), `share 1 of 3, 2 needed, set ${s1.set}`);
});

test('a mistyped, truncated or hostile share string is refused with a plain message', () => {
  const [s1] = split(Buffer.from('hello'), 2, 3, prng(14)) as [Share];
  const text = encodeShare(s1);
  const parts = text.split('-');
  const typo = [...parts]; typo[5] = (typo[5]![0] === '0' ? '1' : '0') + typo[5]!.slice(1);
  assert.throws(() => decodeShare(typo.join('-')), /typing mistake/);
  assert.throws(() => decodeShare(text.slice(0, -3)), ShareError);
  assert.throws(() => decodeShare('hello world'), /not a share/);
  assert.throws(() => decodeShare(''), /not a share/);
  assert.throws(() => decodeShare('x'.repeat(5 * 1024 * 1024)), /too long/);
  assert.throws(() => decodeShare(text.replace('zs1', 'zs2')), ShareError);
  const odd = ['zs1', parts[1], '2', '3', '9', parts[5], parts[6]].join('-');
  assert.throws(() => decodeShare(`${odd}-00000000`), ShareError);
});

test('text helpers split and rebuild a UTF-8 secret through typed-in shares', () => {
  const texts = splitText('pässwörd ✓ 秘密', 2, 4, prng(15));
  assert.equal(combineText([texts[3]!, texts[0]!]), 'pässwörd ✓ 秘密');
  assert.throws(() => combineText([texts[0]!]), /1 of the 2/);
});

test('a share alone is uniform-looking: two splits of the same secret give unrelated data', () => {
  const a = split(Buffer.alloc(32, 0), 2, 2, prng(16));
  const b = split(Buffer.alloc(32, 0), 2, 2, prng(17));
  assert.notDeepEqual(a[0]!.data, b[0]!.data);
  assert.notDeepEqual(a[0]!.data, Buffer.alloc(32, 0));
  const distinct = new Set(a[0]!.data);
  assert.ok(distinct.size > 16);
});
