/**
 * Password, passphrase, PIN and username generation with honest entropy accounting. Everything random comes from an
 * injected byte source (default: node:crypto), and every choice is made without modulo bias: a value is drawn from a
 * 32-bit word and thrown away if it falls in the uneven tail (the method of NIST SP 800-90A Appendix A and of
 * `crypto.randomInt`), so each symbol is exactly uniform.
 *
 *  - `password(opts)`: length, character sets (lower, upper, digits, symbols, or your own), a minimum of each set,
 *    characters to leave out (look-alikes like l 1 I O 0, or whatever a site forbids), and a longest allowed run of one
 *    character. Strings are drawn uniformly from ALL strings satisfying the rules (rejection sampling), so the entropy
 *    reported is exact: it is log2 of the number of strings that satisfy the rules, counted by dynamic programming,
 *    not a guess from the pool size. Rules that cannot be met are refused up front.
 *  - `passphrase(opts)`: words drawn uniformly from a list with an optional separator, capitalisation and a number.
 *    The built-in list is 4096 pronounceable pseudo-words made of syllables (12 bits a word); a real dictionary can be
 *    passed and is checked for duplicates, because a repeated word would silently lower the entropy.
 *  - `pin(length)` and `username(opts)` (pseudo-word plus digits), each with its entropy.
 *  - `check(password, rules)`: a site's published rules (length bounds, required sets, forbidden characters, longest
 *    run) as a list of plain problems; `estimate(password)`: an upper bound on the entropy of a password someone else
 *    chose, which penalises what people actually do (repeats, sequences, one character class) and says it is a bound.
 *
 * Not here: breach lookups (a network call), and password storage (see the password-hash and vault-model blocks).
 */
import { randomBytes } from 'node:crypto';

export class GeneratorError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Random = (bytes: number) => Buffer;
const live: Random = (n) => randomBytes(n);

/** A uniform integer in [0, n) without modulo bias. */
export function randomBelow(n: number, random: Random = live): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new GeneratorError('the range must be a whole number from 1 to 2^32');
  if (n === 1) return 0;
  const range = 2 ** 32;
  const limit = range - (range % n);
  for (let tries = 0; tries < 1000; tries++) {
    const b = random(4);
    if (b.length < 4) throw new GeneratorError('the random source returned too few bytes');
    const v = b.readUInt32BE(0);
    if (v < limit) return v % n;
  }
  throw new GeneratorError('the random source never produced a usable value');
}

export const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>?/',
} as const;
export const AMBIGUOUS = 'Il1O0o|`\'"';

export interface PasswordOptions {
  readonly length?: number;
  /** Named sets or custom strings; default all four standard sets. */
  readonly sets?: readonly (keyof typeof SETS | { readonly chars: string })[];
  /** At least this many characters from each set (default 1 for each chosen set). */
  readonly minimum?: number;
  readonly exclude?: string;
  readonly noAmbiguous?: boolean;
  /** The longest run of the same character allowed (default no limit). */
  readonly maxRun?: number;
}

export interface Plan {
  readonly length: number;
  /** The disjoint sets after exclusions. */
  readonly sets: readonly string[];
  readonly minimum: number;
  readonly maxRun: number;
}

export interface Generated {
  readonly value: string;
  /** log2 of the number of equally likely outputs the rules allow. */
  readonly bits: number;
}

const MAX_LENGTH = 1024;

function plan(o: PasswordOptions): Plan {
  const length = o.length ?? 20;
  if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) throw new GeneratorError(`the length is a whole number from 1 to ${MAX_LENGTH}`);
  const names = o.sets ?? (['lower', 'upper', 'digits', 'symbols'] as const);
  if (!names.length) throw new GeneratorError('choose at least one set of characters');
  const drop = new Set([...(o.exclude ?? ''), ...(o.noAmbiguous ? AMBIGUOUS : '')]);
  const taken = new Set<string>();
  const sets: string[] = [];
  for (const n of names) {
    const raw = typeof n === 'string' ? SETS[n] : n.chars;
    if (typeof n === 'string' && !(n in SETS)) throw new GeneratorError(`"${n}" is not a character set`);
    const chars = [...new Set([...raw])].filter((c) => !drop.has(c) && !taken.has(c));
    for (const c of chars) taken.add(c);
    if (chars.length) sets.push(chars.join(''));
  }
  if (!sets.length) throw new GeneratorError('no characters are left after the exclusions');
  const minimum = o.minimum ?? 1;
  if (!Number.isInteger(minimum) || minimum < 0) throw new GeneratorError('the minimum is a whole number, 0 or more');
  if (minimum * sets.length > length) throw new GeneratorError(`${sets.length} sets with at least ${minimum} each do not fit in ${length} characters`);
  const maxRun = o.maxRun ?? length;
  if (!Number.isInteger(maxRun) || maxRun < 1) throw new GeneratorError('the longest run is a whole number from 1');
  if (maxRun === 1 && sets.join('').length < 2) throw new GeneratorError('no repeats allowed but only one character is available');
  if (maxRun === 1 && length > 1 && sets.join('').length < 2) throw new GeneratorError('not enough characters to avoid repeats');
  return { length, sets, minimum, maxRun: Math.min(maxRun, length) };
}

/** Counts the strings the plan allows, by DP over (capped counts per set, last set, run length). Returns log2. */
export function countBits(p: Plan): number {
  const k = p.sets.length;
  const sizes = p.sets.map((s) => BigInt(s.length));
  const cap = p.minimum;
  // state key: counts capped at `cap` for each set, lastSet, run
  const enc = (counts: number[], last: number, run: number) => counts.join(',') + `|${last}|${run}`;
  let cur = new Map<string, bigint>();
  cur.set(enc(new Array(k).fill(0), -1, 0), 1n);
  for (let pos = 0; pos < p.length; pos++) {
    const next = new Map<string, bigint>();
    for (const [key, ways] of cur) {
      const [cs, ls, rs] = key.split('|') as [string, string, string];
      const counts = cs.split(',').map(Number);
      const last = Number(ls);
      const run = Number(rs);
      for (let s = 0; s < k; s++) {
        const bump = (c: number[]) => { const d = [...c]; d[s] = Math.min(cap, d[s]! + 1); return d; };
        // same character as the last one
        if (s === last) {
          if (run + 1 <= p.maxRun) { const kk = enc(bump(counts), s, run + 1); next.set(kk, (next.get(kk) ?? 0n) + ways); }
          const others = sizes[s]! - 1n;
          if (others > 0n) { const kk = enc(bump(counts), s, 1); next.set(kk, (next.get(kk) ?? 0n) + ways * others); }
        } else {
          const kk = enc(bump(counts), s, 1);
          next.set(kk, (next.get(kk) ?? 0n) + ways * sizes[s]!);
        }
      }
    }
    cur = next;
  }
  let total = 0n;
  for (const [key, ways] of cur) if (key.split('|')[0]!.split(',').every((c) => Number(c) >= cap)) total += ways;
  if (total === 0n) throw new GeneratorError('the rules allow no password');
  return log2Big(total);
}

function log2Big(n: bigint): number {
  const bits = n.toString(2).length;
  if (bits <= 52) return Math.log2(Number(n));
  const top = Number(n >> BigInt(bits - 52));
  return Math.log2(top) + (bits - 52);
}

/** A password drawn uniformly from every string that satisfies the rules. */
export function password(o: PasswordOptions = {}, random: Random = live): Generated {
  const p = plan(o);
  const bits = countBits(p);
  const all = p.sets.join('');
  const setOf = new Map<string, number>();
  p.sets.forEach((s, i) => { for (const c of s) setOf.set(c, i); });
  for (let tries = 0; tries < 100_000; tries++) {
    const chars: string[] = [];
    for (let i = 0; i < p.length; i++) chars.push(all[randomBelow(all.length, random)]!);
    const counts = new Array<number>(p.sets.length).fill(0);
    let run = 1;
    let longest = 1;
    for (let i = 0; i < chars.length; i++) {
      counts[setOf.get(chars[i]!)!]!++;
      if (i > 0) { run = chars[i] === chars[i - 1] ? run + 1 : 1; longest = Math.max(longest, run); }
    }
    if (counts.every((c) => c >= p.minimum) && longest <= p.maxRun) return { value: chars.join(''), bits };
  }
  throw new GeneratorError('could not find a password that meets these rules; loosen them');
}

// ---------------------------------------------------------------- words

const CONSONANTS = 'bdfgklmnprstvz'.slice(0, 14) + 'hj';
const VOWELS = 'aeiu';

/** 16 consonants x 4 vowels = 64 syllables; two syllables make 4096 distinct pronounceable pseudo-words. */
export const WORDS: readonly string[] = (() => {
  const syl: string[] = [];
  for (const c of CONSONANTS) for (const v of VOWELS) syl.push(c + v);
  const out: string[] = [];
  for (const a of syl) for (const b of syl) out.push(a + b);
  return out;
})();

export interface PassphraseOptions {
  readonly words?: number;
  readonly separator?: string;
  readonly capitalize?: boolean;
  /** Append one random digit to a random word. */
  readonly number?: boolean;
  readonly list?: readonly string[];
}

export function checkList(list: readonly string[]): void {
  if (list.length < 2) throw new GeneratorError('a word list needs at least 2 words');
  const seen = new Set<string>();
  for (const w of list) {
    if (!w || /\s/.test(w)) throw new GeneratorError('a word list entry is empty or has a space in it');
    const k = w.toLowerCase();
    if (seen.has(k)) throw new GeneratorError(`the word "${w}" is in the list twice, which would lower the entropy`);
    seen.add(k);
  }
}

export function passphrase(o: PassphraseOptions = {}, random: Random = live): Generated {
  const count = o.words ?? 6;
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new GeneratorError('use 1 to 64 words');
  const list = o.list ?? WORDS;
  if (o.list) checkList(list);
  const sep = o.separator ?? '-';
  if (sep.length > 8) throw new GeneratorError('the separator is at most 8 characters');
  const picked: string[] = [];
  for (let i = 0; i < count; i++) picked.push(list[randomBelow(list.length, random)]!);
  let bits = count * Math.log2(list.length);
  let words = picked.map((w) => (o.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w));
  if (o.number) {
    const at = randomBelow(count, random);
    words = words.map((w, i) => (i === at ? w + String(randomBelow(10, random)) : w));
    bits += Math.log2(count) + Math.log2(10);
  }
  return { value: words.join(sep), bits };
}

export function pin(length = 6, random: Random = live): Generated {
  if (!Number.isInteger(length) || length < 4 || length > 32) throw new GeneratorError('a PIN is 4 to 32 digits');
  let v = '';
  for (let i = 0; i < length; i++) v += String(randomBelow(10, random));
  return { value: v, bits: length * Math.log2(10) };
}

export function username(o: { digits?: number; words?: number; separator?: string } = {}, random: Random = live): Generated {
  const w = o.words ?? 2;
  const d = o.digits ?? 2;
  if (!Number.isInteger(w) || w < 1 || w > 4 || !Number.isInteger(d) || d < 0 || d > 8) throw new GeneratorError('1 to 4 words and 0 to 8 digits');
  const parts: string[] = [];
  for (let i = 0; i < w; i++) parts.push(WORDS[randomBelow(WORDS.length, random)]!);
  let value = parts.join(o.separator ?? '');
  for (let i = 0; i < d; i++) value += String(randomBelow(10, random));
  return { value, bits: w * 12 + d * Math.log2(10) };
}

// ---------------------------------------------------------------- site rules

export interface SiteRules {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly requireLower?: boolean;
  readonly requireUpper?: boolean;
  readonly requireDigit?: boolean;
  readonly requireSymbol?: boolean;
  readonly forbidden?: string;
  readonly maxRun?: number;
  /** Characters the site accepts; anything else is a problem. */
  readonly allowedOnly?: string;
}

export function check(pw: string, r: SiteRules): string[] {
  const out: string[] = [];
  const chars = [...pw];
  if (r.minLength !== undefined && chars.length < r.minLength) out.push(`needs at least ${r.minLength} characters`);
  if (r.maxLength !== undefined && chars.length > r.maxLength) out.push(`needs at most ${r.maxLength} characters`);
  const has = (re: RegExp) => re.test(pw);
  if (r.requireLower && !has(/[a-z]/)) out.push('needs a lower-case letter');
  if (r.requireUpper && !has(/[A-Z]/)) out.push('needs an upper-case letter');
  if (r.requireDigit && !has(/[0-9]/)) out.push('needs a digit');
  if (r.requireSymbol && !has(/[^A-Za-z0-9]/)) out.push('needs a symbol');
  if (r.forbidden) { const bad = [...new Set(chars.filter((c) => r.forbidden!.includes(c)))]; if (bad.length) out.push(`must not contain ${bad.join(' ')}`); }
  if (r.allowedOnly) { const bad = [...new Set(chars.filter((c) => !r.allowedOnly!.includes(c)))]; if (bad.length) out.push(`may not contain ${bad.join(' ')}`); }
  if (r.maxRun !== undefined) {
    let run = 1;
    let longest = chars.length ? 1 : 0;
    for (let i = 1; i < chars.length; i++) { run = chars[i] === chars[i - 1] ? run + 1 : 1; longest = Math.max(longest, run); }
    if (longest > r.maxRun) out.push(`must not repeat a character more than ${r.maxRun} times in a row`);
  }
  return out;
}

/** Translates a site's rules into generator options, or says why they cannot be met. */
export function optionsFor(r: SiteRules): PasswordOptions {
  const sets: ('lower' | 'upper' | 'digits' | 'symbols')[] = ['lower', 'upper', 'digits', 'symbols'];
  const exclude = r.forbidden ?? '';
  const length = Math.min(Math.max(r.minLength ?? 16, 16), r.maxLength ?? 1024);
  if (length < (r.minLength ?? 0)) throw new GeneratorError('the site allows no length that works');
  const base: { sets: NonNullable<PasswordOptions['sets']> } = r.allowedOnly ? { sets: [{ chars: r.allowedOnly }] } : { sets };
  return { length, ...base, minimum: 0, exclude, ...(r.maxRun !== undefined ? { maxRun: r.maxRun } : {}) };
}

/** Generates a password the site accepts, drawing again until `check` is clean. */
export function forSite(r: SiteRules, random: Random = live): Generated {
  const o = optionsFor(r);
  const need = [r.requireLower, r.requireUpper, r.requireDigit, r.requireSymbol].filter(Boolean).length;
  const opts: PasswordOptions = need && !r.allowedOnly ? { ...o, sets: [...(r.requireLower ? ['lower' as const] : []), ...(r.requireUpper ? ['upper' as const] : []), ...(r.requireDigit ? ['digits' as const] : []), ...(r.requireSymbol ? ['symbols' as const] : [])], minimum: 1 } : o;
  const out = password(opts, random);
  const problems = check(out.value, r);
  if (problems.length) throw new GeneratorError(`could not meet the site rules: ${problems.join('; ')}`);
  return out;
}

// ---------------------------------------------------------------- estimating someone else's password

export interface Estimate {
  /** An upper bound: the real strength may be lower. */
  readonly bits: number;
  readonly notes: string[];
}

export function estimate(pw: string): Estimate {
  const notes: string[] = [];
  if (!pw) return { bits: 0, notes: ['empty'] };
  const chars = [...pw];
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  // Repeated and sequential characters add little: count only characters that are new information.
  let informative = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!.codePointAt(0)!;
    const p = i > 0 ? chars[i - 1]!.codePointAt(0)! : -10;
    const pp = i > 1 ? chars[i - 2]!.codePointAt(0)! : -10;
    if (c === p) continue;
    if (Math.abs(c - p) === 1 && (c - p === p - pp)) continue;
    informative++;
  }
  if (informative < chars.length) notes.push(`${chars.length - informative} character(s) continue a repeat or a sequence`);
  const distinct = new Set(chars).size;
  if (distinct < chars.length / 2) notes.push('few distinct characters');
  let bits = informative * Math.log2(Math.max(pool, 2));
  if (pool <= 10) notes.push('digits only');
  if (pool <= 26 && pool > 10) notes.push('one letter case only');
  if (/^[A-Za-z]+[0-9]{1,4}[^A-Za-z0-9]?$/.test(pw)) { bits = Math.min(bits, 17 + Math.log2(1e4) + 1); notes.push('a word with digits on the end is a common pattern'); }
  return { bits, notes };
}
