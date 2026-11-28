/**
 * Translatable content: one source copy per item and one variant per language, each field remembering which
 * version of the source it was written from. Handled here: locale tags checked and put in canonical form; a
 * resolve that picks, field by field, the first publishable text along a fallback chain (fr-CA, then fr, then any
 * configured fallbacks, then the source language) and says which language each field came from; staleness
 * (when a source field changes, the translated fields written from the old text are marked, and an approval is
 * refused until they are redone); a review state per variant (machine, draft, in review, approved) where the
 * reviewer cannot be the translator; machine translation through an injected translator that never sees
 * placeholders, HTML tags or links (they are masked and checked back, and a field that loses one is rejected) and
 * never overwrites human text; per-language slugs that are unique; hreflang alternates; and a completeness report.
 * The chain and text direction come from the i18n block.
 *
 * Out of scope: the machine translation service itself (it is a function you give), storage, and formatting of
 * numbers and dates (see i18n).
 */
import { createHash } from 'node:crypto';
import { chain as localeChain, direction } from '../i18n/index.ts';

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type VariantState = 'machine' | 'draft' | 'in-review' | 'approved';

export interface FieldDef {
  readonly name: string;
  readonly translatable: boolean;
  readonly required?: boolean;
  readonly maxLength?: number;
}

export interface ContentSchema {
  readonly fields: readonly FieldDef[];
  /** The translatable field that is the URL slug; it is unique per language. */
  readonly slugField?: string;
}

export interface Options {
  readonly schema: ContentSchema;
  readonly sourceLocale: string;
  readonly locales: readonly string[];
  /** Extra fallbacks by language, tried after the tag's own chain: { nb: ["no"], "pt-BR": ["pt-PT"] }. */
  readonly fallbacks?: Readonly<Record<string, readonly string[]>>;
  /** Which states may be shown to readers. Default only approved. */
  readonly publish?: readonly VariantState[];
  /** Whether a translation made from an older source is still shown until redone. Default true. */
  readonly serveStale?: boolean;
  readonly now?: () => number;
}

interface FieldValue {
  text: string;
  /** Hash of the source text this was written from. */
  basedOn: string;
  origin: 'human' | 'machine';
  by: string;
  at: number;
}

export interface Variant {
  readonly locale: string;
  state: VariantState;
  readonly fields: Record<string, FieldValue>;
  translator?: string;
  reviewer?: string;
  rejected?: { by: string; reason: string; at: number };
  log: { at: number; by: string; action: string; note?: string }[];
}

interface Item {
  readonly id: string;
  readonly source: Record<string, string>;
  readonly shared: Record<string, string>;
  revision: number;
  readonly variants: Map<string, Variant>;
}

export interface Resolved {
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly fields: Readonly<Record<string, string>>;
  /** For each translatable field, the language its text came from. */
  readonly from: Readonly<Record<string, string>>;
  /** Fields shown in another language than the one asked for. */
  readonly fallbackFields: readonly string[];
  readonly complete: boolean;
}

export type Translator = (req: { from: string; to: string; texts: Readonly<Record<string, string>> }) => Promise<Readonly<Record<string, string>>>;

export interface MachineResult {
  readonly filled: readonly string[];
  readonly rejected: readonly { field: string; why: string }[];
  readonly kept: readonly string[];
}

export interface LocaleReport {
  readonly locale: string;
  readonly items: number;
  readonly approved: number;
  readonly inReview: number;
  readonly draft: number;
  readonly machine: number;
  readonly missing: number;
  readonly stale: number;
  /** Items fully approved and current, as a share of all items. */
  readonly percent: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const SLUG = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;
const MAX_LOG = 50;

/** A language tag in canonical form (fr-ca becomes fr-CA), or an error. */
export function canonicalLocale(tag: string): string {
  try {
    const c = Intl.getCanonicalLocales(tag);
    if (c.length === 1 && c[0] && !/[_\s]/.test(tag)) return c[0];
  } catch {
    // fall through
  }
  throw new ContentError(`"${tag.slice(0, 30)}" is not a language tag`);
}

// ------------------------------------------------------------------ placeholders for machine translation

const PROTECT: readonly RegExp[] = [/\{\{[^{}]*\}\}/g, /\{[A-Za-z_][A-Za-z0-9_.]*\}/g, /%(?:\d+\$)?[sdf]/g, /<\/?[A-Za-z][^<>]*>/g, /\bhttps?:\/\/[^\s<>"'⟦⟧]*[^\s<>"'⟦⟧.,;:!?)]/g];

/** Replaces everything a translator must not touch by numbered markers, and returns how to put it back. */
export function maskPlaceholders(text: string): { masked: string; tokens: readonly string[] } {
  const tokens: string[] = [];
  let out = text;
  for (const re of PROTECT) {
    out = out.replace(re, (m) => {
      if (/^⟦\d+⟧$/.test(m)) return m;
      tokens.push(m);
      return `⟦${tokens.length - 1}⟧`;
    });
  }
  return { masked: out, tokens };
}

/** Restores masked text; undefined if a marker was lost, repeated or invented. */
export function unmaskPlaceholders(translated: string, tokens: readonly string[]): string | undefined {
  const seen = new Set<number>();
  let bad = false;
  const out = translated.replace(/⟦(\d+)⟧/g, (_m, n: string) => {
    const i = Number(n);
    if (i >= tokens.length || seen.has(i)) {
      bad = true;
      return '';
    }
    seen.add(i);
    return tokens[i]!;
  });
  return bad || seen.size !== tokens.length ? undefined : out;
}

export class Content {
  private readonly o: Options;
  private readonly locales: readonly string[];
  private readonly source: string;
  private readonly publishable: ReadonlySet<VariantState>;
  private readonly items = new Map<string, Item>();
  private readonly defs = new Map<string, FieldDef>();
  private readonly slugs = new Map<string, string>();

  constructor(o: Options) {
    this.o = o;
    this.source = canonicalLocale(o.sourceLocale);
    this.locales = [...new Set([this.source, ...o.locales.map(canonicalLocale)])];
    this.publishable = new Set(o.publish ?? ['approved']);
    for (const f of o.schema.fields) {
      if (this.defs.has(f.name)) throw new ContentError(`field ${f.name} is declared twice`);
      if (['__proto__', 'constructor', 'prototype'].includes(f.name)) throw new ContentError(`"${f.name}" is not a usable field name`);
      this.defs.set(f.name, f);
    }
    const s = o.schema.slugField;
    if (s !== undefined && !this.defs.get(s)?.translatable) throw new ContentError('the slug field must be a translatable field');
  }

  private now() {
    return this.o.now ? this.o.now() : Date.now();
  }

  private item(id: string): Item {
    const i = this.items.get(id);
    if (!i) throw new ContentError(`no content ${id}`);
    return i;
  }

  private locale(tag: string): string {
    const l = canonicalLocale(tag);
    if (!this.locales.includes(l)) throw new ContentError(`${l} is not one of the languages: ${this.locales.join(', ')}`);
    return l;
  }

  private translatable() {
    return this.o.schema.fields.filter((f) => f.translatable);
  }

  private checkValues(values: Readonly<Record<string, string>>, only: 'translatable' | 'any') {
    for (const [k, v] of Object.entries(values)) {
      const d = this.defs.get(k);
      if (!d) throw new ContentError(`there is no field "${k}"`);
      if (only === 'translatable' && !d.translatable) throw new ContentError(`"${k}" is the same in every language and is set on the source`);
      if (typeof v !== 'string') throw new ContentError(`"${k}" must be text`);
      if (d.maxLength !== undefined && v.length > d.maxLength) throw new ContentError(`"${k}" is longer than ${d.maxLength} characters`);
    }
  }

  private claimSlug(locale: string, id: string, slug: string | undefined, old: string | undefined) {
    if (slug === undefined || slug === old) return;
    if (!SLUG.test(slug)) throw new ContentError(`slug "${slug.slice(0, 40)}" must be lower-case words joined by hyphens`);
    const k = `${locale}\u0000${slug}`;
    const owner = this.slugs.get(k);
    if (owner !== undefined && owner !== id) throw new ContentError(`the ${locale} slug "${slug}" is used by ${owner}`);
    if (old !== undefined) this.slugs.delete(`${locale}\u0000${old}`);
    this.slugs.set(k, id);
  }

  // ------------------------------------------------------------ source

  create(id: string, values: Readonly<Record<string, string>>): void {
    if (this.items.has(id)) throw new ContentError(`content ${id} already exists`);
    this.checkValues(values, 'any');
    const missing = this.o.schema.fields.filter((f) => f.required && !(values[f.name] ?? '').trim()).map((f) => f.name);
    if (missing.length) throw new ContentError(`the source needs: ${missing.join(', ')}`);
    const slugField = this.o.schema.slugField;
    if (slugField !== undefined) this.claimSlug(this.source, id, values[slugField], undefined);
    const item: Item = { id, source: {}, shared: {}, revision: 1, variants: new Map() };
    for (const [k, v] of Object.entries(values)) (this.defs.get(k)!.translatable ? item.source : item.shared)[k] = v;
    this.items.set(id, item);
  }

  /** Changes the source. Translated fields written from the old text become stale. Returns the fields that went stale. */
  updateSource(id: string, patch: Readonly<Record<string, string>>): string[] {
    const item = this.item(id);
    this.checkValues(patch, 'any');
    const slugField = this.o.schema.slugField;
    if (slugField !== undefined && patch[slugField] !== undefined) this.claimSlug(this.source, id, patch[slugField], item.source[slugField]);
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      const t = this.defs.get(k)!.translatable;
      const bag = t ? item.source : item.shared;
      if (bag[k] !== v) {
        bag[k] = v;
        changed = changed || t;
      }
    }
    if (changed) item.revision++;
    return this.staleAcross(item);
  }

  private staleAcross(item: Item): string[] {
    const out = new Set<string>();
    for (const v of item.variants.values()) for (const f of this.staleFields(item.id, v.locale)) out.add(f);
    return [...out];
  }

  /** Fields of a variant whose source text has changed since they were written. */
  staleFields(contentId: string, locale: string): string[] {
    const item = this.item(contentId);
    const v = item.variants.get(this.locale(locale));
    if (!v) return [];
    return Object.entries(v.fields)
      .filter(([f, val]) => item.source[f] !== undefined && val.basedOn !== hash(item.source[f]!))
      .map(([f]) => f)
      .sort();
  }

  // ------------------------------------------------------------ translating

  private variant(item: Item, locale: string): Variant {
    let v = item.variants.get(locale);
    if (!v) {
      v = { locale, state: 'draft', fields: {}, log: [] };
      item.variants.set(locale, v);
    }
    return v;
  }

  private note(v: Variant, by: string, action: string, note?: string) {
    v.log.push({ at: this.now(), by, action, ...(note !== undefined ? { note } : {}) });
    if (v.log.length > MAX_LOG) v.log.shift();
  }

  /** A person writes or edits translated fields. Any edit sends the variant back to draft, so approval is never stale. */
  setTranslation(contentId: string, locale: string, values: Readonly<Record<string, string>>, by: string): Variant {
    const item = this.item(contentId);
    const loc = this.locale(locale);
    if (loc === this.source) throw new ContentError(`${loc} is the source language; change the source instead`);
    this.checkValues(values, 'translatable');
    const v = this.variant(item, loc);
    const slugField = this.o.schema.slugField;
    if (slugField !== undefined && values[slugField] !== undefined) this.claimSlug(loc, contentId, values[slugField], v.fields[slugField]?.text);
    const t = this.now();
    for (const [f, text] of Object.entries(values)) {
      if (!Object.hasOwn(item.source, f)) throw new ContentError(`"${f}" has no source text to translate`);
      if (text === '') delete v.fields[f];
      else v.fields[f] = { text, basedOn: hash(item.source[f]!), origin: 'human', by, at: t };
    }
    v.state = 'draft';
    v.translator = by;
    delete v.reviewer;
    this.note(v, by, 'edited', Object.keys(values).join(', '));
    return v;
  }

  submit(contentId: string, locale: string, by: string): Variant {
    const item = this.item(contentId);
    const v = item.variants.get(this.locale(locale));
    if (!v) throw new ContentError('there is no translation to submit');
    if (v.state !== 'draft' && v.state !== 'machine') throw new ContentError(`a ${v.state} translation cannot be submitted`);
    const missing = this.translatable().filter((f) => f.required && item.source[f.name] !== undefined && !(v.fields[f.name]?.text ?? '').trim()).map((f) => f.name);
    if (missing.length) throw new ContentError(`cannot submit; still missing: ${missing.join(', ')}`);
    v.state = 'in-review';
    this.note(v, by, 'submitted');
    return v;
  }

  approve(contentId: string, locale: string, by: string): Variant {
    const loc = this.locale(locale);
    const item = this.item(contentId);
    const v = item.variants.get(loc);
    if (!v || v.state !== 'in-review') throw new ContentError('only a translation in review can be approved');
    if (v.translator !== undefined && v.translator === by) throw new ContentError('the person who translated it cannot approve it');
    const stale = this.staleFields(contentId, loc);
    if (stale.length) throw new ContentError(`the source changed since these were written: ${stale.join(', ')}`);
    v.state = 'approved';
    v.reviewer = by;
    delete v.rejected;
    this.note(v, by, 'approved');
    return v;
  }

  reject(contentId: string, locale: string, by: string, reason: string): Variant {
    const v = this.item(contentId).variants.get(this.locale(locale));
    if (!v || v.state !== 'in-review') throw new ContentError('only a translation in review can be sent back');
    if (!reason.trim()) throw new ContentError('say why it is sent back');
    v.state = 'draft';
    v.rejected = { by, reason: reason.trim(), at: this.now() };
    this.note(v, by, 'rejected', reason.trim());
    return v;
  }

  /**
   * Fills a language with machine translation. Only fields that are empty or stale are sent; text a person wrote
   * is kept unless `overwriteHuman`. Placeholders, tags and links are masked, and a field that comes back without
   * one of them is rejected. A variant made only of machine text is in the "machine" state until a person edits it.
   */
  async machineTranslate(contentId: string, locale: string, translator: Translator, o: { overwriteHuman?: boolean; by?: string } = {}): Promise<MachineResult> {
    const item = this.item(contentId);
    const loc = this.locale(locale);
    if (loc === this.source) throw new ContentError('the source language is not machine translated');
    const existing = item.variants.get(loc);
    const stale = new Set(this.staleFields(contentId, loc));
    const kept: string[] = [];
    const todo: string[] = [];
    for (const f of this.translatable()) {
      const src = item.source[f.name];
      if (src === undefined || !src.trim()) continue;
      const have = existing?.fields[f.name];
      if (!have) todo.push(f.name);
      else if (o.overwriteHuman && have.origin === 'human') todo.push(f.name);
      else if (have.origin === 'machine' && stale.has(f.name)) todo.push(f.name);
      else kept.push(f.name);
    }
    if (!todo.length) return { filled: [], rejected: [], kept };
    const masks = new Map<string, readonly string[]>();
    const texts: Record<string, string> = {};
    for (const f of todo) {
      const m = maskPlaceholders(item.source[f]!);
      masks.set(f, m.tokens);
      texts[f] = m.masked;
    }
    const answer = await translator({ from: this.source, to: loc, texts });
    const filled: string[] = [];
    const rejected: { field: string; why: string }[] = [];
    const by = o.by ?? 'machine';
    const v = this.variant(item, loc);
    const t = this.now();
    const wasEmpty = Object.keys(v.fields).length === 0;
    for (const f of todo) {
      const got = Object.hasOwn(answer, f) ? answer[f] : undefined;
      if (typeof got !== 'string' || !got.trim()) {
        rejected.push({ field: f, why: 'the translator returned nothing' });
        continue;
      }
      const back = unmaskPlaceholders(got, masks.get(f)!);
      if (back === undefined) {
        rejected.push({ field: f, why: 'a placeholder, tag or link was lost or changed' });
        continue;
      }
      const def = this.defs.get(f)!;
      if (def.maxLength !== undefined && back.length > def.maxLength) {
        rejected.push({ field: f, why: `the result is longer than ${def.maxLength} characters` });
        continue;
      }
      if (f === this.o.schema.slugField) {
        if (!SLUG.test(back)) {
          rejected.push({ field: f, why: 'the result is not a usable slug' });
          continue;
        }
        try {
          this.claimSlug(loc, contentId, back, v.fields[f]?.text);
        } catch (e) {
          rejected.push({ field: f, why: (e as Error).message });
          continue;
        }
      }
      v.fields[f] = { text: back, basedOn: hash(item.source[f]!), origin: 'machine', by, at: t };
      filled.push(f);
    }
    if (filled.length) {
      if (wasEmpty || !existing) v.state = 'machine';
      else if (v.state === 'approved' || v.state === 'in-review') v.state = 'draft';
      this.note(v, by, 'machine-translated', filled.join(', '));
    }
    return { filled, rejected, kept };
  }

  variantOf(contentId: string, locale: string): Variant | undefined {
    return this.item(contentId).variants.get(this.locale(locale));
  }

  // ------------------------------------------------------------ reading

  /** The tags to try for a language, nearest first, ending with the source language. */
  chainFor(locale: string): string[] {
    const loc = this.locale(locale);
    const out: string[] = [];
    const add = (t: string) => {
      if (!out.includes(t)) out.push(t);
    };
    for (const t of localeChain(loc, this.source)) {
      if (t === this.source) continue;
      add(t);
      for (const f of this.o.fallbacks?.[t] ?? []) for (const x of localeChain(canonicalLocale(f), this.source)) if (x !== this.source) add(x);
    }
    add(this.source);
    return out;
  }

  /** The content for a language, field by field, falling back along the chain. */
  resolve(contentId: string, locale: string): Resolved {
    const item = this.item(contentId);
    const loc = this.locale(locale);
    const chain = this.chainFor(loc);
    const fields: Record<string, string> = { ...item.shared };
    const from: Record<string, string> = {};
    const fallbackFields: string[] = [];
    const serveStale = this.o.serveStale !== false;
    for (const f of this.translatable()) {
      const src = item.source[f.name];
      if (src === undefined) continue;
      let picked: { text: string; locale: string } | undefined;
      for (const l of chain) {
        if (l === this.source) {
          picked = { text: src, locale: l };
          break;
        }
        const v = item.variants.get(l);
        const val = v?.fields[f.name];
        if (!v || !val || !this.publishable.has(v.state) || !val.text.trim()) continue;
        if (val.basedOn !== hash(src) && !serveStale) continue;
        picked = { text: val.text, locale: l };
        break;
      }
      const p = picked ?? { text: src, locale: this.source };
      fields[f.name] = p.text;
      from[f.name] = p.locale;
      if (p.locale !== loc) fallbackFields.push(f.name);
    }
    return { locale: loc, dir: direction(loc), fields, from, fallbackFields, complete: fallbackFields.length === 0 };
  }

  /** The content id that has this slug in this language. */
  findBySlug(locale: string, slug: string): string | undefined {
    return this.slugs.get(`${this.locale(locale)}\u0000${slug}`);
  }

  /** hreflang alternates: every language that has a published variant, plus the source and an x-default. */
  alternates(contentId: string): { hreflang: string; locale: string; slug?: string }[] {
    const item = this.item(contentId);
    const slugField = this.o.schema.slugField;
    const out: { hreflang: string; locale: string; slug?: string }[] = [];
    const slugOf = (l: string) => (slugField === undefined ? undefined : l === this.source ? item.source[slugField] : item.variants.get(l)?.fields[slugField]?.text);
    for (const l of this.locales) {
      const ok = l === this.source || (() => {
        const v = item.variants.get(l);
        return !!v && this.publishable.has(v.state) && this.translatable().filter((f) => f.required).every((f) => (v.fields[f.name]?.text ?? '').trim());
      })();
      if (!ok) continue;
      const s = slugOf(l);
      out.push({ hreflang: l, locale: l, ...(s !== undefined ? { slug: s } : {}) });
    }
    const s = slugOf(this.source);
    out.push({ hreflang: 'x-default', locale: this.source, ...(s !== undefined ? { slug: s } : {}) });
    return out;
  }

  // ------------------------------------------------------------ status

  /** Per language: the state of one item, what is missing and what is stale. */
  status(contentId: string): { locale: string; state: VariantState | 'missing' | 'source'; missing: string[]; stale: string[] }[] {
    const item = this.item(contentId);
    return this.locales.map((l) => {
      if (l === this.source) return { locale: l, state: 'source' as const, missing: [], stale: [] };
      const v = item.variants.get(l);
      const need = this.translatable().filter((f) => f.required && item.source[f.name] !== undefined).map((f) => f.name);
      if (!v) return { locale: l, state: 'missing' as const, missing: need, stale: [] };
      return { locale: l, state: v.state, missing: need.filter((f) => !(v.fields[f]?.text ?? '').trim()), stale: this.staleFields(contentId, l) };
    });
  }

  /** Completeness by language across every item. */
  report(): LocaleReport[] {
    return this.locales
      .filter((l) => l !== this.source)
      .map((l) => {
        const r = { locale: l, items: this.items.size, approved: 0, inReview: 0, draft: 0, machine: 0, missing: 0, stale: 0, percent: 0 };
        let done = 0;
        for (const it of this.items.values()) {
          const s = this.status(it.id).find((x) => x.locale === l)!;
          if (s.state === 'missing') r.missing++;
          else if (s.state === 'approved') r.approved++;
          else if (s.state === 'in-review') r.inReview++;
          else if (s.state === 'draft') r.draft++;
          else if (s.state === 'machine') r.machine++;
          if (s.stale.length) r.stale++;
          if (s.state === 'approved' && !s.stale.length && !s.missing.length) done++;
        }
        r.percent = r.items ? done / r.items : 1;
        return r;
      });
  }

  /** Items and fields still needing work in a language, oldest source change first is not tracked; ordered by id. */
  todo(locale: string): { contentId: string; reason: 'missing' | 'incomplete' | 'stale' | 'unreviewed'; fields: string[] }[] {
    const loc = this.locale(locale);
    const out: { contentId: string; reason: 'missing' | 'incomplete' | 'stale' | 'unreviewed'; fields: string[] }[] = [];
    for (const it of [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const s = this.status(it.id).find((x) => x.locale === loc);
      if (!s || s.state === 'source') continue;
      if (s.state === 'missing') out.push({ contentId: it.id, reason: 'missing', fields: s.missing });
      else if (s.missing.length) out.push({ contentId: it.id, reason: 'incomplete', fields: s.missing });
      else if (s.stale.length) out.push({ contentId: it.id, reason: 'stale', fields: s.stale });
      else if (s.state !== 'approved') out.push({ contentId: it.id, reason: 'unreviewed', fields: [] });
    }
    return out;
  }
}
