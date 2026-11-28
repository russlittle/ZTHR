/**
 * How records point at each other, kept honest. A schema declares the kinds of record and the relations between
 * them: a foreign key (belongs to), a one-to-one (a foreign key that must be unique), many-to-many through a link
 * table that can keep its order on either side (a post's categories in the order the author chose), and soft
 * references (a field that names another record by its slug, or a "type:id" that may point at several kinds) which
 * are followed when they resolve and reported when they do not, but never block anything. The store enforces the
 * hard ones as records change: a missing parent is refused, a one-to-one stays one-to-one, a tree (an `acyclic`
 * relation to the same kind) cannot be made into a loop, and a delete first makes a plan (what goes with it by
 * cascade, what is set to null, which links are removed, what blocks it, which soft references will dangle) and
 * applies it all or nothing. A scan finds what is already wrong in loaded data (orphans, dangling links, repeated
 * links, broken order, duplicate one-to-ones) and says how each would be repaired.
 *
 * Out of scope: persistence and queries beyond following relations; the store is in memory and `snapshot` and
 * `load` move the data in and out.
 */

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class Restricted extends IntegrityError {
  readonly blockers: readonly Blocker[];
  constructor(blockers: readonly Blocker[]) {
    super(`cannot delete: ${blockers.map((b) => `${b.type} ${b.id} still uses it through ${b.relation}`).join('; ')}`);
    this.blockers = blockers;
  }
}

export type OnDelete = 'cascade' | 'restrict' | 'set-null';

export interface BelongsTo {
  readonly kind: 'belongsTo' | 'oneToOne';
  readonly name: string;
  readonly from: string;
  readonly field: string;
  readonly to: string;
  readonly onDelete: OnDelete;
  /** A value is needed; false lets the field be null. */
  readonly required?: boolean;
  /** For a relation to the same kind: refuse a loop (a folder inside itself). */
  readonly acyclic?: boolean;
}

export interface ManyToMany {
  readonly kind: 'manyToMany';
  readonly name: string;
  readonly left: string;
  readonly right: string;
  /** Which side keeps its links in order: the left record's list of rights, the right's list of lefts, or both. */
  readonly ordered?: 'left' | 'right' | 'both';
}

export interface Soft {
  readonly kind: 'soft';
  readonly name: string;
  readonly from: string;
  readonly field: string;
  /** One or several kinds it may point at. */
  readonly to: readonly string[];
  /** Match on this field of the target (a slug) instead of its id. A "type:value" text names the kind too. */
  readonly toField?: string;
}

export type Relation = BelongsTo | ManyToMany | Soft;

export interface Schema {
  readonly types: readonly string[];
  readonly relations: readonly Relation[];
}

export type Row = { id: string } & Record<string, unknown>;

export interface Blocker {
  readonly type: string;
  readonly id: string;
  readonly relation: string;
}

export interface DeletePlan {
  readonly deletes: readonly { type: string; id: string }[];
  readonly nullify: readonly { type: string; id: string; field: string; relation: string }[];
  readonly unlink: readonly { relation: string; left: string; right: string }[];
  readonly blockers: readonly Blocker[];
  /** Rows that survive but hold a soft reference to something being deleted. */
  readonly dangling: readonly { type: string; id: string; field: string; relation: string }[];
}

export type FindingKind = 'dangling-fk' | 'dangling-link' | 'dangling-soft' | 'repeated-link' | 'bad-order' | 'not-unique' | 'unknown-type' | 'required-empty' | 'loop';

export interface Finding {
  readonly kind: FindingKind;
  readonly severity: 'error' | 'warning';
  readonly relation: string;
  readonly type: string;
  readonly id: string;
  readonly detail: string;
}

export type Repair =
  | { action: 'set-null'; type: string; id: string; field: string }
  | { action: 'delete-row'; type: string; id: string }
  | { action: 'delete-link'; relation: string; left: string; right: string }
  | { action: 'renumber'; relation: string }
  | { action: 'manual'; type: string; id: string; why: string };

interface Link {
  left: string;
  right: string;
  posL: number;
  posR: number;
}

export interface Snapshot {
  readonly rows: Readonly<Record<string, readonly Row[]>>;
  readonly links: Readonly<Record<string, readonly Link[]>>;
}

const isFk = (r: Relation): r is BelongsTo => r.kind === 'belongsTo' || r.kind === 'oneToOne';
const own = (o: object, k: string): unknown => (Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const safeName = (s: string) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s);

/** Checks a schema before anything uses it: every kind exists, names are unique, and no rule contradicts itself. */
export function checkSchema(s: Schema): string[] {
  const out: string[] = [];
  const types = new Set(s.types);
  if (types.size !== s.types.length) out.push('a kind of record is listed twice');
  for (const t of s.types) if (!safeName(t)) out.push(`"${t}" is not a usable name for a kind of record`);
  const names = new Set<string>();
  for (const r of s.relations) {
    if (!safeName(r.name)) out.push(`"${r.name}" is not a usable relation name`);
    if (names.has(r.name)) out.push(`relation ${r.name} is declared twice`);
    names.add(r.name);
    const need = (t: string) => {
      if (!types.has(t)) out.push(`${r.name}: there is no kind "${t}"`);
    };
    if (isFk(r)) {
      need(r.from);
      need(r.to);
      if (!safeName(r.field)) out.push(`${r.name}: "${r.field}" is not a usable field name`);
      if (r.field === 'id') out.push(`${r.name}: a foreign key cannot be the id`);
      if (r.onDelete === 'set-null' && r.required) out.push(`${r.name}: a required reference cannot be set to null when its target goes`);
      if (r.acyclic && r.from !== r.to) out.push(`${r.name}: only a relation to the same kind can be acyclic`);
    } else if (r.kind === 'manyToMany') {
      need(r.left);
      need(r.right);
    } else {
      need(r.from);
      r.to.forEach(need);
      if (!r.to.length) out.push(`${r.name}: a soft reference needs at least one target kind`);
      if (!safeName(r.field)) out.push(`${r.name}: "${r.field}" is not a usable field name`);
    }
  }
  const fieldOf = new Set<string>();
  for (const r of s.relations) if (r.kind !== 'manyToMany') {
    const k = `${r.from}.${r.field}`;
    if (fieldOf.has(k)) out.push(`field ${k} is used by two relations`);
    fieldOf.add(k);
  }
  return out;
}

/** Kinds that delete each other in a ring by cascade, which is allowed but worth knowing about. */
export function cascadeLoops(s: Schema): string[][] {
  const edges = new Map<string, string[]>();
  for (const r of s.relations) if (isFk(r) && r.onDelete === 'cascade' && r.from !== r.to) edges.set(r.to, [...(edges.get(r.to) ?? []), r.from]);
  const loops: string[][] = [];
  const walk = (n: string, path: string[]) => {
    const i = path.indexOf(n);
    if (i >= 0) {
      loops.push([...path.slice(i), n]);
      return;
    }
    for (const m of edges.get(n) ?? []) walk(m, [...path, n]);
  };
  for (const n of [...edges.keys()].sort()) walk(n, []);
  const seen = new Set<string>();
  return loops.filter((l) => {
    const k = [...new Set(l)].sort().join('>');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class Store {
  readonly schema: Schema;
  private readonly rel = new Map<string, Relation>();
  private readonly rows = new Map<string, Map<string, Row>>();
  private readonly links = new Map<string, Link[]>();

  constructor(schema: Schema) {
    const problems = checkSchema(schema);
    if (problems.length) throw new SchemaError(problems.join('; '));
    this.schema = schema;
    for (const t of schema.types) this.rows.set(t, new Map());
    for (const r of schema.relations) {
      this.rel.set(r.name, r);
      if (r.kind === 'manyToMany') this.links.set(r.name, []);
    }
  }

  /** Loads data without checking it, the way a database restored from a backup arrives; use `scan` to judge it. */
  static load(schema: Schema, data: Snapshot): Store {
    const s = new Store(schema);
    for (const [t, rows] of Object.entries(data.rows)) {
      const m = s.rows.get(t);
      if (!m) throw new SchemaError(`no kind "${t}"`);
      for (const r of rows) m.set(r.id, { ...r });
    }
    for (const [n, ls] of Object.entries(data.links)) {
      if (!s.links.has(n)) throw new SchemaError(`no many-to-many relation "${n}"`);
      s.links.set(n, ls.map((l) => ({ ...l })));
    }
    return s;
  }

  snapshot(): Snapshot {
    return {
      rows: Object.fromEntries([...this.rows].map(([t, m]) => [t, [...m.values()].map((r) => ({ ...r }))])),
      links: Object.fromEntries([...this.links].map(([n, ls]) => [n, ls.map((l) => ({ ...l }))])),
    };
  }

  private table(type: string): Map<string, Row> {
    const t = this.rows.get(type);
    if (!t) throw new IntegrityError(`there is no kind "${type}"`);
    return t;
  }

  get(type: string, id: string): Row | undefined {
    const r = this.table(type).get(id);
    return r ? { ...r } : undefined;
  }

  all(type: string): Row[] {
    return [...this.table(type).values()].map((r) => ({ ...r }));
  }

  private fks(type: string): BelongsTo[] {
    return this.schema.relations.filter((r): r is BelongsTo => isFk(r) && r.from === type);
  }

  private checkRow(type: string, row: Row) {
    for (const r of this.fks(type)) {
      const v = own(row, r.field);
      if (v === undefined || v === null) {
        if (r.required === true) throw new IntegrityError(`${type}.${r.field} is required`);
        continue;
      }
      if (typeof v !== 'string') throw new IntegrityError(`${type}.${r.field} must be the id of a ${r.to}`);
      if (!this.table(r.to).has(v)) throw new IntegrityError(`${type}.${r.field}: there is no ${r.to} ${v}`);
      if (r.kind === 'oneToOne') {
        for (const o of this.table(type).values()) if (o.id !== row.id && own(o, r.field) === v) throw new IntegrityError(`${r.name}: ${r.to} ${v} already has its ${type}`);
      }
      if (r.acyclic) {
        let cur: string | null | undefined = v;
        const seen = new Set<string>([row.id]);
        while (cur) {
          if (seen.has(cur)) throw new IntegrityError(`${r.name}: this would put ${type} ${row.id} inside itself`);
          seen.add(cur);
          const next: unknown = own(this.table(type).get(cur) ?? ({} as Row), r.field);
          cur = typeof next === 'string' ? next : undefined;
        }
      }
    }
  }

  insert(type: string, row: Row): Row {
    const t = this.table(type);
    if (typeof row.id !== 'string' || !row.id) throw new IntegrityError('a record needs an id');
    if (t.has(row.id)) throw new IntegrityError(`${type} ${row.id} already exists`);
    this.checkRow(type, row);
    t.set(row.id, { ...row });
    return { ...row };
  }

  update(type: string, id: string, patch: Readonly<Record<string, unknown>>): Row {
    const t = this.table(type);
    const old = t.get(id);
    if (!old) throw new IntegrityError(`no ${type} ${id}`);
    if (Object.hasOwn(patch, 'id') && patch.id !== id) throw new IntegrityError('an id cannot change');
    const next = { ...old } as Row;
    for (const [k, v] of Object.entries(patch)) Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
    this.checkRow(type, next);
    t.set(id, next);
    return { ...next };
  }

  // ------------------------------------------------------------ following relations

  /** The record a foreign key points at. */
  parentOf(relation: string, id: string): Row | undefined {
    const r = this.fkRel(relation);
    const row = this.table(r.from).get(id);
    const v = row ? own(row, r.field) : undefined;
    return typeof v === 'string' ? this.get(r.to, v) : undefined;
  }

  /** The records that point at this one through a foreign key. */
  childrenOf(relation: string, id: string): Row[] {
    const r = this.fkRel(relation);
    return [...this.table(r.from).values()].filter((x) => own(x, r.field) === id).map((x) => ({ ...x }));
  }

  private fkRel(name: string): BelongsTo {
    const r = this.rel.get(name);
    if (!r || !isFk(r)) throw new IntegrityError(`${name} is not a foreign key relation`);
    return r;
  }

  /** Every record, of any kind, that refers to this one by a hard relation: what a change here would touch. */
  dependents(type: string, id: string): { type: string; id: string; relation: string }[] {
    const out: { type: string; id: string; relation: string }[] = [];
    for (const r of this.schema.relations) {
      if (isFk(r) && r.to === type) for (const x of this.table(r.from).values()) if (own(x, r.field) === id) out.push({ type: r.from, id: x.id, relation: r.name });
      if (r.kind === 'manyToMany') {
        for (const l of this.links.get(r.name)!) {
          if (r.left === type && l.left === id) out.push({ type: r.right, id: l.right, relation: r.name });
          if (r.right === type && l.right === id) out.push({ type: r.left, id: l.left, relation: r.name });
        }
      }
    }
    return out;
  }

  /** Follows a soft reference to what it names, if that still exists. */
  resolveSoft(relation: string, id: string): Row | undefined {
    const r = this.rel.get(relation);
    if (!r || r.kind !== 'soft') throw new IntegrityError(`${relation} is not a soft reference`);
    const row = this.table(r.from).get(id);
    const v = row ? own(row, r.field) : undefined;
    if (typeof v !== 'string' || !v) return undefined;
    return this.lookupSoft(r, v);
  }

  private lookupSoft(r: Soft, v: string): Row | undefined {
    let kinds = r.to;
    let key = v;
    const colon = v.indexOf(':');
    if (colon > 0 && r.to.includes(v.slice(0, colon))) {
      kinds = [v.slice(0, colon)];
      key = v.slice(colon + 1);
    } else if (r.to.length > 1) return undefined;
    for (const k of kinds) {
      const t = this.table(k);
      if (r.toField === undefined) {
        const row = t.get(key);
        if (row) return { ...row };
      } else {
        for (const row of t.values()) if (own(row, r.toField) === key) return { ...row };
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------ delete plans

  /** What deleting a record would do, without doing it. */
  planDelete(type: string, id: string): DeletePlan {
    if (!this.table(type).has(id)) throw new IntegrityError(`no ${type} ${id}`);
    const doomed = new Map<string, { type: string; id: string }>();
    const key = (t: string, i: string) => `${t}\u0000${i}`;
    const queue = [{ type, id }];
    doomed.set(key(type, id), { type, id });
    while (queue.length) {
      const cur = queue.shift()!;
      for (const r of this.schema.relations) {
        if (!isFk(r) || r.to !== cur.type || r.onDelete !== 'cascade') continue;
        for (const x of this.table(r.from).values()) {
          if (own(x, r.field) !== cur.id || doomed.has(key(r.from, x.id))) continue;
          doomed.set(key(r.from, x.id), { type: r.from, id: x.id });
          queue.push({ type: r.from, id: x.id });
        }
      }
    }
    const blockers: Blocker[] = [];
    const nullify: DeletePlan['nullify'][number][] = [];
    const dangling: DeletePlan['dangling'][number][] = [];
    for (const d of doomed.values()) {
      for (const r of this.schema.relations) {
        if (isFk(r) && r.to === d.type && r.onDelete !== 'cascade') {
          for (const x of this.table(r.from).values()) {
            if (own(x, r.field) !== d.id || doomed.has(key(r.from, x.id))) continue;
            if (r.onDelete === 'restrict') blockers.push({ type: r.from, id: x.id, relation: r.name });
            else nullify.push({ type: r.from, id: x.id, field: r.field, relation: r.name });
          }
        }
        if (r.kind === 'soft' && r.to.includes(d.type)) {
          for (const x of this.table(r.from).values()) {
            if (doomed.has(key(r.from, x.id))) continue;
            const v = own(x, r.field);
            if (typeof v !== 'string') continue;
            const hit = this.lookupSoft(r, v);
            if (hit && hit.id === d.id && this.softKind(r, v) === d.type) dangling.push({ type: r.from, id: x.id, field: r.field, relation: r.name });
          }
        }
      }
    }
    const unlink: DeletePlan['unlink'][number][] = [];
    for (const r of this.schema.relations) {
      if (r.kind !== 'manyToMany') continue;
      for (const l of this.links.get(r.name)!) {
        if (doomed.has(key(r.left, l.left)) || doomed.has(key(r.right, l.right))) unlink.push({ relation: r.name, left: l.left, right: l.right });
      }
    }
    return { deletes: [...doomed.values()], nullify, unlink, blockers, dangling };
  }

  private softKind(r: Soft, v: string): string | undefined {
    const colon = v.indexOf(':');
    if (colon > 0 && r.to.includes(v.slice(0, colon))) return v.slice(0, colon);
    if (r.to.length === 1) return r.to[0];
    for (const k of r.to) {
      const t = this.table(k);
      if (r.toField === undefined ? t.has(v) : [...t.values()].some((x) => own(x, r.toField!) === v)) return k;
    }
    return undefined;
  }

  /** Deletes a record with everything its plan says, all or nothing; refuses if anything restricts it. */
  delete(type: string, id: string): DeletePlan {
    const plan = this.planDelete(type, id);
    if (plan.blockers.length) throw new Restricted(plan.blockers);
    for (const n of plan.nullify) {
      const row = this.table(n.type).get(n.id)!;
      this.table(n.type).set(n.id, { ...row, [n.field]: null });
    }
    for (const u of plan.unlink) {
      const ls = this.links.get(u.relation)!;
      const i = ls.findIndex((l) => l.left === u.left && l.right === u.right);
      if (i >= 0) ls.splice(i, 1);
    }
    for (const d of plan.deletes) this.table(d.type).delete(d.id);
    for (const name of new Set(plan.unlink.map((u) => u.relation))) this.renumber(name);
    return plan;
  }

  // ------------------------------------------------------------ many to many

  private m2m(name: string): ManyToMany {
    const r = this.rel.get(name);
    if (!r || r.kind !== 'manyToMany') throw new IntegrityError(`${name} is not a many-to-many relation`);
    return r;
  }

  /** Links two records; `at` puts the link at a place in the ordered list (default the end). Linking twice is refused. */
  link(name: string, left: string, right: string, at: { left?: number; right?: number } = {}): void {
    const r = this.m2m(name);
    if (!this.table(r.left).has(left)) throw new IntegrityError(`there is no ${r.left} ${left}`);
    if (!this.table(r.right).has(right)) throw new IntegrityError(`there is no ${r.right} ${right}`);
    const ls = this.links.get(name)!;
    if (ls.some((l) => l.left === left && l.right === right)) throw new IntegrityError(`${r.left} ${left} is already linked to ${r.right} ${right}`);
    const nl = ls.filter((l) => l.left === left).length;
    const nr = ls.filter((l) => l.right === right).length;
    const pl = at.left === undefined ? nl : Math.max(0, Math.min(nl, Math.trunc(at.left)));
    const pr = at.right === undefined ? nr : Math.max(0, Math.min(nr, Math.trunc(at.right)));
    if ((at.left !== undefined && !r.ordered) || (at.right !== undefined && !r.ordered)) throw new IntegrityError(`${name} is not ordered`);
    for (const l of ls) {
      if (l.left === left && l.posL >= pl) l.posL++;
      if (l.right === right && l.posR >= pr) l.posR++;
    }
    ls.push({ left, right, posL: pl, posR: pr });
  }

  unlink(name: string, left: string, right: string): boolean {
    this.m2m(name);
    const ls = this.links.get(name)!;
    const i = ls.findIndex((l) => l.left === left && l.right === right);
    if (i < 0) return false;
    ls.splice(i, 1);
    this.renumber(name);
    return true;
  }

  /** The rights linked to a left, in its order (or in the order they were linked when unordered). */
  rightsOf(name: string, left: string): string[] {
    const r = this.m2m(name);
    const ls = this.links.get(name)!.filter((l) => l.left === left);
    return (r.ordered === 'left' || r.ordered === 'both' ? ls.sort((a, b) => a.posL - b.posL) : ls).map((l) => l.right);
  }

  leftsOf(name: string, right: string): string[] {
    const r = this.m2m(name);
    const ls = this.links.get(name)!.filter((l) => l.right === right);
    return (r.ordered === 'right' || r.ordered === 'both' ? ls.sort((a, b) => a.posR - b.posR) : ls).map((l) => l.left);
  }

  /** Moves one right inside a left's list to a place; the others keep their order. */
  move(name: string, left: string, right: string, toIndex: number): void {
    const r = this.m2m(name);
    if (r.ordered !== 'left' && r.ordered !== 'both') throw new IntegrityError(`${name} does not keep an order for ${r.left}`);
    const list = this.rightsOf(name, left);
    const from = list.indexOf(right);
    if (from < 0) throw new IntegrityError(`${r.right} ${right} is not linked to ${r.left} ${left}`);
    list.splice(from, 1);
    list.splice(Math.max(0, Math.min(list.length, Math.trunc(toIndex))), 0, right);
    this.reorder(name, left, list);
  }

  /** Sets the whole order for a left; it must name exactly the rights already linked. */
  reorder(name: string, left: string, rights: readonly string[]): void {
    const r = this.m2m(name);
    if (r.ordered !== 'left' && r.ordered !== 'both') throw new IntegrityError(`${name} does not keep an order for ${r.left}`);
    const have = this.rightsOf(name, left);
    if (rights.length !== have.length || new Set(rights).size !== rights.length || !rights.every((x) => have.includes(x))) throw new IntegrityError('the new order must list exactly the linked records, each once');
    const ls = this.links.get(name)!;
    rights.forEach((x, i) => (ls.find((l) => l.left === left && l.right === x)!.posL = i));
  }

  private renumber(name: string) {
    const ls = this.links.get(name)!;
    for (const side of ['left', 'right'] as const) {
      const groups = new Map<string, Link[]>();
      for (const l of ls) groups.set(l[side], [...(groups.get(l[side]) ?? []), l]);
      for (const g of groups.values()) {
        g.sort((a, b) => (side === 'left' ? a.posL - b.posL : a.posR - b.posR));
        g.forEach((l, i) => {
          if (side === 'left') l.posL = i;
          else l.posR = i;
        });
      }
    }
  }

  // ------------------------------------------------------------ integrity scan and repair

  /** Everything wrong in the data as it stands, with severity; hard breaks are errors, soft ones warnings. */
  scan(): Finding[] {
    const out: Finding[] = [];
    for (const r of this.schema.relations) {
      if (isFk(r)) {
        const seen = new Map<string, string>();
        for (const x of this.table(r.from).values()) {
          const v = own(x, r.field);
          if (v === undefined || v === null || v === '') {
            if (r.required === true) out.push({ kind: 'required-empty', severity: 'error', relation: r.name, type: r.from, id: x.id, detail: `${r.field} is empty but required` });
            continue;
          }
          if (typeof v !== 'string' || !this.table(r.to).has(v)) out.push({ kind: 'dangling-fk', severity: 'error', relation: r.name, type: r.from, id: x.id, detail: `${r.field} points at ${r.to} ${String(v)}, which does not exist` });
          else if (r.kind === 'oneToOne') {
            const other = seen.get(v);
            if (other !== undefined) out.push({ kind: 'not-unique', severity: 'error', relation: r.name, type: r.from, id: x.id, detail: `${r.to} ${v} is also claimed by ${r.from} ${other}` });
            else seen.set(v, x.id);
          }
        }
        if (r.acyclic) {
          for (const x of this.table(r.from).values()) {
            const path = new Set<string>([x.id]);
            let cur = own(x, r.field);
            while (typeof cur === 'string') {
              if (path.has(cur)) {
                if (cur === x.id) out.push({ kind: 'loop', severity: 'error', relation: r.name, type: r.from, id: x.id, detail: `${r.from} ${x.id} is inside itself` });
                break;
              }
              path.add(cur);
              cur = own(this.table(r.from).get(cur) ?? ({} as Row), r.field);
            }
          }
        }
      } else if (r.kind === 'manyToMany') {
        const ls = this.links.get(r.name)!;
        const pairs = new Set<string>();
        for (const l of ls) {
          if (!this.table(r.left).has(l.left)) out.push({ kind: 'dangling-link', severity: 'error', relation: r.name, type: r.left, id: l.left, detail: `a link names ${r.left} ${l.left}, which does not exist` });
          if (!this.table(r.right).has(l.right)) out.push({ kind: 'dangling-link', severity: 'error', relation: r.name, type: r.right, id: l.right, detail: `a link names ${r.right} ${l.right}, which does not exist` });
          const k = `${l.left}\u0000${l.right}`;
          if (pairs.has(k)) out.push({ kind: 'repeated-link', severity: 'error', relation: r.name, type: r.left, id: l.left, detail: `${r.left} ${l.left} is linked to ${r.right} ${l.right} more than once` });
          pairs.add(k);
        }
        const ordered = (side: 'left' | 'right') => {
          const groups = new Map<string, number[]>();
          for (const l of ls) groups.set(l[side], [...(groups.get(l[side]) ?? []), side === 'left' ? l.posL : l.posR]);
          for (const [id, ps] of groups) {
            const sorted = [...ps].sort((a, b) => a - b);
            if (!sorted.every((p, i) => p === i)) out.push({ kind: 'bad-order', severity: 'warning', relation: r.name, type: side === 'left' ? r.left : r.right, id, detail: `positions ${sorted.join(',')} are not 0..${sorted.length - 1}` });
          }
        };
        if (r.ordered === 'left' || r.ordered === 'both') ordered('left');
        if (r.ordered === 'right' || r.ordered === 'both') ordered('right');
      } else {
        for (const x of this.table(r.from).values()) {
          const v = own(x, r.field);
          if (typeof v !== 'string' || !v) continue;
          if (!this.lookupSoft(r, v)) out.push({ kind: 'dangling-soft', severity: 'warning', relation: r.name, type: r.from, id: x.id, detail: `${r.field} "${v.slice(0, 80)}" names nothing that exists` });
        }
      }
    }
    return out;
  }

  /** How each finding could be repaired; soft references are left alone, and some need a person. */
  repairPlan(findings: readonly Finding[] = this.scan()): Repair[] {
    const out: Repair[] = [];
    const seen = new Set<string>();
    const add = (r: Repair) => {
      const k = JSON.stringify(r);
      if (!seen.has(k)) (seen.add(k), out.push(r));
    };
    for (const f of findings) {
      const r = this.rel.get(f.relation)!;
      switch (f.kind) {
        case 'dangling-fk':
          if (isFk(r) && r.required !== true) add({ action: 'set-null', type: f.type, id: f.id, field: r.field });
          else add({ action: 'delete-row', type: f.type, id: f.id });
          break;
        case 'required-empty':
          add({ action: 'manual', type: f.type, id: f.id, why: `${f.relation} needs a value chosen by a person` });
          break;
        case 'not-unique':
          add({ action: 'manual', type: f.type, id: f.id, why: `${f.relation} must be one-to-one; choose which record keeps it` });
          break;
        case 'loop':
          if (isFk(r)) add({ action: 'set-null', type: f.type, id: f.id, field: r.field });
          break;
        case 'dangling-link':
        case 'repeated-link': {
          const m = r as ManyToMany;
          for (const l of this.links.get(f.relation)!) {
            const gone = !this.table(m.left).has(l.left) || !this.table(m.right).has(l.right);
            if (f.kind === 'dangling-link' && gone) add({ action: 'delete-link', relation: f.relation, left: l.left, right: l.right });
          }
          if (f.kind === 'repeated-link') add({ action: 'renumber', relation: f.relation });
          break;
        }
        case 'bad-order':
          add({ action: 'renumber', relation: f.relation });
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** Applies repairs; `manual` ones are returned untouched. */
  repair(plan: readonly Repair[] = this.repairPlan()): Repair[] {
    const left: Repair[] = [];
    const renumber = new Set<string>();
    for (const p of plan) {
      if (p.action === 'set-null') {
        const row = this.table(p.type).get(p.id);
        if (row) this.table(p.type).set(p.id, { ...row, [p.field]: null });
      } else if (p.action === 'delete-row') this.table(p.type).delete(p.id);
      else if (p.action === 'delete-link') {
        const ls = this.links.get(p.relation)!;
        const i = ls.findIndex((l) => l.left === p.left && l.right === p.right);
        if (i >= 0) ls.splice(i, 1);
        renumber.add(p.relation);
      } else if (p.action === 'renumber') {
        const ls = this.links.get(p.relation)!;
        const seen = new Set<string>();
        for (let i = ls.length - 1; i >= 0; i--) {
          const k = `${ls[i]!.left}\u0000${ls[i]!.right}`;
          if (seen.has(k)) ls.splice(i, 1);
          seen.add(k);
        }
        renumber.add(p.relation);
      } else left.push(p);
    }
    for (const n of renumber) this.renumber(n);
    return left;
  }
}
