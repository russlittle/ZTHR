/**
 * OpenID Connect Provider (the server that signs people in for other applications). The relying-party side is the
 * `oidc` block. Standards: OpenID Connect Core 1.0 (authorization code flow, ID token, UserInfo, claims, the
 * `claims` request parameter, pairwise subjects), OpenID Connect Discovery 1.0, OpenID Connect RP-Initiated Logout
 * 1.0, OpenID Connect Back-Channel Logout 1.0, OpenID Connect Front-Channel Logout 1.0, RFC 6749 (OAuth 2.0), RFC
 * 6750 (bearer tokens), RFC 7636 (PKCE), RFC 7009 (revocation), RFC 7515 to 7519 (JWS, JWK, JWA, JWT) with RS256 and
 * ES256 through node:crypto, RFC 9207 (the `iss` parameter on authorization responses).
 *
 * What it holds, since no OAuth server block exists to build on: the pieces of the authorization code flow that an
 * OpenID Provider needs, kept inside this block. `KeySet` signs and publishes keys with rotation; `Provider`
 * answers discovery and JWKS, checks an authorization request and returns what to do next (redirect with a code,
 * ask for login, ask for consent, show an error page), exchanges codes and refresh tokens for tokens, mints ID
 * tokens (sub, aud, exp, iat, auth_time, nonce, at_hash, sid, acr, amr), serves UserInfo, maps account attributes
 * to claims by scope and by the `claims` parameter, revokes tokens, and ends sessions with RP-initiated, back-channel
 * and front-channel logout. How the person proves who they are (passwords, passkeys, a login page) is not here:
 * the host application passes in who is signed in; the provider decides what follows from that.
 *
 * Security by default: only the code flow; PKCE with S256 required (plain refused); redirect URIs matched exactly
 * and registered with https (http only for loopback); a request with a repeated parameter is refused; codes live a
 * minute, work once, and a reused code revokes what it produced; refresh tokens rotate and a reused one revokes the
 * whole family; codes, tokens and client secrets are kept as SHA-256 hashes and compared in constant time; the
 * client authentication method is the one registered, no other; token and userinfo responses are `no-store`;
 * error pages are used instead of redirects whenever the client or redirect URI is not trusted; only registered
 * logout URIs are ever contacted; JWTs are verified with an algorithm allow-list and never `none`; claim values of
 * the wrong type are dropped; the `sub` seen by a client can be pairwise so clients cannot compare people.
 *
 * Out of scope: implicit and hybrid flows, request objects (`request`, `request_uri`), dynamic client registration,
 * client_credentials and device grants, encrypted ID tokens, token introspection (RFC 7662), session management
 * through `check_session_iframe`, login and consent screens, and durable storage (the store is an interface with
 * an in-memory version). Key generation uses the operating system's randomness; everything else takes `random` and
 * `now` as inputs.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------------------
// Errors and helpers
// ---------------------------------------------------------------------------------------------------------------

/** An OAuth 2.0 error with the code a client reads (`invalid_grant`, `invalid_request` ...). */
export class OAuthError extends Error {
  readonly code: string;
  readonly description: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  constructor(code: string, description: string, status = 400, headers: Record<string, string> = {}) {
    super(`${code}: ${description}`);
    this.name = 'OAuthError';
    this.code = code; this.description = description; this.status = status; this.headers = headers;
  }
}
/** The provider or a client was configured wrongly. */
export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name; }
}
/** A JWT or key is not acceptable. */
export class JwtError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name; }
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;
const b64u = (b: Uint8Array | string): string => Buffer.from(b as never).toString('base64url');
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const hashOf = (s: string): string => sha256(s).toString('base64url');
const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const sameText = (a: string, b: string): boolean => sameBytes(sha256(a), sha256(b));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** at_hash, c_hash: the left half of the SHA-256 of the value, base64url (Core section 3.3.2.11). */
export function halfHash(value: string): string { return sha256(value).subarray(0, 16).toString('base64url'); }
/** The PKCE S256 challenge for a verifier (RFC 7636 section 4.2). */
export function pkceChallenge(verifier: string): string { return sha256(verifier).toString('base64url'); }

// ---------------------------------------------------------------------------------------------------------------
// Keys and JWTs
// ---------------------------------------------------------------------------------------------------------------

export type Alg = 'RS256' | 'ES256';
export interface Jwk { readonly kty: string; readonly kid?: string; readonly use?: string; readonly alg?: string; readonly [k: string]: unknown }
export interface SigningKey { readonly kid: string; readonly alg: Alg; readonly privateKey: KeyObject; readonly retired: boolean }
export interface Jws { readonly header: Record<string, unknown>; readonly payload: Record<string, unknown> }

function jsonPart(s: string, what: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!isObj(v)) throw new Error('not an object');
    return v;
  } catch { throw new JwtError(`the ${what} is not a JSON object`); }
}

/**
 * Check a compact JWS against a set of public keys. The algorithm must be on the allow-list and match the key's
 * own algorithm; `none` is never accepted; a header with `crit` is refused because nothing here understands it.
 */
export function verifyJws(token: string, jwks: { readonly keys: readonly Jwk[] }, algs: readonly Alg[] = ['RS256', 'ES256']): Jws {
  if (typeof token !== 'string' || token.length > 16_384) throw new JwtError('the token is missing or too long');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new JwtError('not a compact JWS');
  const header = jsonPart(parts[0]!, 'header');
  const alg = header.alg;
  if (typeof alg !== 'string' || !(algs as readonly string[]).includes(alg)) throw new JwtError(`the algorithm ${String(alg)} is not accepted`);
  if ('crit' in header) throw new JwtError('a critical header is not understood');
  const kid = header.kid;
  const candidates = jwks.keys.filter((k) => (kid === undefined ? true : k.kid === kid) && (k.alg === undefined || k.alg === alg) && (k.use === undefined || k.use === 'sig') && k.kty === (alg === 'RS256' ? 'RSA' : 'EC'));
  if (candidates.length === 0 || (kid === undefined && candidates.length > 1)) throw new JwtError('no key matches the token');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2]!, 'base64url');
  for (const jwk of candidates) {
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      ok = alg === 'RS256' ? cryptoVerify('sha256', data, key, sig) : sig.length === 64 && cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch { ok = false; }
    if (ok) return { header, payload: jsonPart(parts[1]!, 'payload') };
  }
  throw new JwtError('the signature does not verify');
}

/** Signing keys with rotation: the newest key of an algorithm signs, retired keys stay published so old tokens still verify. */
export class KeySet {
  #keys: SigningKey[];
  constructor(keys: readonly SigningKey[]) {
    if (keys.length === 0 || keys.every((k) => k.retired)) throw new ConfigError('a key set needs at least one active key');
    if (new Set(keys.map((k) => k.kid)).size !== keys.length) throw new ConfigError('key ids must be unique');
    this.#keys = [...keys];
  }
  static generate(alg: Alg, kid: string): SigningKey {
    const { privateKey } = alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return { kid, alg, privateKey, retired: false };
  }
  static fromPem(alg: Alg, kid: string, pem: string): SigningKey {
    const privateKey = createPrivateKey(pem);
    if ((alg === 'RS256') !== (privateKey.asymmetricKeyType === 'rsa')) throw new ConfigError(`the key is not suitable for ${alg}`);
    if (alg === 'RS256' && (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new ConfigError('RSA keys must be at least 2048 bits');
    if (alg === 'ES256' && privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new ConfigError('ES256 needs a P-256 key');
    return { kid, alg, privateKey, retired: false };
  }
  /** Make `key` the signing key for its algorithm; earlier keys of that algorithm are retired but stay in the JWKS. */
  rotate(key: SigningKey): void {
    if (this.#keys.some((k) => k.kid === key.kid)) throw new ConfigError('that key id is already in use');
    this.#keys = this.#keys.map((k) => (k.alg === key.alg ? { ...k, retired: true } : k));
    this.#keys.push({ ...key, retired: false });
  }
  /** Stop publishing a retired key (once every token it signed has expired). */
  remove(kid: string): void {
    const k = this.#keys.find((x) => x.kid === kid);
    if (!k) throw new ConfigError('no such key');
    if (!k.retired) throw new ConfigError('an active key cannot be removed; rotate first');
    this.#keys = this.#keys.filter((x) => x.kid !== kid);
  }
  algorithms(): Alg[] { return [...new Set(this.#keys.filter((k) => !k.retired).map((k) => k.alg))]; }
  active(alg: Alg): SigningKey {
    const k = [...this.#keys].reverse().find((x) => x.alg === alg && !x.retired);
    if (!k) throw new ConfigError(`no active ${alg} key`);
    return k;
  }
  jwks(): { keys: Jwk[] } {
    return { keys: this.#keys.map((k) => ({ ...(createPublicKey(k.privateKey).export({ format: 'jwk' }) as Jwk), kid: k.kid, use: 'sig', alg: k.alg })) };
  }
  sign(payload: Record<string, unknown>, alg: Alg, typ = 'JWT'): string {
    const k = this.active(alg);
    const head = b64u(JSON.stringify({ alg, kid: k.kid, typ }));
    const body = b64u(JSON.stringify(payload));
    const data = Buffer.from(`${head}.${body}`);
    const sig = alg === 'RS256' ? cryptoSign('sha256', data, k.privateKey) : cryptoSign('sha256', data, { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${head}.${body}.${b64u(sig)}`;
  }
  verify(token: string, algs?: readonly Alg[]): Jws { return verifyJws(token, this.jwks(), algs ?? ['RS256', 'ES256']); }
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts and claims
// ---------------------------------------------------------------------------------------------------------------

export interface Account { readonly sub: string; readonly attributes: Readonly<Record<string, unknown>>; readonly disabled?: boolean }
export interface AccountStore { get(sub: string): Account | undefined }

export type ClaimSource = string | ((account: Account) => unknown);
export interface ClaimOptions {
  /** Where each claim comes from: a dotted path into the account's attributes, or a function. A claim not listed is read from the attribute of the same name. */
  readonly sources?: Readonly<Record<string, ClaimSource>>;
  /** Extra scopes and the claims they release, added to the standard ones. */
  readonly scopes?: Readonly<Record<string, readonly string[]>>;
}

export const STANDARD_SCOPES: Readonly<Record<string, readonly string[]>> = {
  openid: ['sub'],
  profile: ['name', 'family_name', 'given_name', 'middle_name', 'nickname', 'preferred_username', 'profile', 'picture', 'website', 'gender', 'birthdate', 'zoneinfo', 'locale', 'updated_at'],
  email: ['email', 'email_verified'],
  address: ['address'],
  phone: ['phone_number', 'phone_number_verified'],
};
const CLAIM_TYPES: Readonly<Record<string, 'string' | 'boolean' | 'number' | 'object'>> = {
  name: 'string', family_name: 'string', given_name: 'string', middle_name: 'string', nickname: 'string', preferred_username: 'string', profile: 'string', picture: 'string', website: 'string',
  gender: 'string', birthdate: 'string', zoneinfo: 'string', locale: 'string', updated_at: 'number', email: 'string', email_verified: 'boolean', address: 'object', phone_number: 'string', phone_number_verified: 'boolean',
};

function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The claims of an account for a set of claim names. Values of the wrong type, and empty ones, are left out. */
export function mapClaims(account: Account, names: Iterable<string>, o: ClaimOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of new Set(names)) {
    if (name === 'sub') continue;
    const src = o.sources && Object.hasOwn(o.sources, name) ? o.sources[name]! : name;
    const v = typeof src === 'function' ? src(account) : readPath(account.attributes, src);
    if (v === undefined || v === null || v === '') continue;
    const want = Object.hasOwn(CLAIM_TYPES, name) ? CLAIM_TYPES[name] : undefined;
    if (want === 'object' ? !isObj(v) : want !== undefined && typeof v !== want) continue;
    if (name === '__proto__') continue;
    Object.defineProperty(out, name, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export interface ClaimsRequest { readonly userinfo?: Readonly<Record<string, unknown>>; readonly id_token?: Readonly<Record<string, unknown>> }
function parseClaimsParam(raw: string): ClaimsRequest {
  if (raw.length > 4096) throw new OAuthError('invalid_request', 'the claims parameter is too long');
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new OAuthError('invalid_request', 'the claims parameter is not JSON'); }
  if (!isObj(v)) throw new OAuthError('invalid_request', 'the claims parameter must be a JSON object');
  const pick = (k: 'userinfo' | 'id_token'): Record<string, unknown> | undefined => {
    const m = v[k];
    if (m === undefined) return undefined;
    if (!isObj(m)) throw new OAuthError('invalid_request', `claims.${k} must be an object`);
    const out: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(m)) { if (spec !== null && !isObj(spec)) throw new OAuthError('invalid_request', `claims.${k}.${name} must be null or an object`); if (name !== '__proto__') out[name] = spec; }
    return out;
  };
  const userinfo = pick('userinfo'); const idToken = pick('id_token');
  return { ...(userinfo ? { userinfo } : {}), ...(idToken ? { id_token: idToken } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------------------------

export type AuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';
export interface ClientConfig {
  readonly id: string;
  /** Plain secret at registration; only its hash is kept. */
  readonly secret?: string;
  readonly name?: string;
  readonly redirectUris: readonly string[];
  readonly postLogoutRedirectUris?: readonly string[];
  readonly authMethod?: AuthMethod;
  readonly scopes?: readonly string[];
  readonly allowRefresh?: boolean;
  readonly idTokenAlg?: Alg;
  readonly subjectType?: 'public' | 'pairwise';
  readonly sectorIdentifier?: string;
  /** A client run by the same organisation: no consent screen. */
  readonly firstParty?: boolean;
  readonly backchannelLogoutUri?: string;
  readonly backchannelLogoutSessionRequired?: boolean;
  readonly frontchannelLogoutUri?: string;
  readonly frontchannelLogoutSessionRequired?: boolean;
}
interface Client {
  readonly id: string; readonly name: string; readonly secretHash?: Buffer; readonly redirectUris: readonly string[]; readonly postLogoutRedirectUris: readonly string[];
  readonly authMethod: AuthMethod; readonly scopes: readonly string[]; readonly allowRefresh: boolean; readonly idTokenAlg: Alg; readonly subjectType: 'public' | 'pairwise';
  readonly sector: string; readonly firstParty: boolean; readonly backchannelLogoutUri?: string; readonly backchannelLogoutSessionRequired: boolean;
  readonly frontchannelLogoutUri?: string; readonly frontchannelLogoutSessionRequired: boolean;
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
function checkUri(raw: string, what: string, o: { allowHttpLoopback: boolean; query?: boolean }): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConfigError(`${what} ${raw} is not an absolute URL`); }
  if (u.hash || raw.includes('#')) throw new ConfigError(`${what} must not have a fragment`);
  if (u.username || u.password) throw new ConfigError(`${what} must not carry credentials`);
  if (raw.includes('*')) throw new ConfigError(`${what} must not use wildcards`);
  const ok = u.protocol === 'https:' || (o.allowHttpLoopback && u.protocol === 'http:' && LOOPBACK.test(u.hostname));
  if (!ok) throw new ConfigError(`${what} must be https (http only for localhost)`);
  return u;
}

// ---------------------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------------------

export interface CodeRecord {
  readonly clientId: string; readonly sub: string; readonly sid: string; readonly scopes: readonly string[]; readonly redirectUri: string; readonly nonce?: string;
  readonly challenge: string; readonly authTime: number; readonly acr?: string; readonly amr?: readonly string[]; readonly claims?: ClaimsRequest; readonly expires: number;
  readonly family: string; used: boolean;
}
export interface TokenRecord {
  readonly kind: 'access' | 'refresh'; readonly clientId: string; readonly sub: string; readonly sid: string; readonly scopes: readonly string[]; readonly claims?: ClaimsRequest;
  readonly family: string; readonly expires: number; readonly authTime: number; readonly acr?: string; readonly amr?: readonly string[]; used: boolean; revoked: boolean;
}
export interface SessionRecord { readonly sid: string; readonly sub: string; readonly clients: Set<string> }
export interface OidcStore {
  putCode(hash: string, rec: CodeRecord): void;
  getCode(hash: string): CodeRecord | undefined;
  putToken(hash: string, rec: TokenRecord): void;
  getToken(hash: string): TokenRecord | undefined;
  revokeFamily(family: string): void;
  revokeSession(sid: string): void;
  session(sid: string): SessionRecord | undefined;
  touchSession(sid: string, sub: string, clientId: string): void;
  endSession(sid: string): void;
  sessionsOf(sub: string): string[];
  consent(sub: string, clientId: string): readonly string[] | undefined;
  setConsent(sub: string, clientId: string, scopes: readonly string[]): void;
  /** Remove expired codes and tokens; returns how many. */
  purge(now: number): number;
}

export function memoryStore(): OidcStore {
  const codes = new Map<string, CodeRecord>();
  const tokens = new Map<string, TokenRecord>();
  const sessions = new Map<string, SessionRecord>();
  const consents = new Map<string, readonly string[]>();
  return {
    putCode: (h, r) => { codes.set(h, r); },
    getCode: (h) => codes.get(h),
    putToken: (h, r) => { tokens.set(h, r); },
    getToken: (h) => tokens.get(h),
    revokeFamily: (f) => { for (const t of tokens.values()) if (t.family === f) t.revoked = true; },
    revokeSession: (sid) => { for (const t of tokens.values()) if (t.sid === sid) t.revoked = true; },
    session: (sid) => sessions.get(sid),
    touchSession: (sid, sub, clientId) => { const s = sessions.get(sid) ?? { sid, sub, clients: new Set<string>() }; s.clients.add(clientId); sessions.set(sid, s); },
    endSession: (sid) => { sessions.delete(sid); },
    sessionsOf: (sub) => [...sessions.values()].filter((s) => s.sub === sub).map((s) => s.sid),
    consent: (sub, c) => consents.get(`${sub}\u0000${c}`),
    setConsent: (sub, c, scopes) => { consents.set(`${sub}\u0000${c}`, [...scopes]); },
    purge: (now) => {
      let n = 0;
      for (const [h, c] of codes) if (c.expires < now) { codes.delete(h); n++; }
      for (const [h, t] of tokens) if (t.expires < now) { tokens.delete(h); n++; }
      return n;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------------------------

export interface Paths { readonly authorization: string; readonly token: string; readonly userinfo: string; readonly jwks: string; readonly endSession: string; readonly revocation: string }
export interface Lifetimes { readonly code?: number; readonly accessToken?: number; readonly idToken?: number; readonly refreshToken?: number; readonly backchannelToken?: number; readonly reauthWindow?: number }
export interface ProviderOptions {
  readonly issuer: string;
  readonly keys: KeySet;
  readonly accounts: AccountStore;
  readonly now: () => number;
  readonly random?: (bytes: number) => Uint8Array;
  readonly store?: OidcStore;
  readonly paths?: Partial<Paths>;
  /** Lifetimes in seconds. Defaults: code 60, access token 600, ID token 600, refresh token 30 days, logout token 120, re-authentication window 60. */
  readonly lifetimes?: Lifetimes;
  readonly claims?: ClaimOptions;
  /** Secret mixed into pairwise subject identifiers. Required when any client uses pairwise subjects. */
  readonly pairwiseSalt?: string;
  /** Also put the claims of the granted scopes into the ID token (default false: they come from UserInfo). */
  readonly claimsInIdToken?: boolean;
  /** Accept http redirect URIs on localhost (default false). */
  readonly allowHttpLoopback?: boolean;
}

const DEFAULT_PATHS: Paths = { authorization: '/authorize', token: '/token', userinfo: '/userinfo', jwks: '/jwks', endSession: '/logout', revocation: '/revoke' };
export const WELL_KNOWN = '/.well-known/openid-configuration';
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Who is signed in at the provider, as the host application knows it. `authTime` is in seconds. */
export interface Authn { readonly sub: string; readonly sid: string; readonly authTime: number; readonly acr?: string; readonly amr?: readonly string[] }

export type AuthorizeResult =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'login'; readonly reason: 'none' | 'prompt' | 'max_age'; readonly clientId: string }
  | { readonly kind: 'consent'; readonly clientId: string; readonly clientName: string; readonly scopes: readonly string[] }
  | { readonly kind: 'error'; readonly status: number; readonly error: string; readonly description: string };

export interface TokenResponse { readonly status: 200; readonly headers: Readonly<Record<string, string>>; readonly body: Readonly<Record<string, unknown>> }
export interface ErrorResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: { readonly error: string; readonly error_description: string } }

export interface LogoutPlan {
  readonly sid: string;
  readonly sub: string;
  readonly backchannel: readonly { readonly clientId: string; readonly uri: string; readonly logoutToken: string }[];
  readonly frontchannel: readonly { readonly clientId: string; readonly url: string }[];
}
export interface EndSession {
  /** True when no id_token_hint proved who is asking: show the person a confirmation, then call again with `confirmed`. */
  readonly confirmRequired: boolean;
  readonly plan?: LogoutPlan;
  readonly redirectTo?: string;
}
export interface BackchannelResult { readonly clientId: string; readonly ok: boolean; readonly status?: number; readonly error?: string }

type Params = URLSearchParams | Record<string, string | readonly string[] | undefined>;

function single(p: Params, max = 4096): Map<string, string> {
  const out = new Map<string, string>();
  const add = (k: string, v: string): void => {
    if (out.has(k)) throw new OAuthError('invalid_request', `the parameter ${k} is repeated`);
    if (v.length > max) throw new OAuthError('invalid_request', `the parameter ${k} is too long`);
    out.set(k, v);
  };
  if (p instanceof URLSearchParams) for (const [k, v] of p) add(k, v);
  else for (const [k, v] of Object.entries(p)) { if (v === undefined) continue; if (typeof v === 'string') add(k, v); else if (v.length === 1) add(k, v[0]!); else if (v.length > 1) throw new OAuthError('invalid_request', `the parameter ${k} is repeated`); }
  return out;
}

export class Provider {
  readonly #o: ProviderOptions;
  readonly #store: OidcStore;
  readonly #clients = new Map<string, Client>();
  readonly #paths: Paths;
  readonly #life: Required<Lifetimes>;
  readonly #claimScopes: Record<string, readonly string[]>;
  readonly #issuer: string;

  constructor(o: ProviderOptions) {
    let u: URL;
    try { u = new URL(o.issuer); } catch { throw new ConfigError('the issuer must be an absolute URL'); }
    if (u.search || u.hash) throw new ConfigError('the issuer must not have a query or fragment');
    if (!(u.protocol === 'https:' || (o.allowHttpLoopback === true && u.protocol === 'http:' && LOOPBACK.test(u.hostname)))) throw new ConfigError('the issuer must be an https URL');
    if (o.issuer.endsWith('/')) throw new ConfigError('the issuer must not end with a slash');
    this.#o = o;
    this.#issuer = o.issuer;
    this.#store = o.store ?? memoryStore();
    this.#paths = { ...DEFAULT_PATHS, ...o.paths };
    const l = o.lifetimes ?? {};
    this.#life = { code: l.code ?? 60, accessToken: l.accessToken ?? 600, idToken: l.idToken ?? 600, refreshToken: l.refreshToken ?? 2_592_000, backchannelToken: l.backchannelToken ?? 120, reauthWindow: l.reauthWindow ?? 60 };
    this.#claimScopes = { ...STANDARD_SCOPES, ...(o.claims?.scopes ?? {}) };
  }

  #rand(n: number): Uint8Array { return (this.#o.random ?? randomBytes)(n); }
  #token(): string { return b64u(this.#rand(32)); }
  #sec(): number { return Math.floor(this.#o.now() / 1000); }
  #url(path: string): string { return `${this.#issuer}${path}`; }

  // ---- clients ----------------------------------------------------------------------------------------------

  registerClient(c: ClientConfig): void {
    if (!/^[A-Za-z0-9._~-]{1,100}$/.test(c.id)) throw new ConfigError('a client id is 1 to 100 letters, digits and ._~-');
    if (this.#clients.has(c.id)) throw new ConfigError(`client ${c.id} already exists`);
    const loop = this.#o.allowHttpLoopback === true;
    if (c.redirectUris.length === 0 || c.redirectUris.length > 10) throw new ConfigError('a client needs 1 to 10 redirect URIs');
    const redirectUris = c.redirectUris.map((r) => { checkUri(r, 'a redirect URI', { allowHttpLoopback: loop }); return r; });
    const post = (c.postLogoutRedirectUris ?? []).map((r) => { checkUri(r, 'a post-logout redirect URI', { allowHttpLoopback: loop }); return r; });
    const authMethod = c.authMethod ?? (c.secret === undefined ? 'none' : 'client_secret_basic');
    if (authMethod !== 'none' && (c.secret === undefined || c.secret.length < 16)) throw new ConfigError('a confidential client needs a secret of at least 16 characters');
    if (authMethod === 'none' && c.secret !== undefined) throw new ConfigError('a client with authMethod none has no secret');
    const subjectType = c.subjectType ?? 'public';
    if (subjectType === 'pairwise' && this.#o.pairwiseSalt === undefined) throw new ConfigError('pairwise subjects need a pairwiseSalt in the provider options');
    const hosts = new Set(redirectUris.map((r) => new URL(r).host));
    if (subjectType === 'pairwise' && c.sectorIdentifier === undefined && hosts.size > 1) throw new ConfigError('a pairwise client with redirect URIs on several hosts needs a sectorIdentifier');
    const bc = c.backchannelLogoutUri === undefined ? undefined : checkUri(c.backchannelLogoutUri, 'the back-channel logout URI', { allowHttpLoopback: loop }).href;
    const fc = c.frontchannelLogoutUri === undefined ? undefined : checkUri(c.frontchannelLogoutUri, 'the front-channel logout URI', { allowHttpLoopback: loop }).href;
    const idTokenAlg = c.idTokenAlg ?? this.#o.keys.algorithms()[0]!;
    if (!this.#o.keys.algorithms().includes(idTokenAlg)) throw new ConfigError(`no active ${idTokenAlg} key to sign ID tokens with`);
    const scopes = [...new Set(['openid', ...(c.scopes ?? ['profile', 'email'])])];
    const unknown = scopes.filter((s) => !Object.hasOwn(this.#claimScopes, s) && s !== 'offline_access');
    if (unknown.length) throw new ConfigError(`unknown scope ${unknown.join(', ')}`);
    this.#clients.set(c.id, {
      id: c.id, name: c.name ?? c.id, ...(c.secret === undefined ? {} : { secretHash: sha256(c.secret) }), redirectUris, postLogoutRedirectUris: post, authMethod, scopes, allowRefresh: c.allowRefresh === true,
      idTokenAlg, subjectType, sector: c.sectorIdentifier ?? [...hosts][0]!, firstParty: c.firstParty === true,
      ...(bc ? { backchannelLogoutUri: bc } : {}), backchannelLogoutSessionRequired: c.backchannelLogoutSessionRequired === true,
      ...(fc ? { frontchannelLogoutUri: fc } : {}), frontchannelLogoutSessionRequired: c.frontchannelLogoutSessionRequired === true,
    });
  }

  #subFor(c: Client, sub: string): string {
    if (c.subjectType === 'public') return sub;
    return b64u(sha256(`${c.sector}\u0000${sub}\u0000${this.#o.pairwiseSalt ?? ''}`));
  }

  // ---- discovery ----------------------------------------------------------------------------------------------

  discovery(): Record<string, unknown> {
    const scopes = [...new Set([...Object.keys(this.#claimScopes), 'offline_access'])];
    const claims = [...new Set(['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'acr', 'amr', 'sid', ...Object.values(this.#claimScopes).flat()])];
    return {
      issuer: this.#issuer,
      authorization_endpoint: this.#url(this.#paths.authorization),
      token_endpoint: this.#url(this.#paths.token),
      userinfo_endpoint: this.#url(this.#paths.userinfo),
      jwks_uri: this.#url(this.#paths.jwks),
      end_session_endpoint: this.#url(this.#paths.endSession),
      revocation_endpoint: this.#url(this.#paths.revocation),
      scopes_supported: scopes,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: this.#o.pairwiseSalt === undefined ? ['public'] : ['public', 'pairwise'],
      id_token_signing_alg_values_supported: this.#o.keys.algorithms(),
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      claim_types_supported: ['normal'],
      claims_supported: claims,
      claims_parameter_supported: true,
      request_parameter_supported: false,
      request_uri_parameter_supported: false,
      authorization_response_iss_parameter_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      frontchannel_logout_supported: true,
      frontchannel_logout_session_supported: true,
    };
  }
  jwks(): { keys: Jwk[] } { return this.#o.keys.jwks(); }

  // ---- authorization ------------------------------------------------------------------------------------------

  /**
   * Decide what follows an authorization request. `authn` is who is signed in now (or null). Call again after a login
   * page or consent page has done its work; pass `consented: true` once the person has agreed to the scopes shown.
   */
  authorize(params: Params, authn: Authn | null, o: { consented?: boolean } = {}): AuthorizeResult {
    const page = (error: string, description: string, status = 400): AuthorizeResult => ({ kind: 'error', status, error, description });
    let q: Map<string, string>;
    try { q = single(params); } catch (e) { return e instanceof OAuthError ? page(e.code, e.description) : page('invalid_request', 'bad request'); }
    const client = q.get('client_id') === undefined ? undefined : this.#clients.get(q.get('client_id')!);
    if (!client) return page('invalid_client', 'the client_id is missing or unknown');
    const redirectUri = q.get('redirect_uri');
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) return page('invalid_request', 'the redirect_uri is missing or not registered for this client');
    const state = q.get('state');
    const back = (error: string, description: string): AuthorizeResult => ({ kind: 'redirect', url: this.#redirect(redirectUri, { error, error_description: description, ...(state !== undefined ? { state } : {}) }) });
    if (state !== undefined && state.length > 1024) return back('invalid_request', 'the state is too long');
    if (q.has('request')) return back('request_not_supported', 'request objects are not supported');
    if (q.has('request_uri')) return back('request_uri_not_supported', 'request_uri is not supported');
    if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
    if (q.has('response_mode') && q.get('response_mode') !== 'query') return back('invalid_request', 'only response_mode=query is supported');
    const requested = (q.get('scope') ?? '').split(' ').filter(Boolean);
    if (!requested.includes('openid')) return back('invalid_scope', 'the scope must include openid');
    const scopes = requested.filter((s) => client.scopes.includes(s) || (s === 'offline_access' && client.allowRefresh));
    const challenge = q.get('code_challenge');
    if (challenge === undefined) return back('invalid_request', 'code_challenge is required (PKCE)');
    if (q.get('code_challenge_method') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'code_challenge is not a SHA-256 value in base64url');
    const nonce = q.get('nonce');
    if (nonce !== undefined && nonce.length > 255) return back('invalid_request', 'the nonce is too long');
    const prompts = (q.get('prompt') ?? '').split(' ').filter(Boolean);
    if (prompts.some((p) => !['none', 'login', 'consent', 'select_account'].includes(p))) return back('invalid_request', 'unknown prompt value');
    if (prompts.includes('none') && prompts.length > 1) return back('invalid_request', 'prompt=none cannot be combined with other values');
    let maxAge: number | undefined;
    if (q.has('max_age')) {
      if (!/^[0-9]{1,9}$/.test(q.get('max_age')!)) return back('invalid_request', 'max_age must be a whole number of seconds');
      maxAge = Number(q.get('max_age'));
    }
    let claims: ClaimsRequest | undefined;
    if (q.has('claims')) { try { claims = parseClaimsParam(q.get('claims')!); } catch (e) { return back('invalid_request', (e as OAuthError).description); } }

    const now = this.#sec();
    const needLogin = !authn ? 'none' as const : prompts.includes('login') && now - authn.authTime > this.#life.reauthWindow ? 'prompt' as const : maxAge !== undefined && now - authn.authTime > maxAge ? 'max_age' as const : undefined;
    if (needLogin || !authn) {
      if (prompts.includes('none')) return back('login_required', 'the person is not signed in');
      return { kind: 'login', reason: needLogin ?? 'none', clientId: client.id };
    }
    if (!client.firstParty) {
      const have = this.#store.consent(authn.sub, client.id) ?? [];
      const covered = scopes.every((s) => s === 'openid' || have.includes(s));
      if (o.consented === true) this.#store.setConsent(authn.sub, client.id, [...new Set([...have, ...scopes])]);
      else if (!covered || prompts.includes('consent')) {
        if (prompts.includes('none')) return back('consent_required', 'the person has not agreed to these scopes');
        return { kind: 'consent', clientId: client.id, clientName: client.name, scopes: scopes.filter((s) => s !== 'openid') };
      }
    }
    const code = this.#token();
    const family = this.#token();
    this.#store.putCode(hashOf(code), {
      clientId: client.id, sub: authn.sub, sid: authn.sid, scopes, redirectUri, challenge, authTime: authn.authTime, expires: this.#o.now() + this.#life.code * 1000, family, used: false,
      ...(nonce !== undefined ? { nonce } : {}), ...(authn.acr !== undefined ? { acr: authn.acr } : {}), ...(authn.amr ? { amr: authn.amr } : {}), ...(claims ? { claims } : {}),
    });
    this.#store.touchSession(authn.sid, authn.sub, client.id);
    return { kind: 'redirect', url: this.#redirect(redirectUri, { code, ...(state !== undefined ? { state } : {}) }) };
  }

  #redirect(base: string, params: Record<string, string>): string {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('iss', this.#issuer);
    return u.href;
  }

  // ---- token endpoint -----------------------------------------------------------------------------------------

  #authenticate(headers: string | undefined, q: Map<string, string>): Client {
    const fail = (): never => { throw new OAuthError('invalid_client', 'client authentication failed', 401, { 'WWW-Authenticate': 'Basic realm="token"' }); };
    let id: string | undefined; let secret: string | undefined; let via: AuthMethod | undefined;
    if (headers !== undefined && /^basic /i.test(headers)) {
      const raw = Buffer.from(headers.slice(6).trim(), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i < 0) return fail();
      try { id = decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')); secret = decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')); } catch { return fail(); }
      via = 'client_secret_basic';
    } else if (q.has('client_secret')) { id = q.get('client_id'); secret = q.get('client_secret'); via = 'client_secret_post'; }
    else { id = q.get('client_id'); via = 'none'; }
    const client = id === undefined ? undefined : this.#clients.get(id);
    if (!client) { sameText(secret ?? '', 'x'); return fail(); }
    if (client.authMethod !== via) return fail();
    if (client.secretHash) { if (secret === undefined || !sameBytes(sha256(secret), client.secretHash)) return fail(); }
    if (q.has('client_id') && q.get('client_id') !== client.id) return fail();
    return client;
  }

  /** Handle a request to the token endpoint. `authorization` is the Authorization header; `body` the form fields. Throws OAuthError. */
  token(req: { readonly authorization?: string; readonly body: Params }): TokenResponse {
    const q = single(req.body);
    const client = this.#authenticate(req.authorization, q);
    const grant = q.get('grant_type');
    if (grant === 'authorization_code') return this.#codeGrant(client, q);
    if (grant === 'refresh_token' && client.allowRefresh) return this.#refreshGrant(client, q);
    throw new OAuthError('unsupported_grant_type', 'the grant_type is not supported for this client');
  }

  /** The same as `token` but never throws: errors come back as a response ready to send. */
  tokenResponse(req: { readonly authorization?: string; readonly body: Params }): TokenResponse | ErrorResponse { return this.#guard(() => this.token(req)); }
  #guard<T>(f: () => T): T | ErrorResponse {
    try { return f(); } catch (e) {
      if (e instanceof OAuthError) return { status: e.status, headers: { ...NO_STORE, ...e.headers }, body: { error: e.code, error_description: e.description } };
      throw e;
    }
  }

  #codeGrant(client: Client, q: Map<string, string>): TokenResponse {
    const code = q.get('code');
    const bad = (why: string): never => { throw new OAuthError('invalid_grant', why); };
    if (code === undefined) return bad('the code is missing');
    const h = hashOf(code);
    const rec = this.#store.getCode(h);
    if (!rec) return bad('the code is not valid');
    if (rec.used) { this.#store.revokeFamily(rec.family); return bad('the code was already used; tokens issued from it are revoked'); }
    rec.used = true;
    if (rec.expires < this.#o.now()) return bad('the code has expired');
    if (rec.clientId !== client.id) return bad('the code was issued to another client');
    if (q.get('redirect_uri') !== rec.redirectUri) return bad('the redirect_uri does not match the authorization request');
    const verifier = q.get('code_verifier');
    if (verifier === undefined || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return bad('the code_verifier is missing or malformed');
    if (!sameText(pkceChallenge(verifier), rec.challenge)) return bad('the code_verifier does not match the code_challenge');
    return this.#issue(client, rec, rec.family, rec.scopes, rec.nonce);
  }

  #issue(client: Client, g: { sub: string; sid: string; authTime: number; acr?: string | undefined; amr?: readonly string[] | undefined; claims?: ClaimsRequest | undefined }, family: string, grantScopes: readonly string[], nonce?: string, narrowed?: readonly string[]): TokenResponse {
    const scopes = narrowed ?? grantScopes;
    const now = this.#o.now();
    const access = this.#token();
    const base = { clientId: client.id, sub: g.sub, sid: g.sid, family, authTime: g.authTime, used: false, revoked: false, ...(g.claims ? { claims: g.claims } : {}), ...(g.acr !== undefined ? { acr: g.acr } : {}), ...(g.amr ? { amr: g.amr } : {}) };
    this.#store.putToken(hashOf(access), { ...base, scopes, kind: 'access', expires: now + this.#life.accessToken * 1000 });
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: this.#life.accessToken, scope: scopes.join(' ') };
    if (grantScopes.includes('offline_access') && client.allowRefresh) {
      const refresh = this.#token();
      this.#store.putToken(hashOf(refresh), { ...base, scopes: grantScopes, kind: 'refresh', expires: now + this.#life.refreshToken * 1000 });
      body.refresh_token = refresh;
    }
    if (scopes.includes('openid')) body.id_token = this.#idToken(client, g, access, scopes, nonce);
    return { status: 200, headers: NO_STORE, body };
  }

  #idToken(client: Client, g: { sub: string; sid: string; authTime: number; acr?: string | undefined; amr?: readonly string[] | undefined; claims?: ClaimsRequest | undefined }, access: string, scopes: readonly string[], nonce?: string): string {
    const iat = this.#sec();
    const payload: Record<string, unknown> = {
      iss: this.#issuer, sub: this.#subFor(client, g.sub), aud: client.id, exp: iat + this.#life.idToken, iat, auth_time: g.authTime, at_hash: halfHash(access), sid: g.sid,
    };
    if (nonce !== undefined) payload.nonce = nonce;
    if (g.acr !== undefined) payload.acr = g.acr;
    if (g.amr) payload.amr = g.amr;
    const account = this.#o.accounts.get(g.sub);
    if (account && !account.disabled) {
      const names = new Set<string>(Object.keys(g.claims?.id_token ?? {}));
      if (this.#o.claimsInIdToken === true) for (const s of scopes) for (const c of this.#claimScopes[s] ?? []) names.add(c);
      for (const [k, v] of Object.entries(mapClaims(account, names, this.#o.claims))) if (!(k in payload)) payload[k] = v;
    }
    return this.#o.keys.sign(payload, client.idTokenAlg);
  }

  #refreshGrant(client: Client, q: Map<string, string>): TokenResponse {
    const bad = (why: string): never => { throw new OAuthError('invalid_grant', why); };
    const rt = q.get('refresh_token');
    if (rt === undefined) return bad('the refresh_token is missing');
    const rec = this.#store.getToken(hashOf(rt));
    if (!rec || rec.kind !== 'refresh') return bad('the refresh token is not valid');
    if (rec.used) { this.#store.revokeFamily(rec.family); return bad('the refresh token was already used; the whole grant is revoked'); }
    if (rec.revoked || rec.expires < this.#o.now()) return bad('the refresh token has expired or been revoked');
    if (rec.clientId !== client.id) return bad('the refresh token was issued to another client');
    let narrowed: readonly string[] | undefined;
    if (q.has('scope')) {
      const asked = q.get('scope')!.split(' ').filter(Boolean);
      if (asked.some((s) => !rec.scopes.includes(s))) throw new OAuthError('invalid_scope', 'a refresh cannot add scopes that were not granted');
      narrowed = asked;
    }
    rec.used = true;
    const account = this.#o.accounts.get(rec.sub);
    if (!account || account.disabled) { this.#store.revokeFamily(rec.family); return bad('the account is no longer active'); }
    return this.#issue(client, rec, rec.family, rec.scopes, undefined, narrowed);
  }

  /** RFC 7009. A token is revoked together with the others from the same grant when it is a refresh token. Unknown tokens are not an error. */
  revoke(req: { readonly authorization?: string; readonly body: Params }): { status: 200 } {
    const q = single(req.body);
    const client = this.#authenticate(req.authorization, q);
    const tok = q.get('token');
    if (tok !== undefined) {
      const rec = this.#store.getToken(hashOf(tok));
      if (rec && rec.clientId === client.id) { if (rec.kind === 'refresh') this.#store.revokeFamily(rec.family); else rec.revoked = true; }
    }
    return { status: 200 };
  }

  // ---- userinfo -------------------------------------------------------------------------------------------------

  /** The UserInfo response for an `Authorization: Bearer ...` header. Throws OAuthError (status 401, with WWW-Authenticate). */
  userinfo(authorization: string | undefined): { status: 200; headers: Readonly<Record<string, string>>; body: Record<string, unknown> } {
    const fail = (error: string, why: string): never => { throw new OAuthError(error, why, 401, { 'WWW-Authenticate': `Bearer error="${error}"` }); };
    if (authorization === undefined) return fail('invalid_request', 'no bearer token');
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization);
    if (!m) return fail('invalid_request', 'the Authorization header is not a bearer token');
    const rec = this.#store.getToken(hashOf(m[1]!));
    if (!rec || rec.kind !== 'access' || rec.revoked || rec.expires < this.#o.now()) return fail('invalid_token', 'the access token is not valid');
    if (!rec.scopes.includes('openid')) return fail('insufficient_scope', 'the token has no openid scope');
    const account = this.#o.accounts.get(rec.sub);
    if (!account || account.disabled) return fail('invalid_token', 'the account is no longer active');
    const client = this.#clients.get(rec.clientId)!;
    const names = new Set<string>(Object.keys(rec.claims?.userinfo ?? {}));
    for (const s of rec.scopes) for (const c of this.#claimScopes[s] ?? []) names.add(c);
    const claims = mapClaims(account, names, this.#o.claims);
    return { status: 200, headers: NO_STORE, body: { sub: this.#subFor(client, rec.sub), ...claims } };
  }

  // ---- logout ---------------------------------------------------------------------------------------------------

  /** Build the logout plan for a session and end it: its tokens stop working and the session is forgotten. */
  logoutSession(sid: string): LogoutPlan | undefined {
    const s = this.#store.session(sid);
    if (!s) return undefined;
    const backchannel: { clientId: string; uri: string; logoutToken: string }[] = [];
    const frontchannel: { clientId: string; url: string }[] = [];
    const iat = this.#sec();
    for (const cid of s.clients) {
      const c = this.#clients.get(cid);
      if (!c) continue;
      if (c.backchannelLogoutUri) {
        const payload: Record<string, unknown> = { iss: this.#issuer, sub: this.#subFor(c, s.sub), aud: c.id, iat, exp: iat + this.#life.backchannelToken, jti: this.#token(), events: { [BACKCHANNEL_EVENT]: {} } };
        if (c.backchannelLogoutSessionRequired) payload.sid = s.sid;
        backchannel.push({ clientId: c.id, uri: c.backchannelLogoutUri, logoutToken: this.#o.keys.sign(payload, c.idTokenAlg, 'logout+jwt') });
      }
      if (c.frontchannelLogoutUri) {
        const u = new URL(c.frontchannelLogoutUri);
        if (c.frontchannelLogoutSessionRequired) { u.searchParams.set('iss', this.#issuer); u.searchParams.set('sid', s.sid); }
        frontchannel.push({ clientId: c.id, url: u.href });
      }
    }
    this.#store.revokeSession(sid);
    this.#store.endSession(sid);
    return { sid, sub: s.sub, backchannel, frontchannel };
  }

  /** End every session of a person (an administrator disabling an account, a password reset). */
  logoutPerson(sub: string): LogoutPlan[] {
    return this.#store.sessionsOf(sub).map((sid) => this.logoutSession(sid)).filter((p): p is LogoutPlan => p !== undefined);
  }

  /**
   * RP-initiated logout. With a valid `id_token_hint` the request is known to come from a client that has the person's
   * token and the session is ended at once. Without one the call returns `confirmRequired` and does nothing until it
   * is repeated with `confirmed: true` by the host application after asking the person. `current` is the session the
   * browser holds at the provider, if any.
   */
  endSession(params: Params, current: { readonly sid: string } | null, o: { confirmed?: boolean } = {}): EndSession {
    const q = single(params);
    let hintClient: string | undefined; let hintSid: string | undefined;
    const hint = q.get('id_token_hint');
    if (hint !== undefined) {
      let jws: Jws;
      try { jws = this.#o.keys.verify(hint); } catch { throw new OAuthError('invalid_request', 'the id_token_hint is not one this provider signed'); }
      if (jws.payload.iss !== this.#issuer || typeof jws.payload.aud !== 'string' || !this.#clients.has(jws.payload.aud)) throw new OAuthError('invalid_request', 'the id_token_hint is not for a registered client');
      hintClient = jws.payload.aud;
      if (typeof jws.payload.sid === 'string') hintSid = jws.payload.sid;
    }
    const clientId = q.get('client_id');
    if (clientId !== undefined && hintClient !== undefined && clientId !== hintClient) throw new OAuthError('invalid_request', 'client_id does not match the id_token_hint');
    const who = this.#clients.get(hintClient ?? clientId ?? '');
    if (clientId !== undefined && !who) throw new OAuthError('invalid_request', 'unknown client_id');
    let redirectTo: string | undefined;
    const post = q.get('post_logout_redirect_uri');
    if (post !== undefined) {
      if (!who) throw new OAuthError('invalid_request', 'post_logout_redirect_uri needs an id_token_hint or client_id');
      if (!who.postLogoutRedirectUris.includes(post)) throw new OAuthError('invalid_request', 'the post_logout_redirect_uri is not registered for this client');
      const u = new URL(post);
      if (q.has('state')) u.searchParams.set('state', q.get('state')!);
      redirectTo = u.href;
    }
    const confirmRequired = hint === undefined && o.confirmed !== true;
    if (confirmRequired) return { confirmRequired: true, ...(redirectTo ? { redirectTo } : {}) };
    const sid = hintSid ?? current?.sid;
    const plan = sid === undefined ? undefined : this.logoutSession(sid);
    return { confirmRequired: false, ...(plan ? { plan } : {}), ...(redirectTo ? { redirectTo } : {}) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Logout delivery
// ---------------------------------------------------------------------------------------------------------------

export interface PostFn { (url: string, body: string, headers: Record<string, string>): Promise<{ readonly status: number }> }

/**
 * Deliver back-channel logout tokens to the URIs in a plan (these are the registered ones, never anything else) with
 * the HTTP function you pass in; one client failing does not stop the others. A 200 or 204 counts as delivered.
 */
export async function sendBackchannel(plan: LogoutPlan, post: PostFn): Promise<BackchannelResult[]> {
  const run = async (b: LogoutPlan['backchannel'][number]): Promise<BackchannelResult> => {
    try {
      const res = await post(b.uri, `logout_token=${encodeURIComponent(b.logoutToken)}`, { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' });
      return { clientId: b.clientId, ok: res.status === 200 || res.status === 204, status: res.status };
    } catch (e) { return { clientId: b.clientId, ok: false, error: (e as Error).message }; }
  };
  return Promise.all(plan.backchannel.map(run));
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A page that loads each client's front-channel logout URL in a hidden frame, with a CSP that allows only those frames. */
export function frontchannelPage(plan: LogoutPlan): { html: string; headers: Record<string, string> } {
  const origins = [...new Set(plan.frontchannel.map((f) => new URL(f.url).origin))];
  const frames = plan.frontchannel.map((f) => `<iframe src="${esc(f.url)}" style="display:none" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin"></iframe>`).join('');
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Signing out</title></head><body><p>Signing out&hellip;</p>${frames}</body></html>`,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-src ${origins.join(' ') || "'none'"}`, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  };
}

export interface LogoutTokenCheck {
  readonly jwks: { readonly keys: readonly Jwk[] };
  readonly issuer: string;
  readonly clientId: string;
  readonly now: number;
  /** Return true if this jti was already seen (and remember it otherwise). */
  readonly seen?: (jti: string) => boolean;
  readonly requireSid?: boolean;
  /** Allowed clock difference in seconds. Default 60. */
  readonly skew?: number;
}

/** The relying party's checks on a logout token (Back-Channel Logout 1.0 section 2.6). Throws JwtError. */
export function validateLogoutToken(token: string, c: LogoutTokenCheck): { sub?: string; sid?: string; jti: string } {
  const { header, payload: p } = verifyJws(token, c.jwks);
  if (header.typ !== undefined && header.typ !== 'logout+jwt') throw new JwtError('the token type is not logout+jwt');
  if (p.iss !== c.issuer) throw new JwtError('wrong issuer');
  const aud = p.aud;
  if (!(aud === c.clientId || (Array.isArray(aud) && aud.includes(c.clientId)))) throw new JwtError('not for this client');
  const skew = c.skew ?? 60;
  const nowS = Math.floor(c.now / 1000);
  if (typeof p.iat !== 'number' || p.iat > nowS + skew) throw new JwtError('iat is missing or in the future');
  if (p.exp !== undefined && (typeof p.exp !== 'number' || p.exp < nowS - skew)) throw new JwtError('the token has expired');
  if (!isObj(p.events) || !isObj(p.events[BACKCHANNEL_EVENT])) throw new JwtError('the backchannel-logout event is missing');
  if ('nonce' in p) throw new JwtError('a logout token must not have a nonce');
  const sub = typeof p.sub === 'string' ? p.sub : undefined;
  const sid = typeof p.sid === 'string' ? p.sid : undefined;
  if (sub === undefined && sid === undefined) throw new JwtError('the token has neither sub nor sid');
  if (c.requireSid === true && sid === undefined) throw new JwtError('sid is required');
  if (typeof p.jti !== 'string' || p.jti === '') throw new JwtError('jti is missing');
  if (c.seen?.(p.jti) === true) throw new JwtError('this logout token was already used');
  return { ...(sub !== undefined ? { sub } : {}), ...(sid !== undefined ? { sid } : {}), jti: p.jti };
}
