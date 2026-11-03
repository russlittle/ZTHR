/**
 * @zthr/egress — the one door to the network for app code (PRD P2).
 *
 * Apps never call fetch directly; the no-hidden-egress gate fails any file outside this block and the model
 * client that does. Every request names its purpose, goes only to a host on the allow-list the app declared at
 * start-up, and is recorded. Tests and walks use the twin, which records the same way and never leaves the box.
 */
export interface EgressRequest {
  purpose: string;
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface EgressResponse {
  status: number;
  body: string;
}

export interface Egress {
  send(req: EgressRequest): Promise<EgressResponse>;
  readonly log: { at: string; purpose: string; method: string; host: string; status: number | 'refused' }[];
}

export class EgressRefused extends Error {}

const hostOf = (url: string): string => {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new EgressRefused(`only https is allowed: ${u.protocol}`);
  return u.hostname.toLowerCase();
};

/** Matches exact hosts, and "*.example.com" for any subdomain. */
export const allowed = (host: string, allow: string[]): boolean => allow.some((a) => (a.startsWith('*.') ? host.endsWith(a.slice(1)) && host.length > a.length - 1 : host === a));

export function realEgress(allow: string[], timeoutMs = 8000): Egress {
  const log: Egress['log'] = [];
  return {
    log,
    async send(req) {
      const host = hostOf(req.url);
      if (!allowed(host, allow)) {
        log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: 'refused' });
        throw new EgressRefused(`${host} is not on the egress allow-list`);
      }
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetch(req.url, { method: req.method, body: req.body, headers: req.headers, signal: ctl.signal, redirect: 'error' });
        const body = await r.text();
        log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: r.status });
        return { status: r.status, body };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** A recording stand-in with scripted answers per host; refuses hosts off the allow-list exactly like the real one. */
export class EgressTwin implements Egress {
  readonly log: Egress['log'] = [];
  readonly sent: EgressRequest[] = [];
  constructor(
    private readonly allow: string[] = ['*'],
    private readonly answer: (req: EgressRequest) => EgressResponse = () => ({ status: 200, body: '{}' }),
  ) {}
  async send(req: EgressRequest): Promise<EgressResponse> {
    const host = hostOf(req.url);
    if (!this.allow.includes('*') && !allowed(host, this.allow)) {
      this.log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: 'refused' });
      throw new EgressRefused(`${host} is not on the egress allow-list`);
    }
    this.sent.push(req);
    const r = this.answer(req);
    this.log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: r.status });
    return r;
  }
}

/** Anything with a fetch handler, such as a Hono app. */
export interface FetchHandler {
  fetch(req: Request): Response | Promise<Response>;
}

/**
 * Routes requests for the listed hosts to in-process services instead of the network, and sends everything else
 * through `fallback` (or refuses it). Used to run synthetic campus services inside the demo and the tests: the
 * app's code path is the same `send` it uses against real vendors, only the transport differs.
 */
export function routedEgress(routes: Record<string, FetchHandler>, fallback?: Egress, headers: () => Record<string, string> = () => ({})): Egress {
  const log: Egress['log'] = [];
  return {
    log,
    async send(req) {
      const host = hostOf(req.url);
      const target = routes[host];
      if (!target) {
        if (!fallback) {
          log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: 'refused' });
          throw new EgressRefused(`${host} is not on the egress allow-list`);
        }
        const r = await fallback.send(req);
        log.push(fallback.log[fallback.log.length - 1] ?? { at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: r.status });
        return r;
      }
      const r = await target.fetch(new Request(req.url, { method: req.method, body: req.body, headers: { ...headers(), ...req.headers } }));
      const body = await r.text();
      log.push({ at: new Date().toISOString(), purpose: req.purpose, method: req.method, host, status: r.status });
      return { status: r.status, body };
    },
  };
}
