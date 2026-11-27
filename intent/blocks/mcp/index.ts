/**
 * Agent tools over the Model Context Protocol. The product's actions are offered to AI agents as MCP tools through
 * a JSON-RPC 2.0 handler (initialize, tools/list, tools/call, ping), transport-agnostic so it can sit behind stdio
 * or streamable HTTP. Each tool declares a JSON Schema for its input, checked before it runs; each call is made as
 * the person the agent acts for, so an agent can never do more than they could; read-only tools are marked so
 * clients can call them without asking; every call that reaches a tool is recorded with its outcome.
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

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class Server {
  private readonly tools = new Map<string, Tool>();
  readonly log: { at: string; who: string; tool: string; ok: boolean; error?: string }[] = [];
  private readonly info: { name: string; version: string };
  private readonly now: () => Date;

  constructor(info: { name: string; version: string }, tools: readonly Tool[], now: () => Date = () => new Date()) {
    this.info = info;
    this.now = now;
    for (const t of tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`${t.name}: tool names are letters, digits, _ and -`);
      if (this.tools.has(t.name)) throw new Error(`${t.name}: a tool is named twice`);
      this.tools.set(t.name, t);
    }
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
        const t = typeof name === 'string' ? this.tools.get(name) : undefined;
        if (!t || (t.permission && !as.can(t.permission))) return err(-32602, `no tool ${String(name)}`);
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        const problems = validate(t.inputSchema, args);
        if (problems.length) return err(-32602, 'the arguments do not match the tool', problems);
        const at = this.now().toISOString();
        try {
          const out = await t.run(args, as);
          this.log.push({ at, who: as.who, tool: t.name, ok: true });
          return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }], ...(typeof out === 'object' && out !== null && !Array.isArray(out) ? { structuredContent: out } : {}), isError: false });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.log.push({ at, who: as.who, tool: t.name, ok: false, error: message });
          return ok({ content: [{ type: 'text', text: message }], isError: true });
        }
      }
      default:
        return err(-32601, `no method ${m.method}`);
    }
  }
}
