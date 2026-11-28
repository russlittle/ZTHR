/**
 * The night shift's crew: the stations it works, the kinds of task it takes, the models that may take them, and the
 * router that picks the cheapest model proven good enough for each task. Prices are a dated reading of a list, not a
 * fact about the world: the router reads this table, and the table says when and where it was read.
 */

export type Tier = 'worker' | 'escalation' | 'judgment';
export const TIERS: readonly Tier[] = ['worker', 'escalation', 'judgment'];
const rank = (t: Tier) => TIERS.indexOf(t);

export type Station = 'gauges' | 'wear' | 'restore' | 'scrap' | 'suspicion';

/** The stations of the night shift: each repairs one kind of thing the day shift and metrology tag. */
export const STATIONS: readonly { key: Station; label: string; checks: string; tags: string }[] = [
  { key: 'gauges', label: 'Gauge repair', checks: 'Work orders from metrology’s calibration: a surviving mutant is a planted defect a test failed to reject; add the test, fix the defect it finds, or remove code that does nothing', tags: 'metrology’s calibration runs' },
  { key: 'wear', label: 'Wear checks', checks: 'Fuzzing, dependency advisories, and certificates, keys and tokens nearing expiry', tags: 'fuzz runs, advisories, expiry dates' },
  { key: 'restore', label: 'Restore drills', checks: 'Every backup proved by restoring it and reading it back', tags: 'backup schedules' },
  { key: 'scrap', label: 'Scrap review', checks: 'Problem reports turned into failing tests', tags: 'user reports and incidents' },
  { key: 'suspicion', label: 'Open suspicions', checks: 'Doubts a reviewer recorded without blocking: confirmed by a test, or dismissed with reasons another family accepts', tags: 'reviews and gates' },
];

export type TaskKind = 'fix-bug' | 'kill-mutant' | 'simplify' | 'patch-dependency' | 'renew' | 'restore-drill' | 'reproduce' | 'investigate' | 'check' | 'rule';

export interface KindSpec {
  readonly key: TaskKind;
  readonly station: readonly Station[];
  readonly does: string;
  /** What must be true before the change is accepted, on top of the gates every change passes. */
  readonly accepted: string;
  /** The lowest tier that may take it. */
  readonly from: Tier;
  /** Tokens a typical task of this kind reads and writes, for the budget's estimate before it starts. */
  readonly tokens: { readonly in: number; readonly out: number };
}

/** Task kinds, in the order a round takes them. Mutation work goes fix-bug, then kill-mutant, then simplify. */
export const KINDS: readonly KindSpec[] = [
  { key: 'fix-bug', station: ['gauges', 'wear', 'scrap'], does: 'A test that fails on the real code has found a real defect: fix the code, with the test attached', accepted: 'the attached test failed before the fix and passes after it', from: 'worker', tokens: { in: 40_000, out: 6_000 } },
  { key: 'kill-mutant', station: ['gauges'], does: 'A mutant survived: add the test that should have rejected it', accepted: 'the new test fails on the mutant and passes on the real code', from: 'worker', tokens: { in: 24_000, out: 4_000 } },
  { key: 'simplify', station: ['gauges'], does: 'An equivalent mutant points at code that does nothing: remove or tighten it', accepted: 'every test still passes, and a judge from another family agrees the mutant was equivalent', from: 'worker', tokens: { in: 24_000, out: 3_000 } },
  { key: 'patch-dependency', station: ['wear'], does: 'An advisory names a dependency in use: move to a fixed version', accepted: 'every test passes on the new version, and the advisory no longer matches', from: 'worker', tokens: { in: 20_000, out: 2_000 } },
  { key: 'renew', station: ['wear'], does: 'A certificate, key or token nears expiry: prepare its renewal', accepted: 'the renewal is proposed with its new expiry; any person-only act waits for a person', from: 'escalation', tokens: { in: 12_000, out: 2_000 } },
  { key: 'restore-drill', station: ['restore'], does: 'Restore a backup into a scratch place and read it back', accepted: 'the restored copy matches its recorded checksums and opens', from: 'worker', tokens: { in: 10_000, out: 1_500 } },
  { key: 'reproduce', station: ['scrap'], does: 'Turn a problem report into a test that fails for the reason reported', accepted: 'the test fails on the code the person used, for the reason they gave', from: 'worker', tokens: { in: 30_000, out: 4_000 } },
  { key: 'investigate', station: ['suspicion'], does: 'Settle a reviewer’s open suspicion: a failing test that confirms it, or reasons it is unfounded', accepted: 'a confirming test, or a dismissal another family agrees with', from: 'escalation', tokens: { in: 40_000, out: 4_000 } },
  { key: 'check', station: ['gauges', 'wear', 'restore', 'scrap', 'suspicion'], does: 'The independent check on every fix: the failing test came first, the fix makes it pass, nothing was weakened', accepted: 'the checker is of another family than the fixer, and finds nothing', from: 'worker', tokens: { in: 30_000, out: 1_500 } },
  { key: 'rule', station: ['gauges', 'suspicion'], does: 'Judge a claim another model made: that a mutant is equivalent, or that a suspicion is unfounded', accepted: 'recorded with its reasoning; counts only when the judge is of another family than the claimant', from: 'judgment', tokens: { in: 16_000, out: 2_000 } },
];

export interface Price {
  readonly in: number;
  readonly out: number;
  /** A higher rate for every token of a request whose input reaches the threshold. */
  readonly longContext?: { readonly from: number; readonly in: number; readonly out: number };
}

export interface CrewModel {
  readonly key: string;
  readonly name: string;
  readonly family: string;
  readonly tier: Tier;
  readonly price: Price;
}

export interface PriceTable {
  readonly schema: 'zthr-crew/1';
  /** The day the list was read. */
  readonly checked: string;
  readonly source: string;
  readonly where: string;
  readonly unit: string;
  readonly models: readonly CrewModel[];
}

/** The list the router reads. Re-read and re-dated when the list changes; a price is never assumed current. */
export const PRICES: PriceTable = {
  schema: 'zthr-crew/1',
  checked: '2026-11-27',
  source: 'https://cloud.google.com/model-garden/partner-models/pricing',
  where: 'Google Cloud Vertex AI partner models, global endpoint, list prices',
  unit: 'USD per 1M tokens',
  models: [
    { key: 'gpt-oss-120b', name: 'gpt-oss-120b', family: 'openai', tier: 'worker', price: { in: 0.09, out: 0.36 } },
    { key: 'haiku-5.5', name: 'Claude Haiku 5.5', family: 'anthropic', tier: 'worker', price: { in: 0.1, out: 0.5, longContext: { from: 200_000, in: 0.5, out: 2.5 } } },
    { key: 'qwen3-coder-480b', name: 'Qwen3-Coder-480B', family: 'qwen', tier: 'worker', price: { in: 0.22, out: 1.8 } },
    { key: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', family: 'deepseek', tier: 'worker', price: { in: 0.3, out: 1.2 } },
    { key: 'sonnet-5.5', name: 'Claude Sonnet 5.5', family: 'anthropic', tier: 'escalation', price: { in: 2, out: 10 } },
    { key: 'opus-5.5', name: 'Claude Opus 5.5', family: 'anthropic', tier: 'judgment', price: { in: 4, out: 20 } },
  ],
};

export const kind = (k: TaskKind) => KINDS.find((x) => x.key === k)!;
export const model = (key: string, t: PriceTable = PRICES) => t.models.find((m) => m.key === key);

/** Dollars for one request. At or above the long-context threshold every token is charged at the long rate. */
export function usd(p: Price, tokens: { in: number; out: number }): number {
  const r = p.longContext && tokens.in >= p.longContext.from ? p.longContext : p;
  return (tokens.in * r.in + tokens.out * r.out) / 1_000_000;
}

/** How one model has done at one kind of task: every attempt counted, accepted only when every gate passed. */
export interface Perf {
  readonly model: string;
  readonly kind: TaskKind;
  readonly attempts: number;
  readonly accepted: number;
  readonly usd: number;
}

/** A model is proven for a kind after enough attempts at a high enough rate; below it, it is out for that kind. */
export const BAR = { attempts: 5, rate: 0.8 } as const;

export type Standing = 'proven' | 'on trial' | 'below the bar';

export function standing(perf: readonly Perf[], key: string, k: TaskKind): Standing {
  const r = perf.find((p) => p.model === key && p.kind === k);
  if (!r || r.attempts < BAR.attempts) return 'on trial';
  return r.accepted / r.attempts >= BAR.rate ? 'proven' : 'below the bar';
}

export interface RouteAsk {
  readonly kind: TaskKind;
  readonly perf?: readonly Perf[];
  /** Models already tried on this task and failed: the next try goes a tier up. */
  readonly failed?: readonly string[];
  /** Families that may not take it: the author's, for a check or a ruling. */
  readonly notFamilies?: readonly string[];
  readonly spentToday?: number;
  readonly dailyUSD?: number;
  /** When a different family is required and no model of one sits at the kind's tier, take the highest tier that has one. */
  readonly fallDown?: boolean;
}

export type Route =
  | { readonly to: 'model'; readonly model: CrewModel; readonly standing: Exclude<Standing, 'below the bar'>; readonly estimate: number; readonly why: string }
  | { readonly to: 'held'; readonly why: string }
  | { readonly to: 'person'; readonly why: string };

/**
 * The cheapest model allowed to take the task that is proven good enough for it; failing any proven, the cheapest
 * not yet measured, on trial, so the table fills. A failure moves the task a tier up; past the top tier it goes to a
 * person. A task the day's budget cannot cover waits for the next shift: nothing is skipped.
 */
export function route(ask: RouteAsk, t: PriceTable = PRICES): Route {
  const k = kind(ask.kind);
  const perf = ask.perf ?? [];
  const failed = (ask.failed ?? []).map((f) => model(f, t)).filter((m): m is CrewModel => !!m);
  const floor = Math.max(rank(k.from), ...failed.map((m) => rank(m.tier) + 1));
  if (floor >= TIERS.length) return { to: 'person', why: `tried at every tier up to ${TIERS.at(-1)} and not accepted` };
  const allowed = (m: CrewModel) => !(ask.notFamilies ?? []).includes(m.family) && !failed.some((f) => f.key === m.key) && standing(perf, m.key, k.key) !== 'below the bar';
  let pool = t.models.filter((m) => rank(m.tier) >= floor && allowed(m));
  if (!pool.length && ask.fallDown && !failed.length) {
    const lower = t.models.filter((m) => rank(m.tier) < floor && allowed(m));
    const top = Math.max(-1, ...lower.map((m) => rank(m.tier)));
    pool = lower.filter((m) => rank(m.tier) === top);
  }
  if (!pool.length) return { to: 'person', why: `no model of an allowed family is left at the ${TIERS[floor]} tier or above` };
  const cost = (m: CrewModel) => usd(m.price, k.tokens);
  const byCost = [...pool].sort((a, b) => cost(a) - cost(b) || a.key.localeCompare(b.key));
  const proven = byCost.find((m) => standing(perf, m.key, k.key) === 'proven');
  const pick = proven ?? byCost[0]!;
  const estimate = Number(cost(pick).toFixed(6));
  if (ask.dailyUSD !== undefined && (ask.spentToday ?? 0) + estimate > ask.dailyUSD) return { to: 'held', why: `the day's budget of $${ask.dailyUSD.toFixed(2)} cannot cover it; it waits for the next shift` };
  return { to: 'model', model: pick, standing: proven ? 'proven' : 'on trial', estimate, why: proven ? `the cheapest proven for ${k.key}` : `no model is proven for ${k.key} at this tier yet; the cheapest is on trial` };
}

/** The independent check on a fix: a model of another family than the one that made it. */
export const checker = (fixer: string, perf: readonly Perf[] = [], t: PriceTable = PRICES): Route => route({ kind: 'check', perf, notFamilies: [model(fixer, t)?.family ?? ''] }, t);

/** The judge of an equivalence or a dismissal: the judgment tier when its family differs, otherwise the highest tier of another family. */
export const judge = (claimant: string, perf: readonly Perf[] = [], t: PriceTable = PRICES): Route => route({ kind: 'rule', perf, notFamilies: [model(claimant, t)?.family ?? ''], fallDown: true }, t);
