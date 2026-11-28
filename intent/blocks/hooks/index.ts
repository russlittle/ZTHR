/**
 * Actions and filters: the way a plugin changes what a program does without the program knowing the plugin. An
 * action announces that something happened and every listener runs; a filter passes a value through its listeners,
 * each returning the value for the next. Shaped after WordPress (add_action, add_filter, apply_filters, priorities
 * where lower runs first and ties keep the order of adding, removal, how many arguments a callback takes, hasFilter,
 * didAction, the stack of hooks running), with these rules made explicit: a callback added while a hook runs
 * joins it if it sorts after the one running, a callback removed before its turn does not run, a hook may run
 * itself only to a depth limit, and one listener failing is recorded and skipped (or thrown, by option) rather than
 * silently breaking the rest. A catalogue says what each hook is, since when, with which arguments, and whether it is
 * deprecated: registering on a hook nobody declared is refused with a "did you mean" (strict mode), a deprecated
 * hook still works and says so once per listener, and running a replacement also runs listeners of the hook it
 * replaced. Hooks can be named by a pattern (`save_post_{type}`), listeners belong to an owner so a plugin can be
 * unloaded in one call, and the catalogue prints as Markdown for plugin authors. Async listeners run one after
 * another, in the same order.
 *
 * Out of scope: running listeners in another process or thread, and timing (callers wrap what they need).
 */

export class HookError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Kind = 'action' | 'filter';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Callback = (...args: any[]) => unknown;

export interface ArgDoc {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
}

export interface HookDoc {
  /** A name, or a pattern with {placeholders}: `save_post_{type}`. */
  readonly name: string;
  readonly kind: Kind;
  readonly since: string;
  readonly description: string;
  readonly args: readonly ArgDoc[];
  /** For a filter: what the value is and what a listener must return. */
  readonly returns?: string;
  readonly deprecated?: { readonly since: string; readonly replacement?: string; readonly message?: string };
}

export interface Warning {
  readonly kind: 'deprecated-hook' | 'returned-undefined' | 'listener-failed';
  readonly hook: string;
  readonly listener?: string;
  readonly message: string;
}

export interface Options {
  /** Refuse listeners on hooks that are not declared in the catalogue. Default false. */
  readonly strict?: boolean;
  /** What to do when a listener throws: record it and carry on (default), or throw to the caller. */
  readonly onError?: 'isolate' | 'throw';
  /** How deep hooks may run inside hooks. Default 20. */
  readonly maxDepth?: number;
  /** Called with every warning as well as keeping it in `warnings()`. */
  readonly onWarning?: (w: Warning) => void;
}

export interface AddOptions {
  /** Lower runs first. Default 10. */
  readonly priority?: number;
  /** How many arguments the listener takes; extra ones are not passed. Default 1. */
  readonly args?: number;
  readonly owner?: string;
  /** Runs once, then removes itself. */
  readonly once?: boolean;
  /** A name for logs and warnings. */
  readonly label?: string;
}

interface Listener {
  readonly id: string;
  readonly fn: Callback;
  readonly priority: number;
  readonly seq: number;
  readonly args: number;
  readonly owner: string | undefined;
  readonly once: boolean;
  readonly label: string;
}

const NAME = /^[a-z][a-z0-9_.:-]{0,99}$/;
const PATTERN = /^[a-z][a-z0-9_.:-]{0,60}(?:\{[a-z_][a-z0-9_]*\}[a-z0-9_.:-]*)+$/;

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_v, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const patternRegex = (p: string) => new RegExp(`^${p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[a-z_][a-z0-9_]*\}/g, '[a-z0-9_.:-]+')}$`);

export class Hooks {
  private readonly o: Options;
  private readonly lists = new Map<string, Listener[]>();
  private readonly docs = new Map<string, HookDoc>();
  private readonly patterns: { re: RegExp; doc: HookDoc }[] = [];
  private readonly ran = new Map<string, number>();
  private readonly stack: string[] = [];
  private readonly warned = new Set<string>();
  private readonly log: Warning[] = [];
  private seq = 0;
  private ids = 0;

  constructor(o: Options = {}) {
    this.o = o;
  }

  // ------------------------------------------------------------ the catalogue

  /** Declares a hook so plugin authors can find it and typos are caught. */
  declare(doc: HookDoc): void {
    const isPattern = doc.name.includes('{');
    if (isPattern ? !PATTERN.test(doc.name) : !NAME.test(doc.name)) throw new HookError(`"${doc.name.slice(0, 60)}" is not a usable hook name`);
    if (this.docs.has(doc.name)) throw new HookError(`hook ${doc.name} is declared twice`);
    if (!doc.description.trim()) throw new HookError(`hook ${doc.name} needs a description`);
    if (doc.kind === 'filter' && doc.args.length === 0) throw new HookError(`filter ${doc.name} must declare the value as its first argument`);
    const seen = new Set<string>();
    for (const a of doc.args) {
      if (seen.has(a.name)) throw new HookError(`hook ${doc.name} has two arguments called ${a.name}`);
      seen.add(a.name);
    }
    if (doc.deprecated?.replacement !== undefined && doc.deprecated.replacement === doc.name) throw new HookError('a hook cannot replace itself');
    this.docs.set(doc.name, doc);
    if (isPattern) this.patterns.push({ re: patternRegex(doc.name), doc });
  }

  /** The declaration that covers a hook name, exact or by pattern. */
  docFor(name: string): HookDoc | undefined {
    return this.docs.get(name) ?? this.patterns.find((p) => p.re.test(name))?.doc;
  }

  private check(name: string, kind: Kind, args: number, label: string) {
    if (!NAME.test(name)) throw new HookError(`"${name.slice(0, 60)}" is not a usable hook name`);
    const d = this.docFor(name);
    if (!d) {
      if (this.o.strict) {
        const near = [...this.docs.keys()].map((k) => ({ k, d: distance(name, k) })).sort((a, b) => a.d - b.d)[0];
        throw new HookError(`there is no hook "${name}"${near && near.d <= Math.max(2, Math.floor(name.length / 3)) ? `; did you mean "${near.k}"?` : ''}`);
      }
      return;
    }
    if (d.kind !== kind) throw new HookError(`${name} is a ${d.kind}, not a ${kind}`);
    if (args > d.args.length) throw new HookError(`${name} passes ${d.args.length} argument(s); the listener asks for ${args}`);
    if (d.deprecated) this.warnOnce('deprecated-hook', name, label, `${name} is deprecated since ${d.deprecated.since}${d.deprecated.replacement ? `; use ${d.deprecated.replacement}` : ''}${d.deprecated.message ? `: ${d.deprecated.message}` : ''}`);
  }

  private warn(w: Warning) {
    this.log.push(w);
    if (this.log.length > 500) this.log.shift();
    this.o.onWarning?.(w);
  }

  private warnOnce(kind: Warning['kind'], hook: string, listener: string, message: string) {
    const k = `${kind}\u0000${hook}\u0000${listener}`;
    if (this.warned.has(k)) return;
    this.warned.add(k);
    this.warn({ kind, hook, listener, message });
  }

  warnings(): readonly Warning[] {
    return this.log;
  }

  /** The catalogue, with how many listeners each hook has now. */
  catalogue(): (HookDoc & { listeners: number; ran: number })[] {
    return [...this.docs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ ...d, listeners: d.name.includes('{') ? [...this.lists].filter(([n]) => patternRegex(d.name).test(n)).reduce((s, [, l]) => s + l.length, 0) : (this.lists.get(d.name)?.length ?? 0), ran: this.ran.get(d.name) ?? 0 }));
  }

  /** The catalogue as Markdown for plugin authors: one section per hook with its arguments and any deprecation. */
  toMarkdown(): string {
    const out: string[] = ['# Hooks', ''];
    for (const d of this.catalogue()) {
      out.push(`## \`${d.name}\``, '', `${d.kind === 'filter' ? 'Filter' : 'Action'}, since ${d.since}.${d.deprecated ? ` **Deprecated since ${d.deprecated.since}.**${d.deprecated.replacement ? ` Use \`${d.deprecated.replacement}\`.` : ''}${d.deprecated.message ? ` ${d.deprecated.message}` : ''}` : ''}`, '', d.description.trim(), '');
      if (d.args.length) {
        out.push('| Argument | Type | Description |', '| --- | --- | --- |');
        for (const a of d.args) out.push(`| \`${a.name}\` | \`${a.type.replace(/\|/g, '\\|')}\` | ${(a.description ?? '').replace(/\|/g, '\\|')} |`);
        out.push('');
      }
      if (d.returns) out.push(`Returns: ${d.returns}`, '');
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ adding and removing

  private add(kind: Kind, name: string, fn: Callback, o: AddOptions): string {
    if (typeof fn !== 'function') throw new HookError('a listener must be a function');
    const priority = o.priority ?? 10;
    if (!Number.isInteger(priority) || Math.abs(priority) > 1_000_000) throw new HookError('a priority is a whole number');
    const args = o.args ?? 1;
    if (!Number.isInteger(args) || args < 0 || args > 20) throw new HookError('args is a whole number from 0 to 20');
    const label = o.label ?? (fn.name || 'anonymous');
    this.check(name, kind, args, label);
    const l: Listener = { id: `h${++this.ids}`, fn, priority, seq: ++this.seq, args, owner: o.owner, once: o.once === true, label };
    const list = this.lists.get(name) ?? [];
    list.push(l);
    this.lists.set(name, list);
    return l.id;
  }

  addAction(name: string, fn: Callback, o: AddOptions = {}): string {
    return this.add('action', name, fn, o);
  }

  addFilter(name: string, fn: Callback, o: AddOptions = {}): string {
    return this.add('filter', name, fn, o);
  }

  /** Removes a listener by the id returned when it was added, or by the function (and optionally priority). Returns how many were removed. */
  remove(name: string, which: string | Callback, priority?: number): number {
    const list = this.lists.get(name);
    if (!list) return 0;
    const before = list.length;
    const keep = list.filter((l) => !((typeof which === 'string' ? l.id === which : l.fn === which) && (priority === undefined || l.priority === priority)));
    if (keep.length) this.lists.set(name, keep);
    else this.lists.delete(name);
    return before - keep.length;
  }

  /** Removes everything on a hook, or only at one priority. */
  removeAll(name: string, priority?: number): number {
    const list = this.lists.get(name);
    if (!list) return 0;
    const keep = priority === undefined ? [] : list.filter((l) => l.priority !== priority);
    if (keep.length) this.lists.set(name, keep);
    else this.lists.delete(name);
    return list.length - keep.length;
  }

  /** Removes every listener an owner added, on every hook: what unloading a plugin does. */
  removeByOwner(owner: string): number {
    let n = 0;
    for (const [name, list] of [...this.lists]) {
      const keep = list.filter((l) => l.owner !== owner);
      n += list.length - keep.length;
      if (keep.length) this.lists.set(name, keep);
      else this.lists.delete(name);
    }
    return n;
  }

  /** The priority of the first listener found (or of the given function), false if none. */
  has(name: string, which?: string | Callback): number | false {
    const list = this.lists.get(name) ?? [];
    const sorted = [...list].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const f = which === undefined ? sorted[0] : sorted.find((l) => (typeof which === 'string' ? l.id === which : l.fn === which));
    return f ? f.priority : false;
  }

  /** What would run, in order. */
  listeners(name: string): { id: string; label: string; priority: number; owner?: string }[] {
    return [...(this.lists.get(name) ?? [])].sort((a, b) => a.priority - b.priority || a.seq - b.seq).map((l) => ({ id: l.id, label: l.label, priority: l.priority, ...(l.owner !== undefined ? { owner: l.owner } : {}) }));
  }

  // ------------------------------------------------------------ running

  /** How many times a hook has run. */
  didRun(name: string): number {
    return this.ran.get(name) ?? 0;
  }

  /** The hook being run, innermost first; with a name, whether that hook is running now. */
  current(): string | undefined {
    return this.stack[this.stack.length - 1];
  }

  doing(name: string): boolean {
    return this.stack.includes(name);
  }

  private enter(name: string) {
    if (this.stack.length >= (this.o.maxDepth ?? 20)) throw new HookError(`hooks are nested more than ${this.o.maxDepth ?? 20} deep (${[...this.stack.slice(-4), name].join(' > ')})`);
    this.stack.push(name);
    this.ran.set(name, (this.ran.get(name) ?? 0) + 1);
  }

  /** The next listener after the position reached, so ones added or removed while running are honoured. */
  private next(name: string, after: { priority: number; seq: number } | undefined): Listener | undefined {
    let best: Listener | undefined;
    for (const l of this.lists.get(name) ?? []) {
      if (after && (l.priority < after.priority || (l.priority === after.priority && l.seq <= after.seq))) continue;
      if (!best || l.priority < best.priority || (l.priority === best.priority && l.seq < best.seq)) best = l;
    }
    return best;
  }

  /** Names to run for a hook: the hooks it replaced come first, so their listeners still hear about it. */
  private chain(name: string): string[] {
    const olds = [...this.docs.values()].filter((d) => d.deprecated?.replacement === name && (this.lists.get(d.name)?.length ?? 0) > 0).map((d) => d.name);
    return [...olds, name];
  }

  private fail(name: string, l: Listener, e: unknown) {
    if (this.o.onError === 'throw') throw e;
    this.warn({ kind: 'listener-failed', hook: name, listener: l.label, message: e instanceof Error ? e.message : String(e) });
  }

  private after(name: string, l: Listener) {
    if (l.once) this.remove(name, l.id);
  }

  /** Announces that something happened; every listener runs in priority order. Returns how many ran. */
  doAction(name: string, ...args: unknown[]): number {
    this.requireKind(name, 'action');
    let count = 0;
    for (const h of this.chain(name)) {
      this.enter(h);
      try {
        let at: { priority: number; seq: number } | undefined;
        for (let l = this.next(h, at); l; l = this.next(h, at)) {
          at = l;
          this.deprecation(h, l);
          try {
            l.fn(...args.slice(0, l.args));
            count++;
          } catch (e) {
            this.fail(h, l, e);
          }
          this.after(h, l);
        }
      } finally {
        this.stack.pop();
      }
    }
    return count;
  }

  /** Passes a value through every listener; each gets the value first and then the extra arguments, and returns the new value. */
  applyFilters<T>(name: string, value: T, ...extra: unknown[]): T {
    this.requireKind(name, 'filter');
    let v: unknown = value;
    for (const h of this.chain(name)) {
      this.enter(h);
      try {
        let at: { priority: number; seq: number } | undefined;
        for (let l = this.next(h, at); l; l = this.next(h, at)) {
          at = l;
          this.deprecation(h, l);
          try {
            const r = l.fn(...[v, ...extra].slice(0, Math.max(1, l.args)));
            if (r === undefined && v !== undefined) this.warnOnce('returned-undefined', h, l.label, `listener ${l.label} on ${h} returned nothing; a filter must return the value`);
            v = r;
          } catch (e) {
            this.fail(h, l, e);
          }
          this.after(h, l);
        }
      } finally {
        this.stack.pop();
      }
    }
    return v as T;
  }

  /** Like doAction, but waits for each listener before the next. */
  async doActionAsync(name: string, ...args: unknown[]): Promise<number> {
    this.requireKind(name, 'action');
    let count = 0;
    for (const h of this.chain(name)) {
      this.enter(h);
      try {
        let at: { priority: number; seq: number } | undefined;
        for (let l = this.next(h, at); l; l = this.next(h, at)) {
          at = l;
          this.deprecation(h, l);
          try {
            await l.fn(...args.slice(0, l.args));
            count++;
          } catch (e) {
            this.fail(h, l, e);
          }
          this.after(h, l);
        }
      } finally {
        this.stack.pop();
      }
    }
    return count;
  }

  /** Like applyFilters, but each listener may return a promise. */
  async applyFiltersAsync<T>(name: string, value: T, ...extra: unknown[]): Promise<T> {
    this.requireKind(name, 'filter');
    let v: unknown = value;
    for (const h of this.chain(name)) {
      this.enter(h);
      try {
        let at: { priority: number; seq: number } | undefined;
        for (let l = this.next(h, at); l; l = this.next(h, at)) {
          at = l;
          this.deprecation(h, l);
          try {
            const r = await l.fn(...[v, ...extra].slice(0, Math.max(1, l.args)));
            if (r === undefined && v !== undefined) this.warnOnce('returned-undefined', h, l.label, `listener ${l.label} on ${h} returned nothing; a filter must return the value`);
            v = r;
          } catch (e) {
            this.fail(h, l, e);
          }
          this.after(h, l);
        }
      } finally {
        this.stack.pop();
      }
    }
    return v as T;
  }

  private deprecation(name: string, l: Listener) {
    const d = this.docFor(name);
    if (d?.deprecated) this.warnOnce('deprecated-hook', name, l.label, `${name} is deprecated since ${d.deprecated.since}${d.deprecated.replacement ? `; use ${d.deprecated.replacement}` : ''}`);
  }

  private requireKind(name: string, kind: Kind) {
    if (!NAME.test(name)) throw new HookError(`"${name.slice(0, 60)}" is not a usable hook name`);
    const d = this.docFor(name);
    if (d && d.kind !== kind) throw new HookError(`${name} is a ${d.kind}, not a ${kind}`);
    if (!d && this.o.strict) throw new HookError(`there is no hook "${name}"`);
  }
}
