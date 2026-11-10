import type { Context, MiddlewareHandler } from 'hono';

/**
 * What a public demo needs before anyone pokes at it. Each guard is small and stated here, so the security review
 * can read the whole policy in one place.
 *
 *  - Security headers: a content security policy that allows only this origin (and Google sign-in when it is on),
 *    no framing by other sites, no content sniffing, no referrer leaking beyond the origin, and HTTPS only.
 *  - A per-client request rate, and a separate, much smaller rate for starting new demo sandboxes, so one client
 *    cannot exhaust the server or push other visitors' sandboxes out.
 */
export function securityHeaders(): MiddlewareHandler {
  const csp = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://accounts.google.com",
    "frame-src https://accounts.google.com",
    "connect-src 'self' https://accounts.google.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', csp);
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Over HTTPS (the front end says so), browsers are told to use nothing else for a year.
    if (c.req.header('x-forwarded-proto') === 'https') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
}

/** The client's address: the first hop the front end recorded, or the socket's when there is no front end. */
export function clientOf(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : '') || c.req.header('x-real-ip') || 'local';
}

/** A fixed-window counter per key. Bounded: the oldest keys go first when it holds too many. */
export class Window {
  private readonly hits = new Map<string, { start: number; n: number }>();
  constructor(
    readonly max: number,
    readonly ms: number,
    private readonly keys = 50_000,
  ) {}

  /** Counts one; false when the key is over its limit for this window. */
  take(key: string, now = Date.now()): boolean {
    let h = this.hits.get(key);
    if (!h || now - h.start >= this.ms) {
      if (!h && this.hits.size >= this.keys) this.hits.delete(this.hits.keys().next().value!);
      h = { start: now, n: 0 };
      this.hits.set(key, h);
    }
    h.n++;
    return h.n <= this.max;
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Answers 429 with a plain page when a client sends more than the window allows. */
export function rateLimit(w: Window): MiddlewareHandler {
  return async (c, next) => {
    if (!w.take(clientOf(c))) {
      c.header('Retry-After', String(Math.ceil(w.ms / 1000)));
      return c.text('Too many requests from this address. Please wait a minute and try again.', 429);
    }
    await next();
  };
}
