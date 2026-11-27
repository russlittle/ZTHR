/**
 * Never lose work. What someone is typing is saved as a draft every few seconds, per person and per thing being
 * edited, with a short history so an earlier draft can be brought back. When the record has been saved by someone
 * else since the draft began, resuming says so and shows both, instead of silently overwriting either. Drafts are
 * removed when the work is saved, and old ones are swept after a set time.
 */

export interface Draft {
  readonly who: string;
  readonly what: string;
  /** The version of the record the draft is based on; saving from a newer version moves it on. */
  base: number;
  fields: Record<string, unknown>;
  readonly started: number;
  updated: number;
  readonly history: { at: number; fields: Record<string, unknown> }[];
}

export type Resume = { readonly state: 'none' } | { readonly state: 'clean'; readonly draft: Draft } | { readonly state: 'conflict'; readonly draft: Draft; readonly changed: readonly string[] };

/** A deep copy, so later edits to nested values in the editor cannot rewrite saved history. */
const copy = (f: Record<string, unknown>): Record<string, unknown> => structuredClone(f);

export class Drafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly now: () => number;
  private readonly keep: number;
  private readonly minGapMs: number;

  constructor(o: { now?: () => number; keepVersions?: number; minGapMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.keep = o.keepVersions ?? 10;
    if (!(this.keep >= 1)) throw new Error('keep at least one version');
    this.minGapMs = o.minGapMs ?? 30_000;
  }

  /** Unambiguous for any ids, so no crafted id can reach another person's draft. */
  private key(who: string, what: string) {
    return JSON.stringify([who, what]);
  }

  /** Called on every pause in typing. A snapshot goes into history at most every `minGapMs`. */
  save(who: string, what: string, base: number, fields: Record<string, unknown>): Draft {
    const k = this.key(who, what);
    const t = this.now();
    const d = this.drafts.get(k);
    if (!d) {
      const nd: Draft = { who, what, base, fields: copy(fields), started: t, updated: t, history: [{ at: t, fields: copy(fields) }] };
      this.drafts.set(k, nd);
      return nd;
    }
    d.base = base;
    d.fields = copy(fields);
    d.updated = t;
    const last = d.history.at(-1)!;
    if (t - last.at >= this.minGapMs) d.history.push({ at: t, fields: copy(fields) });
    else last.fields = copy(fields);
    while (d.history.length > this.keep) d.history.shift();
    return d;
  }

  /** On opening the editor: is there a draft, and does the record still match what it started from? */
  resume(who: string, what: string, current: { version: number; fields: Readonly<Record<string, unknown>> }, startedFrom?: Readonly<Record<string, unknown>>): Resume {
    const d = this.drafts.get(this.key(who, what));
    if (!d) return { state: 'none' };
    if (d.base === current.version) return { state: 'clean', draft: d };
    const changed = Object.keys(current.fields).filter((k) => startedFrom === undefined || JSON.stringify(current.fields[k]) !== JSON.stringify(startedFrom[k])).sort();
    return { state: 'conflict', draft: d, changed };
  }

  /** Brings an earlier draft back as the current one. */
  restore(who: string, what: string, index: number): Draft {
    const d = this.drafts.get(this.key(who, what));
    const h = d?.history[index];
    if (!d || !h) throw new Error('no such draft');
    d.fields = copy(h.fields);
    d.updated = this.now();
    return d;
  }

  /** The work was saved: the draft is done. */
  done(who: string, what: string): void {
    this.drafts.delete(this.key(who, what));
  }

  discard(who: string, what: string): void {
    this.drafts.delete(this.key(who, what));
  }

  /** Drafts a person has open, newest first: "pick up where you left off". */
  mine(who: string): Draft[] {
    return [...this.drafts.values()].filter((d) => d.who === who).sort((a, b) => b.updated - a.updated);
  }

  sweep(olderThanMs: number): number {
    let n = 0;
    for (const [k, d] of this.drafts)
      if (this.now() - d.updated > olderThanMs) {
        this.drafts.delete(k);
        n++;
      }
    return n;
  }
}
