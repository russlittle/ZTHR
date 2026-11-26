/**
 * The information schema: what the software keeps, signed with the schematic, because it is the part of the system that
 * cannot be rebuilt. Screens, the API, reports, docs and training can all be regenerated from the intent; the records
 * people have trusted it with cannot. So the schema is written from the intent, in the words of the person who knows
 * the work, checked for integrity on its own, and changed only with a record of what changed and a migration that never
 * throws data away.
 *
 * It is built in three layers, all by rule:
 *   1. Patterns. Business applications keep the same kinds of record again and again: people, obligations, payments,
 *      messages, consent, flags. Each pattern is defined once with its fields, states and integrity rules, maintained
 *      by the fleet, and named in the words the intent uses ("bills", not "obligations").
 *   2. The person's sentences, under "The information": "A bill has an amount and a due date." "A reminder belongs to
 *      one bill." "A bill can be open, paid or overdue." Each sentence becomes fields, relations, states, sensitivity or
 *      retention. A sentence that fits no shape is shown back as unread, never guessed at.
 *   3. Integrity rules, from both: every required field present, every reference real, every state allowed, money never
 *      negative, consent before contact. Each rule is a query that returns the records that break it, so the data can
 *      be checked without the code that wrote it.
 */
import patternData from '../catalog/patterns.json' with { type: 'json' };
import { sha256 } from './hash.ts';
import type { InfoLine } from './model.ts';
import type { Prepared } from './pipeline.ts';
import { toPrisma } from './prisma.ts';
import { pipelineFiles } from './datapipeline.ts';

export type FieldType = 'id' | 'text' | 'money' | 'date' | 'timestamp' | 'integer' | 'boolean' | 'email' | 'phone' | 'state' | `ref:${string}`;
export type Sensitivity = 'public' | 'internal' | 'contact' | 'financial' | 'private' | 'health';

export interface Field {
  readonly key: string;
  readonly name: string;
  readonly type: FieldType;
  readonly meaning: string;
  readonly sensitivity: Sensitivity;
  readonly required: boolean;
  readonly states?: readonly string[];
  /** Where it came from: a fleet pattern, the person's own sentence (with its line), or the system. */
  readonly from: 'pattern' | 'your words' | 'provided' | 'system';
  readonly line?: number;
}
export interface Entity {
  readonly key: string;
  readonly name: string;
  readonly what: string;
  readonly pattern: string | null;
  readonly maintainedBy: 'fleet' | 'local';
  readonly fields: readonly Field[];
  readonly retention: string;
  readonly balloons: readonly number[];
  /** The person's sentences about it, verbatim, with their lines. */
  readonly words: readonly { text: string; line: number }[];
}
export interface Relation {
  readonly from: string;
  readonly field: string;
  readonly to: string;
  readonly meaning: string;
}
export interface Rule {
  readonly id: string;
  readonly entity: string;
  readonly text: string;
  /** Returns the id of every record that breaks it. */
  readonly sql: string;
}
export interface Schema {
  readonly entities: readonly Entity[];
  readonly relations: readonly Relation[];
  readonly rules: readonly Rule[];
  /** Sentences under "The information" that fit no shape: shown back, never guessed at. */
  readonly unread: readonly { text: string; line: number; why: string }[];
  readonly hash: string;
}

interface PatternField { name: string; type: string; meaning: string; sensitivity: string; required?: boolean; states?: string[] }
interface Pattern { id: string; name: string; what: string; always?: boolean; sheet?: string; rule?: string; triggers?: [string, string][]; fields: PatternField[]; rules?: string[]; retention: string }
export const PATTERNS = patternData as { name: string; what: string; patterns: Pattern[]; types: Record<string, string>; sensitivity: Record<Sensitivity, string> };

const snake = (t: string) => t.toLowerCase().replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';
const singular = (w: string) => w.replace(/ies$/i, 'y').replace(/(ss)es$/i, '$1').replace(/([^s])s$/i, '$1');
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const article = /^(?:an?|the|each|every|their|its|his|her|one)\s+/i;
const bare = (t: string) => t.trim().replace(/[.;:]+$/, '').replace(article, '').trim();

/** What a field's name says its type is; an explicit "(money)" or "(date)" in the sentence wins. */
function typeOf(name: string, hint?: string): FieldType {
  const h = (hint ?? '').toLowerCase();
  if (h) {
    if (/money|amount|dollars?/.test(h)) return 'money';
    if (/^date|day/.test(h)) return 'date';
    if (/time|moment/.test(h)) return 'timestamp';
    if (/yes|no|true|false/.test(h)) return 'boolean';
    if (/number|count|whole/.test(h)) return 'integer';
    if (/email/.test(h)) return 'email';
    if (/phone/.test(h)) return 'phone';
    if (/text|words/.test(h)) return 'text';
  }
  const n = name.toLowerCase();
  if (/\b(amount|balance|cost|price|fee|total|paid amount|owed)\b/.test(n)) return 'money';
  if (/\b(email)\b/.test(n)) return 'email';
  if (/\b(phone|mobile|cell)\b/.test(n)) return 'phone';
  if (/\b(at|time)$/.test(n)) return 'timestamp';
  if (/\b(date|due|day|on|birthday)\b/.test(n)) return 'date';
  if (/\b(number of|count|how many|age)\b/.test(n)) return 'integer';
  if (/^(is|has|was|whether)\b|\?$/.test(n)) return 'boolean';
  return 'text';
}
function sensitivityOf(name: string, type: FieldType): Sensitivity {
  const n = name.toLowerCase();
  if (/\b(diagnos|condition|health|medical|disabilit|medication)/.test(n)) return 'health';
  if (type === 'money' || /\b(income|account|balance|aid)\b/.test(n)) return 'financial';
  if (type === 'email' || type === 'phone' || /\b(address|name)\b/.test(n)) return 'contact';
  return 'internal';
}

interface Draft {
  key: string;
  name: string;
  what: string;
  pattern: string | null;
  fields: Field[];
  retention: string;
  balloons: Set<number>;
  words: { text: string; line: number }[];
  rules: string[];
}

export function schemaOf(p: Prepared): Schema {
  const st = p.statements;
  const info: readonly InfoLine[] = p.model.information ?? [];
  const drafts = new Map<string, Draft>();
  // A role is the person's noun: "staff who see this information (on the other side)" is staff.
  const roles = [...new Set(st.filter((s) => s.slot === 'people').map((s) => singular(s.text.replace(/\s*\(.*$/, '').replace(/,.*$/, '').replace(/\s+(who|that|which|with|from|at|in|on)\b.*$/i, '').trim().toLowerCase().split(/\s+/).slice(-1)[0] || 'person')))];
  const fromPattern = (pt: Pattern, name: string): Draft => ({
    key: snake(name),
    name,
    what: pt.what,
    pattern: pt.id,
    fields: pt.fields.map((f) => ({ key: snake(f.name), name: f.name, type: f.type as FieldType, meaning: f.meaning, sensitivity: f.sensitivity as Sensitivity, required: !!f.required, ...(f.states ? { states: f.states } : {}), from: 'pattern' as const })),
    retention: pt.retention,
    balloons: new Set(),
    words: [],
    rules: pt.rules ?? [],
  });

  // 1. Patterns the intent calls for, named in its own words.
  for (const pt of PATTERNS.patterns) {
    // A pattern the spec sheet switches on: report a problem brings its tickets.
    if (pt.sheet === 'feedback' && p.options.feedback === 'off') continue;
    let name: string | null = pt.always || (pt.sheet === 'feedback' && p.options.feedback !== 'off') ? pt.name : null;
    const hits = new Set<number>();
    for (const [re, as] of pt.triggers ?? []) {
      const r = new RegExp(re, 'i');
      const by = st.filter((s) => r.test(s.text) || (s.words ? r.test(s.words) : false));
      const said = info.some((l) => r.test(l.text));
      if (by.length || said) {
        name ??= as;
        for (const s of by) hits.add(s.balloon);
      }
    }
    if (pt.rule) {
      const by = st.filter((s) => s.supplied.kind === 'derived' && s.supplied.rule === pt.rule);
      if (by.length) {
        name ??= pt.name;
        for (const s of by) hits.add(s.balloon);
      }
    }
    if (!name) continue;
    const d = fromPattern(pt, name);
    for (const b of hits) d.balloons.add(b);
    drafts.set(pt.id, d);
  }
  const person = drafts.get('person')!;
  if (roles.length) person.fields = person.fields.map((f) => (f.key === 'role' ? { ...f, states: roles } : f));
  for (const s of st.filter((x) => x.slot === 'people')) person.balloons.add(s.balloon);

  // Resolve a word to an entity: a role is a person; a pattern's own name or the name it took; or a new record.
  const all = () => [...drafts.values()];
  const find = (word: string): Draft | undefined => {
    const w = singular(bare(word).toLowerCase());
    if (roles.includes(w) || w === 'person' || w === 'people') return person;
    return all().find((d) => singular(d.name.toLowerCase()) === w || d.key === snake(w) || (d.pattern && PATTERNS.patterns.find((x) => x.id === d.pattern)?.name.toLowerCase() === w));
  };
  const ensure = (word: string, line: number): Draft => {
    const hit = find(word);
    if (hit) return hit;
    const name = cap(singular(bare(word).toLowerCase()));
    const d: Draft = { key: snake(name), name, what: 'A record you described in your own words.', pattern: null, fields: [{ key: 'created_at', name: 'created at', type: 'timestamp', meaning: 'When the record was made', sensitivity: 'internal', required: true, from: 'system' }], retention: 'as long as it is needed, then 1 year', balloons: new Set(), words: [], rules: [] };
    drafts.set(`own:${d.key}`, d);
    void line;
    return d;
  };
  const addField = (d: Draft, phrase: string, line: number) => {
    const hint = /\(([^)]+)\)\s*$/.exec(phrase)?.[1];
    const raw = bare(phrase.replace(/\([^)]*\)\s*$/, ''));
    if (!raw) return;
    // "who it is for", "whose it is": the person it belongs to.
    if (/^(who it is for|whose it is|who owes it|who it belongs to)$/i.test(raw)) {
      const has = d.fields.find((f) => f.type === 'ref:Person' && (f.from === 'provided' || /owner|for|to|about|person/.test(f.key)));
      if (has) d.fields = d.fields.map((f) => (f === has && f.from !== 'provided' ? { ...f, from: 'your words', line } : f));
      else d.fields.push({ key: 'owner', name: 'owner', type: 'ref:Person', meaning: 'Who it is for', sensitivity: 'internal', required: true, from: 'your words', line });
      return;
    }
    const target = find(raw);
    const key = snake(raw);
    // "due date" is the pattern's "due on": the same kind of value, sharing a word that means something.
    const STOPW = new Set(['date', 'time', 'at', 'on', 'of', 'the', 'number', 'name']);
    const sig = (t: string) => t.split('_').filter((w) => w.length > 1 && !STOPW.has(w));
    const existing = d.fields.find((f) => f.key === key) ?? d.fields.find((f) => f.type === typeOf(raw, hint) && f.type !== 'text' && sig(f.key).some((w) => sig(key).includes(w)));
    if (existing) {
      // What a team already has stays as it is; the sentence confirms it.
      if (existing.from !== 'provided') d.fields = d.fields.map((f) => (f === existing ? { ...f, from: 'your words', line, ...(hint ? { type: typeOf(raw, hint) } : {}) } : f));
      return;
    }
    const type: FieldType = target && target !== d ? `ref:${target.pattern ? PATTERNS.patterns.find((x) => x.id === target.pattern)!.name : target.name}` : typeOf(raw, hint);
    d.fields.push({ key, name: raw.toLowerCase(), type, meaning: `${cap(raw)}, as you described it`, sensitivity: sensitivityOf(raw, type), required: false, from: 'your words', line });
  };
  // 1b. Records a team already has, as provided: their table, fields, types and relations win over the patterns.
  const providedBy = new Map<string, Draft>();
  for (const pe of p.model.provided ?? []) {
    let d = find(pe.name) ?? find(pe.key.replace(/_/g, ' '));
    if (!d) {
      d = { key: pe.key, name: pe.name, what: pe.meaning ?? 'A record your team already keeps, as provided.', pattern: null, fields: [], retention: 'as your team keeps it now', balloons: new Set(), words: [], rules: [] };
      drafts.set(`provided:${pe.key}`, d);
    }
    d.key = pe.key;
    providedBy.set(pe.model, d);
    for (const pf of pe.fields.filter((x) => x.key !== 'id')) {
      const f: Field = { key: pf.key, name: pf.name, type: pf.to ? (`ref:@${pf.to}` as FieldType) : pf.type, meaning: pf.meaning ?? `${cap(pf.name)}, as provided`, sensitivity: sensitivityOf(pf.name, pf.type), required: pf.required, ...(pf.states ? { states: pf.states } : {}), from: 'provided', line: pf.line };
      const SKIP = new Set(['date', 'time', 'at', 'on', 'of', 'the', 'id', 'number', 'name']);
      const sig = (k: string) => k.split('_').filter((w) => w.length > 1 && !SKIP.has(w));
      const i = d.fields.findIndex((x) => x.from !== 'provided' && (x.key === pf.key || (!pf.to && x.type === pf.type && x.type !== 'text' && sig(x.key).some((w) => sig(pf.key).includes(w)))));
      if (i >= 0) d.fields[i] = { ...f, sensitivity: d.fields[i]!.sensitivity, meaning: pf.meaning ?? d.fields[i]!.meaning };
      else d.fields.push(f);
    }
  }
  // A provided reference replaces the pattern's reference to the same record: the team's column is the real one.
  const targetOf = (t: string) => (t.startsWith('ref:@') ? providedBy.get(t.slice(5)) : t.startsWith('ref:') ? all().find((x) => (x.pattern ? PATTERNS.patterns.find((y) => y.id === x.pattern)!.name : x.name) === t.slice(4)) : undefined);
  for (const d of new Set(providedBy.values())) {
    const provided = d.fields.filter((f) => f.from === 'provided' && f.type.startsWith('ref:'));
    d.fields = d.fields.filter((f) => !(f.from === 'pattern' && f.type.startsWith('ref:') && provided.some((pf) => targetOf(pf.type) === targetOf(f.type))));
  }
  const refName = (d: Draft) => (d.pattern ? PATTERNS.patterns.find((x) => x.id === d.pattern)!.name : d.name);
  for (const d of drafts.values()) d.fields = d.fields.map((f) => (f.type.startsWith('ref:@') ? { ...f, type: (providedBy.has(f.type.slice(5)) ? `ref:${refName(providedBy.get(f.type.slice(5))!)}` : 'text') as FieldType } : f));

  const list = (t: string) => t.split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/i).map((x) => x.trim()).filter(Boolean);
  const unread: { text: string; line: number; why: string }[] = [];

  // 2. The person's sentences.
  for (const l of info) {
    const t = l.text.trim().replace(/[.]+$/, '');
    const line = l.origin.line;
    let m: RegExpExecArray | null;
    if ((m = /^keep\s+(.+?)\s+for\s+(.+)$/i.exec(t))) {
      const d = find(m[1]!);
      if (d) {
        d.retention = m[2]!;
        d.words.push({ text: l.text, line });
      } else unread.push({ text: l.text, line, why: `"${m[1]}" is not a record yet; describe it first ("A ${singular(bare(m[1]!))} has …")` });
      continue;
    }
    if ((m = /^(?:an?|each|every|the|one)\s+(.+?)\s+(?:can be|is either|is one of|moves from|goes from)\s+(.+)$/i.exec(t))) {
      const d = ensure(m[1]!, line);
      const states = list(m[2]!.replace(/\s+(?:to|then)\s+/gi, ', ')).map((x) => bare(x).toLowerCase());
      const has = d.fields.find((f) => f.type === 'state' && f.key === 'status');
      if (has?.from === 'provided') {
        const same = (has.states ?? []).map((x) => x.toLowerCase()).join() === states.join();
        if (!same) unread.push({ text: l.text, line, why: `The schema your team provided says a ${d.name.toLowerCase()} can be ${(has.states ?? []).join(', ')}. Your words say ${states.join(', ')}. The provided one is kept until you settle which is right` });
        else d.words.push({ text: l.text, line });
        continue;
      }
      d.fields = has ? d.fields.map((f) => (f === has ? { ...f, states, from: 'your words', line } : f)) : [...d.fields, { key: 'status', name: 'status', type: 'state', meaning: 'Where it stands', sensitivity: 'internal', required: true, states, from: 'your words', line }];
      d.words.push({ text: l.text, line });
      continue;
    }
    if ((m = /^(?:an?|each|every|the|one)\s+(.+?)\s+(?:belongs to|is for|is about|is sent to|is owed by|is part of)\s+(?:one|an?|the|a single)\s+(.+)$/i.exec(t))) {
      const d = ensure(m[1]!, line);
      const to = ensure(m[2]!, line);
      const key = snake(to === person ? (/sent to/i.test(t) ? 'to' : /owed by/i.test(t) ? 'owner' : 'for') : to.name);
      if (!d.fields.some((f) => f.type === `ref:${to.pattern ? PATTERNS.patterns.find((x) => x.id === to.pattern)!.name : to.name}`))
        d.fields.push({ key, name: key.replace(/_/g, ' '), type: `ref:${to.pattern ? PATTERNS.patterns.find((x) => x.id === to.pattern)!.name : to.name}`, meaning: `The ${to.name.toLowerCase()} it ${/sent to/i.test(t) ? 'is sent to' : 'belongs to'}`, sensitivity: 'internal', required: true, from: 'your words', line });
      d.words.push({ text: l.text, line });
      continue;
    }
    if ((m = /^(?:an?|each|every|the|one)\s+(.+?)\s+(?:can have|has many|may have)\s+(?:many|several|any number of|some)?\s*(.+)$/i.exec(t))) {
      const d = ensure(m[1]!, line);
      const child = ensure(m[2]!, line);
      const ref = `ref:${d.pattern ? PATTERNS.patterns.find((x) => x.id === d.pattern)!.name : d.name}` as FieldType;
      if (!child.fields.some((f) => f.type === ref)) child.fields.push({ key: d === person ? 'owner' : snake(d.name), name: d === person ? 'owner' : d.name.toLowerCase(), type: ref, meaning: `The ${d.name.toLowerCase()} it belongs to`, sensitivity: 'internal', required: true, from: 'your words', line });
      d.words.push({ text: l.text, line });
      continue;
    }
    if ((m = /^(?:the\s+)?(?:(.+?)['’]s\s+)?(.+?)\s+(?:is|are)\s+(private|sensitive|confidential|public)\b(?:\s+to\s+.+)?$/i.exec(t))) {
      const level: Sensitivity = /public/i.test(m[3]!) ? 'public' : 'private';
      const fkey = snake(bare(m[2]!));
      const owners = m[1] ? [find(m[1])].filter((x): x is Draft => !!x) : all().filter((d) => d.fields.some((f) => f.key === fkey));
      if (owners.length) {
        for (const d of owners) d.fields = d.fields.map((f) => (f.key === fkey ? { ...f, sensitivity: level, from: 'your words', line } : f));
        owners[0]!.words.push({ text: l.text, line });
        continue;
      }
    }
    if ((m = /^(?:an?|each|every|the|one)\s+(.+?)\s+(?:has|have|holds|records|keeps|includes)\s+(.+)$/i.exec(t))) {
      const d = ensure(m[1]!, line);
      for (const f of list(m[2]!)) addField(d, f, line);
      d.words.push({ text: l.text, line });
      continue;
    }
    unread.push({ text: l.text, line, why: 'It fits none of the shapes: "A … has …", "A … belongs to one …", "A … can have many …", "A … can be …", "The … is private", "Keep … for …"' });
  }

  // Payment needs what it pays; without one, the reference has nowhere to point.
  const names = new Map(all().map((d) => [d.pattern ? PATTERNS.patterns.find((x) => x.id === d.pattern)!.name : d.name, d]));
  for (const d of all()) d.fields = d.fields.filter((f) => !f.type.startsWith('ref:') || names.has(f.type.slice(4)));
  const consent = drafts.get('consent');

  // 3. Entities, in the order they must be created: what others point to first.
  const order: Draft[] = [];
  const visit = (d: Draft, seen: Set<Draft>) => {
    if (order.includes(d) || seen.has(d)) return;
    seen.add(d);
    for (const f of d.fields) if (f.type.startsWith('ref:')) visit(names.get(f.type.slice(4))!, seen);
    order.push(d);
  };
  for (const d of all()) visit(d, new Set());
  const keyOf = (type: string) => names.get(type.slice(4))!.key;
  const entities: Entity[] = order.map((d) => ({
    key: d.key,
    name: d.name,
    what: d.what,
    pattern: d.pattern,
    maintainedBy: d.pattern ? 'fleet' : 'local',
    fields: [{ key: 'id', name: 'id', type: 'id', meaning: 'A key that names nothing about the record', sensitivity: 'internal', required: true, from: 'system' }, ...d.fields],
    retention: d.retention,
    balloons: [...d.balloons].sort((a, b) => a - b),
    words: d.words,
  }));
  const relations: Relation[] = entities.flatMap((e) => e.fields.filter((f) => f.type.startsWith('ref:')).map((f) => ({ from: e.key, field: f.key, to: keyOf(f.type), meaning: f.meaning })));

  const q = (k: string) => `"${k}"`;
  const rules: Rule[] = [];
  for (const e of entities) {
    const d = order.find((x) => x.key === e.key)!;
    for (const f of e.fields.filter((x) => x.required && x.key !== 'id')) rules.push({ id: `${e.key}.${f.key}.present`, entity: e.key, text: `Every ${e.name.toLowerCase()} has its ${f.name}`, sql: `select id from ${q(e.key)} where ${q(f.key)} is null` });
    for (const f of e.fields.filter((x) => x.type.startsWith('ref:'))) {
      const to = keyOf(f.type);
      rules.push({ id: `${e.key}.${f.key}.real`, entity: e.key, text: `Every ${e.name.toLowerCase()}'s ${f.name} is a real ${entities.find((x) => x.key === to)!.name.toLowerCase()}`, sql: `select a.id from ${q(e.key)} a left join ${q(to)} b on b.id = a.${q(f.key)} where a.${q(f.key)} is not null and b.id is null` });
    }
    for (const f of e.fields.filter((x) => x.type === 'state' && x.states?.length)) rules.push({ id: `${e.key}.${f.key}.allowed`, entity: e.key, text: `A ${e.name.toLowerCase()}'s ${f.name} is one of: ${f.states!.join(', ')}`, sql: `select id from ${q(e.key)} where ${q(f.key)} not in (${f.states!.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ')})` });
    for (const r of d.rules) {
      const [kind, arg] = r.split(':') as [string, string];
      if (kind === 'nonnegative' || kind === 'positive') {
        const k = snake(arg);
        if (e.fields.some((f) => f.key === k)) rules.push({ id: `${e.key}.${k}.${kind}`, entity: e.key, text: `A ${e.name.toLowerCase()}'s ${arg} is ${kind === 'positive' ? 'more than' : 'never less than'} zero`, sql: `select id from ${q(e.key)} where ${q(k)} ${kind === 'positive' ? '<=' : '<'} 0` });
      } else if (kind === 'unique') {
        const k = snake(arg);
        if (!e.fields.some((f) => f.key === k)) continue;
        rules.push({ id: `${e.key}.${k}.unique`, entity: e.key, text: `No two ${e.name.toLowerCase()} records share a ${arg}`, sql: `select min(id) as id from ${q(e.key)} where ${q(k)} is not null group by ${q(k)} having count(*) > 1` });
      } else if (kind === 'order') {
        const [a, b] = arg.split('<').map(snake) as [string, string];
        if (!e.fields.some((f) => f.key === a) || !e.fields.some((f) => f.key === b)) continue;
        rules.push({ id: `${e.key}.${a}.before.${b}`, entity: e.key, text: `A ${e.name.toLowerCase()}'s ${a.replace(/_/g, ' ')} comes before its ${b.replace(/_/g, ' ')}`, sql: `select id from ${q(e.key)} where ${q(b)} is not null and ${q(b)} < ${q(a)}` });
      } else if (kind === 'distinct') {
        const [a, b] = arg.split(',').map(snake) as [string, string];
        if (!e.fields.some((f) => f.key === a) || !e.fields.some((f) => f.key === b)) continue;
        rules.push({ id: `${e.key}.${a}.not.${b}`, entity: e.key, text: `Nobody is granted their own records`, sql: `select id from ${q(e.key)} where ${q(a)} = ${q(b)}` });
      } else if (kind === 'consent' && consent) {
        const k = snake(arg);
        const ce = entities.find((x) => x.key === consent.key);
        if (!e.fields.some((f) => f.key === k) || !e.fields.some((f) => f.key === 'send_at') || !['person', 'given_at', 'withdrawn_at'].every((c) => ce?.fields.some((f) => f.key === c))) continue;
        rules.push({ id: `${e.key}.${k}.consented`, entity: e.key, text: `A ${e.name.toLowerCase()} goes only to someone who has agreed to be contacted and not taken it back`, sql: `select m.id from ${q(e.key)} m where not exists (select 1 from ${q(consent.key)} c where c.${q('person')} = m.${q(k)} and c.${q('given_at')} <= m.${q('send_at')} and (c.${q('withdrawn_at')} is null or c.${q('withdrawn_at')} > m.${q('send_at')}))` });
      }
    }
  }
  const canon = { entities: entities.map((e) => ({ ...e, words: e.words.map((w) => w.text) })), relations, rules: rules.map((r) => r.id) };
  return { entities, relations, rules, unread, hash: sha256(JSON.stringify(canon)) };
}

// ---------------------------------------------------------------- the schema as the database, the checks and the documents

const SQL_TYPE: Record<string, string> = { id: 'varchar', text: 'varchar', money: 'decimal(12,2)', date: 'date', timestamp: 'timestamp', integer: 'integer', boolean: 'boolean', email: 'varchar', phone: 'varchar', state: 'varchar' };
const lit = (t: string) => `'${t.replace(/'/g, "''")}'`;
const qi = (k: string) => `"${k}"`;

export function ddl(s: Schema): string {
  const byKey = new Map(s.entities.map((e) => [e.key, e]));
  const tables = s.entities.map((e) => {
    const cols = e.fields.map((f) => {
      const ref = f.type.startsWith('ref:') ? s.relations.find((r) => r.from === e.key && r.field === f.key) : undefined;
      const type = ref ? 'varchar' : SQL_TYPE[f.type]!;
      const checks = [f.type === 'state' && f.states?.length ? `check (${qi(f.key)} in (${f.states.map(lit).join(', ')}))` : '', f.type === 'money' ? `check (${qi(f.key)} >= 0)` : ''].filter(Boolean).join(' ');
      return `  ${qi(f.key)} ${type}${f.key === 'id' ? ' primary key' : f.required ? ' not null' : ''}${ref ? ` references ${qi(byKey.get(ref.to)!.key)} (id)` : ''}${checks ? ` ${checks}` : ''}`;
    });
    const comments = [`comment on table ${qi(e.key)} is ${lit(`${e.name}: ${e.what} Kept ${e.retention}. ${e.maintainedBy === 'fleet' ? 'A fleet pattern' : 'Yours'}.`)};`, ...e.fields.map((f) => `comment on column ${qi(e.key)}.${qi(f.key)} is ${lit(`${f.meaning}. ${cap(f.sensitivity)}.${f.from === 'your words' ? ` Your words, line ${f.line}.` : ''}`)};`)];
    return `create table ${qi(e.key)} (\n${cols.join(',\n')}\n);\n${comments.join('\n')}`;
  });
  return `-- The information schema, signed with the schematic. Generated; change the intent, not this file.\n-- Schema ${s.hash.slice(0, 12)}. Tables are in the order they must be created.\n\n${tables.join('\n\n')}\n`;
}

export function integritySql(s: Schema): string {
  return `-- Integrity checks: each query returns the records that break one rule. An empty result is a pass.\n-- They read the data alone, so they hold whatever code wrote it.\n\n${s.rules.map((r) => `-- ${r.id}: ${r.text}\n${r.sql};`).join('\n\n')}\n`;
}

export interface Change {
  readonly kind: 'added' | 'retired' | 'changed';
  readonly what: string;
  readonly breaking: boolean;
  readonly sql: string;
}

/** What changed since the last signed schema, and a migration that keeps every record: nothing is ever dropped. */
export function changes(before: Schema | null, after: Schema, revision: number): Change[] {
  if (!before) return [];
  const out: Change[] = [];
  const old = new Map(before.entities.map((e) => [e.key, e]));
  for (const e of after.entities) {
    const was = old.get(e.key);
    if (!was) {
      out.push({ kind: 'added', what: `${e.name}, a new record`, breaking: false, sql: ddl({ ...after, entities: [e], relations: after.relations.filter((r) => r.from === e.key) }).split('\n').filter((l) => !l.startsWith('--')).join('\n').trim() });
      continue;
    }
    const of = new Map(was.fields.map((f) => [f.key, f]));
    for (const f of e.fields) {
      const w = of.get(f.key);
      if (!w) out.push({ kind: 'added', what: `${e.name}: ${f.name}`, breaking: false, sql: `alter table ${qi(e.key)} add column ${qi(f.key)} ${f.type.startsWith('ref:') ? 'varchar' : SQL_TYPE[f.type]};${f.required ? `\n-- Required from now on: filled for existing records before the check is turned on.` : ''}` });
      else if (w.type !== f.type) out.push({ kind: 'changed', what: `${e.name}: ${f.name} from ${w.type} to ${f.type}`, breaking: true, sql: `alter table ${qi(e.key)} add column ${qi(`${f.key}_r${revision}`)} ${f.type.startsWith('ref:') ? 'varchar' : SQL_TYPE[f.type]};\nupdate ${qi(e.key)} set ${qi(`${f.key}_r${revision}`)} = cast(${qi(f.key)} as ${f.type.startsWith('ref:') ? 'varchar' : SQL_TYPE[f.type]});\n-- The old column is kept, retired, until a person decides it can go.` });
      else if (JSON.stringify(w.states ?? []) !== JSON.stringify(f.states ?? [])) {
        const dropped = (w.states ?? []).filter((x) => !(f.states ?? []).includes(x));
        out.push({ kind: 'changed', what: `${e.name}: ${f.name} may now be ${(f.states ?? []).join(', ')}`, breaking: dropped.length > 0, sql: `-- Allowed ${f.name} values: ${(f.states ?? []).join(', ')}.${dropped.length ? ` Records already ${dropped.join(' or ')} keep their value and are listed by the integrity check until a person moves them.` : ''}` });
      } else if (!w.required && f.required) out.push({ kind: 'changed', what: `${e.name}: ${f.name} is now required`, breaking: true, sql: `-- Fill ${f.name} for existing records, then: alter table ${qi(e.key)} alter column ${qi(f.key)} set not null;` });
    }
    for (const w of was.fields) if (!e.fields.some((f) => f.key === w.key)) out.push({ kind: 'retired', what: `${e.name}: ${w.name}`, breaking: true, sql: `comment on column ${qi(e.key)}.${qi(w.key)} is ${lit(`Retired in revision ${revision}. Kept: the factory never drops data.`)};` });
  }
  for (const w of before.entities) if (!after.entities.some((e) => e.key === w.key)) out.push({ kind: 'retired', what: `${w.name}, the whole record`, breaking: true, sql: `comment on table ${qi(w.key)} is ${lit(`Retired in revision ${revision}. Kept: the factory never drops data.`)};` });
  return out;
}

export function schemaFiles(s: Schema, before: Schema | null, revision: number): Record<string, string> {
  const cell = (t: string) => t.replace(/\|/g, '\\|');
  const erd = `erDiagram\n${s.relations.map((r) => `  ${r.to.toUpperCase()} ||--o{ ${r.from.toUpperCase()} : "${r.field.replace(/_/g, ' ')}"`).join('\n')}\n${s.entities.map((e) => `  ${e.key.toUpperCase()} {\n${e.fields.map((f) => `    ${f.type.startsWith('ref:') ? 'string' : f.type === 'money' ? 'decimal' : f.type === 'state' || f.type === 'email' || f.type === 'phone' || f.type === 'id' ? 'string' : f.type} ${f.key}${f.key === 'id' ? ' PK' : f.type.startsWith('ref:') ? ' FK' : ''}`).join('\n')}\n  }`).join('\n')}`;
  const ch = changes(before, s, revision);
  const md = `# The information it keeps

What the software keeps is the one part of it that cannot be rebuilt, so it is signed with the schematic. Screens, the API, reports, docs and training are generated from the intent and can be regenerated at will; these records cannot. Each entity is a fleet pattern named in the intent's words, or a record described in your own sentences. Schema \`${s.hash.slice(0, 12)}\`.

\`\`\`mermaid
${erd}
\`\`\`

${s.entities.map((e) => `## ${e.name}

${e.what} Kept ${e.retention}. ${e.maintainedBy === 'fleet' ? `A fleet pattern (${e.pattern}): its standard fields and rules are maintained once for every app.` : 'Described in your own words; your team maintains it.'}${e.balloons.length ? ` Called for by balloons ${e.balloons.join(', ')}.` : ''}
${e.words.length ? `\nIn your words:\n\n${e.words.map((w) => `> ${w.text} _(line ${w.line})_`).join('\n>\n')}\n` : ''}
| Field | Type | Means | Sensitivity | Required | From |
| --- | --- | --- | --- | --- | --- |
${e.fields.map((f) => `| ${f.name} | ${f.type.startsWith('ref:') ? `→ ${s.entities.find((x) => x.key === s.relations.find((y) => y.from === e.key && y.field === f.key)?.to)?.name ?? f.type.slice(4)}` : f.type}${f.states ? `: ${f.states.join(', ')}` : ''} | ${cell(f.meaning)} | ${f.sensitivity} | ${f.required ? 'yes' : ''} | ${f.from === 'your words' ? `your words, line ${f.line}` : f.from} |`).join('\n')}
`).join('\n')}
## Integrity rules

Each is a query that returns the records breaking it (\`information/integrity.sql\`), so the data can be checked on its own, whatever code wrote it.

${s.rules.map((r) => `- ${r.text}`).join('\n')}
${s.unread.length ? `\n## Sentences not read yet\n\n${s.unread.map((u) => `- Line ${u.line}: "${u.text}". ${u.why}`).join('\n')}\n` : ''}${ch.length ? `\n## Changed since the last signed schema\n\n| Change | What | Breaks existing records? |\n| --- | --- | --- |\n${ch.map((c) => `| ${c.kind} | ${cell(c.what)} | ${c.breaking ? 'yes: migrated, nothing dropped' : 'no'} |`).join('\n')}\n` : ''}`;
  const files: Record<string, string> = {
    'information/schema.json': `${JSON.stringify({ schema: 'zthr-information-schema/1', hash: s.hash, entities: s.entities, relations: s.relations, rules: s.rules.map(({ id, entity, text }) => ({ id, entity, text })), unread: s.unread }, null, 1)}\n`,
    'information/schema.md': md,
    'information/schema.sql': ddl(s),
    'information/schema.prisma': toPrisma(s),
    'information/integrity.sql': integritySql(s),
  };
  Object.assign(files, pipelineFiles(s, before, revision));
  if (ch.length) files[`information/migrations/revision-${revision}.sql`] = `-- Revision ${revision}: ${ch.length} change${ch.length === 1 ? '' : 's'} to the information schema. Nothing is dropped.\n\n${ch.map((c) => `-- ${c.kind}: ${c.what}${c.breaking ? ' (breaks existing records: migrated)' : ''}\n${c.sql}`).join('\n\n')}\n`;
  return files;
}
