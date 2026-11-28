/**
 * What the factory spends, and where it stops. The work is judged by the fixture (checks, gauges, ratchets, walks),
 * not by the model, so each seat runs the cheapest model that can do its job, and every token is metered against a
 * ceiling the person sets. When the ceiling is reached the agenda pauses: nothing is skipped, it waits.
 *
 *   agents/acts.jsonl    the person's signed ceiling: dollars a day, and dollars a case. Raised only by a person.
 *   agents/budget.json   a lower ceiling anyone may set; it never raises the signed one
 *   agents/spend.jsonl   every model call the driver made: seat, model, tokens, dollars
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import plan from '../../catalog/models.json' with { type: 'json' };
import type { Role } from './duties.ts';
import { append, readLines, validActs, type Ledger } from './ledger.ts';

export interface ModelSpec {
  readonly provider: 'vertex' | 'ollama';
  readonly model: string;
  readonly region?: string;
  readonly family: string;
  readonly price: { readonly in: number; readonly cachedIn: number; readonly out: number };
  readonly for: string;
}

export interface Plan {
  readonly checked: string;
  readonly models: Readonly<Record<string, ModelSpec>>;
  readonly seats: Readonly<Record<Role, readonly string[]>>;
  readonly limits: { readonly maxOutputTokens: Readonly<Partial<Record<Role, number>>>; readonly maxTurns: number };
}

export const PLAN = plan as unknown as Plan;

/** The models a seat may use, cheapest that fits first, leaving out any family the API would refuse. */
export function seatModels(role: Role, notFamilies: readonly string[] = [], p: Plan = PLAN): { key: string; spec: ModelSpec }[] {
  return (p.seats[role] ?? []).map((key) => ({ key, spec: p.models[key]! })).filter((m) => m.spec && !notFamilies.includes(m.spec.family));
}

export interface Usage {
  readonly in: number;
  readonly cachedIn?: number;
  readonly out: number;
}

export const dollars = (m: ModelSpec, u: Usage): number => ((u.in - (u.cachedIn ?? 0)) * m.price.in + (u.cachedIn ?? 0) * m.price.cachedIn + u.out * m.price.out) / 1_000_000;

export interface Spend {
  readonly at: string;
  readonly role: Role;
  readonly model: string;
  readonly in: number;
  readonly cachedIn: number;
  readonly out: number;
  readonly usd: number;
  readonly case?: string;
}

export function meter(l: Ledger, role: Role, key: string, u: Usage, kase?: string, p: Plan = PLAN): Spend {
  const m = p.models[key]!;
  const row: Spend = { at: l.now(), role, model: key, in: u.in, cachedIn: u.cachedIn ?? 0, out: u.out, usd: Number(dollars(m, u).toFixed(6)), ...(kase ? { case: kase } : {}) };
  append(l, 'spend.jsonl', row);
  return row;
}

export interface Budget {
  readonly dailyUSD: number;
  readonly caseUSD: number;
}

/** Without a ceiling set by a person, the factory spends a dollar a day: enough to prove the loop, not to hurt. */
export const DEFAULT_BUDGET: Budget = { dailyUSD: 1, caseUSD: 0.25 };

/**
 * The ceiling: the last one a person signed (agents/acts.jsonl), or the default. A lower ceiling is always safe, so
 * agents/budget.json, written by anyone, can only lower it; raising it is a person's signed act.
 */
export function budget(l: Ledger): Budget {
  const a = validActs(l, 'budget').at(-1);
  const signed: Budget = a ? { dailyUSD: Number(a.fields['dailyUSD']), caseUSD: Number(a.fields['caseUSD']) } : DEFAULT_BUDGET;
  const p = join(l.dir, 'budget.json');
  if (!existsSync(p)) return signed;
  const local = JSON.parse(readFileSync(p, 'utf8')) as Partial<Budget>;
  const lower = (x: unknown, y: number) => (typeof x === 'number' && x >= 0 ? Math.min(x, y) : y);
  return { dailyUSD: lower(local.dailyUSD, signed.dailyUSD), caseUSD: lower(local.caseUSD, signed.caseUSD) };
}

export function budgetState(l: Ledger, kase?: string) {
  const b = budget(l);
  const today = l.now().slice(0, 10);
  const rows = readLines<Spend>(l, 'spend.jsonl');
  const spentToday = rows.filter((r) => r.at.startsWith(today)).reduce((a, r) => a + r.usd, 0);
  const spentCase = kase ? rows.filter((r) => r.case === kase).reduce((a, r) => a + r.usd, 0) : 0;
  return {
    ceiling: b,
    spentToday: Number(spentToday.toFixed(4)),
    spentCase: Number(spentCase.toFixed(4)),
    paused: spentToday >= b.dailyUSD,
    caseOver: kase ? spentCase >= b.caseUSD : false,
  };
}
