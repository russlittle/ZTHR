/**
 * The agent API from the command line.
 *
 *   intent agents serve --workspace d --role r --family f --agent name [--factory checkout]   the MCP server, on stdio
 *   intent agents guide --role r                                                              the guide for a role
 *   intent agents tools --role r                                                              tool definitions, for APIs without MCP
 *   intent agents proposals --workspace d                                                     what waits on a person
 *   intent agents sign|decline <proposal> --workspace d --by email [--note text]               a person decides
 *   intent agents call <tool> --json '{...}' --workspace d --role r --family f --agent name     one call, for scripts and the pipeline
 *   intent agents verify --workspace d                                                        whether the log's chain holds
 *
 * sign and decline are a person's commands. The server has no tool that reaches them, and they refuse anyone not
 * listed in agents/people.json, which only a person edits.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUTIES, type Role } from './duties.ts';
import { guide } from './guide.ts';
import { append, decisionOn, ledgerOf, proposals, signers, verifyLog, type Signature } from './ledger.ts';
import { serve } from './mcp.ts';
import { applySigned, call, toolDefinitions } from './tools.ts';

export function agentsCli(args: readonly string[]): number {
  const [cmd, ...rest] = args;
  const flag = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const roles = DUTIES.map((d) => d.role);
  const role = flag('role') as Role | undefined;
  const needRole = () => {
    if (!role || !roles.includes(role)) {
      console.error(`--role must be one of: ${roles.join(', ')}`);
      return false;
    }
    return true;
  };
  const ws = flag('workspace');
  if (cmd === 'guide') return needRole() ? (process.stdout.write(guide(role!)), 0) : 2;
  if (cmd === 'tools') return needRole() ? (process.stdout.write(`${JSON.stringify(toolDefinitions(role!), null, 2)}\n`), 0) : 2;
  if (!ws) {
    console.error('--workspace is required');
    return 2;
  }
  const l = ledgerOf(ws);
  if (cmd === 'serve') {
    const family = flag('family');
    const agent = flag('agent');
    if (!needRole()) return 2;
    if (!family || !/^[a-z][a-z0-9._-]{0,39}$/i.test(family) || !agent) {
      console.error('--family (a plain name, such as anthropic or google) and --agent (this agent’s own name) are required');
      return 2;
    }
    const factory = flag('factory');
    serve({ workspace: ws, session: { role: role!, family, agent }, ...(factory ? { factory } : {}) });
    return -1;
  }
  if (cmd === 'call') {
    const family = flag('family');
    const agent = flag('agent');
    const tool = rest.find((x, k) => !x.startsWith('--') && (k === 0 || !rest[k - 1]!.startsWith('--')));
    if (!needRole() || !family || !agent || !tool) {
      console.error('call needs a tool, --role, --family and --agent');
      return 2;
    }
    const factory = flag('factory');
    const r = call({ workspace: ws, ledger: l, session: { role: role!, family, agent }, ...(factory ? { factory } : {}) }, tool, JSON.parse(flag('json') ?? '{}') as Record<string, unknown>);
    console.log(JSON.stringify(r.ok ? r.value : r.refused ? { refused: r.why, instead: r.instead } : { error: r.why }, null, 2));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'proposals') {
    for (const p of proposals(l).filter((x) => !decisionOn(l, x.id))) console.log(`${p.id}  ${p.kind.padEnd(10)}  ${p.title}\n    because: ${p.reason.slice(0, 200)}\n    from: ${p.from.role} (${p.from.family}, ${p.from.agent})`);
    return 0;
  }
  if (cmd === 'sign' || cmd === 'decline') {
    const id = rest.find((x) => /^p-[0-9a-f]{10}$/.test(x));
    const by = flag('by');
    const p = proposals(l).find((x) => x.id === id);
    if (!p) {
      console.error(`no proposal ${id ?? ''}`);
      return 2;
    }
    if (!by || !signers(l).includes(by)) {
      console.error(`${by ?? 'nobody'} is not listed in ${join(ws, 'agents', 'people.json')} as someone who may sign`);
      return 1;
    }
    if (decisionOn(l, p.id)) {
      console.error(`${p.id} is already decided`);
      return 1;
    }
    const note = flag('note');
    append(l, 'signatures.jsonl', { proposal: p.id, decision: cmd === 'sign' ? 'signed' : 'declined', by, at: l.now(), ...(note ? { note } : {}) } satisfies Signature);
    console.log(`${p.id} ${cmd === 'sign' ? `signed: ${applySigned(ws, p)}` : 'declined'}`);
    return 0;
  }
  if (cmd === 'verify') {
    const v = verifyLog(l);
    console.log(v.ok ? `the log holds: ${v.lines} entries` : `the log is broken at entry ${v.at}`);
    return v.ok ? 0 : 1;
  }
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 10).map((x) => x.replace(/^ \* ?/, '')).join('\n'));
  return 2;
}
