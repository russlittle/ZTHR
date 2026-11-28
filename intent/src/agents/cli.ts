/**
 * The agent API from the command line.
 *
 *   intent agents serve --workspace d --role r --family f --agent name [--factory checkout]   the MCP server, on stdio
 *   intent agents guide --role r                                                              the guide for a role
 *   intent agents tools --role r                                                              tool definitions, for APIs without MCP
 *   intent agents proposals --workspace d                                                     what waits on a person
 *   intent agents sign|decline <proposal> --workspace d --by email --signature act.sig [--note]   a person decides
 *   intent agents call <tool> --json '{...}' --workspace d --role r --family f --agent name     one call, for scripts and the pipeline
 *        [--provider p --model m --response id]                                               the model call it came from
 *   intent agents verify --workspace d [--factory checkout]                                   the log against its key and anchors
 *   intent agents anchor --workspace d --factory checkout                                     publish the log's head as a tag
 *   intent agents delegate --workspace d --by email --class-ii on|off [--attempts n] --signature act.sig
 *   intent agents budget --workspace d --by email --daily usd [--case usd] --signature act.sig
 *   intent agents agenda --workspace d                                                        what waits on every role
 *   intent agents drive --workspace d [--factory checkout] [--rounds n]                       wake the seats with work, on the cheap plan
 *   intent agents hook --workspace d --factory checkout                                       install the pre-push hook in the checkout
 *   intent agents prepush --workspace d                                                       the hook: refuse a push the API has not seen pass
 *
 * sign, decline, delegate and budget are a person's acts. The server has no tool that reaches them, and naming a
 * person is not enough: each needs that person's SSH signature, by a key listed for them in agents/people.json, over
 * the exact act. Run the command without --signature to print the act and the ssh-keygen line that signs it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUTIES, type Role } from './duties.ts';
import { guide } from './guide.ts';
import { append, checkAct, decisionOn, decisionText, keysOf, ledgerOf, NAMESPACE, proposals, recordAct, releaseAnchors, tagAnchor, tagAnchors, verifyLog, type Act, type Signature } from './ledger.ts';
import { supervise } from './driver.ts';
import { serve } from './mcp.ts';
import { applySigned, call, prepushGaps, toolDefinitions, type ModelCall } from './tools.ts';

/** How a person signs an act the command printed. */
const howToSign = (cmd: string) =>
  `The act is on standard output. Save it exactly (run this again with > act.txt), sign it with your own key:\n  ssh-keygen -Y sign -n ${NAMESPACE} -f ~/.ssh/zthr_signing act.txt\nthen run the same ${cmd} command again with --signature act.txt.sig.`;

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
  const sig = () => {
    const f = flag('signature');
    return f ? readFileSync(f, 'utf8') : undefined;
  };
  const answer = (): ModelCall | undefined => {
    const provider = flag('provider');
    const model = flag('model');
    const response = flag('response');
    return provider && model ? { provider, model, ...(response ? { response } : {}) } : undefined;
  };
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
    const a = answer();
    serve({ workspace: ws, session: { role: role!, family, agent }, ...(factory ? { factory } : {}), ...(a ? { answer: a } : {}) });
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
    const a = answer();
    const r = call({ workspace: ws, ledger: l, session: { role: role!, family, agent }, ...(factory ? { factory } : {}), ...(a ? { answer: a } : {}) }, tool, JSON.parse(flag('json') ?? '{}') as Record<string, unknown>);
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
    if (!by) {
      console.error('--by is required: the person deciding');
      return 2;
    }
    if (decisionOn(l, p.id)) {
      console.error(`${p.id} is already decided`);
      return 1;
    }
    const decision = cmd === 'sign' ? 'signed' : 'declined';
    const text = decisionText(p, decision, by);
    const signature = sig();
    const v = checkAct(l, by, text, signature);
    if (!v.ok) {
      console.error(`refused: ${v.why}`);
      if (!signature && keysOf(l, by).length) {
        process.stdout.write(text);
        console.error(howToSign(cmd));
      }
      return 1;
    }
    const note = flag('note');
    append(l, 'signatures.jsonl', { proposal: p.id, decision, by, at: l.now(), ...(note ? { note } : {}), signature: signature! } satisfies Signature);
    console.log(`${p.id} ${cmd === 'sign' ? `signed: ${applySigned(ws, p)}` : 'declined'}`);
    return 0;
  }
  if (cmd === 'delegate' || cmd === 'budget') {
    const by = flag('by');
    if (!by) {
      console.error('--by is required: the person acting');
      return 2;
    }
    let fields: Act['fields'];
    if (cmd === 'delegate') {
      const on = flag('class-ii');
      if (on !== 'on' && on !== 'off') {
        console.error('--class-ii on|off');
        return 2;
      }
      fields = { classII: on === 'on', attempts: Number(flag('attempts') ?? 5) };
    } else {
      const daily = Number(flag('daily'));
      if (!(daily > 0)) {
        console.error('--daily must be dollars a day, more than 0');
        return 2;
      }
      fields = { dailyUSD: daily, caseUSD: Number(flag('case') ?? daily / 4) };
    }
    const signature = sig();
    const r = recordAct(l, cmd, fields, by, signature);
    if (!r.ok) {
      console.error(`refused: ${r.why}`);
      if (!signature && keysOf(l, by).length) {
        process.stdout.write(r.text);
        console.error(howToSign(cmd));
      }
      return 1;
    }
    console.log(cmd === 'delegate' ? `the factory ${fields['classII'] ? 'may' : 'may not'} issue Class II revisions on its own; ${String(fields['attempts'])} attempts a case before it asks` : `spending stops at $${String(fields['dailyUSD'])} a day and $${String(fields['caseUSD'])} a case`);
    return 0;
  }
  if (cmd === 'drive') {
    const factory = flag('factory');
    void supervise({ workspace: ws, ...(factory ? { factory } : {}), rounds: Number(flag('rounds') ?? 5), log: (x) => console.log(x) }).then((r) => {
      console.log(`stopped after ${r.rounds} round(s): ${r.why}; spent $${r.usd.toFixed(4)}`);
      process.exit(0);
    });
    return -1;
  }
  if (cmd === 'hook') {
    const factory = flag('factory');
    if (!factory) {
      console.error('--factory is required');
      return 2;
    }
    const hook = join(factory, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\n# Installed by intent agents hook: a push goes only when typecheck and tests passed on each commit's exact tree.\nexec node ${JSON.stringify(new URL('../cli.ts', import.meta.url).pathname)} agents prepush --workspace ${JSON.stringify(ws)}\n`, { mode: 0o755 });
    console.log(`pre-push hook installed in ${factory}`);
    return 0;
  }
  if (cmd === 'prepush') {
    // git sends: <local ref> <local sha> <remote ref> <remote sha>, one line per ref.
    const input = readFileSync(0, 'utf8');
    const shas = input.split('\n').filter(Boolean).map((x) => x.split(' ')[1]!).filter((x) => !/^0+$/.test(x));
    const trees = shas.map((sha) => ({ sha, tree: spawnSync('git', ['rev-parse', `${sha}^{tree}`], { encoding: 'utf8' }).stdout.trim() }));
    const gaps = prepushGaps(l, trees);
    if (gaps.length) {
      console.error(`push refused: run change_open on the commit first, so the API tests it\n${gaps.join('\n')}`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'agenda') {
    for (const r of roles) {
      const a = call({ workspace: ws, ledger: l, session: { role: r, family: 'supervisor', agent: 'supervisor' } }, 'agenda', {});
      const v = a.ok ? (a.value as { items: { do: string }[]; paused: boolean }) : { items: [], paused: false };
      console.log(`${r}: ${v.paused ? 'paused, budget reached' : v.items.length ? v.items.map((x) => x.do).join('; ') : 'nothing'}`);
    }
    return 0;
  }
  if (cmd === 'verify') {
    const factory = flag('factory');
    const anchors = [...releaseAnchors(ws), ...(factory ? tagAnchors(factory) : [])];
    const v = verifyLog(l, anchors);
    console.log(v.ok ? `the log holds: ${v.lines} entries, keyed, ${anchors.length} anchor(s) up to entry ${v.anchored}` : `the log does not hold${v.at ? ` at entry ${v.at}` : ''}: ${v.why}`);
    return v.ok ? 0 : 1;
  }
  if (cmd === 'anchor') {
    const factory = flag('factory');
    if (!factory) {
      console.error('--factory is required: the checkout the tag goes into');
      return 2;
    }
    const v = verifyLog(l, [...releaseAnchors(ws), ...tagAnchors(factory)]);
    if (!v.ok) {
      console.error(`not anchored: the log does not hold${v.at ? ` at entry ${v.at}` : ''}: ${v.why}`);
      return 1;
    }
    const t = tagAnchor(l, factory);
    console.log(`${t.tag} at entry ${t.seq} (${t.hash.slice(0, 12)}); push it: git -C ${factory} push origin refs/tags/${t.tag}`);
    return 0;
  }
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 20).map((x) => x.replace(/^ \* ?/, '')).join('\n'));
  return 2;
}
