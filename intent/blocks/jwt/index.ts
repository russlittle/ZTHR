/**
 * JSON Web Tokens done defensively. JWS compact serialization (RFC 7515) and JWT claims (RFC 7519) with HS256/384/512
 * (RFC 7518 section 3.2: keys at least as long as the hash), RS256/384/512 and PS256/384/512 (RSA keys of 2048 bits
 * or more), ES256/384/512 (the matching curve only, signatures in the fixed-length r||s form), and EdDSA with
 * Ed25519 (RFC 8037). JWKs (RFC 7517) are read and written, with thumbprints (RFC 7638) as default key ids.
 *
 * The rules that stop the classic attacks are not options: the caller must give the algorithms it accepts; "none"
 * is never accepted; a key is only used for the algorithm family its type allows, so a public RSA key can never
 * serve as an HMAC secret (algorithm confusion); the header's jwk, jku, x5u and x5c are ignored, never fetched or
 * trusted; "crit" naming anything not understood is refused; tokens over 16 KiB, with other than three parts, with
 * non-canonical base64url, or whose header or payload is not a JSON object are malformed. HMAC and every
 * comparison are constant time. Claims are checked strictly: exp, nbf and iat against an injected clock with a
 * small tolerance, iss and aud against what the caller expects, sub and jti when required, a maximum lifetime, the
 * typ header (RFC 9068 "at+jwt" and others), and an optional replay check for jti.
 *
 * KeySet holds keys by id with states (active signs and verifies; retiring only verifies; revoked does neither),
 * rotates them (a new key signs at once, the old one verifies until its grace period ends), picks the signing key,
 * resolves the verifying key from the token's kid, and publishes only public keys as a JWKS (RFC 7517 section 5).
 * Not here: JWE (encrypted tokens), JSON serialization, "b64": false, fetching a remote JWKS (OIDC does that),
 * and PEM handling beyond what node:crypto's KeyObject gives.
 */
import { constants, createHash, createHmac, createPrivateKey, createPublicKey, createSecretKey, generateKeyPairSync, randomBytes, sign as nodeSign, timingSafeEqual, verify as nodeVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

export class InvalidToken extends Error {}
export class InvalidSignature extends Error {
  constructor() {
    super('the signature does not match');
  }
}
export class ClaimError extends Error {
  readonly claim: string;
  constructor(claim: string, message: string) {
    super(message);
    this.claim = claim;
  }
}
export class KeyError extends Error {}

export type Alg = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512' | 'EdDSA';

interface AlgInfo {
  readonly kind: 'hmac' | 'rsa' | 'pss' | 'ec' | 'ed';
  readonly hash?: 'sha256' | 'sha384' | 'sha512';
  readonly curve?: string;
  readonly sigLen?: number;
}

const ALGS: Readonly<Record<Alg, AlgInfo>> = {
  HS256: { kind: 'hmac', hash: 'sha256' }, HS384: { kind: 'hmac', hash: 'sha384' }, HS512: { kind: 'hmac', hash: 'sha512' },
  RS256: { kind: 'rsa', hash: 'sha256' }, RS384: { kind: 'rsa', hash: 'sha384' }, RS512: { kind: 'rsa', hash: 'sha512' },
  PS256: { kind: 'pss', hash: 'sha256' }, PS384: { kind: 'pss', hash: 'sha384' }, PS512: { kind: 'pss', hash: 'sha512' },
  ES256: { kind: 'ec', hash: 'sha256', curve: 'prime256v1', sigLen: 64 }, ES384: { kind: 'ec', hash: 'sha384', curve: 'secp384r1', sigLen: 96 }, ES512: { kind: 'ec', hash: 'sha512', curve: 'secp521r1', sigLen: 132 },
  EdDSA: { kind: 'ed' },
};

const isAlg = (a: unknown): a is Alg => typeof a === 'string' && Object.hasOwn(ALGS, a);
const HASH_BYTES = { sha256: 32, sha384: 48, sha512: 64 } as const;

// ---------------------------------------------------------------- base64url

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Strict base64url: only the URL-safe alphabet, no padding, no whitespace, and it must re-encode to itself. */
export function unb64u(s: string, what = 'segment'): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new InvalidToken(`the ${what} is not base64url`);
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s) throw new InvalidToken(`the ${what} is not canonical base64url`);
  return b;
}

// ---------------------------------------------------------------- keys

export type KeyInput = KeyObject | JsonWebKey | Buffer | string;

/** A key as a KeyObject: a JWK (private or public), an existing KeyObject, or secret bytes for HMAC. */
export function toKey(k: KeyInput, kind: 'private' | 'public' | 'secret'): KeyObject {
  if (typeof k === 'string' || Buffer.isBuffer(k)) {
    if (kind !== 'secret') throw new KeyError('a string or buffer is only an HMAC secret');
    return createSecretKey(Buffer.from(k));
  }
  if ('type' in k && typeof (k as KeyObject).type === 'string' && typeof (k as KeyObject).export === 'function') return k as KeyObject;
  const jwk = k as JsonWebKey;
  if (jwk.kty === 'oct') {
    if (typeof jwk.k !== 'string') throw new KeyError('an oct key needs k');
    return createSecretKey(unb64u(jwk.k, 'key'));
  }
  try {
    return kind === 'private' ? createPrivateKey({ key: jwk, format: 'jwk' }) : createPublicKey({ key: jwk, format: 'jwk' });
  } catch (e) {
    throw new KeyError(`that is not a usable key: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Throws unless a key may be used with the algorithm: the right family, the right curve, a long enough secret or modulus. */
export function checkKey(alg: Alg, key: KeyObject, use: 'sign' | 'verify'): void {
  const a = ALGS[alg];
  const t = key.type;
  if (a.kind === 'hmac') {
    if (t !== 'secret') throw new KeyError(`${alg} needs a secret key, not a ${t} key (an asymmetric key may not be used as an HMAC secret)`);
    if (key.symmetricKeySize! < HASH_BYTES[a.hash!]) throw new KeyError(`${alg} needs a secret of at least ${HASH_BYTES[a.hash!]} bytes`);
    return;
  }
  if (t === 'secret') throw new KeyError(`${alg} needs an asymmetric key`);
  if (use === 'sign' && t !== 'private') throw new KeyError(`signing with ${alg} needs a private key`);
  const type = key.asymmetricKeyType;
  if (a.kind === 'rsa' || a.kind === 'pss') {
    if (type !== 'rsa' && !(a.kind === 'pss' && type === 'rsa-pss')) throw new KeyError(`${alg} needs an RSA key, not ${type}`);
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new KeyError('RSA keys must be at least 2048 bits');
  } else if (a.kind === 'ec') {
    if (type !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== a.curve) throw new KeyError(`${alg} needs a ${a.curve} EC key`);
  } else if (type !== 'ed25519') throw new KeyError('EdDSA here means Ed25519');
}

/** The RFC 7638 thumbprint of a public JWK: base64url SHA-256 of its required members in order. */
export function thumbprint(jwk: JsonWebKey): string {
  let members: Record<string, unknown>;
  switch (jwk.kty) {
    case 'RSA': members = { e: jwk.e, kty: 'RSA', n: jwk.n }; break;
    case 'EC': members = { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y }; break;
    case 'OKP': members = { crv: jwk.crv, kty: 'OKP', x: jwk.x }; break;
    case 'oct': members = { k: jwk.k, kty: 'oct' }; break;
    default: throw new KeyError(`cannot take the thumbprint of a ${String(jwk.kty)} key`);
  }
  for (const v of Object.values(members)) if (typeof v !== 'string') throw new KeyError('the key is missing a required member');
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

// ---------------------------------------------------------------- JWS

export interface Header {
  readonly alg: string;
  readonly typ?: string;
  readonly kid?: string;
  readonly crit?: readonly string[];
  readonly [k: string]: unknown;
}

const MAX_TOKEN = 16 * 1024;

function signBytes(alg: Alg, input: Buffer, key: KeyObject): Buffer {
  checkKey(alg, key, 'sign');
  const a = ALGS[alg];
  switch (a.kind) {
    case 'hmac': return createHmac(a.hash!, key).update(input).digest();
    case 'rsa': return nodeSign(a.hash!, input, key);
    case 'pss': return nodeSign(a.hash!, input, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: HASH_BYTES[a.hash!] });
    case 'ec': return nodeSign(a.hash!, input, { key, dsaEncoding: 'ieee-p1363' });
    case 'ed': return nodeSign(null, input, key);
  }
}

function verifyBytes(alg: Alg, input: Buffer, sig: Buffer, key: KeyObject): boolean {
  checkKey(alg, key, 'verify');
  const a = ALGS[alg];
  switch (a.kind) {
    case 'hmac': {
      const want = createHmac(a.hash!, key).update(input).digest();
      return want.length === sig.length && timingSafeEqual(want, sig);
    }
    case 'rsa': return nodeVerify(a.hash!, input, key, sig);
    case 'pss': return nodeVerify(a.hash!, input, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: HASH_BYTES[a.hash!] }, sig);
    case 'ec': return sig.length === a.sigLen && nodeVerify(a.hash!, input, { key, dsaEncoding: 'ieee-p1363' }, sig);
    case 'ed': return sig.length === 64 && nodeVerify(null, input, key, sig);
  }
}

/** Signs a payload (any bytes) as a JWS compact token. The header is written with alg first, then typ, then kid. */
export function signJws(payload: Buffer | string, alg: Alg, key: KeyObject, h: { typ?: string; kid?: string } = {}): string {
  if (!isAlg(alg)) throw new KeyError(`${String(alg)} is not a supported algorithm`);
  const header = JSON.stringify({ alg, ...(h.typ ? { typ: h.typ } : {}), ...(h.kid ? { kid: h.kid } : {}) });
  const input = `${b64u(header)}.${b64u(payload)}`;
  return `${input}.${b64u(signBytes(alg, Buffer.from(input), key))}`;
}

export interface Parsed {
  readonly header: Header;
  readonly payload: Buffer;
  readonly input: Buffer;
  readonly signature: Buffer;
}

/** Splits and decodes a compact token without trusting it: shape, base64url, header JSON. Nothing is verified here. */
export function parse(token: string): Parsed {
  if (typeof token !== 'string') throw new InvalidToken('a token is a string');
  if (token.length > MAX_TOKEN) throw new InvalidToken(`the token is longer than ${MAX_TOKEN} characters`);
  const parts = token.split('.');
  if (parts.length === 5) throw new InvalidToken('this is an encrypted token (JWE), which is not supported');
  if (parts.length !== 3) throw new InvalidToken('a token has three parts separated by dots');
  const [h, p, s] = parts as [string, string, string];
  if (!h) throw new InvalidToken('the header is empty');
  let header: unknown;
  try {
    header = JSON.parse(unb64u(h, 'header').toString('utf8'));
  } catch (e) {
    if (e instanceof InvalidToken) throw e;
    throw new InvalidToken('the header is not JSON');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new InvalidToken('the header is not a JSON object');
  const hd = header as Header;
  if (typeof hd.alg !== 'string') throw new InvalidToken('the header has no alg');
  return { header: hd, payload: unb64u(p, 'payload'), input: Buffer.from(`${h}.${p}`), signature: unb64u(s, 'signature') };
}

/** Header fields that change how a token must be read; one this code does not know means refuse. */
const UNDERSTOOD_CRIT: readonly string[] = [];

export interface VerifyJwsOptions {
  /** The algorithms the caller accepts. Required; "none" is never accepted. */
  readonly algorithms: readonly Alg[];
}

/** Verifies a compact JWS against a function that finds the key for the header; returns the header and payload bytes. */
export function verifyJws(token: string, find: (h: Header) => KeyObject | readonly KeyObject[] | undefined, o: VerifyJwsOptions): { header: Header; payload: Buffer } {
  if (!o.algorithms?.length) throw new KeyError('say which algorithms are accepted');
  const t = parse(token);
  const alg = t.header.alg;
  if (alg.toLowerCase() === 'none') throw new InvalidToken('unsigned tokens (alg none) are never accepted');
  if (!isAlg(alg)) throw new InvalidToken(`the algorithm ${JSON.stringify(alg.slice(0, 20))} is not supported`);
  if (!o.algorithms.includes(alg)) throw new InvalidToken(`the algorithm ${alg} is not accepted here`);
  if (t.header.crit !== undefined) {
    const crit = t.header.crit;
    if (!Array.isArray(crit) || crit.length === 0 || crit.some((c) => typeof c !== 'string' || !UNDERSTOOD_CRIT.includes(c))) throw new InvalidToken('the token requires a header extension that is not understood (crit)');
  }
  const found = find(t.header);
  const keys = found === undefined ? [] : Array.isArray(found) ? found : [found as KeyObject];
  if (!keys.length) throw new KeyError('no key is known for this token');
  let ok = false;
  for (const k of keys as KeyObject[]) {
    try {
      if (verifyBytes(alg, t.input, t.signature, k)) ok = true;
    } catch (e) {
      // A key of the wrong kind for this algorithm is a configuration error, never a pass.
      if (keys.length === 1) throw e;
    }
  }
  if (!ok) throw new InvalidSignature();
  return { header: t.header, payload: t.payload };
}

// ---------------------------------------------------------------- JWT claims

export type Claims = Record<string, unknown>;

export interface ClaimRules {
  /** Seconds since the epoch, or a Date: the clock. */
  readonly now: () => number;
  /** Leeway for exp, nbf and iat. Default 60 seconds. */
  readonly toleranceSec?: number;
  readonly issuer?: string | readonly string[];
  /** The token's aud must include one of these. */
  readonly audience?: string | readonly string[];
  readonly subject?: string;
  readonly requireExp?: boolean;
  readonly requireSub?: boolean;
  readonly requireJti?: boolean;
  /** The longest allowed exp - iat, in seconds; needs iat. */
  readonly maxLifetimeSec?: number;
  /** The typ header the token must carry, compared ignoring case and an "application/" prefix. */
  readonly typ?: string;
  /** Spends a jti; returns false when it was already used (replay). */
  readonly once?: (jti: string, expSec: number | undefined) => boolean;
}

const one = (v: string | readonly string[] | undefined): readonly string[] => (v === undefined ? [] : typeof v === 'string' ? [v] : v);
const normTyp = (t: string) => t.toLowerCase().replace(/^application\//, '');
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks claims against the rules; throws ClaimError naming the claim. */
export function checkClaims(c: Claims, header: Header, r: ClaimRules): void {
  const now = r.now();
  const tol = r.toleranceSec ?? 60;
  if (r.typ !== undefined && (typeof header.typ !== 'string' || normTyp(header.typ) !== normTyp(r.typ))) throw new ClaimError('typ', `the token's type must be ${r.typ}`);
  if (c.exp !== undefined && !isNum(c.exp)) throw new ClaimError('exp', 'exp must be a number');
  if (c.nbf !== undefined && !isNum(c.nbf)) throw new ClaimError('nbf', 'nbf must be a number');
  if (c.iat !== undefined && !isNum(c.iat)) throw new ClaimError('iat', 'iat must be a number');
  if (r.requireExp !== false && c.exp === undefined) throw new ClaimError('exp', 'the token has no expiry');
  if (isNum(c.exp) && now >= c.exp + tol) throw new ClaimError('exp', 'the token has expired');
  if (isNum(c.nbf) && now + tol < c.nbf) throw new ClaimError('nbf', 'the token is not valid yet');
  if (isNum(c.iat) && now + tol < c.iat) throw new ClaimError('iat', 'the token was issued in the future');
  if (r.maxLifetimeSec !== undefined) {
    if (!isNum(c.iat) || !isNum(c.exp)) throw new ClaimError('iat', 'a maximum lifetime needs both iat and exp');
    if (c.exp - c.iat > r.maxLifetimeSec) throw new ClaimError('exp', `the token lives longer than ${r.maxLifetimeSec} seconds`);
  }
  if (r.issuer !== undefined && (typeof c.iss !== 'string' || !one(r.issuer).includes(c.iss))) throw new ClaimError('iss', 'the issuer is not trusted');
  if (r.audience !== undefined) {
    const aud = typeof c.aud === 'string' ? [c.aud] : Array.isArray(c.aud) && c.aud.every((x) => typeof x === 'string') ? (c.aud as string[]) : [];
    if (!aud.some((a) => one(r.audience).includes(a))) throw new ClaimError('aud', 'the token is not for this audience');
  }
  if (r.subject !== undefined && c.sub !== r.subject) throw new ClaimError('sub', 'the subject is not the expected one');
  if (r.requireSub && (typeof c.sub !== 'string' || !c.sub)) throw new ClaimError('sub', 'the token has no subject');
  if ((r.requireJti || r.once) && (typeof c.jti !== 'string' || !c.jti)) throw new ClaimError('jti', 'the token has no id');
  if (r.once && !r.once(c.jti as string, isNum(c.exp) ? c.exp : undefined)) throw new ClaimError('jti', 'this token was already used');
}

// ---------------------------------------------------------------- key set with rotation

export type KeyState = 'active' | 'retiring' | 'revoked';

export interface StoredKey {
  readonly kid: string;
  readonly alg: Alg;
  readonly key: KeyObject;
  /** Public half for asymmetric keys (the key itself when it is already public). */
  readonly pub?: KeyObject;
  state: KeyState;
  readonly createdAt: number;
  /** For a retiring key: when it stops verifying. */
  retireAt?: number;
}

export class KeySet {
  private readonly keys = new Map<string, StoredKey>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  /** Adds a key. The id defaults to the JWK thumbprint (asymmetric) or a random id (secrets). */
  add(alg: Alg, input: KeyInput, o: { kid?: string; state?: KeyState; kind?: 'private' | 'public' | 'secret' } = {}): StoredKey {
    const a = ALGS[alg];
    const kind = o.kind ?? (a.kind === 'hmac' ? 'secret' : typeof input === 'object' && !Buffer.isBuffer(input) && (('d' in input && (input as JsonWebKey).d !== undefined) || ('type' in input && (input as KeyObject).type === 'private')) ? 'private' : 'public');
    const key = toKey(input, kind);
    checkKey(alg, key, kind === 'public' ? 'verify' : 'verify');
    const pub = key.type === 'private' ? createPublicKey(key) : key.type === 'public' ? key : undefined;
    const kid = o.kid ?? (pub ? thumbprint(pub.export({ format: 'jwk' })) : b64u(randomBytes(9)));
    if (this.keys.has(kid)) throw new KeyError(`a key with id ${kid} already exists`);
    const sk: StoredKey = { kid, alg, key, ...(pub ? { pub } : {}), state: o.state ?? 'active', createdAt: this.now() };
    this.keys.set(kid, sk);
    return sk;
  }

  /** Makes a new key pair (or secret) for an algorithm and adds it. */
  generate(alg: Alg, o: { kid?: string } = {}): StoredKey {
    const a = ALGS[alg];
    if (a.kind === 'hmac') return this.add(alg, randomBytes(HASH_BYTES[a.hash!]), o.kid ? { kid: o.kid } : {});
    const pair = a.kind === 'rsa' || a.kind === 'pss' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : a.kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: a.curve! }) : generateKeyPairSync('ed25519');
    return this.add(alg, pair.privateKey, { kind: 'private', ...(o.kid ? { kid: o.kid } : {}) });
  }

  /**
   * Starts using a new key: every active key for the algorithm keeps verifying for `graceMs` and no longer signs.
   * Returns the new key. Tokens signed with the old key stay valid until their grace ends.
   */
  rotate(alg: Alg, graceMs: number, o: { kid?: string } = {}): StoredKey {
    const t = this.now();
    for (const k of this.keys.values()) if (k.alg === alg && k.state === 'active') Object.assign(k, { state: 'retiring' as const, retireAt: t + graceMs });
    return this.generate(alg, o);
  }

  revoke(kid: string): void {
    const k = this.keys.get(kid);
    if (!k) throw new KeyError(`no key ${kid}`);
    k.state = 'revoked';
  }

  /** Drops retired keys past their grace and revoked keys, so the set does not grow forever. */
  sweep(): string[] {
    const t = this.now();
    const gone: string[] = [];
    for (const [kid, k] of this.keys) if (k.state === 'revoked' || (k.state === 'retiring' && (k.retireAt ?? 0) <= t)) {
      this.keys.delete(kid);
      gone.push(kid);
    }
    return gone;
  }

  private live(k: StoredKey): boolean {
    return k.state === 'active' || (k.state === 'retiring' && (k.retireAt ?? Infinity) > this.now());
  }

  /** The key to sign with: the newest active key for the algorithm that holds a private half. */
  signingKey(alg: Alg): StoredKey {
    const c = [...this.keys.values()].filter((k) => k.alg === alg && k.state === 'active' && (ALGS[alg].kind === 'hmac' || k.key.type === 'private')).sort((a, b) => b.createdAt - a.createdAt);
    if (!c[0]) throw new KeyError(`there is no active signing key for ${alg}`);
    return c[0];
  }

  /**
   * The key(s) to verify a token with. A kid picks exactly that key (when it is live and for the algorithm). With
   * no kid, only a single live key for the algorithm is used; more than one is ambiguous and refused.
   */
  forHeader(h: Header): KeyObject | undefined {
    const alg = h.alg as Alg;
    if (h.kid !== undefined) {
      if (typeof h.kid !== 'string') return undefined;
      const k = this.keys.get(h.kid);
      return k && k.alg === alg && this.live(k) ? (k.pub ?? k.key) : undefined;
    }
    const c = [...this.keys.values()].filter((k) => k.alg === alg && this.live(k));
    return c.length === 1 ? (c[0]!.pub ?? c[0]!.key) : undefined;
  }

  get(kid: string): StoredKey | undefined {
    return this.keys.get(kid);
  }

  /** The public keys as a JWKS: asymmetric keys only, never a secret or a private part. */
  publicJwks(): { keys: JsonWebKey[] } {
    const out: JsonWebKey[] = [];
    for (const k of [...this.keys.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!k.pub || !this.live(k)) continue;
      const jwk = k.pub.export({ format: 'jwk' });
      out.push({ ...jwk, kid: k.kid, alg: k.alg, use: 'sig' } as JsonWebKey);
    }
    return { keys: out };
  }

  /** Loads a JWKS from another party as verify-only keys. Entries that are not usable public keys are skipped and reported. */
  static fromJwks(jwks: unknown, now: () => number, algs?: readonly Alg[]): { set: KeySet; skipped: string[] } {
    const set = new KeySet(now);
    const skipped: string[] = [];
    const list = (jwks as { keys?: unknown })?.keys;
    if (!Array.isArray(list)) throw new KeyError('a JWKS has a "keys" array');
    for (const j of list as (JsonWebKey & { kid?: string; alg?: string; use?: string })[]) {
      try {
        if (j.kty === 'oct' || j.d !== undefined) throw new KeyError('secret and private keys do not belong in a JWKS');
        if (j.use !== undefined && j.use !== 'sig') throw new KeyError('not a signature key');
        const alg = (j.alg as Alg | undefined) ?? (j.kty === 'EC' ? ({ 'P-256': 'ES256', 'P-384': 'ES384', 'P-521': 'ES512' } as Record<string, Alg>)[j.crv ?? ''] : j.kty === 'OKP' ? 'EdDSA' : undefined);
        if (!alg || !isAlg(alg)) throw new KeyError('the algorithm is missing or unsupported');
        if (algs && !algs.includes(alg)) throw new KeyError(`${alg} is not accepted here`);
        set.add(alg, j, { kind: 'public', ...(j.kid ? { kid: j.kid } : {}) });
      } catch (e) {
        skipped.push(`${j?.kid ?? '(no kid)'}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { set, skipped };
  }
}

// ---------------------------------------------------------------- the JWT service

export interface JwtOptions {
  readonly keys: KeySet;
  /** The algorithms accepted when verifying, and the default for signing (the first). */
  readonly algorithms: readonly Alg[];
  readonly issuer?: string;
  readonly audience?: string | readonly string[];
  /** The clock, in milliseconds. */
  readonly now: () => number;
  readonly toleranceSec?: number;
  readonly typ?: string;
}

export class Jwt {
  private readonly o: JwtOptions;
  constructor(o: JwtOptions) {
    if (!o.algorithms.length) throw new KeyError('say which algorithms are accepted');
    this.o = o;
  }

  /** Issues a token: iss, iat and exp are set from the options and the clock; the caller's claims cannot override them. */
  issue(claims: Claims, o: { ttlSec: number; alg?: Alg; jti?: string; typ?: string } ): string {
    if (!(o.ttlSec > 0)) throw new ClaimError('exp', 'a token needs a positive lifetime');
    const alg = o.alg ?? this.o.algorithms[0]!;
    if (!this.o.algorithms.includes(alg)) throw new KeyError(`${alg} is not one of the algorithms in use`);
    const k = this.o.keys.signingKey(alg);
    const iat = Math.floor(this.o.now() / 1000);
    const body: Claims = { ...claims, ...(this.o.issuer ? { iss: this.o.issuer } : {}), iat, exp: iat + Math.floor(o.ttlSec), ...(o.jti ? { jti: o.jti } : {}) };
    return signJws(JSON.stringify(body), alg, k.key, { kid: k.kid, typ: o.typ ?? this.o.typ ?? 'JWT' });
  }

  /** Verifies the signature (with the key the token's kid names) and every claim; returns the claims. */
  verify(token: string, rules: Partial<Omit<ClaimRules, 'now'>> = {}): { header: Header; claims: Claims } {
    const { header, payload } = verifyJws(token, (h) => this.o.keys.forHeader(h), { algorithms: this.o.algorithms });
    let claims: unknown;
    try {
      claims = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new InvalidToken('the payload is not JSON');
    }
    if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw new InvalidToken('the payload is not a JSON object');
    checkClaims(claims as Claims, header, { now: () => this.o.now() / 1000, toleranceSec: this.o.toleranceSec ?? 60, ...(this.o.issuer ? { issuer: this.o.issuer } : {}), ...(this.o.audience ? { audience: this.o.audience } : {}), ...(this.o.typ ? { typ: this.o.typ } : {}), ...rules });
    return { header, claims: claims as Claims };
  }
}

/** The claims and header of a token WITHOUT checking anything: for logging and debugging only, never for decisions. */
export function unsafeDecode(token: string): { header: Header; claims: unknown } {
  const t = parse(token);
  let claims: unknown;
  try {
    claims = JSON.parse(t.payload.toString('utf8'));
  } catch {
    claims = undefined;
  }
  return { header: t.header, claims };
}
