/**
 * Password rules that follow NIST SP 800-63B rather than folklore: length over composition, no forced rotation, no
 * hints, a block list, and a check against passwords known from breaches. Holds four things. (1) A strength estimator:
 * not a character-class count but a guess-count estimate from the cheapest way an attacker would build the password
 * (common-password list, dictionary words with l33t substitution, keyboard walks, sequences, repeats, dates, and
 * brute force), with a 0-4 score and a plain explanation; context words (email, name, product) are guessed first.
 * (2) A breached-password check as a plan, not a call: `rangeQuery` gives the 5-hex-character prefix to send to a k-
 * anonymity range service (the Have I Been Pwned model) and `matchRange` reads the response locally, so the password
 * and its full hash never leave; the caller does the HTTP. (3) History and reuse limits: `History` keeps salted
 * hashes of recent passwords, supplied by the caller's hasher, and refuses reuse and near-reuse (a trailing counter).
 * (4) Policy text generated from the policy itself, so what users read matches what is enforced.
 *
 * Out of scope: the HTTP call to the breach service, a large built-in word list (the bundled list is a small seed of
 * the most common passwords: pass your own with `common`), password hashing (see password-hash), and rotation on
 * schedule (NIST advises against it; `mustChange` only fires on evidence of compromise or age you choose to set).
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- policy

export interface Policy {
  /** NIST: at least 8; 12 or more recommended; 15 for single-factor. */
  readonly minLength: number;
  /** Generous: NIST asks for at least 64. */
  readonly maxLength: number;
  readonly minScore: 0 | 1 | 2 | 3 | 4;
  /** Block anything the estimator finds in a context word (name, email local part, product name). */
  readonly blockContext: boolean;
  readonly blockBreached: boolean;
  readonly historySize: number;
  /** Optional maximum age in days: off by default; NIST advises against scheduled rotation. */
  readonly maxAgeDays?: number;
  /** Composition rules are off by default; set to require them anyway. */
  readonly requireClasses?: number;
}

export const DEFAULT_POLICY: Policy = { minLength: 12, maxLength: 128, minScore: 3, blockContext: true, blockBreached: true, historySize: 5 };

// ---------------------------------------------------------------- common passwords (a seed, not a database)

export const COMMON_SEED: readonly string[] = [
  'password', '123456', '12345678', '123456789', 'qwerty', 'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou', 'admin', 'welcome', 'login', 'passw0rd', 'master', 'sunshine', 'princess', 'football', 'baseball', 'shadow', 'superman', 'michael', 'trustno1', 'starwars', 'whatever', 'freedom', 'qazwsx', '1q2w3e4r', 'zaq12wsx', 'hello', 'charlie', 'donald', 'mustang', 'access', 'flower', 'hottie', 'loveme', 'batman', 'ashley', 'jordan', 'summer', 'winter', 'secret', 'computer', 'internet', 'google', 'changeme', 'default', 'test', 'guest', 'root', 'p@ssw0rd', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'pass', 'love', 'angel', 'cookie', 'chocolate', 'orange', 'soccer', 'hockey', 'killer', 'pepper', 'tigger', 'cheese', 'banana', 'london', 'spring', 'autumn', 'purple', 'silver', 'golden', 'merlin', 'matrix', 'ranger', 'harley', 'thomas', 'robert', 'daniel', 'jessica', 'hunter', 'buster', 'soccer1', 'welcome1', 'password1', 'password123', 'iloveyou1', 'letmein1',
];

const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i', '+': 't', '(': 'c', '9': 'g' };
const LEET_ALT: Record<string, string> = { '1': 'i' };

const ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '!@#$%^&*()'];

// ---------------------------------------------------------------- estimator

export interface Match {
  readonly kind: 'common' | 'context' | 'word' | 'keyboard' | 'sequence' | 'repeat' | 'date' | 'brute';
  readonly token: string;
  readonly guesses: number;
  readonly start: number;
  readonly end: number;
}
export interface Estimate {
  readonly guesses: number;
  readonly log10: number;
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly matches: readonly Match[];
  readonly warning: string | undefined;
  readonly suggestions: readonly string[];
}

export interface EstimateOptions {
  readonly common?: readonly string[];
  /** Words an attacker who knows the user would try: name, email local part, company, product. */
  readonly context?: readonly string[];
}

const norm = (s: string) => s.toLowerCase();
const delet = (s: string) => [...norm(s)].map((c) => LEET[c] ?? c).join('');
const deletAlt = (s: string) => [...norm(s)].map((c) => LEET_ALT[c] ?? LEET[c] ?? c).join('');

function classesIn(s: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
}
function bruteGuesses(s: string): number {
  let card = 0;
  if (/[a-z]/.test(s)) card += 26;
  if (/[A-Z]/.test(s)) card += 26;
  if (/\d/.test(s)) card += 10;
  if (/[^A-Za-z0-9]/.test(s)) card += 33;
  return Math.pow(Math.max(card, 10), s.length);
}

/** Estimates how many guesses an attacker needs. Lower bound by the cheapest decomposition (dynamic programming). */
export function estimate(password: string, o: EstimateOptions = {}): Estimate {
  const pw = password.normalize('NFKC');
  const n = pw.length;
  const common = new Map<string, number>();
  (o.common ?? COMMON_SEED).forEach((w, i) => common.set(norm(w), i + 1));
  const ctx = new Set((o.context ?? []).map(norm).filter((w) => w.length >= 3));
  const cands: Match[] = [];
  const lower = norm(pw);
  const leet = delet(pw);
  const leet2 = deletAlt(pw);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= n; j++) {
      const raw = pw.slice(i, j);
      const low = lower.slice(i, j);
      const lt = leet.slice(i, j);
      const lt2 = leet2.slice(i, j);
      if (j - i >= 3) {
        const caps = raw !== low && raw !== raw.toUpperCase() && !(raw[0] === raw[0]!.toUpperCase() && raw.slice(1) === low.slice(1)) ? 4 : raw !== low ? 2 : 1;
        const subst = lt !== low ? 2 : 1;
        for (const form of new Set([low, lt, lt2])) {
          const rank = common.get(form);
          if (rank !== undefined) cands.push({ kind: 'common', token: raw, guesses: rank * caps * (form === low ? 1 : subst), start: i, end: j });
          if (ctx.has(form)) cands.push({ kind: 'context', token: raw, guesses: 10 * caps * (form === low ? 1 : subst), start: i, end: j });
        }
        // sequences: abc, 321, 2468
        if (j - i >= 3) {
          const step = low.charCodeAt(1) - low.charCodeAt(0);
          if (Math.abs(step) >= 1 && Math.abs(step) <= 3) {
            let ok = true;
            for (let k = 1; k < low.length; k++) if (low.charCodeAt(k) - low.charCodeAt(k - 1) !== step) ok = false;
            if (ok && /^[a-z0-9]+$/.test(low)) cands.push({ kind: 'sequence', token: raw, guesses: 26 * (j - i) * 2, start: i, end: j });
          }
        }
        // repeats: aaa, abab
        for (let p = 1; p <= Math.floor((j - i) / 2); p++) {
          if ((j - i) % p) continue;
          const unit = raw.slice(0, p);
          if (unit.repeat((j - i) / p) === raw) {
            cands.push({ kind: 'repeat', token: raw, guesses: (p < j - i ? estimate(unit, o).guesses : bruteGuesses(unit)) * ((j - i) / p), start: i, end: j });
            break;
          }
        }
        // keyboard walks along a row, either direction
        for (const row of ROWS) {
          if (row.includes(low) || [...row].reverse().join('').includes(low)) cands.push({ kind: 'keyboard', token: raw, guesses: 40 * (j - i) * 2, start: i, end: j });
        }
      }
      // years and dates: 1980-2039, ddmmyyyy, mmddyy
      if (/^(19|20)\d{2}$/.test(raw)) cands.push({ kind: 'date', token: raw, guesses: 120, start: i, end: j });
      else if (/^\d{6}$|^\d{8}$/.test(raw) && validDate(raw)) cands.push({ kind: 'date', token: raw, guesses: 365 * 60, start: i, end: j });
    }
  }
  // dictionary words that are not in the common list are unknowable here; everything else is brute force per character.
  const best: { cost: number; via: Match | undefined; from: number }[] = Array.from({ length: n + 1 }, () => ({ cost: Infinity, via: undefined, from: 0 }));
  best[0] = { cost: 1, via: undefined, from: 0 };
  const byEnd = new Map<number, Match[]>();
  for (const c of cands) byEnd.set(c.end, [...(byEnd.get(c.end) ?? []), c]);
  for (let k = 1; k <= n; k++) {
    // one brute-force character
    const ch = pw[k - 1]!;
    const bc = best[k - 1]!.cost * charCard(pw);
    if (bc < best[k]!.cost) best[k] = { cost: bc, via: { kind: 'brute', token: ch, guesses: charCard(pw), start: k - 1, end: k }, from: k - 1 };
    for (const m of byEnd.get(k) ?? []) {
      const c = best[m.start]!.cost * m.guesses;
      if (c < best[k]!.cost) best[k] = { cost: c, via: m, from: m.start };
    }
  }
  const matches: Match[] = [];
  for (let k = n; k > 0; ) {
    const b = best[k]!;
    matches.unshift(b.via!);
    k = b.from;
  }
  // merge adjacent brute chars
  const merged: Match[] = [];
  for (const m of matches) {
    const last = merged.at(-1);
    if (m.kind === 'brute' && last?.kind === 'brute') merged[merged.length - 1] = { ...last, token: last.token + m.token, guesses: last.guesses * m.guesses, end: m.end };
    else merged.push(m);
  }
  // a mix of pieces costs more than the sum order alone: add a factorial term for the number of pieces
  const pieces = merged.length;
  let guesses = best[n]!.cost * factorial(pieces);
  if (n === 0) guesses = 1;
  const lengthFloor = n > 0 ? 1 : 0;
  guesses = Math.max(guesses, lengthFloor);
  const log10 = Math.log10(Math.max(guesses, 1));
  const score: Estimate['score'] = log10 < 3 ? 0 : log10 < 6 ? 1 : log10 < 8 ? 2 : log10 < 10 ? 3 : 4;
  const warn = warning(merged, n);
  return { guesses, log10, score, matches: merged, warning: warn, suggestions: suggest(merged, pw, score) };
}

function charCard(s: string): number {
  let card = 0;
  if (/[a-z]/.test(s)) card += 26;
  if (/[A-Z]/.test(s)) card += 26;
  if (/\d/.test(s)) card += 10;
  if (/[^A-Za-z0-9]/.test(s)) card += 33;
  return Math.max(card, 10);
}
const factorial = (k: number) => {
  let r = 1;
  for (let i = 2; i <= Math.min(k, 8); i++) r *= i;
  return r;
};
function validDate(s: string): boolean {
  const cands = s.length === 8 ? [[s.slice(0, 2), s.slice(2, 4)], [s.slice(2, 4), s.slice(0, 2)], [s.slice(4, 6), s.slice(6, 8)]] : [[s.slice(0, 2), s.slice(2, 4)], [s.slice(2, 4), s.slice(0, 2)]];
  return cands.some(([a, b]) => Number(a) >= 1 && Number(a) <= 31 && Number(b) >= 1 && Number(b) <= 12);
}

function warning(ms: readonly Match[], n: number): string | undefined {
  if (n === 0) return 'The password is empty.';
  if (ms.length === 1) {
    const m = ms[0]!;
    if (m.kind === 'common') return 'This is one of the most commonly used passwords.';
    if (m.kind === 'context') return 'This is easy to guess from information about you or this service.';
    if (m.kind === 'keyboard') return 'A row of keys on the keyboard is easy to guess.';
    if (m.kind === 'sequence') return 'A run of consecutive characters is easy to guess.';
    if (m.kind === 'repeat') return 'Repeated characters are easy to guess.';
    if (m.kind === 'date') return 'Dates are easy to guess.';
  }
  if (ms.some((m) => m.kind === 'context')) return 'Part of this is easy to guess from information about you or this service.';
  if (ms.some((m) => m.kind === 'common' && m.token.length >= n - 4)) return 'This is a common password with a small change, which attackers try first.';
  return undefined;
}
function suggest(ms: readonly Match[], pw: string, score: number): string[] {
  const out: string[] = [];
  if (score >= 3) return out;
  if (pw.length < 12) out.push('Use a longer password: several unrelated words make a good passphrase.');
  if (ms.some((m) => m.kind === 'common')) out.push('Avoid common passwords and common words with a number or symbol added.');
  if (ms.some((m) => m.kind === 'keyboard' || m.kind === 'sequence' || m.kind === 'repeat')) out.push('Avoid patterns such as keyboard rows, runs and repeats.');
  if (ms.some((m) => m.kind === 'date')) out.push('Avoid dates and years.');
  if (ms.some((m) => m.kind === 'context')) out.push('Do not use your name, email or the name of this service.');
  return out;
}

// ---------------------------------------------------------------- breach range query

export interface RangePlan {
  /** Send this to the range service: GET https://api.pwnedpasswords.com/range/<prefix>. */
  readonly prefix: string;
  /** Keep this; it never leaves the process. */
  readonly suffix: string;
}

/** SHA-1 is what the range services index; it is used here for lookup only, never for storage. */
export function rangeQuery(password: string): RangePlan {
  const h = createHash('sha1').update(password.normalize('NFKC'), 'utf8').digest('hex').toUpperCase();
  return { prefix: h.slice(0, 5), suffix: h.slice(5) };
}

/** Reads a range response ("SUFFIX:COUNT" lines, with optional padding rows of count 0) and returns the breach count. */
export function matchRange(plan: RangePlan, body: string): number {
  if (body.length > 2 * 1024 * 1024) throw new RangeError('range response too large');
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i !== 35) continue;
    if (line.slice(0, 35).toUpperCase() === plan.suffix) {
      const c = Number(line.slice(36).trim());
      return Number.isFinite(c) ? c : 0;
    }
  }
  return 0;
}

// ---------------------------------------------------------------- history

export interface Hasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
export interface HistoryEntry {
  readonly hash: string;
  readonly at: number;
}

/** Strips a trailing counter or year so "Winter2024!" and "Winter2025!" read as the same base. */
export const baseOf = (pw: string) => norm(pw.normalize('NFKC')).replace(/[\d!@#$%^&*._-]+$/g, '');

/**
 * Recent-password memory. Entries are salted hashes from the caller's hasher (use password-hash), newest first.
 * `check` refuses exact reuse of any retained password; for near-reuse it needs the new password's base compared with
 * the bases of the old ones, which are stored as hashes of the base too (`baseHash`).
 */
export class History {
  readonly #h: Hasher;
  readonly #size: number;
  constructor(h: Hasher, size: number) {
    this.#h = h;
    this.#size = size;
  }
  async check(entries: readonly { readonly pw: HistoryEntry; readonly base: HistoryEntry }[], password: string): Promise<'ok' | 'reused' | 'near'> {
    for (const e of entries.slice(0, this.#size)) {
      if (await this.#h.verify(password, e.pw.hash)) return 'reused';
    }
    const b = baseOf(password);
    if (b.length >= 4) for (const e of entries.slice(0, this.#size)) if (await this.#h.verify(b, e.base.hash)) return 'near';
    return 'ok';
  }
  async record(entries: readonly { readonly pw: HistoryEntry; readonly base: HistoryEntry }[], password: string, now: number) {
    const next = [{ pw: { hash: await this.#h.hash(password), at: now }, base: { hash: await this.#h.hash(baseOf(password)), at: now } }, ...entries];
    return next.slice(0, this.#size);
  }
}

// ---------------------------------------------------------------- evaluate

export interface Verdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly estimate: Estimate;
}

export interface Evaluation {
  readonly policy?: Policy;
  readonly context?: readonly string[];
  readonly common?: readonly string[];
  /** The count from `matchRange`, when the caller has made the range query. */
  readonly breachCount?: number;
}

/** Judges a password against a policy. Messages are for the user and never repeat the password. */
export function evaluate(password: string, o: Evaluation = {}): Verdict {
  const p = o.policy ?? DEFAULT_POLICY;
  const problems: string[] = [];
  const len = [...password.normalize('NFKC')].length;
  if (len < p.minLength) problems.push(`Use at least ${p.minLength} characters.`);
  if (len > p.maxLength) problems.push(`Use at most ${p.maxLength} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(password)) problems.push('Remove control characters.');
  const est = estimate(password, { ...(o.common ? { common: o.common } : {}), ...(p.blockContext && o.context ? { context: o.context } : {}) });
  if (est.score < p.minScore) problems.push(est.warning ?? 'This password is too easy to guess.');
  if (p.requireClasses && classesIn(password) < p.requireClasses) problems.push(`Use at least ${p.requireClasses} kinds of character (lowercase, uppercase, digits, symbols).`);
  if (p.blockBreached && (o.breachCount ?? 0) > 0) problems.push('This password has appeared in a data breach. Choose another.');
  return { ok: problems.length === 0, problems, estimate: est };
}

/** Whether the stored password is old enough that the policy (if it has a maximum age) asks for a change. */
export function mustChange(p: Policy, changedAt: number, now: number, compromised = false): boolean {
  if (compromised) return true;
  return p.maxAgeDays !== undefined && now - changedAt > p.maxAgeDays * 86_400_000;
}

/** The rules as text for the sign-up form, derived from the policy so that the two cannot drift apart. */
export function describePolicy(p: Policy = DEFAULT_POLICY): string[] {
  const out = [`At least ${p.minLength} characters; up to ${p.maxLength} are accepted. Spaces and any language are fine.`];
  out.push('A passphrase of several unrelated words is a good choice.');
  if (p.minScore >= 3) out.push('It must not be easy to guess: common passwords, keyboard patterns, dates and your own details are refused.');
  if (p.blockBreached) out.push('It is checked against passwords known from data breaches, without sending the password anywhere.');
  if (p.historySize > 0) out.push(`It must differ from your last ${p.historySize} passwords.`);
  if (p.requireClasses) out.push(`It must use at least ${p.requireClasses} kinds of character.`);
  if (p.maxAgeDays !== undefined) out.push(`You will be asked to change it every ${p.maxAgeDays} days.`);
  else out.push('You will not be asked to change it on a schedule, only if it may have been exposed.');
  return out;
}
