/**
 * Which family made a model, read from the model id the provider answered with. Independence is counted by this,
 * not by the family a session was started with: a flag is whatever its setter typed, while the model id comes back
 * with the call. A model id this table does not know has no family, and its verdict does not count.
 */
export const MAKERS: readonly { readonly family: string; readonly match: RegExp }[] = [
  { family: 'anthropic', match: /(^|[/@:_-])(claude|anthropic)/i },
  { family: 'google', match: /(^|[/@:_-])(gemini|gemma|google|palm)/i },
  { family: 'openai', match: /(^|[/@:_-])(gpt|openai|o[1-9](-|$)|codex|chatgpt)/i },
  { family: 'deepseek', match: /(^|[/@:_-])deepseek/i },
  { family: 'llama', match: /(^|[/@:_-])(llama|meta-llama|meta\/)/i },
  { family: 'qwen', match: /(^|[/@:_-])(qwen|qwq|alibaba)/i },
  { family: 'mistral', match: /(^|[/@:_-])(mistral|mixtral|codestral|ministral|magistral|devstral)/i },
  { family: 'xai', match: /(^|[/@:_-])(grok|xai)/i },
];

/** The family that made `model`, or null when the id names none, or more than one. */
export function familyOfModel(model: string | undefined): string | null {
  if (!model) return null;
  const hits = [...new Set(MAKERS.filter((m) => m.match.test(model)).map((m) => m.family))];
  return hits.length === 1 ? hits[0]! : null;
}
