/**
 * The supervisor: wakes each seat only when its agenda has work, on the cheapest model the plan gives that seat,
 * and meters every token against the person's ceiling. Vertex and Ollama both serve the OpenAI chat-completions
 * shape, so one loop drives every model.
 *
 *   intent agents drive --workspace d [--factory checkout] [--rounds n]
 *
 * Every shortcut here is a first-principles one: the fixture judges the work, so a model is only ever asked what a
 * machine cannot answer.
 *   - An empty agenda wakes nobody: an idle seat costs nothing.
 *   - The system prompt is the role's guide, the same bytes every call, first: the provider caches it.
 *   - Tool results are capped, and the conversation is short: each wake does the agenda and stops.
 *   - Reviewers see a packet, not the repository, and only once every check is green.
 *   - Reviews run one family at a time; once two pass the change is admitted and the third seat sleeps.
 *   - Output tokens are capped per seat; temperature is 0.
 *
 * Building needs a coding agent that edits files, which this loop does not do. The builder seat runs the command in
 * ZTHR_BUILDER_CMD (any coding agent that speaks MCP, pointed at a local Ollama model), with the agent API attached.
 */
import { spawnSync } from 'node:child_process';
import type { Role } from './duties.ts';
import { guide } from './guide.ts';
import { budgetState, meter, PLAN, seatModels, type ModelSpec } from './cost.ts';
import { ledgerOf, type Ledger } from './ledger.ts';
import { call, toolDefinitions, type Context } from './tools.ts';

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface Env {
  readonly project?: string;
  readonly ollama?: string;
  /** A Vertex access token for this run. In Cloud Shell it is read from gcloud each run; it is never stored. */
  readonly token?: () => string;
}

export function endpoint(m: ModelSpec, env: Env): { url: string; headers: Record<string, string> } {
  if (m.provider === 'ollama') return { url: `${env.ollama ?? 'http://localhost:11434'}/v1/chat/completions`, headers: { 'Content-Type': 'application/json' } };
  if (!env.project) throw new Error('set GOOGLE_CLOUD_PROJECT to call Vertex');
  const loc = m.region ?? 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  const token = (env.token ?? (() => spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).stdout.trim()))();
  return { url: `https://${host}/v1/projects/${env.project}/locations/${loc}/endpoints/openapi/chat/completions`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } };
}

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const CAP = 8000;

/** One seat, one wake: the agenda, then tool calls until the model stops or a limit is reached. */
export async function wake(c: Context, key: string, f: Fetch, env: Env): Promise<{ turns: number; usd: number; stopped: string }> {
  const spec = PLAN.models[key]!;
  const role = c.session.role;
  const first = call(c, 'agenda', {});
  const agenda = first.ok ? (first.value as { items: unknown[]; paused: boolean }) : { items: [], paused: false };
  if (agenda.paused) return { turns: 0, usd: 0, stopped: 'budget reached' };
  if (!agenda.items.length) return { turns: 0, usd: 0, stopped: 'nothing to do' };
  const tools = toolDefinitions(role).map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages: Msg[] = [
    { role: 'system', content: guide(role) },
    { role: 'user', content: `Your agenda, most urgent first:\n${JSON.stringify(agenda.items)}\n\nWork through it with your tools. When it is done, or nothing more can be done in your role, reply with one line saying what you did.` },
  ];
  let usd = 0;
  for (let turn = 1; turn <= PLAN.limits.maxTurns; turn++) {
    if (budgetState(c.ledger).paused) return { turns: turn - 1, usd, stopped: 'budget reached' };
    let res: Awaited<ReturnType<Fetch>>;
    try {
      const e = endpoint(spec, env);
      res = await f(e.url, { method: 'POST', headers: e.headers, body: JSON.stringify({ model: spec.model, messages, tools, temperature: 0, max_tokens: PLAN.limits.maxOutputTokens[role] ?? 1000 }) });
    } catch (err) {
      // An Ollama box that is off is not an error in the work: the next seat in the plan takes it.
      return { turns: 0, usd, stopped: `unreachable: ${(err as Error).message}` };
    }
    if (!res.ok) return { turns: turn, usd, stopped: `model answered ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const body = (await res.json()) as { choices: { message: Msg; finish_reason: string }[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } };
    const u = body.usage;
    if (u) usd += meter(c.ledger, role, key, { in: u.prompt_tokens, cachedIn: u.prompt_tokens_details?.cached_tokens ?? 0, out: u.completion_tokens }).usd;
    const msg = body.choices[0]!.message;
    messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) return { turns: turn, usd, stopped: 'done' };
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '{"refused":"arguments were not JSON","instead":"send one JSON object"}' });
        continue;
      }
      const r = call(c, tc.function.name, args);
      const out = JSON.stringify(r.ok ? r.value : r.refused ? { refused: r.why, instead: r.instead } : { error: r.why });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out.length > CAP ? `${out.slice(0, CAP)}…(cut)` : out });
    }
  }
  return { turns: PLAN.limits.maxTurns, usd, stopped: 'turn limit' };
}

/** Seats in the order work flows. The pipeline is the build service itself, never a model. */
const ORDER: readonly Role[] = ['reader', 'steward', 'reviewer', 'operator', 'triager'];

/** Rounds of wakes until no seat has work, the budget is reached, or the rounds run out. */
export async function supervise(opts: { workspace: string; factory?: string; rounds?: number; fetch?: Fetch; env?: Env; log?: (s: string) => void }): Promise<{ rounds: number; usd: number; why: string }> {
  const l: Ledger = ledgerOf(opts.workspace);
  const f = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
  const env = opts.env ?? { ...(process.env['GOOGLE_CLOUD_PROJECT'] ? { project: process.env['GOOGLE_CLOUD_PROJECT'] } : {}), ...(process.env['OLLAMA_HOST'] ? { ollama: process.env['OLLAMA_HOST'] } : {}) };
  const say = opts.log ?? (() => {});
  let usd = 0;
  for (let round = 1; round <= (opts.rounds ?? 5); round++) {
    let worked = false;
    for (const role of ORDER) {
      for (const { key, spec } of seatModels(role)) {
        if (budgetState(l).paused) return { rounds: round, usd, why: 'budget reached' };
        const c: Context = { workspace: opts.workspace, ledger: l, session: { role, family: spec.family, agent: `${role}-${key}` }, ...(opts.factory ? { factory: opts.factory } : {}) };
        const r = await wake(c, key, f, env);
        usd += r.usd;
        if (r.turns) worked = true;
        if (r.turns || r.stopped.startsWith('unreachable')) say(`${role} on ${key}: ${r.stopped}, ${r.turns} turn(s), $${r.usd.toFixed(4)}`);
        // One seat model per role does the role's work, except where independence needs a second family.
        if (role !== 'reader' && role !== 'reviewer' && r.turns) break;
      }
    }
    const builder = process.env['ZTHR_BUILDER_CMD'];
    const bc: Context = { workspace: opts.workspace, ledger: l, session: { role: 'builder', family: 'qwen', agent: 'builder' } };
    const ba = call(bc, 'agenda', {});
    if (builder && ba.ok && (ba.value as { items: unknown[] }).items.length) {
      say('builder: running ZTHR_BUILDER_CMD');
      spawnSync('bash', ['-c', builder], { stdio: 'inherit', env: { ...process.env, ZTHR_WORKSPACE: opts.workspace } });
      worked = true;
    }
    if (!worked) return { rounds: round, usd, why: 'nothing waiting on any seat' };
  }
  return { rounds: opts.rounds ?? 5, usd, why: 'round limit' };
}
