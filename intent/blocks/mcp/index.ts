/**
 * Agent tools over the Model Context Protocol. The product's actions are offered to AI agents as MCP tools through
 * a JSON-RPC 2.0 handler (initialize, tools/list, tools/call, ping), transport-agnostic so it can sit behind stdio
 * or streamable HTTP. Each tool declares a JSON Schema for its input, checked before it runs; each call is made as
 * the person the agent acts for, so an agent can never do more than they could; read-only tools are marked so
 * clients can call them without asking. Every tools/call is recorded with its outcome: ok, error (the tool ran and
 * failed), denied (no such tool, or one the person may not use) or invalid (the arguments do not match the schema),
 * so security monitoring sees probing and refused calls as well as the ones that ran. The record is a bounded
 * in-memory log of the most recent calls, each also handed to a caller-provided sink for durable storage.
 */

export const PROTOCOL = '2025-06-18';

export type Schema = { readonly type: 'object'; readonly properties: Readonly<Record<string, Prop>>; readonly required?: readonly string[]; readonly additionalProperties?: false };
export type Prop = { readonly type: 'string'; readonly enum?: readonly string[]; readonly maxLength?: number; readonly description?: string } | { readonly type: 'number' | 'integer'; readonly minimum?: number; readonly maximum?: number; readonly description?: string } | { readonly type: 'boolean'; readonly description?: string } | { readonly type: 'array'; readonly items: Prop; readonly maxItems?: number; readonly description?: string };

export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly readOnly?: boolean;
  readonly permission?: string;
  readonly run: (args: Record<string, unknown>, as: { who: string; can: (p: string) => boolean }) => Promise<unknown>;
}

export function validate(s: Schema, v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['arguments must be an object'];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  for (const r of s.required ?? []) if (!Object.hasOwn(o, r)) out.push(`${r} is required`);
  for (const [k, val] of Object.entries(o)) {
    const p = Object.hasOwn(s.properties, k) ? s.properties[k] : undefined;
    if (!p) {
      if (s.additionalProperties === false) out.push(`${k} is not an argument of this tool`);
      continue;
    }
    out.push(...prop(k, p, val));
  }
  return out;
}

function prop(k: string, p: Prop, v: unknown): string[] {
  switch (p.type) {
    case 'string':
      if (typeof v !== 'string') return [`${k} must be a string`];
      if (p.enum && !p.enum.includes(v)) return [`${k} must be one of ${p.enum.join(', ')}`];
      if (p.maxLength !== undefined && v.length > p.maxLength) return [`${k} can be at most ${p.maxLength} characters`];
      return [];
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v) || (p.type === 'integer' && !Number.isInteger(v))) return [`${k} must be ${p.type === 'integer' ? 'a whole number' : 'a number'}`];
      if ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum)) return [`${k} must be between ${p.minimum ?? '-∞'} and ${p.maximum ?? '∞'}`];
      return [];
    case 'boolean':
      return typeof v === 'boolean' ? [] : [`${k} must be true or false`];
    case 'array':
      if (!Array.isArray(v)) return [`${k} must be a list`];
      if (p.maxItems !== undefined && v.length > p.maxItems) return [`${k} can have at most ${p.maxItems} items`];
      return v.flatMap((x, i) => prop(`${k}[${i}]`, p.items, x));
  }
}

/** One tools/call as recorded. `tool` is the name the caller asked for, cut to 200 characters. */
export interface CallLog {
  readonly at: string;
  readonly who: string;
  readonly tool: string;
  /** True only when the tool ran and returned. */
  readonly ok: boolean;
  readonly outcome: 'ok' | 'error' | 'denied' | 'invalid';
  /** What went wrong: the tool's error, why the call was denied, or that the arguments did not match. */
  readonly error?: string;
  /** For an invalid call, each way the arguments failed the schema. */
  readonly problems?: readonly string[];
}

/** How a bounded log keeps its entries: the most recent `keep` in memory, every one handed to `sink` as it is recorded. */
export interface LogOptions<E> {
  /** How many of the most recent entries stay in memory; a whole number of at least 1, 1000 if not given. */
  readonly keep?: number;
  /**
   * Durable storage, provided by the caller: called once with every entry as it is recorded, before anything is
   * evicted from memory. A sink that throws or whose promise rejects is counted in `sinkFailures` and never breaks
   * the work being recorded.
   */
  readonly sink?: (entry: E) => void | Promise<unknown>;
}

/** An in-memory log that holds only the most recent entries, with counts that say what was recorded, handed on and evicted. */
export class BoundedLog<E> {
  private readonly list: E[] = [];
  private readonly keep: number;
  private readonly sink: ((entry: E) => void | Promise<unknown>) | undefined;
  /** Entries recorded since the log was made. */
  recorded = 0;
  /** Entries handed to the sink. */
  handed = 0;
  /** Hand-offs where the sink threw or its promise rejected. */
  sinkFailures = 0;
  /** Entries dropped from memory to stay within `keep`. */
  evicted = 0;

  constructor(o: LogOptions<E> = {}) {
    const keep = o.keep ?? 1000;
    if (!Number.isInteger(keep) || keep < 1) throw new Error('a log keeps a whole number of entries, at least 1');
    this.keep = keep;
    this.sink = o.sink;
  }

  /** The most recent entries, oldest first. */
  get entries(): readonly E[] {
    return this.list;
  }

  push(entry: E): void {
    this.recorded++;
    if (this.sink) {
      this.handed++;
      try {
        const r = this.sink(entry);
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, () => void this.sinkFailures++);
      } catch {
        this.sinkFailures++;
      }
    }
    this.list.push(entry);
    while (this.list.length > this.keep) {
      this.list.shift();
      this.evicted++;
    }
  }
}

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class Server {
  private readonly tools = new Map<string, Tool>();
  /** The call log: the most recent calls in memory, with counts of what was recorded, handed to the sink and evicted. */
  readonly calls: BoundedLog<CallLog>;
  private readonly info: { name: string; version: string };
  private readonly now: () => Date;

  constructor(info: { name: string; version: string }, tools: readonly Tool[], now: () => Date = () => new Date(), log: LogOptions<CallLog> = {}) {
    this.info = info;
    this.now = now;
    this.calls = new BoundedLog(log);
    for (const t of tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`${t.name}: tool names are letters, digits, _ and -`);
      if (this.tools.has(t.name)) throw new Error(`${t.name}: a tool is named twice`);
      this.tools.set(t.name, t);
    }
  }

  /** The most recent calls, oldest first. */
  get log(): readonly CallLog[] {
    return this.calls.entries;
  }

  /**
   * Handles one JSON-RPC message; notifications (no id) get no reply. A request id is a string or a number: MCP
   * forbids null, so null or any other kind of id is an invalid request, answered with a null id.
   */
  async handle(raw: unknown, as: { who: string; can: (p: string) => boolean }): Promise<Reply | undefined> {
    const m = raw as Rpc;
    const given = m && typeof m === 'object' && !Array.isArray(m) && Object.hasOwn(m, 'id') ? (m as { id: unknown }).id : undefined;
    const has = m && typeof m === 'object' && !Array.isArray(m) && Object.hasOwn(m, 'id');
    const validId = typeof given === 'string' || (typeof given === 'number' && Number.isFinite(given));
    const err = (code: number, message: string, data?: unknown): Reply => ({ jsonrpc: '2.0', id: validId ? (given as string | number) : null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(-32600, 'not a JSON-RPC 2.0 request');
    if (!has) return undefined;
    if (!validId) return err(-32600, 'a request id is a string or a number');
    const id = given as string | number;
    const ok = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: this.info });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: [...this.tools.values()].filter((t) => !t.permission || as.can(t.permission)).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !t.readOnly } })) });
      case 'tools/call': {
        const name = m.params?.name;
        const at = this.now().toISOString();
        const t = typeof name === 'string' ? this.tools.get(name) : undefined;
        if (!t || (t.permission && !as.can(t.permission))) {
          // The reply is the same either way, so a caller cannot tell a hidden tool from a missing one; the log can.
          this.calls.push({ at, who: as.who, tool: String(name).slice(0, 200), ok: false, outcome: 'denied', error: t ? `not permitted: needs ${t.permission}` : 'no such tool' });
          return err(-32602, `no tool ${String(name)}`);
        }
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        const problems = validate(t.inputSchema, args);
        if (problems.length) {
          this.calls.push({ at, who: as.who, tool: t.name, ok: false, outcome: 'invalid', error: 'the arguments do not match the tool', problems });
          return err(-32602, 'the arguments do not match the tool', problems);
        }
        try {
          const out = await t.run(args, as);
          this.calls.push({ at, who: as.who, tool: t.name, ok: true, outcome: 'ok' });
          return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }], ...(typeof out === 'object' && out !== null && !Array.isArray(out) ? { structuredContent: out } : {}), isError: false });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.calls.push({ at, who: as.who, tool: t.name, ok: false, outcome: 'error', error: message });
          return ok({ content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default:
        return err(-32601, `no method ${m.method}`);
    }
  }
}
