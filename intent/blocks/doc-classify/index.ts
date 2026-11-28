/**
 * Sorting incoming documents the way a filing clerk would, with every decision explained. Each correspondent,
 * document type, tag and storage path carries a matching rule: any of these words, all of these words, this exact
 * phrase, a regular expression, a fuzzy match that forgives typos and scanning errors (the fuzzy-match block), or
 * "auto", which learns from documents already filed (multinomial naive Bayes over the search block's words, only
 * answering when it is confident). A single-valued field (correspondent, type, storage path) takes the strongest
 * unique match and stays empty when two rules are equally strong, saying so; tags are all that match. A storage
 * path template ("{correspondent}/{created_year}/{title}") fills in names that cannot climb out of the folder.
 * User-written regular expressions are checked for nested repetition and backreferences, which are how a pattern
 * is made to run for minutes, and refused; matched text is capped in length.
 * Out of scope: OCR, and reading dates or amounts out of the text.
 */
import { similarity } from '../fuzzy-match/index.ts';
import { fold, stem, words } from '../search/index.ts';

export class BadRule extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Algorithm = 'none' | 'any' | 'all' | 'literal' | 'regex' | 'fuzzy' | 'auto';

export interface MatchRule {
  readonly algorithm: Algorithm;
  /** The words, phrase, pattern or fuzzy text; unused for none and auto. */
  readonly pattern?: string;
  /** Case and accents ignored; default true. */
  readonly insensitive?: boolean;
  /** For fuzzy: 0..1, default 0.85. */
  readonly threshold?: number;
}

export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly rule: MatchRule;
  /** A tag that marks documents still waiting for a person to look. */
  readonly inbox?: boolean;
  /** For a storage path: the template. */
  readonly template?: string;
}

export interface Document {
  readonly title: string;
  readonly content: string;
  readonly filename?: string;
  /** ISO date the document is dated. */
  readonly created?: string;
  readonly added?: string;
  readonly asn?: number;
}

const MAX_TEXT = 500_000;
const MAX_PATTERN = 200;

/** Refuses regular expressions that can backtrack catastrophically: nested repetition, repeated alternation, backreferences. */
export function checkRegex(p: string): void {
  if (p.length === 0 || p.length > MAX_PATTERN) throw new BadRule(`a pattern is 1 to ${MAX_PATTERN} characters`);
  try {
    new RegExp(p, 'u');
  } catch {
    throw new BadRule('that is not a valid regular expression');
  }
  if (/\\[1-9]|\\k</.test(p)) throw new BadRule('backreferences are not allowed in patterns');
  if (/\(\?<[=!]/.test(p)) throw new BadRule('look-behind is not allowed in patterns');
  // A quantified group whose body contains a quantifier or an alternation.
  const stack: { start: number; risky: boolean }[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      while (i < p.length && p[i] !== ']') i += p[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') stack.push({ start: i, risky: false });
    else if (c === '|' && stack.length) stack.at(-1)!.risky = true;
    else if ((c === '*' || c === '+' || (c === '{' && /^\{\d+,\d*\}/.test(p.slice(i)))) && stack.length) stack.at(-1)!.risky = true;
    else if (c === ')') {
      const g = stack.pop();
      const q = p[i + 1];
      if (g?.risky && (q === '*' || q === '+' || (q === '{' && /^\{\d+,\d*\}/.test(p.slice(i + 1))))) throw new BadRule('nested repetition in a pattern can run for minutes and is not allowed');
      if (g?.risky && stack.length) stack.at(-1)!.risky = true;
    }
  }
}

export function validateRule(r: MatchRule): void {
  if (!['none', 'any', 'all', 'literal', 'regex', 'fuzzy', 'auto'].includes(r.algorithm)) throw new BadRule(`${JSON.stringify(r.algorithm)} is not a matching algorithm`);
  if (['any', 'all', 'literal', 'regex', 'fuzzy'].includes(r.algorithm) && !(r.pattern ?? '').trim()) throw new BadRule(`the ${r.algorithm} rule needs a pattern`);
  if (r.algorithm === 'regex') checkRegex(r.pattern!);
  if (r.threshold !== undefined && !(r.threshold > 0 && r.threshold <= 1)) throw new BadRule('the fuzzy threshold is above 0 and at most 1');
}

const tokens = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];

export interface RuleMatch {
  readonly matched: boolean;
  /** How strong: the number of pattern words that matched, or 1 for a pattern, or the fuzzy score. */
  readonly strength: number;
  readonly why: string;
}

const NO: RuleMatch = { matched: false, strength: 0, why: '' };

/** Whether a rule matches a text. "auto" and "none" never match here; auto is the learned classifier's. */
export function matches(rule: MatchRule, text: string): RuleMatch {
  validateRule(rule);
  const t = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const ins = rule.insensitive ?? true;
  const prep = (s: string) => (ins ? fold(s) : s);
  switch (rule.algorithm) {
    case 'any': {
      const have = new Set(ins ? tokens(t) : (t.match(/[\p{L}\p{N}]+/gu) ?? []));
      const hit = (ins ? tokens(rule.pattern!) : (rule.pattern!.match(/[\p{L}\p{N}]+/gu) ?? [])).filter((w) => have.has(w));
      return hit.length ? { matched: true, strength: new Set(hit).size, why: `has ${[...new Set(hit)].map((h) => `"${h}"`).join(', ')}` } : NO;
    }
    case 'all': {
      const have = new Set(ins ? tokens(t) : (t.match(/[\p{L}\p{N}]+/gu) ?? []));
      const need = [...new Set(ins ? tokens(rule.pattern!) : (rule.pattern!.match(/[\p{L}\p{N}]+/gu) ?? []))];
      return need.length && need.every((w) => have.has(w)) ? { matched: true, strength: need.length + 1, why: `has all of ${need.map((n) => `"${n}"`).join(', ')}` } : NO;
    }
    case 'literal': {
      const norm = (s: string) => prep(s).replace(/\s+/g, ' ');
      const phrase = norm(rule.pattern!).trim();
      const hay = ` ${norm(t).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
      const needle = ` ${phrase.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
      return needle.trim() && hay.includes(needle) ? { matched: true, strength: needle.trim().split(' ').length + 2, why: `contains the phrase "${rule.pattern!.trim()}"` } : NO;
    }
    case 'regex': {
      const m = new RegExp(rule.pattern!, ins ? 'iu' : 'u').exec(t);
      return m ? { matched: true, strength: 3, why: `matches /${rule.pattern}/ at "${m[0].slice(0, 40)}"` } : NO;
    }
    case 'fuzzy': {
      const want = tokens(rule.pattern!);
      const have = tokens(t);
      const n = want.length;
      const phrase = want.join(' ');
      const limit = rule.threshold ?? 0.85;
      let best = 0;
      for (let i = 0; i + n <= have.length; i++) best = Math.max(best, similarity(have.slice(i, i + n).join(' '), phrase));
      return best >= limit ? { matched: true, strength: best * 2, why: `is ${Math.round(best * 100)}% like "${rule.pattern!.trim()}"` } : NO;
    }
    default:
      return NO;
  }
}

// ---------------------------------------------------------------- learned matching

export interface Labelled {
  readonly doc: Document;
  readonly correspondent?: string;
  readonly type?: string;
  readonly storagePath?: string;
  readonly tags?: readonly string[];
}

const features = (d: Document): string[] => [...new Set([...words(`${d.title} ${d.content.slice(0, 20_000)}`).map(stem)])].slice(0, 2000);

class Bayes {
  private readonly docs = new Map<string, number>();
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly totals = new Map<string, number>();
  private readonly vocab = new Set<string>();

  add(label: string, f: readonly string[]): void {
    this.docs.set(label, (this.docs.get(label) ?? 0) + 1);
    let c = this.counts.get(label);
    if (!c) this.counts.set(label, (c = new Map()));
    for (const w of f) {
      c.set(w, (c.get(w) ?? 0) + 1);
      this.vocab.add(w);
    }
    this.totals.set(label, (this.totals.get(label) ?? 0) + f.length);
  }

  labels(): string[] {
    return [...this.docs.keys()];
  }

  count(label: string): number {
    return this.docs.get(label) ?? 0;
  }

  /** Probability per label (softmax over log scores). */
  predict(f: readonly string[]): Map<string, number> {
    const n = [...this.docs.values()].reduce((a, b) => a + b, 0);
    const v = this.vocab.size;
    const logs = new Map<string, number>();
    for (const l of this.docs.keys()) {
      let s = Math.log(this.docs.get(l)! / n);
      const c = this.counts.get(l)!;
      const t = this.totals.get(l)!;
      for (const w of f) if (this.vocab.has(w)) s += Math.log(((c.get(w) ?? 0) + 1) / (t + v));
      logs.set(l, s);
    }
    const max = Math.max(...logs.values());
    const exp = new Map([...logs].map(([l, s]) => [l, Math.exp(s - max)] as const));
    const sum = [...exp.values()].reduce((a, b) => a + b, 0);
    return new Map([...exp].map(([l, e]) => [l, e / sum] as const));
  }
}

export interface Decision {
  readonly correspondent?: string;
  readonly type?: string;
  readonly storagePath?: string;
  readonly tags: readonly string[];
  readonly reasons: readonly { readonly field: string; readonly entity: string; readonly why: string }[];
  /** Fields left empty because two rules were equally strong. */
  readonly ambiguous: readonly { readonly field: string; readonly candidates: readonly string[] }[];
}

export interface ClassifierOptions {
  readonly correspondents?: readonly Entity[];
  readonly types?: readonly Entity[];
  readonly tags?: readonly Entity[];
  readonly storagePaths?: readonly Entity[];
  /** Confidence needed for a learned answer; default 0.8. */
  readonly minConfidence?: number;
  /** Examples a label needs before it is learned from; default 2. */
  readonly minExamples?: number;
}

type Field = 'correspondent' | 'type' | 'storagePath';

export class Classifier {
  private readonly o: ClassifierOptions;
  private readonly single = new Map<Field, Bayes>();
  private readonly tagModels = new Map<string, Bayes>();
  private trained = 0;

  constructor(o: ClassifierOptions) {
    const seen = new Set<string>();
    for (const e of [...(o.correspondents ?? []), ...(o.types ?? []), ...(o.tags ?? []), ...(o.storagePaths ?? [])]) {
      validateRule(e.rule);
      if (seen.has(e.id)) throw new BadRule(`two entities have the id ${e.id}`);
      seen.add(e.id);
    }
    for (const p of o.storagePaths ?? []) if (p.template !== undefined) checkTemplate(p.template);
    this.o = o;
  }

  /** Learns from documents a person has already filed. */
  train(examples: readonly Labelled[]): void {
    this.single.clear();
    this.tagModels.clear();
    this.trained = examples.length;
    const tagIds = new Set((this.o.tags ?? []).filter((t) => t.rule.algorithm === 'auto').map((t) => t.id));
    const pos = new Map<string, number>();
    for (const ex of examples) {
      const f = features(ex.doc);
      for (const [field, v] of [['correspondent', ex.correspondent], ['type', ex.type], ['storagePath', ex.storagePath]] as const) {
        if (!v) continue;
        let b = this.single.get(field);
        if (!b) this.single.set(field, (b = new Bayes()));
        b.add(v, f);
      }
      for (const t of ex.tags ?? []) if (tagIds.has(t)) pos.set(t, (pos.get(t) ?? 0) + 1);
    }
    for (const id of tagIds) {
      if ((pos.get(id) ?? 0) < (this.o.minExamples ?? 2) || examples.length - (pos.get(id) ?? 0) < (this.o.minExamples ?? 2)) continue;
      const b = new Bayes();
      for (const ex of examples) b.add((ex.tags ?? []).includes(id) ? 'yes' : 'no', features(ex.doc));
      this.tagModels.set(id, b);
    }
  }

  get examples(): number {
    return this.trained;
  }

  private learned(field: Field, d: Document, entities: readonly Entity[]): { id: string; p: number } | undefined {
    const b = this.single.get(field);
    const auto = new Set(entities.filter((e) => e.rule.algorithm === 'auto').map((e) => e.id));
    if (!b || !auto.size) return undefined;
    const usable = b.labels().filter((l) => auto.has(l) && b.count(l) >= (this.o.minExamples ?? 2));
    if (usable.length < 1) return undefined;
    const p = b.predict(features(d));
    const best = [...p].filter(([l]) => usable.includes(l)).sort((x, y) => y[1] - x[1])[0];
    return best && best[1] >= (this.o.minConfidence ?? 0.8) && b.labels().length >= 2 ? { id: best[0], p: best[1] } : undefined;
  }

  classify(d: Document): Decision {
    const text = `${d.title}\n${d.content}${d.filename ? `\n${d.filename}` : ''}`;
    const reasons: { field: string; entity: string; why: string }[] = [];
    const ambiguous: { field: string; candidates: string[] }[] = [];
    const pick = (field: Field, label: string, list: readonly Entity[] | undefined): string | undefined => {
      const es = list ?? [];
      const hits = es.map((e) => ({ e, m: matches(e.rule, text) })).filter((x) => x.m.matched).sort((a, b) => b.m.strength - a.m.strength || a.e.name.localeCompare(b.e.name));
      if (hits.length) {
        const top = hits.filter((h) => h.m.strength === hits[0]!.m.strength);
        if (top.length > 1) {
          ambiguous.push({ field: label, candidates: top.map((h) => h.e.name) });
          return undefined;
        }
        reasons.push({ field: label, entity: hits[0]!.e.name, why: hits[0]!.m.why });
        return hits[0]!.e.id;
      }
      const l = this.learned(field, d, es);
      if (l) {
        reasons.push({ field: label, entity: es.find((e) => e.id === l.id)!.name, why: `learned from ${this.single.get(field)!.count(l.id)} filed documents, ${Math.round(l.p * 100)}% sure` });
        return l.id;
      }
      return undefined;
    };
    const correspondent = pick('correspondent', 'correspondent', this.o.correspondents);
    const type = pick('type', 'document type', this.o.types);
    const storagePath = pick('storagePath', 'storage path', this.o.storagePaths);
    const tags: string[] = [];
    for (const t of this.o.tags ?? []) {
      const m = matches(t.rule, text);
      if (m.matched) {
        tags.push(t.id);
        reasons.push({ field: 'tag', entity: t.name, why: m.why });
        continue;
      }
      const model = this.tagModels.get(t.id);
      if (model) {
        const p = model.predict(features(d)).get('yes') ?? 0;
        if (p >= (this.o.minConfidence ?? 0.8)) {
          tags.push(t.id);
          reasons.push({ field: 'tag', entity: t.name, why: `learned, ${Math.round(p * 100)}% sure` });
        }
      }
    }
    return { ...(correspondent ? { correspondent } : {}), ...(type ? { type } : {}), ...(storagePath ? { storagePath } : {}), tags, reasons, ambiguous };
  }

  /** The folder and file name for a document, from the chosen storage path's template. */
  pathFor(d: Document, decision: Decision, fallback = '{title}'): string {
    const sp = (this.o.storagePaths ?? []).find((p) => p.id === decision.storagePath);
    const nameOf = (list: readonly Entity[] | undefined, id: string | undefined) => (list ?? []).find((e) => e.id === id)?.name;
    return renderPath(sp?.template ?? fallback, {
      title: d.title,
      correspondent: nameOf(this.o.correspondents, decision.correspondent),
      document_type: nameOf(this.o.types, decision.type),
      tag_list: decision.tags.map((t) => nameOf(this.o.tags, t) ?? t).sort().join(','),
      ...dateParts('created', d.created),
      ...dateParts('added', d.added),
      asn: d.asn === undefined ? undefined : String(d.asn).padStart(7, '0'),
    });
  }
}

// ---------------------------------------------------------------- storage path templates

const FIELDS = new Set(['title', 'correspondent', 'document_type', 'tag_list', 'created_year', 'created_month', 'created_day', 'added_year', 'added_month', 'added_day', 'asn']);

export function checkTemplate(t: string): void {
  if (t.length > 300) throw new BadRule('a path template is at most 300 characters');
  for (const m of t.matchAll(/\{([^{}]*)\}/g)) if (!FIELDS.has(m[1]!)) throw new BadRule(`{${m[1]}} is not a field a path can use (${[...FIELDS].join(', ')})`);
  if (/[{}]/.test(t.replace(/\{[^{}]*\}/g, ''))) throw new BadRule('braces in a path template must pair up');
}

function dateParts(prefix: 'created' | 'added', iso: string | undefined): Record<string, string | undefined> {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? { [`${prefix}_year`]: m[1], [`${prefix}_month`]: m[2], [`${prefix}_day`]: m[3] } : {};
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** One path segment made safe: no separators, no dots-only names, no control characters, no reserved device names. */
export function safeSegment(s: string): string {
  let v = s.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (RESERVED.test(v.split('.')[0]!)) v = `_${v}`;
  return [...v].slice(0, 100).join('') || 'none';
}

export function renderPath(template: string, values: Readonly<Record<string, string | undefined>>): string {
  checkTemplate(template);
  const parts = template
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.replace(/\{([a-z_]+)\}/g, (_m, k: string) => safeSegment(values[k] ?? 'none')))
    .map((seg) => safeSegment(seg))
    .filter((s) => s.length > 0);
  if (!parts.length) throw new BadRule('the path came out empty');
  return parts.join('/');
}
