/**
 * Row-level change capture as an ordered feed that subscribers can follow, filter, fall behind on and resume.
 *
 * - Change records: `insert`, `update` and `delete` of a row, with the key, the row before and after (an update also
 *   lists which columns changed; an update that changes nothing is not a change and is not recorded), the
 *   transaction it belonged to and a sequence number. Sequence numbers are gapless and increase in commit order.
 *   Changes made in a transaction (`feed.transaction`) appear together and only on commit; a rollback leaves no trace.
 * - Retention: the feed keeps the last N records. Older ones are gone, and a subscriber that asks for them is told so.
 * - Resume tokens: a token names the feed's epoch and a sequence number, signed so it cannot be forged or edited.
 *   Resuming replays what the subscriber has not seen, in order, without gaps; if the records are no longer kept
 *   (or the token comes from before a restart, a different epoch) the subscriber is told to take a fresh snapshot,
 *   never silently handed a feed with a hole in it.
 * - Filter predicates: by table, by operation, by conditions on column values (eq, neq, in, gt, gte, lt, lte,
 *   isNull, notNull), by which columns changed, with a `parseFilter` for the text form `status=eq.open`, and by a
 *   per-subscriber permission check and hidden columns, so a subscriber never sees a row or a column it may not.
 * - Delivery with backpressure: each subscription has a bounded buffer that the consumer drains. When it fills,
 *   the subscription either replaces what it had to drop with one gap marker (counting what was lost and giving the
 *   token to resume from) or ends with the reason "slow"; the feed itself never waits for a consumer.
 *
 * `coalesce` folds a run of records to the net change per row for a consumer that wants state, not history, and
 * `toCloudEvent` gives a record in the form of the events block. Out of scope: reading a database's write-ahead log
 * (the caller reports changes to `capture`), and persistence of the feed across restarts.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CloudEvent } from '../events/index.ts';

export class FeedError extends Error {}
export class ResumeError extends Error {
  readonly reason: 'invalid' | 'expired' | 'epoch' | 'ahead';
  constructor(reason: ResumeError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export type Row = Readonly<Record<string, unknown>>;
export type Op = 'insert' | 'update' | 'delete';
export interface Change {
  readonly seq: number;
  readonly table: string;
  readonly op: Op;
  readonly key: string;
  readonly before: Row | null;
  readonly after: Row | null;
  /** For an update, the columns whose value changed (sorted). */
  readonly changed: readonly string[];
  readonly tx: string | null;
  readonly time: number;
}
export interface Gap {
  readonly gap: true;
  readonly count: number;
  /** The sequence numbers lost, inclusive. */
  readonly from: number;
  readonly to: number;
  /** Resume from here to get the lost records, if they are still kept. */
  readonly resume: string;
}
export type Item = Change | Gap;
export const isGap = (i: Item): i is Gap => 'gap' in i;

const same = (a: unknown, b: unknown, depth = 0): boolean => {
  if (Object.is(a, b)) return true;
  if (depth > 20 || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1));
};
const freeze = (r: Row | null): Row | null => (r === null ? null : Object.freeze({ ...r }));

// -------------------------------------------------------------------------------------------------------------
// Filters

export type Cmp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull' | 'notNull';
export interface Condition {
  readonly column: string;
  readonly cmp: Cmp;
  readonly value?: unknown;
}
export interface Filter {
  readonly tables?: readonly string[];
  readonly ops?: readonly Op[];
  /** Conditions on the row after the change (before, for a delete); all must hold. */
  readonly where?: readonly Condition[];
  /** An update must have changed at least one of these columns. */
  readonly changedAny?: readonly string[];
}

const CMPS = new Set<Cmp>(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'isNull', 'notNull']);

function test(c: Condition, row: Row | null): boolean {
  const v = row === null ? undefined : row[c.column];
  switch (c.cmp) {
    case 'eq':
      return same(v, c.value) || (v !== undefined && v !== null && typeof c.value === 'string' && String(v) === c.value);
    case 'neq':
      return !test({ ...c, cmp: 'eq' }, row);
    case 'in':
      return Array.isArray(c.value) && c.value.some((x) => test({ column: c.column, cmp: 'eq', value: x }, row));
    case 'isNull':
      return v === null || v === undefined;
    case 'notNull':
      return v !== null && v !== undefined;
    default: {
      if (v === null || v === undefined) return false;
      const a = typeof v === 'string' && typeof c.value === 'number' ? Number(v) : v;
      const b = c.value;
      if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
        return c.cmp === 'gt' ? a > b : c.cmp === 'gte' ? a >= b : c.cmp === 'lt' ? a < b : a <= b;
      }
      return false;
    }
  }
}

/** Checks a filter and returns a predicate over changes. Throws FeedError for a filter that makes no sense. */
export function compileFilter(f: Filter): (c: Change) => boolean {
  const where = f.where ?? [];
  if (where.length > 20) throw new FeedError('at most 20 conditions');
  for (const w of where) {
    if (typeof w.column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(w.column)) throw new FeedError(`${JSON.stringify(String(w.column).slice(0, 30))} is not a column name`);
    if (!CMPS.has(w.cmp)) throw new FeedError(`unknown comparison ${JSON.stringify(String(w.cmp).slice(0, 12))}`);
    if (w.cmp === 'in' && (!Array.isArray(w.value) || w.value.length === 0 || w.value.length > 100)) throw new FeedError('in needs a list of 1 to 100 values');
  }
  for (const o of f.ops ?? []) if (o !== 'insert' && o !== 'update' && o !== 'delete') throw new FeedError(`unknown operation ${JSON.stringify(String(o).slice(0, 12))}`);
  const tables = f.tables ? new Set(f.tables) : undefined;
  const ops = f.ops ? new Set(f.ops) : undefined;
  const cols = f.changedAny ? new Set(f.changedAny) : undefined;
  return (c) => {
    if (tables && !tables.has(c.table)) return false;
    if (ops && !ops.has(c.op)) return false;
    if (cols && (c.op !== 'update' || !c.changed.some((x) => cols.has(x)))) return false;
    const row = c.op === 'delete' ? c.before : c.after;
    return where.every((w) => test(w, row));
  };
}

/** The text form: `status=eq.open`, `id=in.(1,2,3)`, `deleted_at=is.null`, `age=gte.18`; several joined with `&`. */
export function parseFilter(text: string): Condition[] {
  if (text.length > 1000) throw new FeedError('the filter is too long');
  return text
    .split('&')
    .filter((p) => p !== '')
    .map((part) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]{0,62})=(eq|neq|gt|gte|lt|lte|in|is|not\.is)\.(.*)$/.exec(part);
      if (!m) throw new FeedError(`cannot read the condition ${JSON.stringify(part.slice(0, 40))}`);
      const [, column, cmp, raw] = m as unknown as [string, string, string, string];
      const lit = (s: string): unknown => (/^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s);
      if (cmp === 'is' || cmp === 'not.is') {
        if (raw !== 'null') throw new FeedError('is and not.is only compare with null');
        return { column, cmp: cmp === 'is' ? 'isNull' : 'notNull' } as Condition;
      }
      if (cmp === 'in') {
        const l = /^\((.*)\)$/.exec(raw);
        if (!l) throw new FeedError('in takes a list like in.(1,2,3)');
        return { column, cmp: 'in', value: l[1]!.split(',').map((s) => lit(s.trim())) };
      }
      return { column, cmp: cmp as Cmp, value: lit(raw) };
    });
}

// -------------------------------------------------------------------------------------------------------------
// The feed

export interface FeedOptions {
  /** Secret that signs resume tokens. Required: a token must not be forgeable. */
  readonly signingKey: Uint8Array | string;
  readonly retain?: number;
  readonly now?: () => number;
  /** Names this run of the feed; a token from another epoch cannot be resumed. Default: random. */
  readonly epoch?: string;
}

export interface SubscribeOptions {
  readonly filter?: Filter;
  /** Decides whether this subscriber may see a change at all. */
  readonly canSee?: (c: Change) => boolean;
  /** Columns removed from before and after for this subscriber (also removed from `changed`). */
  readonly hide?: readonly string[];
  readonly buffer?: number;
  readonly onFull?: 'gap' | 'close';
  /** Resume after this token. */
  readonly from?: string;
  /** Called when something is waiting; do not do work in it, schedule a drain. */
  readonly onReady?: () => void;
}

export class Subscription {
  private items: Item[] = [];
  private closed: string | undefined;
  private lastSeq: number;
  private pendingGap: { from: number; to: number; count: number } | undefined;
  readonly id: number;
  private readonly feed: ChangeFeed;
  private readonly o: Required<Pick<SubscribeOptions, 'buffer' | 'onFull'>> & SubscribeOptions;
  private readonly match: (c: Change) => boolean;
  constructor(feed: ChangeFeed, id: number, o: SubscribeOptions, start: number) {
    this.feed = feed;
    this.id = id;
    this.o = { ...o, buffer: o.buffer ?? 100, onFull: o.onFull ?? 'gap' };
    if (!Number.isInteger(this.o.buffer) || this.o.buffer < 1 || this.o.buffer > 100_000) throw new FeedError('buffer is 1 to 100000');
    this.match = compileFilter(o.filter ?? {});
    this.lastSeq = start;
  }

  /** @internal Called by the feed with each new change in order. */
  offer(c: Change): void {
    if (this.closed) return;
    if (!this.match(c) || (this.o.canSee && !this.o.canSee(c))) {
      return void (this.lastSeq = c.seq, this.skipped = c.seq);
    }
    const mine = this.view(c);
    if (this.items.length >= this.o.buffer) {
      if (this.o.onFull === 'close') {
        this.closed = 'slow';
        this.items = [];
        return;
      }
      // Replace the oldest change with (or extend) one gap marker.
      const first = this.items.findIndex((i) => !isGap(i));
      const old = first >= 0 ? (this.items.splice(first, 1)[0] as Change) : undefined;
      if (old) this.pendingGap = this.pendingGap ? { from: Math.min(this.pendingGap.from, old.seq), to: Math.max(this.pendingGap.to, old.seq), count: this.pendingGap.count + 1 } : { from: old.seq, to: old.seq, count: 1 };
      this.rebuildGap();
    }
    this.items.push(mine);
    this.lastSeq = c.seq;
    this.o.onReady?.();
  }
  /** Highest sequence number the feed has shown this subscription, matching or not. */
  skipped = 0;

  private rebuildGap(): void {
    this.items = this.items.filter((i) => !isGap(i));
    if (this.pendingGap) this.items.unshift({ gap: true, count: this.pendingGap.count, from: this.pendingGap.from, to: this.pendingGap.to, resume: this.feed.tokenFor(this.pendingGap.from - 1) });
  }

  private view(c: Change): Change {
    const hide = this.o.hide;
    if (!hide?.length) return c;
    const strip = (r: Row | null) => (r === null ? null : (Object.freeze(Object.fromEntries(Object.entries(r).filter(([k]) => !hide.includes(k)))) as Row));
    return { ...c, before: strip(c.before), after: strip(c.after), changed: c.changed.filter((k) => !hide.includes(k)) };
  }

  /** Up to `max` waiting items, oldest first. A gap marker comes before the changes that follow it. */
  poll(max = 100): Item[] {
    const out = this.items.splice(0, max);
    if (out.some(isGap)) this.pendingGap = undefined;
    return out;
  }
  get waiting(): number {
    return this.items.length;
  }
  /** Why the subscription ended ("slow", "closed"), or undefined while open. */
  get endedBecause(): string | undefined {
    return this.closed;
  }
  /** A token to resume after the last change this subscription has been shown, delivered or not yet drained. */
  token(): string {
    const lastDelivered = this.items.length ? (isGap(this.items[0]!) ? (this.items[0] as Gap).from - 1 : (this.items[0] as Change).seq - 1) : this.lastSeq;
    return this.feed.tokenFor(lastDelivered);
  }
  close(): void {
    this.closed ??= 'closed';
    this.feed.drop(this);
  }
}

interface Pending {
  readonly table: string;
  readonly op: Op;
  readonly key: string;
  readonly before: Row | null;
  readonly after: Row | null;
}

export class ChangeFeed {
  private log: Change[] = [];
  private seq = 0;
  private txCounter = 0;
  private nextSub = 1;
  private readonly subs = new Set<Subscription>();
  private readonly key: Buffer;
  private readonly retain: number;
  private readonly now: () => number;
  readonly epoch: string;
  constructor(o: FeedOptions) {
    const k = typeof o.signingKey === 'string' ? Buffer.from(o.signingKey) : Buffer.from(o.signingKey);
    if (k.length < 16) throw new FeedError('the signing key must be at least 16 bytes');
    this.key = k;
    this.retain = o.retain ?? 10_000;
    if (!Number.isInteger(this.retain) || this.retain < 1) throw new FeedError('retain is at least 1');
    this.now = o.now ?? Date.now;
    this.epoch = o.epoch ?? randomBytes(6).toString('hex');
    if (!/^[A-Za-z0-9]{1,32}$/.test(this.epoch)) throw new FeedError('the epoch is letters and digits');
  }

  get head(): number {
    return this.seq;
  }
  get oldest(): number {
    return this.log[0]?.seq ?? this.seq + 1;
  }

  private build(p: Pending, tx: string | null, time: number): Change | undefined {
    if (typeof p.table !== 'string' || p.table === '' || typeof p.key !== 'string' || p.key === '') throw new FeedError('a change needs a table and a key');
    if (p.op === 'insert' && (p.before || !p.after)) throw new FeedError('an insert has an after row and no before row');
    if (p.op === 'delete' && (!p.before || p.after)) throw new FeedError('a delete has a before row and no after row');
    if (p.op === 'update' && (!p.before || !p.after)) throw new FeedError('an update has a before and an after row');
    if (p.op !== 'insert' && p.op !== 'update' && p.op !== 'delete') throw new FeedError('unknown operation');
    let changed: string[] = [];
    if (p.op === 'update') {
      const cols = new Set([...Object.keys(p.before!), ...Object.keys(p.after!)]);
      changed = [...cols].filter((c) => !same(p.before![c], p.after![c])).sort();
      if (!changed.length) return undefined;
    }
    return { seq: 0, table: p.table, op: p.op, key: p.key, before: freeze(p.before), after: freeze(p.after), changed, tx, time };
  }

  private publish(list: Change[]): Change[] {
    const out = list.map((c) => Object.freeze({ ...c, seq: ++this.seq }) as Change);
    this.log.push(...out);
    if (this.log.length > this.retain) this.log.splice(0, this.log.length - this.retain);
    for (const c of out) for (const s of [...this.subs]) s.offer(c);
    return out;
  }

  /** Records one change on its own. Returns undefined for an update that changed nothing. */
  capture(table: string, op: Op, key: string, before: Row | null, after: Row | null): Change | undefined {
    const c = this.build({ table, op, key, before, after }, null, this.now());
    return c ? this.publish([c])[0] : undefined;
  }

  /** Changes made inside `fn` appear together, in order, when it returns; if it throws, none do. */
  async transaction<T>(fn: (tx: { capture: (table: string, op: Op, key: string, before: Row | null, after: Row | null) => void }) => Promise<T> | T): Promise<T> {
    const id = `tx${++this.txCounter}`;
    const time = this.now();
    const pending: Change[] = [];
    const result = await fn({
      capture: (table, op, key, before, after) => {
        const c = this.build({ table, op, key, before, after }, id, time);
        if (c) pending.push(c);
      },
    });
    if (pending.length) this.publish(pending);
    return result;
  }

  tokenFor(seq: number): string {
    if (!Number.isInteger(seq) || seq < 0) throw new FeedError('a token is for a sequence number of 0 or more');
    const body = `${this.epoch}.${seq}`;
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url').slice(0, 22)}`;
  }

  /** The sequence number after which to replay, or a ResumeError saying why that cannot be done. */
  readToken(token: string): number {
    const m = /^([A-Za-z0-9]{1,32})\.(\d{1,15})\.([A-Za-z0-9_-]{22})$/.exec(token);
    if (!m) throw new ResumeError('invalid', 'that is not a resume token');
    const want = createHmac('sha256', this.key).update(`${m[1]}.${m[2]}`).digest('base64url').slice(0, 22);
    const a = Buffer.from(m[3]!);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ResumeError('invalid', 'that resume token was not issued by this feed');
    if (m[1] !== this.epoch) throw new ResumeError('epoch', 'the feed has restarted since that token; take a fresh snapshot');
    const seq = Number(m[2]);
    if (seq > this.seq) throw new ResumeError('ahead', 'that token is ahead of the feed');
    if (seq + 1 < this.oldest && seq < this.seq) throw new ResumeError('expired', `records from ${seq + 1} are no longer kept (oldest is ${this.oldest}); take a fresh snapshot`);
    return seq;
  }

  /** Follows the feed, first replaying from `from` if given. */
  subscribe(o: SubscribeOptions = {}): Subscription {
    const start = o.from === undefined ? this.seq : this.readToken(o.from);
    const sub = new Subscription(this, this.nextSub++, o, start);
    for (const c of this.log) if (c.seq > start) sub.offer(c);
    this.subs.add(sub);
    return sub;
  }
  drop(s: Subscription): void {
    this.subs.delete(s);
  }
  get subscribers(): number {
    for (const s of [...this.subs]) if (s.endedBecause) this.subs.delete(s);
    return this.subs.size;
  }

  /** The kept records after `seq` that match, without subscribing. */
  since(seq: number, filter: Filter = {}, limit = 1000): Change[] {
    const m = compileFilter(filter);
    return this.log.filter((c) => c.seq > seq && m(c)).slice(0, limit);
  }
}

/** The net change per row: insert then update is an insert, insert then delete is nothing, updates fold to one. */
export function coalesce(list: readonly Change[]): Change[] {
  const byRow = new Map<string, Change>();
  const order: string[] = [];
  for (const c of list) {
    const k = `${c.table}\u0000${c.key}`;
    const prev = byRow.get(k);
    if (!prev) {
      byRow.set(k, c);
      order.push(k);
      continue;
    }
    let next: Change | undefined;
    if (prev.op === 'insert' && c.op === 'delete') next = undefined;
    else if (prev.op === 'insert') next = { ...c, op: 'insert', before: null, changed: [] };
    else if (prev.op === 'delete') next = { ...c, op: 'update', before: prev.before, changed: [...new Set([...Object.keys(prev.before ?? {}), ...Object.keys(c.after ?? {})])].filter((x) => !same(prev.before?.[x], c.after?.[x])).sort() };
    else if (c.op === 'delete') next = { ...c, before: prev.before };
    else next = { ...c, before: prev.before, changed: [...new Set([...Object.keys(prev.before ?? {}), ...Object.keys(c.after ?? {})])].filter((x) => !same(prev.before?.[x], c.after?.[x])).sort() };
    if (next && next.op === 'update' && next.changed.length === 0) next = undefined;
    if (next) byRow.set(k, next);
    else byRow.delete(k);
  }
  return order.filter((k) => byRow.has(k)).map((k) => byRow.get(k)!);
}

/** A change as a CloudEvent: type `<table>.<op>d` style names (row.inserted), subject `<table>/<key>`. */
export function toCloudEvent(c: Change, source: string, dataschema = 'urn:change-feed:v1'): CloudEvent {
  return {
    specversion: '1.0',
    id: `${c.seq}`,
    source,
    type: `row.${c.op === 'insert' ? 'inserted' : c.op === 'update' ? 'updated' : 'deleted'}`,
    time: new Date(c.time).toISOString(),
    subject: `${c.table}/${c.key}`,
    datacontenttype: 'application/json',
    dataschema,
    data: { table: c.table, key: c.key, op: c.op, before: c.before, after: c.after, changed: c.changed, tx: c.tx },
  };
}
