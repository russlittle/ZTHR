/**
 * The part of JSON-LD that federation needs: expand a document with its contexts, compact it back against a context
 * you choose, and normalise what remote servers send into one predictable shape (`id` and `type` as plain strings,
 * references as ids, extension terms kept).
 *
 * This is deliberately not a full processor. It supports `@context` (URLs, objects, arrays, null), term definitions
 * with `@id`, `@type` coercion, `@container` of `@list`, `@set` and `@language`, compact IRIs, `@vocab`, `@base`,
 * `@language`, keyword aliases, `@graph`, value objects and list objects. It refuses what it does not do (`@reverse`,
 * `@nest`, scoped contexts, `@json`) with an error instead of guessing.
 *
 * The risk in JSON-LD for a server is the context: a processor that fetches whatever URL a remote document names
 * is an outbound request on a stranger's say-so, and a hostile context can redefine terms so that `id` or `to` mean
 * something else. So contexts are only loaded from an allow-list (the ActivityStreams and security contexts are
 * built in as subsets), never fetched from anywhere else, cached by URL with a size limit and expiry, and bounded in
 * depth, size and number. Identifiers are never rewritten: an `@id` comes out the way it went in, because it may be
 * the thing a signature covers.
 */

export class JsonLdError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const AS = 'https://www.w3.org/ns/activitystreams';
export const SECURITY = 'https://w3id.org/security/v1';
export const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

const AS_NS = 'https://www.w3.org/ns/activitystreams#';
const ref = (id: string): Obj => ({ '@id': id, '@type': '@id' });
const refs = (id: string, extra: Obj = {}): Obj => ({ '@id': id, '@type': '@id', ...extra });
const asTypes = ['Accept', 'Add', 'Announce', 'Arrive', 'Block', 'Create', 'Delete', 'Dislike', 'Flag', 'Follow', 'Ignore', 'Invite', 'Join', 'Leave', 'Like', 'Listen', 'Move', 'Offer', 'Question', 'Read', 'Reject', 'Remove', 'TentativeAccept', 'TentativeReject', 'Travel', 'Undo', 'Update', 'View', 'Activity', 'IntransitiveActivity', 'Application', 'Group', 'Organization', 'Person', 'Service', 'Article', 'Audio', 'Document', 'Event', 'Image', 'Note', 'Page', 'Place', 'Profile', 'Relationship', 'Tombstone', 'Video', 'Mention', 'Collection', 'CollectionPage', 'OrderedCollection', 'OrderedCollectionPage', 'Link', 'Object'];

/** A subset of the ActivityStreams 2.0 context: the terms federation uses. Unknown terms become blank node properties, as in the real one. */
const AS_CONTEXT: Obj = {
  '@vocab': '_:',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  as: AS_NS,
  ldp: 'http://www.w3.org/ns/ldp#',
  id: '@id',
  type: '@type',
  ...Object.fromEntries(asTypes.map((t) => [t, `as:${t}`])),
  actor: ref('as:actor'),
  attributedTo: ref('as:attributedTo'),
  attachment: ref('as:attachment'),
  audience: ref('as:audience'),
  bcc: ref('as:bcc'),
  bto: ref('as:bto'),
  cc: ref('as:cc'),
  to: ref('as:to'),
  context: ref('as:context'),
  current: ref('as:current'),
  first: ref('as:first'),
  generator: ref('as:generator'),
  icon: ref('as:icon'),
  image: ref('as:image'),
  inReplyTo: ref('as:inReplyTo'),
  instrument: ref('as:instrument'),
  last: ref('as:last'),
  location: ref('as:location'),
  items: ref('as:items'),
  oneOf: ref('as:oneOf'),
  anyOf: ref('as:anyOf'),
  closed: { '@id': 'as:closed', '@type': 'xsd:dateTime' },
  origin: ref('as:origin'),
  next: ref('as:next'),
  object: ref('as:object'),
  prev: ref('as:prev'),
  preview: ref('as:preview'),
  replies: ref('as:replies'),
  result: ref('as:result'),
  partOf: ref('as:partOf'),
  tag: ref('as:tag'),
  target: ref('as:target'),
  url: { '@id': 'as:url', '@type': '@id' },
  orderedItems: refs('as:items', { '@container': '@list' }),
  content: 'as:content',
  contentMap: { '@id': 'as:content', '@container': '@language' },
  name: 'as:name',
  nameMap: { '@id': 'as:name', '@container': '@language' },
  summary: 'as:summary',
  summaryMap: { '@id': 'as:summary', '@container': '@language' },
  published: { '@id': 'as:published', '@type': 'xsd:dateTime' },
  updated: { '@id': 'as:updated', '@type': 'xsd:dateTime' },
  startTime: { '@id': 'as:startTime', '@type': 'xsd:dateTime' },
  endTime: { '@id': 'as:endTime', '@type': 'xsd:dateTime' },
  deleted: { '@id': 'as:deleted', '@type': 'xsd:dateTime' },
  totalItems: { '@id': 'as:totalItems', '@type': 'xsd:nonNegativeInteger' },
  width: { '@id': 'as:width', '@type': 'xsd:nonNegativeInteger' },
  height: { '@id': 'as:height', '@type': 'xsd:nonNegativeInteger' },
  mediaType: 'as:mediaType',
  preferredUsername: 'as:preferredUsername',
  href: { '@id': 'as:href', '@type': '@id' },
  hreflang: 'as:hreflang',
  rel: 'as:rel',
  duration: { '@id': 'as:duration', '@type': 'xsd:duration' },
  sensitive: 'as:sensitive',
  inbox: { '@id': 'ldp:inbox', '@type': '@id' },
  outbox: ref('as:outbox'),
  following: ref('as:following'),
  followers: ref('as:followers'),
  streams: ref('as:streams'),
  endpoints: ref('as:endpoints'),
  sharedInbox: ref('as:sharedInbox'),
  proxyUrl: ref('as:proxyUrl'),
  oauthAuthorizationEndpoint: ref('as:oauthAuthorizationEndpoint'),
  oauthTokenEndpoint: ref('as:oauthTokenEndpoint'),
};

/** A subset of the security vocabulary context: public keys and their owners. */
const SECURITY_CONTEXT: Obj = {
  sec: 'https://w3id.org/security#',
  dc: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  id: '@id',
  type: '@type',
  CryptographicKey: 'sec:Key',
  publicKey: { '@id': 'sec:publicKey', '@type': '@id' },
  publicKeyPem: 'sec:publicKeyPem',
  owner: { '@id': 'sec:owner', '@type': '@id' },
  created: { '@id': 'dc:created', '@type': 'xsd:dateTime' },
  creator: { '@id': 'dc:creator', '@type': '@id' },
  revoked: { '@id': 'sec:revoked', '@type': 'xsd:dateTime' },
  expires: { '@id': 'sec:expiration', '@type': 'xsd:dateTime' },
};

export const BUILT_IN: Readonly<Record<string, Obj>> = { [AS]: { '@context': AS_CONTEXT }, [SECURITY]: { '@context': SECURITY_CONTEXT } };

// ------------------------------------------------------------ loading contexts

export interface LoaderOptions {
  /** URLs a document may name as a context. The built-in ones are always allowed. */
  readonly allow?: readonly string[];
  /** Documents for allowed URLs, given up front. */
  readonly documents?: Readonly<Record<string, Json>>;
  /** Fetches an allowed URL not held locally. Without it, such a URL is an error. */
  readonly fetch?: (url: string) => Promise<Json>;
  readonly ttlMs?: number;
  readonly max?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export class ContextLoader {
  private readonly allowed: Set<string>;
  private readonly local = new Map<string, Json>();
  private readonly cache = new Map<string, { until: number; doc: Json }>();
  private readonly inflight = new Map<string, Promise<Json>>();
  private readonly o: LoaderOptions;
  private readonly now: () => number;

  constructor(o: LoaderOptions = {}) {
    this.o = o;
    this.now = o.now ?? Date.now;
    for (const [k, v] of Object.entries(BUILT_IN)) this.local.set(k, v);
    for (const [k, v] of Object.entries(o.documents ?? {})) this.local.set(k, v);
    this.allowed = new Set([...Object.keys(BUILT_IN), ...(o.allow ?? []), ...Object.keys(o.documents ?? {})]);
  }

  isAllowed(url: string): boolean {
    return this.allowed.has(url);
  }

  size(): number {
    return this.cache.size;
  }

  async load(url: string): Promise<Json> {
    if (!this.allowed.has(url)) throw new JsonLdError('context-not-allowed', `${url} is not an allowed context`);
    const here = this.local.get(url);
    if (here !== undefined) return here;
    const hit = this.cache.get(url);
    if (hit && hit.until > this.now()) return hit.doc;
    if (!this.o.fetch) throw new JsonLdError('context-unavailable', `${url} is allowed but there is no way to fetch it`);
    const running = this.inflight.get(url);
    if (running) return running;
    const p = (async () => {
      try {
        const doc = await (this.o.fetch as (u: string) => Promise<Json>)(url);
        const size = JSON.stringify(doc)?.length ?? 0;
        if (size > (this.o.maxBytes ?? 200_000)) throw new JsonLdError('context-too-large', `${url} is larger than the limit`);
        if (!isObj(doc) || !('@context' in doc)) throw new JsonLdError('context-invalid', `${url} is not a context document`);
        if (this.cache.size >= (this.o.max ?? 100)) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(url, { until: this.now() + (this.o.ttlMs ?? 86_400_000), doc });
        return doc;
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, p);
    return p;
  }
}

// ------------------------------------------------------------ active context

export interface Term {
  readonly id: string;
  readonly type?: string;
  readonly container?: '@list' | '@set' | '@language';
  readonly prefix: boolean;
}

export interface Context {
  readonly terms: ReadonlyMap<string, Term | null>;
  readonly vocab?: string;
  readonly base?: string;
  readonly language?: string;
}

export interface Limits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTerms: number;
  readonly maxContextDepth: number;
}

export const LIMITS: Limits = { maxDepth: 32, maxNodes: 20_000, maxTerms: 2_000, maxContextDepth: 4 };

export interface Options {
  readonly loader?: ContextLoader;
  readonly base?: string;
  readonly limits?: Partial<Limits>;
}

const KEYWORDS = new Set(['@context', '@id', '@type', '@value', '@language', '@list', '@set', '@graph', '@vocab', '@base', '@container', '@index', '@reverse', '@nest', '@included', '@json', '@none', '@prefix', '@protected', '@version', '@direction', '@import', '@propagate']);
const UNSUPPORTED = new Set(['@reverse', '@nest', '@included', '@json', '@import', '@direction']);
const FORBIDDEN_TERMS = new Set(['__proto__', 'constructor', 'prototype']);
const isAbsolute = (s: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s);
const GENDELIMS = /[:/?#[\]@]$/;

interface State {
  readonly loader: ContextLoader;
  readonly limits: Limits;
  nodes: number;
}

const emptyContext = (base?: string): Context => ({ terms: new Map(), ...(base ? { base } : {}) });

async function processContext(active: Context, local: Json | undefined, st: State, depth = 0, chain: readonly string[] = []): Promise<Context> {
  if (local === undefined) return active;
  if (depth > st.limits.maxContextDepth) throw new JsonLdError('context-depth', 'contexts refer to contexts too deeply');
  if (local === null) return emptyContext(active.base);
  if (Array.isArray(local)) {
    let ctx = active;
    for (const item of local) ctx = await processContext(ctx, item, st, depth, chain);
    return ctx;
  }
  if (typeof local === 'string') {
    if (chain.includes(local)) throw new JsonLdError('context-cycle', `${local} includes itself`);
    const doc = await st.loader.load(local);
    if (!isObj(doc) || !('@context' in doc)) throw new JsonLdError('context-invalid', `${local} is not a context document`);
    return processContext(active, doc['@context'] as Json, st, depth + 1, [...chain, local]);
  }
  if (!isObj(local)) throw new JsonLdError('context-invalid', 'a context is a URL, an object, null or an array of those');
  const terms = new Map(active.terms);
  let vocab = active.vocab;
  let base = active.base;
  let language = active.language;
  if ('@vocab' in local) {
    const v = local['@vocab'];
    if (v === null) vocab = undefined;
    else if (typeof v === 'string') vocab = v === '' ? (active.vocab ?? undefined) : v;
    else throw new JsonLdError('context-invalid', '@vocab must be a string or null');
  }
  if ('@base' in local) {
    const b = local['@base'];
    if (b === null) base = undefined;
    else if (typeof b === 'string') base = b;
    else throw new JsonLdError('context-invalid', '@base must be a string or null');
  }
  if ('@language' in local) {
    const l = local['@language'];
    if (l === null) language = undefined;
    else if (typeof l === 'string') language = l.toLowerCase();
    else throw new JsonLdError('context-invalid', '@language must be a string or null');
  }
  const keys = Object.keys(local).filter((k) => !['@vocab', '@base', '@language', '@version', '@protected', '@propagate'].includes(k));
  if (terms.size + keys.length > st.limits.maxTerms) throw new JsonLdError('context-too-large', 'the context defines too many terms');
  const partial = (): Context => ({ terms, ...(vocab !== undefined ? { vocab } : {}), ...(base !== undefined ? { base } : {}) });
  const pending = new Set<string>();
  const defined = new Set<string>();
  const define = (key: string): void => {
    if (defined.has(key)) return;
    if (pending.has(key)) throw new JsonLdError('cyclic-iri-mapping', `the term ${key} is defined in terms of itself`);
    pending.add(key);
    try {
      if (FORBIDDEN_TERMS.has(key)) throw new JsonLdError('invalid-term', `${key} cannot be a term`);
      if (key.startsWith('@')) throw new JsonLdError('keyword-redefinition', `${key} is a keyword and cannot be redefined`);
      if (key === '') throw new JsonLdError('invalid-term', 'a term cannot be empty');
      const raw = local[key] as Json;
      if (raw === null) {
        terms.set(key, null);
        return;
      }
      const def: Obj = typeof raw === 'string' ? { '@id': raw } : isObj(raw) ? raw : (() => {
        throw new JsonLdError('invalid-term', `the definition of ${key} is not a string, object or null`);
      })();
      for (const k of Object.keys(def)) {
        if (UNSUPPORTED.has(k) || k === '@context') throw new JsonLdError('unsupported', `${k} in a term definition is not supported`);
        if (!['@id', '@type', '@container', '@prefix', '@protected', '@language', '@index'].includes(k)) throw new JsonLdError('invalid-term', `${k} is not valid in the definition of ${key}`);
      }
      // prefixes defined later in this same context must be available to expand a compact IRI
      const expandPart = (s: string): string => {
        if (s.startsWith('@')) {
          if (!KEYWORDS.has(s)) throw new JsonLdError('invalid-iri', `${s} is not a keyword`);
          return s;
        }
        const colon = s.indexOf(':');
        if (colon > 0 && !s.startsWith('_:') && !s.slice(colon + 1).startsWith('//')) {
          const p = s.slice(0, colon);
          if (p in local && p !== key) define(p);
        }
        if (s === key) throw new JsonLdError('cyclic-iri-mapping', `${key} maps to itself`);
        if (s in local && !s.startsWith('@') && s !== key) define(s);
        const out = expandIri(partial(), s, { vocab: true, defineLater: true });
        if (out === undefined || (!isAbsolute(out) && !out.startsWith('@'))) throw new JsonLdError('invalid-iri', `${s} does not expand to an IRI`);
        return out;
      };
      let id: string;
      if ('@id' in def) {
        if (def['@id'] === null) {
          terms.set(key, null);
          return;
        }
        if (typeof def['@id'] !== 'string') throw new JsonLdError('invalid-term', '@id must be a string');
        id = expandPart(def['@id']);
      } else if (key.includes(':') && !key.startsWith('_:')) {
        id = expandPart(key);
      } else if (vocab !== undefined) {
        id = `${vocab}${key}`;
      } else throw new JsonLdError('invalid-term', `${key} has no IRI: give it an @id or set @vocab`);
      let type: string | undefined;
      if ('@type' in def) {
        const t = def['@type'];
        if (typeof t !== 'string') throw new JsonLdError('invalid-term', '@type must be a string');
        if (t === '@json' || t === '@none') throw new JsonLdError('unsupported', `a term type of ${t} is not supported`);
        type = t === '@id' || t === '@vocab' ? t : expandPart(t);
      }
      let container: Term['container'];
      if ('@container' in def) {
        const c = def['@container'];
        if (c !== '@list' && c !== '@set' && c !== '@language') throw new JsonLdError('unsupported', `a container of ${JSON.stringify(c)} is not supported`);
        container = c;
      }
      const prefix = typeof def['@prefix'] === 'boolean' ? def['@prefix'] : !key.includes(':') && typeof raw === 'string' ? GENDELIMS.test(id) || id.startsWith('_:') === false && /[#/:]$/.test(id) : false;
      terms.set(key, { id, ...(type !== undefined ? { type } : {}), ...(container !== undefined ? { container } : {}), prefix });
    } finally {
      pending.delete(key);
      defined.add(key);
    }
  };
  for (const k of keys) define(k);
  return { terms, ...(vocab !== undefined ? { vocab } : {}), ...(base !== undefined ? { base } : {}), ...(language !== undefined ? { language } : {}) };
}

/** Expands a string to an absolute IRI, a blank node id or a keyword; undefined when the term is blocked. */
export function expandIri(ctx: Context, value: string, o: { vocab?: boolean; defineLater?: boolean } = {}): string | undefined {
  if (value.startsWith('@')) return value;
  if (o.vocab && ctx.terms.has(value)) return ctx.terms.get(value)?.id;
  const colon = value.indexOf(':');
  if (colon > 0) {
    const prefix = value.slice(0, colon);
    const suffix = value.slice(colon + 1);
    if (prefix === '_' || suffix.startsWith('//')) return value;
    const t = ctx.terms.get(prefix);
    if (t && t.prefix) return t.id + suffix;
    if (isAbsolute(value)) return value;
  }
  if (o.vocab && ctx.vocab !== undefined) return ctx.vocab + value;
  if (!o.vocab && ctx.base !== undefined) {
    try {
      return new URL(value, ctx.base).href;
    } catch {
      return value;
    }
  }
  return value;
}

// ------------------------------------------------------------ expansion

export type Expanded = Obj;

function checkNode(st: State, depth: number): void {
  if (depth > st.limits.maxDepth) throw new JsonLdError('too-deep', `the document nests deeper than ${st.limits.maxDepth}`);
  if (++st.nodes > st.limits.maxNodes) throw new JsonLdError('too-large', `the document has more than ${st.limits.maxNodes} nodes`);
}

const pushAll = (target: Json[], more: Json | Json[]) => (Array.isArray(more) ? target.push(...more) : target.push(more));

async function expandValue(ctx: Context, prop: Term | null | undefined, v: Json, st: State, depth: number): Promise<Json[]> {
  if (v === null) return [];
  if (Array.isArray(v)) {
    const out: Json[] = [];
    let each = prop;
    if (prop?.container === '@list') {
      const { container: _c, ...rest } = prop;
      each = rest;
    }
    for (const item of v) pushAll(out, await expandValue(ctx, each, item, st, depth + 1));
    return prop?.container === '@list' ? [{ '@list': out }] : out;
  }
  if (isObj(v)) {
    const r = await expandNode(ctx, v, st, depth + 1, prop);
    return r === undefined ? [] : [r];
  }
  if (prop?.type === '@id') return [{ '@id': expandIri(ctx, String(v)) ?? String(v) }];
  if (prop?.type === '@vocab') return [{ '@id': expandIri(ctx, String(v), { vocab: true }) ?? String(v) }];
  const single: Obj = { '@value': v };
  if (prop?.type) single['@type'] = prop.type;
  else if (typeof v === 'string' && ctx.language) single['@language'] = ctx.language;
  return prop?.container === '@list' ? [{ '@list': [single] }] : [single];
}

async function expandNode(parent: Context, node: Obj, st: State, depth: number, via?: Term | null): Promise<Obj | undefined> {
  checkNode(st, depth);
  const ctx = '@context' in node ? await processContext(parent, node['@context'], st) : parent;
  const keyOf = (k: string): string | undefined => (k.startsWith('@') ? k : expandIri(ctx, k, { vocab: true }));
  const entries = Object.keys(node)
    .filter((k) => k !== '@context')
    .map((k) => [k, keyOf(k), node[k] as Json] as const)
    .sort((a, b) => (a[1] === '@type' ? -1 : b[1] === '@type' ? 1 : 0));
  if (entries.some(([, e]) => e === '@value')) return expandValueObject(ctx, entries, st);
  const out: Obj = {};
  for (const [key, exp, value] of entries) {
    if (exp === undefined || exp === null) continue;
    if (exp.startsWith('@')) {
      if (!KEYWORDS.has(exp)) throw new JsonLdError('invalid-keyword', `${exp} is not a keyword`);
      if (UNSUPPORTED.has(exp)) throw new JsonLdError('unsupported', `${exp} is not supported`);
    }
    switch (exp) {
      case '@id':
        if (typeof value !== 'string') throw new JsonLdError('invalid-id', '@id must be a string');
        out['@id'] = expandIri(ctx, value) ?? value;
        continue;
      case '@type': {
        const ts = Array.isArray(value) ? value : [value];
        if (!ts.every((t) => typeof t === 'string')) throw new JsonLdError('invalid-type', '@type must be a string or strings');
        out['@type'] = ts.map((t) => expandIri(ctx, t as string, { vocab: true }) ?? (t as string));
        continue;
      }
      case '@graph':
        out['@graph'] = await expandValue(ctx, null, value, st, depth);
        continue;
      case '@list': {
        const inner = await expandValue(ctx, { id: '', container: '@list', prefix: false }, value, st, depth);
        return { '@list': (inner[0] as Obj | undefined)?.['@list'] ?? [] };
      }
      case '@set':
        return { '@set': await expandValue(ctx, null, value, st, depth) };
      case '@index':
        continue;
      case '@language':
      case '@value':
        throw new JsonLdError('invalid-value-object', `${exp} is only valid in a value object`);
      default:
        if (exp.startsWith('@')) continue;
    }
    if (!isAbsolute(exp) && !exp.startsWith('_:')) continue; // a term that expands to nothing usable is dropped, as the spec says
    const term = ctx.terms.get(key) ?? undefined;
    let values: Json[];
    if (term?.container === '@language' && isObj(value)) {
      values = [];
      for (const [lang, v] of Object.entries(value)) for (const s of Array.isArray(v) ? v : [v]) if (s !== null) {
        if (typeof s !== 'string') throw new JsonLdError('invalid-language-map', 'a language map has strings');
        values.push({ '@value': s, '@language': lang.toLowerCase() });
      }
    } else values = await expandValue(ctx, term, value, st, depth);
    if (values.length === 0) continue;
    const have = (out[exp] as Json[] | undefined) ?? [];
    out[exp] = [...have, ...values];
  }
  void via;
  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === '@graph' && depth === 0) return out;
  return out;
}

function expandValueObject(ctx: Context, entries: readonly (readonly [string, string | undefined, Json])[], st: State): Obj {
  const out: Obj = {};
  for (const [, exp, v] of entries) {
    if (exp === '@value') {
      if (v !== null && typeof v === 'object') throw new JsonLdError('invalid-value-object', '@value must be a scalar');
      out['@value'] = v;
    } else if (exp === '@type') {
      if (typeof v !== 'string') throw new JsonLdError('invalid-typed-value', 'a value object has one @type');
      out['@type'] = expandIri(ctx, v, { vocab: true }) ?? v;
    } else if (exp === '@language') {
      if (typeof v !== 'string') throw new JsonLdError('invalid-language', '@language must be a string');
      out['@language'] = v.toLowerCase();
    } else if (exp === '@index') continue;
    else throw new JsonLdError('invalid-value-object', `a value object cannot have ${exp ?? 'that key'}`);
  }
  void st;
  if (out['@value'] === null) return {};
  if ('@language' in out && '@type' in out) throw new JsonLdError('invalid-value-object', 'a value object has a language or a type, not both');
  if ('@language' in out && typeof out['@value'] !== 'string') throw new JsonLdError('invalid-language-tagged-value', 'only a string has a language');
  return out;
}

/** The expanded form: an array of node objects with full IRIs, every property value an array. */
export async function expand(doc: Json, o: Options = {}): Promise<Expanded[]> {
  const st: State = { loader: o.loader ?? new ContextLoader(), limits: { ...LIMITS, ...o.limits }, nodes: 0 };
  const start = emptyContext(o.base);
  let items: Json[];
  if (Array.isArray(doc)) items = doc;
  else if (isObj(doc)) items = [doc];
  else throw new JsonLdError('invalid-document', 'a JSON-LD document is an object or an array');
  const result: Expanded[] = [];
  let ctx = start;
  if (isObj(doc) && '@context' in doc) ctx = await processContext(start, doc['@context'], st);
  for (const item of items) {
    if (!isObj(item)) continue;
    const r = await expandNode(ctx, item, st, 0);
    if (!r) continue;
    const keys = Object.keys(r);
    if (keys.length === 1 && keys[0] === '@graph') result.push(...((r['@graph'] as Expanded[]) ?? []));
    else if (keys.length === 0 || (keys.length === 1 && keys[0] === '@id') || '@value' in r) continue; // free floating
    else result.push(r);
  }
  return result;
}

// ------------------------------------------------------------ compaction

export interface CompactOptions extends Options {
  /** Keep single values as arrays. */
  readonly compactArrays?: boolean;
}

interface Inverse {
  readonly alias: Map<string, string>;
  readonly byIri: Map<string, [string, Term][]>;
}

function inverse(ctx: Context): Inverse {
  const alias = new Map<string, string>();
  const byIri = new Map<string, [string, Term][]>();
  for (const [name, t] of ctx.terms) {
    if (!t) continue;
    if (t.id.startsWith('@')) {
      const cur = alias.get(t.id);
      if (cur === undefined || name.length < cur.length || (name.length === cur.length && name < cur)) alias.set(t.id, name);
      continue;
    }
    (byIri.get(t.id) ?? byIri.set(t.id, []).get(t.id))!.push([name, t]);
  }
  return { alias, byIri };
}

function compactIri(ctx: Context, inv: Inverse, iri: string, vocab: boolean): string {
  if (vocab) {
    const exact = inv.byIri.get(iri)?.filter(([, t]) => !t.container && !t.type).sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))[0];
    if (exact) return exact[0];
    if (ctx.vocab !== undefined && iri.startsWith(ctx.vocab) && iri.length > ctx.vocab.length) {
      const rest = iri.slice(ctx.vocab.length);
      if (!ctx.terms.has(rest) && !rest.includes(':')) return rest;
    }
  }
  let best: string | undefined;
  for (const [name, t] of ctx.terms) {
    if (!t || !t.prefix || name === iri || !iri.startsWith(t.id) || iri.length === t.id.length) continue;
    const candidate = `${name}:${iri.slice(t.id.length)}`;
    if (ctx.terms.has(candidate)) continue;
    if (best === undefined || candidate.length < best.length || (candidate.length === best.length && candidate < best)) best = candidate;
  }
  return best ?? iri;
}

type Item = Json;
const isValue = (v: Item): v is Obj => isObj(v) && '@value' in v;
const isRef = (v: Item): v is Obj => isObj(v) && '@id' in v && Object.keys(v).length === 1;
const isList = (v: Item): v is Obj => isObj(v) && '@list' in v;

function fits(t: Term, v: Item): number {
  if (isList(v)) return t.container === '@list' ? 3 : 0;
  if (t.container === '@list') return 0;
  if (isValue(v)) {
    if (typeof v['@language'] === 'string') return t.container === '@language' ? 3 : t.type === undefined && t.container === undefined ? 1 : 0;
    if (t.container === '@language') return 0;
    if (typeof v['@type'] === 'string') return t.type === v['@type'] ? 3 : t.type === undefined ? 1 : 0;
    return t.type === undefined ? 2 : 0;
  }
  if (t.container === '@language') return 0;
  if (isRef(v)) return t.type === '@id' ? 3 : t.type === undefined ? 1 : 0;
  return t.type === undefined || t.type === '@id' ? 1 : 0;
}

function pickTerm(inv: Inverse, iri: string, values: readonly Item[]): [string, Term] | undefined {
  const cands = inv.byIri.get(iri);
  if (!cands) return undefined;
  let best: { score: number; c: [string, Term] } | undefined;
  for (const c of cands) {
    let score = Infinity;
    for (const v of values) score = Math.min(score, fits(c[1], v));
    if (values.length === 0 || score === 0) continue;
    if (!best || score > best.score || (score === best.score && (c[0].length < best.c[0].length || (c[0].length === best.c[0].length && c[0] < best.c[0])))) best = { score, c };
  }
  return best?.c;
}

function compactValue(ctx: Context, inv: Inverse, term: Term | undefined, v: Item, arrays: boolean): Json {
  const kw = (k: string) => inv.alias.get(k) ?? k;
  if (isList(v)) {
    const items = (v['@list'] as Item[]).map((x) => compactValue(ctx, inv, term && term.container === '@list' ? { ...term, container: undefined as never } : undefined, x, arrays));
    return term?.container === '@list' ? items : { '@list': items };
  }
  if (isValue(v)) {
    const lang = v['@language'];
    const ty = v['@type'];
    if (typeof lang === 'string' && (term?.container === '@language' || (lang === ctx.language && term?.type === undefined))) return v['@value'] as Json;
    if (typeof ty === 'string') return term?.type === ty ? (v['@value'] as Json) : { '@value': v['@value'] as Json, '@type': compactIri(ctx, inv, ty, true) };
    if (typeof lang === 'string') return { '@value': v['@value'] as Json, '@language': lang };
    return v['@value'] as Json;
  }
  if (isRef(v)) {
    const id = v['@id'] as string;
    // an id is left exactly as it was: it may be what a signature covers
    if (term?.type === '@id') return id;
    if (term?.type === '@vocab') return compactIri(ctx, inv, id, true);
    return { [kw('@id')]: id };
  }
  return compactNode(ctx, inv, v as unknown as Obj, arrays);
}

function compactNode(ctx: Context, inv: Inverse, node: Obj, arrays: boolean): Obj {
  const kw = (k: string) => inv.alias.get(k) ?? k;
  const out: Obj = {};
  const put = (k: string, v: Json, forceArray: boolean) => {
    const cur = out[k];
    const merged = cur === undefined ? v : [...(Array.isArray(cur) ? cur : [cur]), ...(Array.isArray(v) ? v : [v])];
    out[k] = forceArray && !Array.isArray(merged) ? [merged] : merged;
  };
  if ('@id' in node) out[kw('@id')] = node['@id'] as Json;
  if ('@type' in node) {
    const ts = (node['@type'] as string[]).map((t) => compactIri(ctx, inv, t, true));
    out[kw('@type')] = ts.length === 1 && arrays ? (ts[0] as string) : ts;
  }
  if ('@graph' in node) out[kw('@graph')] = (node['@graph'] as Item[]).map((n) => compactValue(ctx, inv, undefined, n, arrays));
  for (const key of Object.keys(node)) {
    if (key.startsWith('@')) continue;
    // Each value picks its own term, as the spec does: a plain string and a language-tagged one under the same
    // property land under "content" and "contentMap".
    const groups = new Map<string, { term: Term | undefined; vals: Json[] }>();
    for (const v of node[key] as Item[]) {
      const picked = pickTerm(inv, key, [v]);
      const name = picked?.[0] ?? compactIri(ctx, inv, key, true);
      const term = picked?.[1];
      if (term?.container === '@language') {
        const map: Obj = (out[name] as Obj | undefined) ?? {};
        const lang = (v as Obj)['@language'] as string;
        const cur = map[lang];
        map[lang] = cur === undefined ? ((v as Obj)['@value'] as Json) : [...(Array.isArray(cur) ? cur : [cur]), (v as Obj)['@value'] as Json];
        out[name] = map;
        continue;
      }
      const g = groups.get(name) ?? groups.set(name, { term, vals: [] }).get(name)!;
      g.vals.push(compactValue(ctx, inv, term, v, arrays));
    }
    for (const [name, g] of groups) {
      if (g.term?.container === '@list') put(name, (g.vals[0] as Json) ?? [], false);
      else put(name, g.vals.length === 1 && arrays && g.term?.container !== '@set' ? (g.vals[0] as Json) : g.vals, g.term?.container === '@set');
    }
  }
  return out;
}

/**
 * Compacts expanded nodes against a context. One node gives that node with `@context` on it; several give an `@graph`.
 */
export async function compact(expanded: readonly Expanded[], context: Json, o: CompactOptions = {}): Promise<Obj> {
  const st: State = { loader: o.loader ?? new ContextLoader(), limits: { ...LIMITS, ...o.limits }, nodes: 0 };
  const ctx = await processContext(emptyContext(o.base), context, st);
  const inv = inverse(ctx);
  const arrays = o.compactArrays !== false;
  const nodes = expanded.map((n) => compactNode(ctx, inv, n, arrays));
  if (nodes.length === 1) return { '@context': context, ...(nodes[0] as Obj) };
  return { '@context': context, [inv.alias.get('@graph') ?? '@graph']: nodes };
}

export const FEDERATION_CONTEXT: Json = [AS, SECURITY];

/**
 * Reads a document from another server into the shape the rest of the code expects: contexts resolved from the
 * allow-list, `id` and `type` as plain strings, one name for each property, references as ids or nested objects, and
 * extension terms kept under their own names. A document whose contexts are not allowed is refused, not guessed at.
 */
export async function normalise(doc: Json, o: CompactOptions & { context?: Json } = {}): Promise<Obj> {
  const expanded = await expand(doc, o);
  if (expanded.length === 0) throw new JsonLdError('empty', 'the document has no nodes');
  return compact(expanded, o.context ?? FEDERATION_CONTEXT, o);
}

// ------------------------------------------------------------ helpers for activities

export const asArray = <T>(v: T | readonly T[] | null | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? [...(v as T[])] : [v as T]);

/** The id of a reference: a string is its own id, an object has an `id` (or `@id`). */
export function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (isObj(v as Json)) {
    const id = (v as Obj).id ?? (v as Obj)['@id'];
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/** The types of a node, from `type` or `@type`, as an array of strings. */
export function typesOf(node: unknown): string[] {
  if (!isObj(node as Json)) return [];
  const t = (node as Obj).type ?? (node as Obj)['@type'];
  return asArray(t as Json).filter((x): x is string => typeof x === 'string');
}

export const hasType = (node: unknown, ...types: string[]): boolean => typesOf(node).some((t) => types.includes(t));

/** Every id a field points at, whether it holds ids, objects, or a mix; the Public collection is left in. */
export const idsOf = (v: unknown): string[] => asArray(v as Json).map(idOf).filter((x): x is string => x !== undefined);

/**
 * A document must not claim an id on a host other than the one it came from, or anyone could publish a document that
 * speaks for someone else. `expectedUrl` is where it was fetched, or the actor a signature proved.
 */
export function assertSameOrigin(node: unknown, expectedUrl: string): void {
  const id = idOf(node);
  if (!id) throw new JsonLdError('no-id', 'the document has no id');
  let a: URL;
  let b: URL;
  try {
    a = new URL(id);
    b = new URL(expectedUrl);
  } catch {
    throw new JsonLdError('bad-id', `${id} or ${expectedUrl} is not a URL`);
  }
  if (a.origin !== b.origin) throw new JsonLdError('origin-mismatch', `the document says its id is on ${a.host}, but it came from ${b.host}`);
}
