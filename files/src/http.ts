/**
 * The HTTP plumbing every route shares: a request with its body as a stream, the signed-in person from Basic
 * authentication (a login password or an app password), throttling of wrong passwords per address, and one
 * place that turns block errors into the status codes clients expect.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NotSignedIn } from '../../intent/blocks/devices/index.ts';
import { BadIf, BadXml } from '../../intent/blocks/dav/index.ts';
import { Refused, Throttled } from '../../intent/blocks/grants/index.ts';
import { Held } from '../../intent/blocks/leases/index.ts';
import { Missing, TooLarge } from '../../intent/blocks/objects/index.ts';
import { Limited, SignInFailures } from '../../intent/blocks/ratelimit/index.ts';
import { Unsafe } from '../../intent/blocks/uploadsafe/index.ts';
import { Exists, IntoItself, InvalidName, MissingParent, NotFound } from '../../intent/blocks/tree/index.ts';
import { BadChunk, NoSession, OverQuota, WrongLength } from '../../intent/blocks/uploads/index.ts';
import { Denied, Insufficient, PreconditionFailed, type Files } from './app.ts';
import type { Person } from './state.ts';

export interface Req {
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly ip: string;
  readonly raw: IncomingMessage;
  person?: Person;
  device?: number;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | AsyncIterable<Uint8Array>;
}

export const header = (r: Req, h: string) => r.headers[h.toLowerCase()];

/** The body as text, capped, for XML and form requests. */
export async function text(r: Req, max = 1_000_000): Promise<string> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of r.raw) {
    n += (c as Buffer).length;
    if (n > max) throw new TooLarge(max);
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The body as a stream of bytes, for uploads. */
export const stream = (r: Req): AsyncIterable<Uint8Array> => r.raw as AsyncIterable<Uint8Array>;

/** Form fields from a urlencoded or JSON body, and from the query string. */
export async function fields(r: Req): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.fromEntries(r.url.searchParams);
  if (r.method === 'GET' || r.method === 'HEAD') return out;
  const t = await text(r);
  if (!t) return out;
  const type = (header(r, 'content-type') ?? '').toLowerCase();
  if (type.includes('json')) {
    const j = JSON.parse(t) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) if (v !== null && v !== undefined) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  } else for (const [k, v] of new URLSearchParams(t)) out[k] = v;
  return out;
}

/**
 * Wrong passwords, counted per address and login name (ten a minute) and per address over every login (thirty a
 * minute). Every way in counts against the same limits (Basic, the web sign-in, the app sign-in page). A right
 * password clears only that address's mistakes at that login, so a person who mistyped is not held back once they
 * get it right, while signing in to an account of your own between guesses at someone else's buys no more guesses.
 * One limit per server, so two servers in one process (as in tests) do not share it.
 */
const limits = new WeakMap<Files, SignInFailures>();
const signIns = (files: Files) => {
  let f = limits.get(files);
  if (!f) limits.set(files, (f = new SignInFailures({ perLogin: 10, perAddress: 30, windowMs: 60_000 }, { what: 'too many failed sign-ins from this address' })));
  return f;
};

/** Checks a login name and password (or app password), counted against the address's limits. */
export async function signInAs(files: Files, r: Req, user: string, password: string): ReturnType<Files['signIn']> {
  const lim = signIns(files);
  lim.check(r.ip, user);
  try {
    const s = await files.signIn(user, password);
    lim.succeed(r.ip, user);
    return s;
  } catch (e) {
    lim.fail(r.ip, user);
    throw e;
  }
}

/** Signs the request in from its Basic credentials; returns false when it carries none. */
export async function authenticate(files: Files, r: Req): Promise<boolean> {
  const h = header(r, 'authorization');
  if (!h?.startsWith('Basic ')) return false;
  const raw = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) throw new NotSignedIn();
  let user: string;
  try {
    user = decodeURIComponent(raw.slice(0, i));
  } catch {
    user = raw.slice(0, i);
  }
  const s = await signInAs(files, r, user, raw.slice(i + 1));
  r.person = s.person;
  if (s.device !== undefined) r.device = s.device;
  return true;
}

/** The status a block error means to a client. */
export function statusOf(e: unknown): { status: number; message: string; retryAfter?: number } {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof NotSignedIn) return { status: 401, message: m };
  if (e instanceof Limited || e instanceof Throttled) return { status: 429, message: m, retryAfter: Math.ceil(e.retryAfterMs / 1000) };
  if (e instanceof Unsafe) return { status: 400, message: m };
  if (e instanceof Denied) return { status: e.status, message: m };
  if (e instanceof NotFound || e instanceof Missing || e instanceof NoSession) return { status: 404, message: m };
  if (e instanceof MissingParent) return { status: 409, message: m };
  if (e instanceof IntoItself) return { status: 403, message: m };
  if (e instanceof Exists) return { status: 405, message: m };
  if (e instanceof PreconditionFailed) return { status: 412, message: m };
  if (e instanceof Held) return { status: 423, message: m };
  if (e instanceof Insufficient || e instanceof OverQuota) return { status: 507, message: m };
  if (e instanceof TooLarge) return { status: 413, message: m };
  if (e instanceof InvalidName || e instanceof BadChunk || e instanceof BadXml || e instanceof BadIf || e instanceof WrongLength || e instanceof SyntaxError || e instanceof URIError) return { status: 400, message: m };
  if (e instanceof Refused) return { status: 400, message: m };
  return { status: 500, message: 'something went wrong on the server' };
}

export async function send(res: ServerResponse, method: string, out: Reply): Promise<void> {
  const h: Record<string, string> = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...(out.headers ?? {}) };
  const b = out.body;
  if (typeof b === 'string' || b instanceof Uint8Array) {
    const buf = typeof b === 'string' ? Buffer.from(b) : b;
    h['content-length'] ??= String(buf.length);
    res.writeHead(out.status, h);
    res.end(method === 'HEAD' ? undefined : buf);
    return;
  }
  res.writeHead(out.status, h);
  if (!b || method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(Readable.from(b), res);
}

export const xml = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({ status, headers: { 'content-type': 'application/xml; charset=utf-8', ...headers }, body });
export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) });
export const html = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...headers }, body });

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The Sabre exception class Nextcloud names in an error body for each status. */
const SABRE: Readonly<Record<number, string>> = {
  400: 'BadRequest',
  401: 'NotAuthenticated',
  403: 'Forbidden',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  409: 'Conflict',
  412: 'PreconditionFailed',
  415: 'UnsupportedMediaType',
  416: 'RequestedRangeNotSatisfiable',
  423: 'Locked',
  501: 'NotImplemented',
  503: 'ServiceUnavailable',
  507: 'InsufficientStorage',
};

/**
 * A WebDAV error body, as Sabre shapes it, which is what Nextcloud clients parse for the message. `about` names
 * the request header the error is about, as Sabre's s:header does (Overwrite, If-Match).
 */
export const davError = (status: number, message: string, about?: string): Reply =>
  xml(status, `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>${esc(SABRE[status] ? `Sabre\\DAV\\Exception\\${SABRE[status]}` : 'Sabre\\DAV\\Exception')}</s:exception><s:message>${esc(message)}</s:message>${about ? `<s:header>${esc(about)}</s:header>` : ''}</d:error>`);
