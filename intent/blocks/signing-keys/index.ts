/**
 * Signing keys through their whole life: generated, published ahead of use, made active, retired but still
 * published so old signatures verify, expired, or revoked. Keys have usage limits (a lifetime, a signature count,
 * the purposes they may sign for). Public keys are published as a JWKS (RFC 7517) with RFC 7638 thumbprints as key
 * ids, so no DID or other directory is needed. Signing and verifying use compact JWS (RFC 7515) with ES256, RS256
 * (2048 bits or more) and EdDSA (RFC 8037). A token's algorithm must match the one published for its key, so
 * "alg: none" and algorithm confusion are refused. A revocation list says which keys are withdrawn and why:
 * a compromised key voids everything it signed; any other reason keeps tokens issued before the revocation.
 * Private keys stay in memory objects handed out by an injectable generator; they are never part of any output.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type Alg = 'ES256' | 'RS256' | 'EdDSA';
export type RevocationReason = 'keyCompromise' | 'superseded' | 'cessationOfOperation' | 'privilegeWithdrawn' | 'unspecified';

export class KeyUnusable extends Error {
  constructor(why: string) {
    super(`key cannot be used: ${why}`);
  }
}
export class BadSignature extends Error {
  constructor(why: string) {
    super(`signature refused: ${why}`);
  }
}

export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
}
export interface Jwks {
  readonly keys: readonly Jwk[];
}

export interface KeyPolicy {
  readonly alg: Alg;
  /** How long a key may sign, from the moment it becomes active. */
  readonly signForMs: number;
  /** How long after it stops signing its public key stays published. */
  readonly verifyGraceMs: number;
  /** How long before it starts signing a new key is published, so caches have it. */
  readonly publishLeadMs: number;
  readonly maxSignatures?: number;
  /** When set, a key signs only for these purposes. */
  readonly purposes?: readonly string[];
}

export type KeyState = 'pending' | 'active' | 'retired' | 'expired' | 'revoked';

export interface KeyInfo {
  readonly kid: string;
  readonly alg: Alg;
  readonly state: KeyState;
  readonly createdAt: number;
  readonly activeFrom: number;
  readonly signatures: number;
  readonly revokedAt?: number;
  readonly reason?: RevocationReason;
}

export interface Generated {
  readonly privateKey: KeyObject;
  readonly publicJwk: Jwk;
}

export function generateKey(alg: Alg): Generated {
  const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicJwk: pair.publicKey.export({ format: 'jwk' }) as Jwk };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RFC 7638: the SHA-256 of the required members in lexicographic order, base64url. */
export function thumbprint(jwk: Jwk): string {
  let members: Record<string, string | undefined>;
  if (jwk.kty === 'RSA') members = { e: jwk.e, kty: 'RSA', n: jwk.n };
  else if (jwk.kty === 'EC') members = { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y };
  else if (jwk.kty === 'OKP') members = { crv: jwk.crv, kty: 'OKP', x: jwk.x };
  else throw new BadSignature(`key type ${jwk.kty} is not supported`);
  for (const [k, v] of Object.entries(members)) if (typeof v !== 'string') throw new BadSignature(`key is missing ${k}`);
  return createHash('sha256').update(JSON.stringify(members)).digest('base64url');
}

interface Rec {
  readonly kid: string;
  readonly alg: Alg;
  readonly privateKey: KeyObject;
  readonly jwk: Jwk;
  readonly createdAt: number;
  readonly activeFrom: number;
  signatures: number;
  revokedAt?: number;
  reason?: RevocationReason;
}

export interface RevocationEntry {
  readonly kid: string;
  readonly revokedAt: number;
  readonly reason: RevocationReason;
}
export interface RevocationList {
  readonly issuedAt: number;
  /** Counts up with each change, so a consumer can tell it has the newest list. */
  readonly version: number;
  readonly entries: readonly RevocationEntry[];
}

export interface RegistryOptions {
  readonly policy: KeyPolicy;
  readonly now: () => number;
  /** Replaceable so tests (or an HSM adapter) supply keys. */
  readonly generate?: (alg: Alg) => Generated;
}

export class KeyRegistry {
  private readonly recs: Rec[] = [];
  private listVersion = 0;
  private readonly o: RegistryOptions;
  constructor(o: RegistryOptions) {
    this.o = o;
  }

  /** Makes a new key. The first is active at once; later ones are published now and become active after the lead. */
  rotate(): string {
    const now = this.o.now();
    const g = (this.o.generate ?? generateKey)(this.o.policy.alg);
    const kid = thumbprint(g.publicJwk);
    if (this.recs.some((r) => r.kid === kid)) throw new KeyUnusable('that key already exists');
    const activeFrom = this.recs.length === 0 ? now : now + this.o.policy.publishLeadMs;
    this.recs.push({ kid, alg: this.o.policy.alg, privateKey: g.privateKey, jwk: { ...g.publicJwk, kid, use: 'sig', alg: this.o.policy.alg }, createdAt: now, activeFrom, signatures: 0 });
    return kid;
  }

  private stateOf(r: Rec, now: number): KeyState {
    if (r.revokedAt !== undefined && r.revokedAt <= now) return 'revoked';
    if (now < r.activeFrom) return 'pending';
    const p = this.o.policy;
    const over = r.signatures >= (p.maxSignatures ?? Infinity);
    const end = r.activeFrom + p.signForMs;
    if (now >= end + p.verifyGraceMs) return 'expired';
    if (now >= end || over) return 'retired';
    // A newer key that has taken over also retires this one.
    const newer = this.recs.some((o) => o !== r && o.activeFrom > r.activeFrom && o.activeFrom <= now && !(o.revokedAt !== undefined && o.revokedAt <= now));
    return newer ? 'retired' : 'active';
  }

  list(): KeyInfo[] {
    const now = this.o.now();
    return this.recs.map((r) => ({ kid: r.kid, alg: r.alg, state: this.stateOf(r, now), createdAt: r.createdAt, activeFrom: r.activeFrom, signatures: r.signatures, ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt, reason: r.reason! } : {}) }));
  }

  /** The key that signs now, or an explanation of why none can. */
  private signer(purpose?: string): Rec {
    const now = this.o.now();
    const active = this.recs.filter((r) => this.stateOf(r, now) === 'active');
    const r = active.sort((a, b) => b.activeFrom - a.activeFrom)[0];
    if (!r) throw new KeyUnusable('there is no active key; rotate to make one');
    const p = this.o.policy;
    if (p.purposes && (purpose === undefined || !p.purposes.includes(purpose))) throw new KeyUnusable(`it may not sign for ${purpose ?? 'an unnamed purpose'}`);
    return r;
  }

  /** Signs a payload as a compact JWS. Counts the signature against the key's limit. */
  sign(payload: Record<string, unknown>, purpose?: string): string {
    const r = this.signer(purpose);
    const iat = Math.floor(this.o.now() / 1000);
    const head = b64u(JSON.stringify({ alg: r.alg, kid: r.kid, typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iat, ...payload }));
    const input = Buffer.from(`${head}.${body}`);
    const sig = r.alg === 'ES256' ? nodeSign('sha256', input, { key: r.privateKey, dsaEncoding: 'ieee-p1363' }) : r.alg === 'RS256' ? nodeSign('sha256', input, r.privateKey) : nodeSign(null, input, r.privateKey);
    r.signatures += 1;
    return `${head}.${body}.${b64u(sig)}`;
  }

  /** Public keys that verifiers should hold: pending, active and retired. Never revoked or expired, never private. */
  jwks(): Jwks {
    const now = this.o.now();
    return { keys: this.recs.filter((r) => ['pending', 'active', 'retired'].includes(this.stateOf(r, now))).map((r) => ({ ...r.jwk })) };
  }

  revoke(kid: string, reason: RevocationReason): void {
    const r = this.recs.find((x) => x.kid === kid);
    if (!r) throw new KeyUnusable(`no key ${kid}`);
    if (r.revokedAt !== undefined) return;
    r.revokedAt = this.o.now();
    r.reason = reason;
    this.listVersion += 1;
  }

  revocationList(): RevocationList {
    return { issuedAt: this.o.now(), version: this.listVersion, entries: this.recs.filter((r) => r.revokedAt !== undefined).map((r) => ({ kid: r.kid, revokedAt: r.revokedAt!, reason: r.reason! })) };
  }
}

export interface VerifyOptions {
  readonly jwks: Jwks;
  readonly now: number;
  readonly revoked?: RevocationList;
  /** Algorithms the verifier accepts; default all three. */
  readonly algs?: readonly Alg[];
  /** Seconds of clock difference to allow on iat. */
  readonly skewSeconds?: number;
}

const decode = (s: string): Buffer => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new BadSignature('not base64url');
  return Buffer.from(s, 'base64url');
};

/** Verifies a compact JWS against published keys and the revocation list; returns the payload. */
export function verifyJws(token: string, o: VerifyOptions): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new BadSignature('it is not a compact signature');
  let head: { alg?: unknown; kid?: unknown };
  let payload: Record<string, unknown>;
  try {
    head = JSON.parse(decode(parts[0]).toString('utf8'));
    payload = JSON.parse(decode(parts[1]).toString('utf8'));
  } catch (e) {
    if (e instanceof BadSignature) throw e;
    throw new BadSignature('its header or payload is not JSON');
  }
  if (typeof head.alg !== 'string' || typeof head.kid !== 'string') throw new BadSignature('it names no algorithm or key');
  const algs = o.algs ?? (['ES256', 'RS256', 'EdDSA'] as const);
  if (!(algs as readonly string[]).includes(head.alg)) throw new BadSignature(`algorithm ${head.alg} is not accepted`);
  const jwk = o.jwks.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw new BadSignature(`key ${head.kid} is not published`);
  if (jwk.alg !== head.alg) throw new BadSignature('the token names a different algorithm than its key');
  const entry = o.revoked?.entries.find((e) => e.kid === head.kid);
  const iat = typeof payload.iat === 'number' ? payload.iat : undefined;
  if (entry) {
    if (entry.reason === 'keyCompromise') throw new BadSignature('its key was revoked as compromised');
    if (iat === undefined || iat * 1000 >= entry.revokedAt) throw new BadSignature('its key was revoked before it was issued');
  }
  if (iat !== undefined && iat * 1000 > o.now + (o.skewSeconds ?? 60) * 1000) throw new BadSignature('it was issued in the future');
  if (jwk.kty === 'RSA' && decode(jwk.n ?? '').length < 256) throw new BadSignature('the RSA key is under 2048 bits');
  const input = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = decode(parts[2]);
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    if (head.alg === 'ES256') {
      if (sig.length !== 64) throw new BadSignature('wrong signature length');
      ok = nodeVerify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } else if (head.alg === 'RS256') ok = nodeVerify('sha256', input, key, sig);
    else ok = nodeVerify(null, input, key, sig);
  } catch (e) {
    if (e instanceof BadSignature) throw e;
    throw new BadSignature('the key could not be used');
  }
  if (!ok) throw new BadSignature('it does not match its key');
  return payload;
}
