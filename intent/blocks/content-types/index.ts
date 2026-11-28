/**
 * A content-model builder in the shape of Strapi's: content types (collections and single types) made of fields, reusable
 * components (a field group such as `shared.seo` used in many types, single or repeatable), dynamic zones (an ordered
 * list where each item is one of a set of allowed components, tagged `__component`), localisation (an entry has one
 * variant per locale; a field marked `localized: false` is shared and kept equal across the variants), and draft and
 * publish (every locale variant has a working draft and, once published, a frozen published copy; status is `draft`,
 * `published`, or `modified` when the draft has moved on).
 *
 * Field kinds: string, text, richtext, email, uid (a slug that can follow another field, made unique with -1, -2...),
 * integer, decimal, boolean, date, datetime, enumeration, json, media, relation, component, dynamiczone; with required,
 * unique, default, private, min and max, length limits and a regex.
 *
 * Rules: the registry refuses a definition whose component, relation target or dynamic-zone component does not exist,
 * and components that contain themselves (directly or around a loop); saving a draft checks every value's type and
 * limits and names every problem with its path (`body[1].title`), but does not demand required fields, which are
 * demanded when publishing; unknown fields are refused; uid and unique fields are unique within a locale; the id and
 * timestamps are the store's. The clock and id source are arguments.
 *
 * Out of scope: storage on disk, relation integrity beyond the id being a string, permissions, and rich-text rendering
 * (see the markdown and block-markup blocks).
 */

export class ContentModelError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export interface Problem {
  readonly path: string;
  readonly message: string;
}
export class ValidationFailed extends ContentModelError {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(`invalid content: ${problems.map((p) => `${p.path || '(entry)'}: ${p.message}`).join('; ')}`);
    this.problems = problems;
  }
}
export class NotFoundError extends ContentModelError {}

export type FieldKind =
  | 'string' | 'text' | 'richtext' | 'email' | 'uid' | 'integer' | 'decimal' | 'boolean' | 'date' | 'datetime'
  | 'enumeration' | 'json' | 'media' | 'relation' | 'component' | 'dynamiczone';

export interface Field {
  readonly kind: FieldKind;
  readonly required?: boolean;
  readonly unique?: boolean;
  readonly private?: boolean;
  /** For types with localisation: false means one value shared by every locale. Default true. */
  readonly localized?: boolean;
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly regex?: string;
  /** enumeration */
  readonly values?: readonly string[];
  /** uid: the field whose text the slug is made from */
  readonly targetField?: string;
  /** relation: the content type uid, and how many on each side */
  readonly target?: string;
  readonly relation?: 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany';
  /** component */
  readonly component?: string;
  readonly repeatable?: boolean;
  /** dynamiczone */
  readonly components?: readonly string[];
  /** media */
  readonly multiple?: boolean;
}

export interface ContentTypeDef {
  readonly uid: string;
  readonly kind?: 'collection' | 'single';
  readonly draftAndPublish?: boolean;
  readonly localized?: boolean;
  readonly fields: Readonly<Record<string, Field>>;
}
export interface ComponentDef {
  readonly uid: string;
  readonly fields: Readonly<Record<string, Field>>;
}

const UID = /^[a-z][a-z0-9-]*(?:[.:][a-z][a-z0-9-]*)*$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['id', 'documentId', 'locale', 'createdAt', 'updatedAt', 'publishedAt', '__component', 'status']);
const KINDS = new Set<string>(['string', 'text', 'richtext', 'email', 'uid', 'integer', 'decimal', 'boolean', 'date', 'datetime', 'enumeration', 'json', 'media', 'relation', 'component', 'dynamiczone']);

export class Registry {
  private readonly types = new Map<string, ContentTypeDef>();
  private readonly components = new Map<string, ComponentDef>();

  defineComponent(def: ComponentDef): void {
    this.checkUid(def.uid, 'component');
    if (!def.uid.includes('.')) throw new ContentModelError(`component uid "${def.uid}" must be "category.name"`);
    if (this.components.has(def.uid)) throw new ContentModelError(`component "${def.uid}" is already defined`);
    this.checkFields(def.fields, `component ${def.uid}`);
    this.components.set(def.uid, def);
  }

  defineType(def: ContentTypeDef): void {
    this.checkUid(def.uid, 'content type');
    if (this.types.has(def.uid)) throw new ContentModelError(`content type "${def.uid}" is already defined`);
    this.checkFields(def.fields, `type ${def.uid}`);
    if (def.kind !== undefined && def.kind !== 'collection' && def.kind !== 'single') throw new ContentModelError(`kind must be collection or single`);
    this.types.set(def.uid, { kind: 'collection', draftAndPublish: false, localized: false, ...def });
  }

  type(uid: string): ContentTypeDef {
    const t = this.types.get(uid);
    if (!t) throw new NotFoundError(`no content type "${uid}"`);
    return t;
  }
  component(uid: string): ComponentDef {
    const c = this.components.get(uid);
    if (!c) throw new NotFoundError(`no component "${uid}"`);
    return c;
  }
  listTypes(): string[] {
    return [...this.types.keys()].sort();
  }
  listComponents(): string[] {
    return [...this.components.keys()].sort();
  }

  /** Where each component is used: component uid to the types and components that hold it. */
  usage(): Record<string, string[]> {
    const out: Record<string, Set<string>> = {};
    const scan = (owner: string, fields: Readonly<Record<string, Field>>) => {
      for (const [name, f] of Object.entries(fields)) {
        for (const c of [...(f.component ? [f.component] : []), ...(f.components ?? [])]) (out[c] ??= new Set()).add(`${owner}.${name}`);
      }
    };
    for (const t of this.types.values()) scan(t.uid, t.fields);
    for (const c of this.components.values()) scan(c.uid, c.fields);
    return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, [...v].sort()]));
  }

  /** Problems across the whole model: references to things that do not exist, and components that contain themselves. Empty when sound. */
  check(): string[] {
    const problems: string[] = [];
    const scan = (owner: string, fields: Readonly<Record<string, Field>>) => {
      for (const [name, f] of Object.entries(fields)) {
        if (f.kind === 'relation' && f.target !== undefined && !this.types.has(f.target)) problems.push(`${owner}.${name}: relation target "${f.target}" is not a content type`);
        if (f.kind === 'component' && f.component !== undefined && !this.components.has(f.component)) problems.push(`${owner}.${name}: component "${f.component}" is not defined`);
        if (f.kind === 'dynamiczone') for (const c of f.components ?? []) if (!this.components.has(c)) problems.push(`${owner}.${name}: component "${c}" is not defined`);
      }
    };
    for (const t of this.types.values()) scan(t.uid, t.fields);
    for (const c of this.components.values()) scan(c.uid, c.fields);
    // cycles among components
    const edges = (uid: string): string[] => {
      const out: string[] = [];
      for (const f of Object.values(this.components.get(uid)?.fields ?? {})) {
        if (f.component) out.push(f.component);
        if (f.components) out.push(...f.components);
      }
      return out.filter((c) => this.components.has(c));
    };
    const state = new Map<string, 1 | 2>();
    const walk = (uid: string, path: string[]) => {
      if (state.get(uid) === 2) return;
      if (state.get(uid) === 1) {
        problems.push(`components contain themselves: ${[...path.slice(path.indexOf(uid)), uid].join(' > ')}`);
        return;
      }
      state.set(uid, 1);
      for (const e of edges(uid)) walk(e, [...path, uid]);
      state.set(uid, 2);
    };
    for (const uid of this.components.keys()) walk(uid, []);
    return problems;
  }

  /** The model as plain data, for a client that builds forms from it. */
  exportSchema(): { types: ContentTypeDef[]; components: ComponentDef[] } {
    return { types: [...this.types.values()].sort((a, b) => a.uid.localeCompare(b.uid)), components: [...this.components.values()].sort((a, b) => a.uid.localeCompare(b.uid)) };
  }

  private checkUid(uid: string, what: string) {
    if (typeof uid !== 'string' || !UID.test(uid)) throw new ContentModelError(`${what} uid "${String(uid)}" must be lowercase words joined by . or : or -`);
  }

  private checkFields(fields: Readonly<Record<string, Field>>, where: string) {
    const names = Object.keys(fields);
    if (names.length === 0) throw new ContentModelError(`${where} needs at least one field`);
    for (const [name, f] of Object.entries(fields)) {
      if (!FIELD.test(name)) throw new ContentModelError(`${where}: "${name}" is not a valid field name`);
      if (RESERVED.has(name)) throw new ContentModelError(`${where}: "${name}" is reserved`);
      if (!KINDS.has(f.kind)) throw new ContentModelError(`${where}.${name}: unknown field kind "${String(f.kind)}"`);
      if (f.kind === 'enumeration' && (!f.values || f.values.length === 0)) throw new ContentModelError(`${where}.${name}: an enumeration needs values`);
      if (f.kind === 'uid' && f.targetField !== undefined && !(f.targetField in fields)) throw new ContentModelError(`${where}.${name}: targetField "${f.targetField}" is not a field`);
      if (f.kind === 'relation' && (f.target === undefined || f.relation === undefined)) throw new ContentModelError(`${where}.${name}: a relation needs target and relation`);
      if (f.kind === 'component' && f.component === undefined) throw new ContentModelError(`${where}.${name}: a component field needs component`);
      if (f.kind === 'dynamiczone' && (!f.components || f.components.length === 0)) throw new ContentModelError(`${where}.${name}: a dynamic zone needs components`);
      if (f.regex !== undefined) {
        if (f.regex.length > 200 || /\((?:[^()]*[+*])[^()]*\)[+*{]/.test(f.regex)) throw new ContentModelError(`${where}.${name}: regex is too long or has a nested quantifier`);
        try { new RegExp(f.regex); } catch { throw new ContentModelError(`${where}.${name}: regex is not valid`); }
      }
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new ContentModelError(`${where}.${name}: min is above max`);
      if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) throw new ContentModelError(`${where}.${name}: minLength is above maxLength`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ validation

export type Data = Record<string, unknown>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[A-Za-z0-9_.~-]*$/;

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Check data against fields. With `enforceRequired` false (a draft), missing values are fine; present values must
 * still be right. Returns every problem with its path.
 */
export function validateFields(reg: Registry, fields: Readonly<Record<string, Field>>, data: Data, enforceRequired: boolean, base = '', problems: Problem[] = []): Problem[] {
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(fields, key)) problems.push({ path: base + key, message: 'is not a field of this type' });
  }
  for (const [name, f] of Object.entries(fields)) {
    const path = base + name;
    const v = data[name];
    if (v === undefined || v === null) {
      if (enforceRequired && f.required && !(f.kind === 'uid' && f.targetField !== undefined)) problems.push({ path, message: 'is required' });
      continue;
    }
    one(reg, f, v, path, enforceRequired, problems);
  }
  return problems;
}

function one(reg: Registry, f: Field, v: unknown, path: string, enforceRequired: boolean, problems: Problem[]): void {
  const bad = (message: string) => void problems.push({ path, message });
  switch (f.kind) {
    case 'string': case 'text': case 'richtext': case 'email': case 'uid': {
      if (typeof v !== 'string') return bad('must be text');
      if (f.minLength !== undefined && v.length < f.minLength) bad(`must be at least ${f.minLength} characters`);
      if (f.maxLength !== undefined && v.length > f.maxLength) bad(`must be at most ${f.maxLength} characters`);
      if (f.required && enforceRequired && v === '') bad('is required');
      if (f.kind === 'email' && v !== '' && !EMAIL.test(v)) bad('must be an email address');
      if (f.kind === 'uid' && !SLUG.test(v)) bad('may only contain letters, digits, - _ . ~');
      if (f.regex !== undefined && v !== '' && !new RegExp(f.regex).test(v)) bad(`does not match ${f.regex}`);
      return;
    }
    case 'integer': case 'decimal': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('must be a number');
      if (f.kind === 'integer' && !Number.isInteger(v)) return bad('must be a whole number');
      if (f.min !== undefined && v < f.min) bad(`must be at least ${f.min}`);
      if (f.max !== undefined && v > f.max) bad(`must be at most ${f.max}`);
      return;
    }
    case 'boolean': if (typeof v !== 'boolean') bad('must be true or false'); return;
    case 'date': if (typeof v !== 'string' || !validDate(v)) bad('must be a date like 2026-03-31'); return;
    case 'datetime': if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) bad('must be an ISO date and time'); return;
    case 'enumeration': if (typeof v !== 'string' || !(f.values ?? []).includes(v)) bad(`must be one of ${(f.values ?? []).join(', ')}`); return;
    case 'json': {
      try { JSON.stringify(v); } catch { bad('must be JSON'); }
      return;
    }
    case 'media': {
      const ids = Array.isArray(v) ? v : [v];
      if (!f.multiple && Array.isArray(v)) return bad('takes one file');
      if (!ids.every((x) => typeof x === 'string' && x !== '')) bad('must be file ids');
      return;
    }
    case 'relation': {
      const many = f.relation === 'oneToMany' || f.relation === 'manyToMany';
      if (many) {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x !== '')) return bad('must be a list of ids');
      } else if (typeof v !== 'string' || v === '') return bad('must be an id');
      return;
    }
    case 'component': {
      const def = reg.component(f.component as string);
      if (f.repeatable) {
        if (!Array.isArray(v)) return bad('must be a list');
        if (f.min !== undefined && v.length < f.min) bad(`needs at least ${f.min} items`);
        if (f.max !== undefined && v.length > f.max) bad(`allows at most ${f.max} items`);
        v.forEach((item, i) => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return void problems.push({ path: `${path}[${i}]`, message: 'must be an object' });
          validateFields(reg, def.fields, item as Data, enforceRequired, `${path}[${i}].`, problems);
        });
      } else {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad('must be an object');
        validateFields(reg, def.fields, v as Data, enforceRequired, `${path}.`, problems);
      }
      return;
    }
    case 'dynamiczone': {
      if (!Array.isArray(v)) return bad('must be a list');
      if (f.min !== undefined && v.length < f.min) bad(`needs at least ${f.min} items`);
      if (f.max !== undefined && v.length > f.max) bad(`allows at most ${f.max} items`);
      v.forEach((item, i) => {
        const p = `${path}[${i}]`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return void problems.push({ path: p, message: 'must be an object' });
        const { __component, ...rest } = item as Data;
        if (typeof __component !== 'string' || !(f.components ?? []).includes(__component)) return void problems.push({ path: `${p}.__component`, message: `must be one of ${(f.components ?? []).join(', ')}` });
        validateFields(reg, reg.component(__component).fields, rest, enforceRequired, `${p}.`, problems);
      });
      return;
    }
  }
}

// ------------------------------------------------------------------------------------------------ store

export type Status = 'draft' | 'published' | 'modified';

export interface Entry {
  readonly documentId: string;
  readonly locale: string;
  readonly status: Status;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt: number | null;
  readonly data: Data;
}

interface Variant {
  draft: Data;
  published: Data | undefined;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}
interface Doc {
  readonly id: string;
  readonly variants: Map<string, Variant>;
}

export interface StoreOptions {
  readonly registry: Registry;
  readonly now: () => number;
  readonly newId: () => string;
  /** Locales that exist; the first is the default. Default ['en']. */
  readonly locales?: readonly string[];
}

export interface ReadOptions {
  readonly locale?: string;
  /** Which copy to read for a type with draft and publish. Default `draft`. */
  readonly status?: 'draft' | 'published';
  /** Locales to try, in order, when the wanted one has no variant. */
  readonly fallback?: readonly string[];
  /** Leave out fields marked private. */
  readonly hidePrivate?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ContentStore {
  private readonly reg: Registry;
  private readonly now: () => number;
  private readonly newId: () => string;
  readonly locales: readonly string[];
  private readonly docs = new Map<string, Map<string, Doc>>();

  constructor(o: StoreOptions) {
    const problems = o.registry.check();
    if (problems.length) throw new ContentModelError(`the content model is not sound: ${problems.join('; ')}`);
    this.reg = o.registry;
    this.now = o.now;
    this.newId = o.newId;
    this.locales = o.locales ?? ['en'];
    for (const l of this.locales) if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(l)) throw new ContentModelError(`"${l}" is not a locale code`);
    if (this.locales.length === 0) throw new ContentModelError('at least one locale is needed');
  }

  private table(uid: string): Map<string, Doc> {
    this.reg.type(uid);
    return this.docs.get(uid) ?? this.docs.set(uid, new Map()).get(uid)!;
  }
  private locale(uid: string, l: string | undefined): string {
    const t = this.reg.type(uid);
    const loc = l ?? (this.locales[0] as string);
    if (!t.localized) {
      if (l !== undefined && l !== this.locales[0]) throw new ContentModelError(`"${uid}" is not localized; it has only the ${this.locales[0]} variant`);
      return this.locales[0] as string;
    }
    if (!this.locales.includes(loc)) throw new ContentModelError(`locale "${loc}" is not enabled (${this.locales.join(', ')})`);
    return loc;
  }
  private sharedFields(uid: string): string[] {
    const t = this.reg.type(uid);
    return t.localized ? Object.entries(t.fields).filter(([, f]) => f.localized === false).map(([n]) => n) : [];
  }
  private status(t: { draftAndPublish?: boolean }, v: Variant): Status {
    if (!t.draftAndPublish) return 'published';
    if (!v.published) return 'draft';
    return same(v.draft, v.published) ? 'published' : 'modified';
  }
  private entry(uid: string, d: Doc, locale: string, v: Variant, o: ReadOptions): Entry {
    const t = this.reg.type(uid);
    let data = structuredClone(o.status === 'published' && t.draftAndPublish ? (v.published as Data) : v.draft);
    if (o.hidePrivate) data = Object.fromEntries(Object.entries(data).filter(([k]) => !t.fields[k]?.private));
    return { documentId: d.id, locale, status: this.status(t, v), createdAt: v.createdAt, updatedAt: v.updatedAt, publishedAt: v.publishedAt, data };
  }

  private defaults(fields: Readonly<Record<string, Field>>, data: Data): Data {
    const out: Data = { ...data };
    for (const [n, f] of Object.entries(fields)) if (out[n] === undefined && f.default !== undefined) out[n] = structuredClone(f.default);
    return out;
  }

  private check(uid: string, locale: string, selfId: string | undefined, data: Data, enforceRequired: boolean): void {
    const t = this.reg.type(uid);
    const problems = validateFields(this.reg, t.fields, data, enforceRequired);
    for (const [n, f] of Object.entries(t.fields)) {
      const v = data[n];
      if ((f.unique || f.kind === 'uid') && typeof v === 'string' && v !== '') {
        for (const d of this.table(uid).values()) {
          if (d.id === selfId) continue;
          const other = d.variants.get(locale);
          if (other && other.draft[n] === v) problems.push({ path: n, message: `"${v}" is already used` });
        }
      }
    }
    if (problems.length) throw new ValidationFailed(problems);
  }

  private fillUid(uid: string, locale: string, selfId: string | undefined, data: Data): void {
    const t = this.reg.type(uid);
    for (const [n, f] of Object.entries(t.fields)) {
      if (f.kind !== 'uid' || f.targetField === undefined || (data[n] !== undefined && data[n] !== '')) continue;
      const src = data[f.targetField];
      if (typeof src !== 'string' || slugify(src) === '') continue;
      const base = slugify(src);
      const taken = new Set<string>();
      for (const d of this.table(uid).values()) if (d.id !== selfId) { const x = d.variants.get(locale)?.draft[n]; if (typeof x === 'string') taken.add(x); }
      let candidate = base;
      for (let i = 1; taken.has(candidate); i++) candidate = `${base}-${i}`;
      data[n] = candidate;
    }
  }

  create(uid: string, input: Data, options: { locale?: string } = {}): Entry {
    const t = this.reg.type(uid);
    const locale = this.locale(uid, options.locale);
    const table = this.table(uid);
    if (t.kind === 'single' && table.size > 0) throw new ContentModelError(`"${uid}" is a single type and already has its entry`);
    const data = this.defaults(t.fields, structuredClone(input));
    this.fillUid(uid, locale, undefined, data);
    this.check(uid, locale, undefined, data, false);
    const now = this.now();
    const doc: Doc = { id: t.kind === 'single' ? 'single' : this.newId(), variants: new Map() };
    const v: Variant = { draft: data, published: undefined, createdAt: now, updatedAt: now, publishedAt: null };
    if (!t.draftAndPublish) {
      this.check(uid, locale, undefined, data, true);
      v.published = structuredClone(data);
      v.publishedAt = now;
    }
    doc.variants.set(locale, v);
    table.set(doc.id, doc);
    return this.entry(uid, doc, locale, v, {});
  }

  private doc(uid: string, id: string): Doc {
    const d = this.table(uid).get(id);
    if (!d) throw new NotFoundError(`${uid} "${id}" does not exist`);
    return d;
  }

  /** Add a variant in another locale. Shared fields are copied from the default locale's variant. */
  addLocale(uid: string, documentId: string, locale: string, input: Data): Entry {
    const t = this.reg.type(uid);
    if (!t.localized) throw new ContentModelError(`"${uid}" is not localized`);
    const loc = this.locale(uid, locale);
    const d = this.doc(uid, documentId);
    if (d.variants.has(loc)) throw new ContentModelError(`${uid} "${documentId}" already has a ${loc} variant`);
    const source = d.variants.get(this.locales[0] as string) ?? [...d.variants.values()][0]!;
    const given = structuredClone(input);
    for (const n of this.sharedFields(uid)) {
      if (given[n] !== undefined && !same(given[n], source.draft[n])) throw new ValidationFailed([{ path: n, message: 'is shared by every locale; change it on the original and it is updated everywhere' }]);
      if (source.draft[n] !== undefined) given[n] = structuredClone(source.draft[n]);
    }
    const data = this.defaults(t.fields, given);
    this.fillUid(uid, loc, documentId, data);
    this.check(uid, loc, documentId, data, false);
    const now = this.now();
    const v: Variant = { draft: data, published: undefined, createdAt: now, updatedAt: now, publishedAt: null };
    if (!t.draftAndPublish) { this.check(uid, loc, documentId, data, true); v.published = structuredClone(data); v.publishedAt = now; }
    d.variants.set(loc, v);
    return this.entry(uid, d, loc, v, {});
  }

  /** Change fields of the draft (a patch). Shared fields are changed in every locale. */
  update(uid: string, documentId: string, patch: Data, options: { locale?: string } = {}): Entry {
    const t = this.reg.type(uid);
    const locale = this.locale(uid, options.locale);
    const d = this.doc(uid, documentId);
    const v = d.variants.get(locale);
    if (!v) throw new NotFoundError(`${uid} "${documentId}" has no ${locale} variant`);
    const data = { ...structuredClone(v.draft), ...structuredClone(patch) };
    for (const [k, val] of Object.entries(data)) if (val === null) delete data[k];
    this.fillUid(uid, locale, documentId, data);
    this.check(uid, locale, documentId, data, !t.draftAndPublish);
    const now = this.now();
    v.draft = data;
    v.updatedAt = now;
    if (!t.draftAndPublish) { v.published = structuredClone(data); v.publishedAt = now; }
    for (const n of this.sharedFields(uid)) {
      if (!(n in patch)) continue;
      for (const [l, other] of d.variants) {
        if (l === locale) continue;
        if (data[n] === undefined) delete other.draft[n];
        else other.draft[n] = structuredClone(data[n]);
        other.updatedAt = now;
        if (!t.draftAndPublish) other.published = structuredClone(other.draft);
      }
    }
    return this.entry(uid, d, locale, v, {});
  }

  /** Publish the draft of one locale (default) after checking everything is present, or of every locale. */
  publish(uid: string, documentId: string, options: { locale?: string; allLocales?: boolean } = {}): Entry[] {
    const t = this.reg.type(uid);
    if (!t.draftAndPublish) throw new ContentModelError(`"${uid}" has no draft and publish`);
    const d = this.doc(uid, documentId);
    const wanted = options.allLocales ? [...d.variants.keys()] : [this.locale(uid, options.locale)];
    const out: Entry[] = [];
    const now = this.now();
    // check all first, so nothing is half published
    for (const l of wanted) {
      const v = d.variants.get(l);
      if (!v) throw new NotFoundError(`${uid} "${documentId}" has no ${l} variant`);
      try { this.check(uid, l, documentId, v.draft, true); } catch (e) {
        if (e instanceof ValidationFailed) throw new ValidationFailed(e.problems.map((p) => ({ path: options.allLocales ? `${l}:${p.path}` : p.path, message: p.message })));
        throw e;
      }
    }
    for (const l of wanted) {
      const v = d.variants.get(l) as Variant;
      v.published = structuredClone(v.draft);
      v.publishedAt = now;
      out.push(this.entry(uid, d, l, v, {}));
    }
    return out;
  }

  unpublish(uid: string, documentId: string, options: { locale?: string } = {}): Entry {
    const t = this.reg.type(uid);
    if (!t.draftAndPublish) throw new ContentModelError(`"${uid}" has no draft and publish`);
    const locale = this.locale(uid, options.locale);
    const d = this.doc(uid, documentId);
    const v = d.variants.get(locale);
    if (!v) throw new NotFoundError(`${uid} "${documentId}" has no ${locale} variant`);
    v.published = undefined;
    v.publishedAt = null;
    return this.entry(uid, d, locale, v, {});
  }

  /** Throw away draft changes: the draft becomes the published copy again. */
  discardDraft(uid: string, documentId: string, options: { locale?: string } = {}): Entry {
    const locale = this.locale(uid, options.locale);
    const d = this.doc(uid, documentId);
    const v = d.variants.get(locale);
    if (!v) throw new NotFoundError(`${uid} "${documentId}" has no ${locale} variant`);
    if (!v.published) throw new ContentModelError('nothing is published to go back to');
    v.draft = structuredClone(v.published);
    return this.entry(uid, d, locale, v, {});
  }

  /** Delete one locale variant, or the whole document when no locale is given. Returns how many variants went. */
  delete(uid: string, documentId: string, options: { locale?: string } = {}): number {
    const d = this.doc(uid, documentId);
    if (options.locale === undefined) {
      const n = d.variants.size;
      this.table(uid).delete(documentId);
      return n;
    }
    const locale = this.locale(uid, options.locale);
    if (!d.variants.delete(locale)) throw new NotFoundError(`${uid} "${documentId}" has no ${locale} variant`);
    if (d.variants.size === 0) this.table(uid).delete(documentId);
    return 1;
  }

  get(uid: string, documentId: string, options: ReadOptions = {}): Entry | undefined {
    const t = this.reg.type(uid);
    const d = this.table(uid).get(documentId);
    if (!d) return undefined;
    const tryLocales = [this.locale(uid, options.locale), ...(t.localized ? (options.fallback ?? []) : [])];
    for (const l of tryLocales) {
      const v = d.variants.get(l);
      if (!v) continue;
      if (options.status === 'published' && t.draftAndPublish && !v.published) continue;
      return this.entry(uid, d, l, v, options);
    }
    return undefined;
  }

  list(uid: string, options: ReadOptions & { where?: (e: Entry) => boolean } = {}): Entry[] {
    const t = this.reg.type(uid);
    const locale = this.locale(uid, options.locale);
    const out: Entry[] = [];
    for (const d of this.table(uid).values()) {
      const e = this.get(uid, d.id, options);
      if (!e) continue;
      if (e.locale !== locale && !(t.localized && options.fallback?.includes(e.locale))) continue;
      if (options.where && !options.where(e)) continue;
      out.push(e);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.documentId.localeCompare(b.documentId));
  }

  /** Which locales a document has, and each one's status. */
  localesOf(uid: string, documentId: string): { locale: string; status: Status }[] {
    const t = this.reg.type(uid);
    const d = this.doc(uid, documentId);
    return [...d.variants].map(([locale, v]) => ({ locale, status: this.status(t, v) })).sort((a, b) => a.locale.localeCompare(b.locale));
  }
}
