import { DatabaseSync } from 'node:sqlite';

/**
 * The store block: a document store where every document has one owner, so a person's whole record can be
 * exported or deleted with one query each, and a schema declaration that says what every field is and how
 * sensitive it is. The data-model docs, the ERDs and the sensitive-data trace are all generated from the declaration.
 */
export class DocStore {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL, id TEXT NOT NULL, student_id TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (collection, id));
      CREATE INDEX IF NOT EXISTS docs_student ON docs(student_id, collection);`);
  }

  put<T>(collection: string, id: string, owner: string, doc: T): T {
    this.db.prepare('INSERT OR REPLACE INTO docs (collection, id, student_id, json) VALUES (?, ?, ?, ?)').run(collection, id, owner, JSON.stringify(doc));
    return doc;
  }

  get<T>(collection: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT json FROM docs WHERE collection = ? AND id = ?').get(collection, id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  list<T>(collection: string, owner: string): T[] {
    return (this.db.prepare('SELECT json FROM docs WHERE collection = ? AND student_id = ? ORDER BY rowid').all(collection, owner) as { json: string }[]).map((r) => JSON.parse(r.json) as T);
  }

  remove(collection: string, id: string): void {
    this.db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, id);
  }

  /** Every document the owner has, grouped by collection. */
  exportStudent(owner: string): Record<string, unknown[]> {
    const rows = this.db.prepare('SELECT collection, json FROM docs WHERE student_id = ? ORDER BY collection, rowid').all(owner) as { collection: string; json: string }[];
    const out: Record<string, unknown[]> = {};
    for (const r of rows) (out[r.collection] ??= []).push(JSON.parse(r.json));
    return out;
  }

  /** Deletes every document the owner has and says how many went. */
  deleteStudent(owner: string): number {
    return Number(this.db.prepare('DELETE FROM docs WHERE student_id = ?').run(owner).changes);
  }

  countFor(owner: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE student_id = ?').get(owner) as { n: number }).n);
  }

  /** Every stored document as text, for scanning (the sensitive-data trace reads this). */
  dump(): string {
    return (this.db.prepare('SELECT collection, json FROM docs ORDER BY collection, rowid').all() as { collection: string; json: string }[]).map((r) => `${r.collection}\t${r.json}`).join('\n');
  }
}

// ------------------------------------------------------------------ declaration

/**
 * How sensitive a field is. Ordered from least to most.
 *  - public: published facts anyone may read (a bus stop, a dining hall's hours)
 *  - internal: ids, timestamps and settings that say nothing about the person on their own
 *  - personal: identifies or describes the person (name, phone, zip, schedule)
 *  - sensitive: special-category facts: health, disability, money, benefits, family, immigration, justice history
 *  - secret: credentials and keys; stored only hashed or encrypted, never shown
 */
export const CLASSES = ['public', 'internal', 'personal', 'sensitive', 'secret'] as const;
export type DataClass = (typeof CLASSES)[number];
export const rank = (c: DataClass): number => CLASSES.indexOf(c);
export const atLeast = (c: DataClass, floor: DataClass): boolean => rank(c) >= rank(floor);

export interface FieldDef {
  name: string;
  type: string;
  note?: string;
  optional?: boolean;
  /** How sensitive the value is. Undeclared fields fail the classification check. */
  cls?: DataClass;
}

export interface CollectionDef {
  name: string;
  purpose: string;
  key: string;
  fields: FieldDef[];
  /** Other collections this one points at: [target, label, cardinality as in Mermaid, e.g. "||--o{"]. */
  relations?: [string, string, string][];
  /** Kept only as long as needed; not part of the lasting record. */
  transient?: boolean;
  group?: string;
}

export const field = (name: string, type: string, cls: DataClass, note?: string, optional = false): FieldDef => ({ name, type, cls, note, optional });

/** The most sensitive class of any field in the collection. */
export function collectionClass(c: CollectionDef): DataClass {
  return c.fields.reduce<DataClass>((m, f) => (f.cls && rank(f.cls) > rank(m) ? f.cls : m), 'public');
}

/** Fields with no class, as "collection.field". */
export function unclassified(cs: CollectionDef[]): string[] {
  return cs.flatMap((c) => c.fields.filter((f) => !f.cls || !CLASSES.includes(f.cls)).map((f) => `${c.name}.${f.name}`));
}

const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
const typeWord = (t: string) => ident(t.split(/[ ,]/)[0]!.replace(/\[\]$/, '_list')) || 'value';

/** A Mermaid ERD of the collections. Each field's class is shown as its comment, so the picture shows sensitivity too. */
export function erd(cs: CollectionDef[], opts: { showClass?: boolean } = {}): string {
  const names = new Set(cs.map((c) => c.name));
  const lines = ['erDiagram'];
  for (const c of cs) {
    lines.push(`  ${ident(c.name)} {`);
    for (const f of c.fields) {
      const note = opts.showClass && f.cls ? f.cls : (f.note ?? '').replace(/"/g, "'").slice(0, 40);
      lines.push(`    ${typeWord(f.type)} ${ident(f.name)}${f.name === c.key || f.name === 'id' ? ' PK' : ''}${note ? ` "${note}"` : ''}`);
    }
    lines.push('  }');
  }
  for (const c of cs) for (const [target, label, card] of c.relations ?? []) if (names.has(target)) lines.push(`  ${ident(c.name)} ${card} ${ident(target)} : "${label.replace(/"/g, "'")}"`);
  return lines.join('\n');
}
