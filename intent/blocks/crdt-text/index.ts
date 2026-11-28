/**
 * A sequence CRDT for shared text. Every character is an item with a stable id (client, clock); an insert names the
 * item to its left and right at the time it was made, and the YATA integration rule (the one Yjs uses) places
 * concurrent inserts the same way on every replica, so replicas that have seen the same updates, in any order, hold
 * the same text. A delete keeps the item as a tombstone, because a concurrent insert may still name it as a
 * neighbour. Characters are Unicode code points; indexes in this API count code points, never UTF-16 units, so an
 * astral character is never split.
 *
 * Sync: a state vector says, per client, how many operations a replica has; `encodeUpdate(sv)` is everything the
 * other side lacks, as a compact binary (varints; consecutive characters typed by one client travel as one run),
 * and `applyUpdate` is idempotent and order-free: an update that arrives before the ones it depends on is held
 * pending and integrated when they arrive. Cursors are relative positions anchored to a character id, so they stay
 * with the text when others type or delete around them.
 *
 * GC rules: deleted characters lose their content at once (`gc()` frees it, and updates never carry it), but the
 * tombstone (id and neighbours) is kept for good, since any peer's later insert may still name it; dropping
 * tombstones needs every peer to agree on a new baseline, which is a decision for the service holding the
 * document, not for this structure. Hostile input is refused: truncated or oversized updates, runs longer than the
 * cap, text that does not match its declared length, and more pending structures than the cap.
 *
 * Out of scope: rich text attributes, moves of ranges, subdocuments, and undo history.
 */

export class Refused extends Error {
  constructor(why: string) {
    super(`update refused: ${why}`);
  }
}

export interface Id {
  readonly client: number;
  readonly clock: number;
}

interface Item {
  readonly client: number;
  readonly clock: number;
  ch: string;
  deleted: boolean;
  readonly origin: Id | null;
  readonly rightOrigin: Id | null;
  left: Item | null;
  right: Item | null;
}

/** A run of items from one client with consecutive clocks, as carried in an update. */
interface Run {
  client: number;
  clock: number;
  len: number;
  origin: Id | null;
  rightOrigin: Id | null;
  /** The code points, or null when the run is deleted (no content travels). */
  text: string[] | null;
}

export type StateVector = Map<number, number>;
export type DeleteSet = Map<number, [number, number][]>;

const sameId = (a: Id | null, b: Id | null) => (a === null ? b === null : b !== null && a.client === b.client && a.clock === b.clock);

// --- binary encoding ------------------------------------------------------------------------------------------

class Writer {
  private b: number[] = [];
  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('not a non-negative safe integer');
    while (n > 127) {
      this.b.push(128 | (n % 128));
      n = Math.floor(n / 128);
    }
    this.b.push(n);
  }
  byte(n: number): void {
    this.b.push(n);
  }
  str(s: string): void {
    const u = Buffer.from(s, 'utf8');
    this.uint(u.length);
    for (const x of u) this.b.push(x);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.b);
  }
}

class Reader {
  private i = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  get done() {
    return this.i >= this.b.length;
  }
  uint(): number {
    let n = 0;
    let mul = 1;
    for (let k = 0; k < 9; k++) {
      if (this.i >= this.b.length) throw new Refused('it ends in the middle of a number');
      const x = this.b[this.i++]!;
      n += (x & 127) * mul;
      if (x < 128) {
        if (!Number.isSafeInteger(n)) throw new Refused('a number is too large');
        return n;
      }
      mul *= 128;
    }
    throw new Refused('a number is too long');
  }
  byte(): number {
    if (this.i >= this.b.length) throw new Refused('it ends unexpectedly');
    return this.b[this.i++]!;
  }
  str(max: number): string {
    const n = this.uint();
    if (n > max) throw new Refused('a text is longer than the limit');
    if (this.i + n > this.b.length) throw new Refused('it ends in the middle of a text');
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(s);
    } catch {
      throw new Refused('a text is not valid UTF-8');
    }
  }
}

export interface DocOptions {
  /** Called with each local change, as an update to send to peers. */
  readonly onUpdate?: (update: Uint8Array) => void;
  /** Longest run accepted in an update (default 1,048,576). */
  readonly maxRun?: number;
  /** Most items the document may hold (default 5,000,000). */
  readonly maxItems?: number;
  /** Most pending (not yet integrable) items held (default 1,000,000). */
  readonly maxPending?: number;
  /** Largest update accepted, in bytes (default 32 MiB). */
  readonly maxUpdateBytes?: number;
}

export interface RelativePosition {
  /** The character the cursor is anchored to; null means the end of the text. */
  readonly id: Id | null;
  /** 0: just before that character; 1: just after it. */
  readonly assoc: 0 | 1;
}

export class Doc {
  readonly clientId: number;
  private start: Item | null = null;
  private readonly byClient = new Map<number, Item[]>();
  private count = 0;
  private pending: Run[] = [];
  private pendingCount = 0;
  private pendingDeletes: DeleteSet = new Map();
  private readonly o: DocOptions;

  constructor(clientId: number, o: DocOptions = {}) {
    if (!Number.isSafeInteger(clientId) || clientId < 0) throw new RangeError('clientId must be a non-negative integer');
    this.clientId = clientId;
    this.o = o;
  }

  // --- reading ---

  /** The text as it reads now. */
  toString(): string {
    let s = '';
    for (let it = this.start; it; it = it.right) if (!it.deleted) s += it.ch;
    return s;
  }

  /** Length in code points. */
  get length(): number {
    let n = 0;
    for (let it = this.start; it; it = it.right) if (!it.deleted) n++;
    return n;
  }

  /** Items held, tombstones included. */
  get itemCount(): number {
    return this.count;
  }

  get pendingItems(): number {
    return this.pendingCount;
  }

  stateVector(): StateVector {
    const sv: StateVector = new Map();
    for (const [c, items] of this.byClient) sv.set(c, items.length);
    return sv;
  }

  private get(id: Id): Item | undefined {
    return this.byClient.get(id.client)?.[id.clock];
  }

  // --- local edits ---

  /** Inserts text at a code point index (0..length). */
  insert(index: number, text: string): void {
    const chars = [...text];
    if (chars.length === 0) return;
    if (!Number.isInteger(index) || index < 0) throw new RangeError('index must be a non-negative integer');
    let left: Item | null = null;
    if (index > 0) {
      let seen = 0;
      for (let it = this.start; it; it = it.right) {
        if (it.deleted) continue;
        left = it;
        if (++seen === index) break;
      }
      if (seen < index) throw new RangeError(`index ${index} is past the end (${seen})`);
    }
    const before = this.stateVector();
    const rightItem = left ? left.right : this.start;
    const clock0 = this.byClient.get(this.clientId)?.length ?? 0;
    this.guardCount(chars.length);
    let prev: Item | null = left;
    const rightOrigin = rightItem ? { client: rightItem.client, clock: rightItem.clock } : null;
    chars.forEach((ch, i) => {
      const it: Item = { client: this.clientId, clock: clock0 + i, ch, deleted: false, origin: prev ? { client: prev.client, clock: prev.clock } : null, rightOrigin, left: prev, right: rightItem };
      if (prev) prev.right = it;
      else this.start = it;
      if (rightItem) rightItem.left = it;
      this.store(it);
      prev = it;
    });
    this.emit(before, new Map());
  }

  /** Deletes `length` characters from a code point index. Characters already deleted are not counted. */
  delete(index: number, length: number): void {
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(length) || length < 0) throw new RangeError('index and length must be non-negative integers');
    if (length === 0) return;
    let seen = 0;
    const del: DeleteSet = new Map();
    let n = 0;
    for (let it = this.start; it && n < length; it = it.right) {
      if (it.deleted) continue;
      if (seen++ < index) continue;
      it.deleted = true;
      addRange(del, it.client, it.clock, 1);
      n++;
    }
    if (n < length) throw new RangeError('the range is past the end of the text');
    this.emit(this.stateVector(), del);
  }

  /** Frees the content of deleted characters. Their tombstones stay (see the GC rules above). Returns how many were freed. */
  gc(): number {
    let n = 0;
    for (let it = this.start; it; it = it.right)
      if (it.deleted && it.ch !== '') {
        it.ch = '';
        n++;
      }
    return n;
  }

  private emit(before: StateVector, del: DeleteSet): void {
    if (this.o.onUpdate) this.o.onUpdate(this.encode(before, del));
  }

  private store(it: Item): void {
    let a = this.byClient.get(it.client);
    if (!a) this.byClient.set(it.client, (a = []));
    a.push(it);
    this.count++;
  }

  private guardCount(add: number): void {
    if (this.count + add > (this.o.maxItems ?? 5_000_000)) throw new Refused('the document would hold too many items');
  }

  // --- encoding ---

  /** The delete set: every deleted character, as merged ranges per client. */
  deleteSet(): DeleteSet {
    const ds: DeleteSet = new Map();
    for (const [c, items] of this.byClient) for (const it of items) if (it.deleted) addRange(ds, c, it.clock, 1);
    return ds;
  }

  /** Everything the holder of `sv` lacks: operations from their clocks on, and all deletes. Omit `sv` for the whole document. */
  encodeUpdate(sv: StateVector = new Map()): Uint8Array {
    return this.encode(sv, this.deleteSet());
  }

  private encode(sv: StateVector, del: DeleteSet): Uint8Array {
    const w = new Writer();
    const clients = [...this.byClient.entries()].filter(([c, items]) => items.length > (sv.get(c) ?? 0)).sort((a, b) => b[0] - a[0]);
    w.uint(clients.length);
    for (const [c, items] of clients) {
      const from = sv.get(c) ?? 0;
      const runs: Run[] = [];
      for (let k = from; k < items.length; k++) {
        const it = items[k]!;
        const r = runs[runs.length - 1];
        if (r && (r.text === null) === it.deleted && sameId(it.origin, { client: c, clock: it.clock - 1 }) && sameId(it.rightOrigin, r.rightOrigin) && r.clock + r.len === it.clock) {
          r.len++;
          r.text?.push(it.ch);
        } else runs.push({ client: c, clock: it.clock, len: 1, origin: it.origin, rightOrigin: it.rightOrigin, text: it.deleted ? null : [it.ch] });
      }
      w.uint(c);
      w.uint(runs.length);
      for (const r of runs) {
        w.uint(r.clock);
        w.uint(r.len);
        w.byte((r.origin ? 1 : 0) | (r.rightOrigin ? 2 : 0) | (r.text === null ? 4 : 0));
        if (r.origin) (w.uint(r.origin.client), w.uint(r.origin.clock));
        if (r.rightOrigin) (w.uint(r.rightOrigin.client), w.uint(r.rightOrigin.clock));
        if (r.text !== null) w.str(r.text.join(''));
      }
    }
    const dc = [...del.entries()].sort((a, b) => b[0] - a[0]);
    w.uint(dc.length);
    for (const [c, ranges] of dc) {
      w.uint(c);
      w.uint(ranges.length);
      for (const [clock, len] of ranges) (w.uint(clock), w.uint(len));
    }
    return w.bytes();
  }

  // --- applying ---

  /** Integrates an update from a peer. Safe to repeat, and safe in any order. Throws Refused for a damaged or hostile update. */
  applyUpdate(update: Uint8Array): void {
    if (update.length > (this.o.maxUpdateBytes ?? 32 * 1024 * 1024)) throw new Refused('it is larger than the limit');
    const r = new Reader(update);
    const maxRun = this.o.maxRun ?? 1_048_576;
    const runs: Run[] = [];
    const nClients = r.uint();
    if (nClients > update.length) throw new Refused('more clients than bytes');
    for (let i = 0; i < nClients; i++) {
      const client = r.uint();
      const nRuns = r.uint();
      if (nRuns > update.length) throw new Refused('more runs than bytes');
      let expect = -1;
      for (let j = 0; j < nRuns; j++) {
        const clock = r.uint();
        const len = r.uint();
        if (len < 1 || len > maxRun) throw new Refused(`a run of ${len} items is outside 1..${maxRun}`);
        if (expect >= 0 && clock < expect) throw new Refused('runs overlap or are out of order');
        expect = clock + len;
        const flags = r.byte();
        if (flags > 7) throw new Refused('unknown run flags');
        const origin = flags & 1 ? { client: r.uint(), clock: r.uint() } : null;
        const rightOrigin = flags & 2 ? { client: r.uint(), clock: r.uint() } : null;
        let text: string[] | null = null;
        if (!(flags & 4)) {
          text = [...r.str(maxRun * 4)];
          if (text.length !== len) throw new Refused('a run\'s text is not its declared length');
        }
        runs.push({ client, clock, len, origin, rightOrigin, text });
      }
    }
    const del: DeleteSet = new Map();
    const nDel = r.uint();
    if (nDel > update.length) throw new Refused('more delete clients than bytes');
    for (let i = 0; i < nDel; i++) {
      const c = r.uint();
      const n = r.uint();
      if (n > update.length) throw new Refused('more delete ranges than bytes');
      for (let j = 0; j < n; j++) {
        const clock = r.uint();
        const len = r.uint();
        if (len < 1) throw new Refused('an empty delete range');
        addRange(del, c, clock, len);
      }
    }
    if (!r.done) throw new Refused('there are bytes after the end');
    for (const run of runs) this.pending.push(run);
    for (const [c, rs] of del) for (const [clock, len] of rs) addRange(this.pendingDeletes, c, clock, len);
    this.drain();
    if (this.pendingCount > (this.o.maxPending ?? 1_000_000)) {
      this.pending = [];
      this.pendingCount = 0;
      throw new Refused('too many operations are waiting for ones that have not arrived');
    }
  }

  private drain(): void {
    for (let progress = true; progress; ) {
      progress = false;
      const next: Run[] = [];
      for (const run of this.pending) {
        let k = Math.max(0, (this.byClient.get(run.client)?.length ?? 0) - run.clock);
        if (k > 0) progress = true; // part or all of it was already here
        for (; k < run.len; k++) {
          const clock = run.clock + k;
          if (clock !== (this.byClient.get(run.client)?.length ?? 0)) break;
          const origin = k === 0 ? run.origin : { client: run.client, clock: clock - 1 };
          if ((origin && !this.get(origin)) || (run.rightOrigin && !this.get(run.rightOrigin))) break;
          this.guardCount(1);
          this.integrate({ client: run.client, clock, ch: run.text ? run.text[k]! : '', deleted: run.text === null, origin, rightOrigin: run.rightOrigin, left: null, right: null });
          progress = true;
        }
        if (k < run.len) {
          const from = k;
          next.push({ ...run, clock: run.clock + from, len: run.len - from, origin: from === 0 ? run.origin : { client: run.client, clock: run.clock + from - 1 }, text: run.text ? run.text.slice(from) : null });
        }
      }
      this.pending = next;
    }
    this.pendingCount = this.pending.reduce((n, r) => n + r.len, 0);
    this.applyPendingDeletes();
  }

  private applyPendingDeletes(): void {
    for (const [c, ranges] of this.pendingDeletes) {
      const items = this.byClient.get(c);
      const keep: [number, number][] = [];
      for (const [clock, len] of ranges) {
        const have = items?.length ?? 0;
        const upto = Math.min(clock + len, have);
        for (let k = clock; k < upto; k++) items![k]!.deleted = true;
        if (clock + len > have) keep.push([Math.max(clock, have), clock + len - Math.max(clock, have)]);
      }
      if (keep.length) this.pendingDeletes.set(c, keep);
      else this.pendingDeletes.delete(c);
    }
  }

  private integrate(item: Item): void {
    let left = item.origin ? this.get(item.origin)! : null;
    const right = item.rightOrigin ? this.get(item.rightOrigin)! : null;
    let o = left ? left.right : this.start;
    const conflicting = new Set<Item>();
    const before = new Set<Item>();
    while (o && o !== right) {
      before.add(o);
      conflicting.add(o);
      if (sameId(item.origin, o.origin)) {
        if (o.client < item.client) {
          left = o;
          conflicting.clear();
        } else if (sameId(item.rightOrigin, o.rightOrigin)) break;
      } else if (o.origin && before.has(this.get(o.origin)!)) {
        if (!conflicting.has(this.get(o.origin)!)) {
          left = o;
          conflicting.clear();
        }
      } else break;
      o = o.right;
    }
    item.left = left;
    item.right = left ? left.right : this.start;
    if (left) left.right = item;
    else this.start = item;
    if (item.right) item.right.left = item;
    this.store(item);
  }

  // --- cursors ---

  /** A cursor at a code point index that follows its character through other people's edits. */
  relativePosition(index: number, assoc: 0 | 1 = 0): RelativePosition {
    let seen = 0;
    for (let it = this.start; it; it = it.right) {
      if (it.deleted) continue;
      if (assoc === 0 && seen === index) return { id: { client: it.client, clock: it.clock }, assoc };
      seen++;
      if (assoc === 1 && seen === index) return { id: { client: it.client, clock: it.clock }, assoc };
    }
    if (index > seen) throw new RangeError('index is past the end');
    if (assoc === 1 && index === 0) return { id: this.start ? { client: this.start.client, clock: this.start.clock } : null, assoc: 0 };
    return { id: null, assoc };
  }

  /** The index a cursor points at now, or undefined when its character has not arrived here yet. */
  absolutePosition(p: RelativePosition): number | undefined {
    if (p.id === null) return this.length;
    const target = this.get(p.id);
    if (!target) return undefined;
    let n = 0;
    for (let it = this.start; it && it !== target; it = it.right) if (!it.deleted) n++;
    return p.assoc === 1 && !target.deleted ? n + 1 : n;
  }
}

function addRange(ds: DeleteSet, client: number, clock: number, len: number): void {
  let a = ds.get(client);
  if (!a) ds.set(client, (a = []));
  a.push([clock, len]);
  a.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [c, l] of a) {
    const last = merged[merged.length - 1];
    if (last && c <= last[0] + last[1]) last[1] = Math.max(last[1], c + l - last[0]);
    else merged.push([c, l]);
  }
  ds.set(client, merged);
}

export function encodeStateVector(sv: StateVector): Uint8Array {
  const w = new Writer();
  const e = [...sv.entries()].sort((a, b) => b[0] - a[0]);
  w.uint(e.length);
  for (const [c, n] of e) (w.uint(c), w.uint(n));
  return w.bytes();
}

export function decodeStateVector(b: Uint8Array): StateVector {
  const r = new Reader(b);
  const n = r.uint();
  if (n > b.length) throw new Refused('more clients than bytes');
  const sv: StateVector = new Map();
  for (let i = 0; i < n; i++) sv.set(r.uint(), r.uint());
  if (!r.done) throw new Refused('there are bytes after the end');
  return sv;
}

/** One update that carries what several do, by applying them to a scratch document; refuses if some stay pending. */
export function mergeUpdates(updates: readonly Uint8Array[]): Uint8Array {
  const d = new Doc(0);
  for (const u of updates) d.applyUpdate(u);
  if (d.pendingItems) throw new Refused('some operations depend on updates that are not among those given');
  return d.encodeUpdate();
}

/** Exchanges missing updates between two documents; returns once both hold the same operations. */
export function sync(a: Doc, b: Doc): void {
  const ua = a.encodeUpdate(b.stateVector());
  const ub = b.encodeUpdate(a.stateVector());
  b.applyUpdate(ua);
  a.applyUpdate(ub);
}

export function encodeRelativePosition(p: RelativePosition): Uint8Array {
  const w = new Writer();
  w.byte((p.id ? 1 : 0) | (p.assoc << 1));
  if (p.id) (w.uint(p.id.client), w.uint(p.id.clock));
  return w.bytes();
}

export function decodeRelativePosition(b: Uint8Array): RelativePosition {
  const r = new Reader(b);
  const f = r.byte();
  if (f > 3) throw new Refused('unknown cursor flags');
  const id = f & 1 ? { client: r.uint(), clock: r.uint() } : null;
  if (!r.done) throw new Refused('there are bytes after the end');
  return { id, assoc: ((f >> 1) & 1) as 0 | 1 };
}
