/**
 * Every question gets the quickest way to answer it. Questions that already chose their form keep it; the rest
 * follow fixed rules: two or more readings are a choice, one proposal is a yes, a yes-or-no question is two
 * taps, and only a question nothing can be offered for asks for typing.
 */
import type { Answer, Question } from './frame.ts';

const YES_NO = /^(is|are|does|do|should|can|will|must|would|has|have)\b/i;

export function answerFor(q: Question): Answer {
  if (q.answer) return q.answer;
  const c = q.choices ?? [];
  if (c.length >= 2) return { kind: 'single', options: c, other: true };
  if (c.length === 1) return { kind: 'confirm', proposal: c[0]! };
  // A marker or question phrased for yes or no gets the two taps.
  const asked = q.text.includes(': ') ? q.text.slice(q.text.lastIndexOf(': ') + 2) : q.text;
  if (YES_NO.test(asked.trim())) return { kind: 'single', options: ['Yes', 'No'], other: true };
  return { kind: 'text' };
}

export const shaped = (qs: readonly Question[]): Question[] => qs.map((q) => ({ ...q, answer: answerFor(q) }));
