/**
 * History and undo for any record. Every change is kept as the fields it changed, before and after, with who and
 * when; any past version can be rebuilt, two versions compared, and a change undone. Undo is itself a change, so
 * nothing is ever lost; an undo that would overwrite something edited since is refused with the fields in conflict,
 * rather than quietly losing the newer edit.
 */

export type Fields = Readonly<Record<string, unknown>>;

export interface Change {
  readonly version: number;
  readonly by: string;
  readonly at: string;
  readonly before: Fields;
  readonly after: Fields;
  readonly note?: string;
  readonly undoes?: number;
}

export class Conflict extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`changed since: ${fields.join(', ')}`);
    this.fields = fields;
  }
}

/** Compares values as JSON, with object keys in a fixed order, so a reordered object is not a change. */
const canon = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
/** Field access by own key only, so fields named like `constructor` or `__proto__` never read or set the prototype. */
const own = (o: Fields, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const put = (o: Record<string, unknown>, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

export class History {
  private readonly changes = new Map<string, Change[]>();
  private readonly current = new Map<string, Record<string, unknown>>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  get(id: string): Fields | undefined {
    const c = this.current.get(id);
    return c ? { ...c } : undefined;
  }

  version(id: string): number {
    return this.changes.get(id)?.length ?? 0;
  }

  /** Applies a change; `expected` makes it refuse if someone else changed the record first. */
  change(id: string, by: string, fields: Fields, o: { expected?: number; note?: string; undoes?: number } = {}): Change {
    const list = this.changes.get(id) ?? [];
    if (o.expected !== undefined && o.expected !== list.length) throw new Conflict(['version']);
    const cur = this.current.get(id) ?? {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (same(own(cur, k), v)) continue;
      put(before, k, own(cur, k));
      put(after, k, v);
    }
    const c: Change = { version: list.length + 1, by, at: this.now().toISOString(), before, after, ...(o.note ? { note: o.note } : {}), ...(o.undoes ? { undoes: o.undoes } : {}) };
    list.push(c);
    this.changes.set(id, list);
    const next = { ...cur, ...after };
    for (const [k, v] of Object.entries(after)) if (v === undefined) delete next[k];
    this.current.set(id, next);
    return c;
  }

  log(id: string): readonly Change[] {
    return this.changes.get(id) ?? [];
  }

  /** The record as it was right after a version. */
  at(id: string, version: number): Fields {
    const out: Record<string, unknown> = {};
    for (const c of this.log(id).slice(0, version))
      for (const [k, v] of Object.entries(c.after)) {
        if (v === undefined) delete out[k];
        else put(out, k, v);
      }
    return out;
  }

  diff(id: string, from: number, to: number): { field: string; from: unknown; to: unknown }[] {
    const a = this.at(id, from);
    const b = this.at(id, to);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(own(a, k), own(b, k))).sort().map((field) => ({ field, from: own(a, field), to: own(b, field) }));
  }

  /** Undoes one change, as a new change. Refuses when a field it touched has changed again since. */
  undo(id: string, version: number, by: string): Change {
    const c = this.log(id)[version - 1];
    if (!c) throw new Error(`no version ${version}`);
    const cur = this.current.get(id) ?? {};
    const moved = Object.keys(c.after).filter((k) => !same(own(cur, k), c.after[k]));
    if (moved.length) throw new Conflict(moved);
    return this.change(id, by, c.before, { note: `undo of version ${version}`, undoes: version });
  }

  /** Puts the record back as it was at a version, as one new change. */
  restore(id: string, version: number, by: string): Change {
    const then = this.at(id, version);
    const cur = this.current.get(id) ?? {};
    const fields: Record<string, unknown> = { ...then };
    for (const k of Object.keys(cur)) if (!Object.hasOwn(then, k)) put(fields, k, undefined);
    return this.change(id, by, fields, { note: `restored version ${version}` });
  }
}
