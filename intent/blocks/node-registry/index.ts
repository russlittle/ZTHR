/**
 * A typed catalogue of connectors ("nodes"): what each one is called, which versions exist, the operations each
 * version offers with their parameters described as JSON Schema, which credential types it accepts, and sample
 * data used as test fixtures. Parameters, credentials and sample outputs are checked with a small JSON Schema
 * validator that is part of this block (the Draft 2020-12 keywords that connector forms use: type, enum, const,
 * properties, required, additionalProperties, items, minimum/maximum, minLength/maxLength, pattern, minItems/
 * maxItems, oneOf, anyOf). Versions are whole numbers; an older version's saved parameters are carried forward by
 * declared steps (rename, remove, set) rather than by code, so the steps can be stored and reviewed. Secret
 * credential fields are never shown by `describeCredential` or `redactCredential`.
 *
 * Out of scope: running a node (the caller supplies an executor to `runFixtures`), $ref resolution, and
 * remote schema loading.
 */

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface JsonSchema {
  readonly type?: JsonType | readonly JsonType[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly default?: unknown;
  readonly description?: string;
}

export interface SchemaProblem {
  readonly path: string;
  readonly message: string;
}

const typeOf = (v: unknown): JsonType | 'undefined' =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : (typeof v as JsonType | 'undefined');

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every way a value breaks a schema, each with the path to it. An empty list means it fits. */
export function checkSchema(schema: JsonSchema, value: unknown, path = ''): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  const bad = (message: string) => out.push({ path: path || '/', message });
  const t = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as readonly JsonType[]) : [schema.type as JsonType];
    const fits = allowed.some((a) => a === t || (a === 'number' && t === 'integer'));
    if (!fits) {
      bad(`expected ${allowed.join(' or ')}, got ${t}`);
      return out;
    }
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) bad(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => sameJson(e, value))) bad(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) bad(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) bad(`must be at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) bad(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) bad(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) bad(`must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) bad(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(`must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...checkSchema(schema.items!, v, `${path}/${i}`)));
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!Object.hasOwn(obj, r) || obj[r] === undefined) out.push({ path: `${path}/${r}`, message: 'is required' });
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      if (sub) out.push(...checkSchema(sub, v, `${path}/${k}`));
      else if (schema.additionalProperties === false) out.push({ path: `${path}/${k}`, message: 'is not a known field' });
      else if (typeof schema.additionalProperties === 'object') out.push(...checkSchema(schema.additionalProperties, v, `${path}/${k}`));
    }
  }
  if (schema.oneOf) {
    const n = schema.oneOf.filter((s) => checkSchema(s, value, path).length === 0).length;
    if (n !== 1) bad(`must match exactly one alternative, matched ${n}`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => checkSchema(s, value, path).length === 0)) bad('must match at least one alternative');
  return out;
}

/** Fill declared defaults for missing fields, recursively through objects. Does not change its input. */
export function withDefaults(schema: JsonSchema, value: unknown): unknown {
  if (schema.properties && typeOf(value) === 'object') {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (out[k] === undefined && sub.default !== undefined) out[k] = structuredClone(sub.default);
      if (out[k] !== undefined) out[k] = withDefaults(sub, out[k]);
    }
    return out;
  }
  return value;
}

export class InvalidDefinition extends Error {}
export class UnknownNode extends Error {}
export class InvalidParameters extends Error {
  readonly problems: readonly SchemaProblem[];
  constructor(what: string, problems: readonly SchemaProblem[]) {
    super(`${what}: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    this.problems = problems;
  }
}

export interface CredentialType {
  readonly name: string;
  readonly displayName: string;
  readonly schema: JsonSchema;
  /** Field names that hold secrets; never displayed. */
  readonly secretFields: readonly string[];
  /** How the credential is applied to a request. */
  readonly authenticate: { readonly kind: 'bearer' | 'basic' | 'header' | 'query'; readonly field?: string; readonly name?: string };
}

export interface Operation {
  readonly name: string;
  readonly resource?: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly output?: JsonSchema;
  /** Marks operations that only read, so tooling can offer them in test mode. */
  readonly readOnly?: boolean;
}

export interface Fixture {
  readonly name: string;
  readonly operation: string;
  readonly parameters: unknown;
  /** Sample input item and the sample output the connector is documented to return. */
  readonly input?: unknown;
  readonly output: unknown;
}

export type Step =
  | { readonly rename: Readonly<Record<string, string>> }
  | { readonly remove: readonly string[] }
  | { readonly set: Readonly<Record<string, unknown>> };

export interface NodeVersion {
  readonly version: number;
  readonly deprecated?: string;
  readonly operations: readonly Operation[];
  /** Credential type names this version accepts. */
  readonly credentials: readonly string[];
  /** Steps that turn the previous version's saved parameters into this version's. */
  readonly migrateFromPrevious?: readonly Step[];
  readonly fixtures?: readonly Fixture[];
}

export interface NodeType {
  readonly name: string;
  readonly displayName: string;
  readonly group: 'trigger' | 'action' | 'transform' | 'flow';
  readonly versions: readonly NodeVersion[];
}

export class Registry {
  readonly #creds = new Map<string, CredentialType>();
  readonly #nodes = new Map<string, NodeType>();

  addCredentialType(c: CredentialType): void {
    if (!/^[a-z][A-Za-z0-9]*$/.test(c.name)) throw new InvalidDefinition(`credential type name ${c.name} must be camelCase letters and digits`);
    if (this.#creds.has(c.name)) throw new InvalidDefinition(`credential type ${c.name} is already registered`);
    for (const f of c.secretFields) if (!c.schema.properties || !Object.hasOwn(c.schema.properties, f)) throw new InvalidDefinition(`secret field ${f} is not in the schema of ${c.name}`);
    if (c.authenticate.kind !== 'basic' && c.authenticate.field && !c.schema.properties?.[c.authenticate.field]) throw new InvalidDefinition(`authenticate field ${c.authenticate.field} is not in ${c.name}`);
    this.#creds.set(c.name, c);
  }

  addNode(n: NodeType): void {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-zA-Z0-9-]*)*$/.test(n.name)) throw new InvalidDefinition(`node name ${n.name} is not a dotted lower-case name`);
    if (this.#nodes.has(n.name)) throw new InvalidDefinition(`node ${n.name} is already registered`);
    if (n.versions.length === 0) throw new InvalidDefinition(`${n.name} has no versions`);
    const seen = new Set<number>();
    let prev = 0;
    for (const v of n.versions) {
      if (!Number.isInteger(v.version) || v.version < 1) throw new InvalidDefinition(`${n.name} version ${v.version} must be a whole number from 1`);
      if (seen.has(v.version)) throw new InvalidDefinition(`${n.name} lists version ${v.version} twice`);
      if (v.version < prev) throw new InvalidDefinition(`${n.name} versions must be in ascending order`);
      seen.add(v.version);
      prev = v.version;
      const ops = new Set<string>();
      for (const o of v.operations) {
        if (ops.has(o.name)) throw new InvalidDefinition(`${n.name} v${v.version} has operation ${o.name} twice`);
        ops.add(o.name);
      }
      for (const c of v.credentials) if (!this.#creds.has(c)) throw new InvalidDefinition(`${n.name} v${v.version} names unknown credential type ${c}`);
    }
    this.#nodes.set(n.name, n);
  }

  /** The node at a version, or the newest non-deprecated one when no version is given. */
  node(name: string, version?: number): NodeVersion & { readonly node: NodeType } {
    const n = this.#nodes.get(name);
    if (!n) throw new UnknownNode(`no node called ${name}`);
    if (version === undefined) {
      const live = n.versions.filter((v) => v.deprecated === undefined);
      const pick = (live.length ? live : n.versions).at(-1)!;
      return { ...pick, node: n };
    }
    const v = n.versions.find((x) => x.version === version);
    if (!v) throw new UnknownNode(`${name} has no version ${version} (has ${n.versions.map((x) => x.version).join(', ')})`);
    return { ...v, node: n };
  }

  credentialType(name: string): CredentialType {
    const c = this.#creds.get(name);
    if (!c) throw new UnknownNode(`no credential type called ${name}`);
    return c;
  }

  /** Check an operation's parameters, filling declared defaults first. Returns the filled parameters. */
  validateParameters(name: string, version: number, operation: string, parameters: unknown): unknown {
    const v = this.node(name, version);
    const op = v.operations.find((o) => o.name === operation);
    if (!op) throw new UnknownNode(`${name} v${version} has no operation ${operation}`);
    const filled = withDefaults(op.parameters, parameters);
    const problems = checkSchema(op.parameters, filled);
    if (problems.length) throw new InvalidParameters(`${name} v${version} ${operation}`, problems);
    return filled;
  }

  /** Check a saved credential against its type, and that the node version accepts that type. */
  validateCredential(name: string, version: number, credentialType: string, data: unknown): void {
    const v = this.node(name, version);
    if (!v.credentials.includes(credentialType)) throw new InvalidParameters(`${name} v${version}`, [{ path: '/credential', message: `does not accept ${credentialType}` }]);
    const problems = checkSchema(this.credentialType(credentialType).schema, data);
    if (problems.length) throw new InvalidParameters(`credential ${credentialType}`, problems);
  }

  /** The credential with every secret field replaced, safe to show or log. */
  redactCredential(credentialType: string, data: Record<string, unknown>): Record<string, unknown> {
    const c = this.credentialType(credentialType);
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, c.secretFields.includes(k) ? '***' : v]));
  }

  /** What a credential form shows: field names and descriptions, marking which are secret. */
  describeCredential(credentialType: string): { displayName: string; fields: { name: string; secret: boolean; required: boolean; description?: string }[] } {
    const c = this.credentialType(credentialType);
    return {
      displayName: c.displayName,
      fields: Object.entries(c.schema.properties ?? {}).map(([name, s]) => ({
        name,
        secret: c.secretFields.includes(name),
        required: c.schema.required?.includes(name) ?? false,
        ...(s.description ? { description: s.description } : {}),
      })),
    };
  }

  /** Request headers or query additions that apply a credential to a call. */
  authenticate(credentialType: string, data: Record<string, unknown>): { headers: Record<string, string>; query: Record<string, string> } {
    const c = this.credentialType(credentialType);
    const a = c.authenticate;
    const headers: Record<string, string> = {};
    const query: Record<string, string> = {};
    const val = (f: string | undefined) => {
      const x = f === undefined ? undefined : data[f];
      if (typeof x !== 'string' || x === '') throw new InvalidParameters(`credential ${c.name}`, [{ path: `/${f ?? ''}`, message: 'is required' }]);
      return x;
    };
    if (a.kind === 'bearer') headers.authorization = `Bearer ${val(a.field)}`;
    else if (a.kind === 'basic') headers.authorization = `Basic ${Buffer.from(`${val('user')}:${val('password')}`).toString('base64')}`;
    else if (a.kind === 'header') headers[(a.name ?? 'x-api-key').toLowerCase()] = val(a.field);
    else query[a.name ?? 'api_key'] = val(a.field);
    return { headers, query };
  }

  /** Carry saved parameters from one version to a newer one through the declared steps. */
  migrate(name: string, parameters: Record<string, unknown>, from: number, to: number): Record<string, unknown> {
    const n = this.#nodes.get(name);
    if (!n) throw new UnknownNode(`no node called ${name}`);
    if (to < from) throw new InvalidDefinition(`cannot migrate ${name} backwards from ${from} to ${to}`);
    let cur: Record<string, unknown> = { ...parameters };
    for (const v of n.versions.filter((x) => x.version > from && x.version <= to)) {
      for (const s of v.migrateFromPrevious ?? []) {
        if ('rename' in s) for (const [a, b] of Object.entries(s.rename)) if (Object.hasOwn(cur, a)) { cur[b] = cur[a]; delete cur[a]; }
        if ('remove' in s) for (const k of s.remove) delete cur[k];
        if ('set' in s) cur = { ...cur, ...structuredClone(s.set) };
      }
    }
    return cur;
  }

  /** Browsable list, optionally filtered by group or by text in the name or operation descriptions. */
  catalogue(o: { group?: NodeType['group']; text?: string } = {}): { name: string; displayName: string; group: string; latest: number; deprecatedVersions: number[] }[] {
    const t = o.text?.toLowerCase();
    return [...this.#nodes.values()]
      .filter((n) => (o.group === undefined || n.group === o.group) && (!t || `${n.name} ${n.displayName} ${n.versions.flatMap((v) => v.operations.map((x) => x.description)).join(' ')}`.toLowerCase().includes(t)))
      .map((n) => ({ name: n.name, displayName: n.displayName, group: n.group, latest: n.versions.at(-1)!.version, deprecatedVersions: n.versions.filter((v) => v.deprecated !== undefined).map((v) => v.version) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Run every fixture through a caller-supplied executor and compare. Each fixture's parameters must be valid, its
   * sample output must fit the operation's output schema, and the executor must return exactly that output.
   */
  async runFixtures(executor: (call: { node: string; version: number; operation: string; parameters: unknown; input: unknown }) => Promise<unknown>): Promise<{ node: string; version: number; fixture: string; ok: boolean; problem?: string }[]> {
    const results: { node: string; version: number; fixture: string; ok: boolean; problem?: string }[] = [];
    for (const n of this.#nodes.values()) {
      for (const v of n.versions) {
        for (const f of v.fixtures ?? []) {
          const base = { node: n.name, version: v.version, fixture: f.name };
          const fail = (problem: string) => results.push({ ...base, ok: false, problem });
          const op = v.operations.find((o) => o.name === f.operation);
          if (!op) { fail(`unknown operation ${f.operation}`); continue; }
          const pp = checkSchema(op.parameters, withDefaults(op.parameters, f.parameters));
          if (pp.length) { fail(`parameters: ${pp[0]!.path} ${pp[0]!.message}`); continue; }
          const op2 = op.output ? checkSchema(op.output, f.output) : [];
          if (op2.length) { fail(`sample output: ${op2[0]!.path} ${op2[0]!.message}`); continue; }
          try {
            const got = await executor({ node: n.name, version: v.version, operation: f.operation, parameters: withDefaults(op.parameters, f.parameters), input: f.input ?? null });
            if (!sameJson(got, f.output)) fail('executor output differs from the sample');
            else results.push({ ...base, ok: true });
          } catch (e) {
            fail(`executor threw: ${(e as Error).message}`);
          }
        }
      }
    }
    return results;
  }
}
