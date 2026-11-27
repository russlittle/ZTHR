/**
 * A query console that cannot hurt anything. Queries are written in a small read-only language
 * (`from files where size > 1000 and owner = "ana" order by size desc limit 20 select name, size`), parsed into a
 * plan that is checked against the declared collections and fields before it runs: no writes exist in the
 * language, unknown fields are refused by name, results are capped, sensitive fields are masked unless the person
 * may see them, and every query is recorded with who ran it and how many rows came back.
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
  const value = (x: string): string | number | boolean => (x.startsWith('"') ? (JSON.parse(x) as string) : /^-?\d/.test(x) ? Number(x) : x === 'true' ? true : x === 'false' ? false : (() => { throw new QueryError(`${x} is not a value; quote text like "this"`); })());
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
  for (const f of [...p.where.map((w) => w.field), ...(p.order ? [p.order.field] : []), ...(p.select ?? [])]) if (!c.fields[f]) throw new QueryError(`${p.from} has no field ${f}`);
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

export class Console {
  readonly log: { at: string; who: string; query: string; rows: number; error?: string }[] = [];
  private readonly cols: readonly Collection[];
  private readonly data: (name: string) => readonly Readonly<Record<string, unknown>>[];
  private readonly now: () => Date;
  constructor(cols: readonly Collection[], data: (name: string) => readonly Readonly<Record<string, unknown>>[], now: () => Date = () => new Date()) {
    this.cols = cols;
    this.data = data;
    this.now = now;
  }
  run(who: string, query: string, o: { seeSensitive?: boolean } = {}): { rows: Record<string, unknown>[]; capped: boolean; masked: string[] } {
    const at = this.now().toISOString();
    try {
      const p = parse(query);
      const c = checkPlan(p, this.cols);
      if (!o.seeSensitive) for (const w of p.where) if (c.fields[w.field]!.sensitive) throw new QueryError(`you cannot filter on ${w.field}`);
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
      this.log.push({ at, who, query, rows: out.length });
      return { rows: out, capped, masked };
    } catch (e) {
      this.log.push({ at, who, query, rows: 0, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
}
