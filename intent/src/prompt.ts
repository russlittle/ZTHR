/**
 * The one request a model family is given: read the person's rough intent into the reading schema, and
 * nothing else. The same words go to every family, so their readings can be compared field by field.
 */
import type { IntentModel } from './model.ts';

export function readingPrompt(model: IntentModel, family: string): string {
  const text = [
    model.end ? `End in mind: ${model.end}` : '',
    ...model.context,
    ...model.requirements.map((r) => `- ${r.text}`),
    ...model.examples.map((e) => `- given ${e.given}; when ${e.when}; then ${e.then}`),
  ]
    .filter(Boolean)
    .join('\n');
  return `You are one of two independent readers of a person's rough description of software they want. Read it as they mean it: generously, metaphors included, never pedantically. Do not add features they did not ask for.

Return only one JSON object, with exactly these fields and nothing else:
{
  "family": "${family}",
  "problem": "what is going wrong today, for whom, in one sentence",
  "why": "what they are ultimately trying to achieve, one step beyond what they asked for",
  "outcomes": ["what will be true when it works", "..."],
  "people": [{"name": "who it is for", "side": "primary"}, {"name": "anyone on the other side of an activity", "side": "other"}],
  "measures": [{"text": "how anyone will know it worked", "tolerance": "how close is close enough, with a number where possible"}],
  "constraints": ["what must always or never happen"],
  "nonGoals": ["what is deliberately left out"]
}
Use empty strings or empty lists where the description says nothing. Keep their words where you can.

The description:
"""
${text}
"""`;
}
