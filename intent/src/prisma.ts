/**
 * Prisma, both ways. The information schema is written out as a Prisma schema, the one data declaration the build's
 * store works from; and a Prisma schema a team already has can be brought in, so the intent starts from the records
 * that exist rather than describing them again. What comes in is kept as provided: its fields, types and relations win
 * over the patterns, and every field says it was provided.
 */
import type { Field, FieldType, Schema } from './schema.ts';

export interface ProvidedField {
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly states?: readonly string[];
  readonly meaning?: string;
  /** For a reference: the model it points to, by its Prisma name. */
  readonly to?: string;
  readonly line: number;
}
export interface ProvidedEntity {
  readonly model: string;
  readonly name: string;
  readonly key: string;
  readonly meaning?: string;
  readonly fields: readonly ProvidedField[];
  readonly line: number;
}

const snake = (t: string) => t.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const words = (pascal: string) => {
  const w = pascal.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const pascal = (t: string) => t.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const camel = (t: string) => {
  const p = pascal(t);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const ident = (t: string) => t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1');

// ---------------------------------------------------------------- in

export function parsePrisma(text: string): ProvidedEntity[] {
  const lines = text.split('\n');
  const enums = new Map<string, string[]>();
  const blocks: { kind: 'model' | 'enum'; name: string; start: number; body: { text: string; line: number; doc: string }[]; doc: string }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  let doc: string[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith('///')) {
      doc.push(t.slice(3).trim());
      return;
    }
    const clean = t.replace(/\s\/\/.*$/, '').replace(/^\/\/.*$/, '').trim();
    if (!cur) {
      const m = /^(model|enum)\s+(\w+)\s*\{$/.exec(clean);
      if (m) {
        cur = { kind: m[1] as 'model' | 'enum', name: m[2]!, start: i + 1, body: [], doc: doc.join(' ') };
        blocks.push(cur);
      }
      doc = [];
      return;
    }
    if (clean === '}') {
      cur = null;
      doc = [];
      return;
    }
    if (clean) cur.body.push({ text: clean, line: i + 1, doc: doc.join(' ') });
    doc = [];
  });
  for (const b of blocks.filter((x) => x.kind === 'enum'))
    enums.set(b.name, b.body.filter((l) => !l.text.startsWith('@@')).map((l) => /@map\("([^"]+)"\)/.exec(l.text)?.[1] ?? l.text.split(/\s+/)[0]!));
  const models = new Set(blocks.filter((x) => x.kind === 'model').map((x) => x.name));

  return blocks
    .filter((b) => b.kind === 'model')
    .map((b) => {
      const table = /@@map\("([^"]+)"\)/.exec(b.body.map((l) => l.text).join('\n'))?.[1] ?? snake(b.name);
      const parsed = b.body
        .filter((l) => !l.text.startsWith('@@'))
        .map((l) => {
          const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(l.text);
          return m ? { name: m[1]!, type: m[2]!, list: !!m[3], optional: !!m[4], attrs: m[5] ?? '', line: l.line, doc: l.doc } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      // A relation names the scalar that holds the key; that scalar is the reference, the relation field is not a column.
      const holders = new Map<string, string>();
      for (const f of parsed) {
        const rel = /@relation\([^)]*fields:\s*\[\s*(\w+)\s*\]/.exec(f.attrs);
        if (models.has(f.type) && !f.list && rel) holders.set(rel[1]!, f.type);
      }
      const fields: ProvidedField[] = [];
      for (const f of parsed) {
        if (f.list || models.has(f.type)) continue;
        const key = /@map\("([^"]+)"\)/.exec(f.attrs)?.[1] ?? (/@id\b/.test(f.attrs) ? 'id' : snake(f.name));
        const to = holders.get(f.name);
        const lower = f.name.toLowerCase();
        const type: FieldType = /@id\b/.test(f.attrs)
          ? 'id'
          : to
            ? `ref:${to}`
            : enums.has(f.type)
              ? 'state'
              : f.type === 'Decimal'
                ? 'money'
                : f.type === 'Int' || f.type === 'BigInt'
                  ? 'integer'
                  : f.type === 'Float'
                    ? /amount|balance|price|cost|fee|total/.test(lower) ? 'money' : 'integer'
                    : f.type === 'Boolean'
                      ? 'boolean'
                      : f.type === 'DateTime'
                        ? /@db\.Date\b/.test(f.attrs) || /date|due|day|birth/.test(lower) && !/at$/.test(lower) ? 'date' : 'timestamp'
                        : /email/.test(lower)
                          ? 'email'
                          : /phone|mobile/.test(lower)
                            ? 'phone'
                            : 'text';
        const name = key === 'id' ? 'id' : key.replace(/_id$/, '').replace(/_/g, ' ');
        fields.push({ key, name, type, required: !f.optional, ...(enums.has(f.type) ? { states: enums.get(f.type)! } : {}), ...(f.doc ? { meaning: f.doc.replace(/\s*(Sensitivity|Sensitive):.*$/i, '').replace(/\.$/, '') } : {}), ...(to ? { to } : {}), line: f.line });
      }
      return { model: b.name, name: words(b.name), key: table, ...(b.doc ? { meaning: b.doc } : {}), fields, line: b.start };
    });
}

// ---------------------------------------------------------------- out

export function toPrisma(s: Schema): string {
  const model = new Map(s.entities.map((e) => [e.key, pascal(e.name)]));
  const enums: string[] = [];
  const back = new Map<string, string[]>();
  const relName = (from: string, field: string) => `${model.get(from)}_${camel(field)}`;
  for (const r of s.relations) back.set(r.to, [...(back.get(r.to) ?? []), `  ${camel(`${model.get(r.from)} ${r.field}`)} ${model.get(r.from)}[] @relation("${relName(r.from, r.field)}")`]);
  const field = (e: (typeof s.entities)[number], f: Field): string[] => {
    const doc = `  /// ${f.meaning}. Sensitivity: ${f.sensitivity}.${f.from === 'your words' ? ` Your words, line ${f.line}.` : f.from === 'provided' ? ` Provided, line ${f.line}.` : ''}`;
    const opt = f.required ? '' : '?';
    const map = (name: string) => (name === f.key ? '' : ` @map("${f.key}")`);
    if (f.key === 'id') return [doc, `  id String @id @default(cuid())`];
    if (f.type.startsWith('ref:')) {
      const r = s.relations.find((x) => x.from === e.key && x.field === f.key)!;
      const scalar = camel(`${f.key} id`);
      return [doc, `  ${scalar} String${opt}${map(scalar)}`, `  ${camel(f.key)}Ref ${model.get(r.to)}${opt} @relation("${relName(e.key, f.key)}", fields: [${scalar}], references: [id])`];
    }
    const name = camel(f.key);
    if (f.type === 'state' && f.states?.length) {
      const en = `${model.get(e.key)}${pascal(f.key)}`;
      enums.push(`/// The allowed ${f.name} of a ${e.name.toLowerCase()}.\nenum ${en} {\n${f.states.map((v) => `  ${ident(v)}${ident(v) === v ? '' : ` @map("${v}")`}`).join('\n')}\n}`);
      return [doc, `  ${name} ${en}${opt}${map(name)}`];
    }
    const t = f.type === 'money' ? 'Decimal' : f.type === 'integer' ? 'Int' : f.type === 'boolean' ? 'Boolean' : f.type === 'date' || f.type === 'timestamp' ? 'DateTime' : 'String';
    const db = f.type === 'money' ? ' @db.Decimal(12, 2)' : f.type === 'date' ? ' @db.Date' : '';
    return [doc, `  ${name} ${t}${opt}${map(name)}${db}`];
  };
  const models = s.entities.map((e) => `/// ${e.name}: ${e.what} Kept ${e.retention}. ${e.maintainedBy === 'fleet' ? 'A fleet pattern.' : 'Yours.'}\nmodel ${model.get(e.key)} {\n${[...e.fields.flatMap((f) => field(e, f)), ...(back.get(e.key) ?? [])].join('\n')}\n\n  @@map("${e.key}")\n}`);
  return `// The information schema as Prisma (the Prisma 7 schema language, which Prisma 8 also reads): the build's one data\n// declaration. Generated from the signed schematic.\n// Schema ${s.hash.slice(0, 12)}. Change the intent, not this file.\n\ngenerator client {\n  provider = "prisma-client"\n  output   = "../generated/prisma"\n}\n\n// The connection is set in prisma.config.ts where the app runs, never here.\ndatasource db {\n  provider = "postgresql"\n}\n\n${models.join('\n\n')}\n\n${enums.join('\n\n')}\n`;
}
