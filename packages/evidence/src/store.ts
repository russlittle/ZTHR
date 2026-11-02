import { DatabaseSync } from 'node:sqlite';

/**
 * One append-only evidence store fed by every kit. Rows cannot be updated or
 * deleted: triggers abort any attempt, so a measure can always be recomputed
 * from what actually happened.
 */
export interface EvidenceEvent {
  id: number;
  at: string;
  kind: string;
  subject: string;
  data: Record<string, unknown>;
}

export interface ModelCall {
  at?: string;
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  candidate?: string;
  studentMonth?: string;
}

export interface Price {
  model: string;
  effectiveFrom: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, at);
CREATE TABLE IF NOT EXISTS model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  candidate TEXT,
  student_month TEXT
);
CREATE TABLE IF NOT EXISTS prices (
  model TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  input_per_mtok REAL NOT NULL,
  output_per_mtok REAL NOT NULL,
  cached_per_mtok REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (model, effective_from)
);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS calls_no_update BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS calls_no_delete BEFORE DELETE ON model_calls BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
`;

export class EvidenceStore {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  append(kind: string, subject: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): number {
    const r = this.db
      .prepare('INSERT INTO events (at, kind, subject, data) VALUES (?, ?, ?, ?)')
      .run(at, kind, subject, JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }

  events(kind?: string): EvidenceEvent[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind)
      : this.db.prepare('SELECT * FROM events ORDER BY id').all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      kind: String(r.kind),
      subject: String(r.subject),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    }));
  }

  recordModelCall(c: ModelCall): void {
    this.db
      .prepare(
        `INSERT INTO model_calls (at, provider, model, purpose, input_tokens, output_tokens, cached_tokens, candidate, student_month)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.at ?? new Date().toISOString(),
        c.provider,
        c.model,
        c.purpose,
        c.inputTokens,
        c.outputTokens,
        c.cachedTokens ?? 0,
        c.candidate ?? null,
        c.studentMonth ?? null,
      );
  }

  modelCalls(): Required<ModelCall>[] {
    const rows = this.db.prepare('SELECT * FROM model_calls ORDER BY id').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      at: String(r.at),
      provider: String(r.provider),
      model: String(r.model),
      purpose: String(r.purpose),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cachedTokens: Number(r.cached_tokens),
      candidate: r.candidate == null ? '' : String(r.candidate),
      studentMonth: r.student_month == null ? '' : String(r.student_month),
    }));
  }

  setPrice(p: Price): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO prices (model, effective_from, input_per_mtok, output_per_mtok, cached_per_mtok) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.model, p.effectiveFrom, p.inputPerMTok, p.outputPerMTok, p.cachedPerMTok ?? 0);
  }

  prices(): Price[] {
    const rows = this.db.prepare('SELECT * FROM prices ORDER BY model, effective_from').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      model: String(r.model),
      effectiveFrom: String(r.effective_from),
      inputPerMTok: Number(r.input_per_mtok),
      outputPerMTok: Number(r.output_per_mtok),
      cachedPerMTok: Number(r.cached_per_mtok),
    }));
  }

  close(): void {
    this.db.close();
  }
}
