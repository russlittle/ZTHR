/**
 * Shamir's secret sharing (Shamir, "How to Share a Secret", CACM 1979) over GF(2^8), byte by byte: split a secret
 * into n shares so that any k of them rebuild it and fewer than k reveal nothing about it (information-theoretic,
 * not computational). The field is GF(256) with the AES polynomial x^8+x^4+x^3+x+1 (FIPS 197), so 0x53 * 0xCA = 0x01.
 *
 * What is added around the bare maths, because bare Shamir is silent about every mistake:
 *  - Each share is a self-describing string "zs1-<set>-<k>-<n>-<x>-<data>-<check>" carrying a random set id, the
 *    threshold, the share number and a checksum, so shares of different secrets or sets are never mixed, a mistyped
 *    share is caught before it silently yields garbage, and the person holding it can see "3 of 5, number 2".
 *  - The secret is committed to with a salted SHA-256 inside every share, so `combine` can tell the right secret
 *    from a wrong one when it is rebuilt from the wrong shares or too few of them. A holder cannot learn the secret
 *    from the commitment (the salt is random and the secret is expected to be high-entropy; do not share a short
 *    guessable password this way without adding entropy first).
 *  - `verify` checks that a set of shares is consistent with one polynomial of degree k-1: every k-subset of the shares
 *    given rebuilds the same secret, which catches a cheating or corrupted holder.
 *  - Share x-coordinates are 1..255, so up to 255 shares; k is 2..n. Coefficients come from the injected random source,
 *    rejection-free (a random byte is a uniform field element), and a degree-(k-1) polynomial whose top coefficient is
 *    forced non-zero is not needed for secrecy and is not done.
 *
 * Out of scope: verifiable secret sharing against a dealer who cheats (Feldman, Pedersen), proactive resharing, and
 * share transport. The randomness source and nothing else is an argument.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class ShareError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Random = (bytes: number) => Buffer;

// ---------------------------------------------------------------- GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  // 0x03 generates the multiplicative group under the AES polynomial.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // x * 3 = x ^ (x * 2)
    let x2 = x << 1;
    if (x2 & 0x100) x2 ^= 0x11b;
    x = x2 ^ x;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

export const gfAdd = (a: number, b: number): number => a ^ b;
export const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new ShareError('division by zero in the field');
  return a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!;
}

// ---------------------------------------------------------------- shares

export interface Share {
  /** Random id of the set this share belongs to. */
  readonly set: string;
  readonly k: number;
  readonly n: number;
  /** The x-coordinate, 1 to 255. */
  readonly x: number;
  readonly data: Buffer;
  /** Salted commitment to the secret, the same in every share of a set. */
  readonly commit: string;
}

const MAX_SECRET = 1 << 20;

function commitment(salt: string, secret: Uint8Array): string {
  return createHash('sha256').update('zthr-shamir-v1\0').update(salt).update('\0').update(secret).digest('hex').slice(0, 32);
}

function checksum(parts: string): string {
  return createHash('sha256').update('zthr-share-check\0').update(parts).digest('hex').slice(0, 8);
}

/** Splits `secret` into `n` shares, any `k` of which rebuild it. */
export function split(secret: Uint8Array, k: number, n: number, random: Random = (b) => randomBytes(b)): Share[] {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > 255) throw new ShareError('need 2 <= k <= n <= 255');
  if (secret.length === 0) throw new ShareError('there is no secret to split');
  if (secret.length > MAX_SECRET) throw new ShareError('the secret is too large to split (1 MiB at most)');
  const set = random(6).toString('hex');
  const salt = random(8).toString('hex');
  if (set.length !== 12 || salt.length !== 16) throw new ShareError('the random source returned too few bytes');
  const commit = salt + commitment(salt, secret).slice(0, 16);
  const coeffs = random(secret.length * (k - 1));
  if (coeffs.length !== secret.length * (k - 1)) throw new ShareError('the random source returned too few bytes');
  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    const data = Buffer.alloc(secret.length);
    for (let i = 0; i < secret.length; i++) {
      // Horner: ((c_{k-1} x + c_{k-2}) x + ...) x + secret
      let y = 0;
      for (let j = k - 1; j >= 1; j--) y = gfMul(y, x) ^ coeffs[i * (k - 1) + (j - 1)]!;
      data[i] = gfMul(y, x) ^ secret[i]!;
    }
    shares.push({ set, k, n, x, data, commit });
  }
  return shares;
}

/** Lagrange interpolation at zero of the points (xs[i], ys[i][byte]). */
function interpolate(xs: readonly number[], rows: readonly Buffer[]): Buffer {
  const len = rows[0]!.length;
  const out = Buffer.alloc(len);
  const basis = xs.map((xi, i) => {
    let num = 1;
    let den = 1;
    xs.forEach((xj, j) => {
      if (i === j) return;
      num = gfMul(num, xj);
      den = gfMul(den, xi ^ xj);
    });
    return gfDiv(num, den);
  });
  for (let b = 0; b < len; b++) {
    let acc = 0;
    for (let i = 0; i < xs.length; i++) acc ^= gfMul(rows[i]![b]!, basis[i]!);
    out[b] = acc;
  }
  return out;
}

function checkSet(shares: readonly Share[]): void {
  if (!shares.length) throw new ShareError('no shares were given');
  const f = shares[0]!;
  const seen = new Set<number>();
  for (const s of shares) {
    if (s.set !== f.set || s.k !== f.k || s.n !== f.n || s.commit !== f.commit || s.data.length !== f.data.length) throw new ShareError('these shares are not from the same set');
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > 255) throw new ShareError(`share number ${s.x} is out of range`);
    if (seen.has(s.x)) throw new ShareError(`share number ${s.x} was given twice`);
    seen.add(s.x);
  }
}

function matches(commit: string, secret: Buffer): boolean {
  const salt = commit.slice(0, 16);
  const want = Buffer.from(commit.slice(16), 'utf8');
  const got = Buffer.from(commitment(salt, secret).slice(0, 16), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Rebuilds the secret from at least k shares of one set, and refuses a result that does not match the commitment. */
export function combine(shares: readonly Share[]): Buffer {
  checkSet(shares);
  const k = shares[0]!.k;
  if (shares.length < k) throw new ShareError(`${shares.length} of the ${k} shares needed were given`);
  const use = shares.slice(0, k);
  const secret = interpolate(use.map((s) => s.x), use.map((s) => s.data));
  if (!matches(shares[0]!.commit, secret)) throw new ShareError('the shares do not rebuild the original secret; one is wrong');
  return secret;
}

export interface Verdict {
  readonly ok: boolean;
  readonly problems: string[];
  /** Share numbers that disagree with the rest, when it can be told. */
  readonly suspect: number[];
}

/**
 * Checks a set of shares for consistency: with more than k shares, every k-subset (or a covering sample when there
 * are many) must rebuild the same secret that matches the commitment. With exactly k, only the commitment can say.
 */
export function verify(shares: readonly Share[]): Verdict {
  const problems: string[] = [];
  try {
    checkSet(shares);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message], suspect: [] };
  }
  const k = shares[0]!.k;
  if (shares.length < k) return { ok: false, problems: [`${shares.length} of the ${k} shares needed were given`], suspect: [] };
  // A share is good if some k-subset containing it rebuilds a secret matching the commitment.
  const good = new Set<number>();
  const idx = shares.map((_, i) => i);
  const subsets: number[][] = [];
  const walk = (start: number, cur: number[]) => {
    if (subsets.length >= 5000) return;
    if (cur.length === k) { subsets.push([...cur]); return; }
    for (let i = start; i < idx.length; i++) { cur.push(i); walk(i + 1, cur); cur.pop(); }
  };
  walk(0, []);
  for (const sub of subsets) {
    const pick = sub.map((i) => shares[i]!);
    const secret = interpolate(pick.map((s) => s.x), pick.map((s) => s.data));
    if (matches(shares[0]!.commit, secret)) for (const s of pick) good.add(s.x);
  }
  const suspect = shares.filter((s) => !good.has(s.x)).map((s) => s.x).sort((a, b) => a - b);
  if (good.size === 0) problems.push('no group of shares rebuilds the committed secret');
  else if (suspect.length) problems.push(`share ${suspect.join(', ')} disagree${suspect.length === 1 ? 's' : ''} with the rest`);
  return { ok: problems.length === 0, problems, suspect };
}

// ---------------------------------------------------------------- text form

const HEX = /^[0-9a-f]+$/;

export function encodeShare(s: Share): string {
  const body = `zs1-${s.set}-${s.k}-${s.n}-${s.x}-${s.data.toString('hex')}-${s.commit}`;
  return `${body}-${checksum(body)}`;
}

export function decodeShare(text: string): Share {
  const t = text.trim().toLowerCase();
  if (t.length > 4 * MAX_SECRET) throw new ShareError('that is too long to be a share');
  const parts = t.split('-');
  if (parts.length !== 8 || parts[0] !== 'zs1') throw new ShareError('that is not a share');
  const [, set, ks, ns, xs, data, commit, check] = parts as [string, string, string, string, string, string, string, string];
  if (checksum(parts.slice(0, 7).join('-')) !== check) throw new ShareError('that share has a typing mistake (the check does not match)');
  if (!/^[0-9a-f]{12}$/.test(set) || !/^\d{1,3}$/.test(ks) || !/^\d{1,3}$/.test(ns) || !/^\d{1,3}$/.test(xs) || !HEX.test(data) || data.length % 2 !== 0 || data.length === 0 || !/^[0-9a-f]{32}$/.test(commit)) throw new ShareError('that is not a share');
  const k = Number(ks);
  const n = Number(ns);
  const x = Number(xs);
  if (k < 2 || n < k || n > 255 || x < 1 || x > n) throw new ShareError('that share numbers itself impossibly');
  return { set, k, n, x, data: Buffer.from(data, 'hex'), commit };
}

/** What a holder can be told about a share they typed in, without revealing anything. */
export const describeShare = (s: Share): string => `share ${s.x} of ${s.n}, ${s.k} needed, set ${s.set}`;

export function splitText(secret: string, k: number, n: number, random?: Random): string[] {
  return split(Buffer.from(secret, 'utf8'), k, n, random).map(encodeShare);
}

export const combineText = (shares: readonly string[]): string => combine(shares.map(decodeShare)).toString('utf8');
