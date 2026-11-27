/**
 * Safe defaults for browsers: the response headers every page and API answer carries (a strict content security
 * policy with per-response nonces for any inline script, no framing, no sniffing, HTTPS only, no referrer leak,
 * no powerful features unless asked for), and protection against cross-site requests: a per-session token every
 * change must carry, checked in constant time, plus a check that a change comes from this site's own pages.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface HeaderOptions {
  /** Extra sources per directive, such as an analytics or image host. */
  readonly allow?: Readonly<Partial<Record<'script-src' | 'style-src' | 'img-src' | 'connect-src' | 'font-src' | 'frame-src' | 'media-src', readonly string[]>>>;
  /** A nonce for this response's inline scripts; made fresh per response. */
  readonly nonce?: string;
  /** For an API answer: no HTML is served, so the policy is simply "nothing". */
  readonly api?: boolean;
  /** Browser features this page needs (camera, microphone, geolocation); all others are switched off. */
  readonly features?: readonly string[];
  readonly hstsDays?: number;
}

const FEATURES = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'bluetooth', 'display-capture', 'fullscreen', 'publickey-credentials-get'];

export const nonce = () => randomBytes(16).toString('base64');

export function headers(o: HeaderOptions = {}): Record<string, string> {
  const extra = (d: keyof NonNullable<HeaderOptions['allow']>) => (o.allow?.[d] ?? []).map((x) => ` ${x}`).join('');
  const csp = o.api
    ? "default-src 'none'; frame-ancestors 'none'"
    : [
        "default-src 'self'",
        `script-src 'self'${o.nonce ? ` 'nonce-${o.nonce}'` : ''}${extra('script-src')}`,
        `style-src 'self'${extra('style-src')}`,
        `img-src 'self' data:${extra('img-src')}`,
        `connect-src 'self'${extra('connect-src')}`,
        `font-src 'self'${extra('font-src')}`,
        `frame-src ${o.allow?.['frame-src']?.join(' ') ?? "'none'"}`,
        `media-src 'self'${extra('media-src')}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'upgrade-insecure-requests',
      ].join('; ');
  const allowed = new Set(o.features ?? []);
  return {
    'content-security-policy': csp,
    'strict-transport-security': `max-age=${(o.hstsDays ?? 365) * 86400}; includeSubDomains`,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': FEATURES.map((f) => `${f}=${allowed.has(f) ? '(self)' : '()'}`).join(', '),
  };
}

/** Cookie attributes for a session: never readable by script, only over HTTPS, not sent on cross-site posts. */
export const sessionCookie = (name: string, value: string, maxAgeSeconds: number) => `__Host-${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

// ---------------------------------------------------------------- cross-site requests

/** A request token bound to a session: derived, so nothing extra is stored, and different for every session. */
export const csrfToken = (secret: string, sessionId: string) => createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfCheck {
  readonly method: string;
  /** The Origin header, or the Referer when Origin is absent. */
  readonly origin?: string;
  readonly referer?: string;
  /** The token the request carried, in a form field or a header. */
  readonly token?: string;
  readonly sessionId?: string;
}

/**
 * Null when the request may proceed; otherwise the reason it may not. Safe methods always may. A change must come
 * from one of `origins` and carry the session's token.
 */
export function csrf(c: CsrfCheck, secret: string, origins: readonly string[]): string | null {
  if (SAFE.has(c.method.toUpperCase())) return null;
  const from = c.origin ?? (c.referer ? safeOrigin(c.referer) : undefined);
  if (!from || !origins.includes(from)) return 'the request did not come from this site';
  if (!c.sessionId || !c.token) return 'the request carries no request token';
  const want = Buffer.from(csrfToken(secret, c.sessionId));
  const got = Buffer.from(c.token);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return 'the request token does not match this session';
  return null;
}

const safeOrigin = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};
