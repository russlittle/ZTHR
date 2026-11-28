/**
 * Tolerances into working ranges. The tolerance a person confirmed in the read-back is the range the factory
 * works within: it sets the starting floor of each ratchet, and how firmly it was established sets how much
 * confidence the evidence starts with. A tolerance that cannot be read as a range is said to be so, never guessed.
 */
import type { Ballooned } from './frame.ts';

export type Range =
  | { readonly kind: 'time'; readonly maxMs: number }
  | { readonly kind: 'rate'; readonly min: number }
  | { readonly kind: 'count'; readonly max: number }
  | { readonly kind: 'relative'; readonly direction: 'down' | 'up'; readonly against: string }
  | { readonly kind: 'exact' }
  | { readonly kind: 'unread'; readonly why: string };

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, zero: 0, none: 0, no: 0 };
const n = (s: string) => (s in WORDS ? WORDS[s]! : Number(s));

export function rangeOf(tolerance: string | undefined): Range {
  const t = (tolerance ?? '').trim().toLowerCase();
  if (!t) return { kind: 'unread', why: 'no tolerance stated' };
  if (t === 'exactly as stated') return { kind: 'exact' };
  let m: RegExpExecArray | null;
  if ((m = /within\s+([\d.]+)\s*(milliseconds?|ms|seconds?|s)\b/.exec(t))) return { kind: 'time', maxMs: /^m/.test(m[2] ?? '') ? Number(m[1]) : Number(m[1]) * 1000 };
  if (/^(every time|always|all of them|every message|every one|no sideways scrolling)$/.test(t)) return { kind: 'rate', min: 1 };
  if ((m = /^(\w+)\s+(?:times\s+)?in\s+(\w+)(?:\s+people)?$/.exec(t))) {
    const a = n(m[1] ?? '');
    const b = n(m[2] ?? '');
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return { kind: 'rate', min: a / b };
  }
  if ((m = /^(?:at most|no more than|up to)\s+(\w+)$/.exec(t)) && Number.isFinite(n(m[1] ?? ''))) return { kind: 'count', max: n(m[1] ?? '') };
  if ((m = /^([\d.]+)\s*%$/.exec(t))) return { kind: 'rate', min: Number(m[1]) / 100 };
  if ((m = /^(none|no|zero|\d+|one|two|three|four|five)\b.*\b(in a|per|each)\b/.exec(t))) return { kind: 'count', max: n(m[1] ?? '') };
  if ((m = /^(fewer|less|lower|more|higher|better) than (.+)$/.exec(t))) return { kind: 'relative', direction: /^(fewer|less|lower)$/.test(m[1] ?? '') ? 'down' : 'up', against: m[2] ?? '' };
  if (/most of the time|usually|mostly/.test(t)) return { kind: 'unread', why: `"${tolerance}" names no number; confirm one (for example nine times in ten)` };
  return { kind: 'unread', why: `"${tolerance}" could not be read as a range` };
}

export type Confidence = 'firm' | 'provisional' | 'inherited';
export const confidenceOf = (s: Ballooned): Confidence => (s.state === 'confirmed' ? 'firm' : s.state === 'default' ? 'inherited' : 'provisional');

export interface WorkingRange {
  readonly balloon: number;
  readonly measure: string;
  readonly tolerance: string | null;
  readonly range: Range;
  readonly confidence: Confidence;
}

export const workingRanges = (statements: readonly Ballooned[]): WorkingRange[] =>
  statements.filter((s) => s.slot === 'measures').map((s) => ({ balloon: s.balloon, measure: s.text, tolerance: s.tolerance ?? null, range: rangeOf(s.tolerance), confidence: confidenceOf(s) }));

/** Starting ratchets, in the factory's own shape: each floor starts at the tolerance and can only tighten. */
export function startingRatchets(ranges: readonly WorkingRange[]): { id: string; metric: string; direction: 'up' | 'down'; floor: number }[] {
  const out: { id: string; metric: string; direction: 'up' | 'down'; floor: number }[] = [];
  for (const w of ranges) {
    const id = `balloon-${w.balloon}`;
    const r = w.range;
    if (r.kind === 'time') out.push({ id, metric: `${w.measure} (ms, at most)`, direction: 'down', floor: r.maxMs });
    else if (r.kind === 'rate') out.push({ id, metric: `${w.measure} (% of runs, at least)`, direction: 'up', floor: Math.round(r.min * 1000) / 10 });
    else if (r.kind === 'count') out.push({ id, metric: `${w.measure} (count, at most)`, direction: 'down', floor: r.max });
  }
  return out;
}
