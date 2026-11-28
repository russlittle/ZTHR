/**
 * Idempotent requests: one result per key. A repeat with the same key and the same content returns the first
 * result without running again; the same key with different content is refused; a repeat that arrives while the
 * first is still running waits for it instead of running twice. A failure is not kept, so the caller may try again.
 */

export interface Stored<T> {
  readonly fingerprint: string;
  readonly result?: T;
  readonly at: number;
}

export interface Store<T> {
  get(key: string): Promise<Stored<T> | undefined>;
  set(key: string, v: Stored<T>): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KeyReused extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`idempotency key ${key} was used before for different content`);
    this.key = key;
  }
}

export function memoryStore<T>(): Store<T> {
  const m = new Map<string, Stored<T>>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
}

/** A stable fingerprint of a request body: keys sorted, so the same content in another order is the same request. */
export function fingerprint(body: unknown): string {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(norm(body));
}

export class Idempotent<T> {
  /** Runs in flight, registered before anything is awaited, so a second request at the same moment waits for the first. */
  private readonly running = new Map<string, { fp: string; done: Promise<T> }>();
  private readonly store: Store<T>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(store: Store<T>, ttlMs: number, now: () => number = Date.now) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async once(key: string, body: unknown, run: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (!key.trim()) throw new TypeError('an idempotency key is required');
    const fp = fingerprint(body);
    const inFlight = this.running.get(key);
    if (inFlight) {
      if (inFlight.fp !== fp) throw new KeyReused(key);
      return { result: await inFlight.done, replayed: true };
    }
    let replayed = false;
    const done = (async () => {
      const kept = await this.store.get(key);
      if (kept && this.now() - kept.at < this.ttlMs) {
        if (kept.fingerprint !== fp) throw new KeyReused(key);
        if ('result' in kept) {
          replayed = true;
          return kept.result as T;
        }
      }
      await this.store.set(key, { fingerprint: fp, at: this.now() });
      try {
        const result = await run();
        await this.store.set(key, { fingerprint: fp, result, at: this.now() });
        return result;
      } catch (e) {
        await this.store.delete(key);
        throw e;
      }
    })();
    this.running.set(key, { fp, done });
    try {
      return { result: await done, replayed };
    } finally {
      this.running.delete(key);
    }
  }
}
