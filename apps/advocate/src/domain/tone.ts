import type { Depth, OutboundMessage } from './types.js';

/**
 * The tone rubric's deterministic layer (PRD P3, P4). A message fails if it
 * scolds, if it reports a problem without a next step, if it reads above the
 * student's level, or if it is too long for their chosen depth. A model judge
 * from another family adds a second opinion; it can fail a message, never pass one.
 */
const SCOLDING: [RegExp, string][] = [
  [/\byou(?:'re| are) (?:late|behind|falling behind)\b/i, 'tells the student they are late or behind'],
  [/\byou (?:failed|forgot|missed|neglected)\b/i, 'blames the student'],
  [/\byou should have\b/i, 'second-guesses the student'],
  [/\bwhy didn'?t you\b/i, 'interrogates the student'],
  [/\bwarning\b/i, 'uses alarm language'],
  [/\boverdue\b/i, 'uses scolding language for a passed date'],
  [/\bfailure to\b/i, 'uses compliance language'],
  [/\bunfortunately\b/i, 'opens with bad-news framing'],
  [/\byou must\b/i, 'commands the student'],
  [/\bdelinquent\b/i, 'uses collections language'],
  [/\birresponsible\b/i, 'judges the student'],
];

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w.length > 0 ? 1 : 0;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/**
 * Flesch-Kincaid grade level of the words the team writes. URLs, phone numbers,
 * dollar amounts and proper names (runs of two or more capitalized words, such
 * as an agency's name) are ignored: the student cannot be spared those, and
 * they would otherwise hide whether the surrounding sentences are plain.
 */
export function readingGrade(text: string): number {
  const clean = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\d$().,:\-+/]{4,}/g, '')
    .replace(/\b[A-Z][\w'.&-]*(?:\s+(?:of|and|the|for|de|&)?\s*[A-Z][\w'.&-]*)+/g, 'Name');
  const sentences = Math.max(1, (clean.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = clean.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 0) return 0;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

const LIMITS: Record<Depth, { maxChars: number; gradeSlack: number }> = {
  brief: { maxChars: 320, gradeSlack: 2 },
  standard: { maxChars: 1200, gradeSlack: 2 },
  'walk-me-through': { maxChars: 2400, gradeSlack: 0 },
};

export interface ToneResult {
  ok: boolean;
  problems: string[];
  grade: number;
}

export function checkTone(m: Pick<OutboundMessage, 'text' | 'nextSteps' | 'urgency'>, depth: Depth, targetGrade: number): ToneResult {
  const problems: string[] = [];
  for (const [re, why] of SCOLDING) if (re.test(m.text)) problems.push(why);
  if (m.urgency !== 'safety' && m.nextSteps.length === 0) problems.push('reports without offering a next step');
  const grade = readingGrade(m.text);
  const lim = LIMITS[depth];
  if (m.urgency !== 'safety' && grade > targetGrade + lim.gradeSlack) problems.push(`reads at grade ${grade.toFixed(1)}, above ${targetGrade + lim.gradeSlack}`);
  if (m.text.length > lim.maxChars) problems.push(`${m.text.length} characters is too long for ${depth} mode`);
  return { ok: problems.length === 0, problems, grade };
}
