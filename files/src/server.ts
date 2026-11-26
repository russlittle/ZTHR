/**
 * The router: one HTTP server answering the paths Nextcloud's apps call. It signs each request in, sends it to
 * WebDAV, OCS or a page, and records every request as one structured log line (method, route, status, time, who),
 * never with a password, a token or a file name in it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Files } from './app.ts';
import { authenticate, davError, header, json, send, statusOf, type Reply, type Req } from './http.ts';
import { ocs, ocsRoute } from './ocs.ts';
import { home, link, loginFlow, status, wipe } from './pages.ts';
import { davPath, webdav } from './webdav.ts';

export interface ServeOptions {
  /** The address people use, when a proxy sits in front; otherwise it is read from the request. */
  readonly origin?: string;
  readonly log?: (line: Record<string, unknown>) => void;
}

const READS = new Set(['GET', 'HEAD', 'PROPFIND', 'OPTIONS', 'REPORT']);

const routeOf = (path: string) => (path.startsWith('/remote.php') ? 'dav' : path.startsWith('/ocs/') ? 'ocs' : path.startsWith('/s/') ? 'link' : path.startsWith('/index.php/login') ? 'login' : path.split('/').slice(0, 2).join('/') || '/');

export function handler(files: Files, o: ServeOptions = {}) {
  return async (raw: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]));
    const proto = (headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || 'http';
    const host = headers['host'] ?? 'localhost';
    const origin = o.origin ?? `${proto}://${host}`;
    let url: URL;
    try {
      url = new URL(raw.url ?? '/', origin);
    } catch {
      res.writeHead(400).end();
      return;
    }
    // The apps reach some endpoints with and without index.php; both mean the same.
    const path = url.pathname.replace(/^\/index\.php(?=\/(apps|ocs|s)\/)/, '');
    const r: Req = { method: (raw.method ?? 'GET').toUpperCase(), url, path, headers, ip: (headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() || raw.socket.remoteAddress || '', raw };
    let out: Reply;
    try {
      out = await route(files, r, origin);
      // A change is answered only once it is in the log, so nothing a client was told is saved can be lost.
      if (!READS.has(r.method)) await files.state.flush();
    } catch (e) {
      const s = statusOf(e);
      out = path.startsWith('/remote.php') ? davError(s.status, s.message) : json(s.status, { message: s.message });
      if (s.status >= 500) o.log?.({ severity: 'ERROR', message: e instanceof Error ? e.stack : String(e) });
    }
    if (out.status === 401 && !out.headers?.['www-authenticate']) out.headers = { ...(out.headers ?? {}), 'www-authenticate': 'Basic realm="Files", charset="UTF-8"' };
    try {
      await send(res, r.method, out);
    } catch {
      res.destroy();
    }
    o.log?.({ severity: out.status >= 500 ? 'ERROR' : 'INFO', httpRequest: { requestMethod: r.method, status: out.status, latency: `${(Date.now() - started) / 1000}s` }, route: routeOf(path), user: r.person ? 'signed-in' : 'anonymous' });
  };
}

const signedIn = (files: Files, r: Req) => authenticate(files, r);

async function route(files: Files, r: Req, origin: string): Promise<Reply> {
  const p = r.path;
  if (p === '/status.php') return status();
  if (p === '/' || p === '/index.php') return home();
  if (p === '/.well-known/caldav' || p === '/.well-known/carddav') return { status: 301, headers: { location: '/remote.php/dav/' } };
  if (p === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' };
  if (p.startsWith('/index.php/login/v2')) return loginFlow(files, r, p.slice('/index.php/login/v2'.length), origin);
  if (p.startsWith('/index.php/core/wipe')) return wipe(files, r, p.slice('/index.php/core/wipe'.length));
  const s = /^\/s\/([A-Za-z0-9]{15,32})(\/.*)?$/.exec(p);
  if (s) return link(files, r, s[1]!, s[2] ?? '');
  const o = /^\/ocs\/v([12])\.php(\/.*)$/.exec(p);
  if (o) {
    const v = Number(o[1]) as 1 | 2;
    if (o[2] !== '/cloud/capabilities' || header(r, 'authorization')) {
      try {
        await signedIn(files, r);
      } catch (e) {
        const st = statusOf(e);
        return ocs(r, v, st.status, [], st.message);
      }
    }
    return ocsRoute(files, r, v, o[2]!, origin);
  }
  const d = davPath(p);
  if (d) {
    if (r.method === 'OPTIONS' && !header(r, 'authorization')) return { status: 200, headers: { dav: '1, 3', allow: 'OPTIONS, PROPFIND' } };
    if (!(await signedIn(files, r))) return davError(401, 'sign in with your login name and an app password');
    return webdav(files, r, d);
  }
  return json(404, { message: 'nothing here' });
}

export function serve(files: Files, port: number, o: ServeOptions = {}): Promise<Server> {
  return new Promise((ok) => {
    const s = createServer(handler(files, o));
    s.requestTimeout = 0;
    s.headersTimeout = 60_000;
    s.keepAliveTimeout = 65_000;
    s.listen(port, () => ok(s));
  });
}
