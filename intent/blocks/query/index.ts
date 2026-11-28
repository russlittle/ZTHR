/**
 * A query console that cannot hurt anything. Queries are written in a small read-only language
 * (`from files where size > 1000 and owner = "ana" order by size desc limit 20 select name, size`), parsed into a
 * plan that is checked against the declared collections and fields before it runs: no writes exist in the
 * language, unknown fields are refused by name, results are capped, sensitive fields are masked unless the person
 * may see them (and cannot be filtered or sorted on, which would reveal them), and every query is recorded with
 * who ran it and how many rows came back. The record is a bounded in-memory log of the most recent queries, each
 * also handed to a caller-provided sink for durable storage.
 */

export interface Collection {
  readonly name: string;
  readonly fields: Readonly<Record<string, { readonly type: 'string' | 'number' | 'boolean' | 'date'; readonly sensitive?: boolean }>>;
}

export type Cmp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains';
export interface Cond {
  readonly field: string;
  readonly op: Cmp;
  readonly value: string | number | boolean;
}
export interface Plan {
  readonly from: string;
  readonly where: readonly Cond[];
  readonly order?: { readonly field: string; readonly desc: boolean };
  readonly limit: number;
  readonly select?: readonly string[];
}

export class QueryError extends Error {}

const TOKEN = /\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|(<=|>=|!=|=|<|>|,)|([A-Za-z_][\w.]*))/y;

export function tokens(q: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < q.length) {
    if (/^\s*$/.test(q.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(q);
    if (!m) throw new QueryError(`cannot read the query at "${q.slice(at, at + 12)}"`);
    out.push(m[0].trim());
  }
  return out;
}

export function parse(q: string, maxLimit = 500): Plan {
  const t = tokens(q);
  let i = 0;
  const peek = () => t[i]?.toLowerCase();
  const take = (want?: string) => {
    const x = t[i++];
    if (x === undefined) throw new QueryError(`the query ends too soon${want ? `; expected ${want}` : ''}`);
    if (want && x.toLowerCase() !== want) throw new QueryError(`expected ${want}, found ${x}`);
    return x;
  };
  const text = (x: string): string => {
    try {
      return JSON.parse(x) as string;
    } catch {
      throw new QueryError(`${x} is not readable text; the escapes are \\" \\\\ \\n \\t and \\u0000`);
    }
  };
  const value = (x: string): string | number | boolean => (x.startsWith('"') ? text(x) : /^-?\d/.test(x) ? Number(x) : x === 'true' ? true : x === 'false' ? false : (() => { throw new QueryError(`${x} is not a value; quote text like "this"`); })());
  take('from');
  const from = take();
  const where: Cond[] = [];
  let order: Plan['order'];
  let limit = 50;
  let select: string[] | undefined;
  while (i < t.length) {
    const k = peek();
    if (k === 'where' || k === 'and') {
      take();
      const field = take();
      const op = take();
      if (!['=', '!=', '<', '<=', '>', '>=', 'contains'].includes(op.toLowerCase())) throw new QueryError(`${op} is not a comparison`);
      where.push({ field, op: op.toLowerCase() as Cmp, value: value(take()) });
    } else if (k === 'order') {
      take();
      take('by');
      const field = take();
      const d = peek();
      if (d === 'asc' || d === 'desc') take();
      order = { field, desc: d === 'desc' };
    } else if (k === 'limit') {
      take();
      limit = Number(take());
      if (!Number.isInteger(limit) || limit < 1) throw new QueryError('limit is a whole number above 0');
    } else if (k === 'select') {
      take();
      select = [take()];
      while (peek() === ',') take(), select.push(take());
    } else if (['insert', 'update', 'delete', 'drop', 'set', 'or'].includes(k!)) throw new QueryError(k === 'or' ? 'use two queries instead of or' : 'this console only reads');
    else throw new QueryError(`did not expect ${t[i]}`);
  }
  return { from, where, ...(order ? { order } : {}), limit: Math.min(limit, maxLimit), ...(select ? { select } : {}) };
}

export function checkPlan(p: Plan, cols: readonly Collection[]): Collection {
  const c = cols.find((x) => x.name === p.from);
  if (!c) throw new QueryError(`no collection ${p.from}; there are ${cols.map((x) => x.name).join(', ')}`);
  for (const f of [...p.where.map((w) => w.field), ...(p.order ? [p.order.field] : []), ...(p.select ?? [])]) if (!Object.hasOwn(c.fields, f)) throw new QueryError(`${p.from} has no field ${f}`);
  for (const w of p.where) {
    const ty = c.fields[w.field]!.type;
    if (w.op === 'contains' ? ty !== 'string' : ty === 'number' ? typeof w.value !== 'number' : ty === 'boolean' ? typeof w.value !== 'boolean' : typeof w.value !== 'string') throw new QueryError(`${w.field} is a ${ty}; ${JSON.stringify(w.value)} does not fit ${w.op}`);
  }
  return c;
}

const test = (v: unknown, c: Cond) => {
  switch (c.op) {
    case '=': return v === c.value;
    case '!=': return v !== c.value;
    case '<': return (v as number) < (c.value as number);
    case '<=': return (v as number) <= (c.value as number);
    case '>': return (v as number) > (c.value as number);
    case '>=': return (v as number) >= (c.value as number);
    case 'contains': return typeof v === 'string' && v.toLowerCase().includes(String(c.value).toLowerCase());
  }
};

/** One query as recorded: who ran it, the text, the rows returned, and the error if it was refused. */
export interface QueryLog {
  readonly at: string;
  readonly who: string;
  readonly query: string;
  readonly rows: number;
  readonly error?: string;
}

/** How a bounded log keeps its entries: the most recent `keep` in memory, every one handed to `sink` as it is recorded. */
export interface LogOptions<E> {
  /** How many of the most recent entries stay in memory; a whole number of at least 1, 1000 if not given. */
  readonly keep?: number;
  /**
   * Durable storage, provided by the caller: called once with every entry as it is recorded, before anything is
   * evicted from memory. A sink that throws or whose promise rejects is counted in `sinkFailures` and never breaks
   * the work being recorded.
   */
  readonly sink?: (entry: E) => void | Promise<unknown>;
}

/** An in-memory log that holds only the most recent entries, with counts that say what was recorded, handed on and evicted. */
export class BoundedLog<E> {
  private readonly list: E[] = [];
  private readonly keep: number;
  private readonly sink: ((entry: E) => void | Promise<unknown>) | undefined;
  /** Entries recorded since the log was made. */
  recorded = 0;
  /** Entries handed to the sink. */
  handed = 0;
  /** Hand-offs where the sink threw or its promise rejected. */
  sinkFailures = 0;
  /** Entries dropped from memory to stay within `keep`. */
  evicted = 0;

  constructor(o: LogOptions<E> = {}) {
    const keep = o.keep ?? 1000;
    if (!Number.isInteger(keep) || keep < 1) throw new Error('a log keeps a whole number of entries, at least 1');
    this.keep = keep;
    this.sink = o.sink;
  }

  /** The most recent entries, oldest first. */
  get entries(): readonly E[] {
    return this.list;
  }

  push(entry: E): void {
    this.recorded++;
    if (this.sink) {
      this.handed++;
      try {
        const r = this.sink(entry);
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => void this.sinkFailures++);
      } catch {
        this.sinkFailures++;
      }
    }
    this.list.push(entry);
    while (this.list.length > this.keep) {
      this.list.shift();
      this.evicted++;
    }
  }
}

export class Console {
  /** The query log: the most recent queries in memory, with counts of what was recorded, handed to the sink and evicted. */
  readonly queries: BoundedLog<QueryLog>;
  private readonly cols: readonly Collection[];
  private readonly data: (name: string) => readonly Readonly<Record<string, unknown>>[];
  private readonly now: () => Date;
  constructor(cols: readonly Collection[], data: (name: string) => readonly Readonly<Record<string, unknown>>[], now: () => Date = () => new Date(), log: LogOptions<QueryLog> = {}) {
    this.cols = cols;
    this.data = data;
    this.now = now;
    this.queries = new BoundedLog(log);
  }
  /** The most recent queries, oldest first. */
  get log(): readonly QueryLog[] {
    return this.queries.entries;
  }
  run(who: string, query: string, o: { seeSensitive?: boolean } = {}): { rows: Record<string, unknown>[]; capped: boolean; masked: string[] } {
    const at = this.now().toISOString();
    try {
      const p = parse(query);
      const c = checkPlan(p, this.cols);
      if (!o.seeSensitive) {
        for (const w of p.where) if (c.fields[w.field]!.sensitive) throw new QueryError(`you cannot filter on ${w.field}`);
        if (p.order && c.fields[p.order.field]!.sensitive) throw new QueryError(`you cannot sort on ${p.order.field}`);
      }
      let rows = this.data(p.from).filter((r) => p.where.every((w) => test(r[w.field], w)));
      if (p.order) {
        const f = p.order.field;
        const s = p.order.desc ? -1 : 1;
        rows = [...rows].sort((a, b) => ((a[f] as number) < (b[f] as number) ? -s : (a[f] as number) > (b[f] as number) ? s : 0));
      }
      const capped = rows.length > p.limit;
      const fields = p.select ?? Object.keys(c.fields);
      const masked = o.seeSensitive ? [] : fields.filter((f) => c.fields[f]!.sensitive);
      const out = rows.slice(0, p.limit).map((r) => Object.fromEntries(fields.map((f) => [f, masked.includes(f) ? '•••' : r[f]])));
      this.queries.push({ at, who, query, rows: out.length });
      return { rows: out, capped, masked };
    } catch (e) {
      this.queries.push({ at, who, query, rows: 0, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
}
