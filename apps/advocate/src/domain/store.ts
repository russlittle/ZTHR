import { DatabaseSync } from 'node:sqlite';

/**
 * Application store behind a small document interface (ADR 0001). Each
 * collection holds JSON documents keyed by id and owned by one student, so
 * export and deletion are a single query each.
 */
export class AppStore {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL, id TEXT NOT NULL, student_id TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (collection, id));
      CREATE INDEX IF NOT EXISTS docs_student ON docs(student_id, collection);`);
  }

  put<T>(collection: string, id: string, studentId: string, doc: T): T {
    this.db.prepare('INSERT OR REPLACE INTO docs (collection, id, student_id, json) VALUES (?, ?, ?, ?)').run(collection, id, studentId, JSON.stringify(doc));
    return doc;
  }

  get<T>(collection: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT json FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  list<T>(collection: string, studentId: string): T[] {
    return (this.db.prepare('SELECT json FROM docs WHERE collection = ? AND student_id = ? ORDER BY rowid').all(collection, studentId) as { json: string }[]).map((r) => JSON.parse(r.json) as T);
  }

  remove(collection: string, id: string): void {
    this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id);
  }

  exportStudent(studentId: string): Record<string, unknown[]> {
    const rows = this.db.prepare('SELECT collection, json FROM docs WHERE student_id = ? ORDER BY collection, rowid').all(studentId) as { collection: string; json: string }[];
    const out: Record<string, unknown[]> = {};
    for (const r of rows) (out[r.collection] ??= []).push(JSON.parse(r.json));
    return out;
  }

  deleteStudent(studentId: string): number {
    return Number(this.db.prepare('DELETE FROM docs WHERE student_id = ?').run(studentId).changes);
  }

  countFor(studentId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE student_id = ?').get(studentId) as { n: number }).n);
  }
}
