/**
 * Single sign-on with OpenID Connect (Google, Microsoft, Okta and any certified provider): a sign-in link that
 * carries state, a nonce and a PKCE challenge; the callback that checks the state, exchanges the code, and
 * verifies the ID token's signature against the provider's published keys and its issuer, audience, expiry and
 * nonce before anything in it is believed. Keys are fetched once and refreshed when an unknown key id appears,
 * which is how providers rotate them.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig, type JsonWebKey } from 'node:crypto';

export interface Provider {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
}

export class SignInFailed extends Error {
  constructor(why: string) {
    super(why);
  }
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface Started {
  readonly url: string;
  /** Kept server-side (or in an encrypted cookie) until the callback. */
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly at: number;
}

export function start(p: Provider, now = Date.now()): Started {
  const state = b64u(randomBytes(24));
  const nonce = b64u(randomBytes(24));
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const u = new URL(p.authorizationEndpoint);
  u.search = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, scope: (p.scopes ?? ['openid', 'email', 'profile']).join(' '), state, nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { url: u.toString(), state, nonce, verifier, at: now };
}

export interface Claims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly [k: string]: unknown;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

/** The key type and curve each accepted algorithm must be verified with, so a key is never used for another. */
const FITS: Readonly<Record<string, (k: Jwk) => boolean>> = { RS256: (k) => k.kty === 'RSA', ES256: (k) => k.kty === 'EC' && k.crv === 'P-256' };

const part = <T>(s: string, what: string): T => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString()) as T;
  } catch {
    throw new SignInFailed(`the ID token's ${what} is not JSON`);
  }
};

export class Keys {
  private keys: Jwk[] = [];
  private fetched = 0;
  private readonly f: typeof fetch;
  private readonly uri: string;
  constructor(uri: string, f: typeof fetch = fetch) {
    this.uri = uri;
    this.f = f;
  }
  async get(kid: string | undefined, now = Date.now()): Promise<Jwk | undefined> {
    const find = () => this.keys.find((k) => (kid ? k.kid === kid : true));
    // Refresh when the key is unknown (the provider rotated), but no more than once a minute.
    if (!find() && now - this.fetched > 60_000) {
      const r = await this.f(this.uri);
      if (!r.ok) throw new SignInFailed(`the provider's keys could not be fetched (${r.status})`);
      this.keys = ((await r.json()) as { keys: Jwk[] }).keys;
      this.fetched = now;
    }
    return find();
  }
}

/**
 * Verifies an ID token: signature by a published key of the type its algorithm needs, then issuer, audience (and
 * the authorised party, when one is named or there are several audiences), expiry, issue time and nonce; a token
 * without an expiry or issue time is refused.
 */
export async function verifyIdToken(token: string, p: Provider, keys: Keys, o: { nonce: string; now?: number; skewSec?: number }): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new SignInFailed('the ID token is not a JWT');
  const [h, b, s] = parts as [string, string, string];
  const header = part<{ alg: string; kid?: string }>(h, 'header');
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new SignInFailed(`the ID token is signed with ${header.alg}, which is not accepted`);
  const jwk = await keys.get(header.kid, o.now);
  if (!jwk) throw new SignInFailed('the ID token is signed with a key the provider does not publish');
  if (!FITS[header.alg]!(jwk) || (jwk.alg && jwk.alg !== header.alg) || (jwk.use && jwk.use !== 'sig')) throw new SignInFailed(`the provider's key ${jwk.kid ?? ''} is not one for ${header.alg} signatures`);
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verifySig('sha256', Buffer.from(`${h}.${b}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(s, 'base64url'));
  if (!ok) throw new SignInFailed('the ID token signature does not verify');
  const c = part<Claims>(b, 'body');
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const skew = o.skewSec ?? 60;
  if (c.iss !== p.issuer) throw new SignInFailed('the ID token is from another issuer');
  const aud = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) ? c.aud : [];
  if (!aud.includes(p.clientId)) throw new SignInFailed('the ID token is for another application');
  if ((aud.length > 1 || c['azp'] !== undefined) && c['azp'] !== p.clientId) throw new SignInFailed('the ID token names another authorised party');
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) throw new SignInFailed('the ID token carries no expiry');
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) throw new SignInFailed('the ID token carries no issue time');
  if (c.exp + skew < now) throw new SignInFailed('the ID token has expired');
  if (c.iat - skew > now) throw new SignInFailed('the ID token was issued in the future');
  if (c.nonce !== o.nonce) throw new SignInFailed('the ID token does not answer this sign-in');
  return c;
}

/** Whether the state sent back is the one started, compared in constant time (as digests, so lengths may differ). */
export function sameState(got: string | null, want: string): boolean {
  if (got === null) return false;
  const d = (x: string) => createHash('sha256').update(x).digest();
  return timingSafeEqual(d(got), d(want));
}

/** The callback: the state must match the one started, then the code is exchanged and the ID token verified. */
export async function callback(p: Provider, keys: Keys, started: Started, query: URLSearchParams, o: { fetch?: typeof fetch; now?: number; maxAgeMs?: number } = {}): Promise<Claims> {
  const now = o.now ?? Date.now();
  if (query.get('error')) throw new SignInFailed(`the provider refused: ${query.get('error_description') ?? query.get('error')}`);
  if (!sameState(query.get('state'), started.state)) throw new SignInFailed('this sign-in was not started here');
  if (now - started.at > (o.maxAgeMs ?? 10 * 60_000)) throw new SignInFailed('the sign-in took too long; start again');
  const code = query.get('code');
  if (!code) throw new SignInFailed('the provider sent no code');
  const f = o.fetch ?? fetch;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: started.verifier, ...(p.clientSecret ? { client_secret: p.clientSecret } : {}) });
  const r = await f(p.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!r.ok) throw new SignInFailed(`the provider refused the code (${r.status})`);
  const t = (await r.json()) as { id_token?: string };
  if (!t.id_token) throw new SignInFailed('the provider sent no ID token');
  return verifyIdToken(t.id_token, p, keys, { nonce: started.nonce, now });
}
