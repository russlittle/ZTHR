import { DatabaseSync } from 'node:sqlite';
import { sha256, stableStringify } from '@zthr/gates';

/**
 * Consent ledger: every grant, revocation, sealed-fact release, approval and
 * share, as an append-only, hash-chained record the student can read.
 */
export interface LedgerEntry {
  seq: number;
  at: string;
  studentId: string;
  kind: 'grant' | 'revoke' | 'release' | 'approve' | 'share' | 'delete' | 'export';
  subject: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export class ConsentLedger {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consent (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, student_id TEXT NOT NULL, kind TEXT NOT NULL,
        subject TEXT NOT NULL, detail TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS consent_no_update BEFORE UPDATE ON consent BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS consent_no_delete BEFORE DELETE ON consent BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    `);
  }

  /** Every row, hashes and all, for a test snapshot. */
  dump(): Record<string, string | number>[] {
    return this.db.prepare('SELECT * FROM consent ORDER BY seq').all() as Record<string, string | number>[];
  }

  /** Load rows from a snapshot into an empty ledger. */
  load(rows: Record<string, string | number>[]): void {
    const ins = this.db.prepare('INSERT INTO consent (seq, at, student_id, kind, subject, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.seq!, r.at!, r.student_id!, r.kind!, r.subject!, r.detail!, r.prev_hash!, r.hash!);
  }

  /** Copy every entry, hashes and all, into an empty ledger (a fork for testing). */
  copyInto(other: ConsentLedger): void {
    other.load(this.dump());
  }

  private last(): { hash: string } | undefined {
    return this.db.prepare('SELECT hash FROM consent ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  }

  static entryHash(e: Omit<LedgerEntry, 'seq' | 'hash'>): string {
    return sha256(stableStringify(e));
  }

  append(studentId: string, kind: LedgerEntry['kind'], subject: string, detail: Record<string, unknown> = {}): LedgerEntry {
    const prevHash = this.last()?.hash ?? 'genesis';
    const at = new Date().toISOString();
    const body = { at, studentId, kind, subject, detail, prevHash };
    const hash = ConsentLedger.entryHash(body);
    const r = this.db
      .prepare('INSERT INTO consent (at, student_id, kind, subject, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(at, studentId, kind, subject, JSON.stringify(detail), prevHash, hash);
    return { seq: Number(r.lastInsertRowid), ...body, hash };
  }

  entries(studentId?: string): LedgerEntry[] {
    const rows = (studentId
      ? this.db.prepare('SELECT * FROM consent WHERE student_id = ? ORDER BY seq').all(studentId)
      : this.db.prepare('SELECT * FROM consent ORDER BY seq').all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      studentId: String(r.student_id),
      kind: String(r.kind) as LedgerEntry['kind'],
      subject: String(r.subject),
      detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
      prevHash: String(r.prev_hash),
      hash: String(r.hash),
    }));
  }

  /** Recompute the chain. Any edited or removed entry breaks it. */
  static verify(entries: LedgerEntry[]): { ok: true } | { ok: false; at: number } {
    let prev = 'genesis';
    for (const e of entries) {
      const { seq: _s, hash, ...body } = e;
      if (e.prevHash !== prev || ConsentLedger.entryHash(body) !== hash) return { ok: false, at: e.seq };
      prev = hash;
    }
    return { ok: true };
  }
}
