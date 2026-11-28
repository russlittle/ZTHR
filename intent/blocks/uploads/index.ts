/**
 * Resumable uploads: a session collects numbered chunks in any order, a repeated chunk replaces the earlier one, and
 * assembly joins them in number order into one object, in the store, without the bytes coming back through the app.
 * The total length, when the client says it up front, is checked against the quota on the first chunk, not after
 * gigabytes have arrived, and every chunk's stream is cut off at what may still arrive: the chunk limit, the
 * declared total less what came before, and the free space less what came before. Assembly leaves the chunks in
 * place; the caller commits the joined object and only then calls finish, so a crash in between loses nothing.
 * A session nobody has touched for a day expires and its chunks are swept.
 */
import { TooLarge, type ObjectStore, type Written } from '../objects/index.ts';

export interface Rules {
  /** Chunk numbers allowed, inclusive. */
  readonly minChunk: number;
  readonly maxChunk: number;
  /** Bytes every chunk but the last must have at least, and every chunk at most. */
  readonly minBytes: number;
  readonly maxBytes: number;
  /** A session idle this long is gone. */
  readonly idleMs: number;
}

/** The limits Nextcloud's clients are built for: chunks 1 to 10,000, 5 MB to 5 GB but the last, idle for a day. */
export const NEXTCLOUD_RULES: Rules = { minChunk: 1, maxChunk: 10_000, minBytes: 5 * 1024 * 1024, maxBytes: 5 * 1024 * 1024 * 1024, idleMs: 24 * 3600_000 };

export interface Session {
  readonly id: string;
  readonly owner: string;
  readonly destination: string;
  readonly totalLength?: number;
  readonly chunks: Readonly<Record<string, { key: string; size: number }>>;
  readonly touched: number;
}

export interface SessionStore {
  get(owner: string, id: string): Promise<Session | undefined>;
  set(s: Session): Promise<void>;
  delete(owner: string, id: string): Promise<void>;
  all(): Promise<Session[]>;
}

export function memorySessions(): SessionStore {
  const m = new Map<string, Session>();
  const k = (o: string, id: string) => `${o}\0${id}`;
  return {
    get: async (o, id) => m.get(k(o, id)),
    set: async (s) => void m.set(k(s.owner, s.id), s),
    delete: async (o, id) => void m.delete(k(o, id)),
    all: async () => [...m.values()],
  };
}

export class NoSession extends Error {
  constructor(id: string) {
    super(`no upload ${id}, or it expired`);
  }
}

export class BadChunk extends Error {
  readonly why: string;
  constructor(why: string) {
    super(why);
    this.why = why;
  }
}

export class OverQuota extends Error {
  readonly needed: number;
  readonly free: number;
  constructor(needed: number, free: number) {
    super(`needs ${needed} bytes, ${free} free`);
    this.needed = needed;
    this.free = free;
  }
}

export class WrongLength extends Error {
  constructor(expected: number, got: number) {
    super(`expected ${expected} bytes, assembled ${got}`);
  }
}

export interface UploadsOptions {
  readonly rules?: Rules;
  readonly now?: () => number;
  /** Bytes the owner may still store; undefined means no limit. */
  readonly free?: (owner: string) => Promise<number | undefined>;
  /** How many parts the store joins in one call; the rest are joined in a tree of calls. */
  readonly composeWidth?: number;
}

export class Uploads {
  private readonly objects: ObjectStore;
  private readonly sessions: SessionStore;
  private readonly rules: Rules;
  private readonly now: () => number;
  private readonly free: (owner: string) => Promise<number | undefined>;
  private readonly width: number;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(objects: ObjectStore, sessions: SessionStore, o: UploadsOptions = {}) {
    this.objects = objects;
    this.sessions = sessions;
    this.rules = o.rules ?? NEXTCLOUD_RULES;
    this.now = o.now ?? Date.now;
    this.free = o.free ?? (async () => undefined);
    this.width = Math.max(2, o.composeWidth ?? 32);
  }

  /** Session updates run one at a time per session, so chunks arriving together are all kept. */
  private serial<T>(owner: string, id: string, run: () => Promise<T>): Promise<T> {
    const k = `${owner}\0${id}`;
    const next = (this.queues.get(k) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => undefined);
    this.queues.set(k, tail);
    void tail.then(() => {
      if (this.queues.get(k) === tail) this.queues.delete(k);
    });
    return next;
  }

  private async live(owner: string, id: string): Promise<Session> {
    const s = await this.sessions.get(owner, id);
    if (!s || this.now() - s.touched > this.rules.idleMs) throw new NoSession(id);
    return s;
  }

  private async checkQuota(owner: string, total: number | undefined): Promise<void> {
    if (total === undefined) return;
    const free = await this.free(owner);
    if (free !== undefined && total > free) throw new OverQuota(total, free);
  }

  /** Opens a session; opening one that exists keeps it and its chunks (clients retry the opening request). */
  async start(owner: string, id: string, destination: string, totalLength?: number): Promise<Session> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new BadChunk('an upload id is 1 to 128 letters, digits, dots, dashes or underscores');
    await this.checkQuota(owner, totalLength);
    const kept = await this.sessions.get(owner, id);
    const s: Session = kept && this.now() - kept.touched <= this.rules.idleMs ? { ...kept, destination, ...(totalLength !== undefined ? { totalLength } : {}), touched: this.now() } : { id, owner, destination, ...(totalLength !== undefined ? { totalLength } : {}), chunks: {}, touched: this.now() };
    await this.sessions.set(s);
    return s;
  }

  /**
   * Stores one chunk. Its bytes are cut off at the most it may have: the chunk limit, the declared total less the
   * other chunks, and the free space less the other chunks (a resent chunk replaces its earlier copy, so that one is
   * not counted). `size`, when the client says it (Content-Length), is checked against the same before any byte is read.
   */
  async chunk(owner: string, id: string, name: string, data: AsyncIterable<Uint8Array> | Uint8Array, totalLength?: number, size?: number): Promise<{ size: number }> {
    const s = await this.live(owner, id);
    const n = Number(name);
    if (!/^\d+$/.test(name) || n < this.rules.minChunk || n > this.rules.maxChunk) throw new BadChunk(`chunk names are whole numbers from ${this.rules.minChunk} to ${this.rules.maxChunk}`);
    await this.checkQuota(owner, totalLength ?? s.totalLength);
    const free = await this.free(owner);
    const limits = (sess: Session) => {
      const others = Object.entries(sess.chunks).reduce((a, [k, c]) => (Number(k) === n ? a : a + c.size), 0);
      const declared = totalLength ?? sess.totalLength;
      return { others, declared, byTotal: declared === undefined ? Infinity : declared - others, byFree: free === undefined ? Infinity : free - others };
    };
    const refuse = (l: ReturnType<typeof limits>, got: number): never => {
      if (got > l.byTotal) throw new BadChunk(`the chunks come to more than the ${l.declared} bytes declared`);
      throw new OverQuota(l.others + got, free!);
    };
    const first = limits(s);
    const cap = Math.max(0, Math.min(this.rules.maxBytes, first.byTotal, first.byFree));
    if (size !== undefined && Number.isFinite(size) && size > cap) {
      if (size > this.rules.maxBytes && cap === this.rules.maxBytes) throw new TooLarge(this.rules.maxBytes);
      refuse(first, size);
    }
    // The bytes are written outside the queue, so chunks upload in parallel; only the record of them is serial.
    let w: Written;
    try {
      w = await this.objects.put(data, { maxBytes: cap, algos: [] });
    } catch (e) {
      if (e instanceof TooLarge && cap < this.rules.maxBytes) refuse(first, cap + 1);
      throw e;
    }
    const old = await this.serial(owner, id, async () => {
      const latest = await this.live(owner, id);
      // Chunks stored in parallel each fit alone; together they are checked again as each is recorded.
      const l = limits(latest);
      if (w.size > l.byTotal || w.size > l.byFree) refuse(l, w.size);
      const before = latest.chunks[String(n)];
      await this.sessions.set({ ...latest, ...(totalLength !== undefined ? { totalLength } : {}), chunks: { ...latest.chunks, [String(n)]: { key: w.key, size: w.size } }, touched: this.now() });
      return before;
    }).catch(async (e) => {
      await this.objects.delete(w.key);
      throw e;
    });
    if (old) await this.objects.delete(old.key);
    return { size: w.size };
  }

  /** The chunks a client has sent so far, so it can resume with the rest. */
  async received(owner: string, id: string): Promise<{ n: number; size: number }[]> {
    const s = await this.live(owner, id);
    return Object.entries(s.chunks)
      .map(([n, c]) => ({ n: Number(n), size: c.size }))
      .sort((a, b) => a.n - b.n);
  }

  /**
   * Joins the chunks in number order into one new object. The chunks and the session stay: the caller commits the
   * object where it belongs, makes that durable, and then calls finish. Until then a retry assembles again.
   */
  async assemble(owner: string, id: string, totalLength?: number): Promise<Written & { destination: string }> {
    return this.serial(owner, id, () => this.assembleNow(owner, id, totalLength));
  }

  private async assembleNow(owner: string, id: string, totalLength?: number): Promise<Written & { destination: string }> {
    const s = await this.live(owner, id);
    const order = Object.entries(s.chunks)
      .map(([n, c]) => ({ n: Number(n), ...c }))
      .sort((a, b) => a.n - b.n);
    if (!order.length) throw new BadChunk('there are no chunks to assemble');
    order.slice(0, -1).forEach((c) => {
      if (c.size < this.rules.minBytes) throw new BadChunk(`chunk ${c.n} has ${c.size} bytes; every chunk but the last needs at least ${this.rules.minBytes}`);
    });
    const want = totalLength ?? s.totalLength;
    const got = order.reduce((a, c) => a + c.size, 0);
    if (want !== undefined && want !== got) throw new WrongLength(want, got);
    await this.checkQuota(owner, got);
    const w = await this.join(order.map((c) => c.key));
    return { ...w, destination: s.destination };
  }

  /** Ends a session whose joined object is committed: its chunks and its record go. */
  async finish(owner: string, id: string): Promise<void> {
    return this.serial(owner, id, async () => {
      const s = await this.sessions.get(owner, id);
      if (s) await this.discard(s);
    });
  }

  /** Every session a person has open, for removing them with the person. */
  async of(owner: string): Promise<Session[]> {
    return (await this.sessions.all()).filter((s) => s.owner === owner);
  }

  /** Joins in a tree of compose calls, `width` parts at a time, deleting each intermediate object once used. */
  private async join(keys: string[]): Promise<Written> {
    let level = keys;
    const made: string[] = [];
    while (level.length > this.width) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += this.width) {
        const part = level.slice(i, i + this.width);
        if (part.length === 1) next.push(part[0]!);
        else {
          const w = await this.objects.compose(part);
          made.push(w.key);
          next.push(w.key);
        }
      }
      level = next;
    }
    const final = await this.objects.compose(level);
    for (const k of made) await this.objects.delete(k);
    return final;
  }

  async abort(owner: string, id: string): Promise<void> {
    const s = await this.sessions.get(owner, id);
    if (s) await this.discard(s);
  }

  private async discard(s: Session): Promise<void> {
    for (const c of Object.values(s.chunks)) await this.objects.delete(c.key);
    await this.sessions.delete(s.owner, s.id);
  }

  /** Removes every session idle past the limit, with its chunks; returns how many it removed. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const s of await this.sessions.all())
      if (this.now() - s.touched > this.rules.idleMs) {
        await this.discard(s);
        n++;
      }
    return n;
  }
}
