/**
 * The crew's router: which model gets a work order. The rule is the cheapest model proven good enough. A model is
 * proven for a kind of task when the Wilson lower bound of its measured pass rate on that kind clears a bar after
 * enough attempts, so a model with few tries is explored but not trusted. Untried models cheaper than the trusted
 * choice are explored at a set rate. A task that keeps failing climbs from worker to escalation to judgment models,
 * and past judgment it is parked for a person. Spending stops when the day's budget is spent. Cost is worked out from
 * token counts and a dated price table, per request, with the long-context tier and the regional premium applied.
 *
 * Pure: the price table, the results log, the clock and the randomness are arguments.
 */

export type RunnerKind = 'claude-code' | 'openai-compatible';
export type Level = 'worker' | 'escalation' | 'judgment';
export const LEVELS: readonly Level[] = ['worker', 'escalation', 'judgment'];

/** What a model is, apart from its price. */
export interface Entry {
  readonly id: string;
  /** The model name sent to Vertex: the Claude model id, or publisher/model for the OpenAI-compatible endpoint. */
  readonly vertexId: string;
  readonly family: string;
  readonly runner: RunnerKind;
  readonly levels: readonly Level[];
  /** Largest single request, in tokens. */
  readonly contextTokens: number;
  /** Vertex location; 'global' unless the model is served only regionally. */
  readonly location: string;
}

/** USD per million tokens. */
export interface Rate {
  readonly input: number;
  readonly output: number;
}

export interface PriceEntry {
  readonly id: string;
  readonly input: number;
  readonly output: number;
  /** Batch rates, when offered. */
  readonly batch?: Rate;
  /** Above this many input tokens in one request, the whole request is billed at the long rates. */
  readonly long?: Rate & { readonly aboveInputTokens: number; readonly confirmed: boolean };
  /** Prompt-cache rates as multiples of the input rate. */
  readonly cache?: { readonly read: number; readonly write: number; readonly confirmed: boolean };
  /** The source this row was read from, and when. */
  readonly source: string;
  readonly checked: string;
  /** Last day a promotional rate holds. */
  readonly validUntil?: string;
  /** Day the provider retired the model; it stays listed so old results still price, and is never chosen. */
  readonly retired?: string;
}

export interface PriceTable {
  readonly checked: string;
  readonly currency: 'USD';
  readonly unit: 'per-million-tokens';
  /** Multiplier for regional and multi-region endpoints over the global endpoint. */
  readonly regionalMultiplier: number;
  readonly models: readonly PriceEntry[];
}

export interface Model extends Entry {
  readonly price: PriceEntry;
}

/** The crew's catalogue. Ids as Vertex documents them; see intent/factory/prices.json for where each was read. */
export const CATALOGUE: readonly Entry[] = [
  { id: 'gpt-oss-120b', vertexId: 'openai/gpt-oss-120b-maas', family: 'openai', runner: 'openai-compatible', levels: ['worker'], contextTokens: 131_072, location: 'global' },
  { id: 'claude-haiku-5-5', vertexId: 'claude-haiku-5-5', family: 'anthropic', runner: 'claude-code', levels: ['worker'], contextTokens: 200_000, location: 'global' },
  { id: 'deepseek-v4.1-flash', vertexId: 'deepseek-ai/deepseek-v4.1-flash-maas', family: 'deepseek', runner: 'openai-compatible', levels: ['worker'], contextTokens: 1_000_000, location: 'global' },
  { id: 'qwen3-coder-480b-a35b-instruct', vertexId: 'qwen/qwen3-coder-480b-a35b-instruct-maas', family: 'alibaba', runner: 'openai-compatible', levels: ['worker'], contextTokens: 262_144, location: 'global' },
  { id: 'gemini-3.5-flash-lite', vertexId: 'google/gemini-3.5-flash-lite', family: 'google', runner: 'openai-compatible', levels: ['worker'], contextTokens: 1_000_000, location: 'global' },
  { id: 'gemini-3.8-flash', vertexId: 'google/gemini-3.8-flash', family: 'google', runner: 'openai-compatible', levels: ['escalation'], contextTokens: 1_000_000, location: 'global' },
  { id: 'claude-sonnet-5-5', vertexId: 'claude-sonnet-5-5', family: 'anthropic', runner: 'claude-code', levels: ['escalation'], contextTokens: 1_000_000, location: 'global' },
  { id: 'claude-opus-5-5', vertexId: 'claude-opus-5-5', family: 'anthropic', runner: 'claude-code', levels: ['judgment'], contextTokens: 1_000_000, location: 'global' },
];

/** Joins the catalogue to the price table. A catalogue model with no price is an error: it could not be accounted. */
export function models(table: PriceTable, entries: readonly Entry[] = CATALOGUE): Model[] {
  const byId = new Map(table.models.map((p) => [p.id, p]));
  return entries.map((e) => {
    const price = byId.get(e.id);
    if (!price) throw new Error(`no price for ${e.id} in the price table`);
    return { ...e, price };
  });
}

const DAY = 86_400_000;

/** Problems that make the price table unfit to route by: too old, a promotional rate past its end, a bad row. */
export function staleness(table: PriceTable, now: Date, maxAgeDays = 30): string[] {
  const out: string[] = [];
  const age = (d: string) => (now.getTime() - Date.parse(`${d}T00:00:00Z`)) / DAY;
  if (!(age(table.checked) <= maxAgeDays)) out.push(`price table checked ${table.checked}, more than ${maxAgeDays} days ago`);
  for (const p of table.models) {
    if (!(age(p.checked) <= maxAgeDays)) out.push(`${p.id}: price checked ${p.checked}, more than ${maxAgeDays} days ago`);
    if (p.validUntil && age(p.validUntil) > 1) out.push(`${p.id}: rate valid until ${p.validUntil}, now past`);
    if (!(p.input >= 0 && p.output >= 0)) out.push(`${p.id}: negative or missing rate`);
    if (!p.source.startsWith('https://')) out.push(`${p.id}: no source`);
  }
  return out;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * USD for one request. When the request's input (cached input included) is above the long-context threshold, every
 * token of the request is billed at the long rates. Regional and multi-region endpoints carry the multiplier.
 */
export function cost(m: Model, u: Usage, o: { regionalMultiplier: number; batch?: boolean; location?: string }): number {
  for (const n of [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0]) if (!(n >= 0)) throw new Error('token counts must be zero or more');
  const p = m.price;
  const totalIn = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  let rate: Rate = { input: p.input, output: p.output };
  if (p.long && totalIn > p.long.aboveInputTokens) rate = p.long;
  else if (o.batch && p.batch) rate = p.batch;
  const read = p.cache?.read ?? 1;
  const write = p.cache?.write ?? 1;
  const usd = (u.inputTokens * rate.input + (u.cacheReadTokens ?? 0) * rate.input * read + (u.cacheWriteTokens ?? 0) * rate.input * write + u.outputTokens * rate.output) / 1_000_000;
  const where = o.location ?? m.location;
  return round(where === 'global' ? usd : usd * o.regionalMultiplier);
}

export const round = (usd: number) => Math.round(usd * 1e9) / 1e9;

// ---------------------------------------------------------------------------------------------------------------
// Measured performance

/** One line of intent/factory/results.jsonl. `pass` is null when the attempt says nothing about the model. */
export interface Result {
  readonly at: string;
  readonly model: string;
  readonly kind: string;
  readonly pass: boolean | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly task?: string;
  readonly level?: Level;
  readonly outcome?: string;
}

export interface Stat {
  readonly attempts: number;
  readonly passes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

const ZERO: Stat = { attempts: 0, passes: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const key = (model: string, kind: string) => `${model}␟${kind}`;

/** Attempts, passes, tokens and cost per model per task kind. Neutral attempts cost money but are not scored. */
export function measure(results: readonly Result[]): Map<string, Stat> {
  const m = new Map<string, Stat>();
  for (const r of results) {
    const s = m.get(key(r.model, r.kind)) ?? ZERO;
    const scored = r.pass !== null;
    m.set(key(r.model, r.kind), {
      attempts: s.attempts + (scored ? 1 : 0),
      passes: s.passes + (r.pass === true ? 1 : 0),
      inputTokens: s.inputTokens + r.inputTokens,
      outputTokens: s.outputTokens + r.outputTokens,
      costUsd: round(s.costUsd + r.costUsd),
    });
  }
  return m;
}

export const statOf = (stats: Map<string, Stat>, model: string, kind: string): Stat => stats.get(key(model, kind)) ?? ZERO;

/** Wilson score interval for k passes in n attempts. With no attempts it is [0, 1]: nothing is known. */
export function wilson(k: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  if (!(k >= 0 && k <= n)) throw new Error(`passes ${k} out of range for ${n} attempts`);
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return { lower: Math.max(0, (centre - spread) / denom), upper: Math.min(1, (centre + spread) / denom) };
}

/** USD spent on a UTC day (YYYY-MM-DD). */
export const spentOn = (results: readonly Result[], day: string): number => round(results.filter((r) => r.at.slice(0, 10) === day).reduce((a, r) => a + r.costUsd, 0));

/** Scored failures of one task so far, which decide its level. */
export const failuresOf = (results: readonly Result[], task: string): number => results.filter((r) => r.task === task && r.pass === false).length;

// ---------------------------------------------------------------------------------------------------------------
// Choosing

export interface Policy {
  /** The Wilson lower bound a model must clear to be trusted. */
  readonly bar: number;
  /** Scored attempts before a model can be trusted or ruled out. */
  readonly minAttempts: number;
  /** Share of choices that explore a cheaper model not yet trusted, when a trusted one exists. */
  readonly explore: number;
  /** Failures at a level before the task climbs to the next. */
  readonly failuresPerLevel: number;
  readonly z: number;
  /** Share of an estimate that is input, when only a total is given. */
  readonly inputShare: number;
}

export const POLICY: Policy = { bar: 0.5, minAttempts: 5, explore: 0.1, failuresPerLevel: 2, z: 1.96, inputShare: 0.85 };

export type Standing = 'trusted' | 'exploring' | 'ruled-out';

export interface Estimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The largest single request, which decides the long-context tier and whether the model can hold it. */
  readonly largestRequest?: number;
}

export interface Choice {
  readonly stop: false;
  readonly model: Model;
  readonly level: Level;
  readonly why: 'trusted' | 'explore' | 'not-yet-proven';
  readonly standing: Standing;
  readonly estCostUsd: number;
  readonly stat: Stat;
  readonly lower: number;
}

export interface Stop {
  readonly stop: true;
  readonly reason: 'budget' | 'parked' | 'no-model';
  readonly detail: string;
}

export interface ChooseOptions {
  /** Scored failures of this task so far. */
  readonly failures?: number;
  /** Families that must not be chosen (a judge never shares the claimant's family). */
  readonly excludeFamilies?: readonly string[];
  /** Only these families (a review seat). */
  readonly onlyFamilies?: readonly string[];
  /** Runner kinds this dispatcher can run. */
  readonly runners?: readonly RunnerKind[];
  /** Start at this level instead of the one the failures give. */
  readonly level?: Level;
  /** Consider every level from the starting one, not just that level. */
  readonly anyLevel?: boolean;
  /** Models that already failed this task: passed over while the level has another model. */
  readonly avoid?: readonly string[];
}

export class Router {
  readonly models: readonly Model[];
  readonly stats: Map<string, Stat>;
  readonly policy: Policy;
  private readonly table: PriceTable;
  private readonly random: () => number;
  private readonly today: string;

  constructor(table: PriceTable, results: readonly Result[], o: { now: Date; random: () => number; policy?: Partial<Policy>; entries?: readonly Entry[] }) {
    this.table = table;
    this.models = models(table, o.entries ?? CATALOGUE);
    this.stats = measure(results);
    this.policy = { ...POLICY, ...o.policy };
    this.random = o.random;
    this.today = o.now.toISOString().slice(0, 10);
  }

  model(id: string): Model {
    const m = this.models.find((x) => x.id === id || x.vertexId === id);
    if (!m) throw new Error(`unknown model ${id}`);
    return m;
  }

  cost(id: string, u: Usage, o: { batch?: boolean; location?: string } = {}): number {
    return cost(this.model(id), u, { regionalMultiplier: this.table.regionalMultiplier, ...o });
  }

  estimate(est: number | Estimate): Estimate {
    if (typeof est !== 'number') return est;
    const input = Math.round(est * this.policy.inputShare);
    return { inputTokens: input, outputTokens: est - input, largestRequest: input };
  }

  /** Estimated cost of a task on a model; the long tier applies when the largest request is over the threshold. */
  estCost(m: Model, est: Estimate): number {
    const largest = est.largestRequest ?? est.inputTokens;
    const p = m.price;
    const long = p.long !== undefined && largest > p.long.aboveInputTokens;
    const rate: Rate = long && p.long ? p.long : p;
    const usd = (est.inputTokens * rate.input + est.outputTokens * rate.output) / 1_000_000;
    return round(m.location === 'global' ? usd : usd * this.table.regionalMultiplier);
  }

  standing(m: Model, kind: string): { standing: Standing; stat: Stat; lower: number } {
    const stat = statOf(this.stats, m.id, kind);
    const w = wilson(stat.passes, stat.attempts, this.policy.z);
    if (stat.attempts >= this.policy.minAttempts && w.lower >= this.policy.bar) return { standing: 'trusted', stat, lower: w.lower };
    if (stat.attempts >= this.policy.minAttempts && w.upper < this.policy.bar) return { standing: 'ruled-out', stat, lower: w.lower };
    return { standing: 'exploring', stat, lower: w.lower };
  }

  levelFor(failures: number): Level | undefined {
    return LEVELS[Math.floor(failures / this.policy.failuresPerLevel)];
  }

  /**
   * The cheapest model proven good enough for this kind of task at the task's level, or a cheaper one not yet
   * proven at the exploration rate. A level with no model that is not ruled out hands the task up a level.
   */
  choose(kind: string, est: number | Estimate, budgetLeftUsd: number, o: ChooseOptions = {}): Choice | Stop {
    if (!(budgetLeftUsd > 0)) return { stop: true, reason: 'budget', detail: `budget left ${budgetLeftUsd.toFixed(4)} USD` };
    const failures = o.failures ?? 0;
    const start = o.level ?? this.levelFor(failures);
    if (!start) return { stop: true, reason: 'parked', detail: `${failures} failures: past judgment, parked for a person` };
    const e = this.estimate(est);
    const largest = e.largestRequest ?? e.inputTokens;
    const exclude = new Set((o.excludeFamilies ?? []).map((f) => f.toLowerCase()));
    const only = o.onlyFamilies ? new Set(o.onlyFamilies.map((f) => f.toLowerCase())) : undefined;
    let overBudget = false;
    for (let i = LEVELS.indexOf(start); i < LEVELS.length; i++) {
      const level = LEVELS[i]!;
      const pool = this.models
        .filter((m) => (o.anyLevel ? LEVELS.slice(LEVELS.indexOf(start)).some((l) => m.levels.includes(l)) : m.levels.includes(level)))
        .filter((m) => !m.price.retired && !exclude.has(m.family.toLowerCase()) && (!only || only.has(m.family.toLowerCase())))
        .filter((m) => !o.runners || o.runners.includes(m.runner))
        .filter((m) => m.contextTokens >= largest)
        .map((m) => ({ m, est: this.estCost(m, e), ...this.standing(m, kind) }))
        .filter((c) => c.standing !== 'ruled-out')
        .sort((a, b) => a.est - b.est || a.m.id.localeCompare(b.m.id));
      const fresh = pool.filter((c) => !o.avoid?.includes(c.m.id));
      const affordable = (fresh.length ? fresh : pool).filter((c) => c.est <= budgetLeftUsd);
      if (pool.length && !affordable.length) overBudget = true;
      if (!affordable.length) {
        if (o.anyLevel) break;
        continue;
      }
      const trusted = affordable.find((c) => c.standing === 'trusted');
      const pick = (c: (typeof affordable)[number], why: Choice['why']): Choice => ({ stop: false, model: c.m, level, why, standing: c.standing, estCostUsd: c.est, stat: c.stat, lower: c.lower });
      const cheaper = affordable.filter((c) => c.standing === 'exploring' && (!trusted || c.est < trusted.est));
      const leastTried = [...cheaper].sort((a, b) => a.stat.attempts - b.stat.attempts || a.est - b.est || a.m.id.localeCompare(b.m.id))[0];
      if (trusted) return leastTried && this.random() < this.policy.explore ? pick(leastTried, 'explore') : pick(trusted, 'trusted');
      if (leastTried) return pick(leastTried, 'not-yet-proven');
      if (o.anyLevel) break;
    }
    if (overBudget) return { stop: true, reason: 'budget', detail: `no model fits the ${budgetLeftUsd.toFixed(4)} USD left` };
    return { stop: true, reason: 'no-model', detail: `no model from ${start} up can take a ${kind} task of ${largest} tokens${exclude.size ? ` outside ${[...exclude].join(', ')}` : ''}` };
  }

  /** A judge for a claim: any level, cheapest proven, and never of the claimant's family. */
  chooseJudge(claimantFamily: string, est: number | Estimate = 20_000, budgetLeftUsd = Number.POSITIVE_INFINITY, kind = 'judge'): Choice | Stop {
    if (!claimantFamily.trim()) throw new Error('the claimant family is required');
    const c = this.choose(kind, est, budgetLeftUsd, { excludeFamilies: [claimantFamily], level: 'worker', anyLevel: true });
    if (!c.stop && c.model.family.toLowerCase() === claimantFamily.toLowerCase()) throw new Error('unreachable: judge shares the claimant family');
    return c;
  }

  /** One model per seat, each seat from its allowed families, no two seats from the same family. */
  panel(kind: string, est: number | Estimate, seats: readonly { role: string; families: readonly string[] }[], budgetLeftUsd = Number.POSITIVE_INFINITY): { role: string; choice: Choice | Stop }[] {
    const used: string[] = [];
    return seats.map((s) => {
      const choice = this.choose(kind, est, budgetLeftUsd, { onlyFamilies: s.families, excludeFamilies: used, level: 'worker', anyLevel: true, runners: ['openai-compatible', 'claude-code'] });
      if (!choice.stop) used.push(choice.model.family);
      return { role: s.role, choice };
    });
  }

  /** Budget left today. */
  budgetLeft(dailyUsd: number, results: readonly Result[]): number {
    return round(dailyUsd - spentOn(results, this.today));
  }

  /** Pass rates per model per kind, for the morning report. */
  rates(): { model: string; kind: string; attempts: number; passes: number; lower: number; costUsd: number; standing: Standing }[] {
    const out: { model: string; kind: string; attempts: number; passes: number; lower: number; costUsd: number; standing: Standing }[] = [];
    for (const [k, s] of this.stats) {
      const [model, kind] = k.split('␟') as [string, string];
      const m = this.models.find((x) => x.id === model);
      const w = wilson(s.passes, s.attempts, this.policy.z);
      out.push({ model, kind, attempts: s.attempts, passes: s.passes, lower: Math.round(w.lower * 1000) / 1000, costUsd: s.costUsd, standing: m ? this.standing(m, kind).standing : 'exploring' });
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
  }
}
