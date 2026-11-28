/**
 * Shared structured state that converges without a server deciding: a nested map of last-writer-wins registers,
 * observed-remove sets (adds win over a concurrent remove) and counters, with vector clocks and causal delivery.
 *
 * Every change is one operation carrying a dot (the replica and its own counter), the vector clock the replica
 * had when it made it (its dependencies), a Lamport stamp, the dots it removes (only ones it had seen) and the one
 * entry it adds. The state is a set of entries, each tagged with the dot that made it, and a vector clock of what
 * has been seen. That is the dot-kernel design of delta-state CRDTs (Almeida, Shoker and Baquero), which is why:
 *
 *  - Applying operations needs only causal delivery (an operation waits until its dependencies have been applied;
 *    a repeat is ignored), in any other order of arrival.
 *  - Merging two states keeps an entry present in both, and an entry present in one only when the other has not
 *    yet seen its dot. That merge is commutative, associative and idempotent (the tests check each law, and that
 *    delivering operations and merging states reach the same value).
 *  - A register keeps every concurrent write; reading picks the highest (Lamport time, replica id), so the winner
 *    is the same everywhere. `conflicts` lists the losers. A set's remove deletes only the elements the remover had
 *    seen, so a concurrent add survives. A counter is one entry per replica, summed; removing a subtree resets it
 *    for the replicas that had been seen.
 *  - A path is a list of keys. Writing a register replaces everything below that path. Removing a path removes the
 *    entries below it that were seen; a concurrent write below it survives (add wins). Where a register and deeper
 *    entries share a path, the JSON view shows the deeper ones (a map wins over a leaf); `get` still reads the leaf.
 *
 * Hostile input is refused: replica ids are plain names, keys cannot be "__proto__", paths and values have size
 * limits, an operation claiming to be ours from the future is refused, and the pending queue is bounded.
 * Not here: garbage collection of the vector clocks of replicas that have left, text sequences (see the text
 * CRDT blocks), and transport.
 */

export class CrdtError extends Error {}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type Path = readonly string[];

// ---------------------------------------------------------------- vector clocks

export type VClock = Readonly<Record<string, number>>;
export type Order = 'equal' | 'before' | 'after' | 'concurrent';

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** How two clocks relate: one happened before the other, they are equal, or they are concurrent. */
export function compare(a: VClock, b: VClock): Order {
  let less = false;
  let more = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x < y) less = true;
    if (x > y) more = true;
  }
  return less && more ? 'concurrent' : less ? 'before' : more ? 'after' : 'equal';
}

/** The pointwise maximum: what both have seen. */
export function mergeClocks(a: VClock, b: VClock): VClock {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}

/** True when every count in `deps` has been seen in `have`: the test for causal delivery. */
export const covers = (have: VClock, deps: VClock): boolean => Object.entries(deps).every(([k, n]) => (have[k] ?? 0) >= n);

// ---------------------------------------------------------------- state

export type Kind = 'reg' | 'set' | 'ctr';

export interface Stamp {
  readonly t: number;
  readonly r: string;
}

export interface Entry {
  readonly dot: string;
  readonly kind: Kind;
  readonly path: Path;
  /** The register's value, the set element, or the replica's running total for a counter. */
  readonly value: Json;
  readonly stamp: Stamp;
}

export interface Op {
  readonly replica: string;
  readonly n: number;
  readonly deps: VClock;
  readonly stamp: Stamp;
  /** Dots this operation removes: only ones its author had seen. */
  readonly remove: readonly string[];
  readonly add?: { readonly kind: Kind; readonly path: Path; readonly value: Json };
}

export interface State {
  readonly clock: VClock;
  readonly lamport: number;
  readonly entries: readonly Entry[];
}

const MAX_DEPTH = 32;
const MAX_KEY = 256;
const MAX_VALUE = 1_048_576;

const higher = (a: Stamp, b: Stamp) => a.t > b.t || (a.t === b.t && a.r > b.r);
const dotOf = (r: string, n: number) => `${r}:${n}`;
const pathKey = (p: Path) => JSON.stringify(p);
const under = (p: Path, prefix: Path) => p.length >= prefix.length && prefix.every((k, i) => p[i] === k);
const sameJson = (a: Json, b: Json) => canonical(a) === canonical(b);

/** JSON text with object keys sorted, so equal values have equal text. */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x as Json)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as { readonly [k: string]: Json };
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k]!)}`).join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new CrdtError('numbers must be finite');
  return JSON.stringify(v);
}

function checkPath(p: Path): void {
  if (!Array.isArray(p) || p.length > MAX_DEPTH) throw new CrdtError(`a path has at most ${MAX_DEPTH} keys`);
  for (const k of p) {
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY) throw new CrdtError('a key is a non-empty string of at most 256 characters');
    if (k === '__proto__') throw new CrdtError('"__proto__" is not a usable key');
  }
}

function checkValue(v: Json): string {
  const text = canonical(v);
  if (text.length > MAX_VALUE) throw new CrdtError('a value is at most 1 MiB');
  return text;
}

function checkClock(c: unknown): VClock {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new CrdtError('a clock is an object of counts');
  for (const [k, n] of Object.entries(c)) if (!NAME.test(k) || !Number.isSafeInteger(n) || (n as number) < 0) throw new CrdtError('a clock holds replica names and whole counts');
  return c as VClock;
}

export class CrdtMap {
  readonly replica: string;
  private vv: Record<string, number> = {};
  private lamport = 0;
  private readonly entries = new Map<string, Entry>();
  private pending: Op[] = [];
  private readonly maxPending: number;

  constructor(replica: string, o: { maxPending?: number } = {}) {
    if (!NAME.test(replica)) throw new CrdtError('a replica id is 1 to 64 letters, digits, dot, dash or underscore');
    this.replica = replica;
    this.maxPending = o.maxPending ?? 10_000;
  }

  // ------------------------------------------------------------ local changes

  /** What this replica has seen. */
  clock(): VClock {
    return { ...this.vv };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private seen(dots: Iterable<string>): string[] {
    return [...dots];
  }

  private commit(add: Op['add'], remove: readonly string[]): Op {
    const n = (this.vv[this.replica] ?? 0) + 1;
    const deps = this.clock();
    this.lamport += 1;
    const op: Op = { replica: this.replica, n, deps, stamp: { t: this.lamport, r: this.replica }, remove, ...(add ? { add } : {}) };
    this.integrate(op);
    return op;
  }

  /** Write a register, replacing everything at and below the path. Returns the operation to send to others. */
  set(path: Path, value: Json): Op {
    checkPath(path);
    checkValue(value);
    if (path.length === 0) throw new CrdtError('a register needs a path');
    return this.commit({ kind: 'reg', path, value }, this.seen([...this.entries.values()].filter((e) => under(e.path, path)).map((e) => e.dot)));
  }

  /** Add an element to the set at the path. */
  add(path: Path, value: Json): Op {
    checkPath(path);
    checkValue(value);
    if (path.length === 0) throw new CrdtError('a set needs a path');
    const same = [...this.entries.values()].filter((e) => e.kind === 'set' && pathKey(e.path) === pathKey(path) && sameJson(e.value, value)).map((e) => e.dot);
    return this.commit({ kind: 'set', path, value }, same);
  }

  /** Remove an element: only the copies this replica has seen, so a concurrent add survives. */
  discard(path: Path, value: Json): Op {
    checkPath(path);
    const same = [...this.entries.values()].filter((e) => e.kind === 'set' && pathKey(e.path) === pathKey(path) && sameJson(e.value, value)).map((e) => e.dot);
    return this.commit(undefined, same);
  }

  /** Add to the counter at the path (negative to subtract). Whole numbers only. */
  increment(path: Path, by = 1): Op {
    checkPath(path);
    if (!Number.isSafeInteger(by)) throw new CrdtError('a counter changes by a whole number');
    if (path.length === 0) throw new CrdtError('a counter needs a path');
    const mine = [...this.entries.values()].filter((e) => e.kind === 'ctr' && pathKey(e.path) === pathKey(path) && e.stamp.r === this.replica);
    const total = mine.reduce((a, e) => a + (e.value as number), 0) + by;
    if (!Number.isSafeInteger(total)) throw new CrdtError('the counter would pass the safe integer range');
    return this.commit({ kind: 'ctr', path, value: total }, mine.map((e) => e.dot));
  }

  /** Remove everything at and below a path that this replica has seen. */
  remove(path: Path): Op {
    checkPath(path);
    return this.commit(undefined, this.seen([...this.entries.values()].filter((e) => under(e.path, path)).map((e) => e.dot)));
  }

  // ------------------------------------------------------------ operations from others

  private integrate(op: Op): void {
    for (const d of op.remove) this.entries.delete(d);
    if (op.add) this.entries.set(dotOf(op.replica, op.n), { dot: dotOf(op.replica, op.n), kind: op.add.kind, path: op.add.path, value: op.add.value, stamp: op.stamp });
    this.vv[op.replica] = op.n;
    this.lamport = Math.max(this.lamport, op.stamp.t);
  }

  private validate(op: Op): void {
    if (!op || typeof op !== 'object') throw new CrdtError('not an operation');
    if (!NAME.test(op.replica) || !Number.isSafeInteger(op.n) || op.n < 1) throw new CrdtError('an operation has a replica and a positive count');
    checkClock(op.deps);
    if (!op.stamp || !Number.isSafeInteger(op.stamp.t) || op.stamp.t < 1 || op.stamp.r !== op.replica) throw new CrdtError('a stamp belongs to its replica');
    if (!Array.isArray(op.remove) || op.remove.length > 100_000 || op.remove.some((d) => typeof d !== 'string' || !/^[A-Za-z0-9._-]{1,64}:\d{1,15}$/.test(d))) throw new CrdtError('removals are dots');
    if (op.add) {
      if (!['reg', 'set', 'ctr'].includes(op.add.kind)) throw new CrdtError('unknown kind');
      checkPath(op.add.path);
      if (op.add.path.length === 0) throw new CrdtError('an entry needs a path');
      checkValue(op.add.value);
      if (op.add.kind === 'ctr' && !Number.isSafeInteger(op.add.value)) throw new CrdtError('a counter holds a whole number');
    }
    if (op.replica === this.replica && op.n > (this.vv[this.replica] ?? 0) + 1) throw new CrdtError('an operation claims to be ours from the future');
    if ((op.deps[op.replica] ?? 0) !== op.n - 1) throw new CrdtError('an operation depends on its own replica up to the one before it');
  }

  /**
   * Apply an operation from another replica once its dependencies are here. An operation that is early waits in a
   * bounded queue; one already applied is ignored. Returns what happened to it.
   */
  apply(op: Op): 'applied' | 'buffered' | 'duplicate' {
    this.validate(op);
    if ((this.vv[op.replica] ?? 0) >= op.n) return 'duplicate';
    if (this.pending.some((p) => p.replica === op.replica && p.n === op.n)) return 'duplicate';
    if (!covers(this.vv, op.deps)) {
      if (this.pending.length >= this.maxPending) throw new CrdtError('too many operations are waiting for their dependencies');
      this.pending.push(op);
      return 'buffered';
    }
    this.integrate(op);
    this.drain();
    return 'applied';
  }

  private drain(): void {
    for (let moved = true; moved; ) {
      moved = false;
      for (const op of this.pending) {
        if ((this.vv[op.replica] ?? 0) >= op.n) {
          this.pending = this.pending.filter((p) => p !== op);
          moved = true;
          break;
        }
        if (covers(this.vv, op.deps)) {
          this.pending = this.pending.filter((p) => p !== op);
          this.integrate(op);
          moved = true;
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------ state merge

  state(): State {
    return { clock: this.clock(), lamport: this.lamport, entries: [...this.entries.values()].sort((a, b) => (a.dot < b.dot ? -1 : 1)) };
  }

  /**
   * Join another replica's state into this one. An entry both have stays; one only the other has stays only if this
   * replica has not already seen (and so removed) its dot; and the other way round. Commutative, associative and
   * idempotent.
   */
  merge(other: State | CrdtMap): void {
    const s = other instanceof CrdtMap ? other.state() : other;
    checkClock(s.clock);
    const theirs = new Map<string, Entry>();
    for (const e of s.entries) {
      checkPath(e.path);
      checkValue(e.value);
      theirs.set(e.dot, e);
    }
    const seenHere = (dot: string) => {
      const i = dot.lastIndexOf(':');
      return (this.vv[dot.slice(0, i)] ?? 0) >= Number(dot.slice(i + 1));
    };
    const seenThere = (dot: string) => {
      const i = dot.lastIndexOf(':');
      return (s.clock[dot.slice(0, i)] ?? 0) >= Number(dot.slice(i + 1));
    };
    for (const d of [...this.entries.keys()]) if (!theirs.has(d) && seenThere(d)) this.entries.delete(d);
    for (const [d, e] of theirs) if (!this.entries.has(d) && !seenHere(d)) this.entries.set(d, e);
    this.vv = { ...mergeClocks(this.vv, s.clock) } as Record<string, number>;
    this.lamport = Math.max(this.lamport, s.lamport);
    this.drain();
  }

  static from(replica: string, s: State): CrdtMap {
    const m = new CrdtMap(replica);
    m.merge(s);
    return m;
  }

  // ------------------------------------------------------------ reads

  private at(path: Path, kind: Kind): Entry[] {
    const k = pathKey(path);
    return [...this.entries.values()].filter((e) => e.kind === kind && pathKey(e.path) === k);
  }

  /** The register's value: the concurrent write with the highest Lamport time (ties by replica id). */
  get(path: Path): Json | undefined {
    const w = this.at(path, 'reg').reduce<Entry | undefined>((best, e) => (!best || higher(e.stamp, best.stamp) ? e : best), undefined);
    return w?.value;
  }

  /** The values that lost to the one `get` shows: concurrent writes nobody has overwritten yet. */
  conflicts(path: Path): Json[] {
    const all = this.at(path, 'reg').sort((a, b) => (higher(a.stamp, b.stamp) ? -1 : 1));
    return all.slice(1).map((e) => e.value);
  }

  /** The elements of the set, each once, in a fixed order. */
  members(path: Path): Json[] {
    const seen = new Map<string, Json>();
    for (const e of this.at(path, 'set')) seen.set(canonical(e.value), e.value);
    return [...seen.keys()].sort().map((k) => seen.get(k)!);
  }

  has(path: Path, value: Json): boolean {
    return this.at(path, 'set').some((e) => sameJson(e.value, value));
  }

  /** The counter's value: the sum of every replica's total. */
  count(path: Path): number {
    return this.at(path, 'ctr').reduce((a, e) => a + (e.value as number), 0);
  }

  /** Is anything at or below the path? */
  exists(path: Path): boolean {
    return [...this.entries.values()].some((e) => under(e.path, path));
  }

  /** The whole map as JSON: registers as their value, sets as sorted arrays, counters as numbers. */
  toJSON(): Json {
    const root: Record<string, unknown> = Object.create(null);
    const paths = new Map<string, Path>();
    for (const e of this.entries.values()) paths.set(pathKey(e.path), e.path);
    const deeper = (p: Path) => [...paths.values()].some((q) => q.length > p.length && under(q, p));
    for (const p of [...paths.values()].sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : 1))) {
      if (deeper(p)) continue; // a map wins over a leaf
      const kinds = new Set(this.entries.size ? [...this.entries.values()].filter((e) => pathKey(e.path) === pathKey(p)).map((e) => e.kind) : []);
      const value: Json = kinds.has('reg') ? this.get(p)! : kinds.has('set') ? this.members(p) : this.count(p);
      let node = root;
      for (const k of p.slice(0, -1)) {
        const next = node[k];
        if (!next || typeof next !== 'object') node[k] = Object.create(null);
        node = node[k] as Record<string, unknown>;
      }
      node[p[p.length - 1]!] = value;
    }
    return JSON.parse(JSON.stringify(root)) as Json;
  }
}

/** Stable text of a state's meaning (entries and clock), for comparing replicas. */
export function fingerprint(m: CrdtMap): string {
  const s = m.state();
  return canonical({ clock: s.clock as Json, entries: s.entries.map((e) => [e.dot, e.kind, e.path as Json, e.value, e.stamp.t, e.stamp.r]) as Json });
}
