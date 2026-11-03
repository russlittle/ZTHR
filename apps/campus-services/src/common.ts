import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';

/**
 * Shared plumbing for the synthetic campus services. Each service is a stand-alone HTTP API shaped like the kind
 * of vendor a college already uses (a dining platform, a transit agency's GTFS feeds, a job board, a learning
 * management system). The data is synthetic and deterministic: the same request at the same clock gives the same
 * answer, so tests and walks can rely on it, and anyone can point the Advocate at a real vendor with the same
 * contract instead.
 *
 * Controls every service honors:
 *  - `at` query parameter or `X-Twin-Clock` header: the service's notion of now (ISO date-time). Default: real now.
 *  - `X-Twin-Scenario` header: `outage` (503), `slow` (adds 1.5 s), plus service-specific scenarios.
 */
export const CAMPUSES = {
  sinclair: { name: 'Sinclair College', city: 'Dayton', lat: 39.7573, lon: -84.1985 },
  'wright-state': { name: 'Wright State University', city: 'Fairborn', lat: 39.7817, lon: -84.0632 },
  antioch: { name: 'Antioch College', city: 'Yellow Springs', lat: 39.8047, lon: -83.8888 },
} as const;
export type CampusId = keyof typeof CAMPUSES;
export const CAMPUS_IDS = Object.keys(CAMPUSES) as CampusId[];

/** A small deterministic generator seeded from a string. */
export function rng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

export const pad = (n: number) => String(n).padStart(2, '0');
export const hhmm = (min: number) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
export const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

/** The service clock in campus local time (America/New_York), as date and minutes after midnight. */
export function clock(c: Context): { iso: string; date: string; min: number } {
  const raw = c.req.query('at') ?? c.req.header('x-twin-clock');
  const d = raw ? new Date(raw) : new Date();
  if (Number.isNaN(d.getTime())) throw new BadRequest(`not a date-time: ${raw}`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { iso: d.toISOString(), date: `${g('year')}-${g('month')}-${g('day')}`, min: Number(g('hour')) * 60 + Number(g('minute')) };
}

export class BadRequest extends Error {}
export class NotFound extends Error {}

export interface ServiceInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  /** Endpoints, for the generated OpenAPI document and the contract tests. */
  endpoints: { method: 'GET' | 'POST'; path: string; summary: string; query?: Record<string, string> }[];
  scenarios: Record<string, string>;
}

/** Wraps a service: health, OpenAPI, scenarios, errors, and the synthetic marker on every response. */
export function service(info: ServiceInfo, routes: (app: Hono) => void): Hono {
  const app = new Hono({ strict: false });
  app.use('*', async (c, next) => {
    const scenario = c.req.header('x-twin-scenario');
    if (scenario === 'outage') return c.json({ error: 'service unavailable', scenario }, 503);
    if (scenario === 'slow') await new Promise((r) => setTimeout(r, 1500));
    await next();
    c.header('x-synthetic-service', info.id);
  });
  app.get('/healthz', (c) => c.json({ ok: true, service: info.id, version: info.version }));
  app.get('/openapi.json', (c) => c.json(openapi(info)));
  routes(app);
  app.onError((e, c) => {
    if (e instanceof BadRequest) return c.json({ error: e.message }, 400);
    if (e instanceof NotFound) return c.json({ error: e.message }, 404);
    throw e;
  });
  app.notFound((c) => c.json({ error: 'no such endpoint', see: '/openapi.json' }, 404));
  return app;
}

export function openapi(info: ServiceInfo) {
  return {
    openapi: '3.1.0',
    info: { title: info.title, version: info.version, description: `${info.description}\n\nSynthetic service: deterministic data for building and testing. Scenarios (X-Twin-Scenario header): ${Object.entries({ outage: 'returns 503', slow: 'adds 1.5 s', ...info.scenarios }).map(([k, v]) => `${k}: ${v}`).join('; ')}.` },
    paths: Object.fromEntries(
      info.endpoints.map((e) => [
        e.path.replace(/:(\w+)/g, '{$1}'),
        {
          [e.method.toLowerCase()]: {
            summary: e.summary,
            parameters: [
              ...[...e.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
              ...Object.entries(e.query ?? {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: { type: 'string' } })),
              { name: 'at', in: 'query', required: false, description: 'Service clock (ISO date-time)', schema: { type: 'string' } },
            ],
            responses: { 200: { description: 'OK' }, 400: { description: 'Bad request' }, 404: { description: 'Not found' }, 503: { description: 'Outage scenario' } },
          },
        },
      ]),
    ),
  };
}

export function campusParam(c: Context): CampusId {
  const v = c.req.query('campus');
  if (!v) throw new BadRequest('campus is required: sinclair, wright-state or antioch');
  if (!(v in CAMPUSES)) throw new NotFound(`no campus ${v}`);
  return v as CampusId;
}

export function dateParam(c: Context, name = 'date'): string {
  const v = c.req.query(name) ?? clock(c).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return v;
}

/** Distance in meters between two points. */
export function meters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}
