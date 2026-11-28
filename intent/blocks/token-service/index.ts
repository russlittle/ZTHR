/**
 * The life of access and refresh tokens. Access tokens are short-lived signed JWTs in the RFC 9068 profile
 * (typ "at+jwt", with iss, sub, aud, exp, iat, jti, client_id, scope) that carry a session id and a refresh family
 * id; refresh tokens are opaque random strings kept only as hashes. Refresh rotates: each use returns a new pair, and
 * presenting an already-used refresh token after the short retry grace is treated as theft and ends the whole
 * family and every access token it issued (OAuth 2.0 Security BCP, RFC 9700). Also: introspection that answers
 * only {active:false} to anything wrong (RFC 7662), revocation of one token, one session, or everything for a person
 * (RFC 7009), sender binding (a token made for a key thumbprint, `cnf.jkt` as in RFC 9449, is refused when
 * presented without it), and token exchange (RFC 8693) that can narrow scope or change audience but never widen,
 * and records who acted on whose behalf (`act`).
 *
 * JWT handling is inside this block: HS256 and ES256 only, the algorithm comes from the key found by `kid` and the
 * header must agree (so "none", RS/HS confusion and unknown algorithms are refused), `jku`, `jwk`, `x5u` and `crit`
 * headers are refused, and sizes are capped. The clock, random source and store are arguments. Not in scope:
 * serving the HTTP endpoints, client authentication, and DPoP proof validation (the caller passes the thumbprint
 * it has verified).
 */
import { createHash, createHmac, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { equal } from '../crypto/index.ts';

// ---------------------------------------------------------------- JWT

export type JwtKey = { readonly kid?: string; readonly alg: 'HS256'; readonly secret: Buffer } | { readonly kid?: string; readonly alg: 'ES256'; readonly publicKey: KeyObject; readonly privateKey?: KeyObject };

export class BadJwt extends Error {
  constructor(why: string) {
    super(`not a valid token: ${why}`);
  }
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const MAX_JWT = 8192;
const REFUSED_HEADERS = ['jku', 'jwk', 'x5u', 'x5c', 'crit'];

/** HMAC-SHA-256 of a JWS signing input, base64url: the signature of an HS256 token. */
export const hs256 = (signingInput: string, secret: Buffer): string => createHmac('sha256', secret).update(signingInput).digest('base64url');

export function encodeJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: JwtKey): string {
  const h = { ...header, alg: key.alg, ...(key.kid ? { kid: key.kid } : {}) };
  const input = `${b64(JSON.stringify(h))}.${b64(JSON.stringify(claims))}`;
  if (key.alg === 'HS256') return `${input}.${hs256(input, key.secret)}`;
  if (!key.privateKey) throw new BadJwt('this key cannot sign');
  return `${input}.${edSign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/**
 * Checks structure and signature and returns the header and claims; claims are not judged here. The key is found
 * by the header's kid, but the algorithm is the key's own: a header that names another is refused.
 */
export function decodeJwt(token: string, resolve: (kid: string | undefined) => JwtKey | undefined, o: { typ?: string } = {}): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  if (typeof token !== 'string' || token.length > MAX_JWT) throw new BadJwt('wrong size');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[2]) throw new BadJwt('not three parts');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new BadJwt('not JSON');
  }
  const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(header) || !isObj(claims)) throw new BadJwt('not objects');
  for (const h of REFUSED_HEADERS) if (h in header) throw new BadJwt(`the ${h} header is not accepted`);
  if (o.typ !== undefined && header['typ'] !== o.typ) throw new BadJwt(`typ must be ${o.typ}`);
  const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
  const key = resolve(kid);
  if (!key) throw new BadJwt('unknown key');
  if (header['alg'] !== key.alg) throw new BadJwt('the algorithm is not the one this key is for');
  const input = `${parts[0]}.${parts[1]}`;
  let good = false;
  if (key.alg === 'HS256') good = equal(hs256(input, key.secret), parts[2]!);
  else {
    const sig = Buffer.from(parts[2]!, 'base64url');
    good = sig.length === 64 && edVerify('sha256', Buffer.from(input), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  }
  if (!good) throw new BadJwt('the signature does not match');
  return { header, claims };
}

/** The public half of ES256 keys as a JWKS, for resource servers that verify on their own. */
export function jwks(keys: Readonly<Record<string, JwtKey>>): { keys: Record<string, unknown>[] } {
  const out: Record<string, unknown>[] = [];
  for (const [kid, k] of Object.entries(keys)) if (k.alg === 'ES256') out.push({ ...k.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'ES256' });
  return { keys: out };
}

// ---------------------------------------------------------------- the service

export type Why = 'unknown' | 'expired' | 'reused' | 'revoked' | 'wrong_client' | 'wrong_binding' | 'scope_widened' | 'not_allowed';

export class TokenRefused extends Error {
  readonly why: Why;
  constructor(why: Why, message: string) {
    super(message);
    this.why = why;
  }
}

export interface Family {
  readonly id: string;
  readonly sub: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly sid: string;
  readonly binding: string | undefined;
  readonly createdAt: number;
  readonly absoluteExpiry: number;
  expiresAt: number;
  current: string;
  previous: string | undefined;
  rotatedAt: number | undefined;
  revoked: string | undefined;
}

export interface Options {
  readonly issuer: string;
  /** The default audience of access tokens. */
  readonly audience: string;
  readonly keys: Readonly<Record<string, JwtKey>>;
  readonly currentKid: string;
  readonly now?: () => number;
  readonly random?: (n: number) => Buffer;
  readonly accessTtlMs?: number;
  /** A refresh token is good this long after it was last used... */
  readonly refreshIdleMs?: number;
  /** ...but never past this long after sign-in. */
  readonly refreshAbsoluteMs?: number;
  /** A retry of the refresh that just rotated, within this time, is a lost response and not theft. */
  readonly reuseGraceMs?: number;
  /** Audiences a token may be exchanged into. */
  readonly exchangeAudiences?: readonly string[];
  readonly clockSkewMs?: number;
}

export interface Grant {
  readonly sub: string;
  readonly clientId: string;
  readonly scope: readonly string[];
  readonly sid?: string;
  /** Thumbprint of the key the client holds (DPoP `jkt`); every later use must present it. */
  readonly binding?: string;
  readonly audience?: string;
}

export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: 'Bearer' | 'DPoP';
  readonly expires_in: number;
  readonly scope: string;
}

export interface Introspection {
  readonly active: boolean;
  readonly scope?: string;
  readonly client_id?: string;
  readonly sub?: string;
  readonly aud?: string;
  readonly iss?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly sid?: string;
  readonly token_type?: 'access_token' | 'refresh_token';
  readonly cnf?: { readonly jkt: string };
  readonly act?: { readonly sub: string };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sec = (ms: number) => Math.floor(ms / 1000);
const NONE: Introspection = { active: false };

export class TokenService {
  private readonly o: Options;
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;
  private readonly families = new Map<string, Family>();
  private readonly byRefresh = new Map<string, string>();
  private readonly revokedJti = new Map<string, number>();
  private readonly revokedSid = new Set<string>();
  /** Tokens issued before this instant (seconds) for a person are dead. */
  private readonly notBefore = new Map<string, number>();

  constructor(o: Options) {
    if (!o.keys[o.currentKid]) throw new RangeError('currentKid is not in keys');
    this.o = o;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? randomBytes;
  }

  private id() {
    return this.random(16).toString('base64url');
  }

  private newRefresh(): string {
    return this.random(32).toString('base64url');
  }

  private mint(g: { sub: string; clientId: string; scope: readonly string[]; sid: string; fam: string; binding: string | undefined; audience: string; exp?: number; act?: string }): { token: string; exp: number } {
    const iat = sec(this.now());
    const exp = Math.min(iat + sec(this.o.accessTtlMs ?? 10 * 60_000), g.exp ?? Infinity);
    const key = this.o.keys[this.o.currentKid]!;
    const token = encodeJwt(
      { typ: 'at+jwt' },
      {
        iss: this.o.issuer,
        sub: g.sub,
        aud: g.audience,
        exp,
        iat,
        jti: this.id(),
        client_id: g.clientId,
        scope: g.scope.join(' '),
        sid: g.sid,
        fam: g.fam,
        ...(g.binding ? { cnf: { jkt: g.binding } } : {}),
        ...(g.act ? { act: { sub: g.act } } : {}),
      },
      { ...key, kid: this.o.currentKid },
    );
    return { token, exp };
  }

  private pair(f: Family, refresh: string, audience?: string): TokenPair {
    const a = this.mint({ sub: f.sub, clientId: f.clientId, scope: f.scope, sid: f.sid, fam: f.id, binding: f.binding, audience: audience ?? this.o.audience });
    return { access_token: a.token, refresh_token: refresh, token_type: f.binding ? 'DPoP' : 'Bearer', expires_in: a.exp - sec(this.now()), scope: f.scope.join(' ') };
  }

  /** Signs a person in: a new session and refresh family. */
  issue(g: Grant): TokenPair {
    const t = this.now();
    const refresh = this.newRefresh();
    const f: Family = {
      id: this.id(),
      sub: g.sub,
      clientId: g.clientId,
      scope: [...new Set(g.scope)],
      sid: g.sid ?? this.id(),
      binding: g.binding,
      createdAt: t,
      absoluteExpiry: t + (this.o.refreshAbsoluteMs ?? 90 * 86_400_000),
      expiresAt: Math.min(t + (this.o.refreshIdleMs ?? 30 * 86_400_000), t + (this.o.refreshAbsoluteMs ?? 90 * 86_400_000)),
      current: sha(refresh),
      previous: undefined,
      rotatedAt: undefined,
      revoked: undefined,
    };
    this.families.set(f.id, f);
    this.byRefresh.set(f.current, f.id);
    return this.pair(f, refresh, g.audience);
  }

  /** Trades a refresh token for a new pair, retiring it. May narrow scope, never widen it. */
  refresh(token: string, o: { clientId: string; binding?: string; scope?: readonly string[] }): TokenPair {
    const h = sha(token);
    const fid = this.byRefresh.get(h);
    const f = fid ? this.families.get(fid) : undefined;
    if (!f) throw new TokenRefused('unknown', 'that refresh token is not valid');
    const t = this.now();
    if (f.revoked) throw new TokenRefused('revoked', 'that refresh token is not valid');
    if (f.clientId !== o.clientId) {
      // Another client presenting this token means it leaked: the family is ended, not just the request refused.
      this.endFamily(f, 'presented by another client');
      throw new TokenRefused('wrong_client', 'that refresh token is not valid');
    }
    if (t >= f.expiresAt) throw new TokenRefused('expired', 'that refresh token has expired');
    if (f.binding !== undefined && o.binding !== f.binding) throw new TokenRefused('wrong_binding', 'that token is bound to a key that was not presented');
    if (this.subjectCut(f) || this.revokedSid.has(f.sid)) throw new TokenRefused('revoked', 'that refresh token is not valid');
    if (o.scope && !o.scope.every((s) => f.scope.includes(s))) throw new TokenRefused('scope_widened', 'a refresh cannot add scope');
    const grace = this.o.reuseGraceMs ?? 10_000;
    if (h !== f.current) {
      if (h === f.previous && f.rotatedAt !== undefined && t - f.rotatedAt <= grace) {
        // The answer to the last refresh was probably lost: answer again, and make this the one that counts.
      } else {
        this.endFamily(f, 'a used refresh token was presented again');
        throw new TokenRefused('reused', 'that refresh token was already used; the session has been ended');
      }
    }
    const next = this.newRefresh();
    const scope = o.scope ? [...new Set(o.scope)] : f.scope;
    // A narrower request narrows the family for good, so a later refresh cannot take back what was given up.
    const nf: Family = o.scope && scope.length < f.scope.length ? Object.assign(f, { scope }) : f;
    if (h === f.current) {
      f.previous = h;
      f.rotatedAt = t;
    }
    this.byRefresh.set(sha(next), f.id);
    f.current = sha(next);
    f.expiresAt = Math.min(t + (this.o.refreshIdleMs ?? 30 * 86_400_000), f.absoluteExpiry);
    return this.pair(nf, next);
  }

  private endFamily(f: Family, why: string): void {
    f.revoked = why;
    this.revokedSid.add(f.sid);
  }

  private subjectCut(f: Family): boolean {
    const nb = this.notBefore.get(f.sub);
    return nb !== undefined && sec(f.createdAt) <= nb;
  }

  private resolve = (kid: string | undefined): JwtKey | undefined => (kid !== undefined && Object.hasOwn(this.o.keys, kid) ? this.o.keys[kid] : undefined);

  /** Reads an access token if it is genuine and current and not revoked; otherwise null. */
  private readAccess(token: string): Record<string, unknown> | null {
    let c: Record<string, unknown>;
    try {
      c = decodeJwt(token, this.resolve, { typ: 'at+jwt' }).claims;
    } catch {
      return null;
    }
    const now = sec(this.now());
    const skew = sec(this.o.clockSkewMs ?? 0);
    if (c['iss'] !== this.o.issuer) return null;
    if (typeof c['exp'] !== 'number' || typeof c['iat'] !== 'number' || typeof c['sub'] !== 'string' || typeof c['jti'] !== 'string') return null;
    if (now >= c['exp'] + skew || c['iat'] > now + skew) return null;
    if (this.revokedJti.has(c['jti'])) return null;
    if (typeof c['sid'] === 'string' && this.revokedSid.has(c['sid'])) return null;
    const nb = this.notBefore.get(c['sub']);
    if (nb !== undefined && c['iat'] <= nb) return null;
    const fam = typeof c['fam'] === 'string' ? this.families.get(c['fam']) : undefined;
    if (fam?.revoked) return null;
    return c;
  }

  /**
   * RFC 7662: whether a token is live and what it says. Anything wrong (unknown, expired, revoked, forged, bound to
   * a key not presented) is the same answer, {active:false}; the reason is never given to the asker.
   */
  introspect(token: string, o: { binding?: string; audience?: string } = {}): Introspection {
    if (typeof token !== 'string') return NONE;
    if (token.split('.').length === 3) {
      const c = this.readAccess(token);
      if (!c) return NONE;
      const jkt = (c['cnf'] as { jkt?: string } | undefined)?.jkt;
      if (jkt !== undefined && (o.binding === undefined || !equal(jkt, o.binding))) return NONE;
      if (o.audience !== undefined && c['aud'] !== o.audience) return NONE;
      return {
        active: true,
        token_type: 'access_token',
        scope: String(c['scope'] ?? ''),
        client_id: String(c['client_id']),
        sub: String(c['sub']),
        aud: String(c['aud']),
        iss: String(c['iss']),
        exp: c['exp'] as number,
        iat: c['iat'] as number,
        jti: String(c['jti']),
        sid: String(c['sid']),
        ...(jkt !== undefined ? { cnf: { jkt } } : {}),
        ...(c['act'] ? { act: c['act'] as { sub: string } } : {}),
      };
    }
    const f = this.families.get(this.byRefresh.get(sha(token)) ?? '');
    if (!f || f.revoked || this.now() >= f.expiresAt || sha(token) !== f.current || this.revokedSid.has(f.sid) || this.subjectCut(f)) return NONE;
    if (f.binding !== undefined && (o.binding === undefined || !equal(f.binding, o.binding))) return NONE;
    return { active: true, token_type: 'refresh_token', scope: f.scope.join(' '), client_id: f.clientId, sub: f.sub, sid: f.sid, exp: sec(f.expiresAt), iat: sec(f.createdAt), ...(f.binding ? { cnf: { jkt: f.binding } } : {}) };
  }

  /**
   * RFC 7009. Revoking a refresh token ends its whole family (and with it every access token issued from it);
   * revoking an access token ends that one token. An unknown token is not an error: the answer is the same.
   */
  revoke(token: string): void {
    if (typeof token !== 'string') return;
    if (token.split('.').length === 3) {
      let c: Record<string, unknown>;
      try {
        c = decodeJwt(token, this.resolve, { typ: 'at+jwt' }).claims;
      } catch {
        return;
      }
      if (typeof c['jti'] === 'string' && typeof c['exp'] === 'number') this.revokedJti.set(c['jti'], c['exp']);
      return;
    }
    const f = this.families.get(this.byRefresh.get(sha(token)) ?? '');
    if (f && !f.revoked) this.endFamily(f, 'revoked by request');
  }

  /** Ends a session: its refresh tokens and every access token issued in it. */
  revokeSession(sid: string): boolean {
    let found = false;
    for (const f of this.families.values())
      if (f.sid === sid && !f.revoked) {
        this.endFamily(f, 'session ended');
        found = true;
      }
    this.revokedSid.add(sid);
    return found;
  }

  /** Ends everything issued to a person up to now (a password change, a deactivation); sign-ins from the next whole second on work. */
  revokeSubject(sub: string): void {
    // Whole seconds, as token times are; a token made in this same second is still cut, so the cut is the end of it.
    this.notBefore.set(sub, sec(this.now()));
  }

  /** A person's live sessions, for a "where you are signed in" page. */
  sessions(sub: string): { sid: string; clientId: string; since: number; scope: string }[] {
    return [...this.families.values()]
      .filter((f) => f.sub === sub && !f.revoked && this.now() < f.expiresAt && !this.revokedSid.has(f.sid) && !this.subjectCut(f))
      .map((f) => ({ sid: f.sid, clientId: f.clientId, since: f.createdAt, scope: f.scope.join(' ') }))
      .sort((a, b) => a.since - b.since);
  }

  /**
   * RFC 8693 token exchange for access tokens: a service holding a person's token asks for one of its own, for another
   * audience and/or narrower scope, optionally recording who acts for them. It cannot outlive the original, cannot
   * widen scope, and ends with the same session, so revoking the session ends it too.
   */
  exchange(o: { subjectToken: string; clientId: string; scope?: readonly string[]; audience?: string; actor?: string; binding?: string }): { access_token: string; issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'; token_type: 'Bearer'; expires_in: number; scope: string } {
    const i = this.introspect(o.subjectToken, o.binding !== undefined ? { binding: o.binding } : {});
    if (!i.active || i.token_type !== 'access_token') throw new TokenRefused('unknown', 'the subject token is not valid');
    const have = (i.scope ?? '').split(' ').filter(Boolean);
    const want = o.scope ? [...new Set(o.scope)] : have;
    if (!want.every((s) => have.includes(s))) throw new TokenRefused('scope_widened', 'an exchange cannot add scope');
    const audience = o.audience ?? i.aud!;
    if (audience !== i.aud && !(this.o.exchangeAudiences ?? []).includes(audience)) throw new TokenRefused('not_allowed', 'that audience is not available by exchange');
    const c = decodeJwt(o.subjectToken, this.resolve).claims;
    const m = this.mint({ sub: i.sub!, clientId: o.clientId, scope: want, sid: i.sid!, fam: String(c['fam']), binding: i.cnf?.jkt, audience, exp: i.exp!, ...(o.actor ? { act: o.actor } : {}) });
    return { access_token: m.token, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: m.exp - sec(this.now()), scope: want.join(' ') };
  }

  /** Forgets what can no longer matter: expired families and denylisted ids past their expiry. */
  sweep(): number {
    const t = this.now();
    let n = 0;
    for (const [jti, exp] of this.revokedJti) if (sec(t) >= exp + 60) (this.revokedJti.delete(jti), n++);
    for (const [id, f] of this.families)
      if (t >= f.absoluteExpiry || (t >= f.expiresAt + 600_000 && !f.revoked)) {
        this.families.delete(id);
        for (const [h, fid] of this.byRefresh) if (fid === id) this.byRefresh.delete(h);
        this.revokedSid.delete(f.sid);
        n++;
      }
    return n;
  }
}
