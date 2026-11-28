/**
 * Edit conflicts. Every record carries a version. A save names the version it was edited from; if the record has
 * moved on since, the fields the two edits share are merged three ways: a field only one side changed takes that
 * change, a field both sides changed the same way is fine, and a field both changed differently is a conflict the
 * person resolves, shown field by field. Nothing is ever silently overwritten.
 */

export interface Versioned<T> {
  readonly version: number;
  readonly data: T;
}

export type SaveResult<T> =
  | { readonly ok: true; readonly record: Versioned<T>; readonly merged: readonly (keyof T)[] }
  | { readonly ok: false; readonly conflicts: readonly { readonly field: keyof T; readonly base: unknown; readonly theirs: unknown; readonly yours: unknown }[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Save `yours`, edited from `base` at version `from`, onto `current`. `base` is the record as it was at `from`.
 */
export function save<T extends Record<string, unknown>>(current: Versioned<T>, from: number, base: T, yours: T): SaveResult<T> {
  if (from > current.version) throw new RangeError(`version ${from} is newer than the record's ${current.version}`);
  if (from === current.version) return { ok: true, record: { version: current.version + 1, data: yours }, merged: [] };
  const theirs = current.data;
  const keys = [...new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(yours)])] as (keyof T)[];
  const out: Record<string, unknown> = {};
  const conflicts: { field: keyof T; base: unknown; theirs: unknown; yours: unknown }[] = [];
  const merged: (keyof T)[] = [];
  for (const k of keys) {
    const b = base[k];
    const t = theirs[k];
    const y = yours[k];
    const tChanged = !same(b, t);
    const yChanged = !same(b, y);
    if (!yChanged) out[k as string] = t;
    else if (!tChanged || same(t, y)) {
      out[k as string] = y;
      merged.push(k);
    } else conflicts.push({ field: k, base: b, theirs: t, yours: y });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, record: { version: current.version + 1, data: out as T }, merged };
}
