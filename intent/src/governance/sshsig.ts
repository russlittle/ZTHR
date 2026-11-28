/**
 * SSH signatures (the SSHSIG format `ssh-keygen -Y sign` writes, and the one git writes into a signed commit),
 * verified in plain Node, so a person's act is checked the same way on any machine and in CI without ssh-keygen.
 *
 * Ed25519 keys and Ed25519 security keys (sk-ssh-ed25519@openssh.com) are accepted. A security-key signature must
 * carry the user-presence flag: the person touched the key. Every other key type is refused, never skipped.
 *
 *   person:  ssh-keygen -Y sign -n <namespace> -f ~/.ssh/id_ed25519 act.txt      writes act.txt.sig
 *   factory: verify(bytes of act.txt, contents of act.txt.sig, namespace, the person's listed keys)
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

export const ED25519 = 'ssh-ed25519';
export const SK_ED25519 = 'sk-ssh-ed25519@openssh.com';

export interface PublicKey {
  readonly type: typeof ED25519 | typeof SK_ED25519;
  /** The raw 32-byte Ed25519 key. */
  readonly raw: Buffer;
  /** For a security key: the application it was made for (usually "ssh:"). */
  readonly application?: string;
  /** The key's wire blob, as it appears in a signature. */
  readonly blob: Buffer;
  /** SHA256:… as ssh-keygen -l prints it. */
  readonly fingerprint: string;
}

class Reader {
  private at = 0;
  private readonly b: Buffer;
  constructor(b: Buffer) {
    this.b = b;
  }
  bytes(n: number): Buffer {
    if (this.at + n > this.b.length) throw new Error('truncated');
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u32(): number {
    return this.bytes(4).readUInt32BE(0);
  }
  u8(): number {
    return this.bytes(1)[0]!;
  }
  string(): Buffer {
    return this.bytes(this.u32());
  }
  get done(): boolean {
    return this.at === this.b.length;
  }
}

export const sshString = (b: Buffer | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(v.length);
  return Buffer.concat([len, v]);
};

const fingerprint = (blob: Buffer) => `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;

/** Read a key from its wire blob. Null for any type this verifier does not accept. */
export function keyFromBlob(blob: Buffer): PublicKey | null {
  try {
    const r = new Reader(blob);
    const type = r.string().toString();
    if (type !== ED25519 && type !== SK_ED25519) return null;
    const raw = Buffer.from(r.string());
    if (raw.length !== 32) return null;
    const application = type === SK_ED25519 ? r.string().toString() : undefined;
    if (!r.done) return null;
    return { type, raw, blob: Buffer.from(blob), fingerprint: fingerprint(blob), ...(application !== undefined ? { application } : {}) };
  } catch {
    return null;
  }
}

/** Read a key from an authorized_keys-style line: `ssh-ed25519 AAAA… comment`. Null when it is not one. */
export function parseKey(line: string): PublicKey | null {
  const m = /^\s*(ssh-ed25519|sk-ssh-ed25519@openssh\.com)\s+([A-Za-z0-9+/=]+)/.exec(line);
  if (!m) return null;
  const k = keyFromBlob(Buffer.from(m[2]!, 'base64'));
  return k && k.type === m[1] ? k : null;
}

export const keyLine = (k: PublicKey, comment = ''): string => `${k.type} ${k.blob.toString('base64')}${comment ? ` ${comment}` : ''}`;

const edKey = (raw: Buffer) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });

export interface Armored {
  readonly key: PublicKey | null;
  readonly keyType: string;
  readonly namespace: string;
  readonly reserved: Buffer;
  readonly hash: string;
  readonly signature: Buffer;
}

/** Unwrap -----BEGIN SSH SIGNATURE----- … -----END SSH SIGNATURE-----. Throws on anything malformed. */
export function unarmor(text: string): Armored {
  const m = /-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(text);
  if (!m) throw new Error('not an SSH signature');
  const blob = Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64');
  const r = new Reader(blob);
  if (r.bytes(6).toString() !== 'SSHSIG') throw new Error('not an SSHSIG blob');
  if (r.u32() !== 1) throw new Error('unknown SSHSIG version');
  const kb = r.string();
  const keyType = new Reader(kb).string().toString();
  const namespace = r.string().toString();
  const reserved = Buffer.from(r.string());
  const hash = r.string().toString();
  const signature = Buffer.from(r.string());
  if (!r.done) throw new Error('trailing bytes after the signature');
  return { key: keyFromBlob(kb), keyType, namespace, reserved, hash, signature };
}

/** The bytes an SSHSIG signature is made over. */
export function signedData(namespace: string, hash: 'sha256' | 'sha512', message: Buffer | string, reserved: Buffer = Buffer.alloc(0)): Buffer {
  const h = createHash(hash).update(typeof message === 'string' ? Buffer.from(message) : message).digest();
  return Buffer.concat([Buffer.from('SSHSIG'), sshString(namespace), sshString(reserved), sshString(hash), sshString(h)]);
}

export type Verdict = { readonly ok: true; readonly key: PublicKey } | { readonly ok: false; readonly why: string };

/**
 * Whether `armored` is a good signature over `message` in `namespace`, by one of `allowed`. Fails closed: an unknown
 * key type, another namespace, a key not listed, a security key without user presence, or any parse error is a no.
 */
export function verify(message: Buffer | string, armored: string, namespace: string, allowed: readonly PublicKey[]): Verdict {
  let a: Armored;
  try {
    a = unarmor(armored);
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
  if (!a.key) return { ok: false, why: `a ${a.keyType} key is not accepted: sign with an Ed25519 key or an Ed25519 security key` };
  if (a.namespace !== namespace) return { ok: false, why: `signed for "${a.namespace}", not "${namespace}"` };
  if (a.hash !== 'sha256' && a.hash !== 'sha512') return { ok: false, why: `hash ${a.hash} is not accepted` };
  const key = allowed.find((k) => k.blob.equals(a.key!.blob));
  if (!key) return { ok: false, why: `signed by ${a.key.fingerprint}, which is not a listed key` };
  const data = signedData(namespace, a.hash, message, a.reserved);
  try {
    const s = new Reader(a.signature);
    const sigType = s.string().toString();
    if (sigType !== key.type) return { ok: false, why: `a ${sigType} signature from a ${key.type} key` };
    const sig = s.string();
    if (key.type === ED25519) {
      if (!s.done) return { ok: false, why: 'trailing bytes in the signature' };
      return edVerify(null, data, edKey(key.raw), sig) ? { ok: true, key } : { ok: false, why: 'the signature does not match what was signed' };
    }
    const flags = s.u8();
    const counter = s.bytes(4);
    if (!s.done) return { ok: false, why: 'trailing bytes in the signature' };
    if ((flags & 0x01) === 0) return { ok: false, why: 'the security key was not touched (no user presence)' };
    const app = createHash('sha256').update(key.application ?? '').digest();
    const inner = Buffer.concat([app, Buffer.from([flags]), counter, createHash('sha256').update(data).digest()]);
    return edVerify(null, inner, edKey(key.raw), sig) ? { ok: true, key } : { ok: false, why: 'the signature does not match what was signed' };
  } catch (e) {
    return { ok: false, why: `malformed signature: ${(e as Error).message}` };
  }
}

/** A git commit object split into what was signed and the signature git stored in its gpgsig header. */
export function commitSignature(raw: string): { payload: string; signature: string | null } {
  const end = raw.indexOf('\n\n');
  const head = end < 0 ? raw : raw.slice(0, end);
  const body = end < 0 ? '' : raw.slice(end);
  const lines = head.split('\n');
  const kept: string[] = [];
  let sig: string[] | null = null;
  let inSig = false;
  for (const line of lines) {
    if (line.startsWith('gpgsig ')) {
      sig = [line.slice(7)];
      inSig = true;
    } else if (inSig && line.startsWith(' ')) sig!.push(line.slice(1));
    else {
      inSig = false;
      kept.push(line);
    }
  }
  return { payload: `${kept.join('\n')}${body}`, signature: sig ? sig.join('\n') : null };
}
