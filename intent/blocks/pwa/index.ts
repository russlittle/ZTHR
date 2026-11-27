/**
 * Installable and usable offline. The web app manifest is built and checked against what browsers need to offer
 * installation (name, start URL, display mode, a 192 and a 512 pixel icon, a maskable icon). A caching plan says,
 * per kind of request, which strategy the service worker uses (cache first for versioned assets, network first for
 * pages with an offline fallback, never cache for the API), and renders the worker. Changes made offline go into a
 * queue that replays in order when the connection returns, each with an idempotency key so a replay never applies
 * twice; one the server refuses is set aside for the person to see, not retried for ever.
 */

export interface Icon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: 'any' | 'maskable' | 'any maskable';
}

export interface Manifest {
  readonly name: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly Icon[];
  readonly id?: string;
  readonly description?: string;
}

export function checkManifest(m: Manifest): string[] {
  const out: string[] = [];
  if (!m.name.trim()) out.push('a name is needed');
  if (m.short_name.length > 12) out.push(`the short name "${m.short_name}" is over 12 characters and will be cut on home screens`);
  if (!m.start_url.startsWith(m.scope)) out.push('the start URL must be inside the scope');
  if (m.display === 'browser') out.push('display "browser" cannot be installed as an app');
  const sizes = new Set(m.icons.flatMap((i) => i.sizes.split(' ')));
  for (const s of ['192x192', '512x512']) if (!sizes.has(s)) out.push(`an icon of ${s} is needed`);
  if (!m.icons.some((i) => i.purpose?.includes('maskable'))) out.push('add a maskable icon so it is not boxed on Android');
  for (const c of [m.background_color, m.theme_color]) if (!/^#[0-9a-f]{6}$/i.test(c)) out.push(`${c} is not a #rrggbb colour`);
  return out;
}

export type Strategy = 'cacheFirst' | 'networkFirst' | 'staleWhileRevalidate' | 'networkOnly';

export interface Route {
  readonly match: string;
  readonly strategy: Strategy;
  readonly cache?: string;
}

/**
 * The service worker source for a plan. Routes are regexes over the path, first match wins. Activation keeps only
 * this version's caches (the precache and each route's cache) and deletes every other.
 */
export function worker(o: { version: string; precache: readonly string[]; routes: readonly Route[]; offline: string }): string {
  const routes = o.routes.map((r) => `[${JSON.stringify(r.match)},${JSON.stringify(r.strategy)},${JSON.stringify(r.cache ?? `rt-${o.version}`)}]`).join(',');
  return `const V=${JSON.stringify(o.version)},PRE=${JSON.stringify(o.precache)},OFF=${JSON.stringify(o.offline)},R=[${routes}].map(([m,s,c])=>[new RegExp(m),s,c]);
self.addEventListener('install',e=>e.waitUntil(caches.open('pre-'+V).then(c=>c.addAll([...PRE,OFF])).then(()=>self.skipWaiting())));
const KEEP=new Set(['pre-'+V,...R.map(([,,c])=>c)]);
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>!KEEP.has(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;const r=R.find(([m])=>m.test(u.pathname));if(!r||r[1]==='networkOnly')return;const [,s,c]=r;
const net=()=>fetch(e.request).then(res=>{if(res.ok){const cl=res.clone();caches.open(c).then(x=>x.put(e.request,cl));}return res;});
if(s==='cacheFirst')e.respondWith(caches.match(e.request).then(h=>h||net()));
else if(s==='networkFirst')e.respondWith(net().catch(()=>caches.match(e.request).then(h=>h||(e.request.mode==='navigate'?caches.match(OFF):Response.error()))));
else e.respondWith(caches.match(e.request).then(h=>{const n=net().catch(()=>h);return h||n;}));});
`;
}

export interface Queued {
  readonly key: string;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly at: string;
  tries: number;
  refused?: { status: number; detail: string };
}

export class OfflineQueue {
  readonly items: Queued[] = [];
  private n = 0;
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  add(method: Queued['method'], path: string, body?: unknown): Queued {
    const q: Queued = { key: `off-${this.now().getTime().toString(36)}-${++this.n}-${globalThis.crypto.randomUUID()}`, method, path, ...(body !== undefined ? { body } : {}), at: this.now().toISOString(), tries: 0 };
    this.items.push(q);
    return q;
  }
  /** Replays in order; stops at the first network failure (still offline) so order is kept. */
  async replay(send: (q: Queued) => Promise<{ status: number; detail?: string }>): Promise<{ sent: number; refused: number; waiting: number }> {
    let sent = 0;
    let refused = 0;
    for (const q of this.items) {
      if (q.refused) continue;
      q.tries++;
      let r: { status: number; detail?: string };
      try {
        r = await send(q);
      } catch {
        break;
      }
      if (r.status >= 200 && r.status < 300) {
        sent++;
        (q as { done?: boolean }).done = true;
      } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        q.refused = { status: r.status, detail: r.detail ?? 'the server refused this change' };
        refused++;
      } else break;
    }
    for (let i = this.items.length - 1; i >= 0; i--) if ((this.items[i] as { done?: boolean }).done) this.items.splice(i, 1);
    return { sent, refused, waiting: this.items.filter((q) => !q.refused).length };
  }
  /** Changes the server refused, for the person to fix or drop. */
  needsYou(): Queued[] {
    return this.items.filter((q) => q.refused);
  }
  drop(key: string): void {
    const i = this.items.findIndex((q) => q.key === key);
    if (i >= 0) this.items.splice(i, 1);
  }
}
