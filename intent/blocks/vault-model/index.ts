/**
 * The data model of a client-side encrypted vault, in the shape the Bitwarden family of password managers uses,
 * so the server holds only ciphertext and can never read an item. Everything a server needs to store and relay is
 * here, and everything that needs a secret takes the key as an argument:
 *
 *  - Cipher strings: "2.<iv>|<ciphertext>|<mac>", AES-256-CBC with an HMAC-SHA-256 over iv and ciphertext checked
 *    first in constant time (encrypt-then-MAC), and "4.<ciphertext>", RSA-2048 OAEP with SHA-1 (what the clients
 *    use to hand a key to a person). Wrong type, bad base64, wrong lengths and a failed MAC are refused with the
 *    same plain error, so nothing leaks about which.
 *  - The key hierarchy: the master key is PBKDF2-HMAC-SHA-256 (RFC 8018, tested against the RFC 7914 vectors) or
 *    scrypt (RFC 7914) of the password salted with the lower-cased email; the server is shown only a further hash
 *    of it, and keeps a salted PBKDF2 of that; HKDF-Expand (RFC 5869) stretches the master key into an encryption
 *    and a MAC key; those wrap a random 64-byte user key, which wraps everything else, including an RSA key pair
 *    whose private half is kept wrapped. Changing the master password re-wraps the one user key; nothing else moves.
 *    Parameters below a safe floor are refused unless the caller says it knows.
 *  - Items (login, note, card, identity) with every secret field encrypted separately, optionally under their own
 *    item key wrapped by the owner's key, folders (names encrypted), and organisations: an organisation key handed
 *    to each confirmed member under their RSA key, collections with read-only, hide-passwords and manage rights,
 *    items shared into collections, and rotation of the organisation key.
 *  - Send: a one-off share whose key lives only in the link (HKDF-SHA-256 from 16 random bytes), with access
 *    counts, expiry, deletion date and an optional password the server keeps as a hash.
 *  - Emergency access: a trusted contact can ask to view or take over an account; the owner may refuse during a
 *    waiting period, after which it is granted. The user key is escrowed to the contact only once the owner confirms.
 *
 * Randomness and the clock are arguments. Out of scope: the transport, the database, TOTP codes inside items (an
 * item stores the secret like any other field) and Argon2id (the platform's crypto does not provide it on every
 * supported Node; scrypt is offered in its place and the KDF is named in the record so another can be added).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, pbkdf2Sync, privateDecrypt, publicEncrypt, randomBytes, scryptSync, constants } from 'node:crypto';
import { equal } from '../crypto/index.ts';

export class VaultError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Random = (bytes: number) => Buffer;
const defaultRandom: Random = (n) => randomBytes(n);
const DAY = 86_400_000;

// ================================================================ key derivation

export type Kdf = { readonly type: 'pbkdf2'; readonly iterations: number } | { readonly type: 'scrypt'; readonly N: number; readonly r: number; readonly p: number };

export const DEFAULT_KDF: Kdf = { type: 'pbkdf2', iterations: 600_000 };
export const MIN_PBKDF2 = 100_000;
export const MIN_SCRYPT_N = 2 ** 15;

export function checkKdf(kdf: Kdf, allowWeak = false): void {
  if (kdf.type === 'pbkdf2') {
    if (!Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > 10_000_000) throw new VaultError('PBKDF2 iterations are a whole number from 1 to 10 million');
    if (!allowWeak && kdf.iterations < MIN_PBKDF2) throw new VaultError(`${kdf.iterations} PBKDF2 iterations is too few; at least ${MIN_PBKDF2}`);
  } else if (kdf.type === 'scrypt') {
    const ok = Number.isInteger(kdf.N) && kdf.N >= 2 && (kdf.N & (kdf.N - 1)) === 0 && Number.isInteger(kdf.r) && kdf.r >= 1 && Number.isInteger(kdf.p) && kdf.p >= 1;
    if (!ok || kdf.N > 2 ** 22 || kdf.r > 32 || kdf.p > 16) throw new VaultError('scrypt needs N a power of two up to 2^22, r up to 32 and p up to 16');
    if (!allowWeak && kdf.N < MIN_SCRYPT_N) throw new VaultError(`scrypt N=${kdf.N} is too small; at least ${MIN_SCRYPT_N}`);
  } else throw new VaultError('unknown key derivation function');
}

const normEmail = (email: string) => email.trim().toLowerCase();

/** The master key: a slow hash of the password salted with the email. 32 bytes. */
export function deriveMasterKey(password: string, email: string, kdf: Kdf = DEFAULT_KDF, allowWeak = false): Buffer {
  checkKdf(kdf, allowWeak);
  if (!password) throw new VaultError('the master password is empty');
  const salt = Buffer.from(normEmail(email), 'utf8');
  if (!salt.length) throw new VaultError('the email is empty');
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  return kdf.type === 'pbkdf2' ? pbkdf2Sync(pw, salt, kdf.iterations, 32, 'sha256') : scryptSync(pw, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 64 * 1024 * 1024 });
}

/** What the client sends to prove it knows the password: one more round over the master key, salted with the password. */
export const authHash = (masterKey: Uint8Array, password: string): string => pbkdf2Sync(masterKey, Buffer.from(password.normalize('NFKC'), 'utf8'), 1, 32, 'sha256').toString('base64');

export interface ServerAuth {
  readonly salt: string;
  readonly iterations: number;
  readonly hash: string;
}

/** What the server keeps: a salted slow hash of the auth hash, so a stolen database does not give a usable login. */
export function storeAuth(auth: string, random: Random = defaultRandom, iterations = 100_000): ServerAuth {
  const salt = random(16).toString('hex');
  return { salt, iterations, hash: pbkdf2Sync(auth, salt, iterations, 32, 'sha256').toString('hex') };
}

export const verifyAuth = (auth: string, stored: ServerAuth): boolean => equal(pbkdf2Sync(auth, stored.salt, stored.iterations, 32, 'sha256').toString('hex'), stored.hash);

/** HKDF-Expand only (RFC 5869 section 2.3): the master key is already uniformly random-looking, so no extract step. */
export function hkdfExpand(prk: Uint8Array, info: string | Uint8Array, length: number): Buffer {
  if (!(length >= 1 && length <= 255 * 32)) throw new VaultError('HKDF output is 1 to 8160 bytes');
  const infoB = typeof info === 'string' ? Buffer.from(info) : Buffer.from(info);
  const out: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    t = createHmac('sha256', prk).update(t).update(infoB).update(Buffer.of(i)).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, length);
}

export interface SymKey {
  readonly enc: Buffer;
  readonly mac: Buffer;
}

export const symKey = (b: Uint8Array): SymKey => {
  if (b.length !== 64) throw new VaultError('a symmetric key is 64 bytes: 32 for encryption and 32 for the MAC');
  return { enc: Buffer.from(b.subarray(0, 32)), mac: Buffer.from(b.subarray(32)) };
};
export const keyBytes = (k: SymKey): Buffer => Buffer.concat([k.enc, k.mac]);

/** The master key stretched into an encryption key and a MAC key. */
export const stretch = (masterKey: Uint8Array): SymKey => {
  if (masterKey.length !== 32) throw new VaultError('a master key is 32 bytes');
  return { enc: hkdfExpand(masterKey, 'enc', 32), mac: hkdfExpand(masterKey, 'mac', 32) };
};

// ================================================================ cipher strings

export interface Parsed {
  readonly type: 2;
  readonly iv: Buffer;
  readonly ct: Buffer;
  readonly mac: Buffer;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const bad = () => new VaultError('that is not a cipher string this key opens');

export function parseEncString(s: string): Parsed {
  if (typeof s !== 'string' || s.length > 10_000_000) throw bad();
  const m = /^2\.([^|.]+)\|([^|.]+)\|([^|.]+)$/.exec(s);
  if (!m || !B64.test(m[1]!) || !B64.test(m[2]!) || !B64.test(m[3]!)) throw bad();
  const iv = Buffer.from(m[1]!, 'base64');
  const ct = Buffer.from(m[2]!, 'base64');
  const mac = Buffer.from(m[3]!, 'base64');
  if (iv.length !== 16 || mac.length !== 32 || ct.length === 0 || ct.length % 16 !== 0) throw bad();
  return { type: 2, iv, ct, mac };
}

/** AES-256-CBC with an HMAC-SHA-256 over iv and ciphertext. The iv comes from `random`, so tests can pin it. */
export function encString(plain: string | Uint8Array, key: SymKey, random: Random = defaultRandom): string {
  const iv = random(16);
  if (iv.length !== 16) throw new VaultError('an iv is 16 bytes');
  const c = createCipheriv('aes-256-cbc', key.enc, iv);
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  const mac = createHmac('sha256', key.mac).update(iv).update(ct).digest();
  return `2.${iv.toString('base64')}|${ct.toString('base64')}|${mac.toString('base64')}`;
}

/** Checks the MAC in constant time before any decryption; every failure is the same error. */
export function decBytes(s: string, key: SymKey): Buffer {
  const p = parseEncString(s);
  const mac = createHmac('sha256', key.mac).update(p.iv).update(p.ct).digest();
  if (!equal(mac.toString('base64'), p.mac.toString('base64'))) throw bad();
  try {
    const d = createDecipheriv('aes-256-cbc', key.enc, p.iv);
    return Buffer.concat([d.update(p.ct), d.final()]);
  } catch {
    throw bad();
  }
}

export const decString = (s: string, key: SymKey): string => decBytes(s, key).toString('utf8');

export interface RsaKeys {
  /** SubjectPublicKeyInfo, DER. */
  readonly publicKey: Buffer;
  /** PKCS#8, DER. */
  readonly privateKey: Buffer;
}

export function generateRsa(): RsaKeys {
  const k = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } });
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

/** "4.<ciphertext>": RSA-2048 OAEP (SHA-1, as the clients do) to someone's public key. */
export function rsaWrap(publicKey: Uint8Array, data: Uint8Array): string {
  const key = createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new VaultError('a public key must be RSA of 2048 bits or more');
  return `4.${publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, data).toString('base64')}`;
}

export function rsaUnwrap(privateKey: Uint8Array, s: string): Buffer {
  const m = /^4\.([A-Za-z0-9+/]+={0,2})$/.exec(s);
  if (!m) throw bad();
  try {
    return privateDecrypt({ key: createPrivateKey({ key: Buffer.from(privateKey), type: 'pkcs8', format: 'der' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, Buffer.from(m[1]!, 'base64'));
  } catch {
    throw bad();
  }
}

/** Short groups of hex to read aloud and compare, so a public key can be confirmed out of band. */
export const fingerprint = (publicKey: Uint8Array, userId: string): string => {
  const h = createHash('sha256').update(userId).update(publicKey).digest('hex').slice(0, 40);
  return h.match(/.{4}/g)!.join('-');
};

// ================================================================ accounts

export interface AccountRecord {
  readonly id: string;
  readonly email: string;
  readonly kdf: Kdf;
  readonly auth: ServerAuth;
  /** The user key, wrapped by the stretched master key. */
  readonly key: string;
  readonly publicKey: string;
  /** The RSA private key, wrapped by the user key. */
  readonly privateKey: string;
  readonly revision: number;
}

export interface Unlocked {
  readonly userKey: SymKey;
  readonly privateKey: Buffer;
}

export interface NewAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly kdf?: Kdf;
  readonly allowWeakKdf?: boolean;
  readonly random?: Random;
  readonly rsa?: RsaKeys;
}

export function createAccount(o: NewAccount): { record: AccountRecord; unlocked: Unlocked } {
  const random = o.random ?? defaultRandom;
  const kdf = o.kdf ?? DEFAULT_KDF;
  const master = deriveMasterKey(o.password, o.email, kdf, o.allowWeakKdf);
  const rsa = o.rsa ?? generateRsa();
  const userKey = symKey(random(64));
  const record: AccountRecord = {
    id: o.id, email: normEmail(o.email), kdf,
    auth: storeAuth(authHash(master, o.password), random),
    key: encString(keyBytes(userKey), stretch(master), random),
    publicKey: rsa.publicKey.toString('base64'),
    privateKey: encString(rsa.privateKey, userKey, random),
    revision: 1,
  };
  return { record, unlocked: { userKey, privateKey: rsa.privateKey } };
}

/** What the client does to log in: derive, prove, and open the keys. The server side is `verifyAuth`. */
export function login(record: AccountRecord, password: string, allowWeakKdf = false): { auth: string; unlock: () => Unlocked } {
  const master = deriveMasterKey(password, record.email, record.kdf, allowWeakKdf);
  return {
    auth: authHash(master, password),
    unlock: () => {
      const userKey = symKey(decBytes(record.key, stretch(master)));
      return { userKey, privateKey: decBytes(record.privateKey, userKey) };
    },
  };
}

/** A new master password (and optionally a new KDF): only the wrapping of the one user key changes. */
export function changeMasterPassword(record: AccountRecord, unlocked: Unlocked, newPassword: string, o: { kdf?: Kdf; allowWeakKdf?: boolean; random?: Random } = {}): AccountRecord {
  const random = o.random ?? defaultRandom;
  const kdf = o.kdf ?? record.kdf;
  const master = deriveMasterKey(newPassword, record.email, kdf, o.allowWeakKdf);
  return { ...record, kdf, auth: storeAuth(authHash(master, newPassword), random), key: encString(keyBytes(unlocked.userKey), stretch(master), random), revision: record.revision + 1 };
}

// ================================================================ items

export type ItemType = 'login' | 'note' | 'card' | 'identity';

export interface ItemData {
  readonly type: ItemType;
  readonly name: string;
  readonly notes?: string;
  readonly login?: { readonly username?: string; readonly password?: string; readonly totp?: string; readonly uris?: readonly string[] };
  readonly card?: { readonly holder?: string; readonly number?: string; readonly expiry?: string; readonly code?: string };
  readonly identity?: Readonly<Record<string, string>>;
  readonly fields?: readonly { readonly name: string; readonly value: string; readonly hidden?: boolean }[];
  readonly favorite?: boolean;
  /** Ask for the master password again before showing it. */
  readonly reprompt?: boolean;
}

export interface EncryptedItem {
  readonly id: string;
  readonly type: ItemType;
  readonly folderId: string | null;
  readonly organizationId: string | null;
  readonly collectionIds: readonly string[];
  /** The item's own key, wrapped by its owner's key; every field is under this key when present. */
  readonly key?: string;
  readonly name: string;
  readonly notes?: string;
  readonly login?: { readonly username?: string; readonly password?: string; readonly totp?: string; readonly uris?: readonly string[] };
  readonly card?: { readonly holder?: string; readonly number?: string; readonly expiry?: string; readonly code?: string };
  readonly identity?: Readonly<Record<string, string>>;
  readonly fields?: readonly { readonly name: string; readonly value: string; readonly hidden: boolean }[];
  readonly favorite: boolean;
  readonly reprompt: boolean;
  readonly revision: number;
}

const ITEM_TYPES = new Set(['login', 'note', 'card', 'identity']);

export function encryptItem(id: string, d: ItemData, owner: SymKey, o: { random?: Random; itemKey?: boolean; folderId?: string | null; organizationId?: string | null; collectionIds?: readonly string[]; revision?: number } = {}): EncryptedItem {
  const random = o.random ?? defaultRandom;
  if (!ITEM_TYPES.has(d.type)) throw new VaultError(`"${d.type}" is not an item type`);
  if (!d.name.trim()) throw new VaultError('an item needs a name');
  const itemKey = o.itemKey === false ? null : symKey(random(64));
  const k = itemKey ?? owner;
  const e = (s: string | undefined) => (s === undefined ? undefined : encString(s, k, random));
  const out: { -readonly [K in keyof EncryptedItem]?: EncryptedItem[K] } = {
    id, type: d.type, folderId: o.folderId ?? null, organizationId: o.organizationId ?? null, collectionIds: [...(o.collectionIds ?? [])],
    name: encString(d.name, k, random), favorite: d.favorite ?? false, reprompt: d.reprompt ?? false, revision: o.revision ?? 1,
  };
  if (itemKey) out.key = encString(keyBytes(itemKey), owner, random);
  if (d.notes !== undefined) out.notes = e(d.notes)!;
  if (d.login) out.login = { ...(d.login.username !== undefined ? { username: e(d.login.username)! } : {}), ...(d.login.password !== undefined ? { password: e(d.login.password)! } : {}), ...(d.login.totp !== undefined ? { totp: e(d.login.totp)! } : {}), ...(d.login.uris ? { uris: d.login.uris.map((u) => e(u)!) } : {}) };
  if (d.card) out.card = Object.fromEntries(Object.entries(d.card).map(([a, b]) => [a, e(b)!]));
  if (d.identity) out.identity = Object.fromEntries(Object.entries(d.identity).map(([a, b]) => [a, e(b)!]));
  if (d.fields) out.fields = d.fields.map((f) => ({ name: e(f.name)!, value: e(f.value)!, hidden: f.hidden ?? false }));
  return out as EncryptedItem;
}

export function decryptItem(it: EncryptedItem, owner: SymKey): ItemData {
  const k = it.key ? symKey(decBytes(it.key, owner)) : owner;
  const d = (s: string | undefined) => (s === undefined ? undefined : decString(s, k));
  const opt = <T extends object>(o: T | undefined, f: (o: T) => unknown) => (o ? f(o) : undefined);
  const r: Record<string, unknown> = { type: it.type, name: decString(it.name, k), favorite: it.favorite, reprompt: it.reprompt };
  if (it.notes !== undefined) r.notes = d(it.notes);
  if (it.login) r.login = opt(it.login, (l) => ({ ...(l.username !== undefined ? { username: d(l.username) } : {}), ...(l.password !== undefined ? { password: d(l.password) } : {}), ...(l.totp !== undefined ? { totp: d(l.totp) } : {}), ...(l.uris ? { uris: l.uris.map((u) => decString(u, k)) } : {}) }));
  if (it.card) r.card = Object.fromEntries(Object.entries(it.card).map(([a, b]) => [a, decString(b, k)]));
  if (it.identity) r.identity = Object.fromEntries(Object.entries(it.identity).map(([a, b]) => [a, decString(b, k)]));
  if (it.fields) r.fields = it.fields.map((f) => ({ name: decString(f.name, k), value: decString(f.value, k), hidden: f.hidden }));
  return r as unknown as ItemData;
}

/** Re-wraps an item's key (or, for an item with none, re-encrypts every field) from one owner key to another: moving into an organisation, or rotating a key. */
export function rekeyItem(it: EncryptedItem, from: SymKey, to: SymKey, o: { random?: Random; organizationId?: string | null; collectionIds?: readonly string[] } = {}): EncryptedItem {
  const random = o.random ?? defaultRandom;
  const base = { ...it, organizationId: o.organizationId === undefined ? it.organizationId : o.organizationId, collectionIds: o.collectionIds ? [...o.collectionIds] : it.collectionIds, revision: it.revision + 1 };
  if (it.key) return { ...base, key: encString(decBytes(it.key, from), to, random) };
  return { ...encryptItem(it.id, decryptItem(it, from), to, { random, itemKey: false, folderId: it.folderId, organizationId: base.organizationId, collectionIds: base.collectionIds, revision: base.revision }) };
}

export interface Folder {
  readonly id: string;
  readonly name: string;
}

export const encryptFolder = (id: string, name: string, key: SymKey, random?: Random): Folder => {
  if (!name.trim()) throw new VaultError('a folder needs a name');
  return { id, name: encString(name, key, random) };
};
export const decryptFolder = (f: Folder, key: SymKey): { id: string; name: string } => ({ id: f.id, name: decString(f.name, key) });

// ================================================================ organisations

export type OrgRole = 'owner' | 'admin' | 'manager' | 'user';
export type MemberStatus = 'invited' | 'accepted' | 'confirmed';

export interface Member {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly status: MemberStatus;
  /** Their public key, once they have accepted. */
  readonly publicKey?: string;
  /** The organisation key wrapped to their public key, once confirmed. */
  readonly key?: string;
}

export interface Access {
  readonly readOnly: boolean;
  readonly hidePasswords: boolean;
  readonly manage: boolean;
}

export interface Collection {
  readonly id: string;
  readonly name: string;
  readonly access: Readonly<Record<string, Access>>;
}

export interface OrgView {
  readonly read: boolean;
  readonly write: boolean;
  readonly seePasswords: boolean;
  readonly manage: boolean;
}

export class Organization {
  readonly id: string;
  readonly name: string;
  private members = new Map<string, Member>();
  private collections = new Map<string, Collection>();
  keyVersion = 1;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  /** Founds an organisation: a fresh organisation key, handed to the founder under their own public key. */
  static found(id: string, name: string, owner: { id: string; email: string; publicKey: Uint8Array }, random: Random = defaultRandom): { org: Organization; orgKey: SymKey } {
    const org = new Organization(id, name);
    const orgKey = symKey(random(64));
    org.members.set(owner.id, { id: owner.id, email: normEmail(owner.email), role: 'owner', status: 'confirmed', publicKey: Buffer.from(owner.publicKey).toString('base64'), key: rsaWrap(owner.publicKey, keyBytes(orgKey)) });
    return { org, orgKey };
  }

  member(id: string): Member | undefined {
    return this.members.get(id);
  }

  list(): Member[] {
    return [...this.members.values()];
  }

  private actor(id: string, ...roles: OrgRole[]): Member {
    const m = this.members.get(id);
    if (!m || m.status !== 'confirmed' || !roles.includes(m.role)) throw new VaultError(`only ${roles.join(' or ')} can do this`);
    return m;
  }

  invite(by: string, memberId: string, email: string, role: OrgRole): Member {
    const a = this.actor(by, 'owner', 'admin');
    if (role === 'owner' && a.role !== 'owner') throw new VaultError('only an owner can invite an owner');
    if (this.members.has(memberId) || [...this.members.values()].some((m) => m.email === normEmail(email))) throw new VaultError('that person is already a member or invited');
    const m: Member = { id: memberId, email: normEmail(email), role, status: 'invited' };
    this.members.set(memberId, m);
    return m;
  }

  /** The invited person accepts and offers the public key their organisation key will be sealed to. */
  accept(memberId: string, publicKey: Uint8Array): Member {
    const m = this.members.get(memberId);
    if (!m || m.status !== 'invited') throw new VaultError('there is no open invitation for that person');
    const next: Member = { ...m, status: 'accepted', publicKey: Buffer.from(publicKey).toString('base64') };
    this.members.set(memberId, next);
    return next;
  }

  /** An admin who holds the organisation key seals it to the person's key. `expectedFingerprint` is what the admin read out from the person. */
  confirm(by: string, orgKey: SymKey, memberId: string, expectedFingerprint: string): Member {
    this.actor(by, 'owner', 'admin');
    const m = this.members.get(memberId);
    if (!m || m.status !== 'accepted' || !m.publicKey) throw new VaultError('that person has not accepted yet');
    const pub = Buffer.from(m.publicKey, 'base64');
    if (fingerprint(pub, m.id) !== expectedFingerprint) throw new VaultError('the fingerprint does not match the key this person gave; do not confirm');
    const next: Member = { ...m, status: 'confirmed', key: rsaWrap(pub, keyBytes(orgKey)) };
    this.members.set(memberId, next);
    return next;
  }

  /** A member opens the organisation key with their private key. */
  openKey(memberId: string, privateKey: Uint8Array): SymKey {
    const m = this.members.get(memberId);
    if (!m?.key) throw new VaultError('that person has not been confirmed');
    return symKey(rsaUnwrap(privateKey, m.key));
  }

  remove(by: string, memberId: string): void {
    const a = this.actor(by, 'owner', 'admin');
    const m = this.members.get(memberId);
    if (!m) throw new VaultError('there is no such member');
    if (m.role === 'owner' && a.role !== 'owner') throw new VaultError('only an owner can remove an owner');
    if (m.role === 'owner' && [...this.members.values()].filter((x) => x.role === 'owner' && x.status === 'confirmed').length < 2) throw new VaultError('an organisation must keep at least one owner');
    this.members.delete(memberId);
    for (const [id, c] of this.collections) {
      const { [memberId]: _gone, ...rest } = c.access;
      this.collections.set(id, { ...c, access: rest });
    }
  }

  addCollection(by: string, id: string, encryptedName: string, access: Readonly<Record<string, Access>> = {}): Collection {
    this.actor(by, 'owner', 'admin', 'manager');
    if (this.collections.has(id)) throw new VaultError('that collection id is taken');
    for (const mid of Object.keys(access)) if (!this.members.has(mid)) throw new VaultError(`${mid} is not a member`);
    const c: Collection = { id, name: encryptedName, access };
    this.collections.set(id, c);
    return c;
  }

  setAccess(by: string, collectionId: string, memberId: string, a: Access | null): void {
    const actor = this.actor(by, 'owner', 'admin', 'manager');
    const c = this.collections.get(collectionId);
    if (!c) throw new VaultError('there is no such collection');
    if (!this.members.has(memberId)) throw new VaultError(`${memberId} is not a member`);
    if (actor.role === 'manager' && !c.access[by]?.manage) throw new VaultError('a manager manages only the collections they have manage rights to');
    const { [memberId]: _old, ...rest } = c.access;
    this.collections.set(collectionId, { ...c, access: a ? { ...rest, [memberId]: a } : rest });
  }

  collection(id: string): Collection | undefined {
    return this.collections.get(id);
  }

  /** What a member may do with an item in these collections: the most generous of their rights, owners and admins everything. */
  view(memberId: string, collectionIds: readonly string[]): OrgView {
    const m = this.members.get(memberId);
    const none = { read: false, write: false, seePasswords: false, manage: false };
    if (!m || m.status !== 'confirmed') return none;
    if (m.role === 'owner' || m.role === 'admin') return { read: true, write: true, seePasswords: true, manage: true };
    const mine = collectionIds.map((c) => this.collections.get(c)?.access[memberId]).filter((a): a is Access => !!a);
    if (!mine.length) return none;
    return { read: true, write: mine.some((a) => !a.readOnly), seePasswords: mine.some((a) => !a.hidePasswords), manage: mine.some((a) => a.manage) };
  }

  /** The items a member can open at all. */
  visible(memberId: string, items: readonly EncryptedItem[]): EncryptedItem[] {
    return items.filter((i) => i.organizationId === this.id && this.view(memberId, i.collectionIds).read);
  }

  /** Items with the passwords left out for people who may not see them. */
  redactFor(memberId: string, item: EncryptedItem): EncryptedItem {
    const v = this.view(memberId, item.collectionIds);
    if (!v.read) throw new VaultError('that item is not shared with you');
    if (v.seePasswords) return item;
    const { key: _key, ...rest } = item;
    void _key;
    return { ...rest, ...(item.login ? { login: { ...item.login, password: undefined as never, totp: undefined as never } } : {}), ...(item.card ? { card: { ...item.card, number: undefined as never, code: undefined as never } } : {}) };
  }

  /**
   * A new organisation key, everyone confirmed handed it, and the items re-wrapped. Do this when someone who knew
   * the old key must no longer be able to read anything added from now on (they could still have copied the old data).
   */
  rotateKey(by: string, oldKey: SymKey, items: readonly EncryptedItem[], random: Random = defaultRandom): { newKey: SymKey; items: EncryptedItem[] } {
    this.actor(by, 'owner', 'admin');
    const newKey = symKey(random(64));
    for (const m of this.members.values()) {
      if (m.status === 'confirmed' && m.publicKey) this.members.set(m.id, { ...m, key: rsaWrap(Buffer.from(m.publicKey, 'base64'), keyBytes(newKey)) });
    }
    this.keyVersion++;
    return { newKey, items: items.map((i) => (i.organizationId === this.id ? rekeyItem(i, oldKey, newKey, { random }) : i)) };
  }
}

// ================================================================ send

export interface SendRecord {
  readonly id: string;
  readonly type: 'text' | 'file';
  /** The 16-byte link secret, wrapped by the owner's user key, so the owner can show the link again. */
  readonly key: string;
  readonly name: string;
  readonly text?: string;
  readonly maxAccessCount: number | null;
  readonly accessCount: number;
  readonly expiresAt: number | null;
  readonly deleteAt: number;
  readonly disabled: boolean;
  readonly hideEmail: boolean;
  readonly password: ServerAuth | null;
}

const sendKey = (secret: Uint8Array): SymKey => symKey(Buffer.from(hkdfSync('sha256', secret, 'bitwarden-send', 'send', 64)));

export function createSend(o: { id: string; name: string; text: string; userKey: SymKey; now: number; deleteInDays: number; expiresInDays?: number; maxAccessCount?: number; password?: string; hideEmail?: boolean; random?: Random }): { send: SendRecord; urlKey: string } {
  const random = o.random ?? defaultRandom;
  if (!o.name.trim()) throw new VaultError('a send needs a name');
  if (!(o.deleteInDays > 0 && o.deleteInDays <= 31)) throw new VaultError('a send is deleted within 31 days');
  if (o.expiresInDays !== undefined && !(o.expiresInDays > 0 && o.expiresInDays <= o.deleteInDays)) throw new VaultError('a send cannot expire after it is deleted');
  if (o.maxAccessCount !== undefined && (!Number.isInteger(o.maxAccessCount) || o.maxAccessCount < 1)) throw new VaultError('the access count is a whole number from 1');
  if (o.password !== undefined && o.password.length < 4) throw new VaultError('a send password has at least 4 characters');
  const secret = random(16);
  const k = sendKey(secret);
  const send: SendRecord = {
    id: o.id, type: 'text', key: encString(secret, o.userKey, random), name: encString(o.name, k, random), text: encString(o.text, k, random),
    maxAccessCount: o.maxAccessCount ?? null, accessCount: 0, expiresAt: o.expiresInDays === undefined ? null : o.now + o.expiresInDays * DAY, deleteAt: o.now + o.deleteInDays * DAY,
    disabled: false, hideEmail: o.hideEmail ?? false, password: o.password === undefined ? null : storeAuth(authHash(Buffer.from(o.password), o.password), random, 100_000),
  };
  return { send, urlKey: secret.toString('base64url') };
}

/** The server's side of an access: the rules, the count, and the ciphertext; it never sees the link secret. */
export function accessSend(send: SendRecord, now: number, password?: string): { send: SendRecord; payload: { name: string; text: string } } {
  if (send.disabled) throw new VaultError('this send is not available');
  if (now >= send.deleteAt) throw new VaultError('this send is not available');
  if (send.expiresAt !== null && now >= send.expiresAt) throw new VaultError('this send is not available');
  if (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount) throw new VaultError('this send is not available');
  if (send.password && (password === undefined || !verifyAuth(authHash(Buffer.from(password), password), send.password))) throw new VaultError('this send needs its password');
  return { send: { ...send, accessCount: send.accessCount + 1 }, payload: { name: send.name, text: send.text! } };
}

/** The recipient's side: the link's secret opens what the server relayed. */
export function openSend(payload: { name: string; text: string }, urlKey: string): { name: string; text: string } {
  if (!/^[A-Za-z0-9_-]{22}$/.test(urlKey)) throw new VaultError('that link is not a send link');
  const k = sendKey(Buffer.from(urlKey, 'base64url'));
  return { name: decString(payload.name, k), text: decString(payload.text, k) };
}

// ================================================================ emergency access

export type EmergencyStatus = 'invited' | 'accepted' | 'confirmed' | 'initiated' | 'approved' | 'rejected';

export interface EmergencyRecord {
  readonly grantor: string;
  readonly granteeEmail: string;
  readonly type: 'view' | 'takeover';
  readonly waitDays: number;
  readonly status: EmergencyStatus;
  readonly granteePublicKey?: string;
  /** The grantor's user key sealed to the grantee's public key (set on confirmation). */
  readonly keyEncrypted?: string;
  readonly initiatedAt?: number;
}

export function inviteEmergency(grantor: string, granteeEmail: string, type: 'view' | 'takeover', waitDays: number): EmergencyRecord {
  if (!Number.isInteger(waitDays) || waitDays < 1 || waitDays > 90) throw new VaultError('the waiting time is 1 to 90 days');
  if (!granteeEmail.includes('@')) throw new VaultError('the contact needs an email address');
  return { grantor, granteeEmail: normEmail(granteeEmail), type, waitDays, status: 'invited' };
}

export function acceptEmergency(r: EmergencyRecord, publicKey: Uint8Array): EmergencyRecord {
  if (r.status !== 'invited') throw new VaultError('there is no open invitation');
  return { ...r, status: 'accepted', granteePublicKey: Buffer.from(publicKey).toString('base64') };
}

/** The grantor, who is unlocked, seals their user key to the contact after checking the contact's fingerprint. */
export function confirmEmergency(r: EmergencyRecord, grantorKey: SymKey, granteeId: string, expectedFingerprint: string): EmergencyRecord {
  if (r.status !== 'accepted' || !r.granteePublicKey) throw new VaultError('the contact has not accepted');
  const pub = Buffer.from(r.granteePublicKey, 'base64');
  if (fingerprint(pub, granteeId) !== expectedFingerprint) throw new VaultError('the fingerprint does not match the key the contact gave; do not confirm');
  return { ...r, status: 'confirmed', keyEncrypted: rsaWrap(pub, keyBytes(grantorKey)) };
}

export function initiateEmergency(r: EmergencyRecord, now: number): EmergencyRecord {
  if (r.status !== 'confirmed') throw new VaultError('emergency access has not been confirmed by the owner');
  return { ...r, status: 'initiated', initiatedAt: now };
}

export function decideEmergency(r: EmergencyRecord, approve: boolean): EmergencyRecord {
  if (r.status !== 'initiated') throw new VaultError('no request is waiting');
  return { ...r, status: approve ? 'approved' : 'rejected' };
}

/** The record as of `now`: a request nobody refused becomes approved when the wait ends. */
export function emergencyAt(r: EmergencyRecord, now: number): EmergencyRecord {
  return r.status === 'initiated' && r.initiatedAt !== undefined && now >= r.initiatedAt + r.waitDays * DAY ? { ...r, status: 'approved' } : r;
}

/** Days left in the wait, for the notice to the owner (0 once it is over). */
export const emergencyDaysLeft = (r: EmergencyRecord, now: number): number => (r.status === 'initiated' && r.initiatedAt !== undefined ? Math.max(0, Math.ceil((r.initiatedAt + r.waitDays * DAY - now) / DAY)) : 0);

/** The contact opens the owner's user key, only once access is approved. */
export function emergencyKey(r: EmergencyRecord, granteePrivateKey: Uint8Array, now: number): SymKey {
  const at = emergencyAt(r, now);
  if (at.status !== 'approved' || !at.keyEncrypted) throw new VaultError(at.status === 'initiated' ? `access is not yet granted; ${emergencyDaysLeft(at, now)} day(s) of the wait remain` : 'access has not been granted');
  return symKey(rsaUnwrap(granteePrivateKey, at.keyEncrypted));
}

/** Takeover: the contact, holding the owner's user key, sets a new master password for the owner's account. */
export function emergencyTakeover(r: EmergencyRecord, account: AccountRecord, granteePrivateKey: Uint8Array, newPassword: string, now: number, o: { kdf?: Kdf; allowWeakKdf?: boolean; random?: Random } = {}): AccountRecord {
  if (r.type !== 'takeover') throw new VaultError('this contact may view, not take over');
  const userKey = emergencyKey(r, granteePrivateKey, now);
  const priv = decBytes(account.privateKey, userKey);
  return changeMasterPassword(account, { userKey, privateKey: priv }, newPassword, o);
}
