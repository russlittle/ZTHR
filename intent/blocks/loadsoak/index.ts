/**
 * Load and soak checks with pass/fail thresholds. A load run calls a target at a steady arrival rate (open model,
 * so a slow service does not quietly lower the load) for a duration, and reports throughput, error rate and latency
 * percentiles against limits. A soak repeats it for longer and fits a line through memory (or any gauge) over time,
 * failing on a steady climb even when every single sample looks fine: the shape of a leak.
 */

export interface Limits {
  readonly p95Ms?: number;
  readonly p99Ms?: number;
  readonly maxErrorRate?: number;
  readonly minRps?: number;
}

export interface Report {
  readonly sent: number;
  readonly ok: number;
  readonly errors: number;
  readonly rps: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly pass: boolean;
  readonly failures: readonly string[];
}

export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function judge(latencies: readonly number[], errors: number, seconds: number, limits: Limits): Report {
  const s = [...latencies].sort((a, b) => a - b);
  const sent = latencies.length + errors;
  const r = { sent, ok: latencies.length, errors, rps: seconds ? sent / seconds : 0, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99), max: s.at(-1) ?? 0 };
  const f: string[] = [];
  if (limits.p95Ms !== undefined && r.p95 > limits.p95Ms) f.push(`p95 ${r.p95} ms is over ${limits.p95Ms} ms`);
  if (limits.p99Ms !== undefined && r.p99 > limits.p99Ms) f.push(`p99 ${r.p99} ms is over ${limits.p99Ms} ms`);
  if (limits.maxErrorRate !== undefined && sent && errors / sent > limits.maxErrorRate) f.push(`${((errors / sent) * 100).toFixed(2)}% errors is over ${(limits.maxErrorRate * 100).toFixed(2)}%`);
  if (limits.minRps !== undefined && r.rps < limits.minRps) f.push(`${r.rps.toFixed(1)} requests a second is under ${limits.minRps}`);
  return { ...r, pass: f.length === 0, failures: f };
}

/**
 * Calls `target` at `rps` for `seconds`; calls start on schedule whether or not earlier ones have finished. The
 * reported rate is over the whole run, until the last call settles.
 */
export async function load(target: () => Promise<unknown>, o: { rps: number; seconds: number; limits: Limits; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<Report> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const total = Math.round(o.rps * o.seconds);
  const lat: number[] = [];
  let errors = 0;
  const start = now();
  const running: Promise<void>[] = [];
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / o.rps;
    const wait = due - now();
    if (wait > 0) await sleep(wait);
    const t0 = now();
    let call: Promise<unknown>;
    try {
      call = Promise.resolve(target());
    } catch (e) {
      call = Promise.reject(e);
    }
    running.push(
      call.then(
        () => void lat.push(now() - t0),
        () => void errors++,
      ),
    );
  }
  await Promise.all(running);
  // Throughput over the time the run really took: a service that cannot keep up stretches it past the plan.
  return judge(lat, errors, Math.max(o.seconds, (now() - start) / 1000), o.limits);
}

/** Least-squares slope of samples over time, per hour. */
export function slope(samples: readonly { at: number; value: number }[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  const mx = samples.reduce((s, x) => s + x.at, 0) / n;
  const my = samples.reduce((s, x) => s + x.value, 0) / n;
  const num = samples.reduce((s, x) => s + (x.at - mx) * (x.value - my), 0);
  const den = samples.reduce((s, x) => s + (x.at - mx) ** 2, 0);
  return den ? (num / den) * 3_600_000 : 0;
}

/** A soak verdict: fails if the gauge climbs faster than `maxPerHour`, with the fit's strength to rule out noise. */
export function soak(samples: readonly { at: number; value: number }[], maxPerHour: number): { perHour: number; r2: number; leak: boolean } {
  const perHour = slope(samples);
  const n = samples.length;
  const my = samples.reduce((s, x) => s + x.value, 0) / (n || 1);
  const mx = samples.reduce((s, x) => s + x.at, 0) / (n || 1);
  const b = perHour / 3_600_000;
  const ssTot = samples.reduce((s, x) => s + (x.value - my) ** 2, 0);
  const ssRes = samples.reduce((s, x) => s + (x.value - (my + b * (x.at - mx))) ** 2, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { perHour, r2, leak: perHour > maxPerHour && r2 > 0.5 };
}
