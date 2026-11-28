/**
 * The agent API over the Model Context Protocol, on standard input and output: one JSON-RPC message per line.
 * The session's role, family and name are set by whoever starts the server, never by the agent, and the role's
 * tools are the only ones listed. The guide and the reference are resources, so an agent can read them before
 * it calls anything.
 *
 *   intent agents serve --workspace dir --role builder --family anthropic --agent builder-1 [--factory checkout]
 */
import { createInterface } from 'node:readline';
import { DUTIES, type Role } from './duties.ts';
import { guide, reference } from './guide.ts';
import { ledgerOf, type Session } from './ledger.ts';
import { call, toolsFor, type Context, type ModelCall } from './tools.ts';

export const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;

interface Rpc {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const RESOURCES = (role: Role) => [
  { uri: 'zthr://guide', name: 'guide', title: `Working in the ZTHR factory: ${role}`, mimeType: 'text/markdown', description: 'The house rules, your role’s limits, your tools and how the work goes. Read it first.' },
  { uri: 'zthr://reference', name: 'reference', title: 'Agent API: tool reference', mimeType: 'text/markdown', description: 'Every tool, every role, every input.' },
  { uri: 'zthr://roles', name: 'roles', title: 'Roles and what each is denied', mimeType: 'application/json', description: 'Each role, what it does, and the limits the API holds for it.' },
];

/** Answer one message. Notifications get no answer. */
export function handle(c: Context, m: Rpc): object | null {
  const ok = (result: object) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
  if (m.id === undefined) return null;
  const role = c.session.role;
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.['protocolVersion'] ?? '');
      return ok({
        protocolVersion: (PROTOCOLS as readonly string[]).includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'zthr-factory', title: 'ZTHR factory', version: '1.0.0' },
        instructions: `You are the ${role} (${c.session.family}, ${c.session.agent}). ${DUTIES.find((d) => d.role === role)!.does} Read zthr://guide, or call guide, before anything else. What only a person does has no tool: propose it.`,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: toolsFor(role).map((t) => ({
          name: t.name,
          title: t.name.replace(/_/g, ' '),
          description: `${t.description} Next: ${t.next}`,
          inputSchema: t.input,
          annotations: { readOnlyHint: t.kind === 'read', destructiveHint: false, idempotentHint: t.kind === 'read', openWorldHint: t.name === 'checks_run' },
        })),
      });
    case 'tools/call': {
      const name = String(m.params?.['name'] ?? '');
      const r = call(c, name, (m.params?.['arguments'] as Record<string, unknown>) ?? {});
      if (r.ok) return ok({ content: [{ type: 'text', text: JSON.stringify(r.value, null, 2) }], structuredContent: r.value as object, isError: false });
      const body = r.refused ? { refused: r.why, instead: r.instead } : { error: r.why };
      return ok({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true });
    }
    case 'resources/list':
      return ok({ resources: RESOURCES(role) });
    case 'resources/read': {
      const uri = String(m.params?.['uri'] ?? '');
      const text = uri === 'zthr://guide' ? guide(role) : uri === 'zthr://reference' ? reference() : uri === 'zthr://roles' ? JSON.stringify(DUTIES, null, 2) : null;
      if (text === null) return err(-32002, `no resource ${uri}`);
      return ok({ contents: [{ uri, mimeType: uri === 'zthr://roles' ? 'application/json' : 'text/markdown', text }] });
    }
    default:
      return err(-32601, `no method ${m.method}`);
  }
}

export function serve(opts: { workspace: string; factory?: string; session: Session; answer?: ModelCall }): void {
  // A server started for a model records which model it serves; it has no provider response id, so its reviews are
  // recorded but do not count toward admission. Counted reviews come from a driver that made the call itself.
  const c: Context = { workspace: opts.workspace, session: opts.session, ledger: ledgerOf(opts.workspace), ...(opts.factory ? { factory: opts.factory } : {}), ...(opts.answer ? { answer: { provider: opts.answer.provider, model: opts.answer.model } } : {}) };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } })}\n`);
      return;
    }
    const out = handle(c, m);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
