/**
 * Passkeys: WebAuthn Level 2/3 registration and sign-in verified on the server, with no library. Reads what a browser
 * sends (clientDataJSON, the CBOR attestation object, authenticator data, COSE public keys) and checks what the
 * specification's verification procedures check: the ceremony type, the single-use challenge, the origin, the relying
 * party id hash, user presence and (when required) verification, the backup-eligibility rules, the algorithm offered,
 * and the signature. Attestation formats supported: "none", "packed" (self and x5c) and "fido-u2f"; an attestation
 * policy says which formats and authenticators (by AAGUID) are accepted and whether the certificate chain must reach a
 * root you trust. Sign-in counters are checked for the cloned-authenticator signal. Credentials can be listed (without
 * key material), renamed and removed, and the last one is not removed by accident.
 *
 * Algorithms: ES256 (-7), RS256 (-257) and EdDSA (-8). The CBOR reader is the deterministic subset CTAP2 uses
 * (RFC 8949: definite lengths, no floats, no tags, no duplicate map keys, bounded depth), tested with RFC 8949
 * appendix A. Out of scope: the TPM, Android and Apple attestation formats (refused as unsupported), metadata
 * service lookups, and extension processing beyond reading the flag. Clock, randomness and storage are arguments.
 */
import { X509Certificate, createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { equal } from '../crypto/index.ts';

// ---------------------------------------------------------------- CBOR (deterministic subset)

export class BadCbor extends Error {
  constructor(why: string) {
    super(`bad CBOR: ${why}`);
  }
}

export type Cbor = number | bigint | string | boolean | null | Buffer | Cbor[] | Map<number | string, Cbor>;

/** Reads one CBOR item and says how many bytes it took, so what follows (extensions) can be read next. */
export function decodeCbor(buf: Uint8Array, at = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 16) throw new BadCbor('nested too deeply');
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (at >= b.length) throw new BadCbor('ran out of bytes');
  const ib = b[at]!;
  const major = ib >> 5;
  const info = ib & 31;
  let pos = at + 1;
  let n: number | bigint;
  if (info < 24) n = info;
  else if (info === 24 || info === 25 || info === 26 || info === 27) {
    const w = 1 << (info - 24);
    if (pos + w > b.length) throw new BadCbor('ran out of bytes');
    n = w === 1 ? b[pos]! : w === 2 ? b.readUInt16BE(pos) : w === 4 ? b.readUInt32BE(pos) : b.readBigUInt64BE(pos);
    pos += w;
    // Deterministic encoding: the shortest form of every head.
    const small = Number(n);
    if ((info === 24 && small < 24) || (info === 25 && small < 256) || (info === 26 && small < 65536) || (info === 27 && typeof n === 'bigint' && n < 4294967296n)) throw new BadCbor('a number not in its shortest form');
    if (typeof n === 'bigint' && n <= BigInt(Number.MAX_SAFE_INTEGER)) n = Number(n);
  } else if (info === 31) throw new BadCbor('indefinite lengths are not accepted');
  else throw new BadCbor('reserved additional information');
  switch (major) {
    case 0:
      return { value: n, end: pos };
    case 1:
      return { value: typeof n === 'bigint' ? -1n - n : -1 - n, end: pos };
    case 2:
    case 3: {
      if (typeof n === 'bigint' || pos + n > b.length) throw new BadCbor('a string longer than the data');
      const raw = b.subarray(pos, pos + n);
      if (major === 2) return { value: Buffer.from(raw), end: pos + n };
      try {
        return { value: new TextDecoder('utf-8', { fatal: true }).decode(raw), end: pos + n };
      } catch {
        throw new BadCbor('text that is not UTF-8');
      }
    }
    case 4: {
      if (typeof n === 'bigint' || n > 1024) throw new BadCbor('an array that is too long');
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const r = decodeCbor(b, pos, depth + 1);
        out.push(r.value);
        pos = r.end;
      }
      return { value: out, end: pos };
    }
    case 5: {
      if (typeof n === 'bigint' || n > 1024) throw new BadCbor('a map that is too long');
      const m = new Map<number | string, Cbor>();
      for (let i = 0; i < n; i++) {
        const k = decodeCbor(b, pos, depth + 1);
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new BadCbor('map keys must be small integers or text');
        if (m.has(k.value)) throw new BadCbor('a map key twice');
        const v = decodeCbor(b, k.end, depth + 1);
        m.set(k.value, v.value);
        pos = v.end;
      }
      return { value: m, end: pos };
    }
    case 6:
      throw new BadCbor('tags are not accepted');
    default:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      throw new BadCbor('floats and other simple values are not accepted');
  }
}

/** The whole input must be one item. */
export function parseCbor(buf: Uint8Array): Cbor {
  const r = decodeCbor(buf);
  if (r.end !== buf.length) throw new BadCbor('bytes left over');
  return r.value;
}

const head = (major: number, n: number): Buffer => {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};

/** Writes the deterministic subset: integers, text, bytes, arrays and maps with keys in canonical order. */
export function encodeCbor(v: Cbor): Buffer {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new BadCbor('no floats');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const t = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, t.length), t]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4]);
  if (v === null) return Buffer.from([0xf6]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) {
    const items = [...v].map(([k, x]) => [encodeCbor(k), encodeCbor(x)] as const).sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
    return Buffer.concat([head(5, v.size), ...items.flat()]);
  }
  throw new BadCbor('cannot write that');
}

// ---------------------------------------------------------------- authenticator data and keys

export class Rejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

export interface AuthData {
  readonly rpIdHash: Buffer;
  readonly flags: number;
  readonly signCount: number;
  readonly attested?: { readonly aaguid: string; readonly credentialId: Buffer; readonly cosePublicKey: Buffer; readonly key: Map<number | string, Cbor> };
  readonly hasExtensions: boolean;
}

const uuid = (b: Buffer) => b.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

export function parseAuthData(d: Buffer): AuthData {
  if (d.length < 37) throw new Rejected('authdata', 'authenticator data is too short');
  const flags = d[32]!;
  const base = { rpIdHash: d.subarray(0, 32), flags, signCount: d.readUInt32BE(33) };
  let pos = 37;
  let attested: AuthData['attested'];
  if (flags & FLAG.AT) {
    if (d.length < pos + 18) throw new Rejected('authdata', 'attested credential data is cut short');
    const aaguid = uuid(d.subarray(pos, pos + 16));
    const len = d.readUInt16BE(pos + 16);
    pos += 18;
    if (len < 1 || len > 1023 || d.length < pos + len) throw new Rejected('authdata', 'the credential id has an impossible length');
    const credentialId = Buffer.from(d.subarray(pos, pos + len));
    pos += len;
    let r;
    try {
      r = decodeCbor(d, pos);
    } catch (e) {
      throw new Rejected('authdata', `the credential public key: ${(e as Error).message}`);
    }
    if (!(r.value instanceof Map)) throw new Rejected('authdata', 'the credential public key is not a COSE key');
    attested = { aaguid, credentialId, cosePublicKey: Buffer.from(d.subarray(pos, r.end)), key: r.value };
    pos = r.end;
  }
  let hasExtensions = false;
  if (flags & FLAG.ED) {
    try {
      const r = decodeCbor(d, pos);
      if (!(r.value instanceof Map)) throw new BadCbor('not a map');
      pos = r.end;
      hasExtensions = true;
    } catch {
      throw new Rejected('authdata', 'the extensions are not valid CBOR');
    }
  }
  if (pos !== d.length) throw new Rejected('authdata', 'bytes left over after authenticator data');
  return { ...base, ...(attested ? { attested } : {}), hasExtensions };
}

export type Alg = -7 | -8 | -257;
export const ALGS: readonly Alg[] = [-7, -257, -8];

/** A COSE_Key as a Node key object, for the three algorithms accepted. */
export function coseToKey(cose: Buffer): { key: KeyObject; alg: Alg } {
  let m: Cbor;
  try {
    m = parseCbor(cose);
  } catch (e) {
    throw new Rejected('key', (e as Error).message);
  }
  if (!(m instanceof Map)) throw new Rejected('key', 'a COSE key is a map');
  return coseMapToKey(m);
}

function coseMapToKey(m: Map<number | string, Cbor>): { key: KeyObject; alg: Alg } {
  const kty = m.get(1);
  const alg = m.get(3);
  const b = (k: number) => {
    const v = m.get(k);
    if (!Buffer.isBuffer(v)) throw new Rejected('key', `COSE key parameter ${k} is missing`);
    return v;
  };
  try {
    if (kty === 2 && alg === -7) {
      if (m.get(-1) !== 1) throw new Rejected('key', 'ES256 needs the P-256 curve');
      const x = b(-2);
      const y = b(-3);
      if (x.length !== 32 || y.length !== 32) throw new Rejected('key', 'a P-256 coordinate is 32 bytes');
      return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' }), alg: -7 };
    }
    if (kty === 3 && alg === -257) {
      const n = b(-1);
      const e = b(-2);
      if (n.length < 256) throw new Rejected('key', 'an RSA key under 2048 bits');
      return { key: createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' }), alg: -257 };
    }
    if (kty === 1 && alg === -8) {
      if (m.get(-1) !== 6) throw new Rejected('key', 'EdDSA needs the Ed25519 curve');
      const x = b(-2);
      if (x.length !== 32) throw new Rejected('key', 'an Ed25519 key is 32 bytes');
      return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' }), alg: -8 };
    }
  } catch (e) {
    if (e instanceof Rejected) throw e;
    throw new Rejected('key', 'that is not a usable public key');
  }
  throw new Rejected('alg', `the key type or algorithm (${String(kty)}, ${String(alg)}) is not supported`);
}

/** Checks a signature the way each algorithm needs: DER for ECDSA, PKCS#1 v1.5 for RSA, pure Ed25519. */
export function checkSignature(key: KeyObject, alg: Alg, data: Buffer, sig: Buffer): boolean {
  try {
    return alg === -8 ? cryptoVerify(null, data, key, sig) : cryptoVerify('sha256', data, key, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- challenges

export interface Challenge {
  readonly id: string;
  readonly challenge: string;
  readonly purpose: 'create' | 'get';
  readonly user: string | undefined;
  readonly expiresAt: number;
}

/** Single-use challenges that lapse. The ceremony state lives here, not in anything the browser can edit. */
export class Challenges {
  private readonly m = new Map<string, Challenge>();
  private readonly now: () => number;
  private readonly random: (n: number) => Buffer;
  private readonly ttl: number;
  constructor(o: { now?: () => number; random?: (n: number) => Buffer; ttlMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? randomBytes;
    this.ttl = o.ttlMs ?? 5 * 60_000;
  }
  issue(purpose: 'create' | 'get', user?: string): Challenge {
    for (const [k, c] of this.m) if (c.expiresAt <= this.now()) this.m.delete(k);
    const c: Challenge = { id: this.random(12).toString('base64url'), challenge: this.random(32).toString('base64url'), purpose, user, expiresAt: this.now() + this.ttl };
    this.m.set(c.id, c);
    return c;
  }
  /** Takes the challenge out: asking twice for the same id gets nothing the second time. */
  take(id: string, purpose: 'create' | 'get'): Challenge {
    const c = this.m.get(id);
    this.m.delete(id);
    if (!c) throw new Rejected('challenge', 'that ceremony was not started here, or has been used');
    if (c.expiresAt <= this.now()) throw new Rejected('challenge', 'that ceremony took too long');
    if (c.purpose !== purpose) throw new Rejected('challenge', 'that challenge is for something else');
    return c;
  }
}

// ---------------------------------------------------------------- credentials

export interface Credential {
  /** base64url credential id. */
  readonly id: string;
  readonly userId: string;
  /** The user handle the authenticator stores for discoverable sign-in. */
  readonly userHandle: string;
  readonly cosePublicKey: string;
  readonly alg: Alg;
  signCount: number;
  readonly aaguid: string;
  readonly transports: readonly string[];
  readonly backupEligible: boolean;
  backedUp: boolean;
  readonly fmt: string;
  /** Whether the attestation chained to a root the policy trusts. */
  readonly attestationTrusted: boolean;
  name: string;
  readonly createdAt: number;
  lastUsedAt: number | undefined;
}

export interface CredentialStore {
  add(c: Credential): void;
  get(id: string): Credential | undefined;
  forUser(userId: string): Credential[];
  remove(id: string): void;
}

export class MemoryCredentials implements CredentialStore {
  private readonly m = new Map<string, Credential>();
  add(c: Credential): void {
    if (this.m.has(c.id)) throw new Rejected('duplicate', 'that credential is already registered');
    this.m.set(c.id, c);
  }
  get(id: string): Credential | undefined {
    return this.m.get(id);
  }
  forUser(userId: string): Credential[] {
    return [...this.m.values()].filter((c) => c.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  }
  remove(id: string): void {
    this.m.delete(id);
  }
}

// ---------------------------------------------------------------- the relying party

export interface AttestationPolicy {
  /** Formats accepted; "none" means the authenticator's make is not checked at all. */
  readonly formats: readonly ('none' | 'packed' | 'fido-u2f')[];
  /** Certificate authorities (PEM) an attestation must chain to; when set, an attestation that does not is refused. */
  readonly trustedRoots?: readonly string[];
  /** If set, only these authenticator models (AAGUIDs) may register. */
  readonly allowedAaguids?: readonly string[];
  readonly deniedAaguids?: readonly string[];
}

export interface RelyingParty {
  readonly rpId: string;
  readonly rpName: string;
  /** Exact origins that may run the ceremony, like "https://app.example.org". */
  readonly origins: readonly string[];
  readonly userVerification?: 'required' | 'preferred' | 'discouraged';
  readonly attestation?: AttestationPolicy;
  /** What to do when a sign-in counter does not rise: refuse (the default) or let it through and say so. */
  readonly onCounterRegression?: 'reject' | 'warn';
  readonly algs?: readonly Alg[];
  readonly now?: () => number;
  readonly random?: (n: number) => Buffer;
  readonly challenges?: Challenges;
  readonly credentials?: CredentialStore;
}

export interface RegistrationResponse {
  readonly id: string;
  readonly response: { readonly clientDataJSON: string; readonly attestationObject: string; readonly transports?: readonly string[] };
}

export interface AuthenticationResponse {
  readonly id: string;
  readonly response: { readonly clientDataJSON: string; readonly authenticatorData: string; readonly signature: string; readonly userHandle?: string | null };
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64 = (s: string) => Buffer.from(s, 'base64url');

export class WebAuthn {
  readonly credentials: CredentialStore;
  readonly challenges: Challenges;
  private readonly rp: RelyingParty;
  private readonly now: () => number;
  private readonly algs: readonly Alg[];
  private readonly rpIdHash: Buffer;

  constructor(rp: RelyingParty) {
    if (!rp.origins.length || rp.origins.some((o) => !/^https:\/\/[^/]+$/.test(o) && !/^http:\/\/localhost(:\d+)?$/.test(o))) throw new RangeError('origins must be exact https origins (http only for localhost)');
    this.rp = rp;
    this.now = rp.now ?? Date.now;
    this.algs = rp.algs ?? ALGS;
    this.rpIdHash = sha256(rp.rpId);
    this.credentials = rp.credentials ?? new MemoryCredentials();
    this.challenges = rp.challenges ?? new Challenges({ now: this.now, ...(rp.random ? { random: rp.random } : {}) });
  }

  // -------- registration

  /** Options for navigator.credentials.create(), and the id of the ceremony to give back with the response. */
  beginRegistration(user: { id: string; name: string; displayName: string }, o: { residentKey?: 'required' | 'preferred' | 'discouraged' } = {}): { ceremony: string; options: Record<string, unknown> } {
    const c = this.challenges.issue('create', user.id);
    const have = this.credentials.forUser(user.id);
    return {
      ceremony: c.id,
      options: {
        rp: { id: this.rp.rpId, name: this.rp.rpName },
        user: { id: Buffer.from(user.id).toString('base64url'), name: user.name, displayName: user.displayName },
        challenge: c.challenge,
        pubKeyCredParams: this.algs.map((alg) => ({ type: 'public-key', alg })),
        timeout: 300_000,
        // Authenticators already registered are excluded, so the same one is not added twice.
        excludeCredentials: have.map((x) => ({ type: 'public-key', id: x.id, transports: x.transports })),
        authenticatorSelection: { residentKey: o.residentKey ?? 'preferred', userVerification: this.rp.userVerification ?? 'preferred' },
        attestation: this.rp.attestation && this.rp.attestation.formats.some((f) => f !== 'none') ? 'direct' : 'none',
      },
    };
  }

  /** Verifies a registration and stores the new credential. Throws `Rejected` with a code for anything wrong. */
  finishRegistration(ceremony: string, r: RegistrationResponse, o: { name?: string; userHandle?: string } = {}): Credential {
    const ch = this.challenges.take(ceremony, 'create');
    const clientDataJSON = b64(r.response.clientDataJSON);
    this.checkClientData(clientDataJSON, 'webauthn.create', ch.challenge);
    let ao: Cbor;
    try {
      ao = parseCbor(b64(r.response.attestationObject));
    } catch (e) {
      throw new Rejected('attestation', (e as Error).message);
    }
    if (!(ao instanceof Map)) throw new Rejected('attestation', 'the attestation object is not a map');
    const fmt = ao.get('fmt');
    const stmt = ao.get('attStmt');
    const rawAuth = ao.get('authData');
    if (typeof fmt !== 'string' || !(stmt instanceof Map) || !Buffer.isBuffer(rawAuth)) throw new Rejected('attestation', 'the attestation object is missing parts');
    const auth = parseAuthData(rawAuth);
    this.checkAuthData(auth, true);
    if (!auth.attested) throw new Rejected('attestation', 'a registration carries the new credential');
    if (auth.attested.credentialId.toString('base64url') !== r.id) throw new Rejected('attestation', 'the credential id does not match the one reported');
    if (this.credentials.get(r.id)) throw new Rejected('duplicate', 'that credential is already registered');
    const { key, alg } = coseMapToKey(auth.attested.key);
    if (!this.algs.includes(alg)) throw new Rejected('alg', 'that algorithm was not offered');
    const policy = this.rp.attestation ?? { formats: ['none'] as const };
    if (!(policy.formats as readonly string[]).includes(fmt)) throw new Rejected('attestation', `the ${fmt} attestation format is not accepted`);
    const trusted = this.checkAttestation(fmt, stmt, rawAuth, sha256(clientDataJSON), auth, key, alg, policy);
    if (policy.trustedRoots?.length && !trusted && fmt !== 'none') throw new Rejected('attestation', 'the attestation does not chain to a trusted root');
    if (policy.trustedRoots?.length && fmt === 'none') throw new Rejected('attestation', 'this relying party needs a verifiable attestation');
    const aaguid = auth.attested.aaguid;
    if (policy.allowedAaguids && !policy.allowedAaguids.includes(aaguid)) throw new Rejected('aaguid', 'that kind of authenticator is not allowed');
    if (policy.deniedAaguids?.includes(aaguid)) throw new Rejected('aaguid', 'that kind of authenticator is not allowed');
    const cred: Credential = {
      id: r.id,
      userId: ch.user!,
      userHandle: o.userHandle ?? Buffer.from(ch.user!).toString('base64url'),
      cosePublicKey: auth.attested.cosePublicKey.toString('base64url'),
      alg,
      signCount: auth.signCount,
      aaguid,
      transports: [...(r.response.transports ?? [])].filter((t) => /^[a-z-]{2,20}$/.test(t)).slice(0, 8),
      backupEligible: !!(auth.flags & FLAG.BE),
      backedUp: !!(auth.flags & FLAG.BS),
      fmt,
      attestationTrusted: trusted,
      name: (o.name ?? 'Passkey').slice(0, 80),
      createdAt: this.now(),
      lastUsedAt: undefined,
    };
    this.credentials.add(cred);
    return cred;
  }

  private checkClientData(raw: Buffer, type: string, challenge: string): void {
    let cd: Record<string, unknown>;
    try {
      cd = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Rejected('client_data', 'clientDataJSON is not JSON');
    }
    if (typeof cd !== 'object' || cd === null) throw new Rejected('client_data', 'clientDataJSON is not an object');
    if (cd['type'] !== type) throw new Rejected('client_data', `the ceremony type is not ${type}`);
    if (typeof cd['challenge'] !== 'string' || !equal(cd['challenge'], challenge)) throw new Rejected('challenge', 'the challenge is not the one issued');
    if (typeof cd['origin'] !== 'string' || !this.rp.origins.includes(cd['origin'])) throw new Rejected('origin', 'the origin is not one this service accepts');
    if (cd['crossOrigin'] === true) throw new Rejected('origin', 'the ceremony ran in a cross-origin frame');
  }

  private checkAuthData(a: AuthData, registering: boolean): void {
    if (!equal(a.rpIdHash.toString('hex'), this.rpIdHash.toString('hex'))) throw new Rejected('rp_id', 'the relying party id hash is not ours');
    if (!(a.flags & FLAG.UP)) throw new Rejected('presence', 'the user was not present');
    if (this.rp.userVerification === 'required' && !(a.flags & FLAG.UV)) throw new Rejected('verification', 'the user was not verified');
    if (a.flags & FLAG.BS && !(a.flags & FLAG.BE)) throw new Rejected('flags', 'a credential cannot be backed up if it is not backup eligible');
    if (!registering && a.attested) throw new Rejected('authdata', 'a sign-in carries no new credential');
  }

  private checkAttestation(fmt: string, stmt: Map<number | string, Cbor>, rawAuth: Buffer, clientHash: Buffer, auth: AuthData, key: KeyObject, alg: Alg, policy: AttestationPolicy): boolean {
    if (fmt === 'none') {
      if (stmt.size !== 0) throw new Rejected('attestation', 'a "none" attestation has an empty statement');
      return false;
    }
    const sig = stmt.get('sig');
    if (!Buffer.isBuffer(sig)) throw new Rejected('attestation', 'the attestation has no signature');
    const x5c = stmt.get('x5c');
    if (fmt === 'packed') {
      const signed = Buffer.concat([rawAuth, clientHash]);
      const statedAlg = stmt.get('alg');
      if (typeof statedAlg !== 'number' || !(ALGS as readonly number[]).includes(statedAlg)) throw new Rejected('attestation', 'the attestation algorithm is missing or unsupported');
      if (x5c === undefined) {
        // Self attestation: signed by the credential's own key, so it proves possession and nothing about the make.
        if (statedAlg !== alg) throw new Rejected('attestation', 'a self attestation is made with the credential algorithm');
        if (!checkSignature(key, alg, signed, sig)) throw new Rejected('attestation', 'the self attestation signature is wrong');
        return false;
      }
      const chain = this.certs(x5c);
      const leaf = chain[0]!;
      this.checkCertDates(chain);
      if (!checkSignature(leaf.publicKey, statedAlg as Alg, signed, sig)) throw new Rejected('attestation', 'the attestation signature is wrong');
      return this.chains(chain, policy);
    }
    if (fmt === 'fido-u2f') {
      if (!Array.isArray(x5c) || x5c.length !== 1) throw new Rejected('attestation', 'a fido-u2f attestation has exactly one certificate');
      if (alg !== -7 || !auth.attested) throw new Rejected('attestation', 'fido-u2f needs an ES256 credential');
      const chain = this.certs(x5c);
      this.checkCertDates(chain);
      const jwk = key.export({ format: 'jwk' });
      const point = Buffer.concat([Buffer.from([4]), b64(String(jwk['x'])), b64(String(jwk['y']))]);
      const signed = Buffer.concat([Buffer.from([0]), auth.rpIdHash, clientHash, auth.attested.credentialId, point]);
      if (!checkSignature(chain[0]!.publicKey, -7, signed, sig)) throw new Rejected('attestation', 'the attestation signature is wrong');
      return this.chains(chain, policy);
    }
    throw new Rejected('attestation', `the ${fmt} attestation format is not supported`);
  }

  private certs(x5c: Cbor | undefined): X509Certificate[] {
    if (!Array.isArray(x5c) || x5c.length < 1 || x5c.length > 5 || !x5c.every((c) => Buffer.isBuffer(c))) throw new Rejected('attestation', 'the certificate chain is malformed');
    try {
      return x5c.map((c) => new X509Certificate(c as Buffer));
    } catch {
      throw new Rejected('attestation', 'a certificate in the chain cannot be read');
    }
  }

  private checkCertDates(chain: X509Certificate[]): void {
    const t = this.now();
    for (const c of chain) if (t < Date.parse(c.validFrom) || t > Date.parse(c.validTo)) throw new Rejected('attestation', 'an attestation certificate is outside its validity dates');
  }

  /** Whether the chain, leaf first, is signed link by link up to one of the policy's roots. */
  private chains(chain: X509Certificate[], policy: AttestationPolicy): boolean {
    if (!policy.trustedRoots?.length) return false;
    let roots: X509Certificate[];
    try {
      roots = policy.trustedRoots.map((p) => new X509Certificate(p));
    } catch {
      throw new RangeError('a trusted root is not a certificate');
    }
    for (let i = 0; i < chain.length - 1; i++) if (!chain[i]!.verify(chain[i + 1]!.publicKey)) return false;
    const top = chain[chain.length - 1]!;
    return roots.some((r) => (r.raw.equals(top.raw) || top.verify(r.publicKey)) && this.now() >= Date.parse(r.validFrom) && this.now() <= Date.parse(r.validTo));
  }

  // -------- sign-in

  /** Options for navigator.credentials.get(). Without a user, the sign-in is for a discoverable passkey. */
  beginAuthentication(userId?: string): { ceremony: string; options: Record<string, unknown> } {
    const c = this.challenges.issue('get', userId);
    const allow = userId ? this.credentials.forUser(userId) : [];
    return {
      ceremony: c.id,
      options: {
        challenge: c.challenge,
        rpId: this.rp.rpId,
        timeout: 300_000,
        userVerification: this.rp.userVerification ?? 'preferred',
        allowCredentials: allow.map((x) => ({ type: 'public-key', id: x.id, transports: x.transports })),
      },
    };
  }

  /**
   * Verifies a sign-in and returns the credential used (its counter and backup state updated) and whether the counter
   * looked wrong. When `userId` was named at the start, the credential must be that person's.
   */
  finishAuthentication(ceremony: string, r: AuthenticationResponse): { credential: Credential; counterWarning: boolean } {
    const ch = this.challenges.take(ceremony, 'get');
    const cred = this.credentials.get(r.id);
    if (!cred) throw new Rejected('credential', 'that credential is not registered');
    if (ch.user !== undefined && cred.userId !== ch.user) throw new Rejected('credential', 'that credential belongs to someone else');
    const rawClient = b64(r.response.clientDataJSON);
    this.checkClientData(rawClient, 'webauthn.get', ch.challenge);
    const rawAuth = b64(r.response.authenticatorData);
    const auth = parseAuthData(rawAuth);
    this.checkAuthData(auth, false);
    const handle = r.response.userHandle;
    if (ch.user === undefined) {
      // Discoverable sign-in: the authenticator must say whose passkey it is, and it must be the owner of this credential.
      if (!handle || handle !== cred.userHandle) throw new Rejected('credential', 'the user handle does not match the credential');
    } else if (handle && handle !== cred.userHandle) throw new Rejected('credential', 'the user handle does not match the credential');
    const { key } = coseToKey(b64(cred.cosePublicKey));
    if (!checkSignature(key, cred.alg, Buffer.concat([rawAuth, sha256(rawClient)]), b64(r.response.signature))) throw new Rejected('signature', 'the signature is not valid for this credential');
    // Backup eligibility is fixed for the life of a credential; a change means this is not the same credential.
    if (!!(auth.flags & FLAG.BE) !== cred.backupEligible) throw new Rejected('flags', 'the backup eligibility of the credential changed');
    let warn = false;
    if (auth.signCount !== 0 || cred.signCount !== 0) {
      if (auth.signCount <= cred.signCount) {
        if (this.rp.onCounterRegression === 'warn') warn = true;
        else throw new Rejected('counter', 'the sign-in counter did not go up: this authenticator may have been cloned');
      }
    }
    cred.signCount = Math.max(cred.signCount, auth.signCount);
    cred.backedUp = !!(auth.flags & FLAG.BS);
    cred.lastUsedAt = this.now();
    return { credential: cred, counterWarning: warn };
  }

  // -------- management

  /** What a settings page shows: no key material. */
  credentialList(userId: string): { id: string; name: string; createdAt: number; lastUsedAt: number | undefined; transports: readonly string[]; backedUp: boolean; backupEligible: boolean; aaguid: string; fmt: string }[] {
    return this.credentials.forUser(userId).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, transports: c.transports, backedUp: c.backedUp, backupEligible: c.backupEligible, aaguid: c.aaguid, fmt: c.fmt }));
  }

  rename(userId: string, id: string, name: string): void {
    const c = this.credentials.get(id);
    if (!c || c.userId !== userId) throw new Rejected('credential', 'no such credential');
    const n = name.trim();
    if (!n || n.length > 80) throw new Rejected('name', 'a name is 1 to 80 characters');
    c.name = n;
  }

  /** Removes one. The last passkey is kept unless the caller says another way to sign in exists. */
  remove(userId: string, id: string, o: { otherSignIn?: boolean } = {}): void {
    const c = this.credentials.get(id);
    if (!c || c.userId !== userId) throw new Rejected('credential', 'no such credential');
    if (this.credentials.forUser(userId).length === 1 && !o.otherSignIn) throw new Rejected('last', 'that is the last way to sign in');
    this.credentials.remove(id);
  }
}
