/**
 * The record of a factory run by agents, kept beside the intent's workspace. Everything is appended, never
 * rewritten: every call to the API, allowed or refused, goes into a log where each line carries the hash of the
 * one before it, so a removed or edited line breaks the chain.
 *
 *   agents/log.jsonl          every call: who, which tool, the outcome, chained by hash
 *   agents/proposals/<id>     what an agent asks a person to decide
 *   agents/signatures.jsonl   a person's decisions; written only by the sign command, never by the API
 *   agents/people.json        who may sign; changed only by a person
 *   agents/changes/<id>       a builder's change: its paths and its author
 *   agents/checks.jsonl       each required check the API ran, and what the process returned
 *   agents/reviews.jsonl      each review, with what was checked and what was found
 *   agents/deploy.jsonl       delivery requests by the operator, and results recorded by the pipeline
 *   agents/tickets.jsonl      what people reported, and every triage event after it
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../hash.ts';
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
}

export const ledgerOf = (workspace: string, now: () => string = () => new Date().toISOString()): Ledger => {
  const dir = join(workspace, 'agents');
  for (const d of ['', 'proposals', 'changes']) mkdirSync(join(dir, d), { recursive: true });
  return { dir, now };
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
}

export function log(l: Ledger, e: Omit<LogEntry, 'seq' | 'at' | 'prev' | 'hash'>): LogEntry {
  const all = readLines<LogEntry>(l, 'log.jsonl');
  const prev = all.at(-1)?.hash ?? 'genesis';
  const body = { seq: all.length + 1, at: l.now(), ...e, prev };
  const row = { ...body, hash: sha256(prev + JSON.stringify(body)) };
  append(l, 'log.jsonl', row);
  return row;
}

/** Whether the chain holds: each line's hash is right and points at the line before. */
export function verifyLog(l: Ledger): { ok: true; lines: number } | { ok: false; at: number } {
  const all = readLines<LogEntry>(l, 'log.jsonl');
  let prev = 'genesis';
  for (const e of all) {
    const { hash, ...body } = e;
    if (body.prev !== prev || sha256(prev + JSON.stringify(body)) !== hash) return { ok: false, at: e.seq };
    prev = hash;
  }
  return { ok: true, lines: all.length };
}

// ------------------------------------------------------------------ proposals and signatures

export type ProposalKind = 'answer' | 'journey' | 'intent' | 'production' | 'ratchet-reset' | 'clarification';

export interface Proposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly reason: string;
  readonly body: Record<string, unknown>;
  readonly from: Session;
  readonly at: string;
}

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

export interface Signature {
  readonly proposal: string;
  readonly decision: 'signed' | 'declined';
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}

export const signatures = (l: Ledger): Signature[] => readLines<Signature>(l, 'signatures.jsonl');
export const decisionOn = (l: Ledger, id: string): Signature | undefined => signatures(l).filter((s) => s.proposal === id).at(-1);

export const signers = (l: Ledger): string[] => {
  const p = join(l.dir, 'people.json');
  return existsSync(p) ? ((JSON.parse(readFileSync(p, 'utf8')) as { signers?: string[] }).signers ?? []) : [];
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

export interface ReviewRecord {
  readonly change: string;
  readonly verdict: 'pass' | 'block';
  readonly checked: readonly string[];
  readonly findings: readonly { readonly what: string; readonly severity: 'blocking' | 'major' | 'minor'; readonly path?: string; readonly line?: number }[];
  readonly by: Session;
  readonly at: string;
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
