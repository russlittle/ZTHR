/**
 * Every number public material states is a fact with one source. In Markdown it is written between markers,
 *
 *   a guide of <!--fact:guide_entries-->270<!--/fact--> checked entries
 *
 * so it reads as plain text and the tools can find it. A fact from the repository is checked on every push by the
 * facts-current gate. A fact from a run (tests run, controls clicked, students walked) is written into the published
 * site by the build that measured it, so the site never states a number its own evidence does not hold. A run fact
 * with no evidence in this build renders as "not measured", never as the last number someone typed.
 */
export type FactKind = 'repo' | 'run';
export interface Fact {
  kind: FactKind;
  value: number | string | undefined;
  /** How the number is written: 2,053 (int), "fifteen" (word), "About 28,200" style rounding (hundred). */
  style?: 'int' | 'word' | 'hundred';
}
export type Facts = Record<string, Fact>;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

export function render(f: Fact): string {
  if (f.value === undefined) return 'not measured';
  if (typeof f.value === 'string') return f.value;
  if (f.style === 'word' && f.value >= 0 && f.value < WORDS.length) return WORDS[f.value]!;
  const n = f.style === 'hundred' ? Math.round(f.value / 100) * 100 : f.value;
  return n.toLocaleString('en-US');
}

/** A word written at the start of a sentence keeps its capital: "Fifteen parts". */
const sameCase = (written: string, value: string) => (/^[A-Z][a-z]/.test(written) ? value.charAt(0).toUpperCase() + value.slice(1) : value);

const MARK = /<!--fact:([a-z_]+)-->([\s\S]*?)<!--\/fact-->/g;

export interface Mismatch {
  fact: string;
  written: string;
  current: string;
}

/** Every marked fact in a text, with what is written and what is true now; unknown fact names are mismatches too. */
export function check(text: string, facts: Facts, kinds: FactKind[] = ['repo']): Mismatch[] {
  const out: Mismatch[] = [];
  for (const m of text.matchAll(MARK)) {
    const [, name, written] = m as unknown as [string, string, string];
    const f = facts[name];
    if (!f) {
      out.push({ fact: name, written, current: 'no such fact' });
      continue;
    }
    if (!kinds.includes(f.kind)) continue;
    const current = sameCase(written, render(f));
    // A rounded figure ("About 28,500 lines") holds while within five percent; an exact count must match exactly.
    if (f.style === 'hundred' && typeof f.value === 'number') {
      const w = Number(written.replace(/,/g, ''));
      if (Number.isFinite(w) && Math.abs(w - f.value) <= f.value * 0.05) continue;
    }
    if (written !== current) out.push({ fact: name, written, current });
  }
  return out;
}

/** The text with each marked fact of the given kinds rewritten to its current value. */
export function apply(text: string, facts: Facts, kinds: FactKind[] = ['repo', 'run']): string {
  return text.replace(MARK, (whole, name: string, written: string) => {
    const f = facts[name];
    if (!f || !kinds.includes(f.kind)) return whole;
    return `<!--fact:${name}-->${sameCase(written, render(f))}<!--/fact-->`;
  });
}

/**
 * Numbers that look like claims but carry no marker: a count followed by one of the words public material counts
 * things in. Each is either marked as a fact or rewritten without the number.
 */
const CLAIM = /(?<![\w.,-])(\d{1,3}(?:,\d{3})+|\d{2,})(?:\s+of\s+\d[\d,]*)?\s+(tests|gates|journeys|locked user journeys|red-team attacks|controls|browser stops|entries|checked entries|blocks|modules|students|lines of)\b/g;
export function unmarked(text: string): string[] {
  const plain = text.replace(MARK, '').replace(/<!-- verified-by:start -->[\s\S]*?<!-- verified-by:end -->/g, '').replace(/```[\s\S]*?```/g, '')
    // A quoted example of wording ("Helped 14 of 19 students who tried it.") is not a claim.
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '');
  return [...plain.matchAll(CLAIM)].map((m) => m[0]);
}
