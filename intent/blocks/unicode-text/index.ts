/**
 * Text as Unicode defines it, for the places where "same" and "different" matter: names, handles, search keys.
 * Normalisation to NFC, NFD, NFKC and NFKD (UAX #15) with refusal of ill-formed text (lone surrogates) and of
 * oversized input; case folding that treats ß, ſ and final sigma the way a person does and settles on one form;
 * grapheme clusters as people count characters (UAX #29, through Intl.Segmenter), with a truncate that never cuts
 * a cluster; locale collation (UTS #10, through Intl.Collator) with natural number order; scripts and mixed-script
 * detection; and a confusable "skeleton" (the idea of UTS #39) so that "paypal" written with Cyrillic letters is
 * caught against the real one, with an identifier check that refuses invisible characters and bidirectional
 * controls. The confusable table is a curated subset of the commonly abused Latin, Cyrillic and Greek look-alikes,
 * not the full UTS #39 data file; full-width and compatibility characters are handled by NFKC first.
 */

export class BadText extends Error {
  constructor(why: string) {
    super(why);
  }
}

const MAX = 1_000_000;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function guard(s: string): string {
  if (typeof s !== 'string') throw new BadText('that is not text');
  if (s.length > MAX) throw new BadText('text longer than a million code units is refused');
  if (LONE.test(s)) throw new BadText('text has a lone surrogate (ill-formed UTF-16)');
  return s;
}

export type Form = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';

export function normalise(s: string, form: Form = 'NFC'): string {
  return guard(s).normalize(form);
}

export const isNormalised = (s: string, form: Form = 'NFC') => guard(s).normalize(form) === s;

/**
 * One form for comparing text that differs only in case or compatibility variants: compatibility-normalised,
 * case-folded (ß becomes ss, final sigma becomes sigma), normalised again. Locale-free, so Turkish dotless i is
 * not special-cased; use collation for locale-aware comparison.
 */
export function fold(s: string): string {
  const a = guard(s).normalize('NFKC');
  return a.toUpperCase().toLowerCase().normalize('NFKC');
}

export const equalFolded = (a: string, b: string) => fold(a) === fold(b);

// ---------------------------------------------------------------- graphemes

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** User-perceived characters (UAX #29 extended grapheme clusters). */
export function graphemes(s: string): string[] {
  return [...segmenter.segment(guard(s))].map((x) => x.segment);
}

export const graphemeLength = (s: string) => graphemes(s).length;

/** At most `max` clusters, with an ellipsis (which counts as one) when something was cut. */
export function truncate(s: string, max: number, ellipsis = '…'): string {
  if (!Number.isInteger(max) || max < 1) throw new BadText('the limit must be a whole number of at least 1');
  const g = graphemes(s);
  if (g.length <= max) return s;
  return g.slice(0, max - 1).join('') + ellipsis;
}

export const reverse = (s: string) => graphemes(s).reverse().join('');

// ---------------------------------------------------------------- collation

export interface CollationOptions {
  /** Digits compare by value: "file2" before "file10". */
  readonly numeric?: boolean;
  /** base: a = á = A; accent: a = A, a != á; case: a = á, a != A; variant (default): all different. */
  readonly sensitivity?: 'base' | 'accent' | 'case' | 'variant';
  readonly upperFirst?: boolean;
}

/** A comparator for a locale, usable directly in sort(). */
export function collator(locale: string, o: CollationOptions = {}): (a: string, b: string) => number {
  let c: Intl.Collator;
  try {
    c = new Intl.Collator(locale, { numeric: o.numeric ?? false, sensitivity: o.sensitivity ?? 'variant', caseFirst: o.upperFirst ? 'upper' : 'false' });
  } catch {
    throw new BadText(`${JSON.stringify(locale.slice(0, 40))} is not a valid locale`);
  }
  return (a, b) => c.compare(guard(a), guard(b));
}

export const sortedFor = (locale: string, list: readonly string[], o: CollationOptions = {}) => [...list].sort(collator(locale, o));

// ---------------------------------------------------------------- scripts

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Hebrew', 'Devanagari', 'Thai', 'Armenian', 'Georgian', 'Bopomofo'] as const;
const scriptRes = SCRIPTS.map((n) => [n, new RegExp(`\\p{Script=${n}}`, 'u')] as const);

export function scriptOf(ch: string): string {
  for (const [n, re] of scriptRes) if (re.test(ch)) return n;
  return /[\p{Script=Common}\p{Script=Inherited}]/u.test(ch) ? 'Common' : 'Other';
}

/** Scripts used, ignoring digits, punctuation and combining marks (Common and Inherited). */
export function scriptsOf(s: string): string[] {
  const out = new Set<string>();
  for (const ch of guard(s)) {
    const x = scriptOf(ch);
    if (x !== 'Common') out.add(x);
  }
  return [...out].sort();
}

const JAPANESE = new Set(['Latin', 'Han', 'Hiragana', 'Katakana']);
const CHINESE = new Set(['Latin', 'Han', 'Bopomofo']);
const KOREAN = new Set(['Latin', 'Han', 'Hangul']);

/** UTS #39 "highly restrictive": one script, or Latin with one of the CJK combinations. */
export function isMixedScript(s: string): boolean {
  const sc = scriptsOf(s);
  if (sc.length <= 1) return false;
  return ![JAPANESE, CHINESE, KOREAN].some((allowed) => sc.every((x) => allowed.has(x)));
}

// ---------------------------------------------------------------- confusables

const PAIRS: readonly [string, string][] = [
  // Cyrillic lower case
  ['а', 'a'], ['с', 'c'], ['е', 'e'], ['о', 'o'], ['р', 'p'], ['х', 'x'], ['у', 'y'], ['і', 'i'], ['ј', 'j'], ['ѕ', 's'], ['ԁ', 'd'], ['һ', 'h'], ['ԛ', 'q'], ['ԝ', 'w'], ['ӏ', 'l'],
  // Cyrillic capitals
  ['А', 'A'], ['В', 'B'], ['Е', 'E'], ['К', 'K'], ['М', 'M'], ['Н', 'H'], ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['Х', 'X'], ['У', 'Y'], ['І', 'I'], ['Ј', 'J'], ['Ѕ', 'S'],
  // Greek
  ['ο', 'o'], ['ν', 'v'], ['α', 'a'], ['ρ', 'p'], ['Α', 'A'], ['Β', 'B'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'H'], ['Ι', 'I'], ['Κ', 'K'], ['Μ', 'M'], ['Ν', 'N'], ['Ο', 'O'], ['Ρ', 'P'], ['Τ', 'T'], ['Χ', 'X'], ['Υ', 'Y'],
  // Latin look-alikes
  ['ı', 'i'], ['ɡ', 'g'], ['ǀ', 'l'], ['ⅼ', 'l'], ['ο', 'o'], ['０', '0'], ['ᴏ', 'o'], ['ƅ', 'b'], ['ɑ', 'a'],
  // Digits and letters that look alike in many fonts
  ['O', '0'], ['I', 'l'], ['1', 'l'], ['|', 'l'],
];
const MAP = new Map(PAIRS);
const SEQUENCES: readonly [string, string][] = [['rn', 'm'], ['vv', 'w'], ['cl', 'd']];
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

/**
 * The skeleton of a string: two strings that look alike have the same skeleton. Compatibility-normalised, invisible
 * characters removed, look-alike letters replaced by one representative, lower-cased, a few letter pairs ("rn")
 * replaced by the letter they imitate.
 */
export function skeleton(s: string): string {
  const n = guard(s).normalize('NFKC').normalize('NFD').replace(IGNORABLE, '');
  let out = '';
  for (const ch of n) out += MAP.get(ch) ?? ch;
  out = out.toLowerCase();
  for (const [from, to] of SEQUENCES) out = out.split(from).join(to);
  return out.normalize('NFD');
}

export const confusable = (a: string, b: string) => skeleton(a) === skeleton(b);

/** The existing names a candidate could be mistaken for (same skeleton, not identical after folding). */
export function lookalikes(candidate: string, existing: readonly string[]): string[] {
  const sk = skeleton(candidate);
  const f = fold(candidate);
  return existing.filter((e) => skeleton(e) === sk && fold(e) !== f);
}

// ---------------------------------------------------------------- identifiers

export interface IdentifierProblem {
  readonly code: 'empty' | 'too-long' | 'not-normalised' | 'invisible' | 'bidi-control' | 'mixed-script' | 'starts-with-mark' | 'whitespace' | 'unassigned-or-private';
  readonly message: string;
}

const BIDI = /[‎‏‪-‮⁦-⁩؜]/u;

/** Everything wrong with a proposed name or handle, so a form can show it all at once. */
export function checkIdentifier(s: string, o: { maxGraphemes?: number } = {}): IdentifierProblem[] {
  const out: IdentifierProblem[] = [];
  const t = guard(s);
  if (t.length === 0) return [{ code: 'empty', message: 'it is empty' }];
  if (graphemeLength(t) > (o.maxGraphemes ?? 64)) out.push({ code: 'too-long', message: `it is longer than ${o.maxGraphemes ?? 64} characters` });
  if (!isNormalised(t, 'NFC')) out.push({ code: 'not-normalised', message: 'it is not in normalised form (NFC)' });
  if (BIDI.test(t)) out.push({ code: 'bidi-control', message: 'it has text-direction controls' });
  else if (/[\p{Default_Ignorable_Code_Point}\p{Cf}]/u.test(t)) out.push({ code: 'invisible', message: 'it has characters that do not show' });
  if (/[\p{Z}\p{Cc}]/u.test(t)) out.push({ code: 'whitespace', message: 'it has spaces or control characters' });
  if (/[\p{Co}\p{Cn}\p{Cs}]/u.test(t)) out.push({ code: 'unassigned-or-private', message: 'it has unassigned or private-use characters' });
  if (isMixedScript(t)) out.push({ code: 'mixed-script', message: `it mixes scripts (${scriptsOf(t).join(', ')}), which is how look-alike names are made` });
  if (/^\p{M}/u.test(t)) out.push({ code: 'starts-with-mark', message: 'it starts with a combining mark' });
  return out;
}
