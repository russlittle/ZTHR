/**
 * An OAuth 2.1 style authorization server as plain functions over request objects (no HTTP framework): the
 * authorization endpoint with consent, the token endpoint, device authorization, revocation and introspection.
 *
 * Follows RFC 6749 (authorization code, client credentials, refresh token), RFC 7636 (PKCE: S256 only, required of
 * every client), RFC 8628 (device authorization grant, with slow_down and a user-code brute-force limit), RFC 7009
 * (revocation), RFC 7662 (introspection), RFC 9068 (JWT access tokens), RFC 9207 (iss in the authorization
 * response) and RFC 9700 (exact redirects, single-use codes, rotation of refresh tokens). When the openid scope is
 * granted an OpenID Connect ID token is issued with nonce, auth_time and at_hash.
 *
 * Refresh tokens rotate on every use and belong to a family. Presenting one that was already used is treated as
 * theft: the whole family is revoked, so the refresh token and the access tokens issued from it stop working. A
 * code presented twice revokes what it produced (RFC 6749 section 4.1.2).
 *
 * The JWT signing and verification the server needs is inside (HS256, RS256, ES256; the algorithm comes from the
 * key and never from the token, "none" is never accepted). Not here: HTTP routing, login pages and user storage
 * (the caller supplies the signed-in subject), request objects (RFC 9101), PAR, DPoP, and resource-server
 * authentication for introspection.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ClientError, GRANT_AUTHORIZATION_CODE, GRANT_CLIENT_CREDENTIALS, GRANT_DEVICE, GRANT_REFRESH } from '../client-registry/index.ts';
import type { ClientRecord, ClientRegistry } from '../client-registry/index.ts';

// ---------------------------------------------------------------- JWT (JWS compact, RFC 7515 / 7519)

export class BadJwt extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Alg = 'HS256' | 'RS256' | 'ES256';

export interface SigningKey {
  readonly alg: Alg;
  readonly kid?: string;
  /** HS256: the secret. RS256 and ES256: the private key. */
  readonly key: Uint8Array | string | KeyObject;
}

export interface VerifyingKey {
  readonly alg: Alg;
  readonly kid?: string;
  /** HS256: the secret. RS256 and ES256: the public key. */
  readonly key: Uint8Array | string | KeyObject;
}

const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
const hmac = (key: Uint8Array | string | KeyObject, data: string) => {
  if (typeof key === 'object' && 'type' in key) throw new BadJwt('an HS256 key must be a secret');
  return createHmac('sha256', key).update(data).digest();
};

export function signJwt(k: SigningKey, claims: Record<string, unknown>, typ = 'JWT'): string {
  const header = { alg: k.alg, typ, ...(k.kid ? { kid: k.kid } : {}) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  let sig: Buffer;
  if (k.alg === 'HS256') sig = hmac(k.key, input);
  else {
    const priv = typeof k.key === 'object' && 'type' in k.key ? k.key : createPrivateKey(Buffer.from(k.key).toString());
    sig = createSign('SHA256').update(input).sign(k.alg === 'ES256' ? { key: priv, dsaEncoding: 'ieee-p1363' } : priv);
  }
  return `${input}.${b64u(sig)}`;
}

export interface VerifyOptions {
  readonly now: number;
  readonly issuer?: string;
  readonly audience?: string;
  /** The `typ` header required, e.g. "at+jwt". */
  readonly typ?: string;
  readonly clockSkewSec?: number;
}

/**
 * Checks a compact JWT against a set of keys and returns its claims. The key is chosen by `kid` (or the only key),
 * and the token's `alg` must equal that key's own algorithm, so a token cannot choose how it is checked.
 */
export function verifyJwt(token: string, keys: readonly VerifyingKey[], o: VerifyOptions): Record<string, unknown> {
  if (token.length > 16_384) throw new BadJwt('the token is too long');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[0] || !parts[1] || !parts[2]) throw new BadJwt('not a compact JWT');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new BadJwt('the header or claims are not JSON');
  }
  if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null || Array.isArray(claims)) throw new BadJwt('the header or claims are not objects');
  if (header.alg === 'none' || typeof header.alg !== 'string') throw new BadJwt('unsigned or unnamed algorithm');
  if ('crit' in header) throw new BadJwt('critical header extensions are not supported');
  const cands = typeof header.kid === 'string' ? keys.filter((k) => k.kid === header.kid) : keys.length === 1 ? [...keys] : [];
  const key = cands[0];
  if (!key) throw new BadJwt('no key for this token');
  if (header.alg !== key.alg) throw new BadJwt(`the token says ${String(header.alg)} but its key is ${key.alg}`);
  const input = `${parts[0]}.${parts[1]}`;
  const sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  if (key.alg === 'HS256') {
    const want = hmac(key.key, input);
    ok = sig.length === want.length && timingSafeEqual(sig, want);
  } else {
    const pub = typeof key.key === 'object' && 'type' in key.key ? (key.key.type === 'private' ? createPublicKey(key.key) : key.key) : createPublicKey(Buffer.from(key.key).toString());
    if (key.alg === 'ES256' && sig.length !== 64) throw new BadJwt('a malformed ES256 signature');
    ok = createVerify('SHA256').update(input).verify(key.alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub, sig);
  }
  if (!ok) throw new BadJwt('the signature does not match');
  const skew = o.clockSkewSec ?? 0;
  const nowSec = Math.floor(o.now / 1000);
  if (typeof claims.exp !== 'number') throw new BadJwt('the token has no expiry');
  if (claims.exp + skew <= nowSec) throw new BadJwt('the token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSec) throw new BadJwt('the token is not valid yet');
  if (o.issuer !== undefined && claims.iss !== o.issuer) throw new BadJwt('the token is from another issuer');
  if (o.audience !== undefined) {
    const aud = claims.aud;
    if (!(aud === o.audience || (Array.isArray(aud) && aud.includes(o.audience)))) throw new BadJwt('the token is for another audience');
  }
  if (o.typ !== undefined && header.typ !== o.typ) throw new BadJwt(`the token type is not ${o.typ}`);
  return claims;
}

// ---------------------------------------------------------------- errors, scopes, helpers

export type OAuthErrorCode =
  | 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope'
  | 'access_denied' | 'unsupported_response_type' | 'server_error' | 'login_required' | 'consent_required'
  | 'authorization_pending' | 'slow_down' | 'expired_token' | 'invalid_token';

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;
  constructor(code: OAuthErrorCode, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

export interface ScopeDef {
  readonly name: string;
  /** Shown to the person on the consent screen. */
  readonly description: string;
  /** Other scopes this one includes ("admin" includes "read"). */
  readonly implies?: readonly string[];
  /** Always asks again, even when the client is trusted or the person agreed before. */
  readonly sensitive?: boolean;
}

export interface Subject {
  readonly id: string;
  /** When the person last signed in, ms. */
  readonly authTime: number;
}

export interface ServerOptions {
  readonly issuer: string;
  readonly registry: ClientRegistry;
  readonly signing: SigningKey;
  /** Extra verification keys, for tokens signed by a key being retired. */
  readonly oldKeys?: readonly VerifyingKey[];
  readonly scopes: readonly ScopeDef[];
  readonly now?: () => number;
  readonly randomBytes: (n: number) => Uint8Array;
  readonly audience?: string;
  readonly accessTtlSec?: number;
  readonly codeTtlSec?: number;
  readonly refreshIdleSec?: number;
  readonly refreshAbsoluteSec?: number;
  readonly deviceTtlSec?: number;
  readonly deviceIntervalSec?: number;
  readonly deviceVerificationUri?: string;
  /** A refresh token used again within this long of its first use is refused without revoking the family (parallel requests). */
  readonly reuseGraceMs?: number;
  /** Wrong device user codes one source may try before it is locked out for `deviceLockMs`. */
  readonly deviceMaxFailures?: number;
  readonly deviceLockMs?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const S256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Reads a query string into a flat object, refusing any parameter given twice (RFC 6749 section 3.1). */
export function parseParams(q: URLSearchParams | string): Record<string, string> {
  const p = typeof q === 'string' ? new URLSearchParams(q) : q;
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of p) {
    if (k in out) throw new OAuthError('invalid_request', `the parameter ${k} appears more than once`);
    out[k] = v;
  }
  return out;
}

/** The base64url SHA-256 challenge for a PKCE verifier (RFC 7636 section 4.2). */
export const pkceChallenge = S256;

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ';

export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string | undefined;
  readonly nonce: string | undefined;
  readonly codeChallenge: string;
  readonly prompt: readonly string[];
}

export type AuthorizeResult =
  /** Show this to the person and do not redirect: the redirect URI or client cannot be trusted. */
  | { readonly kind: 'error-page'; readonly error: OAuthErrorCode; readonly description: string }
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'login'; readonly request: AuthorizationRequest }
  | { readonly kind: 'consent'; readonly request: AuthorizationRequest; readonly client: ClientRecord; readonly scopes: readonly { name: string; description: string; sensitive: boolean; alreadyGranted: boolean }[] };

export interface TokenResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

interface CodeRec {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly scopes: readonly string[];
  readonly subject: Subject;
  readonly nonce: string | undefined;
  readonly expiresAt: number;
  family: string | undefined;
  used: boolean;
}
interface Family {
  readonly id: string;
  readonly clientId: string;
  readonly subject: string | undefined;
  readonly scopes: readonly string[];
  readonly authTime: number;
  readonly nonce: string | undefined;
  readonly absoluteExpires: number;
  revoked: boolean;
  readonly jtis: Set<string>;
}
interface RefreshRec {
  readonly family: string;
  readonly idleExpires: number;
  usedAt: number | undefined;
}
interface DeviceRec {
  readonly clientId: string;
  readonly userCode: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  interval: number;
  lastPoll: number;
  status: 'pending' | 'approved' | 'denied';
  subject?: Subject;
  grantedScopes?: readonly string[];
}

export class AuthorizationServer {
  private readonly o: ServerOptions;
  private readonly now: () => number;
  private readonly codes = new Map<string, CodeRec>();
  private readonly families = new Map<string, Family>();
  private readonly refresh = new Map<string, RefreshRec>();
  private readonly devices = new Map<string, DeviceRec>();
  private readonly userCodes = new Map<string, string>();
  private readonly consents = new Map<string, Set<string>>();
  private readonly revokedJti = new Set<string>();
  private readonly jtiFamily = new Map<string, string>();
  private readonly failures = new Map<string, { n: number; lockedUntil: number; first: number }>();
  private readonly scopeDefs: ReadonlyMap<string, ScopeDef>;

  constructor(o: ServerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.scopeDefs = new Map(o.scopes.map((s) => [s.name, s]));
  }

  private rnd(n: number) {
    return Buffer.from(this.o.randomBytes(n)).toString('base64url');
  }
  private get accessTtl() { return this.o.accessTtlSec ?? 600; }

  // ------------------------------------------------------------ scopes

  /** Splits a scope parameter, refusing unknown scopes and repeats; a scope the client may not have is refused too. */
  parseScopes(raw: string | undefined, client: ClientRecord): string[] {
    const list = (raw ?? '').split(' ').filter(Boolean);
    const unique = [...new Set(list)];
    for (const s of unique) {
      if (!this.scopeDefs.has(s)) throw new OAuthError('invalid_scope', `the scope ${s} is not known here`);
      if (!client.scopes.includes(s)) throw new OAuthError('invalid_scope', `the client may not ask for the scope ${s}`);
    }
    return unique;
  }

  /** Every scope a grant includes once implications are followed. */
  expandScopes(scopes: readonly string[]): string[] {
    const out = new Set<string>();
    const walk = (s: string) => {
      if (out.has(s)) return;
      out.add(s);
      for (const i of this.scopeDefs.get(s)?.implies ?? []) walk(i);
    };
    scopes.forEach(walk);
    return [...out];
  }

  // ------------------------------------------------------------ authorization endpoint

  private errorRedirect(redirectUri: string, error: OAuthErrorCode, description: string, state: string | undefined): AuthorizeResult {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== undefined) u.searchParams.set('state', state);
    u.searchParams.set('iss', this.o.issuer);
    return { kind: 'redirect', url: u.toString() };
  }

  /**
   * Handles an authorization request. `subject` is whoever is signed in, if anyone. Problems with the client or the
   * redirect URI are shown to the person; every other problem goes back to the client's registered redirect.
   */
  authorize(params: Readonly<Record<string, string | undefined>>, subject: Subject | undefined): AuthorizeResult {
    const clientId = params.client_id;
    if (!clientId) return { kind: 'error-page', error: 'invalid_request', description: 'the request names no client' };
    const client = this.o.registry.get(clientId);
    if (!client || client.disabled) return { kind: 'error-page', error: 'invalid_request', description: 'the client is not known here' };
    let redirectUri: string;
    try {
      redirectUri = this.o.registry.resolveRedirect(clientId, params.redirect_uri);
    } catch (e) {
      return { kind: 'error-page', error: 'invalid_request', description: e instanceof ClientError ? e.message : 'the redirect is not valid' };
    }
    const state = params.state;
    const fail = (code: OAuthErrorCode, d: string) => this.errorRedirect(redirectUri, code, d, state);
    if (params.response_type !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
    if (!client.grantTypes.includes(GRANT_AUTHORIZATION_CODE)) return fail('unauthorized_client', 'the client may not use the authorization code grant' as never);
    const challenge = params.code_challenge;
    if (!challenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
    if (params.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    if (!CHALLENGE.test(challenge)) return fail('invalid_request', 'code_challenge is not a base64url SHA-256');
    let scopes: string[];
    try {
      scopes = this.parseScopes(params.scope, client);
    } catch (e) {
      return fail('invalid_scope', (e as Error).message);
    }
    const prompt = (params.prompt ?? '').split(' ').filter(Boolean);
    const request: AuthorizationRequest = { clientId, redirectUri, scopes, state, nonce: params.nonce, codeChallenge: challenge, prompt };
    const maxAge = params.max_age === undefined ? undefined : Number(params.max_age);
    if (params.max_age !== undefined && !(Number.isInteger(maxAge) && maxAge! >= 0)) return fail('invalid_request', 'max_age must be a whole number of seconds');
    const stale = subject !== undefined && maxAge !== undefined && this.now() - subject.authTime > maxAge * 1000;
    if (!subject || prompt.includes('login') || stale) {
      if (prompt.includes('none')) return fail('login_required', 'the person is not signed in');
      return { kind: 'login', request };
    }
    const needs = this.consentNeeded(subject, client, scopes, prompt.includes('consent'));
    if (needs.length > 0) {
      if (prompt.includes('none')) return fail('consent_required', 'the person has not agreed to this');
      return {
        kind: 'consent',
        request,
        client,
        scopes: scopes.map((s) => ({ name: s, description: this.scopeDefs.get(s)!.description, sensitive: !!this.scopeDefs.get(s)!.sensitive, alreadyGranted: !needs.includes(s) })),
      };
    }
    return this.issueCode(request, subject);
  }

  private consentKey = (subject: string, client: string) => `${subject}\u0000${client}`;

  private consentNeeded(subject: Subject, client: ClientRecord, scopes: readonly string[], force: boolean): string[] {
    if (force) return [...scopes];
    const have = this.consents.get(this.consentKey(subject.id, client.clientId));
    return scopes.filter((s) => {
      if (this.scopeDefs.get(s)?.sensitive) return true;
      if (client.trusted) return false;
      return !have?.has(s);
    });
  }

  /** The person agreed. `granted` may be narrower than the request, never wider. Returns the redirect with the code. */
  approve(request: AuthorizationRequest, subject: Subject, granted: readonly string[] = request.scopes): AuthorizeResult {
    const extra = granted.filter((s) => !request.scopes.includes(s));
    if (extra.length > 0) throw new OAuthError('invalid_scope', `the scope ${extra[0]} was not requested`);
    const set = this.consents.get(this.consentKey(subject.id, request.clientId)) ?? new Set<string>();
    for (const s of granted) if (!this.scopeDefs.get(s)?.sensitive) set.add(s);
    this.consents.set(this.consentKey(subject.id, request.clientId), set);
    return this.issueCode({ ...request, scopes: [...granted] }, subject);
  }

  /** The person said no: the client is told access_denied. */
  deny(request: AuthorizationRequest): AuthorizeResult {
    return this.errorRedirect(request.redirectUri, 'access_denied', 'the person did not agree', request.state);
  }

  /** Forgets what a person agreed to for a client. */
  withdrawConsent(subjectId: string, clientId: string): void {
    this.consents.delete(this.consentKey(subjectId, clientId));
  }

  private issueCode(r: AuthorizationRequest, subject: Subject): AuthorizeResult {
    const code = this.rnd(32);
    this.codes.set(sha(code), {
      clientId: r.clientId, redirectUri: r.redirectUri, challenge: r.codeChallenge, scopes: r.scopes, subject, nonce: r.nonce,
      expiresAt: this.now() + (this.o.codeTtlSec ?? 60) * 1000, family: undefined, used: false,
    });
    const u = new URL(r.redirectUri);
    u.searchParams.set('code', code);
    if (r.state !== undefined) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', this.o.issuer);
    return { kind: 'redirect', url: u.toString() };
  }

  // ------------------------------------------------------------ token endpoint

  /**
   * The token endpoint. Never throws for a protocol error: it answers with the RFC 6749 error body and status, and
   * `Cache-Control: no-store` on everything.
   */
  token(req: { authorization?: string | undefined; body: Readonly<Record<string, string | undefined>> }): TokenResponse {
    const headers: Record<string, string> = { 'cache-control': 'no-store', pragma: 'no-cache', 'content-type': 'application/json' };
    try {
      return { status: 200, headers, body: this.grant(req) };
    } catch (e) {
      if (e instanceof OAuthError) {
        const h = { ...headers };
        if (e.status === 401 && req.authorization) h['www-authenticate'] = 'Basic realm="token"';
        return { status: e.status, headers: h, body: { error: e.code, error_description: e.message } };
      }
      throw e;
    }
  }

  private authClient(req: { authorization?: string | undefined; body: Readonly<Record<string, string | undefined>> }): ClientRecord {
    try {
      return this.o.registry.authenticate({ authorization: req.authorization, clientId: req.body.client_id, clientSecret: req.body.client_secret });
    } catch (e) {
      if (e instanceof ClientError) throw new OAuthError('invalid_client', e.message, 401);
      throw e;
    }
  }

  private grant(req: { authorization?: string | undefined; body: Readonly<Record<string, string | undefined>> }): Record<string, unknown> {
    const gt = req.body.grant_type;
    if (!gt) throw new OAuthError('invalid_request', 'grant_type is required');
    const client = this.authClient(req);
    if (!['authorization_code', 'client_credentials', 'refresh_token', GRANT_DEVICE].includes(gt)) throw new OAuthError('unsupported_grant_type', `the grant type ${gt} is not supported`);
    if (!client.grantTypes.includes(gt)) throw new OAuthError('unauthorized_client', 'the client may not use that grant type');
    if (gt === GRANT_AUTHORIZATION_CODE) return this.codeGrant(client, req.body);
    if (gt === GRANT_CLIENT_CREDENTIALS) return this.clientCredentials(client, req.body);
    if (gt === GRANT_REFRESH) return this.refreshGrant(client, req.body);
    return this.deviceGrant(client, req.body);
  }

  private codeGrant(client: ClientRecord, b: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
    const code = b.code;
    const verifier = b.code_verifier;
    if (!code) throw new OAuthError('invalid_request', 'code is required');
    if (!verifier) throw new OAuthError('invalid_request', 'code_verifier is required');
    const rec = this.codes.get(sha(code));
    if (!rec) throw new OAuthError('invalid_grant', 'the code is not valid');
    if (rec.used) {
      // A code used twice: whatever it produced is no longer to be trusted.
      if (rec.family) this.revokeFamily(rec.family);
      throw new OAuthError('invalid_grant', 'the code was already used');
    }
    rec.used = true;
    if (rec.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'the code was issued to another client');
    if (rec.expiresAt <= this.now()) throw new OAuthError('invalid_grant', 'the code has expired');
    if (b.redirect_uri !== undefined && b.redirect_uri !== rec.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri differs from the authorization request');
    if (b.redirect_uri === undefined && client.redirectUris.length !== 1) throw new OAuthError('invalid_grant', 'redirect_uri is required');
    if (!VERIFIER.test(verifier) || !eq(S256(verifier), rec.challenge)) throw new OAuthError('invalid_grant', 'the code_verifier does not match the code_challenge');
    const fam = this.newFamily(client, rec.subject.id, rec.scopes, rec.subject.authTime, rec.nonce);
    rec.family = fam.id;
    return this.respond(client, fam, rec.scopes, client.grantTypes.includes(GRANT_REFRESH));
  }

  private clientCredentials(client: ClientRecord, b: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
    if (client.authMethod === 'none') throw new OAuthError('unauthorized_client', 'a public client cannot use client credentials');
    const scopes = this.parseScopesOrThrow(b.scope, client);
    if (scopes.includes('openid')) throw new OAuthError('invalid_scope', 'openid needs a person');
    const fam = this.newFamily(client, undefined, scopes, this.now(), undefined);
    return this.respond(client, fam, scopes, false);
  }

  private parseScopesOrThrow(raw: string | undefined, client: ClientRecord): string[] {
    return this.parseScopes(raw, client);
  }

  private refreshGrant(client: ClientRecord, b: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
    const tok = b.refresh_token;
    if (!tok) throw new OAuthError('invalid_request', 'refresh_token is required');
    const key = sha(tok);
    const rec = this.refresh.get(key);
    const bad = () => new OAuthError('invalid_grant', 'the refresh token is not valid');
    if (!rec) throw bad();
    const fam = this.families.get(rec.family);
    if (!fam || fam.revoked) throw bad();
    if (fam.clientId !== client.clientId) {
      this.revokeFamily(fam.id);
      throw bad();
    }
    const t = this.now();
    if (rec.usedAt !== undefined) {
      if (t - rec.usedAt >= (this.o.reuseGraceMs ?? 0)) this.revokeFamily(fam.id);
      throw new OAuthError('invalid_grant', 'the refresh token was already used');
    }
    if (rec.idleExpires <= t || fam.absoluteExpires <= t) throw new OAuthError('invalid_grant', 'the refresh token has expired');
    let scopes = fam.scopes;
    if (b.scope !== undefined) {
      const asked = [...new Set(b.scope.split(' ').filter(Boolean))];
      const over = asked.find((s) => !fam.scopes.includes(s));
      if (over) throw new OAuthError('invalid_scope', `the scope ${over} was not in the original grant`);
      scopes = asked;
    }
    rec.usedAt = t;
    return this.respond(client, fam, scopes, true);
  }

  // ------------------------------------------------------------ issuing

  private newFamily(client: ClientRecord, subject: string | undefined, scopes: readonly string[], authTime: number, nonce: string | undefined): Family {
    const fam: Family = {
      id: this.rnd(12), clientId: client.clientId, subject, scopes: [...scopes], authTime, nonce,
      absoluteExpires: this.now() + (this.o.refreshAbsoluteSec ?? 90 * 86400) * 1000, revoked: false, jtis: new Set(),
    };
    this.families.set(fam.id, fam);
    return fam;
  }

  private revokeFamily(id: string): void {
    const f = this.families.get(id);
    if (f) f.revoked = true;
  }

  private respond(client: ClientRecord, fam: Family, scopes: readonly string[], withRefresh: boolean): Record<string, unknown> {
    const t = this.now();
    const nowSec = Math.floor(t / 1000);
    const jti = this.rnd(12);
    fam.jtis.add(jti);
    this.jtiFamily.set(jti, fam.id);
    const access = signJwt(this.o.signing, {
      iss: this.o.issuer, sub: fam.subject ?? client.clientId, aud: this.o.audience ?? this.o.issuer, exp: nowSec + this.accessTtl, iat: nowSec,
      jti, client_id: client.clientId, scope: scopes.join(' '),
    }, 'at+jwt');
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: this.accessTtl, scope: scopes.join(' ') };
    if (withRefresh) {
      const rt = this.rnd(32);
      const idle = Math.min(t + (this.o.refreshIdleSec ?? 30 * 86400) * 1000, fam.absoluteExpires);
      this.refresh.set(sha(rt), { family: fam.id, idleExpires: idle, usedAt: undefined });
      body.refresh_token = rt;
    }
    if (scopes.includes('openid') && fam.subject !== undefined) {
      const atHash = createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url');
      body.id_token = signJwt(this.o.signing, {
        iss: this.o.issuer, sub: fam.subject, aud: client.clientId, exp: nowSec + this.accessTtl, iat: nowSec, auth_time: Math.floor(fam.authTime / 1000),
        ...(fam.nonce === undefined ? {} : { nonce: fam.nonce }), at_hash: atHash,
      });
    }
    return body;
  }

  // ------------------------------------------------------------ device authorization (RFC 8628)

  /** The device authorization endpoint. */
  deviceAuthorization(req: { authorization?: string | undefined; body: Readonly<Record<string, string | undefined>> }): TokenResponse {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };
    try {
      const client = this.authClient(req);
      if (!client.grantTypes.includes(GRANT_DEVICE)) throw new OAuthError('unauthorized_client', 'the client may not use the device grant');
      const scopes = this.parseScopes(req.body.scope, client);
      const deviceCode = this.rnd(32);
      let raw = '';
      const bytes = this.o.randomBytes(8);
      for (let i = 0; i < 8; i++) raw += USER_CODE_CHARS[bytes[i]! % USER_CODE_CHARS.length];
      const pretty = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const ttl = this.o.deviceTtlSec ?? 600;
      const interval = this.o.deviceIntervalSec ?? 5;
      this.devices.set(sha(deviceCode), { clientId: client.clientId, userCode: raw, scopes, expiresAt: this.now() + ttl * 1000, interval, lastPoll: this.now(), status: 'pending' });
      this.userCodes.set(raw, sha(deviceCode));
      const uri = this.o.deviceVerificationUri ?? `${this.o.issuer}/device`;
      return {
        status: 200, headers,
        body: { device_code: deviceCode, user_code: pretty, verification_uri: uri, verification_uri_complete: `${uri}?user_code=${pretty}`, expires_in: ttl, interval },
      };
    } catch (e) {
      if (e instanceof OAuthError) return { status: e.status, headers, body: { error: e.code, error_description: e.message } };
      throw e;
    }
  }

  private findUserCode(userCode: string, source: string): { key: string; rec: DeviceRec } {
    const t = this.now();
    const f = this.failures.get(source);
    if (f && f.lockedUntil > t) throw new OAuthError('access_denied', 'too many wrong codes; try again later', 429);
    const norm = userCode.toUpperCase().replace(/[\s-]/g, '');
    const key = this.userCodes.get(norm);
    const rec = key ? this.devices.get(key) : undefined;
    if (!key || !rec || rec.expiresAt <= t || rec.status !== 'pending') {
      const max = this.o.deviceMaxFailures ?? 5;
      const cur = !f || t - f.first > (this.o.deviceLockMs ?? 900_000) ? { n: 0, lockedUntil: 0, first: t } : f;
      cur.n += 1;
      if (cur.n >= max) cur.lockedUntil = t + (this.o.deviceLockMs ?? 900_000);
      this.failures.set(source, cur);
      throw new OAuthError('invalid_grant', 'that code is not valid');
    }
    this.failures.delete(source);
    return { key, rec };
  }

  /** What the person is asked to approve, for the page where they type the user code. `source` is who is typing (an IP or session). */
  lookupUserCode(userCode: string, source: string): { client: ClientRecord; scopes: readonly { name: string; description: string }[] } {
    const { rec } = this.findUserCode(userCode, source);
    return { client: this.o.registry.get(rec.clientId)!, scopes: rec.scopes.map((s) => ({ name: s, description: this.scopeDefs.get(s)!.description })) };
  }

  approveDevice(userCode: string, subject: Subject, source: string, granted?: readonly string[]): void {
    const { rec } = this.findUserCode(userCode, source);
    const g = granted ?? rec.scopes;
    const extra = g.find((s) => !rec.scopes.includes(s));
    if (extra) throw new OAuthError('invalid_scope', `the scope ${extra} was not requested`);
    rec.status = 'approved';
    rec.subject = subject;
    rec.grantedScopes = [...g];
  }

  denyDevice(userCode: string, source: string): void {
    this.findUserCode(userCode, source).rec.status = 'denied';
  }

  private deviceGrant(client: ClientRecord, b: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
    const dc = b.device_code;
    if (!dc) throw new OAuthError('invalid_request', 'device_code is required');
    const key = sha(dc);
    const rec = this.devices.get(key);
    if (!rec || rec.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'the device code is not valid');
    const t = this.now();
    if (rec.expiresAt <= t) {
      this.dropDevice(key, rec);
      throw new OAuthError('expired_token', 'the device code has expired');
    }
    if (t - rec.lastPoll < rec.interval * 1000) {
      rec.interval += 5;
      rec.lastPoll = t;
      throw new OAuthError('slow_down', `poll no faster than every ${rec.interval - 5} seconds`);
    }
    rec.lastPoll = t;
    if (rec.status === 'denied') {
      this.dropDevice(key, rec);
      throw new OAuthError('access_denied', 'the person refused');
    }
    if (rec.status === 'pending') throw new OAuthError('authorization_pending', 'the person has not approved yet');
    this.dropDevice(key, rec);
    const scopes = rec.grantedScopes ?? rec.scopes;
    const fam = this.newFamily(client, rec.subject!.id, scopes, rec.subject!.authTime, undefined);
    return this.respond(client, fam, scopes, client.grantTypes.includes(GRANT_REFRESH));
  }

  private dropDevice(key: string, rec: DeviceRec) {
    this.devices.delete(key);
    this.userCodes.delete(rec.userCode);
  }

  // ------------------------------------------------------------ resource side

  /** Checks an access token this server issued: signature, issuer, audience, expiry, and that it has not been revoked. */
  verifyAccessToken(token: string): { sub: string; clientId: string; scopes: string[]; jti: string; exp: number } {
    const keys = [{ alg: this.o.signing.alg, ...(this.o.signing.kid ? { kid: this.o.signing.kid } : {}), key: this.verifyKey() }, ...(this.o.oldKeys ?? [])];
    let c: Record<string, unknown>;
    try {
      c = verifyJwt(token, keys, { now: this.now(), issuer: this.o.issuer, audience: this.o.audience ?? this.o.issuer, typ: 'at+jwt' });
    } catch (e) {
      throw new OAuthError('invalid_token', (e as Error).message, 401);
    }
    const jti = String(c.jti);
    const fam = this.jtiFamily.get(jti);
    if (this.revokedJti.has(jti) || (fam !== undefined && this.families.get(fam)?.revoked)) throw new OAuthError('invalid_token', 'the token was revoked', 401);
    return { sub: String(c.sub), clientId: String(c.client_id), scopes: String(c.scope ?? '').split(' ').filter(Boolean), jti, exp: Number(c.exp) };
  }

  private verifyKey(): Uint8Array | string | KeyObject {
    const k = this.o.signing.key;
    return typeof k === 'object' && 'type' in k && k.type === 'private' ? createPublicKey(k) : k;
  }

  /** RFC 7662: whether a token is live, and what it says. Unknown, expired and revoked tokens are simply inactive. */
  introspect(token: string): Record<string, unknown> {
    try {
      const a = this.verifyAccessToken(token);
      return { active: true, scope: a.scopes.join(' '), client_id: a.clientId, sub: a.sub, exp: a.exp, jti: a.jti, token_type: 'Bearer', iss: this.o.issuer };
    } catch {
      const rec = this.refresh.get(sha(token));
      const fam = rec && this.families.get(rec.family);
      if (rec && fam && !fam.revoked && rec.usedAt === undefined && rec.idleExpires > this.now() && fam.absoluteExpires > this.now()) {
        return { active: true, scope: fam.scopes.join(' '), client_id: fam.clientId, ...(fam.subject ? { sub: fam.subject } : {}), exp: Math.floor(rec.idleExpires / 1000), token_type: 'refresh_token' };
      }
      return { active: false };
    }
  }

  /**
   * RFC 7009: a client revokes one of its own tokens. Revoking a refresh token ends the whole grant; revoking an
   * access token ends that token. Unknown tokens and other clients' tokens are ignored, and the answer is the same.
   */
  revoke(req: { authorization?: string | undefined; body: Readonly<Record<string, string | undefined>> }): TokenResponse {
    const headers = { 'cache-control': 'no-store' };
    try {
      const client = this.authClient(req);
      const tok = req.body.token;
      if (!tok) throw new OAuthError('invalid_request', 'token is required');
      const rec = this.refresh.get(sha(tok));
      if (rec) {
        const fam = this.families.get(rec.family);
        if (fam && fam.clientId === client.clientId) this.revokeFamily(fam.id);
      } else {
        try {
          const a = this.verifyAccessToken(tok);
          if (a.clientId === client.clientId) this.revokedJti.add(a.jti);
        } catch {
          // Not ours or already dead: nothing to do.
        }
      }
      return { status: 200, headers, body: {} };
    } catch (e) {
      if (e instanceof OAuthError) return { status: e.status, headers, body: { error: e.code, error_description: e.message } };
      throw e;
    }
  }

  /** Ends every grant of a person (password change, sign out everywhere). Returns how many grants were ended. */
  revokeSubject(subjectId: string): number {
    let n = 0;
    for (const f of this.families.values()) if (f.subject === subjectId && !f.revoked) { f.revoked = true; n++; }
    return n;
  }

  /** Whether a refresh token's family has been revoked, for tests and an admin view. */
  familyRevoked(refreshToken: string): boolean | undefined {
    const rec = this.refresh.get(sha(refreshToken));
    return rec ? this.families.get(rec.family)?.revoked : undefined;
  }
}
