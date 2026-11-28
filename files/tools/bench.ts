/**
 * The pure parts of the small-files benchmark: its options, its percentiles, and the verdict against limits.
 * The limits come from the control (a real Nextcloud on the same runner), so the benchmark is relative to the
 * reference on identical hardware rather than an absolute number from one machine.
 */

export interface LoadOptions {
  readonly files: number;
  readonly store: 'disk' | 'memory';
  readonly seed: number;
  readonly url?: string;
  readonly user?: string;
  readonly password?: string;
  /** The whole journey stops and fails after this many seconds, so it can never hang a build. */
  readonly timeLimit: number;
  /** Pass/fail limits; absent means not checked. */
  readonly maxSeconds?: number;
  readonly maxP95Ms?: number;
  readonly maxErrors: number;
  readonly out?: string;
}

export function parseLoadArgs(argv: readonly string[]): LoadOptions {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
        flags[a.slice(2)] = v;
        i++;
      }
    } else pos.push(a);
  }
  const known = new Set(['url', 'user', 'password', 'time-limit', 'max-seconds', 'max-p95-ms', 'max-errors', 'seed', 'out']);
  for (const k of Object.keys(flags)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
  const num = (k: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a number, not ${v}`);
    return n;
  };
  const files = num('files', pos[0]) ?? 25_000;
  if (!Number.isInteger(files) || files < 1) throw new Error('files must be a whole number above 0');
  const store = pos[1] ?? 'disk';
  if (store !== 'disk' && store !== 'memory') throw new Error(`store is disk or memory, not ${store}`);
  if (flags['url'] && (!flags['user'] || !flags['password'])) throw new Error('--url needs --user and --password');
  const o: LoadOptions = {
    files,
    store,
    seed: num('seed', flags['seed']) ?? 25_000,
    timeLimit: num('time-limit', flags['time-limit']) ?? 1800,
    maxErrors: num('max-errors', flags['max-errors']) ?? 0,
    ...(flags['url'] ? { url: flags['url'].replace(/\/+$/, ''), user: flags['user']!, password: flags['password']! } : {}),
    ...(flags['max-seconds'] !== undefined ? { maxSeconds: num('max-seconds', flags['max-seconds'])! } : {}),
    ...(flags['max-p95-ms'] !== undefined ? { maxP95Ms: num('max-p95-ms', flags['max-p95-ms'])! } : {}),
    ...(flags['out'] ? { out: flags['out'] } : {}),
  };
  return o;
}

/** The p-th percentile of sorted values, nearest-rank. */
export function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export interface LoadResult {
  readonly files: number;
  readonly target: string;
  readonly completed: number;
  readonly errors: number;
  readonly firstError?: string;
  readonly timedOut: boolean;
  readonly uploadSeconds: number;
  readonly perSecond: number;
  readonly p50ms: number;
  readonly p95ms: number;
  readonly p99ms: number;
  readonly fullListingSeconds: number;
  readonly unchangedRecheckMs: number;
}

/** Every limit the result breaks, in words; empty is a pass. */
export function verdict(r: LoadResult, o: Pick<LoadOptions, 'maxSeconds' | 'maxP95Ms' | 'maxErrors' | 'timeLimit'>): string[] {
  const out: string[] = [];
  if (r.timedOut) out.push(`stopped at the time limit of ${o.timeLimit} s with ${r.completed} of ${r.files} files written`);
  else if (r.completed < r.files) out.push(`only ${r.completed} of ${r.files} files written`);
  if (r.errors > o.maxErrors) out.push(`${r.errors} failed writes (limit ${o.maxErrors})${r.firstError ? `; first: ${r.firstError}` : ''}`);
  if (o.maxSeconds !== undefined && !(r.uploadSeconds <= o.maxSeconds)) out.push(`upload took ${r.uploadSeconds} s (limit ${o.maxSeconds} s)`);
  if (o.maxP95Ms !== undefined && !(r.p95ms <= o.maxP95Ms)) out.push(`p95 ${r.p95ms} ms (limit ${o.maxP95Ms} ms)`);
  return out;
}

/**
 * Limits for the candidate from the control's result: the candidate may take at most `factor` times the control's
 * upload time and p95. A control that did not finish gives no limit, and says so, rather than a made-up one.
 */
export function limitsFrom(control: LoadResult, factor: number): { maxSeconds?: number; maxP95Ms?: number; note: string } {
  if (control.timedOut || control.completed < control.files) return { note: `the control did not finish (${control.completed} of ${control.files}); no relative limit` };
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { maxSeconds: round(control.uploadSeconds * factor), maxP95Ms: round(control.p95ms * factor), note: `${factor} × the control: ${control.uploadSeconds} s, p95 ${control.p95ms} ms` };
}
