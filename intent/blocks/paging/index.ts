/**
 * Lists: paging, sorting and filters. A list has a stable order (the chosen sort, then the id, so ties never
 * shuffle), pages by an opaque cursor that holds the last row's sort values (so new rows never shift a page), and
 * accepts only the filters and sorts its declaration allows.
 */

export interface ListSpec<T> {
  /** Fields that may be sorted on. */
  readonly sortable: readonly (keyof T & string)[];
  /** Fields that may be filtered, and how. */
  readonly filterable: Readonly<Partial<Record<keyof T & string, readonly Op[]>>>;
  readonly idField: keyof T & string;
  readonly maxPage: number;
}

export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains';
export interface Filter {
  readonly field: string;
  readonly op: Op;
  readonly value: unknown;
}
export interface Query {
  readonly sort?: { readonly field: string; readonly dir: 'asc' | 'desc' };
  readonly filters?: readonly Filter[];
  readonly after?: string;
  readonly limit?: number;
}

export class BadQuery extends Error {}

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const dec = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new BadQuery('the cursor is not one this list gave out');
  }
};

const cmp = (a: unknown, b: unknown): number => (a === b ? 0 : a === null || a === undefined ? -1 : b === null || b === undefined ? 1 : (a as never) < (b as never) ? -1 : 1);

/** Check a query against the list's declaration. Anything it does not allow is refused by name. */
export function check<T>(spec: ListSpec<T>, q: Query): void {
  if (q.sort && !spec.sortable.includes(q.sort.field as never)) throw new BadQuery(`cannot sort by ${q.sort.field}`);
  for (const f of q.filters ?? []) {
    const ops = spec.filterable[f.field as keyof T & string];
    if (!ops || !ops.includes(f.op)) throw new BadQuery(`cannot filter ${f.field} by ${f.op}`);
  }
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1)) throw new BadQuery('limit must be a whole number from 1');
}

const test = (row: Record<string, unknown>, f: Filter): boolean => {
  const v = row[f.field];
  switch (f.op) {
    case 'eq': return v === f.value;
    case 'ne': return v !== f.value;
    case 'lt': return cmp(v, f.value) < 0;
    case 'lte': return cmp(v, f.value) <= 0;
    case 'gt': return cmp(v, f.value) > 0;
    case 'gte': return cmp(v, f.value) >= 0;
    case 'in': return Array.isArray(f.value) && f.value.includes(v);
    case 'contains': return typeof v === 'string' && typeof f.value === 'string' && v.toLowerCase().includes(f.value.toLowerCase());
  }
};

/** One page of rows, in memory. A database adapter compiles the same query to a keyset WHERE and ORDER BY. */
export function page<T extends Record<string, unknown>>(spec: ListSpec<T>, rows: readonly T[], q: Query): { rows: T[]; next: string | null } {
  check(spec, q);
  const sf = q.sort?.field ?? spec.idField;
  const dir = q.sort?.dir === 'desc' ? -1 : 1;
  const id = spec.idField;
  const order = (a: T, b: T) => dir * cmp(a[sf], b[sf]) || cmp(a[id], b[id]);
  let list = rows.filter((r) => (q.filters ?? []).every((f) => test(r, f))).sort(order);
  if (q.after) {
    const c = dec(q.after) as { s: unknown; i: unknown; f: string; d: number };
    if (!c || c.f !== sf || c.d !== dir) throw new BadQuery('the cursor belongs to another sort');
    list = list.filter((r) => dir * cmp(r[sf], c.s) > 0 || (cmp(r[sf], c.s) === 0 && cmp(r[id], c.i) > 0));
  }
  const limit = Math.min(q.limit ?? spec.maxPage, spec.maxPage);
  const out = list.slice(0, limit);
  const last = out.at(-1);
  return { rows: out, next: list.length > limit && last ? enc({ s: last[sf], i: last[id], f: sf, d: dir }) : null };
}
