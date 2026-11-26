/**
 * The intent frame: every intent, however it arrived, is held in these ten slots. Each statement records who
 * supplied it and its state, so the read-back can say exactly what is confirmed, open, assumed or a default.
 */
import type { Origin } from './model.ts';

export const SLOTS = ['problem', 'why', 'outcome', 'people', 'constraints', 'measures', 'nonGoals', 'prerequisites', 'implications', 'assumptions'] as const;
export type Slot = (typeof SLOTS)[number];

export type State = 'confirmed' | 'open' | 'assumed' | 'default';

export type Supplier =
  | { readonly kind: 'person'; readonly origin?: Origin }
  | { readonly kind: 'parse'; readonly families: readonly string[] }
  | { readonly kind: 'lexicon'; readonly term: string }
  | { readonly kind: 'derived'; readonly rule: string }
  | { readonly kind: 'part'; readonly part: string };

export interface Statement {
  readonly id: string;
  readonly slot: Slot;
  /** What will be built, in plain words. */
  readonly text: string;
  /** The person's own words this came from, verbatim, when there are any. */
  readonly words?: string;
  readonly state: State;
  readonly supplied: Supplier;
  /** For a measure: the tolerance it is held to. */
  readonly tolerance?: string;
  /** Critical or significant, as engineering marks special characteristics; each mark must reach a control. */
  readonly mark?: 'critical' | 'significant';
}

/** A statement with its balloon: the number it keeps through every revision, answered by number in the evidence. */
export interface Ballooned extends Statement {
  readonly balloon: number;
}

/** Application-wide defaults, inherited by every statement unless overridden, as a drawing's title block. */
export interface TitleEntry {
  readonly value: string;
  readonly from: string;
  /** When a statement overrides the default, what the default was. */
  readonly replaces?: { readonly value: string; readonly from: string };
}
export type TitleBlock = Readonly<Record<string, TitleEntry>>;

export type Consequence = 'high' | 'medium' | 'low';

/**
 * How a question is answered, chosen to keep the person moving: a tap where the options are few and known,
 * several taps where more than one can be true, a yes for a proposal, typing only when nothing can be offered.
 * Every choice question also takes "Other", so no answer is ever forced into a wrong box.
 */
export type Answer =
  | { readonly kind: 'single'; readonly options: readonly string[]; readonly other: true; readonly recommended?: string }
  | { readonly kind: 'multi'; readonly options: readonly string[]; readonly other: true; readonly recommended?: string }
  | { readonly kind: 'confirm'; readonly proposal: string }
  | { readonly kind: 'text'; readonly placeholder?: string };

export interface Question {
  readonly id: string;
  readonly origin: 'diff' | 'completeness' | 'overlap' | 'state' | 'pairing' | 'marker' | 'missing';
  readonly slot?: Slot;
  /** Asked in the person's terms. */
  readonly text: string;
  /** Readings to choose between, when there are readings. */
  readonly choices?: readonly string[];
  /** How it is answered; set for every question before it reaches a person. */
  readonly answer?: Answer;
  /** Questions that open only when a given option is chosen: the branch, decided by rule, not by a model. */
  readonly follow?: Readonly<Record<string, readonly Question[]>>;
  /** What choosing an option means, as the statement it becomes; options without an entry become themselves. */
  readonly means?: Readonly<Record<string, { readonly slot: Slot; readonly text: string; readonly mark?: 'critical' | 'significant' }>>;
  /** What a wrong answer would break: every question must say. */
  /** When the question sets how close a measure must be: the measure. Any answer, Other included, is its tolerance. */
  readonly tolerates?: string;
  readonly protects: string;
  readonly consequence: Consequence;
  readonly sourceOrigin?: Origin;
}

/**
 * What one model family returns when it reads rough intent. The schema is the contract: anything that does
 * not match it is not a reading and counts as unknown.
 */
export interface Reading {
  readonly family: string;
  readonly problem: string;
  readonly why: string;
  readonly outcomes: readonly string[];
  readonly people: readonly { readonly name: string; readonly side: 'primary' | 'other' }[];
  readonly measures: readonly { readonly text: string; readonly tolerance: string }[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

/** A reading if the value matches the schema exactly, or the reasons it does not. */
export function checkReading(x: unknown): { ok: true; reading: Reading } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return { ok: false, problems: ['not an object'] };
  const o = x as Record<string, unknown>;
  const allowed = new Set(['family', 'problem', 'why', 'outcomes', 'people', 'measures', 'constraints', 'nonGoals']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) problems.push(`unexpected field ${k}`);
  for (const k of ['family', 'problem', 'why']) if (!isStr(o[k])) problems.push(`${k} must be text`);
  if (isStr(o['family']) && !/^[a-z][a-z0-9 ._-]{0,39}$/i.test(o['family'])) problems.push('family must be a plain name, such as gemini or llama');
  for (const k of ['outcomes', 'constraints', 'nonGoals']) if (!strs(o[k])) problems.push(`${k} must be a list of text`);
  const people = o['people'];
  if (!Array.isArray(people) || !people.every((p) => typeof p === 'object' && p !== null && isStr((p as Record<string, unknown>)['name']) && ['primary', 'other'].includes((p as Record<string, unknown>)['side'] as string)))
    problems.push('people must be a list of {name, side: primary|other}');
  const measures = o['measures'];
  if (!Array.isArray(measures) || !measures.every((m) => typeof m === 'object' && m !== null && isStr((m as Record<string, unknown>)['text']) && isStr((m as Record<string, unknown>)['tolerance'])))
    problems.push('measures must be a list of {text, tolerance}');
  return problems.length ? { ok: false, problems } : { ok: true, reading: x as Reading };
}
