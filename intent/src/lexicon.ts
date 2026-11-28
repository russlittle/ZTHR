/**
 * The design lexicon: human terms resolved to design choices and measures without a model. A hit is an
 * assumption with the person's own words beside it; the read-back confirms it, and a confirmed correction
 * becomes a new entry.
 */
import design from '../lexicon/design.json' with { type: 'json' };
import type { Statement } from './frame.ts';
import type { Origin } from './model.ts';

export interface Term {
  readonly term: string;
  readonly match: readonly string[];
  readonly meaning: string;
  readonly choices: Readonly<Record<string, string>>;
  readonly measures: readonly { readonly text: string; readonly tolerance: string }[];
}

export interface Lexicon {
  readonly version: string;
  readonly terms: readonly Term[];
}

export interface Hit {
  readonly term: Term;
  /** The words the person used, exactly as written. */
  readonly words: string;
  readonly origin?: Origin;
}

/** The lexicon as shipped; bundled as data, so the same terms resolve in a browser and on a server. */
export const loadLexicon = (): Lexicon => design as Lexicon;

/** Every term the lexicon knows, found in the given passages, once per term. */
export function resolveTerms(lexicon: Lexicon, passages: readonly { text: string; origin?: Origin }[]): Hit[] {
  const hits: Hit[] = [];
  for (const term of lexicon.terms) {
    for (const p of passages) {
      const m = term.match.map((r) => new RegExp(r, 'i').exec(p.text)).find((x) => x !== null);
      if (m) {
        hits.push(p.origin ? { term, words: m[0], origin: p.origin } : { term, words: m[0] });
        break;
      }
    }
  }
  return hits;
}

/** Hits as statements: each meaning an assumed constraint, each measure an assumed measure. */
export function hitStatements(hits: readonly Hit[]): Statement[] {
  return hits.flatMap((h, i) => [
    { id: `L${i + 1}`, slot: 'constraints' as const, text: `"${h.words}", read as ${h.term.meaning}`, words: h.words, state: 'assumed' as const, supplied: { kind: 'lexicon' as const, term: h.term.term } },
    ...h.term.measures.map((m, j) => ({ id: `L${i + 1}.${j + 1}`, slot: 'measures' as const, text: m.text, tolerance: m.tolerance, words: h.words, state: 'assumed' as const, supplied: { kind: 'lexicon' as const, term: h.term.term } })),
  ]);
}
