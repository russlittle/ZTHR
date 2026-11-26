import type { EvidenceStore, Price } from './store.js';

/**
 * The section 16 measures as queries over the evidence store. Every measure
 * reports its denominator. A measure with no data returns `undefined`, which
 * the evidence page shows as "not measured", never as zero.
 */
export interface Ratio {
  numerator: number;
  denominator: number;
  value: number | undefined;
}

const ratio = (n: number, d: number): Ratio => ({ numerator: n, denominator: d, value: d === 0 ? undefined : n / d });

export interface JourneyRunData {
  journey: string;
  persona?: string;
  delight?: string;
  phase?: number;
  status: 'pass' | 'fail' | 'unknown';
  release?: string;
}

/** Intent completion: share of journeys whose latest run passed. Unknown counts as not passed. */
export function intentCompletion(store: EvidenceStore, filter?: { phase?: number; release?: string }): Ratio & { byPersona: Record<string, Ratio> } {
  const latest = new Map<string, JourneyRunData>();
  for (const e of store.events('journey_run')) {
    const d = e.data as unknown as JourneyRunData;
    if (filter?.release && d.release !== filter.release) continue;
    if (filter?.phase !== undefined && d.phase !== undefined && d.phase > filter.phase) continue;
    latest.set(d.journey, d);
  }
  const runs = [...latest.values()];
  const byPersonaCounts = new Map<string, { n: number; d: number }>();
  for (const r of runs) {
    if (!r.persona) continue;
    const c = byPersonaCounts.get(r.persona) ?? { n: 0, d: 0 };
    c.d += 1;
    if (r.status === 'pass') c.n += 1;
    byPersonaCounts.set(r.persona, c);
  }
  const byPersona: Record<string, Ratio> = {};
  for (const [p, c] of byPersonaCounts) byPersona[p] = ratio(c.n, c.d);
  return { ...ratio(runs.filter((r) => r.status === 'pass').length, runs.length), byPersona };
}

/** Revision rate: rejected candidates per accepted change. */
export function revisionRate(store: EvidenceStore): Ratio {
  const evs = store.events('candidate');
  const accepted = evs.filter((e) => e.data.outcome === 'accepted').length;
  const rejected = evs.filter((e) => e.data.outcome === 'rejected').length;
  return ratio(rejected, accepted);
}

export function priceOn(prices: Price[], model: string, at: string): Price | undefined {
  return prices
    .filter((p) => p.model === model && p.effectiveFrom <= at)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
}

const callCost = (p: Price, input: number, output: number, cached: number) =>
  (input * p.inputPerMTok + output * p.outputPerMTok + cached * (p.cachedPerMTok ?? 0)) / 1_000_000;

export interface CostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Prices on the day each call was made. Undefined if any call has no price. */
  asPaid: number | undefined;
  /** Same tokens at the newest price for each model. */
  atToday: number | undefined;
  unpricedModels: string[];
}

export function costSummary(store: EvidenceStore, filter?: { purpose?: string; studentMonth?: string }): CostSummary {
  const prices = store.prices();
  const calls = store.modelCalls().filter(
    (c) => (!filter?.purpose || c.purpose === filter.purpose) && (!filter?.studentMonth || c.studentMonth === filter.studentMonth),
  );
  let asPaid = 0;
  let atToday = 0;
  const unpriced = new Set<string>();
  for (const c of calls) {
    const then = priceOn(prices, c.model, c.at);
    const now = priceOn(prices, c.model, '9999-12-31');
    if (!then || !now) {
      unpriced.add(c.model);
      continue;
    }
    asPaid += callCost(then, c.inputTokens, c.outputTokens, c.cachedTokens);
    atToday += callCost(now, c.inputTokens, c.outputTokens, c.cachedTokens);
  }
  const complete = unpriced.size === 0 && calls.length > 0;
  return {
    calls: calls.length,
    inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
    outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
    asPaid: complete ? asPaid : calls.length === 0 ? 0 : undefined,
    atToday: complete ? atToday : calls.length === 0 ? 0 : undefined,
    unpricedModels: [...unpriced],
  };
}

/** Median and tail of a list of durations or counts. */
export function distribution(values: number[]): { n: number; median: number | undefined; p90: number | undefined } {
  if (values.length === 0) return { n: 0, median: undefined, p90: undefined };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
  return { n: s.length, median: at(0.5), p90: at(0.9) };
}
