/**
 * Background work: a queue of jobs, each run by a handler for its kind, retried with jittered backoff when it
 * fails, and moved to a dead-letter list with its last error once its attempts are spent, where it waits for a
 * fix and a replay. A job with a key is enqueued once however often it is asked for. Long tasks report progress
 * and can be cancelled; backfills walk existing records in checkpointed batches that resume where they stopped
 * and can run dry first. Cron expressions schedule recurring jobs.
 */

export type JobState = 'waiting' | 'running' | 'done' | 'dead' | 'cancelled';

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly key?: string;
  state: JobState;
  attempts: number;
  readonly maxAttempts: number;
  runAt: number;
  progress?: { done: number; total?: number; note?: string };
  lastError?: string;
  result?: unknown;
  readonly created: number;
  finished?: number;
}

export interface Context {
  readonly job: Job;
  readonly signal: AbortSignal;
  progress(done: number, total?: number, note?: string): void;
}

export type Handler = (payload: unknown, ctx: Context) => Promise<unknown>;

export interface QueueOptions {
  readonly now?: () => number;
  /** Delay before retry n (1-based): base * 2^(n-1), capped, with full jitter. */
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly random?: () => number;
}

export class Queue {
  readonly jobs = new Map<string, Job>();
  private readonly handlers = new Map<string, Handler>();
  private readonly running = new Map<string, AbortController>();
  private readonly o: Required<QueueOptions>;
  private seq = 0;

  constructor(o: QueueOptions = {}) {
    this.o = { now: o.now ?? Date.now, baseMs: o.baseMs ?? 1000, maxMs: o.maxMs ?? 3_600_000, random: o.random ?? Math.random };
  }

  handle(kind: string, h: Handler): void {
    this.handlers.set(kind, h);
  }

  /** Adds a job; one with the same key that is not finished is returned instead of a second one. */
  enqueue(kind: string, payload: unknown, o: { key?: string; runAt?: number; maxAttempts?: number } = {}): Job {
    if (o.key) for (const j of this.jobs.values()) if (j.key === o.key && j.kind === kind && (j.state === 'waiting' || j.state === 'running')) return j;
    const j: Job = { id: `job-${++this.seq}`, kind, payload, ...(o.key ? { key: o.key } : {}), state: 'waiting', attempts: 0, maxAttempts: o.maxAttempts ?? 5, runAt: o.runAt ?? this.o.now(), created: this.o.now() };
    this.jobs.set(j.id, j);
    return j;
  }

  /** Jobs due now, oldest first. */
  due(): Job[] {
    const t = this.o.now();
    return [...this.jobs.values()].filter((j) => j.state === 'waiting' && j.runAt <= t).sort((a, b) => a.runAt - b.runAt || a.created - b.created);
  }

  /** Runs every due job once; returns how many ran. A worker calls this on a timer. */
  async tick(): Promise<number> {
    const list = this.due();
    for (const j of list) await this.run(j);
    return list.length;
  }

  private async run(j: Job): Promise<void> {
    const h = this.handlers.get(j.kind);
    if (!h) {
      j.state = 'dead';
      j.lastError = `no handler for ${j.kind}`;
      j.finished = this.o.now();
      return;
    }
    const ac = new AbortController();
    this.running.set(j.id, ac);
    j.state = 'running';
    j.attempts++;
    try {
      j.result = await h(j.payload, { job: j, signal: ac.signal, progress: (done, total, note) => (j.progress = { done, ...(total !== undefined ? { total } : {}), ...(note ? { note } : {}) }) });
      j.state = ac.signal.aborted ? 'cancelled' : 'done';
      j.finished = this.o.now();
    } catch (e) {
      j.lastError = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted) {
        j.state = 'cancelled';
        j.finished = this.o.now();
      } else if (j.attempts >= j.maxAttempts) {
        j.state = 'dead';
        j.finished = this.o.now();
      } else {
        const cap = Math.min(this.o.maxMs, this.o.baseMs * 2 ** (j.attempts - 1));
        j.runAt = this.o.now() + Math.floor(this.o.random() * cap);
        j.state = 'waiting';
      }
    } finally {
      this.running.delete(j.id);
    }
  }

  /** Cancels a waiting job, or asks a running one to stop through its signal. */
  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.state === 'waiting') {
      j.state = 'cancelled';
      j.finished = this.o.now();
      return true;
    }
    const ac = this.running.get(id);
    if (ac) {
      ac.abort();
      return true;
    }
    return false;
  }

  dead(): Job[] {
    return [...this.jobs.values()].filter((j) => j.state === 'dead');
  }

  /** Puts dead jobs back in the queue with fresh attempts, after a fix; returns how many. */
  replay(filter: (j: Job) => boolean = () => true): number {
    let n = 0;
    for (const j of this.dead().filter(filter)) {
      j.state = 'waiting';
      j.attempts = 0;
      j.runAt = this.o.now();
      delete j.finished;
      n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------- backfills

export interface Backfill<T> {
  /** The next batch after a checkpoint (undefined to start), and the checkpoint after it. */
  readonly page: (after: string | undefined, size: number) => Promise<{ items: T[]; next?: string }>;
  /** What would change for one item; null when nothing needs to. */
  readonly plan: (item: T) => Promise<unknown | null>;
  readonly apply: (item: T, change: unknown) => Promise<void>;
}

export interface BackfillRun {
  checkpoint?: string;
  seen: number;
  changed: number;
  failed: { item: string; error: string }[];
  finished: boolean;
}

/**
 * Walks every item in batches, saving the checkpoint after each, so a stopped run resumes where it was. A dry run
 * plans every change and applies none. An item that fails is recorded and the run carries on.
 */
export async function backfill<T>(b: Backfill<T>, o: { dryRun: boolean; size?: number; resume?: BackfillRun; save?: (r: BackfillRun) => Promise<void>; signal?: AbortSignal; idOf?: (t: T) => string }): Promise<BackfillRun> {
  const run: BackfillRun = o.resume ? { ...o.resume, failed: [...o.resume.failed] } : { seen: 0, changed: 0, failed: [], finished: false };
  for (;;) {
    if (o.signal?.aborted) return run;
    const { items, next } = await b.page(run.checkpoint, o.size ?? 500);
    for (const it of items) {
      run.seen++;
      try {
        const change = await b.plan(it);
        if (change !== null) {
          if (!o.dryRun) await b.apply(it, change);
          run.changed++;
        }
      } catch (e) {
        run.failed.push({ item: o.idOf ? o.idOf(it) : String(run.seen), error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (next !== undefined) run.checkpoint = next;
    else delete run.checkpoint;
    if (next === undefined) run.finished = true;
    await o.save?.(run);
    if (run.finished) return run;
  }
}

// ---------------------------------------------------------------- cron

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function field(spec: string, [lo, hi]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let a = lo;
    let b = hi;
    if (range !== '*') {
      const [x, y] = range!.split('-').map(Number);
      a = x!;
      b = y ?? (stepS ? hi : x!);
    }
    if (![a, b, step].every(Number.isInteger) || a < lo || b > hi || a > b || step < 1) throw new Error(`"${spec}" is not a valid cron field`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** A parsed five-field cron expression (minute hour day-of-month month day-of-week), in UTC. */
export function cron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('a cron expression has five fields: minute hour day month weekday');
  const [mi, h, dom, mo, dow] = parts.map((p, i) => field(p, RANGES[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const domAny = parts[2] === '*';
  const dowAny = parts[4] === '*';
  const matches = (d: Date) => {
    const dayOk = domAny && dowAny ? true : domAny ? dow.has(d.getUTCDay()) : dowAny ? dom.has(d.getUTCDate()) : dom.has(d.getUTCDate()) || dow.has(d.getUTCDay());
    return mi.has(d.getUTCMinutes()) && h.has(d.getUTCHours()) && mo.has(d.getUTCMonth() + 1) && dayOk;
  };
  return {
    matches,
    /** The first time strictly after `from` that it fires. */
    next(from: Date): Date {
      const d = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
      for (let i = 0; i < 366 * 24 * 60; i++) {
        if (matches(d)) return d;
        d.setTime(d.getTime() + 60_000);
      }
      throw new Error(`"${expr}" never fires`);
    },
  };
}
