/**
 * Full-text search with BM25 ranking. Text is folded (case and accents), split into words, and lightly stemmed;
 * fields carry weights (a title match counts more than a body match); the last word of a query also matches as a
 * prefix so results appear while typing (every word, that one included, must match); quoted phrases must appear in
 * order within one field; filters narrow by facet, and facet counts come back with the results. Snippets mark the
 * matched words, escaped for HTML. Documents are only ever returned to someone the `canSee` check allows.
 */

export interface Doc {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly facets?: Readonly<Record<string, string>>;
}

const STOP = new Set('a an and are as at be by for from in is it of on or that the to was were will with'.split(' '));

export const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const ENDINGS = [['ies', 'y'], ['sses', 'ss'], ['ing', ''], ['edly', ''], ['ed', ''], ['ly', ''], ['es', ''], ['s', '']] as const;

/** A light English stemmer: enough to match plurals and common endings. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  for (const [end, rep] of ENDINGS) if (w.endsWith(end) && w.length - end.length >= 3) return w.slice(0, -end.length) + rep;
  return w;
}

/**
 * Whether a word being typed can still become one indexed under `term`: the term starts with it, or it is the
 * term's stem followed by the start of an ending the stemmer removes ("budgete" on the way to "budgeted", "studi"
 * on the way to "studies"), so results do not drop out while a word is typed past its stem.
 */
export function typedToward(prefix: string, term: string): boolean {
  if (term.startsWith(prefix)) return true;
  for (const [end, rep] of ENDINGS) {
    if (!term.endsWith(rep)) continue;
    const base = term.slice(0, term.length - rep.length);
    if (base.length < 3 || !prefix.startsWith(base)) continue;
    const rest = prefix.slice(base.length);
    if (rest.length > 0 && rest.length < end.length && end.startsWith(rest) && stem(base + end) === term) return true;
  }
  return false;
}

export function words(s: string): string[] {
  return (fold(s).match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
}

export interface SearchOptions {
  readonly weights?: Readonly<Record<string, number>>;
  readonly k1?: number;
  readonly b?: number;
}

export interface Hit {
  readonly id: string;
  readonly score: number;
  readonly snippet: string;
}

export class Index {
  private readonly docs = new Map<string, Doc>();
  private readonly terms = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  /** The terms each document was indexed under, so removing it touches only its own postings. */
  private readonly docTerms = new Map<string, Set<string>>();
  private total = 0;
  private readonly o: Required<SearchOptions>;

  constructor(o: SearchOptions = {}) {
    this.o = { weights: {}, k1: 1.2, b: 0.75, ...o };
  }

  add(d: Doc): void {
    this.remove(d.id);
    this.docs.set(d.id, d);
    let len = 0;
    const mine = new Set<string>();
    for (const [f, text] of Object.entries(d.fields)) {
      const w = (Object.hasOwn(this.o.weights, f) ? this.o.weights[f] : undefined) ?? 1;
      for (const t of words(text).map(stem)) {
        mine.add(t);
        const m = this.terms.get(t) ?? new Map<string, number>();
        m.set(d.id, (m.get(d.id) ?? 0) + w);
        this.terms.set(t, m);
        len += 1;
      }
    }
    this.lengths.set(d.id, len);
    this.docTerms.set(d.id, mine);
    this.total += len;
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return;
    for (const t of this.docTerms.get(id) ?? []) {
      const m = this.terms.get(t);
      m?.delete(id);
      if (m && !m.size) this.terms.delete(t);
    }
    this.docTerms.delete(id);
    this.total -= this.lengths.get(id) ?? 0;
    this.lengths.delete(id);
    this.docs.delete(id);
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, o: { canSee: (id: string) => boolean; filters?: Readonly<Record<string, string>>; limit?: number; facets?: readonly string[] }): { hits: Hit[]; total: number; facets: Record<string, Record<string, number>> } {
    const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) => words(m[1]!));
    const rest = query.replace(/"[^"]*"/g, ' ');
    const qWords = words(rest);
    const typing = !/\s$/.test(query) && !query.trim().endsWith('"');
    const lastPrefix = typing && qWords.length ? qWords.at(-1)! : undefined;
    const terms = [...new Set([...qWords.map(stem), ...phrases.flat().map(stem)])];
    const N = this.docs.size || 1;
    const avg = this.total / N || 1;
    const scores = new Map<string, number>();
    // The word being typed is a prefix unless the same stem also appears as a finished word earlier in the query.
    const prefixStem = lastPrefix !== undefined && !qWords.slice(0, -1).some((w) => stem(w) === stem(lastPrefix)) && !phrases.flat().some((w) => stem(w) === stem(lastPrefix)) ? stem(lastPrefix) : undefined;
    const expand = (t: string) => (t === prefixStem ? [...this.terms.keys()].filter((k) => k === t || typedToward(lastPrefix!, k)) : [t]);
    for (const t of terms) {
      for (const term of expand(t)) {
        const posting = this.terms.get(term);
        if (!posting) continue;
        const idf = Math.log(1 + (N - posting.size + 0.5) / (posting.size + 0.5));
        for (const [id, tf] of posting) {
          const len = this.lengths.get(id) ?? 0;
          const s = (idf * tf * (this.o.k1 + 1)) / (tf + this.o.k1 * (1 - this.o.b + (this.o.b * len) / avg));
          scores.set(id, (scores.get(id) ?? 0) + s);
        }
      }
    }
    const matched: { id: string; score: number }[] = [];
    for (const [id, score] of scores) {
      const d = this.docs.get(id)!;
      if (!o.canSee(id)) continue;
      if (o.filters && !Object.entries(o.filters).every(([k, v]) => d.facets?.[k] === v)) continue;
      const perField = Object.values(d.fields).map(words);
      if (!phrases.every((p) => perField.some((all) => all.some((_, i) => p.every((w, j) => all[i + j] === w))))) continue;
      const stems = new Set(perField.flat().map(stem));
      const required = (prefixStem === undefined ? qWords : qWords.slice(0, -1)).map(stem);
      if (!required.every((t) => stems.has(t))) continue;
      if (prefixStem !== undefined && !stems.has(prefixStem) && ![...stems].some((t) => typedToward(lastPrefix!, t))) continue;
      matched.push({ id, score });
    }
    matched.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const facets: Record<string, Record<string, number>> = {};
    for (const f of o.facets ?? []) {
      facets[f] = {};
      for (const m of matched) {
        const v = this.docs.get(m.id)!.facets?.[f];
        if (v) facets[f]![v] = (facets[f]![v] ?? 0) + 1;
      }
    }
    const marks = new Set([...qWords, ...phrases.flat()].map(stem));
    const hits = matched.slice(0, o.limit ?? 20).map((m) => ({ ...m, snippet: snippet(Object.values(this.docs.get(m.id)!.fields).join(' — '), marks, lastPrefix) }));
    return { hits, total: matched.length, facets };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function snippet(text: string, marks: Set<string>, prefix?: string, width = 160): string {
  const tokens = text.split(/(\s+)/);
  const hit = (w: string) => {
    const f = fold(w.replace(/[^\p{L}\p{N}]/gu, ''));
    return f.length > 0 && (marks.has(stem(f)) || (!!prefix && (f.startsWith(prefix) || typedToward(prefix, stem(f)))));
  };
  const first = tokens.findIndex(hit);
  let start = 0;
  if (first > 0) {
    let chars = 0;
    start = first;
    while (start > 0 && chars < width / 3) chars += tokens[--start]!.length;
  }
  let out = '';
  let len = 0;
  for (let i = start; i < tokens.length && len < width; i++) {
    const t = tokens[i]!;
    out += hit(t) ? `<mark>${esc(t)}</mark>` : esc(t);
    len += t.length;
  }
  return `${start > 0 ? '…' : ''}${out.trim()}${len >= width ? '…' : ''}`;
}
