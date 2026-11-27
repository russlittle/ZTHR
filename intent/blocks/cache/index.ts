/**
 * A read-through cache. A miss loads the value once, however many callers ask at the same moment (no stampede);
 * a value past its time is served while one caller refreshes it in the background, up to a stale limit; a failed
 * load is not cached. Entries are dropped by key, by tag (everything about one record), or least recently used
 * first when the cache is full; dropping a key also discards any load for it still running, so a value read before
 * the change is never cached after it. Hits, misses and loads are counted, so the cache can show it is earning its keep.
 */

export interface CacheOptions {
  readonly ttlMs: number;
  /** How long past its time a value may still be served while it refreshes. */
  readonly staleMs?: number;
  readonly max?: number;
  readonly now?: () => number;
}

interface Entry<V> {
  value: V;
  at: number;
  tags: readonly string[];
}

export class Cache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly loading = new Map<string, { p: Promise<V>; tags: readonly string[] }>();
  readonly stats = { hits: 0, stale: 0, misses: 0, loads: 0, failures: 0 };
  private readonly o: Required<CacheOptions>;

  constructor(o: CacheOptions) {
    this.o = { staleMs: 0, max: 10_000, now: Date.now, ...o };
  }

  async get(key: string, load: () => Promise<V>, tags: readonly string[] = []): Promise<V> {
    const e = this.entries.get(key);
    const age = e ? this.o.now() - e.at : Infinity;
    if (e && age <= this.o.ttlMs) {
      this.stats.hits++;
      this.touch(key, e);
      return e.value;
    }
    if (e && age <= this.o.ttlMs + this.o.staleMs) {
      this.stats.stale++;
      void this.load(key, load, tags).catch(() => {});
      return e.value;
    }
    this.stats.misses++;
    return this.load(key, load, tags);
  }

  private load(key: string, load: () => Promise<V>, tags: readonly string[]): Promise<V> {
    const running = this.loading.get(key);
    if (running) return running.p;
    this.stats.loads++;
    const mine = { p: undefined as unknown as Promise<V>, tags };
    const ours = () => this.loading.get(key) === mine;
    mine.p = load().then(
      (value) => {
        if (!ours()) return value;
        this.loading.delete(key);
        const old = this.entries.get(key);
        this.entries.delete(key);
        this.entries.set(key, { value, at: this.o.now(), tags: old ? [...new Set([...old.tags, ...tags])] : tags });
        while (this.entries.size > this.o.max) this.entries.delete(this.entries.keys().next().value!);
        return value;
      },
      (err: unknown) => {
        if (ours()) this.loading.delete(key);
        this.stats.failures++;
        throw err;
      },
    );
    this.loading.set(key, mine);
    return mine.p;
  }

  private touch(key: string, e: Entry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, e);
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.loading.delete(key);
  }

  /** Drops every entry carrying the tag, such as `user:42` when that user changes. */
  invalidateTag(tag: string): number {
    let n = 0;
    for (const [k, l] of this.loading) if (l.tags.includes(tag)) this.loading.delete(k);
    for (const [k, e] of this.entries)
      if (e.tags.includes(tag)) {
        this.entries.delete(k);
        n++;
      }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }

  hitRate(): number {
    const asked = this.stats.hits + this.stats.stale + this.stats.misses;
    return asked ? (this.stats.hits + this.stats.stale) / asked : 0;
  }
}
