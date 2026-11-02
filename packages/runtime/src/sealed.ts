import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ConsentLedger } from './ledger.js';

/**
 * Sealed facts (PRD P10). Each student has a data key, wrapped by a master
 * key (a cloud KMS key in production, a local key in tests). A sealed fact can
 * be opened only by an identity the student granted for that fact, and every
 * opening is written to the consent ledger.
 */
const ALG = 'aes-256-gcm';

function encrypt(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

function decrypt(key: Buffer, blob: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv(ALG, key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export interface SealedRecord {
  wrappedKey: string;
  facts: Record<string, string>;
  grants: Record<string, string[]>; // fact -> identities allowed to open it
}

export class SealedStore {
  private readonly records = new Map<string, SealedRecord>();

  constructor(private readonly masterKey: Buffer, private readonly ledger: ConsentLedger) {
    if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  }

  private dataKey(studentId: string): Buffer {
    let r = this.records.get(studentId);
    if (!r) {
      r = { wrappedKey: encrypt(this.masterKey, randomBytes(32)), facts: {}, grants: {} };
      this.records.set(studentId, r);
    }
    return decrypt(this.masterKey, r.wrappedKey);
  }

  /** Only the student puts a fact in. */
  seal(studentId: string, fact: string, value: string): void {
    const key = this.dataKey(studentId);
    const r = this.records.get(studentId)!;
    r.facts[fact] = encrypt(key, Buffer.from(value, 'utf8'));
    this.ledger.append(studentId, 'grant', `sealed:${fact}`, { action: 'sealed' });
  }

  grant(studentId: string, fact: string, identity: string): void {
    const r = this.records.get(studentId);
    if (!r?.facts[fact]) throw new Error(`no sealed fact ${fact}`);
    r.grants[fact] = [...new Set([...(r.grants[fact] ?? []), identity])];
    this.ledger.append(studentId, 'grant', `sealed:${fact}`, { identity });
  }

  revoke(studentId: string, fact: string, identity: string): void {
    const r = this.records.get(studentId);
    if (!r) return;
    r.grants[fact] = (r.grants[fact] ?? []).filter((i) => i !== identity);
    this.ledger.append(studentId, 'revoke', `sealed:${fact}`, { identity });
  }

  has(studentId: string, fact: string): boolean {
    return !!this.records.get(studentId)?.facts[fact];
  }

  /** Throws unless the identity was granted this fact. Every successful open is logged. */
  open(studentId: string, fact: string, identity: string, purpose: string): string {
    const r = this.records.get(studentId);
    const blob = r?.facts[fact];
    if (!r || !blob) throw new Error(`no sealed fact ${fact}`);
    if (!(r.grants[fact] ?? []).includes(identity)) throw new Error(`${identity} is not granted ${fact}`);
    const value = decrypt(this.dataKey(studentId), blob).toString('utf8');
    this.ledger.append(studentId, 'release', `sealed:${fact}`, { identity, purpose });
    return value;
  }

  /** Raw stored form, for tests proving nothing is stored in the clear. */
  raw(studentId: string): SealedRecord | undefined {
    return this.records.get(studentId);
  }

  remove(studentId: string, fact: string): void {
    const r = this.records.get(studentId);
    if (r) {
      delete r.facts[fact];
      delete r.grants[fact];
      this.ledger.append(studentId, 'delete', `sealed:${fact}`, {});
    }
  }

  forget(studentId: string): void {
    this.records.delete(studentId);
    this.ledger.append(studentId, 'delete', 'sealed:*', {});
  }
}
