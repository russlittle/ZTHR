/**
 * The plain-language block: measures whether writing is plain and kind, deterministically, before any model
 * gives a second opinion (Pattern 19). It knows nothing about any one app; the app supplies its own rules.
 */

/** Syllables in an English word, by vowel groups. Good enough to rank sentences; not a dictionary. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w.length > 0 ? 1 : 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/**
 * Flesch-Kincaid grade level. Web addresses, phone numbers, dollar amounts and proper names (runs of two or more
 * capitalized words, such as an agency's name) are ignored: a reader cannot be spared those, and they would
 * otherwise hide whether the sentences around them are plain. A line in a list counts as its own sentence.
 */
export function readingGrade(text: string): number {
  const clean = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:gov|org|com|edu|net|us)(?:\/[^\s,;]*)?/gi, 'site')
    .replace(/[\d$().,:\-+/]{4,}/g, '')
    .replace(/\b[A-Z][\w'.&-]*(?:\s+(?:of|and|the|for|de|&)?\s*[A-Z][\w'.&-]*)+/g, 'Name');
  const sentences = Math.max(1, (clean.match(/[.!?]+(\s|$)|\n(?=\s*\S)/g) ?? []).length);
  const words = clean.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return 0;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

/** Ends a sentence once: adds a period only when there is no closing mark already (so "5 p.m." stays one period). */
export const sentence = (t: string): string => (/[.!?]$/.test(t) ? t : `${t}.`);

/** A phrase rule: the pattern, and what it does to the reader when it matches. */
export type PhraseRule = [RegExp, string];

/** Each rule that matches, by what it does. */
export function phraseProblems(text: string, rules: PhraseRule[]): string[] {
  return rules.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/** Careless writing reads as not caring: doubled periods, empty parentheses, stray template holes. */
export function carelessness(text: string): string[] {
  const out: string[] = [];
  if (/[^.]\.\.(?!\.)/.test(text)) out.push('has a doubled period');
  if (/\(\s*\)|\bundefined\b|\bnull\b|NaN|\$\{/.test(text)) out.push('has a template hole or empty value');
  return out;
}
