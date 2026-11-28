import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache } from '../cache/index.ts';
import { Breaker, BreakerOpen, TimedOut } from '../resilience/index.ts';
import { BadEmbedding, BadRequest, DimensionMismatch, Embedder, EmbeddingFailed, ProviderError, assertSameSpace, cosine, twin, words } from './index.ts';
import type { EmbeddingProvider } from './index.ts';

const noSleep = async () => {};
const mk = (o: Partial<ConstructorParameters<typeof Embedder>[0]> = {}, p = twin({ dim: 32, maxBatch: 10 })) => ({ p, e: new Embedder({ provider: p, sleep: noSleep, random: () => 0.5, ...o }) });

/** A provider whose answers a test controls. */
function scripted(dim: number, script: (texts: readonly string[], call: number, signal: AbortSignal) => Promise<ArrayLike<number>[]> | ArrayLike<number>[], model = 'scripted'): EmbeddingProvider & { calls: number } {
  const p = {
    model,
    dim,
    maxBatch: 4,
    calls: 0,
    async embed(texts: readonly string[], o: { signal: AbortSignal }) {
      return script(texts, p.calls++, o.signal);
    },
  };
  return p;
}
const unit = (dim: number, hot = 0) => Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0));

test('the twin gives the same unit vector for the same text, close vectors for shared words, far for unrelated', async () => {
  const a = twin({ dim: 256 });
  const [x1, y1, z1] = (await a.embed(['the quick brown fox', 'the quick brown fox', 'a quick brown dog'], { kind: 'document', signal: new AbortController().signal })) as number[][];
  assert.deepEqual(x1, y1);
  assert.ok(Math.abs(Math.hypot(...x1!) - 1) < 1e-9, 'unit length');
  const [w] = (await twin({ dim: 256 }).embed(['the quick brown fox'], { kind: 'document', signal: new AbortController().signal })) as number[][];
  assert.deepEqual(w, x1, 'another instance, the same vector');
  const [far] = (await a.embed(['quantum chromodynamics lattice'], { kind: 'document', signal: new AbortController().signal })) as number[][];
  assert.ok(cosine(x1!, z1!) > 0.5, `shared words: ${cosine(x1!, z1!)}`);
  assert.ok(cosine(x1!, far!) < 0.3, `unrelated: ${cosine(x1!, far!)}`);
  const [caps, accent] = (await a.embed(['THE QUICK BROWN FOX', 'Thé quick brown fox'], { kind: 'document', signal: new AbortController().signal })) as number[][];
  assert.deepEqual(caps, x1, 'case does not matter');
  assert.ok(cosine(accent!, x1!) > 0.5);
  const [punct1, punct2] = (await a.embed(['?!', '...'], { kind: 'document', signal: new AbortController().signal })) as number[][];
  assert.ok(Math.abs(Math.hypot(...punct1!) - 1) < 1e-9, 'even punctuation alone gives a unit vector');
  assert.notDeepEqual(punct1, punct2);
  assert.throws(() => twin({ dim: 4 }), RangeError);
  assert.deepEqual(words('Hello, wörld! 42'), ['hello', 'wörld', '42']);
});

test('many texts are cut into provider calls of at most maxBatch, in order, and the answers come back in the order asked', async () => {
  const { p, e } = mk();
  const texts = Array.from({ length: 25 }, (_, i) => `text number ${i}`);
  const out = await e.embed(texts);
  assert.deepEqual(p.calls.map((c) => c.texts.length), [10, 10, 5]);
  assert.equal(out.length, 25);
  const direct = await twin({ dim: 32 }).embed(texts, { kind: 'document', signal: new AbortController().signal });
  out.forEach((v, i) => assert.deepEqual([...v].map((x) => Math.fround(x)), (direct[i] as number[]).map((x) => Math.fround(x))));
  assert.equal(e.stats.textsSent, 25);
  const small = mk({ maxBatchChars: 30 });
  await small.e.embed(['a'.repeat(12), 'b'.repeat(12), 'c'.repeat(12)]);
  assert.deepEqual(small.p.calls.map((c) => c.texts.length), [2, 1], 'a call is also limited by its size in characters');
});

test('texts are cached by content: nothing is sent again, a repeat within a request is sent once, and equal text in other forms is the same', async () => {
  const { p, e } = mk();
  await e.embed(['alpha', 'beta', 'alpha']);
  assert.deepEqual(p.calls.map((c) => c.texts), [['alpha', 'beta']]);
  await e.embed(['beta', 'alpha']);
  assert.equal(p.calls.length, 1, 'both from the cache');
  assert.deepEqual([e.stats.cacheHits, e.stats.cacheMisses], [2, 2]);
  await e.embed(['  alpha\n']);
  assert.equal(p.calls.length, 1, 'surrounding space does not change the text');
  await e.embed(['café']);
  await e.embed(['café']);
  assert.equal(p.calls.length, 2, 'composed and decomposed é are one text');
  assert.equal(e.key('x'), e.key(' x '));
  assert.notEqual(e.key('x'), e.key('y'));
  assert.notEqual(e.key('x', 'document'), e.key('x', 'query'));
  assert.match(e.key('x'), /^[0-9a-f]{64}$/);
});

test('the model is part of the key: two models sharing one cache never see each other\'s vectors, and forget drops one model', async () => {
  const shared = new Cache<Float32Array>({ ttlMs: 60_000 });
  const a = mk({ cache: shared }, twin({ dim: 32, model: 'model-a' }));
  const b = mk({ cache: shared }, twin({ dim: 32, model: 'model-b' }));
  await a.e.embed(['hello']);
  await b.e.embed(['hello']);
  assert.equal(b.p.calls.length, 1, 'model b asked its own provider');
  assert.notEqual(a.e.key('hello'), b.e.key('hello'));
  await a.e.embed(['hello']);
  assert.equal(a.p.calls.length, 1);
  assert.equal(a.e.forget(), 1);
  await a.e.embed(['hello']);
  assert.equal(a.p.calls.length, 2, 'model a was forgotten');
  await b.e.embed(['hello']);
  assert.equal(b.p.calls.length, 1, 'model b was not');
  const d16 = mk({ cache: shared }, twin({ dim: 16, model: 'model-a' }));
  assert.notEqual(d16.e.key('hello'), a.e.key('hello'), 'the same name with another dimension is another key');
});

test('queries and documents are embedded as what they are, and cached apart', async () => {
  const { p, e } = mk();
  await e.embed(['red shoes']);
  await e.embedQuery(['red shoes']);
  assert.deepEqual(p.calls.map((c) => c.kind), ['document', 'query']);
  await e.embedQuery(['red shoes']);
  assert.equal(p.calls.length, 2);
  assert.equal((await e.embedOne('red shoes')).length, 32);
});

test('bad requests are refused before any call: empty, not a string, too long, too many', async () => {
  const { p, e } = mk({ maxChars: 20, maxTexts: 3, maxTotalChars: 30 });
  await assert.rejects(e.embed(['ok', '   ']), (x) => x instanceof BadRequest && x.index === 1 && /empty/.test(x.message));
  await assert.rejects(e.embed(['ok', 5 as never]), (x) => x instanceof BadRequest && x.index === 1);
  await assert.rejects(e.embed(['x'.repeat(21)]), /is 21 characters; the limit is 20/);
  await assert.rejects(e.embed(['a', 'b', 'c', 'd']), /at most 3 texts/);
  await assert.rejects(e.embed(['x'.repeat(16), 'y'.repeat(16)]), /more than 30 characters in all/);
  await assert.rejects(e.embed('not a list' as never), BadRequest);
  assert.equal(p.calls.length, 0);
  assert.deepEqual(await e.embed([]), []);
  const cut = mk({ maxChars: 5, tooLong: 'cut' });
  await cut.e.embed(['abcdefgh']);
  assert.deepEqual(cut.p.calls[0]!.texts, ['abcde']);
  const emoji = mk({ maxChars: 3, tooLong: 'cut' });
  await emoji.e.embed(['ab\u{1F600}cd']);
  assert.deepEqual(emoji.p.calls[0]!.texts, ['ab'], 'never half of a surrogate pair');
  const ctl = mk();
  await ctl.e.embed(['a\u0000b']);
  assert.deepEqual(ctl.p.calls[0]!.texts, ['a b'], 'control characters become spaces');
});

test('the dimension guard: wrong dimension, wrong count and non-finite numbers are faults, not retried and not cached', async () => {
  const wrongDim = scripted(4, (t) => t.map(() => unit(3)));
  const e1 = new Embedder({ provider: wrongDim, sleep: noSleep });
  await assert.rejects(e1.embed(['a']), (x) => x instanceof DimensionMismatch && /has 3 numbers; scripted has 4/.test(x.message));
  assert.equal(wrongDim.calls, 1, 'a wrong shape is not retried');
  await assert.rejects(e1.embed(['a']), DimensionMismatch);
  assert.equal(wrongDim.calls, 2, 'and was not cached');
  const wrongCount = scripted(4, (t) => t.slice(1).map(() => unit(4)));
  await assert.rejects(new Embedder({ provider: wrongCount, sleep: noSleep }).embed(['a', 'b']), /2 texts were sent and 1 vectors came back/);
  const nan = scripted(4, (t) => t.map(() => [1, NaN, 0, 0]));
  await assert.rejects(new Embedder({ provider: nan, sleep: noSleep }).embed(['a']), BadEmbedding);
  const inf = scripted(4, (t) => t.map(() => [1, Infinity, 0, 0]));
  await assert.rejects(new Embedder({ provider: inf, sleep: noSleep }).embed(['a']), BadEmbedding);
  const notList = scripted(4, () => 'oops' as never);
  await assert.rejects(new Embedder({ provider: notList, sleep: noSleep }).embed(['a']), BadEmbedding);
  assert.throws(() => new Embedder({ provider: { ...wrongDim, dim: 0 } }), RangeError);
  assert.throws(() => new Embedder({ provider: { ...wrongDim, maxBatch: 0 } }), RangeError);
});

test('transient failures are retried with jittered backoff and succeed; faults that say they will not pass are not retried', async () => {
  const waits: number[] = [];
  const flaky = scripted(4, (t, call) => {
    if (call < 2) throw new ProviderError('rate limited', { status: 429 });
    return t.map(() => unit(4));
  });
  const e = new Embedder({ provider: flaky, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
  const [v] = await e.embed(['a']);
  assert.deepEqual([...v!], [1, 0, 0, 0]);
  assert.equal(flaky.calls, 3);
  assert.deepEqual(waits, [100, 200], 'half of 200 then half of 400');
  assert.equal(e.stats.retries, 2);
  const denied = scripted(4, () => {
    throw new ProviderError('invalid api key', { status: 401, retryable: false });
  });
  const e2 = new Embedder({ provider: denied, sleep: noSleep });
  await assert.rejects(e2.embed(['a']), (x) => x instanceof EmbeddingFailed && x.causes[0] instanceof ProviderError && (x.causes[0] as ProviderError).status === 401);
  assert.equal(denied.calls, 1);
  const down = scripted(4, () => {
    throw new ProviderError('unavailable', { status: 503 });
  });
  const e3 = new Embedder({ provider: down, sleep: noSleep });
  await assert.rejects(e3.embed(['a', 'b']), (x) => x instanceof EmbeddingFailed && /unavailable/.test(x.message) && x.causes.length === 1);
  assert.equal(down.calls, 3, 'three attempts, then it gives up');
});

test('a provider that does not answer in time is stopped, and counted as a failure worth retrying', async () => {
  let aborted = 0;
  const hang = scripted(4, (_t, _c, signal) => {
    signal.addEventListener('abort', () => aborted++);
    return new Promise(() => {});
  });
  const e = new Embedder({ provider: hang, timeoutMs: 15, retry: { attempts: 2, baseMs: 1, maxMs: 1, retryable: () => true }, sleep: noSleep });
  await assert.rejects(e.embed(['a']), (x) => x instanceof EmbeddingFailed && x.causes[0] instanceof TimedOut);
  assert.equal(hang.calls, 2);
  assert.equal(aborted, 2, 'each stuck call was told to stop');
});

test('a circuit breaker stops calls to a failing provider and lets one trial through after the cool-down', async () => {
  let now = 0;
  let healthy = false;
  const p = scripted(4, (t) => {
    if (!healthy) throw new ProviderError('down', { status: 500 });
    return t.map(() => unit(4));
  });
  const e = new Embedder({ provider: p, breaker: new Breaker(3, 1000, () => now), retry: { attempts: 1, baseMs: 1, maxMs: 1, retryable: () => true }, sleep: noSleep });
  for (let i = 0; i < 3; i++) await assert.rejects(e.embed([`t${i}`]), EmbeddingFailed);
  assert.equal(p.calls, 3);
  await assert.rejects(e.embed(['t4']), (x) => x instanceof EmbeddingFailed && x.causes[0] instanceof BreakerOpen);
  assert.equal(p.calls, 3, 'failed fast without calling the provider');
  healthy = true;
  now = 1500;
  assert.equal((await e.embed(['t5'])).length, 1);
  assert.equal(p.calls, 4);
  await e.embed(['t6']);
  assert.equal(p.calls, 5, 'closed again');
});

test('a failed batch is not cached, and the batches that worked stay cached so a retry sends only what is missing', async () => {
  let fail = true;
  const p = scripted(4, (t) => {
    if (fail && t.includes('text-5')) throw new ProviderError('bad batch', { retryable: false });
    return t.map(() => unit(4));
  });
  const e = new Embedder({ provider: p, sleep: noSleep });
  const texts = Array.from({ length: 8 }, (_, i) => `text-${i}`);
  await assert.rejects(e.embed(texts), EmbeddingFailed);
  assert.equal(p.calls, 2, 'two batches of four');
  fail = false;
  const out = await e.embed(texts);
  assert.equal(out.length, 8);
  assert.equal(p.calls, 3, 'only the batch that had failed is sent again');
});

test('two callers asking for the same text at the same moment cause one provider call', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = scripted(4, async (t) => {
    await gate;
    return t.map(() => unit(4));
  });
  const e = new Embedder({ provider: p, sleep: noSleep });
  const one = e.embed(['same', 'only-one']);
  const two = e.embed(['same', 'only-two']);
  await new Promise((r) => setImmediate(r));
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.length + b.length, 4);
  assert.equal(p.calls, 2, 'one call for the first request, one for the text only the second wanted');
  assert.deepEqual(a[0], b[0]);
});

test('what comes back is a copy: changing it does not change what is cached', async () => {
  const { e } = mk();
  const [v] = await e.embed(['mutable']);
  v![0] = 999;
  const [again] = await e.embed(['mutable']);
  assert.notEqual(again![0], 999);
  assert.ok(Math.abs(Math.hypot(...again!) - 1) < 1e-5);
});

test('cached vectors expire and the cache is bounded', async () => {
  let now = 0;
  const p = twin({ dim: 16 });
  const e = new Embedder({ provider: p, ttlMs: 1000, maxCached: 2, now: () => now, sleep: noSleep });
  await e.embed(['a']);
  now = 500;
  await e.embed(['a']);
  assert.equal(p.calls.length, 1);
  now = 2000;
  await e.embed(['a']);
  assert.equal(p.calls.length, 2, 'past its time');
  await e.embed(['b', 'c', 'd']);
  await e.embed(['a']);
  assert.equal(p.calls.length, 4, 'a was pushed out by the bound of two');
});

test('vectors of different models or sizes are refused where they would be mixed or compared', () => {
  assertSameSpace({ model: 'm', dim: 8 }, { model: 'm', dim: 8 });
  assert.throws(() => assertSameSpace({ model: 'm1', dim: 8 }, { model: 'm2', dim: 8 }), /cannot be used with/);
  assert.throws(() => assertSameSpace({ model: 'm', dim: 8 }, { model: 'm', dim: 16 }), /8 numbers per vector against 16/);
  assert.throws(() => cosine([1, 2], [1, 2, 3]), DimensionMismatch);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  const { e } = mk();
  assert.deepEqual(e.space, { model: 'twin-32', dim: 32 });
});
