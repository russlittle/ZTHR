/**
 * Cloud Storage as the object store and as the place the state document is kept. It talks to the JSON API with
 * the service account Cloud Run gives the container (no key file, no SDK). Joins use the bucket's own compose, so
 * an upload's chunks are never downloaded again; the state document is written with a generation precondition, so
 * a second instance writing at the same time is refused instead of silently overwriting.
 */
import { randomUUID } from 'node:crypto';
import { Digest, Missing, TooLarge, type Algo, type ObjectStore, type Range, type Written } from '../../intent/blocks/objects/index.ts';
import { retry, withTimeout } from '../../intent/blocks/resilience/index.ts';
import type { Persist } from './state.ts';

export interface GcsOptions {
  readonly bucket: string;
  /** Under this prefix in the bucket. */
  readonly prefix?: string;
  /** For tests: where the API is, and how to get a token. */
  readonly api?: string;
  readonly token?: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

let cached: { token: string; until: number } | null = null;

/** The container's own service-account token, from the metadata server, cached until a minute before it expires. */
export async function metadataToken(f: typeof fetch = fetch): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const r = await f('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'metadata-flavor': 'Google' } });
  if (!r.ok) throw new Error(`metadata server answered ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

class GcsError extends Error {
  readonly status: number;
  constructor(status: number, what: string) {
    super(`Cloud Storage answered ${status} to ${what}`);
    this.status = status;
  }
}

const retryable = (e: unknown) => !(e instanceof GcsError) || e.status === 429 || e.status >= 500;

export function gcsObjects(o: GcsOptions): ObjectStore {
  const api = o.api ?? 'https://storage.googleapis.com';
  const f = o.fetch ?? fetch;
  const token = o.token ?? (() => metadataToken(f));
  const prefix = o.prefix ?? 'objects/';
  const name = (key: string) => {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Missing(key);
    return `${prefix}${key}`;
  };
  const obj = (key: string) => `${api}/storage/v1/b/${encodeURIComponent(o.bucket)}/o/${encodeURIComponent(name(key))}`;
  const auth = async () => ({ authorization: `Bearer ${await token()}` });
  const call = (what: string, run: (signal: AbortSignal) => Promise<Response>, okStatus: (s: number) => boolean = (s) => s < 300) =>
    retry(async () => {
      const r = await withTimeout(120_000, (signal) => run(signal));
      if (!okStatus(r.status)) {
        await r.body?.cancel();
        if (r.status === 404) throw new Missing(what);
        throw new GcsError(r.status, what);
      }
      return r;
    }, { attempts: 4, baseMs: 250, maxMs: 4000, retryable: (e) => !(e instanceof Missing) && retryable(e) });

  const store: ObjectStore = {
    async put(data, opts = {}) {
      const key = randomUUID();
      const d = new Digest(opts.algos ?? (['MD5', 'SHA1', 'ADLER32'] as Algo[]));
      const max = opts.maxBytes;
      async function* counted() {
        for await (const c of data instanceof Uint8Array ? [data] : data) {
          d.update(c);
          if (max !== undefined && d.size > max) throw new TooLarge(max);
          yield c;
        }
      }
      // A streamed upload cannot be replayed, so it is sent once; a failure leaves no object and the client retries.
      const r = await f(`${api}/upload/storage/v1/b/${encodeURIComponent(o.bucket)}/o?uploadType=media&name=${encodeURIComponent(name(key))}`, { method: 'POST', headers: { ...(await auth()), 'content-type': 'application/octet-stream' }, body: counted() as unknown as BodyInit, duplex: 'half' } as RequestInit);
      if (!r.ok) {
        await r.body?.cancel();
        throw new GcsError(r.status, 'an upload');
      }
      await r.body?.cancel();
      return { key, size: d.size, checksums: d.result() };
    },
    async get(key, range?: Range) {
      const r = await call(key, async (signal) => f(`${obj(key)}?alt=media`, { signal, headers: { ...(await auth()), ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}) } }));
      if (!r.body) return (async function* () {})();
      return r.body as unknown as AsyncIterable<Uint8Array>;
    },
    async size(key) {
      try {
        const r = await call(key, async (signal) => f(`${obj(key)}?fields=size`, { signal, headers: await auth() }));
        return Number(((await r.json()) as { size: string }).size);
      } catch (e) {
        if (e instanceof Missing) return undefined;
        throw e;
      }
    },
    async delete(key) {
      await call(key, async (signal) => f(obj(key), { signal, method: 'DELETE', headers: await auth() }), (s) => s < 300 || s === 404);
    },
    async compose(keys): Promise<Written> {
      if (keys.length > 32) throw new Error('Cloud Storage joins at most 32 objects in one call');
      const key = randomUUID();
      const r = await call('a join', async (signal) => f(`${obj(key)}/compose`, { signal, method: 'POST', headers: { ...(await auth()), 'content-type': 'application/json' }, body: JSON.stringify({ sourceObjects: keys.map((k) => ({ name: name(k) })), destination: { contentType: 'application/octet-stream' } }) }));
      const meta = (await r.json()) as { size: string };
      return { key, size: Number(meta.size), checksums: [] };
    },
  };
  return store;
}

/**
 * The state's log in the bucket: one small object per entry, created only if it does not exist (so a second writer
 * is refused, never interleaved), and a snapshot that lets the entries before it be deleted.
 */
export function gcsPersist(o: GcsOptions & { folder?: string }): Persist {
  const api = o.api ?? 'https://storage.googleapis.com';
  const f = o.fetch ?? fetch;
  const token = o.token ?? (() => metadataToken(f));
  const folder = `${o.prefix ?? ''}${o.folder ?? 'state/'}`;
  const b = encodeURIComponent(o.bucket);
  const entry = (n: number) => `${folder}log/${String(n).padStart(12, '0')}.json`;
  const auth = async () => ({ authorization: `Bearer ${await token()}` });
  const policy = { attempts: 4, baseMs: 250, maxMs: 4000, retryable };
  const read = async (name: string): Promise<string | null> => {
    const r = await f(`${api}/storage/v1/b/${b}/o/${encodeURIComponent(name)}?alt=media`, { headers: await auth() });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) throw new GcsError(r.status, `reading ${name}`);
    return r.text();
  };
  const write = (name: string, text: string, ifGeneration?: string) =>
    retry(async () => {
      const r = await f(`${api}/upload/storage/v1/b/${b}/o?uploadType=media&name=${encodeURIComponent(name)}${ifGeneration !== undefined ? `&ifGenerationMatch=${ifGeneration}` : ''}`, { method: 'POST', headers: { ...(await auth()), 'content-type': 'application/json' }, body: text });
      if (r.status === 412) throw new Error(`${name} was written by another instance; refusing to overwrite it`);
      if (!r.ok) throw new GcsError(r.status, `writing ${name}`);
      await r.body?.cancel();
    }, policy);
  const list = async (prefix: string): Promise<string[]> => {
    const names: string[] = [];
    let page = '';
    do {
      const r = await f(`${api}/storage/v1/b/${b}/o?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: await auth() });
      if (!r.ok) throw new GcsError(r.status, 'listing the log');
      const j = (await r.json()) as { items?: { name: string }[]; nextPageToken?: string };
      names.push(...(j.items ?? []).map((i) => i.name));
      page = j.nextPageToken ?? '';
    } while (page);
    return names.sort();
  };
  return {
    async load() {
      const snapshot = await read(`${folder}snapshot.json`);
      const after = snapshot ? (JSON.parse(snapshot) as { n: number }).n : 0;
      const names = (await list(`${folder}log/`)).filter((n) => Number(/(\d+)\.json$/.exec(n)?.[1]) > after);
      const log: string[] = [];
      for (const n of names) log.push((await read(n))!);
      return { snapshot, log };
    },
    append: (n, text) => write(entry(n), text, '0'),
    async snapshot(n, text) {
      await write(`${folder}snapshot.json`, text);
      for (const name of await list(`${folder}log/`))
        if (Number(/(\d+)\.json$/.exec(name)?.[1]) <= n) {
          const r = await f(`${api}/storage/v1/b/${b}/o/${encodeURIComponent(name)}`, { method: 'DELETE', headers: await auth() });
          await r.body?.cancel();
        }
    },
  };
}
