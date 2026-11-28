/**
 * A store for prompts the way code is stored: every change is a new immutable version with a content hash, an
 * author and a note; variables are declared and checked; labels such as `production` point at versions; eval sets
 * score a version against known cases; and a new version reaches people through a flag-based rollout that can be
 * widened, halted or rolled back in one step.
 *
 * Templates (`parseTemplate`, `render`): `{{name}}` inserts a variable, `{{#if name}}...{{else}}...{{/if}}` includes
 * text when a variable is present and non-empty, and `\{{` is a literal. Variables are declared with a type
 * (string, number, boolean, list), whether they are required, a default, a maximum length and an optional list of
 * allowed values. `checkDraft` finds variables used but not declared, and declared but never used. Rendering
 * refuses unknown or mistyped values, values over their length, and values outside an allowed list. A variable
 * marked `untrusted` (user text, retrieved documents) is wrapped in `<name>...</name>` tags with any such tags
 * inside it defused, so the prompt can tell the model to treat the inside as data.
 *
 * Evals: a case is variable values plus checks (contains, not-contains, equals, regex, valid JSON, a JSON field
 * equals, a length limit). `runEval` renders the version, calls the model you pass in, and records each check;
 * `compareRuns` lists regressions and improvements case by case; `gate` says whether a run is good enough to ship.
 *
 * Rollout: `startRollout` makes a flag (flags block) that sends a percentage of people to a candidate version and
 * everyone else to the stable one. The same person always gets the same side, widening only adds people, a kill
 * switch sends everyone back to stable at once, and `promote` makes the candidate the stable version. The flag
 * rules and the person-to-bucket hash are those of the flags block.
 *
 * The clock is an argument. Out of scope: calling models in production (pass your own function), storage, and cost
 * accounting.
 */
import { createHash } from 'node:crypto';
import { evaluate, type Flag, type Who } from '../flags/index.ts';

export class PromptStoreError extends Error {
  readonly code: 'invalid' | 'not-found' | 'conflict' | 'refused';
  constructor(code: PromptStoreError['code'], message: string) {
    super(message);
    this.name = 'PromptStoreError';
    this.code = code;
  }
}

export type VarType = 'string' | 'number' | 'boolean' | 'list';

export interface VarSpec {
  readonly name: string;
  readonly type: VarType;
  readonly required?: boolean;
  readonly default?: string | number | boolean | readonly string[];
  readonly maxLength?: number;
  readonly oneOf?: readonly string[];
  readonly untrusted?: boolean;
}

export interface MessageTemplate {
  readonly role: 'system' | 'user' | 'assistant';
  readonly template: string;
}

export interface Draft {
  readonly messages: readonly MessageTemplate[];
  readonly variables: readonly VarSpec[];
  readonly model?: { readonly name: string; readonly temperature?: number; readonly maxTokens?: number };
}

export interface Version extends Draft {
  readonly name: string;
  readonly version: number;
  readonly hash: string;
  readonly author: string;
  readonly note: string;
  readonly createdAt: number;
}

export type Values = Readonly<Record<string, string | number | boolean | readonly string[]>>;

// ---------------------------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------------------------

type Node =
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'var'; readonly name: string }
  | { readonly t: 'if'; readonly name: string; readonly then: Node[]; readonly otherwise: Node[] };

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TEMPLATE = 100_000;

export function parseTemplate(src: string): Node[] {
  if (src.length > MAX_TEMPLATE) throw new PromptStoreError('invalid', `a template over ${MAX_TEMPLATE} characters`);
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: 'if' }>; inElse: boolean }[] = [];
  const cur = (): Node[] => (stack.length ? (stack[stack.length - 1]!.inElse ? stack[stack.length - 1]!.node.otherwise : stack[stack.length - 1]!.node.then) : root);
  const re = /\\\{\{|\{\{\s*([^{}]*?)\s*\}\}/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index > last) cur().push({ t: 'text', text: src.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[0] === '\\{{') {
      cur().push({ t: 'text', text: '{{' });
      continue;
    }
    const tag = m[1]!;
    const ifm = /^#if\s+(\S+)$/.exec(tag);
    if (ifm) {
      if (!NAME.test(ifm[1]!)) throw new PromptStoreError('invalid', `${JSON.stringify(ifm[1])} is not a variable name`);
      const node: Extract<Node, { t: 'if' }> = { t: 'if', name: ifm[1]!, then: [], otherwise: [] };
      cur().push(node);
      stack.push({ node, inElse: false });
      if (stack.length > 8) throw new PromptStoreError('invalid', 'conditions nested more than 8 deep');
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.inElse) throw new PromptStoreError('invalid', '{{else}} without an open {{#if}}');
      top.inElse = true;
    } else if (tag === '/if') {
      if (!stack.pop()) throw new PromptStoreError('invalid', '{{/if}} without an open {{#if}}');
    } else if (NAME.test(tag)) cur().push({ t: 'var', name: tag });
    else throw new PromptStoreError('invalid', `unknown tag {{${tag}}}`);
  }
  if (last < src.length) cur().push({ t: 'text', text: src.slice(last) });
  if (stack.length) throw new PromptStoreError('invalid', 'an {{#if}} is never closed');
  return root;
}

function used(nodes: readonly Node[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.t === 'var') out.add(n.name);
    else if (n.t === 'if') {
      out.add(n.name);
      used(n.then, out);
      used(n.otherwise, out);
    }
  }
  return out;
}

export interface DraftReport {
  readonly errors: string[];
  readonly warnings: string[];
}

/** Check a draft before it is stored: parse errors, undeclared and unused variables, bad specs. */
export function checkDraft(d: Draft): DraftReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (d.messages.length === 0) errors.push('a prompt needs at least one message');
  const declared = new Map<string, VarSpec>();
  for (const v of d.variables) {
    if (!NAME.test(v.name)) errors.push(`${JSON.stringify(v.name)} is not a variable name`);
    if (declared.has(v.name)) errors.push(`variable ${v.name} is declared twice`);
    declared.set(v.name, v);
    if (v.required && v.default !== undefined) warnings.push(`variable ${v.name} is required and has a default; the default is never used`);
    if (v.oneOf && v.type !== 'string') errors.push(`variable ${v.name}: oneOf applies to strings`);
    if (v.default !== undefined && !valueFits(v, v.default)) errors.push(`the default of ${v.name} does not fit its own rules`);
  }
  const usedAll = new Set<string>();
  d.messages.forEach((m, i) => {
    try {
      used(parseTemplate(m.template), usedAll);
    } catch (e) {
      errors.push(`message ${i + 1}: ${(e as Error).message}`);
    }
  });
  for (const u of usedAll) if (!declared.has(u)) errors.push(`variable ${u} is used but not declared`);
  for (const k of declared.keys()) if (!usedAll.has(k)) warnings.push(`variable ${k} is declared but never used`);
  if (d.model?.temperature !== undefined && !(d.model.temperature >= 0 && d.model.temperature <= 2)) errors.push('temperature is from 0 to 2');
  return { errors, warnings };
}

function valueFits(v: VarSpec, x: unknown): boolean {
  switch (v.type) {
    case 'string':
      return typeof x === 'string' && (v.maxLength === undefined || [...x].length <= v.maxLength) && (v.oneOf === undefined || v.oneOf.includes(x));
    case 'number':
      return typeof x === 'number' && Number.isFinite(x);
    case 'boolean':
      return typeof x === 'boolean';
    case 'list':
      return Array.isArray(x) && x.every((i) => typeof i === 'string') && (v.maxLength === undefined || x.join('\n').length <= v.maxLength);
  }
}

const TAG = /<\/?\s*([A-Za-z_][A-Za-z0-9_]*)\s*>/g;

const present = (x: unknown): boolean => x !== undefined && x !== '' && x !== false && !(Array.isArray(x) && x.length === 0);

/** Fill a version's templates. Throws PromptStoreError for anything the declarations do not allow. */
export function render(v: Draft, values: Values): { role: MessageTemplate['role']; content: string }[] {
  const specs = new Map(v.variables.map((s) => [s.name, s]));
  for (const k of Object.keys(values)) if (!specs.has(k)) throw new PromptStoreError('invalid', `unknown variable ${k}`);
  const final: Record<string, unknown> = {};
  for (const s of v.variables) {
    let x: unknown = Object.hasOwn(values, s.name) ? values[s.name] : undefined;
    if (x === undefined) {
      if (s.required) throw new PromptStoreError('invalid', `variable ${s.name} is required`);
      x = s.default;
    }
    if (x !== undefined && !valueFits(s, x)) {
      throw new PromptStoreError('invalid', `variable ${s.name} must be a ${s.type}${s.maxLength !== undefined ? ` of at most ${s.maxLength}` : ''}${s.oneOf ? ` from ${s.oneOf.join(', ')}` : ''}`);
    }
    final[s.name] = x;
  }
  const text = (name: string): string => {
    const s = specs.get(name)!;
    const x = final[name];
    if (x === undefined) return '';
    let out = Array.isArray(x) ? x.map((i) => `- ${i}`).join('\n') : String(x);
    if (s.untrusted) {
      out = out.replace(TAG, (m, tag: string) => (tag.toLowerCase() === name.toLowerCase() ? m.replace('<', '< ') : m));
      return `<${name}>\n${out}\n</${name}>`;
    }
    return out;
  };
  const walk = (nodes: readonly Node[]): string =>
    nodes
      .map((n) => (n.t === 'text' ? n.text : n.t === 'var' ? text(n.name) : walk(present(final[n.name]) ? n.then : n.otherwise)))
      .join('');
  return v.messages.map((m) => ({ role: m.role, content: walk(parseTemplate(m.template)) }));
}

// ---------------------------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------------------------

const hashOf = (d: Draft): string => createHash('sha256').update(JSON.stringify({ m: d.messages, v: d.variables, o: d.model ?? null })).digest('hex').slice(0, 16);

export interface Diff {
  readonly messages: { readonly index: number; readonly role: string; readonly added: string[]; readonly removed: string[] }[];
  readonly variables: { readonly added: string[]; readonly removed: string[]; readonly changed: string[] };
  readonly modelChanged: boolean;
}

function lineDiff(a: string, b: string): { added: string[]; removed: string[] } {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) removed.push(x[i++]!);
    else added.push(y[j++]!);
  }
  while (i < x.length) removed.push(x[i++]!);
  while (j < y.length) added.push(y[j++]!);
  return { added, removed };
}

export class PromptStore {
  readonly #versions = new Map<string, Version[]>();
  readonly #labels = new Map<string, Map<string, number>>();
  readonly #now: () => number;
  readonly #rollouts = new Map<string, Rollout>();

  constructor(now: () => number) {
    this.#now = now;
  }

  names(): string[] {
    return [...this.#versions.keys()].sort();
  }

  /** Store a new version. Identical to the latest content: nothing is stored and the latest comes back with `created: false`. */
  publish(name: string, d: Draft, o: { author: string; note: string }): { version: Version; created: boolean; warnings: string[] } {
    if (!/^[a-z0-9][a-z0-9._/-]{0,95}$/.test(name)) throw new PromptStoreError('invalid', 'a prompt name is lower case letters, digits and . _ / -');
    if (o.note.trim() === '') throw new PromptStoreError('invalid', 'a version needs a note saying what changed');
    const report = checkDraft(d);
    if (report.errors.length) throw new PromptStoreError('invalid', report.errors.join('; '));
    const list = this.#versions.get(name) ?? [];
    const hash = hashOf(d);
    const latest = list[list.length - 1];
    if (latest && latest.hash === hash) return { version: latest, created: false, warnings: report.warnings };
    const v: Version = { ...d, name, version: list.length + 1, hash, author: o.author, note: o.note, createdAt: this.#now() };
    this.#versions.set(name, [...list, v]);
    return { version: v, created: true, warnings: report.warnings };
  }

  get(name: string, ref: number | string = 'latest'): Version {
    const list = this.#versions.get(name);
    if (!list) throw new PromptStoreError('not-found', `no prompt ${name}`);
    let n: number | undefined;
    if (typeof ref === 'number') n = ref;
    else if (ref === 'latest') n = list.length;
    else n = this.#labels.get(name)?.get(ref);
    const v = n === undefined ? undefined : list[n - 1];
    if (!v) throw new PromptStoreError('not-found', `${name} has no version ${String(ref)}`);
    return v;
  }

  history(name: string): readonly Version[] {
    const l = this.#versions.get(name);
    if (!l) throw new PromptStoreError('not-found', `no prompt ${name}`);
    return l;
  }

  /** Point a label (production, staging) at a version. Moving a label is how a rollback is done. */
  setLabel(name: string, label: string, version: number): void {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(label) || label === 'latest') throw new PromptStoreError('invalid', 'a label is lower case letters, digits and -');
    this.get(name, version);
    const m = this.#labels.get(name) ?? new Map<string, number>();
    m.set(label, version);
    this.#labels.set(name, m);
  }

  labels(name: string): Record<string, number> {
    return Object.fromEntries(this.#labels.get(name) ?? []);
  }

  diff(name: string, a: number, b: number): Diff {
    const x = this.get(name, a);
    const y = this.get(name, b);
    const messages: Diff['messages'][number][] = [];
    for (let i = 0; i < Math.max(x.messages.length, y.messages.length); i++) {
      const p = x.messages[i];
      const q = y.messages[i];
      const d = lineDiff(p?.template ?? '', q?.template ?? '');
      if (d.added.length || d.removed.length || p?.role !== q?.role) messages.push({ index: i, role: q?.role ?? p!.role, ...d });
    }
    const xv = new Map(x.variables.map((v) => [v.name, JSON.stringify(v)]));
    const yv = new Map(y.variables.map((v) => [v.name, JSON.stringify(v)]));
    return {
      messages,
      variables: {
        added: [...yv.keys()].filter((k) => !xv.has(k)),
        removed: [...xv.keys()].filter((k) => !yv.has(k)),
        changed: [...yv.keys()].filter((k) => xv.has(k) && xv.get(k) !== yv.get(k)),
      },
      modelChanged: JSON.stringify(x.model ?? null) !== JSON.stringify(y.model ?? null),
    };
  }

  /** Render a version for values. */
  render(name: string, ref: number | string, values: Values): { version: Version; messages: { role: MessageTemplate['role']; content: string }[] } {
    const version = this.get(name, ref);
    return { version, messages: render(version, values) };
  }

  // ---- rollout

  /** Send a share of people to `candidate`, everyone else to `stable`. The flag key is `prompt:<name>`. */
  startRollout(name: string, candidate: number, percent: number, o: { owner: string; stable?: number | string }): Rollout {
    if (this.#rollouts.has(name)) throw new PromptStoreError('conflict', `${name} already has a rollout in progress`);
    const stable = this.get(name, o.stable ?? 'production');
    const cand = this.get(name, candidate);
    if (cand.version === stable.version) throw new PromptStoreError('invalid', 'the candidate is already the stable version');
    if (!(percent >= 0 && percent <= 100)) throw new PromptStoreError('invalid', 'a percentage is from 0 to 100');
    const r: Rollout = { name, stable: stable.version, candidate: cand.version, flag: { key: `prompt:${name}`, description: `rollout of ${name} v${cand.version}`, owner: o.owner, on: true, rules: [{ percent }] } };
    this.#rollouts.set(name, r);
    return r;
  }

  rollout(name: string): Rollout | undefined {
    return this.#rollouts.get(name);
  }

  /** Widen the share. It only ever grows, so nobody who had the candidate loses it. */
  widen(name: string, percent: number): Rollout {
    const r = this.#rollouts.get(name);
    if (!r) throw new PromptStoreError('not-found', `no rollout for ${name}`);
    const cur = r.flag.rules?.[0]?.percent ?? 0;
    if (!(percent >= cur && percent <= 100)) throw new PromptStoreError('refused', `the share can only grow: it is ${cur}% and ${percent}% was asked`);
    const next: Rollout = { ...r, flag: { ...r.flag, rules: [{ percent }] } };
    this.#rollouts.set(name, next);
    return next;
  }

  /** The kill switch: everyone gets the stable version at once, and the rollout is kept for the record until ended. */
  halt(name: string): Rollout {
    const r = this.#rollouts.get(name);
    if (!r) throw new PromptStoreError('not-found', `no rollout for ${name}`);
    const next: Rollout = { ...r, flag: { ...r.flag, killed: true } };
    this.#rollouts.set(name, next);
    return next;
  }

  /** Make the candidate the stable (`production`) version and end the rollout. Refused while halted. */
  promote(name: string): number {
    const r = this.#rollouts.get(name);
    if (!r) throw new PromptStoreError('not-found', `no rollout for ${name}`);
    if (r.flag.killed) throw new PromptStoreError('refused', 'a halted rollout cannot be promoted');
    this.setLabel(name, 'production', r.candidate);
    this.#rollouts.delete(name);
    return r.candidate;
  }

  /** End a rollout without promoting: everyone stays on stable. */
  abandon(name: string): void {
    this.#rollouts.delete(name);
  }

  /** The version this person gets, and why. With no rollout, the `production` label, or the latest version. */
  resolve(name: string, who: Who): { version: Version; because: string } {
    const r = this.#rollouts.get(name);
    if (r) {
      const e = evaluate(r.flag, who);
      return e.on ? { version: this.get(name, r.candidate), because: `candidate: ${e.because}` } : { version: this.get(name, r.stable), because: `stable: ${e.because}` };
    }
    const prod = this.#labels.get(name)?.get('production');
    return prod ? { version: this.get(name, prod), because: 'production label' } : { version: this.get(name), because: 'latest version (no production label)' };
  }
}

export interface Rollout {
  readonly name: string;
  readonly stable: number;
  readonly candidate: number;
  readonly flag: Flag;
}

// ---------------------------------------------------------------------------------------------------------------
// Evals
// ---------------------------------------------------------------------------------------------------------------

export type Check =
  | { readonly kind: 'contains'; readonly value: string; readonly ignoreCase?: boolean }
  | { readonly kind: 'not-contains'; readonly value: string; readonly ignoreCase?: boolean }
  | { readonly kind: 'equals'; readonly value: string }
  | { readonly kind: 'regex'; readonly pattern: string; readonly flags?: string }
  | { readonly kind: 'json' }
  | { readonly kind: 'json-field'; readonly path: string; readonly equals: string | number | boolean | null }
  | { readonly kind: 'max-length'; readonly chars: number };

export interface EvalCase {
  readonly id: string;
  readonly values: Values;
  readonly checks: readonly Check[];
}

export interface EvalSet {
  readonly id: string;
  readonly prompt: string;
  readonly cases: readonly EvalCase[];
}

export type Model = (messages: readonly { role: MessageTemplate['role']; content: string }[], params: NonNullable<Draft['model']> | undefined) => Promise<string>;

export interface CaseResult {
  readonly id: string;
  readonly passed: boolean;
  readonly failures: string[];
  readonly output: string;
}

export interface EvalRun {
  readonly prompt: string;
  readonly version: number;
  readonly set: string;
  readonly results: CaseResult[];
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
}

const jsonPath = (v: unknown, path: string): unknown => {
  let cur = v;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(part)] : Object.hasOwn(cur, part) ? (cur as Record<string, unknown>)[part] : undefined;
  }
  return cur;
};

export function runCheck(c: Check, output: string): string | undefined {
  switch (c.kind) {
    case 'contains':
      return (c.ignoreCase ? output.toLowerCase().includes(c.value.toLowerCase()) : output.includes(c.value)) ? undefined : `expected to contain ${JSON.stringify(c.value)}`;
    case 'not-contains':
      return (c.ignoreCase ? output.toLowerCase().includes(c.value.toLowerCase()) : output.includes(c.value)) ? `expected not to contain ${JSON.stringify(c.value)}` : undefined;
    case 'equals':
      return output.trim() === c.value ? undefined : `expected exactly ${JSON.stringify(c.value)}`;
    case 'regex': {
      if (c.pattern.length > 300 || /\([^()]*[+*][^()]*\)[+*{]/.test(c.pattern)) throw new PromptStoreError('invalid', 'a regex check that is too long or could run for ever');
      return new RegExp(c.pattern, c.flags?.replace(/[^imsu]/g, '')).test(output) ? undefined : `expected to match /${c.pattern}/`;
    }
    case 'json':
      try {
        JSON.parse(output);
        return undefined;
      } catch {
        return 'expected valid JSON';
      }
    case 'json-field': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(output);
      } catch {
        return 'expected valid JSON';
      }
      const got = jsonPath(parsed, c.path);
      return got === c.equals ? undefined : `expected ${c.path} to be ${JSON.stringify(c.equals)}, got ${JSON.stringify(got)}`;
    }
    case 'max-length':
      return output.length <= c.chars ? undefined : `expected at most ${c.chars} characters, got ${output.length}`;
  }
}

/** Render the version for each case, call the model, run the checks. A model that throws fails that case, not the run. */
export async function runEval(store: PromptStore, name: string, version: number, set: EvalSet, model: Model): Promise<EvalRun> {
  if (set.prompt !== name) throw new PromptStoreError('invalid', `the eval set is for ${set.prompt}, not ${name}`);
  const v = store.get(name, version);
  const results: CaseResult[] = [];
  for (const c of set.cases) {
    const failures: string[] = [];
    let output = '';
    try {
      output = await model(render(v, c.values), v.model);
      for (const k of c.checks) {
        const f = runCheck(k, output);
        if (f) failures.push(f);
      }
    } catch (e) {
      failures.push(`error: ${(e as Error).message}`);
    }
    results.push({ id: c.id, passed: failures.length === 0, failures, output });
  }
  const passed = results.filter((r) => r.passed).length;
  return { prompt: name, version, set: set.id, results, passed, total: results.length, passRate: results.length ? passed / results.length : 0 };
}

export interface Comparison {
  readonly regressions: string[];
  readonly improvements: string[];
  readonly unchanged: number;
}

export function compareRuns(base: EvalRun, next: EvalRun): Comparison {
  const b = new Map(base.results.map((r) => [r.id, r.passed]));
  const regressions: string[] = [];
  const improvements: string[] = [];
  let unchanged = 0;
  for (const r of next.results) {
    const was = b.get(r.id);
    if (was === undefined || was === r.passed) unchanged++;
    else if (was) regressions.push(r.id);
    else improvements.push(r.id);
  }
  return { regressions, improvements, unchanged };
}

/** May this run ship? It must reach the pass rate, and cause no regression against the baseline when one is given. */
export function gate(run: EvalRun, o: { minPassRate: number; baseline?: EvalRun; allowRegressions?: number }): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (run.total === 0) reasons.push('the eval set has no cases');
  if (run.passRate < o.minPassRate) reasons.push(`pass rate ${Math.round(run.passRate * 100)}% is under ${Math.round(o.minPassRate * 100)}%`);
  if (o.baseline) {
    const c = compareRuns(o.baseline, run);
    if (c.regressions.length > (o.allowRegressions ?? 0)) reasons.push(`regressions on ${c.regressions.join(', ')}`);
  }
  return { ok: reasons.length === 0, reasons };
}
