import { createHash, createHmac, createPublicKey, createVerify, timingSafeEqual } from 'node:crypto';
import type { Egress } from '@zthr/egress';

/**
 * Sign in with Google (standard OpenID Connect ID tokens, PRD Phase 3).
 *
 * The browser gets an ID token from Google's sign-in button and posts it here. The server checks it completely
 * before trusting a word of it: an RS256 signature by one of Google's current keys (fetched through the egress
 * block from Google only), the issuer, the audience (this app's client id), expiry and issue time, and a verified
 * email. Then it issues its own short session, signed with a server secret. The Google subject is stored only as a
 * keyed hash, so the Advocate never keeps a Google identifier in the clear.
 */
export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

export type Verified = { ok: true; claims: GoogleClaims } | { ok: false; reason: string };

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

export class GoogleVerifier {
  private keys: { at: number; byKid: Map<string, Jwk> } | undefined;

  constructor(
    private readonly egress: Egress,
    private readonly clientId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly cacheMs = 60 * 60 * 1000,
  ) {
    if (!clientId) throw new Error('a Google client id is required');
  }

  private async jwks(force = false): Promise<Map<string, Jwk>> {
    if (!force && this.keys && this.now() - this.keys.at < this.cacheMs) return this.keys.byKid;
    const r = await this.egress.send({ purpose: 'signin:google-keys', method: 'GET', url: JWKS_URL });
    if (r.status !== 200) throw new Error(`Google keys unavailable (${r.status})`);
    const keys = (JSON.parse(r.body) as { keys?: Jwk[] }).keys ?? [];
    this.keys = { at: this.now(), byKid: new Map(keys.filter((k) => k.kty === 'RSA').map((k) => [k.kid, k])) };
    return this.keys.byKid;
  }

  async verify(token: string): Promise<Verified> {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
    let header: { alg?: string; kid?: string };
    let claims: GoogleClaims;
    try {
      header = JSON.parse(b64url(parts[0]!).toString('utf8')) as typeof header;
      claims = JSON.parse(b64url(parts[1]!).toString('utf8')) as GoogleClaims;
    } catch {
      return { ok: false, reason: 'unreadable token' };
    }
    if (header.alg !== 'RS256') return { ok: false, reason: `algorithm ${String(header.alg)} is not allowed` };
    if (!header.kid) return { ok: false, reason: 'no key id' };
    let key: Jwk | undefined;
    try {
      key = (await this.jwks()).get(header.kid) ?? (await this.jwks(true)).get(header.kid);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    if (!key) return { ok: false, reason: 'signed by an unknown key' };
    const v = createVerify('RSA-SHA256');
    v.update(`${parts[0]}.${parts[1]}`);
    const pub = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
    if (!v.verify(pub, b64url(parts[2]!))) return { ok: false, reason: 'bad signature' };
    const nowS = Math.floor(this.now() / 1000);
    if (!ISSUERS.includes(claims.iss)) return { ok: false, reason: 'wrong issuer' };
    if (claims.aud !== this.clientId) return { ok: false, reason: 'token is for another app' };
    if (typeof claims.exp !== 'number' || claims.exp < nowS - 30) return { ok: false, reason: 'expired' };
    if (typeof claims.iat !== 'number' || claims.iat > nowS + 300) return { ok: false, reason: 'issued in the future' };
    if (claims.email_verified !== true) return { ok: false, reason: 'email not verified' };
    if (!claims.sub) return { ok: false, reason: 'no subject' };
    return { ok: true, claims };
  }
}

/** A session the server signs itself: who, until when. Nothing else rides in the cookie. */
export class Sessions {
  constructor(private readonly secret: Buffer, private readonly now: () => number = () => Date.now(), private readonly ttlMs = 12 * 60 * 60 * 1000) {
    if (secret.length < 32) throw new Error('session secret must be at least 32 bytes');
  }

  /** The stored form of a Google subject: a keyed hash, never the identifier itself. */
  subjectKey(sub: string): string {
    return createHmac('sha256', this.secret).update(`google:${sub}`).digest('hex').slice(0, 32);
  }

  issue(subjectKey: string, email: string): string {
    const body = Buffer.from(JSON.stringify({ k: subjectKey, e: createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16), x: this.now() + this.ttlMs })).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  read(cookie: string | undefined): { subjectKey: string; emailHash: string } | undefined {
    if (!cookie) return undefined;
    const [body, sig] = cookie.split('.');
    if (!body || !sig) return undefined;
    const want = createHmac('sha256', this.secret).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k: string; e: string; x: number };
    if (p.x < this.now()) return undefined;
    return { subjectKey: p.k, emailHash: p.e };
  }

  emailHash(email: string): string {
    return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  }
}
