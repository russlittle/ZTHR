/**
 * REST resources from a declaration: say what a record is (its fields, which may be filtered or sorted, who may read
 * or write each field, how it relates to other records) and get the five routes, validation, filtering, sorting,
 * cursor paging, relation expansion, permission checks and the OpenAPI description, all from that one declaration, so
 * the code, the documentation and the permissions cannot drift apart.
 *
 *   GET /things                list: filter[field]=v, filter[field][op]=v (eq ne lt lte gt gte in contains),
 *                              sort=-field,field, limit, cursor, fields=a,b, expand=relation
 *   POST /things               create (validated, defaults and timestamps filled in, id from the injected generator)
 *   GET /things/{id}           read
 *   PATCH /things/{id}         partial update
 *   DELETE /things/{id}        delete
 *
 * Permissions come from the rbac block: the actions are list, read, create, update and delete on the entity's kind,
 * evaluated against the record, so "members may edit their own" is a policy line, not code. Rows a person may not
 * read are left out of lists and answer 404 on their own route (the record's existence is not confessed); a person who
 * can read but not change a record gets 403. A field can name an extra action to read it or to write it; a field the
 * subject may not read is omitted from every response and may not be filtered or sorted by; writing one is 403.
 *
 * Errors are RFC 9457 problem responses (application/problem+json) with a list of {path, message} for invalid input.
 * The store is injected (`memoryStore` is included); the clock and the id generator are injected too, so every test is
 * deterministic. `handle` takes a plain request object and returns a plain response, so it mounts on any server.
 * Not here: bulk operations, PUT, soft delete, ETags and If-Match, transactions across records, many-to-many
 * relations, and stores that push the permission filter into a query (the store receives the check as a predicate).
 */
import { decide } from '../rbac/index.ts';
import type { Policy, Subject } from '../rbac/index.ts';
import { arr, build, int, nullable, obj, ref, str, validateValue } from '../openapi/index.ts';
import type { OpenApiDocument, RouteDecl, Schema } from '../openapi/index.ts';

export class BadSchema extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the resource declaration has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`);
    this.name = 'BadSchema';
    this.problems = problems;
  }
}

/** A store that refuses an insert or update because a unique value is taken. */
export class StoreConflict extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`${field} is already taken`);
    this.name = 'StoreConflict';
    this.field = field;
  }
}

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'datetime' | 'json';

export interface Field {
  readonly type: FieldType;
  readonly required?: boolean;
  /** Set by the server only: shown in responses, refused in requests. */
  readonly readOnly?: boolean;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
  readonly default?: unknown;
  readonly enum?: readonly (string | number)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  readonly description?: string;
  /** An rbac action the subject needs (on this record) to see the field. */
  readonly readAction?: string;
  /** An rbac action the subject needs (on this record) to write the field. */
  readonly writeAction?: string;
}

export interface Relation {
  readonly entity: string;
  /** 'one': `field` is a key on this entity that holds the other's id. 'many': `field` is a key on the other entity that holds this id. */
  readonly kind: 'one' | 'many';
  readonly field: string;
}

export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface Entity {
  /** The rbac kind and the schema name: "Post". */
  readonly name: string;
  /** The path segment: "posts". */
  readonly plural: string;
  readonly fields: Readonly<Record<string, Field>>;
  readonly relations?: Readonly<Record<string, Relation>>;
  readonly operations?: readonly Operation[];
  readonly defaultSort?: readonly string[];
  /** Adds readOnly createdAt and updatedAt (default true). */
  readonly timestamps?: boolean;
}

export type Rec = Record<string, unknown>;
export type Op = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'contains';
export interface Where {
  readonly field: string;
  readonly op: Op;
  readonly value: unknown;
}
export interface ListQuery {
  readonly where: readonly Where[];
  readonly sort: readonly { readonly field: string; readonly desc: boolean }[];
  readonly limit: number;
  readonly offset: number;
  /** The permission check: the store keeps only rows it accepts, before paging. */
  readonly visible?: (r: Rec) => boolean;
}
export interface Store {
  get(kind: string, id: string): Promise<Rec | undefined>;
  list(kind: string, q: ListQuery): Promise<{ rows: Rec[]; more: boolean }>;
  insert(kind: string, r: Rec): Promise<void>;
  update(kind: string, id: string, r: Rec): Promise<void>;
  remove(kind: string, id: string): Promise<boolean>;
}

export interface Req {
  readonly method: string;
  readonly path: string;
  readonly query?: string | URLSearchParams;
  readonly body?: unknown;
  /** null: nobody signed in. */
  readonly subject: Subject | null;
}
export interface Res {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface Options {
  readonly entities: readonly Entity[];
  readonly policy: Policy;
  readonly store: Store;
  readonly now: () => Date;
  readonly newId: () => string;
  /** Path prefix, "/v1" (default none). */
  readonly prefix?: string;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  /** The most related records expanded per "many" relation (default 25). */
  readonly expandLimit?: number;
}

// ---------------------------------------------------------------- the store

const cmp = (a: unknown, b: unknown): number => (a === b ? 0 : a === undefined || a === null ? -1 : b === undefined || b === null ? 1 : (a as number | string) < (b as number | string) ? -1 : 1);

export function matches(r: Rec, w: Where): boolean {
  const v = r[w.field];
  switch (w.op) {
    case 'eq': return v === w.value || (v === undefined && w.value === null);
    case 'ne': return !(v === w.value || (v === undefined && w.value === null));
    case 'lt': return v != null && cmp(v, w.value) < 0;
    case 'lte': return v != null && cmp(v, w.value) <= 0;
    case 'gt': return v != null && cmp(v, w.value) > 0;
    case 'gte': return v != null && cmp(v, w.value) >= 0;
    case 'in': return Array.isArray(w.value) && w.value.includes(v);
    case 'contains': return typeof v === 'string' && typeof w.value === 'string' && v.toLowerCase().includes(w.value.toLowerCase());
  }
}

/** An in-memory store: the reference for the interface, and enough for tests and small tools. */
export function memoryStore(seed: Readonly<Record<string, readonly Rec[]>> = {}, unique: Readonly<Record<string, readonly string[]>> = {}): Store {
  const tables = new Map<string, Map<string, Rec>>();
  const table = (k: string) => {
    let t = tables.get(k);
    if (!t) tables.set(k, (t = new Map()));
    return t;
  };
  for (const [k, rows] of Object.entries(seed)) for (const r of rows) table(k).set(String(r['id']), structuredClone(r) as Rec);
  const clash = (kind: string, r: Rec) => {
    for (const f of unique[kind] ?? []) {
      if (r[f] == null) continue;
      for (const o of table(kind).values()) if (o['id'] !== r['id'] && o[f] === r[f]) throw new StoreConflict(f);
    }
  };
  return {
    async get(kind, id) {
      const r = table(kind).get(id);
      return r ? (structuredClone(r) as Rec) : undefined;
    },
    async list(kind, q) {
      let rows = [...table(kind).values()].filter((r) => q.where.every((w) => matches(r, w)) && (q.visible ? q.visible(r) : true));
      rows.sort((a, b) => {
        for (const s of q.sort) {
          const c = cmp(a[s.field], b[s.field]);
          if (c) return s.desc ? -c : c;
        }
        return cmp(a['id'], b['id']);
      });
      rows = rows.slice(q.offset);
      return { rows: rows.slice(0, q.limit).map((r) => structuredClone(r) as Rec), more: rows.length > q.limit };
    },
    async insert(kind, r) {
      clash(kind, r);
      table(kind).set(String(r['id']), structuredClone(r) as Rec);
    },
    async update(kind, id, r) {
      clash(kind, r);
      table(kind).set(id, structuredClone(r) as Rec);
    },
    async remove(kind, id) {
      return table(kind).delete(id);
    },
  };
}

// ---------------------------------------------------------------- the declaration

const SYSTEM: Readonly<Record<string, Field>> = {
  id: { type: 'string', readOnly: true, required: true, filterable: true, sortable: true },
};
const STAMPS: Readonly<Record<string, Field>> = {
  createdAt: { type: 'datetime', readOnly: true, required: true, filterable: true, sortable: true },
  updatedAt: { type: 'datetime', readOnly: true, required: true, filterable: true, sortable: true },
};
const TYPE_OPS: Readonly<Record<FieldType, readonly Op[]>> = {
  string: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'contains'],
  integer: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in'],
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in'],
  boolean: ['eq', 'ne'],
  datetime: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in'],
  json: [],
};

/** The entity with its system fields (id, timestamps) added. */
export function withSystemFields(e: Entity): Entity {
  return { ...e, fields: { ...SYSTEM, ...(e.timestamps === false ? {} : STAMPS), ...e.fields } };
}

function fieldSchema(f: Field): Schema {
  let s: Record<string, unknown>;
  switch (f.type) {
    case 'string': s = { type: 'string', ...(f.minLength !== undefined ? { minLength: f.minLength } : {}), ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}), ...(f.pattern ? { pattern: f.pattern } : {}), ...(f.format ? { format: f.format } : {}) }; break;
    case 'integer': s = { type: 'integer', ...(f.minimum !== undefined ? { minimum: f.minimum } : {}), ...(f.maximum !== undefined ? { maximum: f.maximum } : {}) }; break;
    case 'number': s = { type: 'number', ...(f.minimum !== undefined ? { minimum: f.minimum } : {}), ...(f.maximum !== undefined ? { maximum: f.maximum } : {}) }; break;
    case 'boolean': s = { type: 'boolean' }; break;
    case 'datetime': s = { type: 'string', format: 'date-time' }; break;
    case 'json': s = {}; break;
  }
  if (f.enum) s['enum'] = [...f.enum];
  if (f.description) s['description'] = f.description;
  if (f.default !== undefined) s['default'] = f.default;
  return f.nullable ? nullable(s) : s;
}

/** Checks a declaration and returns the entities with system fields added; throws BadSchema listing every problem. */
export function declare(entities: readonly Entity[]): Entity[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const plurals = new Set<string>();
  const out = entities.map(withSystemFields);
  for (const e of out) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(e.name)) problems.push(`${e.name}: the name must start with a capital letter and use letters and digits`);
    if (names.has(e.name)) problems.push(`${e.name}: declared twice`);
    names.add(e.name);
    if (!/^[a-z][a-z0-9-]*$/.test(e.plural)) problems.push(`${e.name}: the plural "${e.plural}" must be a lower-case path segment`);
    if (plurals.has(e.plural)) problems.push(`${e.name}: the path /${e.plural} is used twice`);
    plurals.add(e.plural);
    for (const [n, f] of Object.entries(e.fields)) {
      const at = `${e.name}.${n}`;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n)) problems.push(`${at}: the field name is not a plain identifier`);
      if (f.type === 'json' && (f.filterable || f.sortable)) problems.push(`${at}: a json field cannot be filtered or sorted`);
      if (f.enum && f.type !== 'string' && f.type !== 'integer' && f.type !== 'number') problems.push(`${at}: enum needs a string, integer or number field`);
      if (f.readOnly && f.required && !Object.hasOwn(SYSTEM, n) && !Object.hasOwn(STAMPS, n) && f.default === undefined) problems.push(`${at}: a required read-only field needs a default`);
      if (f.default !== undefined && validateValue(fieldSchema(f), f.default).length) problems.push(`${at}: the default does not fit the field`);
      if (f.pattern) {
        try {
          new RegExp(f.pattern, 'u');
        } catch {
          problems.push(`${at}: the pattern is not a valid expression`);
        }
      }
    }
    for (const d of e.defaultSort ?? []) {
      const f = e.fields[d.replace(/^-/, '')];
      if (!f?.sortable) problems.push(`${e.name}: defaultSort "${d}" is not a sortable field`);
    }
    for (const [rn, r] of Object.entries(e.relations ?? {})) {
      const other = out.find((x) => x.name === r.entity);
      if (!other) {
        problems.push(`${e.name}.${rn}: the relation points at ${r.entity}, which is not declared`);
        continue;
      }
      if (e.fields[rn]) problems.push(`${e.name}.${rn}: the relation has the same name as a field`);
      if (r.kind === 'one' && !e.fields[r.field]) problems.push(`${e.name}.${rn}: ${e.name} has no field ${r.field}`);
      if (r.kind === 'many' && !other.fields[r.field]) problems.push(`${e.name}.${rn}: ${r.entity} has no field ${r.field}`);
    }
  }
  if (problems.length) throw new BadSchema(problems);
  return out;
}

// ---------------------------------------------------------------- the handlers

interface Issue {
  readonly path: string;
  readonly message: string;
}
class Problem extends Error {
  readonly status: number;
  readonly errors: readonly Issue[] | undefined;
  constructor(status: number, title: string, errors?: readonly Issue[]) {
    super(title);
    this.status = status;
    this.errors = errors;
  }
}

const TITLES: Readonly<Record<number, string>> = { 400: 'Bad request', 401: 'Not authenticated', 403: 'Not allowed', 404: 'Not found', 405: 'Method not allowed', 409: 'Conflict', 422: 'Invalid input' };

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Res => ({ status, headers: { 'content-type': 'application/json', ...extra }, body });
const problem = (p: Problem, instance: string): Res => ({
  status: p.status,
  headers: { 'content-type': 'application/problem+json' },
  body: { type: 'about:blank', title: TITLES[p.status] ?? 'Error', status: p.status, detail: p.message, instance, ...(p.errors ? { errors: p.errors } : {}) },
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
};

export interface Crud {
  /** Serve one request. Never throws for bad input; it answers with a problem response. */
  handle(req: Req): Promise<Res>;
  /** The route declarations, for openapi's build. */
  routes(): RouteDecl[];
  /** The OpenAPI 3.1 document for everything handled here. */
  openapi(info: { title: string; version: string; description?: string }): OpenApiDocument;
  readonly entities: readonly Entity[];
}

export function crud(o: Options): Crud {
  const entities = declare(o.entities);
  const prefix = o.prefix ?? '';
  const defaultLimit = o.defaultLimit ?? 20;
  const maxLimit = o.maxLimit ?? 100;
  const expandLimit = o.expandLimit ?? 25;
  const byName = new Map(entities.map((e) => [e.name, e]));
  const can = (s: Subject, action: string, kind: string, r: Rec) => decide(o.policy, s, action, kind, r).allowed;
  const ops = (e: Entity) => e.operations ?? (['list', 'get', 'create', 'update', 'delete'] as const);

  const readable = (e: Entity, s: Subject, r: Rec, n: string): boolean => {
    const f = e.fields[n];
    return !!f && (!f.readAction || can(s, f.readAction, e.name, r));
  };
  const project = (e: Entity, s: Subject, r: Rec, only?: readonly string[]): Rec => {
    const out: Rec = {};
    for (const n of Object.keys(e.fields)) if (r[n] !== undefined && (!only || only.includes(n) || n === 'id') && readable(e, s, r, n)) out[n] = r[n];
    return out;
  };

  const fieldSchemas = (e: Entity, mode: 'read' | 'create' | 'update') => {
    const props: Record<string, Schema> = {};
    const required: string[] = [];
    for (const [n, f] of Object.entries(e.fields)) {
      if (mode !== 'read' && f.readOnly) continue;
      props[n] = fieldSchema(f);
      if (mode === 'read' ? f.required || f.default !== undefined : mode === 'create' && f.required && f.default === undefined) required.push(n);
    }
    return { props, required };
  };
  const writeSchema = (e: Entity, mode: 'create' | 'update'): Schema => {
    const { props, required } = fieldSchemas(e, mode);
    return obj(props, { required, additionalProperties: false });
  };
  const schemas = new Map(entities.map((e) => [e.name, { create: writeSchema(e, 'create'), update: writeSchema(e, 'update') }]));

  const coerce = (e: Entity, name: string, raw: string, path: string): unknown => {
    const f = e.fields[name]!;
    if (f.nullable && raw === 'null') return null;
    let v: unknown = raw;
    if (f.type === 'integer' || f.type === 'number') {
      v = raw.trim() === '' ? NaN : Number(raw);
    } else if (f.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') throw new Problem(400, 'Invalid filter', [{ path, message: 'must be true or false' }]);
      v = raw === 'true';
    }
    const base: Schema = f.type === 'string' ? { type: 'string' } : f.type === 'integer' ? { type: 'integer' } : f.type === 'number' ? { type: 'number' } : f.type === 'datetime' ? { type: 'string', format: 'date-time' } : {};
    const issues = validateValue(base, v);
    if (issues.length) throw new Problem(400, 'Invalid filter', [{ path, message: issues[0]!.message }]);
    return v;
  };

  const parseList = (e: Entity, s: Subject, params: URLSearchParams) => {
    const where: Where[] = [];
    const issues: Issue[] = [];
    let sortRaw: string | null = null;
    let limit = defaultLimit;
    let cursor: string | null = null;
    let fields: string[] | undefined;
    let expand: string[] = [];
    for (const [k, raw] of params) {
      const m = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(k);
      if (m) {
        const name = m[1]!;
        const op = (m[2] ?? 'eq') as Op;
        const f = e.fields[name];
        if (!f || !f.filterable) issues.push({ path: k, message: `${name} cannot be filtered by` });
        else if (!readable(e, s, {}, name) && f.readAction) issues.push({ path: k, message: `${name} cannot be filtered by` });
        else if (!TYPE_OPS[f.type].includes(op)) issues.push({ path: k, message: `${op} does not apply to a ${f.type} field` });
        else {
          try {
            where.push({ field: name, op, value: op === 'in' ? raw.split(',').map((x) => coerce(e, name, x, k)) : coerce(e, name, raw, k) });
          } catch (x) {
            if (x instanceof Problem) issues.push(...(x.errors ?? []));
            else throw x;
          }
        }
      } else if (k === 'sort') sortRaw = raw;
      else if (k === 'limit') {
        if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maxLimit) issues.push({ path: 'limit', message: `must be a whole number from 1 to ${maxLimit}` });
        else limit = Number(raw);
      } else if (k === 'cursor') cursor = raw;
      else if (k === 'fields') {
        fields = raw.split(',').filter(Boolean);
        for (const n of fields) if (!e.fields[n]) issues.push({ path: 'fields', message: `${n} is not a field` });
      } else if (k === 'expand') {
        expand = raw.split(',').filter(Boolean);
        for (const n of expand) if (!e.relations?.[n]) issues.push({ path: 'expand', message: `${n} is not a relation of ${e.name}` });
      } else issues.push({ path: k, message: 'is not a known parameter' });
    }
    const sortNames = sortRaw !== null ? sortRaw.split(',').filter(Boolean) : [...(e.defaultSort ?? [e.timestamps === false ? 'id' : 'createdAt'])];
    const sort = sortNames.map((n) => ({ field: n.replace(/^-/, ''), desc: n.startsWith('-') }));
    for (const x of sort) if (!e.fields[x.field]?.sortable || (e.fields[x.field]!.readAction && !readable(e, s, {}, x.field))) issues.push({ path: 'sort', message: `${x.field} cannot be sorted by` });
    if (issues.length) throw new Problem(400, 'The query is not valid', issues);
    let offset = 0;
    const sig = [...where.map((w) => `${w.field}:${w.op}:${JSON.stringify(w.value)}`), sortNames.join(',')].join('&');
    if (cursor !== null) {
      const c = unb64(cursor) as { o?: unknown; s?: unknown } | undefined;
      if (!c || typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0 || c.s !== sig) throw new Problem(400, 'The query is not valid', [{ path: 'cursor', message: 'is not a cursor for this query' }]);
      offset = c.o;
    }
    return { where, sort, limit, offset, sig, fields, expand };
  };

  const expandInto = async (e: Entity, s: Subject, row: Rec, names: readonly string[], out: Rec) => {
    for (const n of names) {
      const rel = e.relations![n]!;
      const other = byName.get(rel.entity)!;
      if (rel.kind === 'one') {
        const id = row[rel.field];
        const rec = typeof id === 'string' ? await o.store.get(other.name, id) : undefined;
        out[n] = rec && can(s, 'read', other.name, rec) ? project(other, s, rec) : null;
      } else {
        const r = await o.store.list(other.name, { where: [{ field: rel.field, op: 'eq', value: row['id'] }], sort: [{ field: other.timestamps === false ? 'id' : 'createdAt', desc: false }], limit: expandLimit, offset: 0, visible: (x) => can(s, 'read', other.name, x) });
        out[n] = r.rows.map((x) => project(other, s, x));
      }
    }
  };

  const validateWrite = (e: Entity, s: Subject, mode: 'create' | 'update', body: unknown, current?: Rec): Rec => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Problem(422, 'The body must be a JSON object', [{ path: '', message: 'must be an object' }]);
    const input = body as Rec;
    const sch = schemas.get(e.name)![mode];
    const issues = validateValue(sch, input).map((p) => ({ path: p.path, message: p.message }));
    for (const n of Object.keys(input)) if (e.fields[n]?.readOnly) issues.push({ path: `/${n}`, message: 'is set by the server and cannot be written' });
    const seen = new Set(issues.map((i) => i.path));
    const dedup = issues.filter((i) => !(i.message === 'is not allowed here' && seen.has(i.path) && issues.some((j) => j.path === i.path && j !== i)));
    if (dedup.length) throw new Problem(422, 'The record is not valid', dedup);
    const target = { ...(current ?? {}), ...input };
    for (const n of Object.keys(input)) {
      const w = e.fields[n]!.writeAction;
      if (w && !can(s, w, e.name, current ?? target)) throw new Problem(403, `You may not write ${n}`);
    }
    return input;
  };

  const uniqueCheck = async (e: Entity, rec: Rec, selfId?: string) => {
    for (const [n, f] of Object.entries(e.fields)) {
      if (!f.unique || rec[n] == null) continue;
      const r = await o.store.list(e.name, { where: [{ field: n, op: 'eq', value: rec[n] }], sort: [], limit: 2, offset: 0 });
      if (r.rows.some((x) => x['id'] !== selfId)) throw new Problem(409, `${n} is already taken`, [{ path: `/${n}`, message: 'is already taken' }]);
    }
  };

  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (x) {
      if (x instanceof StoreConflict) throw new Problem(409, x.message, [{ path: `/${x.field}`, message: 'is already taken' }]);
      throw x;
    }
  };

  async function dispatch(req: Req): Promise<Res> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '') || '/';
    if (!path.startsWith(`${prefix}/`)) throw new Problem(404, 'No such resource');
    const parts = path.slice(prefix.length + 1).split('/').map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        throw new Problem(400, 'The path is not valid');
      }
    });
    const e = entities.find((x) => x.plural === parts[0]);
    if (!e || parts.length > 2 || parts.some((p) => p === '')) throw new Problem(404, 'No such resource');
    const id = parts[1];
    const allowed = ops(e);
    const op: Operation | undefined = id === undefined ? (method === 'GET' ? 'list' : method === 'POST' ? 'create' : undefined) : method === 'GET' ? 'get' : method === 'PATCH' ? 'update' : method === 'DELETE' ? 'delete' : undefined;
    if (!op || !allowed.includes(op)) {
      const here = id === undefined ? (['list', 'create'] as const) : (['get', 'update', 'delete'] as const);
      const verbs = here.filter((x) => allowed.includes(x)).map((x) => ({ list: 'GET', create: 'POST', get: 'GET', update: 'PATCH', delete: 'DELETE' })[x]);
      if (!verbs.length) throw new Problem(404, 'No such resource');
      return { ...problem(new Problem(405, `${method} is not supported here`), req.path), headers: { 'content-type': 'application/problem+json', allow: [...new Set(verbs)].join(', ') } };
    }
    const s = req.subject;
    if (!s) throw new Problem(401, 'Sign in to use this API');
    const params = req.query instanceof URLSearchParams ? req.query : new URLSearchParams(req.query ?? '');

    if (op === 'list') {
      const q = parseList(e, s, params);
      const r = await o.store.list(e.name, { where: q.where, sort: q.sort, limit: q.limit, offset: q.offset, visible: (x) => can(s, 'list', e.name, x) && can(s, 'read', e.name, x) });
      const data: Rec[] = [];
      for (const row of r.rows) {
        const p = project(e, s, row, q.fields);
        if (q.expand.length) await expandInto(e, s, row, q.expand, p);
        data.push(p);
      }
      return json(200, { data, next: r.more ? b64({ o: q.offset + r.rows.length, s: q.sig }) : null });
    }
    if (op === 'create') {
      const input = validateWrite(e, s, 'create', req.body);
      const stamp = o.now().toISOString();
      const rec: Rec = { id: o.newId() };
      for (const [n, f] of Object.entries(e.fields)) if (f.default !== undefined) rec[n] = structuredClone(f.default);
      Object.assign(rec, input);
      if (e.timestamps !== false) Object.assign(rec, { createdAt: stamp, updatedAt: stamp });
      if (!can(s, 'create', e.name, rec)) throw new Problem(403, `You may not create ${e.plural}`);
      await uniqueCheck(e, rec);
      await guard(() => o.store.insert(e.name, rec));
      return json(201, project(e, s, rec), { location: `${prefix}/${e.plural}/${encodeURIComponent(String(rec['id']))}` });
    }
    const current = await o.store.get(e.name, id!);
    if (!current || !can(s, 'read', e.name, current)) throw new Problem(404, `No such ${e.name}`);
    if (op === 'get') {
      const issues: Issue[] = [];
      let expand: string[] = [];
      let fields: string[] | undefined;
      for (const [k, raw] of params) {
        if (k === 'expand') {
          expand = raw.split(',').filter(Boolean);
          for (const n of expand) if (!e.relations?.[n]) issues.push({ path: 'expand', message: `${n} is not a relation of ${e.name}` });
        } else if (k === 'fields') {
          fields = raw.split(',').filter(Boolean);
          for (const n of fields) if (!e.fields[n]) issues.push({ path: 'fields', message: `${n} is not a field` });
        } else issues.push({ path: k, message: 'is not a known parameter' });
      }
      if (issues.length) throw new Problem(400, 'The query is not valid', issues);
      const p = project(e, s, current, fields);
      await expandInto(e, s, current, expand, p);
      return json(200, p);
    }
    if (op === 'update') {
      if (!can(s, 'update', e.name, current)) throw new Problem(403, `You may not change this ${e.name}`);
      const input = validateWrite(e, s, 'update', req.body, current);
      const merged: Rec = { ...current, ...input };
      if (e.timestamps !== false) merged['updatedAt'] = o.now().toISOString();
      if (!can(s, 'update', e.name, merged)) throw new Problem(403, `You may not make that change to this ${e.name}`);
      await uniqueCheck(e, merged, id);
      await guard(() => o.store.update(e.name, id!, merged));
      return json(200, project(e, s, merged));
    }
    if (!can(s, 'delete', e.name, current)) throw new Problem(403, `You may not delete this ${e.name}`);
    await o.store.remove(e.name, id!);
    return { status: 204, headers: {} };
  }

  const routes = (): RouteDecl[] => {
    const out: RouteDecl[] = [];
    for (const e of entities) {
      const sc = `${e.name}`;
      const cs = schemas.get(e.name)!;
      const filterable = Object.entries(e.fields).filter(([, f]) => f.filterable);
      const sortable = Object.entries(e.fields).filter(([, f]) => f.sortable).map(([n]) => n);
      const rels = Object.keys(e.relations ?? {});
      const common = {
        fields: { schema: str(), description: `Comma-separated fields to return (${Object.keys(e.fields).join(', ')}).` },
        ...(rels.length ? { expand: { schema: str(), description: `Comma-separated relations to include: ${rels.join(', ')}.` } } : {}),
      };
      const id = { id: str() };
      const perm = (a: string) => `Needs ${a} permission on ${e.name}.`;
      if (ops(e).includes('list')) {
        out.push({
          method: 'get', path: `${prefix}/${e.plural}`, operationId: `list${e.name}`, tags: [e.name], summary: `List ${e.plural}`, description: perm('list'),
          query: {
            limit: { schema: int({ minimum: 1, maximum: maxLimit, default: defaultLimit } as never), description: 'Page size.' },
            cursor: { schema: str(), description: 'The next value of the previous page.' },
            sort: { schema: str(), description: `Comma-separated, - for descending. Sortable: ${sortable.join(', ')}.` },
            ...common,
            ...Object.fromEntries(filterable.map(([n, f]) => [`filter[${n}]`, { schema: fieldSchema({ ...f, required: false, default: undefined }), description: `Filter by ${n}; also filter[${n}][${TYPE_OPS[f.type].filter((x) => x !== 'eq').join('|')}].` }])),
          },
          responses: { '200': { description: `A page of ${e.plural}`, schema: obj({ data: arr(ref(sc)), next: nullable(str()) }, { required: ['data', 'next'] }) } },
        });
      }
      if (ops(e).includes('create')) out.push({ method: 'post', path: `${prefix}/${e.plural}`, operationId: `create${e.name}`, tags: [e.name], summary: `Create a ${e.name}`, description: perm('create'), body: { schema: cs.create }, responses: { '201': { description: 'Created', schema: ref(sc), headers: { location: { schema: str(), required: true } } } } });
      if (ops(e).includes('get')) out.push({ method: 'get', path: `${prefix}/${e.plural}/{id}`, operationId: `get${e.name}`, tags: [e.name], summary: `Read a ${e.name}`, description: perm('read'), pathParams: id, query: common, responses: { '200': { description: e.name, schema: ref(sc) } } });
      if (ops(e).includes('update')) out.push({ method: 'patch', path: `${prefix}/${e.plural}/{id}`, operationId: `update${e.name}`, tags: [e.name], summary: `Change a ${e.name}`, description: perm('update'), pathParams: id, body: { schema: cs.update }, responses: { '200': { description: 'Updated', schema: ref(sc) } } });
      if (ops(e).includes('delete')) out.push({ method: 'delete', path: `${prefix}/${e.plural}/{id}`, operationId: `delete${e.name}`, tags: [e.name], summary: `Delete a ${e.name}`, description: perm('delete'), pathParams: id, responses: { '204': { description: 'Deleted' } } });
    }
    return out;
  };

  return {
    entities,
    routes,
    async handle(req) {
      try {
        return await dispatch(req);
      } catch (x) {
        if (x instanceof Problem) return problem(x, req.path);
        throw x;
      }
    },
    openapi(info) {
      const readSchemas: Record<string, Schema> = {};
      for (const e of entities) {
        const { props, required } = fieldSchemas(e, 'read');
        for (const n of Object.keys(e.relations ?? {})) props[n] = { description: `Included when expand=${n} is asked for.`, ...(e.relations![n]!.kind === 'many' ? { type: 'array', items: ref(e.relations![n]!.entity) } : { oneOf: [ref(e.relations![n]!.entity), { type: 'null' }] }) };
        readSchemas[e.name] = obj(props, { required, additionalProperties: false });
      }
      return build({ info, routes: routes(), schemas: readSchemas, problems: [400, 401, 403, 404, 422], tags: entities.map((e) => ({ name: e.name })) });
    },
  };
}
