/**
 * Translation and formatting. Messages live in catalogues per language, with plural forms chosen by the language's
 * own rules (Intl.PluralRules: English has two, Arabic six, Japanese one) and named values. A missing message falls
 * back along a chain (fr-CA, then fr, then the source language) and is reported, never shown as a raw key. Numbers,
 * money, dates, lists and relative times are formatted by Intl for the reader's locale; direction is known for
 * right-to-left scripts. A check lists every key missing, extra, or missing a plural form, per language.
 */

/** A plain string, or plural forms by category, with optional exact matches such as "=0". */
export type Message = string | Readonly<Partial<Record<Intl.LDMLPluralRule | `=${number}`, string>>>;
export type Catalogue = Readonly<Record<string, Message>>;

const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ug']);

export const direction = (locale: string): 'rtl' | 'ltr' => (RTL.has(locale.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr');

/** fr-CA → [fr-CA, fr, source]. */
export function chain(locale: string, source: string): string[] {
  const out: string[] = [];
  const parts = locale.split('-');
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('-'));
  if (!out.includes(source)) out.push(source);
  return out;
}

/** Picks the best supported locale from an Accept-Language header. */
export function negotiate(header: string | undefined, supported: readonly string[], fallback: string): string {
  const asked = (header ?? '')
    .split(',')
    .map((p) => {
      const [tag, ...params] = p.trim().split(';');
      const q = params.find((x) => x.trim().startsWith('q='));
      return { tag: tag!.trim(), q: q ? Number(q.trim().slice(2)) : 1 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q);
  const lower = supported.map((s) => s.toLowerCase());
  for (const { tag } of asked) {
    const t = tag.toLowerCase();
    const exact = lower.indexOf(t);
    if (exact >= 0) return supported[exact]!;
    const base = lower.findIndex((s) => s === t.split('-')[0] || s.split('-')[0] === t.split('-')[0]);
    if (base >= 0) return supported[base]!;
  }
  return fallback;
}

export class I18n {
  private readonly catalogues: Readonly<Record<string, Catalogue>>;
  readonly source: string;
  readonly missing = new Set<string>();

  constructor(catalogues: Readonly<Record<string, Catalogue>>, source: string) {
    if (!catalogues[source]) throw new Error(`no catalogue for the source language ${source}`);
    this.catalogues = catalogues;
    this.source = source;
  }

  t(locale: string, key: string, values: Readonly<Record<string, string | number>> = {}): string {
    for (const l of chain(locale, this.source)) {
      const m = this.catalogues[l]?.[key];
      if (m === undefined) continue;
      if (l !== locale) this.missing.add(`${locale}:${key}`);
      let text: string | undefined;
      if (typeof m === 'string') text = m;
      else {
        const n = values.count;
        if (typeof n !== 'number') throw new Error(`${key} has plural forms and needs a count`);
        const exact = (m as Record<string, string | undefined>)[`=${n}`];
        text = exact ?? m[new Intl.PluralRules(l).select(n)] ?? m.other;
      }
      if (text === undefined) continue;
      return text.replace(/\{(\w+)\}/g, (_, k: string) => {
        const v = values[k];
        if (v === undefined) throw new Error(`${key} needs {${k}}`);
        return typeof v === 'number' ? new Intl.NumberFormat(l).format(v) : v;
      });
    }
    this.missing.add(`${locale}:${key}`);
    throw new Error(`no message ${key} in any language`);
  }

  /** Per language: keys missing, keys not in the source, and plural forms the language needs but lacks. */
  check(): Record<string, { missing: string[]; extra: string[]; plurals: string[] }> {
    const src = this.catalogues[this.source]!;
    const out: Record<string, { missing: string[]; extra: string[]; plurals: string[] }> = {};
    for (const [l, cat] of Object.entries(this.catalogues)) {
      if (l === this.source) continue;
      const needs = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
      out[l] = {
        missing: Object.keys(src).filter((k) => !(k in cat)).sort(),
        extra: Object.keys(cat).filter((k) => !(k in src)).sort(),
        plurals: Object.entries(cat).flatMap(([k, m]) => (typeof m === 'string' || typeof src[k] === 'string' ? [] : needs.filter((c) => !(c in m)).map((c) => `${k}.${c}`))).sort(),
      };
    }
    return out;
  }
}

export const fmt = {
  number: (locale: string, n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, o).format(n),
  money: (locale: string, minor: number, currency: string) => {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits);
  },
  date: (locale: string, d: Date, tz: string, o: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }) => new Intl.DateTimeFormat(locale, { ...o, timeZone: tz }).format(d),
  list: (locale: string, items: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction') => new Intl.ListFormat(locale, { type }).format(items),
  /** "3 days ago", "in 2 hours", choosing the unit. */
  relative: (locale: string, then: Date, now: Date) => {
    const s = (then.getTime() - now.getTime()) / 1000;
    const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60], ['second', 1]];
    const [unit, size] = units.find(([, n]) => Math.abs(s) >= n) ?? ['second', 1];
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(s / size), unit);
  },
};
