import { carelessness, phraseProblems, readingGrade, type PhraseRule } from '@zthr/plain-language';
import type { Depth, OutboundMessage } from './types.js';

/**
 * The tone rubric's deterministic layer (PRD P3, P4). A message fails if it
 * scolds, if it reports a problem without a next step, if it reads above the
 * student's level, or if it is too long for their chosen depth. A model judge
 * from another family adds a second opinion; it can fail a message, never pass one.
 */
const SCOLDING: PhraseRule[] = [
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

const SCOLDING_ES: PhraseRule[] = [
  [/\b(llegas tarde|estás atrasad[oa])\b/i, 'tells the student they are late'],
  [/\b(debiste|deberías haber)\b/i, 'second-guesses the student'],
  [/\b(advertencia|vencid[oa])\b/i, 'uses alarm language'],
  [/\b(tienes que|debes)\b/i, 'commands the student'],
];

export { readingGrade, syllables } from '@zthr/plain-language';

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

export function checkTone(m: Pick<OutboundMessage, 'text' | 'nextSteps' | 'urgency'>, depth: Depth, targetGrade: number, language: 'en' | 'es' = 'en'): ToneResult {
  const problems: string[] = [];
  problems.push(...phraseProblems(m.text, SCOLDING), ...phraseProblems(m.text, SCOLDING_ES));
  if (m.urgency !== 'safety' && m.nextSteps.length === 0) problems.push('reports without offering a next step');
  // The grade formula is for English; Spanish reading level is not yet measured, so it is not gated.
  const grade = language === 'en' ? readingGrade(m.text) : 0;
  const lim = LIMITS[depth];
  if (language === 'en' && m.urgency !== 'safety' && grade > targetGrade + lim.gradeSlack) problems.push(`reads at grade ${grade.toFixed(1)}, above ${targetGrade + lim.gradeSlack}`);
  if (m.text.length > lim.maxChars) problems.push(`${m.text.length} characters is too long for ${depth} mode`);
  problems.push(...carelessness(m.text));
  for (const n of m.nextSteps) if (!n.label.trim()) problems.push('has a button with no label');
  return { ok: problems.length === 0, problems, grade };
}
