/**
 * Turning text into vectors through any embedding service without trusting it: a provider interface (a model id, a
 * dimension, a largest batch, and a function from texts to vectors), a deterministic twin of a provider for tests and
 * development, and an `Embedder` that sits in front of a provider and adds what every caller needs.
 *
 * Batching: a request for many texts is cut into provider calls of at most `maxBatch` texts (and `maxBatchChars`
 * characters), and a text asked for twice, in one request or at the same moment from two callers, is embedded once.
 * Caching by content: the key is the SHA-256 of the model id, the dimension, the kind of input (query or document)
 * and the text after Unicode normalisation (NFC), so a different model never gets another model's vector and a
 * change of model needs no manual flush; the cache is the cache block's, so entries expire, are bounded, carry the
 * model as a tag to drop at once, and a failed call is never stored. Retries, deadlines and a circuit breaker come
 * from the resilience block; the clock, sleeper and random source are arguments.
 *
 * Checks that refuse bad answers: the number of vectors must equal the number of texts, each must have exactly the
 * provider's dimension and hold only finite numbers (a provider that returns the wrong shape is a fault to report,
 * not to retry or cache). Checks that refuse bad requests before any call: texts must be strings, not empty, within a
 * length limit (an error, or cut to the limit), and within a count and total size.
 *
 * `EmbeddingSpace` (model and dimension) and `assertSameSpace` are for stores of vectors: refuse to compare or mix
 * vectors made by different models.
 *
 * The twin is not semantic: it hashes words and character trigrams into a fixed number of buckets, so texts that share
 * words or spellings are close and unrelated texts are not, the same text always gives the same vector, and nothing
 * leaves the process. Out of scope: any real provider's HTTP calls (a provider is a function you write), and
 * choosing a model.
 */
import { createHash } from 'node:crypto';
import { Breaker, BreakerOpen, DEFAULT_RETRY, TimedOut, retry, withTimeout } from '../resilience/index.ts';
import type { RetryPolicy } from '../resilience/index.ts';
import { Cache } from '../cache/index.ts';

export class BadRequest extends Error {
  readonly index: number | undefined;
  constructor(why: string, index?: number) {
    super(why);
    this.index = index;
  }
}
export class DimensionMismatch extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class BadEmbedding extends Error {
  constructor(why: string) {
    super(why);
  }
}
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(why: string, o: { retryable?: boolean; status?: number } = {}) {
    super(why);
    this.retryable = o.retryable ?? true;
    this.status = o.status;
  }
}
export class EmbeddingFailed extends Error {
  readonly causes: readonly unknown[];
  constructor(why: string, causes: readonly unknown[]) {
    super(why);
    this.causes = causes;
  }
}

export type InputKind = 'document' | 'query';

export interface EmbeddingProvider {
  /** Names the model; vectors from different ids are never mixed or shared through the cache. */
  readonly model: string;
  readonly dim: number;
  /** Most texts the service takes in one call. */
  readonly maxBatch: number;
  embed(texts: readonly string[], o: { kind: InputKind; signal: AbortSignal }): Promise<readonly ArrayLike<number>[]>;
}

export interface EmbeddingSpace {
  readonly model: string;
  readonly dim: number;
}

/** Throws unless two things are in the same space: the same model and the same dimension. */
export function assertSameSpace(a: EmbeddingSpace, b: EmbeddingSpace): void {
  if (a.model !== b.model) throw new DimensionMismatch(`vectors from ${a.model} cannot be used with vectors from ${b.model}`);
  if (a.dim !== b.dim) throw new DimensionMismatch(`${a.dim} numbers per vector against ${b.dim}`);
}

// --- the twin ---------------------------------------------------------------------------------------------------

const fnv = (s: string, seed: number): number => {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};

/** The words of a text as the twin sees them: lower case, letters and digits. */
export const words = (text: string): string[] => text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A provider that needs no network: the same text always gives the same unit vector, and shared words make vectors close. */
export function twin(o: { dim?: number; maxBatch?: number; model?: string } = {}): EmbeddingProvider & { readonly calls: { texts: readonly string[]; kind: InputKind }[] } {
  const dim = o.dim ?? 64;
  if (!Number.isInteger(dim) || dim < 8 || dim > 4096) throw new RangeError('the twin has 8 to 4096 dimensions');
  const calls: { texts: readonly string[]; kind: InputKind }[] = [];
  const one = (text: string): number[] => {
    const v = new Array<number>(dim).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv(feature, 0);
      v[h % dim]! += (fnv(feature, 0x9e3779b9) & 1 ? 1 : -1) * weight;
    };
    for (const w of words(text)) {
      add(`w:${w}`, 1);
      const p = `^${w}$`;
      for (let i = 0; i + 3 <= p.length; i++) add(`t:${p.slice(i, i + 3)}`, 0.35);
    }
    let n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (n === 0) {
      // Nothing but punctuation: still a vector, and still the same one each time.
      add(`raw:${text}`, 1);
      n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    }
    return v.map((x) => x / n);
  };
  return {
    model: o.model ?? `twin-${dim}`,
    dim,
    maxBatch: o.maxBatch ?? 64,
    calls,
    async embed(texts, opts) {
      calls.push({ texts: [...texts], kind: opts.kind });
      return texts.map(one);
    },
  };
}

export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  if (a.length !== b.length) throw new DimensionMismatch(`${a.length} numbers against ${b.length}`);
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    x += a[i]! * a[i]!;
    y += b[i]! * b[i]!;
  }
  return x === 0 || y === 0 ? 0 : d / Math.sqrt(x * y);
};

// --- the embedder -----------------------------------------------------------------------------------------------

export interface EmbedderOptions {
  readonly provider: EmbeddingProvider;
  /** How long a vector is kept (default 7 days). */
  readonly ttlMs?: number;
  /** Most vectors kept (default 50000). */
  readonly maxCached?: number;
  /** A shared cache; the key holds the model, so sharing across models is safe. */
  readonly cache?: Cache<Float32Array>;
  readonly now?: () => number;
  /** Longest a text may be, in characters (default 8000). */
  readonly maxChars?: number;
  /** What to do with a longer text: refuse it (default) or cut it. */
  readonly tooLong?: 'error' | 'cut';
  /** Most texts in one call (default 2048) and most characters in all of them (default 2 million). */
  readonly maxTexts?: number;
  readonly maxTotalChars?: number;
  /** Most characters in one provider call (default 200000). */
  readonly maxBatchChars?: number;
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  readonly breaker?: Breaker;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface EmbedderStats {
  calls: number;
  retries: number;
  textsSent: number;
  cacheHits: number;
  cacheMisses: number;
  failures: number;
}

const retryableByDefault = (e: unknown): boolean => {
  if (e instanceof BreakerOpen || e instanceof BadRequest || e instanceof DimensionMismatch || e instanceof BadEmbedding) return false;
  if (e instanceof ProviderError) return e.retryable;
  return true;
};

export class Embedder {
  readonly provider: EmbeddingProvider;
  readonly space: EmbeddingSpace;
  readonly stats: EmbedderStats = { calls: 0, retries: 0, textsSent: 0, cacheHits: 0, cacheMisses: 0, failures: 0 };
  private readonly cache: Cache<Float32Array>;
  private readonly o: Required<Omit<EmbedderOptions, 'provider' | 'cache' | 'breaker' | 'sleep' | 'random' | 'now'>> & Pick<EmbedderOptions, 'breaker' | 'sleep' | 'random' | 'now'>;

  constructor(opts: EmbedderOptions) {
    const p = opts.provider;
    if (!Number.isInteger(p.dim) || p.dim < 1) throw new RangeError('a provider has a dimension');
    if (!Number.isInteger(p.maxBatch) || p.maxBatch < 1) throw new RangeError('a provider has a largest batch of at least 1');
    this.provider = p;
    this.space = { model: p.model, dim: p.dim };
    this.cache = opts.cache ?? new Cache<Float32Array>({ ttlMs: opts.ttlMs ?? 7 * 86_400_000, max: opts.maxCached ?? 50_000, ...(opts.now ? { now: opts.now } : {}) });
    this.o = {
      ttlMs: opts.ttlMs ?? 7 * 86_400_000,
      maxCached: opts.maxCached ?? 50_000,
      maxChars: opts.maxChars ?? 8000,
      tooLong: opts.tooLong ?? 'error',
      maxTexts: opts.maxTexts ?? 2048,
      maxTotalChars: opts.maxTotalChars ?? 2_000_000,
      maxBatchChars: opts.maxBatchChars ?? 200_000,
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: opts.retry ?? { ...DEFAULT_RETRY, retryable: retryableByDefault },
      ...(opts.breaker ? { breaker: opts.breaker } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.random ? { random: opts.random } : {}),
    };
  }

  /** The cache key of a text: stable, and different for a different model, dimension, kind or text. */
  key(text: string, kind: InputKind = 'document'): string {
    return createHash('sha256').update(`${this.provider.model}\u0000${this.provider.dim}\u0000${kind}\u0000${text.normalize('NFC').trim()}`).digest('hex');
  }

  private prepare(texts: readonly string[]): string[] {
    if (!Array.isArray(texts)) throw new BadRequest('texts must be a list');
    if (texts.length > this.o.maxTexts) throw new BadRequest(`at most ${this.o.maxTexts} texts at a time`);
    let total = 0;
    return texts.map((t, i) => {
      if (typeof t !== 'string') throw new BadRequest(`text ${i} is not a string`, i);
      let s = t.normalize('NFC').trim();
      // eslint-disable-next-line no-control-regex
      s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
      if (s === '') throw new BadRequest(`text ${i} is empty`, i);
      if (s.length > this.o.maxChars) {
        if (this.o.tooLong === 'error') throw new BadRequest(`text ${i} is ${s.length} characters; the limit is ${this.o.maxChars}`, i);
        s = s.slice(0, this.o.maxChars);
        // Do not leave half of a surrogate pair at the cut.
        if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
      }
      total += s.length;
      if (total > this.o.maxTotalChars) throw new BadRequest(`more than ${this.o.maxTotalChars} characters in all`, i);
      return s;
    });
  }

  /** Embeds documents (what is stored and searched). */
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return this.run(texts, 'document');
  }
  /** Embeds queries (what is searched for), for models that treat them differently. */
  embedQuery(texts: readonly string[]): Promise<Float32Array[]> {
    return this.run(texts, 'query');
  }
  async embedOne(text: string, kind: InputKind = 'document'): Promise<Float32Array> {
    return (await this.run([text], kind))[0]!;
  }

  /** Forgets every vector made by this model. */
  forget(): number {
    return this.cache.invalidateTag(`model:${this.provider.model}`);
  }

  private async run(texts: readonly string[], kind: InputKind): Promise<Float32Array[]> {
    const clean = this.prepare(texts);
    const keys = clean.map((t) => this.key(t, kind));
    const first = new Map<string, string>();
    clean.forEach((t, i) => {
      if (!first.has(keys[i]!)) first.set(keys[i]!, t);
    });
    // Ask the cache for every distinct text. Its loader runs at once for each one that nobody has or is already
    // fetching, which is exactly the list to send, so the cache's single-flight serves callers asking at the same time.
    const wanted: { key: string; text: string; ok: (v: Float32Array) => void; fail: (e: unknown) => void }[] = [];
    const answers = new Map<string, Promise<Float32Array>>();
    for (const [key, text] of first) {
      answers.set(
        key,
        this.cache.get(
          key,
          () =>
            new Promise<Float32Array>((ok, fail) => {
              wanted.push({ key, text, ok, fail });
            }),
          [`model:${this.provider.model}`],
        ),
      );
    }
    this.stats.cacheMisses += wanted.length;
    this.stats.cacheHits += first.size - wanted.length;
    const errors: unknown[] = [];
    const batches: typeof wanted[] = [];
    let cur: typeof wanted = [];
    let chars = 0;
    for (const w of wanted) {
      if (cur.length && (cur.length >= this.provider.maxBatch || chars + w.text.length > this.o.maxBatchChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(w);
      chars += w.text.length;
    }
    if (cur.length) batches.push(cur);
    await Promise.all(
      batches.map(async (b) => {
        try {
          const vecs = await this.callProvider(b.map((w) => w.text), kind);
          b.forEach((w, i) => w.ok(vecs[i]!));
        } catch (e) {
          this.stats.failures++;
          errors.push(e);
          for (const w of b) w.fail(e);
        }
      }),
    );
    const settled = await Promise.allSettled([...answers.values()]);
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed.length) {
      const causes = errors.length ? errors : failed.map((f) => f.reason as unknown);
      const only = causes[0];
      if (causes.length === 1 && (only instanceof BadEmbedding || only instanceof DimensionMismatch || only instanceof BadRequest)) throw only;
      throw new EmbeddingFailed(`embedding failed for ${failed.length} of ${first.size} texts: ${(causes[0] as Error)?.message ?? String(causes[0])}`, causes);
    }
    const byKey = new Map<string, Float32Array>();
    for (const [i, key] of [...answers.keys()].entries()) byKey.set(key, (settled[i] as PromiseFulfilledResult<Float32Array>).value);
    // Copies, so a caller who changes a vector cannot change what is cached.
    return keys.map((k) => Float32Array.from(byKey.get(k)!));
  }

  private async callProvider(texts: string[], kind: InputKind): Promise<Float32Array[]> {
    const attempt = async (n: number) => {
      this.stats.calls++;
      if (n > 0) this.stats.retries++;
      this.stats.textsSent += texts.length;
      const call = () => withTimeout(this.o.timeoutMs, (signal) => this.provider.embed(texts, { kind, signal }));
      const out = this.o.breaker ? await this.o.breaker.call(call) : await call();
      return this.check(out, texts.length);
    };
    return retry(attempt, this.o.retry, this.o.sleep, this.o.random);
  }

  private check(out: readonly ArrayLike<number>[], n: number): Float32Array[] {
    if (!Array.isArray(out) || out.length !== n) throw new BadEmbedding(`${n} texts were sent and ${Array.isArray(out) ? out.length : 'no list of'} vectors came back`);
    return out.map((v, i) => {
      if (!v || v.length !== this.provider.dim) throw new DimensionMismatch(`vector ${i} has ${v?.length} numbers; ${this.provider.model} has ${this.provider.dim}`);
      const f = new Float32Array(this.provider.dim);
      for (let k = 0; k < f.length; k++) {
        const x = v[k]!;
        if (typeof x !== 'number' || !Number.isFinite(x)) throw new BadEmbedding(`vector ${i} holds a value that is not a finite number`);
        f[k] = x;
      }
      return f;
    });
  }
}

export { BreakerOpen, TimedOut };
