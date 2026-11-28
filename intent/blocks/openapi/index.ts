/**
 * OpenAPI 3.1: the contract of an HTTP API, generated from the routes that implement it, checked, compared with its
 * last version, and used to test clients. Four jobs:
 *
 * 1. Build (`build`): route declarations (method, path, parameters, body, responses, security) become an OpenAPI 3.1.0
 *    document. Schemas are plain JSON Schema 2020-12 objects (`str`, `int`, `obj`, `arr`, `ref`, `nullable` and the
 *    rest build them); path templates and declared path parameters must agree, operation ids are unique, every $ref
 *    must exist, and every example must validate against its schema, or the build refuses and lists each problem.
 *    Optionally the standard problem-details error responses (RFC 9457) are added to every operation, and an
 *    apiver `Versions` adds the API-Version header parameter and lists the versions.
 * 2. Check (`check`): the same rules applied to any OpenAPI 3.1 document, hand-written or not, returned as errors and
 *    warnings with JSON-pointer paths. External references are refused, `nullable` (a 3.0 keyword) is refused in 3.1.
 * 3. Compare (`diff`): two documents, the old and the new, and every change that would break a client or a server
 *    that relied on the old one: removed paths, operations and responses, parameters and body fields that became
 *    required, types changed, enum values removed from requests or added to responses, constraints tightened on
 *    what clients send or loosened on what they receive, added security. Each change says which rule and where.
 * 4. Contract tests (`contract`): the operations as test cases with request examples (declared or generated from the
 *    schema), and `verifyResponse`, which checks a real response (status, content type, body, required headers)
 *    against the document, so a client or a server is held to what was published.
 *
 * The JSON Schema support is the subset APIs use: type (and type lists, so nullable is `["string","null"]`), enum,
 * const, properties, required, additionalProperties, items, length, range and count limits, multipleOf, uniqueItems,
 * pattern, the common formats, allOf, anyOf, oneOf, not and internal $ref. Not here: serving the document, rendering it
 * as HTML, OpenAPI 3.0 and Swagger 2 input, webhooks and callbacks, XML bodies, and external or dynamic references.
 * Pure: no clock, no network.
 */
import type { Versions } from '../apiver/index.ts';

export class InvalidApi extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the API declaration has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`);
    this.name = 'InvalidApi';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------- schemas

export type Schema = { readonly [k: string]: unknown } | boolean;
type Obj = Record<string, unknown>;

export const str = (o: { format?: string; minLength?: number; maxLength?: number; pattern?: string; description?: string; example?: unknown; default?: unknown } = {}): Schema => ({ type: 'string', ...o });
export const int = (o: { minimum?: number; maximum?: number; description?: string; example?: unknown; default?: unknown; format?: 'int32' | 'int64' } = {}): Schema => ({ type: 'integer', ...o });
export const num = (o: { minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; multipleOf?: number; description?: string; example?: unknown } = {}): Schema => ({ type: 'number', ...o });
export const bool = (o: { description?: string; example?: unknown; default?: unknown } = {}): Schema => ({ type: 'boolean', ...o });
export const enumOf = (values: readonly (string | number)[], o: { description?: string } = {}): Schema => ({ type: typeof values[0] === 'number' ? 'number' : 'string', enum: [...values], ...o });
export const arr = (items: Schema, o: { minItems?: number; maxItems?: number; uniqueItems?: boolean; description?: string } = {}): Schema => ({ type: 'array', items, ...o });
export const obj = (properties: Readonly<Record<string, Schema>>, o: { required?: readonly string[]; additionalProperties?: boolean | Schema; description?: string } = {}): Schema => ({ type: 'object', properties, ...(o.required ? { required: [...o.required] } : {}), additionalProperties: o.additionalProperties ?? false, ...(o.description ? { description: o.description } : {}) });
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
/** `type` becomes a list with "null": the 3.1 way to say a value may be null. */
export const nullable = (s: Schema): Schema => {
  if (typeof s === 'boolean') return s;
  if (typeof s['type'] === 'string') return { ...s, type: [s['type'], 'null'] };
  if (Array.isArray(s['type'])) return s['type'].includes('null') ? s : { ...s, type: [...s['type'], 'null'] };
  return { oneOf: [s, { type: 'null' }] };
};
export const oneOf = (...s: Schema[]): Schema => ({ oneOf: s });

export interface Problem {
  readonly path: string;
  readonly message: string;
}

type Resolver = (ref: string) => Schema | undefined;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameJson(x, (b as unknown[])[i]));
  const ak = Object.keys(a as Obj);
  const bk = Object.keys(b as Obj);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b as Obj, k) && sameJson((a as Obj)[k], (b as Obj)[k]));
}

const FORMATS: Readonly<Record<string, (s: string) => boolean>> = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s,
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254,
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  uri: (s) => {
    try {
      return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !!new URL(s);
    } catch {
      return false;
    }
  },
  ipv4: (s) => /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(s),
};

const cpLength = (s: string) => [...s].length;

/** Checks a value against a schema. Returns every problem with its JSON path; empty means it fits. */
export function validateValue(schema: Schema, value: unknown, resolve: Resolver = () => undefined, path = '', depth = 0, out: Problem[] = []): Problem[] {
  if (depth > 40) {
    out.push({ path, message: 'the schema nests too deeply to check' });
    return out;
  }
  if (schema === true) return out;
  if (schema === false) {
    out.push({ path, message: 'no value is allowed here' });
    return out;
  }
  const s = schema as Obj;
  const bad = (message: string) => out.push({ path, message });
  if (typeof s['$ref'] === 'string') {
    const t = resolve(s['$ref']);
    if (t === undefined) bad(`the reference ${s['$ref']} does not exist`);
    else validateValue(t, value, resolve, path, depth + 1, out);
    return out;
  }
  const types = s['type'] === undefined ? null : Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string];
  if (types) {
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'integer' && t === 'number' && Number.isInteger(value)) || (x === 'number' && t === 'number'));
    if (!ok || (t === 'number' && !Number.isFinite(value as number))) {
      bad(`must be ${types.join(' or ')}, not ${t === 'number' && !Number.isFinite(value as number) ? 'a non-finite number' : t}`);
      return out;
    }
  }
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => sameJson(e, value))) bad(`must be one of ${s['enum'].map((e) => JSON.stringify(e)).join(', ')}`);
  if ('const' in s && !sameJson(s['const'], value)) bad(`must be ${JSON.stringify(s['const'])}`);
  if (typeof value === 'string') {
    const n = cpLength(value);
    if (typeof s['minLength'] === 'number' && n < s['minLength']) bad(`must be at least ${s['minLength']} characters`);
    if (typeof s['maxLength'] === 'number' && n > s['maxLength']) bad(`must be at most ${s['maxLength']} characters`);
    if (typeof s['pattern'] === 'string' && s['pattern'].length <= 500) {
      try {
        if (!new RegExp(s['pattern'], 'u').test(value)) bad(`must match ${s['pattern']}`);
      } catch {
        bad(`the pattern ${s['pattern']} is not a valid expression`);
      }
    }
    if (typeof s['format'] === 'string' && FORMATS[s['format']] && !FORMATS[s['format']]!(value)) bad(`must be a valid ${s['format']}`);
  }
  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < s['minimum']) bad(`must be at least ${s['minimum']}`);
    if (typeof s['maximum'] === 'number' && value > s['maximum']) bad(`must be at most ${s['maximum']}`);
    if (typeof s['exclusiveMinimum'] === 'number' && value <= s['exclusiveMinimum']) bad(`must be more than ${s['exclusiveMinimum']}`);
    if (typeof s['exclusiveMaximum'] === 'number' && value >= s['exclusiveMaximum']) bad(`must be less than ${s['exclusiveMaximum']}`);
    if (typeof s['multipleOf'] === 'number' && s['multipleOf'] > 0) {
      const q = value / s['multipleOf'];
      if (Math.abs(q - Math.round(q)) > 1e-9) bad(`must be a multiple of ${s['multipleOf']}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < s['minItems']) bad(`must have at least ${s['minItems']} items`);
    if (typeof s['maxItems'] === 'number' && value.length > s['maxItems']) bad(`must have at most ${s['maxItems']} items`);
    if (s['uniqueItems'] === true && value.some((x, i) => value.findIndex((y) => sameJson(x, y)) !== i)) bad('items must be unique');
    if (s['items'] !== undefined) value.forEach((v, i) => validateValue(s['items'] as Schema, v, resolve, `${path}/${i}`, depth + 1, out));
  }
  if (isObj(value)) {
    const props = isObj(s['properties']) ? (s['properties'] as Record<string, Schema>) : {};
    for (const r of Array.isArray(s['required']) ? (s['required'] as string[]) : []) if (!Object.hasOwn(value, r)) out.push({ path: `${path}/${r}`, message: 'is required' });
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validateValue(props[k]!, v, resolve, `${path}/${k}`, depth + 1, out);
      else if (s['additionalProperties'] === false) out.push({ path: `${path}/${k}`, message: 'is not allowed here' });
      else if (isObj(s['additionalProperties'])) validateValue(s['additionalProperties'] as Schema, v, resolve, `${path}/${k}`, depth + 1, out);
    }
  }
  if (Array.isArray(s['allOf'])) for (const sub of s['allOf'] as Schema[]) validateValue(sub, value, resolve, path, depth + 1, out);
  if (Array.isArray(s['anyOf']) && !(s['anyOf'] as Schema[]).some((sub) => validateValue(sub, value, resolve, path, depth + 1, []).length === 0)) bad('must match at least one of the allowed shapes');
  if (Array.isArray(s['oneOf'])) {
    const n = (s['oneOf'] as Schema[]).filter((sub) => validateValue(sub, value, resolve, path, depth + 1, []).length === 0).length;
    if (n !== 1) bad(n === 0 ? 'must match one of the allowed shapes' : `matches ${n} of the allowed shapes; it must match exactly one`);
  }
  if (s['not'] !== undefined && validateValue(s['not'] as Schema, value, resolve, path, depth + 1, []).length === 0) bad('must not match the excluded shape');
  return out;
}

/** A sample value that fits the schema: a declared example or default if there is one, else the simplest valid value. */
export function exampleFor(schema: Schema, resolve: Resolver = () => undefined, depth = 0): unknown {
  if (typeof schema === 'boolean' || depth > 6) return null;
  const s = schema as Obj;
  if ('example' in s) return s['example'];
  if (Array.isArray(s['examples']) && s['examples'].length) return s['examples'][0];
  if ('default' in s) return s['default'];
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum']) && s['enum'].length) return s['enum'][0];
  if (typeof s['$ref'] === 'string') {
    const t = resolve(s['$ref']);
    return t === undefined ? null : exampleFor(t, resolve, depth + 1);
  }
  if (Array.isArray(s['allOf'])) {
    const parts = (s['allOf'] as Schema[]).map((x) => exampleFor(x, resolve, depth + 1));
    return parts.every(isObj) ? Object.assign({}, ...parts) : parts[0];
  }
  for (const k of ['oneOf', 'anyOf'] as const) if (Array.isArray(s[k]) && (s[k] as Schema[]).length) return exampleFor((s[k] as Schema[])[0]!, resolve, depth + 1);
  const t = Array.isArray(s['type']) ? ((s['type'] as string[]).find((x) => x !== 'null') ?? 'null') : (s['type'] as string | undefined) ?? (isObj(s['properties']) ? 'object' : undefined);
  switch (t) {
    case 'string': {
      const fmt = typeof s['format'] === 'string' ? s['format'] : '';
      const sample = ({ 'date-time': '2026-01-01T00:00:00Z', date: '2026-01-01', email: 'user@example.com', uuid: '00000000-0000-4000-8000-000000000000', uri: 'https://example.com/', ipv4: '192.0.2.1' } as Record<string, string>)[fmt];
      if (sample) return sample;
      let v = 'string';
      const min = typeof s['minLength'] === 'number' ? s['minLength'] : 0;
      const max = typeof s['maxLength'] === 'number' ? s['maxLength'] : Infinity;
      while ([...v].length < min) v += 'a';
      return [...v].slice(0, max).join('');
    }
    case 'integer':
    case 'number': {
      let v = typeof s['minimum'] === 'number' ? s['minimum'] : typeof s['exclusiveMinimum'] === 'number' ? s['exclusiveMinimum'] + 1 : 0;
      if (typeof s['maximum'] === 'number' && v > s['maximum']) v = s['maximum'];
      if (typeof s['multipleOf'] === 'number' && s['multipleOf'] > 0) v = Math.ceil(v / s['multipleOf']) * s['multipleOf'];
      return v;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const n = Math.max(typeof s['minItems'] === 'number' ? s['minItems'] : 0, s['items'] === undefined ? 0 : 1);
      return Array.from({ length: n }, () => (s['items'] === undefined ? null : exampleFor(s['items'] as Schema, resolve, depth + 1)));
    }
    case 'object': {
      const props = isObj(s['properties']) ? (s['properties'] as Record<string, Schema>) : {};
      const o: Obj = {};
      for (const [k, v] of Object.entries(props)) o[k] = exampleFor(v, resolve, depth + 1);
      return o;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the document

export type Method = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
const METHODS: readonly Method[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export interface Param {
  readonly schema: Schema;
  readonly required?: boolean;
  readonly description?: string;
  readonly example?: unknown;
  readonly deprecated?: boolean;
}
export interface ResponseDecl {
  readonly description: string;
  readonly schema?: Schema;
  readonly contentType?: string;
  readonly example?: unknown;
  readonly headers?: Readonly<Record<string, { readonly schema: Schema; readonly description?: string; readonly required?: boolean }>>;
}
export interface RouteDecl {
  readonly method: Method;
  /** With {braces} for path parameters: /users/{id}. */
  readonly path: string;
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly pathParams?: Readonly<Record<string, Schema>>;
  readonly query?: Readonly<Record<string, Param>>;
  readonly headers?: Readonly<Record<string, Param>>;
  readonly body?: { readonly schema: Schema; readonly required?: boolean; readonly contentType?: string; readonly example?: unknown };
  /** By status: '200', '404', '2XX' or 'default'. */
  readonly responses: Readonly<Record<string, ResponseDecl>>;
  /** Security scheme names (with scopes), or 'none' for an open operation. Default: the document's. */
  readonly security?: readonly (string | { readonly name: string; readonly scopes?: readonly string[] })[] | 'none';
  readonly deprecated?: boolean;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string; [k: string]: unknown };
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, Obj>>;
  components?: { schemas?: Record<string, Schema>; securitySchemes?: Record<string, Obj>; parameters?: Record<string, Obj>; [k: string]: unknown };
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
  [k: string]: unknown;
}

export interface BuildOptions {
  readonly info: { readonly title: string; readonly version?: string; readonly description?: string };
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  readonly routes: readonly RouteDecl[];
  readonly schemas?: Readonly<Record<string, Schema>>;
  readonly securitySchemes?: Readonly<Record<string, Obj>>;
  /** Applied to every operation that does not say otherwise. */
  readonly security?: readonly (string | { readonly name: string; readonly scopes?: readonly string[] })[];
  readonly tags?: readonly { readonly name: string; readonly description?: string }[];
  /** Add these error statuses (as RFC 9457 problem details) to every operation that does not declare them. */
  readonly problems?: readonly number[];
  readonly versions?: Versions;
}

const PROBLEM: Schema = obj(
  { type: str({ format: 'uri-reference' as never, description: 'A URI naming the kind of problem.' }), title: str(), status: int({ minimum: 100, maximum: 599 }), detail: str(), instance: str() },
  { required: ['title', 'status'], additionalProperties: true },
);
const PROBLEM_TITLES: Readonly<Record<number, string>> = { 400: 'Bad request', 401: 'Not authenticated', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict', 412: 'Precondition failed', 415: 'Unsupported media type', 422: 'Invalid input', 429: 'Too many requests', 500: 'Server error', 503: 'Unavailable' };

const secReq = (list: NonNullable<RouteDecl['security']> | readonly (string | { name: string; scopes?: readonly string[] })[]) =>
  (list as readonly (string | { name: string; scopes?: readonly string[] })[]).map((x) => (typeof x === 'string' ? { [x]: [] as string[] } : { [x.name]: [...(x.scopes ?? [])] }));

/** The OpenAPI 3.1 document for a set of routes. Throws InvalidApi, listing every problem, if it would not be sound. */
export function build(o: BuildOptions): OpenApiDocument {
  const problems: string[] = [];
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: o.info.title, version: o.info.version ?? o.versions?.latest ?? '', ...(o.info.description ? { description: o.info.description } : {}), ...(o.versions ? { 'x-api-versions': [...o.versions.known], 'x-api-notes': o.versions.notes } : {}) },
    ...(o.servers?.length ? { servers: o.servers.map((s) => ({ ...s })) } : {}),
    paths: {},
    components: { schemas: { ...(o.schemas ?? {}) } },
  };
  if (!doc.info.version) problems.push('info.version is required: give a version or pass apiver versions');
  const comps = doc.components!;
  if (o.securitySchemes) comps.securitySchemes = { ...o.securitySchemes };
  if (o.security) doc.security = secReq(o.security);
  if (o.tags) doc.tags = o.tags.map((t) => ({ ...t }));
  if (o.problems?.length) comps.schemas!['Problem'] = PROBLEM;
  if (o.versions) comps.parameters = { ApiVersion: { name: 'API-Version', in: 'header', required: false, description: `The API version to answer at; the latest, ${o.versions.latest}, if left out.`, schema: { type: 'string', enum: [...o.versions.known] } } };

  const seenOps = new Map<string, string>();
  for (const r of o.routes) {
    const where = `${r.method.toUpperCase()} ${r.path}`;
    if (!METHODS.includes(r.method)) problems.push(`${where}: "${r.method}" is not an HTTP method OpenAPI knows`);
    if (!r.path.startsWith('/')) problems.push(`${where}: the path must start with /`);
    if (seenOps.has(r.operationId)) problems.push(`${where}: the operationId "${r.operationId}" is already used by ${seenOps.get(r.operationId)}`);
    seenOps.set(r.operationId, where);
    const item = (doc.paths[r.path] ??= {});
    if (item[r.method]) {
      problems.push(`${where}: declared twice`);
      continue;
    }
    const template = [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const declared = Object.keys(r.pathParams ?? {});
    for (const t of template) if (!declared.includes(t)) problems.push(`${where}: the path has {${t}} but no pathParams entry for it`);
    for (const d of declared) if (!template.includes(d)) problems.push(`${where}: pathParams "${d}" is not in the path`);
    const parameters: Obj[] = [];
    for (const t of template) if (r.pathParams?.[t] !== undefined) parameters.push({ name: t, in: 'path', required: true, schema: r.pathParams[t] });
    for (const [n, p] of Object.entries(r.query ?? {})) parameters.push({ name: n, in: 'query', ...(p.required ? { required: true } : {}), ...(p.description ? { description: p.description } : {}), ...(p.deprecated ? { deprecated: true } : {}), schema: p.schema, ...(p.example !== undefined ? { example: p.example } : {}) });
    for (const [n, p] of Object.entries(r.headers ?? {})) parameters.push({ name: n, in: 'header', ...(p.required ? { required: true } : {}), ...(p.description ? { description: p.description } : {}), schema: p.schema, ...(p.example !== undefined ? { example: p.example } : {}) });
    if (o.versions) parameters.push({ $ref: '#/components/parameters/ApiVersion' });
    const responses: Record<string, Obj> = {};
    for (const [code, resp] of Object.entries(r.responses)) {
      responses[code] = {
        description: resp.description,
        ...(resp.headers ? { headers: Object.fromEntries(Object.entries(resp.headers).map(([h, d]) => [h, { ...(d.description ? { description: d.description } : {}), ...(d.required ? { required: true } : {}), schema: d.schema }])) } : {}),
        ...(resp.schema !== undefined ? { content: { [resp.contentType ?? 'application/json']: { schema: resp.schema, ...(resp.example !== undefined ? { example: resp.example } : {}) } } } : {}),
      };
    }
    for (const code of o.problems ?? []) {
      if (responses[String(code)] || responses['default']) continue;
      responses[String(code)] = { description: PROBLEM_TITLES[code] ?? `Error ${code}`, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } };
    }
    const op: Obj = {
      operationId: r.operationId,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.tags?.length ? { tags: [...r.tags] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(r.body ? { requestBody: { required: r.body.required ?? true, content: { [r.body.contentType ?? 'application/json']: { schema: r.body.schema, ...(r.body.example !== undefined ? { example: r.body.example } : {}) } } } } : {}),
      responses,
      ...(r.security === 'none' ? { security: [] } : r.security ? { security: secReq(r.security) } : {}),
      ...(r.deprecated ? { deprecated: true } : {}),
      ...Object.fromEntries(Object.entries(r.extensions ?? {}).filter(([k]) => k.startsWith('x-'))),
    };
    item[r.method] = op;
  }
  const checked = check(doc);
  problems.push(...checked.errors.map((e) => `${e.path || '(document)'}: ${e.message}`));
  if (problems.length) throw new InvalidApi([...new Set(problems)]);
  return doc;
}

// ---------------------------------------------------------------- checking

export interface Findings {
  readonly errors: readonly Problem[];
  readonly warnings: readonly Problem[];
}

function resolverFor(doc: OpenApiDocument): Resolver {
  return (r) => {
    const m = /^#\/components\/schemas\/([^/]+)$/.exec(r);
    return m && Object.hasOwn(doc.components?.schemas ?? {}, m[1]!) ? doc.components!.schemas![m[1]!] : undefined;
  };
}

const ptr = (...parts: string[]) => `/${parts.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

/** Every rule the builder enforces, applied to any OpenAPI 3.1 document. */
export function check(doc: OpenApiDocument): Findings {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  if (typeof doc.openapi !== 'string' || !/^3\.1\.\d+$/.test(doc.openapi)) err('/openapi', `must be 3.1.x, not ${JSON.stringify(doc.openapi)}`);
  if (!isObj(doc.info) || !doc.info.title) err('/info/title', 'is required');
  if (!isObj(doc.info) || !doc.info.version) err('/info/version', 'is required');
  if (!isObj(doc.paths)) {
    err('/paths', 'is required');
    return { errors, warnings };
  }
  const resolve = resolverFor(doc);
  const usedRefs = new Set<string>();
  const schemaRefs = (s: unknown, at: string, depth = 0) => {
    if (depth > 40 || !isObj(s)) {
      if (Array.isArray(s)) s.forEach((x, i) => schemaRefs(x, `${at}/${i}`, depth + 1));
      return;
    }
    if ('nullable' in s) err(at, '"nullable" is OpenAPI 3.0; in 3.1 use a type list such as ["string","null"]');
    if (typeof s['$ref'] === 'string') {
      const r = s['$ref'];
      if (!r.startsWith('#/')) err(at, `the reference ${r} is not inside this document`);
      else if (r.startsWith('#/components/schemas/')) {
        usedRefs.add(r.slice('#/components/schemas/'.length));
        if (!resolve(r)) err(at, `the reference ${r} does not exist`);
      } else if (r.startsWith('#/components/parameters/')) {
        if (!Object.hasOwn(doc.components?.parameters ?? {}, r.slice('#/components/parameters/'.length))) err(at, `the reference ${r} does not exist`);
      } else err(at, `the reference ${r} is not a components reference`);
    }
    for (const [k, v] of Object.entries(s)) if (['properties', 'patternProperties', '$defs'].includes(k) && isObj(v)) for (const [pk, pv] of Object.entries(v)) schemaRefs(pv, `${at}/${k}/${pk}`, depth + 1);
    else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'].includes(k)) schemaRefs(v, `${at}/${k}`, depth + 1);
    else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(k)) schemaRefs(v, `${at}/${k}`, depth + 1);
  };
  const checkExample = (schema: unknown, example: unknown, at: string) => {
    if (schema === undefined) return;
    for (const p of validateValue(schema as Schema, example, resolve)) err(`${at}${p.path}`, `the example ${p.message}`);
  };
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) schemaRefs(s, ptr('components', 'schemas', name));
  const opIds = new Map<string, string>();
  const schemes = Object.keys(doc.components?.securitySchemes ?? {});
  const checkSecurity = (sec: unknown, at: string) => {
    if (!Array.isArray(sec)) return;
    for (const req of sec) if (isObj(req)) for (const n of Object.keys(req)) if (!schemes.includes(n)) err(at, `the security scheme "${n}" is not declared in components.securitySchemes`);
  };
  checkSecurity(doc.security, '/security');
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/')) err(ptr('paths', path), 'a path must start with /');
    const template = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    for (const [method, opRaw] of Object.entries(item)) {
      if (['parameters', 'summary', 'description', 'servers'].includes(method) || method.startsWith('x-')) continue;
      const at = ptr('paths', path, method);
      if (!METHODS.includes(method as Method)) {
        err(at, `"${method}" is not an HTTP method`);
        continue;
      }
      const op = opRaw as Obj;
      if (typeof op['operationId'] === 'string') {
        if (opIds.has(op['operationId'])) err(`${at}/operationId`, `"${op['operationId']}" is also used by ${opIds.get(op['operationId'])}`);
        opIds.set(op['operationId'], at);
      } else warn(`${at}/operationId`, 'an operationId lets generated clients name this operation');
      const params = Array.isArray(op['parameters']) ? (op['parameters'] as Obj[]) : [];
      const seen = new Set<string>();
      const inPath = new Set<string>();
      params.forEach((p, i) => {
        const pa = `${at}/parameters/${i}`;
        if (typeof p['$ref'] === 'string') {
          schemaRefs(p, pa);
          return;
        }
        const key = `${String(p['in'])}:${String(p['name'])}`;
        if (seen.has(key)) err(pa, `the ${String(p['in'])} parameter "${String(p['name'])}" is declared twice`);
        seen.add(key);
        if (!['path', 'query', 'header', 'cookie'].includes(p['in'] as string)) err(`${pa}/in`, 'must be path, query, header or cookie');
        if (p['in'] === 'path') {
          inPath.add(String(p['name']));
          if (p['required'] !== true) err(`${pa}/required`, 'a path parameter is always required');
        }
        schemaRefs(p['schema'], `${pa}/schema`);
        if (p['example'] !== undefined) checkExample(p['schema'], p['example'], `${pa}/example`);
      });
      for (const t of template) if (!inPath.has(t)) err(`${at}/parameters`, `the path has {${t}} but no path parameter "${t}" is declared`);
      for (const p of inPath) if (!template.includes(p)) err(`${at}/parameters`, `the path parameter "${p}" is not in the path`);
      const body = op['requestBody'];
      if (isObj(body)) {
        if (method === 'get' || method === 'head' || method === 'delete') warn(`${at}/requestBody`, `a request body on ${method.toUpperCase()} has no defined meaning`);
        for (const [ct, media] of Object.entries(isObj(body['content']) ? body['content'] : {})) {
          const m = media as Obj;
          schemaRefs(m['schema'], `${at}/requestBody/content/${ct}/schema`);
          if (m['example'] !== undefined) checkExample(m['schema'], m['example'], `${at}/requestBody/content/${ct}/example`);
        }
      }
      const responses = op['responses'];
      if (!isObj(responses) || !Object.keys(responses).length) err(`${at}/responses`, 'an operation needs at least one response');
      else {
        if (!Object.keys(responses).some((c) => /^2/.test(c) || c === 'default')) warn(`${at}/responses`, 'no success response is declared');
        for (const [code, rr] of Object.entries(responses)) {
          const ra = `${at}/responses/${code}`;
          if (!/^(?:[1-5]\d\d|[1-5]XX|default)$/.test(code)) err(ra, `"${code}" is not a status code, a range like 2XX, or default`);
          const r = rr as Obj;
          if (!r['description']) err(`${ra}/description`, 'is required');
          if ((code === '204' || code === '304') && isObj(r['content'])) err(`${ra}/content`, `a ${code} response has no body`);
          for (const [ct, media] of Object.entries(isObj(r['content']) ? r['content'] : {})) {
            const m = media as Obj;
            schemaRefs(m['schema'], `${ra}/content/${ct}/schema`);
            if (m['example'] !== undefined) checkExample(m['schema'], m['example'], `${ra}/content/${ct}/example`);
          }
        }
      }
      checkSecurity(op['security'], `${at}/security`);
    }
  }
  for (const name of Object.keys(doc.components?.schemas ?? {})) if (!usedRefs.has(name) && name !== 'Problem') warn(ptr('components', 'schemas', name), 'is never referenced');
  return { errors, warnings };
}

// ---------------------------------------------------------------- comparing

export type Severity = 'breaking' | 'warning' | 'non-breaking' | 'info';
export interface Change {
  readonly severity: Severity;
  readonly rule: string;
  /** Where, as METHOD /path and a location inside it. */
  readonly where: string;
  readonly message: string;
}

type Dir = 'request' | 'response';

function flatten(s: Schema, resolve: Resolver, depth = 0): Obj {
  if (typeof s === 'boolean') return s ? {} : { not: {} };
  let cur = s as Obj;
  let n = 0;
  while (typeof cur['$ref'] === 'string' && n++ < 20) {
    const t = resolve(cur['$ref']);
    if (t === undefined) return {};
    cur = typeof t === 'boolean' ? {} : (t as Obj);
  }
  if (Array.isArray(cur['allOf']) && depth < 10) {
    const merged: Obj = { ...cur };
    delete merged['allOf'];
    for (const part of cur['allOf'] as Schema[]) {
      const f = flatten(part, resolve, depth + 1);
      for (const [k, v] of Object.entries(f)) {
        if (k === 'properties' && isObj(v)) merged['properties'] = { ...(isObj(merged['properties']) ? merged['properties'] : {}), ...v };
        else if (k === 'required' && Array.isArray(v)) merged['required'] = [...new Set([...(Array.isArray(merged['required']) ? (merged['required'] as string[]) : []), ...(v as string[])])];
        else if (!(k in merged)) merged[k] = v;
      }
    }
    return merged;
  }
  return cur;
}

const typesOf = (s: Obj): string[] | null => (s['type'] === undefined ? null : (Array.isArray(s['type']) ? (s['type'] as string[]) : [s['type'] as string]).slice().sort());

/** Compares two schemas for one direction and reports what changed that a client or server could feel. */
function diffSchema(a: Schema, b: Schema, dir: Dir, where: string, ra: Resolver, rb: Resolver, out: Change[], depth = 0): void {
  if (depth > 20) return;
  const x = flatten(a, ra);
  const y = flatten(b, rb);
  const push = (severity: Severity, rule: string, message: string) => out.push({ severity, rule, where, message });
  // What the receiver of the data must now handle: for a request that is the server, for a response the client.
  const tighten = (rule: string, what: string, loosenedIsBreaking: boolean) => push(loosenedIsBreaking ? 'breaking' : 'non-breaking', rule, what);

  const tx = typesOf(x);
  const ty = typesOf(y);
  if (tx && ty && tx.join() !== ty.join()) {
    const added = ty.filter((t) => !tx.includes(t));
    const removed = tx.filter((t) => !ty.includes(t));
    const widenOnly = removed.length === 0 || (removed.length === 1 && removed[0] === 'integer' && ty.includes('number'));
    // New allowed types widen what is sent (response: breaking) or accepted (request: fine); removed types the reverse.
    if (added.length && widenOnly) push(dir === 'response' ? 'breaking' : 'non-breaking', 'type-widened', `${added.join(', ')} is now allowed (was ${tx.join(' or ')})`);
    else if (removed.length && !added.length) push(dir === 'request' ? 'breaking' : 'non-breaking', 'type-narrowed', `${removed.join(', ')} is no longer allowed (was ${tx.join(' or ')})`);
    else push('breaking', 'type-changed', `the type changed from ${tx.join(' or ')} to ${ty.join(' or ')}`);
  } else if (!tx && ty) push(dir === 'request' ? 'breaking' : 'non-breaking', 'type-constrained', `the type is now ${ty.join(' or ')}`);
  else if (tx && !ty) push(dir === 'response' ? 'breaking' : 'non-breaking', 'type-unconstrained', `the type is no longer constrained (was ${tx.join(' or ')})`);

  const ex = Array.isArray(x['enum']) ? (x['enum'] as unknown[]) : null;
  const ey = Array.isArray(y['enum']) ? (y['enum'] as unknown[]) : null;
  if (ex && ey) {
    const gone = ex.filter((v) => !ey.some((w) => sameJson(v, w)));
    const fresh = ey.filter((v) => !ex.some((w) => sameJson(v, w)));
    if (gone.length) push(dir === 'request' ? 'breaking' : 'non-breaking', 'enum-value-removed', `${gone.map((v) => JSON.stringify(v)).join(', ')} no longer allowed`);
    if (fresh.length) push(dir === 'response' ? 'breaking' : 'non-breaking', 'enum-value-added', `${fresh.map((v) => JSON.stringify(v)).join(', ')} now ${dir === 'response' ? 'possible; clients must handle new values' : 'accepted'}`);
  } else if (!ex && ey) push(dir === 'request' ? 'breaking' : 'non-breaking', 'enum-added', 'the values are now limited to a list');
  else if (ex && !ey) push(dir === 'response' ? 'breaking' : 'non-breaking', 'enum-removed', 'the values are no longer limited to a list');

  // Numeric and length limits: an upper bound that drops or a lower bound that rises is a tightening.
  const limit = (key: string, kind: 'max' | 'min') => {
    const va = x[key];
    const vb = y[key];
    if (typeof va !== 'number' && typeof vb !== 'number') return;
    const tight = (a1: number | undefined, b1: number | undefined) => (b1 !== undefined && (a1 === undefined || (kind === 'max' ? b1 < a1 : b1 > a1)) ? 'tighter' : a1 !== undefined && (b1 === undefined || (kind === 'max' ? b1 > a1 : b1 < a1)) ? 'looser' : 'same');
    const t = tight(typeof va === 'number' ? va : undefined, typeof vb === 'number' ? vb : undefined);
    if (t === 'same') return;
    const msg = `${key} ${typeof va === 'number' ? va : 'unset'} -> ${typeof vb === 'number' ? vb : 'unset'}`;
    if (t === 'tighter') tighten(`${key}-tightened`, msg, dir === 'request');
    else tighten(`${key}-loosened`, msg, dir === 'response');
  };
  limit('maximum', 'max');
  limit('minimum', 'min');
  limit('exclusiveMaximum', 'max');
  limit('exclusiveMinimum', 'min');
  limit('maxLength', 'max');
  limit('minLength', 'min');
  limit('maxItems', 'max');
  limit('minItems', 'min');
  for (const k of ['pattern', 'format'] as const) {
    if (x[k] !== y[k]) {
      if (y[k] !== undefined && x[k] === undefined) tighten(`${k}-added`, `${k} ${JSON.stringify(y[k])} added`, dir === 'request');
      else if (y[k] === undefined) tighten(`${k}-removed`, `${k} ${JSON.stringify(x[k])} removed`, dir === 'response');
      else push('breaking', `${k}-changed`, `${k} changed from ${JSON.stringify(x[k])} to ${JSON.stringify(y[k])}`);
    }
  }

  // Object properties.
  const px = isObj(x['properties']) ? (x['properties'] as Record<string, Schema>) : {};
  const py = isObj(y['properties']) ? (y['properties'] as Record<string, Schema>) : {};
  const rx = new Set(Array.isArray(x['required']) ? (x['required'] as string[]) : []);
  const ry = new Set(Array.isArray(y['required']) ? (y['required'] as string[]) : []);
  for (const k of Object.keys(px)) {
    if (!Object.hasOwn(py, k)) {
      if (dir === 'response') push('breaking', 'property-removed', `"${k}" is no longer returned`);
      else push(y['additionalProperties'] === false ? 'breaking' : 'warning', 'property-removed', `"${k}" is no longer accepted`);
    } else {
      const sub: Change[] = [];
      diffSchema(px[k]!, py[k]!, dir, `${where}/${k}`, ra, rb, sub, depth + 1);
      out.push(...sub);
      if (rx.has(k) && !ry.has(k)) push(dir === 'response' ? 'breaking' : 'non-breaking', 'property-now-optional', `"${k}" is no longer always present`);
      if (!rx.has(k) && ry.has(k)) push(dir === 'request' ? 'breaking' : 'non-breaking', 'property-now-required', `"${k}" is now required`);
    }
  }
  for (const k of Object.keys(py)) {
    if (Object.hasOwn(px, k)) continue;
    if (dir === 'request') push(ry.has(k) ? 'breaking' : 'non-breaking', ry.has(k) ? 'required-property-added' : 'property-added', `"${k}" is ${ry.has(k) ? 'now required' : 'accepted'}`);
    else push('non-breaking', 'property-added', `"${k}" is now returned`);
  }
  if (x['additionalProperties'] !== y['additionalProperties'] && (x['additionalProperties'] === false || y['additionalProperties'] === false)) {
    if (y['additionalProperties'] === false) push(dir === 'request' ? 'breaking' : 'non-breaking', 'additional-properties-closed', 'unknown properties are no longer allowed');
    else push(dir === 'response' ? 'warning' : 'non-breaking', 'additional-properties-opened', 'unknown properties are now allowed');
  }
  if (x['items'] !== undefined && y['items'] !== undefined) diffSchema(x['items'] as Schema, y['items'] as Schema, dir, `${where}[]`, ra, rb, out, depth + 1);

  // Alternatives: a response that can be a new shape is a break for clients, a request that accepts one is not.
  for (const key of ['oneOf', 'anyOf'] as const) {
    const lx = Array.isArray(x[key]) ? (x[key] as Schema[]) : null;
    const ly = Array.isArray(y[key]) ? (y[key] as Schema[]) : null;
    if (lx && ly) {
      const sig = (s: Schema, r: Resolver) => JSON.stringify(flatten(s, r));
      const sx = lx.map((s) => sig(s, ra));
      const sy = ly.map((s) => sig(s, rb));
      const removed = sx.filter((s) => !sy.includes(s)).length;
      const added = sy.filter((s) => !sx.includes(s)).length;
      if (removed) push(dir === 'request' ? 'breaking' : 'non-breaking', `${key}-option-removed`, `${removed} alternative${removed > 1 ? 's' : ''} removed`);
      if (added) push(dir === 'response' ? 'breaking' : 'non-breaking', `${key}-option-added`, `${added} alternative${added > 1 ? 's' : ''} added`);
    }
  }
}

const opsOf = (doc: OpenApiDocument): Map<string, { path: string; method: string; op: Obj; item: Obj }> => {
  const out = new Map<string, { path: string; method: string; op: Obj; item: Obj }>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) for (const [method, op] of Object.entries(item)) if (METHODS.includes(method as Method)) out.set(`${method.toUpperCase()} ${path}`, { path, method, op: op as Obj, item });
  return out;
};

function paramsOf(op: Obj, item: Obj, doc: OpenApiDocument): Map<string, Obj> {
  const m = new Map<string, Obj>();
  const take = (list: unknown) => {
    for (const p of Array.isArray(list) ? list : []) {
      let q = p as Obj;
      if (typeof q['$ref'] === 'string') {
        const n = /^#\/components\/parameters\/(.+)$/.exec(q['$ref'])?.[1];
        const t = n && Object.hasOwn(doc.components?.parameters ?? {}, n) ? doc.components!.parameters![n] : undefined;
        if (!t) continue;
        q = t as Obj;
      }
      m.set(`${String(q['in'])}:${String(q['name'])}`, q);
    }
  };
  take(item['parameters']);
  take(op['parameters']);
  return m;
}

/** Every change between two versions of an API description, classified by what it does to existing clients and servers. */
export function diff(before: OpenApiDocument, after: OpenApiDocument): Change[] {
  const out: Change[] = [];
  const ra = resolverFor(before);
  const rb = resolverFor(after);
  const A = opsOf(before);
  const B = opsOf(after);
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) {
      const pathGone = !Object.hasOwn(after.paths ?? {}, a.path);
      out.push({ severity: 'breaking', rule: pathGone ? 'path-removed' : 'operation-removed', where: k, message: pathGone ? 'the path no longer exists' : 'the operation no longer exists' });
      continue;
    }
    const at = (loc: string) => (loc ? `${k} ${loc.slice(1)}` : k);
    const add = (severity: Severity, rule: string, loc: string, message: string) => out.push({ severity, rule, where: at(loc), message });
    if (a.op['operationId'] !== b.op['operationId']) add('warning', 'operation-id-changed', '', `operationId ${JSON.stringify(a.op['operationId'])} -> ${JSON.stringify(b.op['operationId'])}; generated clients rename the method`);
    if (b.op['deprecated'] === true && a.op['deprecated'] !== true) add('info', 'deprecated', '', 'the operation is now deprecated');
    // Parameters.
    const pa = paramsOf(a.op, a.item, before);
    const pb = paramsOf(b.op, b.item, after);
    for (const [pk, p] of pa) {
      const q = pb.get(pk);
      if (!q) {
        add(p['required'] === true ? 'non-breaking' : 'breaking', 'parameter-removed', `/${pk}`, `the ${String(p['in'])} parameter "${String(p['name'])}" is no longer accepted`);
        continue;
      }
      if (p['required'] !== true && q['required'] === true) add('breaking', 'parameter-now-required', `/${pk}`, `"${String(q['name'])}" is now required`);
      if (p['required'] === true && q['required'] !== true) add('non-breaking', 'parameter-now-optional', `/${pk}`, `"${String(q['name'])}" is now optional`);
      if (p['schema'] !== undefined && q['schema'] !== undefined) diffSchema(p['schema'] as Schema, q['schema'] as Schema, 'request', at(`/${pk}`), ra, rb, out);
    }
    for (const [pk, q] of pb) if (!pa.has(pk)) add(q['required'] === true ? 'breaking' : 'non-breaking', q['required'] === true ? 'required-parameter-added' : 'parameter-added', `/${pk}`, `the ${String(q['in'])} parameter "${String(q['name'])}" ${q['required'] === true ? 'is required' : 'is accepted'}`);
    // Request body.
    const ba = a.op['requestBody'] as Obj | undefined;
    const bb = b.op['requestBody'] as Obj | undefined;
    if (!ba && bb) add(bb['required'] !== false ? 'breaking' : 'non-breaking', bb['required'] !== false ? 'required-body-added' : 'body-added', '/body', 'a request body is now ' + (bb['required'] !== false ? 'required' : 'accepted'));
    else if (ba && !bb) add('breaking', 'body-removed', '/body', 'the request body is no longer accepted');
    else if (ba && bb) {
      if (ba['required'] === false && bb['required'] !== false) add('breaking', 'body-now-required', '/body', 'the request body is now required');
      const ca = isObj(ba['content']) ? (ba['content'] as Record<string, Obj>) : {};
      const cb = isObj(bb['content']) ? (bb['content'] as Record<string, Obj>) : {};
      for (const [ct, m] of Object.entries(ca)) {
        if (!cb[ct]) add('breaking', 'request-media-type-removed', `/body/${ct}`, `${ct} is no longer accepted`);
        else if (m['schema'] !== undefined && cb[ct]!['schema'] !== undefined) diffSchema(m['schema'] as Schema, cb[ct]!['schema'] as Schema, 'request', at(`/body/${ct}`), ra, rb, out);
      }
      for (const ct of Object.keys(cb)) if (!ca[ct]) add('non-breaking', 'request-media-type-added', `/body/${ct}`, `${ct} is now accepted`);
    }
    // Responses.
    const sa = isObj(a.op['responses']) ? (a.op['responses'] as Record<string, Obj>) : {};
    const sb = isObj(b.op['responses']) ? (b.op['responses'] as Record<string, Obj>) : {};
    for (const [code, r] of Object.entries(sa)) {
      const q = sb[code];
      if (!q) {
        add(/^2/.test(code) ? 'breaking' : 'warning', 'response-removed', `/${code}`, `the ${code} response is no longer declared`);
        continue;
      }
      const ca = isObj(r['content']) ? (r['content'] as Record<string, Obj>) : {};
      const cb = isObj(q['content']) ? (q['content'] as Record<string, Obj>) : {};
      for (const [ct, m] of Object.entries(ca)) {
        if (!cb[ct]) add('breaking', 'response-media-type-removed', `/${code}/${ct}`, `${ct} is no longer returned`);
        else if (m['schema'] !== undefined && cb[ct]!['schema'] !== undefined) diffSchema(m['schema'] as Schema, cb[ct]!['schema'] as Schema, 'response', at(`/${code}/${ct}`), ra, rb, out);
      }
      for (const [h, hd] of Object.entries(isObj(r['headers']) ? (r['headers'] as Record<string, Obj>) : {})) {
        const nh = isObj(q['headers']) ? (q['headers'] as Record<string, Obj>)[h] : undefined;
        if (!nh) add('breaking', 'response-header-removed', `/${code}/header/${h}`, `the ${h} header is no longer returned`);
        else if (hd['schema'] !== undefined && nh['schema'] !== undefined) diffSchema(hd['schema'] as Schema, nh['schema'] as Schema, 'response', at(`/${code}/header/${h}`), ra, rb, out);
      }
    }
    for (const code of Object.keys(sb)) if (!sa[code]) add('non-breaking', 'response-added', `/${code}`, `the ${code} response is now declared`);
    // Security: effective requirements, with the document's as the default.
    const secA = JSON.stringify(a.op['security'] ?? before.security ?? []);
    const secB = JSON.stringify(b.op['security'] ?? after.security ?? []);
    if (secA !== secB) {
      const was = (a.op['security'] ?? before.security ?? []) as unknown[];
      const now = (b.op['security'] ?? after.security ?? []) as unknown[];
      if (!was.length && now.length) add('breaking', 'security-added', '/security', 'the operation now needs authentication');
      else if (was.length && !now.length) add('non-breaking', 'security-removed', '/security', 'the operation no longer needs authentication');
      else add('warning', 'security-changed', '/security', 'the security requirements changed');
    }
  }
  for (const k of B.keys()) if (!A.has(k)) out.push({ severity: 'non-breaking', rule: 'operation-added', where: k, message: 'a new operation' });
  const order: Severity[] = ['breaking', 'warning', 'non-breaking', 'info'];
  return out.sort((p, q) => order.indexOf(p.severity) - order.indexOf(q.severity));
}

/** True when nothing in the changes would break an existing client or server. */
export const isBackwardCompatible = (changes: readonly Change[]): boolean => !changes.some((c) => c.severity === 'breaking');

// ---------------------------------------------------------------- contract tests

export interface Case {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  /** A request that fits the declaration: path parameters, required query and header values, and a body. */
  readonly request: {
    readonly url: string;
    readonly query: Readonly<Record<string, unknown>>;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
    readonly contentType?: string;
  };
  /** The statuses the document says this operation answers with. */
  readonly statuses: readonly string[];
}

function exampleOf(media: Obj | undefined, resolve: Resolver): unknown {
  if (!media) return undefined;
  if ('example' in media) return media['example'];
  if (isObj(media['examples'])) {
    const first = Object.values(media['examples'] as Obj)[0];
    if (isObj(first) && 'value' in first) return first['value'];
  }
  return media['schema'] === undefined ? undefined : exampleFor(media['schema'] as Schema, resolve);
}

/** One test case per operation, with a request built from the examples and schemas. */
export function contract(doc: OpenApiDocument): Case[] {
  const resolve = resolverFor(doc);
  const out: Case[] = [];
  for (const [, { path, method, op, item }] of opsOf(doc)) {
    let url = path;
    const query: Record<string, unknown> = {};
    const headers: Record<string, unknown> = {};
    for (const p of paramsOf(op, item, doc).values()) {
      const v = p['example'] !== undefined ? p['example'] : p['schema'] !== undefined ? exampleFor(p['schema'] as Schema, resolve) : 'x';
      if (p['in'] === 'path') url = url.replace(`{${String(p['name'])}}`, encodeURIComponent(String(v)));
      else if (p['in'] === 'query' && p['required'] === true) query[String(p['name'])] = v;
      else if (p['in'] === 'header' && p['required'] === true) headers[String(p['name'])] = v;
    }
    const body = isObj(op['requestBody']) ? (op['requestBody'] as Obj) : undefined;
    const content = body && isObj(body['content']) ? (body['content'] as Record<string, Obj>) : {};
    const ct = Object.keys(content)[0];
    out.push({
      operationId: String(op['operationId'] ?? `${method} ${path}`),
      method: method.toUpperCase(),
      path,
      request: { url, query, headers, ...(ct ? { body: exampleOf(content[ct], resolve), contentType: ct } : {}) },
      statuses: Object.keys(isObj(op['responses']) ? (op['responses'] as Obj) : {}),
    });
  }
  return out;
}

export interface ActualResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** Checks a real response against the document: a declared status, a declared content type, a body that fits, required headers present. */
export function verifyResponse(doc: OpenApiDocument, target: { operationId: string } | { method: string; path: string }, res: ActualResponse): Problem[] {
  const resolve = resolverFor(doc);
  const found = [...opsOf(doc).values()].find((o) => ('operationId' in target ? o.op['operationId'] === target.operationId : o.method === target.method.toLowerCase() && o.path === target.path));
  if (!found) return [{ path: '', message: 'the document has no such operation' }];
  const responses = (isObj(found.op['responses']) ? found.op['responses'] : {}) as Record<string, Obj>;
  const code = String(res.status);
  const decl = responses[code] ?? responses[`${code[0]}XX`] ?? responses['default'];
  if (!decl) return [{ path: `/${code}`, message: `status ${code} is not declared; the document declares ${Object.keys(responses).join(', ')}` }];
  const problems: Problem[] = [];
  const headers = Object.fromEntries(Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const [h, hd] of Object.entries(isObj(decl['headers']) ? (decl['headers'] as Record<string, Obj>) : {})) {
    const v = headers[h.toLowerCase()];
    if (v === undefined) {
      if (hd['required'] === true) problems.push({ path: `/header/${h}`, message: 'is required and was not sent' });
    } else if (hd['schema'] !== undefined) {
      const s = hd['schema'] as Obj;
      const t = s['type'];
      const typed = t === 'integer' || t === 'number' ? Number(v) : t === 'boolean' ? v === 'true' : v;
      for (const p of validateValue(s, typed, resolve)) problems.push({ path: `/header/${h}${p.path}`, message: p.message });
    }
  }
  const content = isObj(decl['content']) ? (decl['content'] as Record<string, Obj>) : {};
  const ctypes = Object.keys(content);
  if (!ctypes.length) {
    if (res.body !== undefined && res.body !== null && res.body !== '') problems.push({ path: '/body', message: `status ${code} declares no body but one was sent` });
    return problems;
  }
  const sent = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const media = content[sent] ?? content[ctypes.find((c) => c.toLowerCase() === sent) ?? ''] ?? (sent === '' ? undefined : content[`${sent.split('/')[0]}/*`]) ?? content['*/*'];
  if (!media) {
    problems.push({ path: '/header/content-type', message: `${sent || '(none)'} is not one of ${ctypes.join(', ')}` });
    return problems;
  }
  if (media['schema'] !== undefined) for (const p of validateValue(media['schema'] as Schema, res.body, resolve)) problems.push({ path: `/body${p.path}`, message: p.message });
  return problems;
}
