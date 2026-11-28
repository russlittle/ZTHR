/**
 * The record of a factory run by agents, kept beside the intent's workspace. Everything is appended, never
 * rewritten: every call to the API, allowed or refused, goes into a log where each line carries the hash of the
 * one before it, so a removed or edited line breaks the chain.
 *
 * A plain hash chain proves nothing against someone who can write the file: they can edit a line and recompute every
 * hash after it, or cut the last lines off and leave a shorter chain that still holds. So the chain is also keyed:
 * each line carries an HMAC made with a key only the ledger writer holds (ZTHR_LEDGER_KEY, or the file named by
 * ZTHR_LEDGER_KEY_FILE), and the head is published where the log's writer cannot take it back: in every release
 * record (history.jsonl) and as a git tag in the factory (zthr-ledger/<seq>), which the repository's rules keep
 * from being moved or deleted. Verifying needs the key, and checks the log against every anchor.
 *
 *   agents/log.jsonl          every call: who, which tool, the outcome, chained by hash and keyed by HMAC
 *   agents/proposals/<id>     what an agent asks a person to decide
 *   agents/signatures.jsonl   a person's decisions, each with that person's SSH signature over what they decided
 *   agents/acts.jsonl         a person's standing acts (delegation, budget), each signed and chained to the last
 *   agents/people.json        who may sign, and each person's signing keys; changed only by a person
 *   agents/changes/<id>       a builder's change: its paths and its author
 *   agents/checks.jsonl       each required check the API ran, and what the process returned
 *   agents/reviews.jsonl      each review, with what was checked, what was found, and the model call that made it
 *   agents/deploy.jsonl       delivery requests by the operator, and results recorded by the pipeline
 *   agents/tickets.jsonl      what people reported, and every triage event after it
 */
import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../hash.ts';
import { parseKey, verify as verifySsh, type PublicKey } from '../governance/sshsig.ts';
import type { Role } from './duties.ts';

export interface Session {
  readonly role: Role;
  /** The model family behind the agent: anthropic, google, openai, open-weights, or a plain name. */
  readonly family: string;
  /** This agent's own name, so it can never review what it wrote. */
  readonly agent: string;
}

export interface Ledger {
  readonly dir: string;
  readonly now: () => string;
  /** The ledger writer's HMAC key. Without it lines are written unkeyed, and the log cannot be verified. */
  readonly key?: Buffer;
}

/** The writer's key: ZTHR_LEDGER_KEY (hex or base64, 32 bytes or more), or the file ZTHR_LEDGER_KEY_FILE names. */
export function ledgerKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const raw = env['ZTHR_LEDGER_KEY'] ?? (env['ZTHR_LEDGER_KEY_FILE'] && existsSync(env['ZTHR_LEDGER_KEY_FILE']) ? readFileSync(env['ZTHR_LEDGER_KEY_FILE'], 'utf8') : undefined);
  if (!raw?.trim()) return undefined;
  const t = raw.trim();
  const k = /^[0-9a-f]+$/i.test(t) && t.length % 2 === 0 ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (k.length < 32) throw new Error('the ledger key must be at least 32 bytes');
  return k;
}

export const ledgerOf = (workspace: string, now: () => string = () => new Date().toISOString(), key: Buffer | undefined = ledgerKey()): Ledger => {
  const dir = join(workspace, 'agents');
  for (const d of ['', 'proposals', 'changes']) mkdirSync(join(dir, d), { recursive: true });
  return { dir, now, ...(key ? { key } : {}) };
};

export function readLines<T>(l: Ledger, file: string): T[] {
  const p = join(l.dir, file);
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as T) : [];
}

export function append(l: Ledger, file: string, row: object): void {
  appendFileSync(join(l.dir, file), `${JSON.stringify(row)}\n`);
}

// ------------------------------------------------------------------ the chained log

export interface LogEntry {
  readonly seq: number;
  readonly at: string;
  readonly session: Session;
  readonly tool: string;
  /** The hash of the input, so the log proves what was asked without keeping free text twice. */
  readonly input: string;
  readonly outcome: 'ok' | 'refused' | 'error';
  readonly why?: string;
  readonly prev: string;
  readonly hash: string;
  /** HMAC-SHA256 of the hash, with the writer's key: what someone who can only write the file cannot recompute. */
  readonly mac?: string;
}

const macOf = (key: Buffer, hash: string) => createHmac('sha256', key).update(`zthr-ledger:${hash}`).digest('hex');

export function log(l: Ledger, e: Omit<LogEntry, 'seq' | 'at' | 'prev' | 'hash' | 'mac'>): LogEntry {
  const all = readLines<LogEntry>(l, 'log.jsonl');
  const prev = all.at(-1)?.hash ?? 'genesis';
  const body = { seq: all.length + 1, at: l.now(), ...e, prev };
  const hash = sha256(prev + JSON.stringify(body));
  const row: LogEntry = { ...body, hash, ...(l.key ? { mac: macOf(l.key, hash) } : {}) };
  append(l, 'log.jsonl', row);
  return row;
}

/** A published head: line `seq` of the log had `hash`. `from` says where it was published. */
export interface Anchor {
  readonly seq: number;
  readonly hash: string;
  readonly from: string;
}

/** The log's head now: the anchor to publish. Seq 0 and 'genesis' for an empty log. */
export function head(l: Ledger): { seq: number; hash: string } {
  const last = readLines<LogEntry>(l, 'log.jsonl').at(-1);
  return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: 'genesis' };
}

export type LogVerdict = { ok: true; lines: number; head: string; anchored: number } | { ok: false; at: number; why: string };

/**
 * Whether the log holds: each line's hash is right and points at the line before, each line's HMAC is the writer's,
 * and every published anchor is still in it. Fails closed: without the key there is no verdict, because a chain
 * anyone can recompute proves nothing; and a log shorter than an anchor has lost lines.
 */
export function verifyLog(l: Ledger, anchors: readonly Anchor[] = []): LogVerdict {
  if (!l.key) return { ok: false, at: 0, why: 'no ledger key: an unkeyed chain can be recomputed by anyone who can write the file, so it is not verified' };
  const all = readLines<LogEntry>(l, 'log.jsonl');
  let prev = 'genesis';
  for (const [i, e] of all.entries()) {
    const { hash, mac, ...body } = e;
    if (body.seq !== i + 1) return { ok: false, at: i + 1, why: `line ${i + 1} says it is entry ${body.seq}` };
    if (body.prev !== prev || sha256(prev + JSON.stringify(body)) !== hash) return { ok: false, at: e.seq, why: 'the hash chain is broken' };
    const want = Buffer.from(macOf(l.key, hash), 'hex');
    if (!mac || !/^[0-9a-f]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, 'hex'), want)) return { ok: false, at: e.seq, why: mac ? 'the HMAC is not the ledger writer’s: the chain was recomputed without the key' : 'the line carries no HMAC' };
    prev = hash;
  }
  for (const a of anchors) {
    if (a.seq === 0) continue;
    const line = all[a.seq - 1];
    if (!line) return { ok: false, at: a.seq, why: `${a.from} anchored entry ${a.seq}, but the log has ${all.length}: lines were removed` };
    if (line.hash !== a.hash) return { ok: false, at: a.seq, why: `entry ${a.seq} is not the one ${a.from} anchored` };
  }
  return { ok: true, lines: all.length, head: prev, anchored: Math.max(0, ...anchors.map((a) => a.seq)) };
}

/** The anchors in the workspace's release records: each revision carries the ledger head at its issue. */
export function releaseAnchors(workspace: string): Anchor[] {
  const p = join(workspace, 'history.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x) as { revision: number; ledger?: { seq: number; hash: string } })
    .filter((h) => h.ledger)
    .map((h) => ({ seq: h.ledger!.seq, hash: h.ledger!.hash, from: `release ${h.revision}` }));
}

export const ANCHOR_TAG = 'zthr-ledger/';

/** The anchors published as tags in a factory checkout: refs/tags/zthr-ledger/<seq>, the head in the message. */
export function tagAnchors(factory: string): Anchor[] {
  const r = spawnSync('git', ['for-each-ref', `refs/tags/${ANCHOR_TAG}`, '--format=%(refname:short)%00%(contents)%00%00'], { cwd: factory, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\0\0')
    .map((x) => x.replace(/^\n/, ''))
    .filter(Boolean)
    .flatMap((x) => {
      const [name, msg] = x.split('\0');
      try {
        const a = JSON.parse((msg ?? '').trim()) as { seq: number; hash: string };
        return Number.isInteger(a.seq) && typeof a.hash === 'string' ? [{ seq: a.seq, hash: a.hash, from: `tag ${name}` }] : [];
      } catch {
        return [{ seq: Number.MAX_SAFE_INTEGER, hash: 'unreadable', from: `tag ${name} (unreadable)` }];
      }
    });
}

/** Publish the head as an annotated tag in the factory checkout. Pushing it is the pipeline's job. */
export function tagAnchor(l: Ledger, factory: string): { tag: string; seq: number; hash: string } {
  const h = head(l);
  const tag = `${ANCHOR_TAG}${h.seq}`;
  const r = spawnSync('git', ['-c', 'user.name=zthr ledger', '-c', 'user.email=ledger@zthr.invalid', '-c', 'tag.gpgsign=false', 'tag', '-a', tag, '-m', JSON.stringify(h)], { cwd: factory, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not tag ${tag}: ${r.stderr.trim()}`);
  return { tag, ...h };
}

// ------------------------------------------------------------------ proposals and signatures

export type ProposalKind = 'answer' | 'journey' | 'intent' | 'production' | 'ratchet-reset' | 'clarification';

export function propose(l: Ledger, from: Session, kind: ProposalKind, title: string, reason: string, body: Record<string, unknown>): Proposal {
  const at = l.now();
  const id = `p-${sha256(`${kind}:${JSON.stringify(body)}:${at}:${from.agent}`).slice(0, 10)}`;
  const p: Proposal = { id, kind, title, reason, body, from, at };
  writeFileSync(join(l.dir, 'proposals', `${id}.json`), `${JSON.stringify(p, null, 2)}\n`);
  return p;
}

export const proposals = (l: Ledger): Proposal[] =>
  readdirSync(join(l.dir, 'proposals'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(l.dir, 'proposals', f), 'utf8')) as Proposal)
    .sort((a, b) => a.at.localeCompare(b.at));

// ------------------------------------------------------------------ people, and what only they do

/**
 * Who may sign, and with which keys. A listed person with no key cannot sign: naming an address on the command line
 * proves nothing, so every act is an SSH signature by one of that person's keys over the exact act.
 *
 *   { "signers": ["you@example.com"], "keys": { "you@example.com": ["ssh-ed25519 AAAA… you"] } }
 */
export interface People {
  readonly signers: readonly string[];
  readonly keys: Readonly<Record<string, readonly string[]>>;
}

export const NAMESPACE = 'zthr-intent';

export function people(l: Ledger): People {
  const p = join(l.dir, 'people.json');
  if (!existsSync(p)) return { signers: [], keys: {} };
  const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<People>;
  return { signers: j.signers ?? [], keys: j.keys ?? {} };
}

export const signers = (l: Ledger): string[] => [...people(l).signers];

export const keysOf = (l: Ledger, by: string): PublicKey[] => {
  const p = people(l);
  return p.signers.includes(by) ? (p.keys[by] ?? []).map(parseKey).filter((k): k is PublicKey => k !== null) : [];
};

/** The exact text a person signs for an act: what, by whom, and the hash of everything it decides. */
export function actText(kind: string, by: string, fields: Readonly<Record<string, string | number | boolean>>): string {
  const lines = Object.keys(fields)
    .sort()
    .map((k) => `${k}: ${String(fields[k])}`);
  return `zthr person act\nact: ${kind}\nby: ${by}\n${lines.join('\n')}\n`;
}

/** Whether `signature` is `by`'s, over `text`. Says why not, so a refusal is plain. */
export function checkAct(l: Ledger, by: string, text: string, signature: string | undefined): { ok: true; key: string } | { ok: false; why: string } {
  if (!signers(l).includes(by)) return { ok: false, why: `${by} is not listed in ${join(l.dir, 'people.json')} as someone who may sign` };
  const keys = keysOf(l, by);
  if (!keys.length) return { ok: false, why: `${by} has no signing key in people.json, so nothing can be signed as them` };
  if (!signature) return { ok: false, why: 'unsigned: a person’s act is an SSH signature over the act, not a name on the command line' };
  const v = verifySsh(text, signature, NAMESPACE, keys);
  return v.ok ? { ok: true, key: v.key.fingerprint } : { ok: false, why: v.why };
}

export interface Proposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly reason: string;
  readonly body: Record<string, unknown>;
  readonly from: Session;
  readonly at: string;
}

/** What a person signs for a decision on a proposal: its id, the decision, and the hash of the proposal itself. */
export const decisionText = (p: Proposal, decision: 'signed' | 'declined', by: string): string => actText('decide', by, { proposal: p.id, decision, hash: sha256(JSON.stringify(p)) });

export interface Signature {
  readonly proposal: string;
  readonly decision: 'signed' | 'declined';
  readonly by: string;
  readonly at: string;
  readonly note?: string;
  /** The armored SSH signature over decisionText. */
  readonly signature?: string;
}

export const signatures = (l: Ledger): Signature[] => readLines<Signature>(l, 'signatures.jsonl');

/**
 * The decision on a proposal: the first one whose signature verifies against the proposal as it stands. A line
 * appended by anyone else, one signed by the wrong key, or one for a proposal edited after it was signed, is not a
 * decision at all.
 */
export function decisionOn(l: Ledger, id: string): Signature | undefined {
  const p = proposals(l).find((x) => x.id === id);
  if (!p) return undefined;
  return signatures(l)
    .filter((s) => s.proposal === id)
    .find((s) => (s.decision === 'signed' || s.decision === 'declined') && checkAct(l, s.by, decisionText(p, s.decision, s.by), s.signature).ok);
}

/** A standing act a person makes: what the factory may do without asking, and what it may spend. */
export interface Act {
  readonly kind: 'delegate' | 'budget';
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  readonly by: string;
  readonly at: string;
  /** The hash of the last valid act of this kind, or "none": an old act appended again does not follow the chain. */
  readonly prev: string;
  readonly signature: string;
}

export const actTextOf = (a: Pick<Act, 'kind' | 'fields' | 'by' | 'prev'>) => actText(a.kind, a.by, { ...a.fields, prev: a.prev });

/** The valid acts of a kind, in order: each signed by a listed person and chained to the one before. */
export function validActs(l: Ledger, kind: Act['kind']): Act[] {
  const out: Act[] = [];
  for (const a of readLines<Act>(l, 'acts.jsonl').filter((x) => x.kind === kind)) {
    const prev = out.length ? sha256(actTextOf(out.at(-1)!)) : 'none';
    if (a.prev === prev && checkAct(l, a.by, actTextOf(a), a.signature).ok) out.push(a);
  }
  return out;
}

/** Record a standing act, if `signature` is `by`'s over it. Refused otherwise, and nothing is written. */
export function recordAct(l: Ledger, kind: Act['kind'], fields: Act['fields'], by: string, signature: string | undefined): { ok: true; act: Act } | { ok: false; why: string; text: string } {
  const prev = nextPrev(l, kind);
  const text = actTextOf({ kind, fields, by, prev });
  const v = checkAct(l, by, text, signature);
  if (!v.ok) return { ok: false, why: v.why, text };
  const act: Act = { kind, fields, by, at: l.now(), prev, signature: signature! };
  append(l, 'acts.jsonl', act);
  return { ok: true, act };
}

/** The prev a new act of this kind must carry. */
export const nextPrev = (l: Ledger, kind: Act['kind']): string => {
  const last = validActs(l, kind).at(-1);
  return last ? sha256(actTextOf(last)) : 'none';
};

// ------------------------------------------------------------------ changes, checks, reviews

export interface Change {
  readonly id: string;
  readonly title: string;
  /** The commit under review. Checks run on it and nothing else. */
  readonly commit: string;
  /** Where the work starts from, when the change is more than one commit. */
  readonly base?: string;
  readonly paths: readonly string[];
  /** The revision of the package it builds to. */
  readonly revision: number;
  readonly author: Session;
  readonly at: string;
  /** Proven paths touched: the gate must be re-proved against its planted defects before the change counts. */
  readonly reprove: readonly string[];
  /** The correction case this change answers, when it is a fix. */
  readonly case?: string;
}

export const changes = (l: Ledger): Change[] =>
  readdirSync(join(l.dir, 'changes'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(l.dir, 'changes', f), 'utf8')) as Change)
    .sort((a, b) => a.at.localeCompare(b.at));

export const changeOf = (l: Ledger, id: string): Change | undefined => changes(l).find((c) => c.id === id);

export function openChange(l: Ledger, c: Omit<Change, 'id' | 'at'>): Change {
  const at = l.now();
  const ch = { ...c, id: `c-${sha256(`${JSON.stringify(c)}:${at}`).slice(0, 10)}`, at };
  writeFileSync(join(l.dir, 'changes', `${ch.id}.json`), `${JSON.stringify(ch, null, 2)}\n`);
  return ch;
}

export interface CheckRun {
  readonly change: string;
  readonly check: string;
  readonly step: string;
  readonly ok: boolean;
  readonly exit: number | null;
  /** The last lines the check printed, so a failure says why without anyone retyping it. */
  readonly tail: string;
  /** The tree the check ran on. An identical tree that passed before is not run again. */
  readonly tree?: string;
  readonly reused?: boolean;
  readonly by: Session;
  readonly at: string;
}

/**
 * The model call a review came from. The session's family is a flag whoever starts the session sets; this is what
 * binds a verdict to a real call: who served it, which model, the provider's own id for the response (which the
 * provider can be asked about), and the tree the reviewer was shown. Recorded by the API from the driver that made
 * the call, never taken from the agent's input.
 */
export interface ReviewEvidence {
  /** Who served the call: vertex, ollama, anthropic, openai, … */
  readonly provider: string;
  /** The model id exactly as the provider names it. Its family is read from it, not from the session. */
  readonly model: string;
  /** The provider's id for the response that carried the verdict. */
  readonly response: string;
  /** The git tree of the change's commit, as the API read it. */
  readonly tree: string;
}

export interface ReviewRecord {
  readonly change: string;
  readonly verdict: 'pass' | 'block';
  readonly checked: readonly string[];
  readonly findings: readonly { readonly what: string; readonly severity: 'blocking' | 'major' | 'minor'; readonly path?: string; readonly line?: number }[];
  readonly by: Session;
  readonly at: string;
  readonly evidence?: ReviewEvidence;
}

// ------------------------------------------------------------------ delivery

export interface DeployRecord {
  readonly change: string;
  /** The revision of the package the change builds to. */
  readonly revision: number;
  readonly stage: string;
  readonly kind: 'requested' | 'result' | 'rollback';
  readonly ok?: boolean;
  readonly build?: string;
  readonly detail?: string;
  readonly by: Session;
  readonly at: string;
}

// ------------------------------------------------------------------ tickets

export type TicketStatus = 'new' | 'triaged' | 'in progress' | 'resolved' | 'duplicate' | 'not a problem';

export interface TicketEvent {
  readonly ticket: string;
  readonly event: 'filed' | 'triaged' | 'defect' | 'idea';
  readonly at: string;
  readonly by: string;
  /** For filed: what the person wrote, kept exactly. */
  readonly kind?: 'bug' | 'idea' | 'question' | 'praise';
  readonly title?: string;
  readonly happened?: string;
  readonly expected?: string;
  readonly where?: string;
  /** For triaged. */
  readonly status?: TicketStatus;
  readonly severity?: 'critical' | 'high' | 'medium' | 'low';
  readonly note?: string;
  readonly duplicateOf?: string;
  readonly evidence?: string;
  /** For defect: the failing test a builder writes first. For idea: the proposal it became. */
  readonly test?: string;
  readonly expectation?: string;
  readonly proposal?: string;
}

/** A report from the app, as the sync from the platform files it. Never an agent tool. */
export function fileTicket(l: Ledger, t: { id: string; by: string; kind: NonNullable<TicketEvent['kind']>; title: string; happened?: string; expected?: string; where?: string }): void {
  append(l, 'tickets.jsonl', { ticket: t.id, event: 'filed', at: l.now(), by: t.by, kind: t.kind, title: t.title, happened: t.happened ?? '', expected: t.expected ?? '', where: t.where ?? '' } satisfies TicketEvent);
}

export interface Ticket {
  readonly id: string;
  readonly filed: TicketEvent;
  readonly status: TicketStatus;
  readonly severity: TicketEvent['severity'] | null;
  readonly duplicateOf: string | null;
  readonly defects: readonly string[];
  readonly history: readonly TicketEvent[];
}

export function tickets(l: Ledger): Ticket[] {
  const by = new Map<string, TicketEvent[]>();
  for (const e of readLines<TicketEvent>(l, 'tickets.jsonl')) by.set(e.ticket, [...(by.get(e.ticket) ?? []), e]);
  return [...by.entries()]
    .filter(([, es]) => es[0]!.event === 'filed')
    .map(([id, es]) => {
      const tri = es.filter((e) => e.event === 'triaged');
      const last = <K extends keyof TicketEvent>(k: K) => tri.filter((e) => e[k] !== undefined).at(-1)?.[k];
      return {
        id,
        filed: es[0]!,
        status: (last('status') as TicketStatus | undefined) ?? 'new',
        severity: (last('severity') as Ticket['severity'] | undefined) ?? null,
        duplicateOf: (last('duplicateOf') as string | undefined) ?? null,
        defects: es.filter((e) => e.event === 'defect').map((e) => e.test!),
        history: es,
      };
    });
}
