/**
 * Finding what someone meant. Edit distance (Levenshtein, optimal-string-alignment, and true unrestricted
 * Damerau-Levenshtein where a swap of neighbours counts once, with an optional cut-off that stops early), Jaro and
 * Jaro-Winkler, trigram similarity the way PostgreSQL's pg_trgm counts it (words padded with two spaces in front
 * and one behind), phonetic keys (American Soundex and Metaphone), token sort and token set scores for names
 * written in a different order or with extra words, and a trigram index that finds candidates without comparing
 * against everything. Scores run from 0 (nothing alike) to 1 (the same after folding case and accents). `suggest`
 * ranks candidates for a query using all of these, says why each matched, and applies a threshold that depends
 * on the length of the word, because one wrong letter in three is a different word and one in twelve is a typo.
 * Strings over 10,000 characters are refused, since edit distance grows with their product.
 */

export class TooLong extends Error {
  constructor() {
    super('text over 10,000 characters is not compared');
  }
}

const MAX = 10_000;

/** Lower-case, accents removed, punctuation made into single spaces. */
export function normalise(s: string): string {
  if (s.length > MAX) throw new TooLong();
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^\p{L}\p{Nd}]+/gu, ' ').trim();
}

const chars = (s: string) => Array.from(s);

// ---------------------------------------------------------------- edit distance

/** Insert, delete, substitute. With `max`, returns max+1 as soon as the distance must exceed it. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a.length > MAX || b.length > MAX) throw new TooLong();
  const x = chars(a);
  const y = chars(b);
  if (Math.abs(x.length - y.length) > max) return max + 1;
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[y.length]!;
}

/** Optimal string alignment: like Levenshtein, plus swapping two neighbours; no substring is edited twice. */
export function osa(a: string, b: string): number {
  if (a.length > MAX || b.length > MAX) throw new TooLong();
  const x = chars(a);
  const y = chars(b);
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) d[0]![j] = j;
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[x.length]![y.length]!;
}

/** True Damerau-Levenshtein (Lowrance-Wagner): a transposition counts once even if edited further. */
export function damerauLevenshtein(a: string, b: string): number {
  if (a.length > MAX || b.length > MAX) throw new TooLong();
  const x = chars(a);
  const y = chars(b);
  const last = new Map<string, number>();
  const inf = x.length + y.length;
  const d: number[][] = Array.from({ length: x.length + 2 }, () => Array<number>(y.length + 2).fill(0));
  d[0]![0] = inf;
  for (let i = 0; i <= x.length; i++) {
    d[i + 1]![0] = inf;
    d[i + 1]![1] = i;
  }
  for (let j = 0; j <= y.length; j++) {
    d[0]![j + 1] = inf;
    d[1]![j + 1] = j;
  }
  for (let i = 1; i <= x.length; i++) {
    let db = 0;
    for (let j = 1; j <= y.length; j++) {
      const i1 = last.get(y[j - 1]!) ?? 0;
      const j1 = db;
      let cost = 1;
      if (x[i - 1] === y[j - 1]) {
        cost = 0;
        db = j;
      }
      d[i + 1]![j + 1] = Math.min(d[i]![j]! + cost, d[i + 1]![j]! + 1, d[i]![j + 1]! + 1, d[i1]![j1]! + (i - i1 - 1) + 1 + (j - j1 - 1));
    }
    last.set(x[i - 1]!, i);
  }
  return d[x.length + 1]![y.length + 1]!;
}

/** 1 for identical, 0 for nothing in common, from the Damerau-Levenshtein distance over the longer length. */
export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  const n = Math.max(chars(x).length, chars(y).length);
  return n === 0 ? 1 : 1 - damerauLevenshtein(x, y) / n;
}

// ---------------------------------------------------------------- Jaro

export function jaro(a: string, b: string): number {
  if (a.length > MAX || b.length > MAX) throw new TooLong();
  const x = chars(a);
  const y = chars(b);
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const mx = Array<boolean>(x.length).fill(false);
  const my = Array<boolean>(y.length).fill(false);
  let m = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = Math.max(0, i - range); j < Math.min(y.length, i + range + 1); j++)
      if (!my[j] && x[i] === y[j]) {
        mx[i] = my[j] = true;
        m++;
        break;
      }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++)
    if (mx[i]) {
      while (!my[k]) k++;
      if (x[i] !== y[k]) t++;
      k++;
    }
  return (m / x.length + m / y.length + (m - t / 2) / m) / 3;
}

/** Jaro with a bonus for a shared start (up to four characters, scaling 0.1), good for names. */
export function jaroWinkler(a: string, b: string, scale = 0.1): number {
  const j = jaro(a, b);
  const x = chars(a);
  const y = chars(b);
  let p = 0;
  while (p < 4 && p < x.length && p < y.length && x[p] === y[p]) p++;
  return j + p * scale * (1 - j);
}

// ---------------------------------------------------------------- trigrams

/** The trigrams of a text as pg_trgm makes them: per word, two spaces before and one after. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalise(s).split(' ').filter(Boolean)) {
    const p = Array.from(`  ${w} `);
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3).join(''));
  }
  return out;
}

/** Shared trigrams over all trigrams (pg_trgm's similarity). */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size && !y.size) return 1;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface TrigramHit {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

/** An inverted index from trigram to entries: a search touches only entries that share a trigram with the query. */
export class TrigramIndex {
  private readonly texts = new Map<string, string>();
  private readonly grams = new Map<string, Set<string>>();
  private readonly postings = new Map<string, Set<string>>();

  add(id: string, text: string): void {
    this.remove(id);
    const g = trigrams(text);
    this.texts.set(id, text);
    this.grams.set(id, g);
    for (const t of g) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Set()));
      p.add(id);
    }
  }

  remove(id: string): void {
    for (const t of this.grams.get(id) ?? []) {
      const p = this.postings.get(t);
      p?.delete(id);
      if (p && !p.size) this.postings.delete(t);
    }
    this.grams.delete(id);
    this.texts.delete(id);
  }

  get size(): number {
    return this.texts.size;
  }

  /** Entries whose similarity to the query reaches the threshold, best first (ties by id). */
  search(query: string, o: { threshold?: number; limit?: number } = {}): TrigramHit[] {
    const q = trigrams(query);
    const shared = new Map<string, number>();
    for (const t of q) for (const id of this.postings.get(t) ?? []) shared.set(id, (shared.get(id) ?? 0) + 1);
    const hits: TrigramHit[] = [];
    for (const [id, n] of shared) {
      const score = n / (q.size + this.grams.get(id)!.size - n);
      if (score >= (o.threshold ?? 0.3)) hits.push({ id, text: this.texts.get(id)!, score });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return o.limit ? hits.slice(0, o.limit) : hits;
  }
}

// ---------------------------------------------------------------- phonetic keys

/** American Soundex: a letter and three digits; H and W do not separate letters with the same code. */
export function soundex(word: string): string {
  const w = word.normalize('NFKD').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!w) return '';
  const code = (c: string) => ('BFPV'.includes(c) ? '1' : 'CGJKQSXZ'.includes(c) ? '2' : 'DT'.includes(c) ? '3' : c === 'L' ? '4' : 'MN'.includes(c) ? '5' : c === 'R' ? '6' : '');
  let out = w[0]!;
  let prev = code(w[0]!);
  for (const c of w.slice(1)) {
    const k = code(c);
    if (k && k !== prev) out += k;
    if (c !== 'H' && c !== 'W') prev = k;
    if (out.length === 4) break;
  }
  return out.padEnd(4, '0');
}

/** The original Metaphone (Philips, 1990): consonant sounds of English words, vowels kept only at the start. */
export function metaphone(word: string): string {
  let w = word.normalize('NFKD').replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!w) return '';
  if (/^(AE|GN|KN|PN|WR)/.test(w)) w = w.slice(1);
  else if (w[0] === 'X') w = `S${w.slice(1)}`;
  else if (w.startsWith('WH')) w = `W${w.slice(2)}`;
  const V = 'AEIOU';
  const at = (i: number) => w[i] ?? '';
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (c === at(i - 1) && c !== 'C') continue;
    const n = at(i + 1);
    switch (c) {
      case 'A': case 'E': case 'I': case 'O': case 'U':
        if (i === 0) out += c;
        break;
      case 'B':
        if (!(i === w.length - 1 && at(i - 1) === 'M')) out += 'B';
        break;
      case 'C':
        if ('EIY'.includes(n) && n) out += at(i - 1) === 'S' ? '' : n === 'I' && at(i + 2) === 'A' ? 'X' : 'S';
        else if (n === 'H') {
          out += i === 0 && !V.includes(at(i + 2)) ? 'K' : 'X';
          i++;
        } else out += 'K';
        break;
      case 'D':
        if (n === 'G' && 'EIY'.includes(at(i + 2)) && at(i + 2)) {
          out += 'J';
          i++;
        } else out += 'T';
        break;
      case 'G':
        if (n === 'H') {
          if (i + 2 < w.length && !V.includes(at(i + 2))) break;
          out += i + 2 >= w.length ? 'F' : 'K';
          i++;
          break;
        }
        if (n === 'N' && (i + 2 === w.length || (at(i + 2) === 'E' && at(i + 3) === 'D' && i + 4 === w.length))) break;
        out += 'EIY'.includes(n) && n && at(i - 1) !== 'G' ? 'J' : 'K';
        break;
      case 'H':
        if (V.includes(n) && n && !'CGPST'.includes(at(i - 1))) out += 'H';
        break;
      case 'K':
        if (at(i - 1) !== 'C') out += 'K';
        break;
      case 'P':
        if (n === 'H') {
          out += 'F';
          i++;
        } else out += 'P';
        break;
      case 'Q':
        out += 'K';
        break;
      case 'S':
        if (n === 'H') {
          out += 'X';
          i++;
        } else if (n === 'I' && 'OA'.includes(at(i + 2)) && at(i + 2)) out += 'X';
        else out += 'S';
        break;
      case 'T':
        if (n === 'I' && 'OA'.includes(at(i + 2)) && at(i + 2)) out += 'X';
        else if (n === 'H') {
          if (at(i + 2) === 'M') {
            out += 'T';
          } else out += '0';
          i++;
        } else if (!(n === 'C' && at(i + 2) === 'H')) out += 'T';
        break;
      case 'V':
        out += 'F';
        break;
      case 'W': case 'Y':
        if (V.includes(n) && n) out += c;
        break;
      case 'X':
        out += 'KS';
        break;
      case 'Z':
        out += 'S';
        break;
      default:
        out += c;
    }
  }
  return out;
}

// ---------------------------------------------------------------- token scores

const tokens = (s: string) => normalise(s).split(' ').filter(Boolean);

/** Names in a different order: words sorted before comparing. */
export function tokenSort(a: string, b: string): number {
  return similarity(tokens(a).sort().join(' '), tokens(b).sort().join(' '));
}

/**
 * Extra words do not count against a match: the words both have are compared with each text's own words, and the
 * best of the three pairings is the score ("John Smith" against "Smith, John Q. Public" is 1 for the shared part).
 */
export function tokenSet(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  const both = [...x].filter((t) => y.has(t)).sort().join(' ');
  const ra = [...x].filter((t) => !y.has(t)).sort().join(' ');
  const rb = [...y].filter((t) => !x.has(t)).sort().join(' ');
  const t0 = both;
  const t1 = `${both} ${ra}`.trim();
  const t2 = `${both} ${rb}`.trim();
  if (!x.size && !y.size) return 1;
  if (!both) return similarity(t1, t2);
  return Math.max(similarity(t0, t1), similarity(t0, t2), similarity(t1, t2));
}

// ---------------------------------------------------------------- ranked suggestions

/** How many edits a word of this length may be off by and still be a plausible match. */
export const allowedEdits = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : len <= 10 ? 2 : 3);

export interface Suggestion {
  readonly text: string;
  readonly score: number;
  readonly why: readonly string[];
}

export interface SuggestOptions {
  /** Lowest score to return; default 0.6. */
  readonly threshold?: number;
  readonly limit?: number;
}

/** Candidates ranked for a query, each with its score and the reasons. Exact (after folding) always scores 1. */
export function suggest(query: string, candidates: readonly string[], o: SuggestOptions = {}): Suggestion[] {
  const q = normalise(query);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const n = normalise(c);
    const why: string[] = [];
    let score: number;
    if (n === q) {
      score = 1;
      why.push('same after ignoring case, accents and punctuation');
    } else {
      const dl = damerauLevenshtein(q, n);
      const edit = 1 - dl / Math.max(chars(q).length, chars(n).length, 1);
      const tri = trigramSimilarity(q, n);
      const tok = Math.max(tokenSort(q, n), tokenSet(q, n) * 0.95);
      const jw = jaroWinkler(q, n);
      score = Math.max(edit, tri, tok * 0.98, jw * 0.9);
      if (dl <= allowedEdits(chars(q).length) && dl > 0) why.push(`${dl} edit${dl === 1 ? '' : 's'} away`);
      else if (dl > allowedEdits(Math.max(chars(q).length, chars(n).length)) && !tri) score = Math.min(score, 0.3);
      if (n.startsWith(q) && q.length >= 2) {
        score = Math.max(score, 0.75 + 0.2 * (q.length / n.length));
        why.push('starts with what was typed');
      }
      if (tri >= 0.5) why.push(`trigram similarity ${tri.toFixed(2)}`);
      if (tok >= 0.8 && q !== n) why.push('same words, different order or extras');
      const sq = soundex(q);
      if (sq && q.split(' ').length === 1 && sq === soundex(n) && n.split(' ').length === 1) {
        score = Math.max(score, 0.65);
        why.push(`sounds alike (${sq})`);
      }
    }
    if (score >= (o.threshold ?? 0.6)) out.push({ text: c, score: Math.round(Math.min(1, score) * 1000) / 1000, why });
  }
  out.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return o.limit ? out.slice(0, o.limit) : out;
}
