/**
 * Health and lifecycle: liveness (the process answers), readiness (every dependency it needs answers, within a
 * deadline), the build it is, and an orderly shutdown that stops taking work, lets what is in flight finish
 * within a grace period, and then stops. Maintenance mode makes the service read-only with a notice, ahead of
 * time and during the work; the environment badge says which environment a screen belongs to; and the status
 * model turns each component's checks into what a status page and an in-app banner show.
 */

export type Status = 'ok' | 'degraded' | 'down';

export interface Check {
  readonly name: string;
  /** Needed to serve at all (down when it fails) or only for part of the service (degraded). */
  readonly critical: boolean;
  readonly run: (signal: AbortSignal) => Promise<void>;
}

export interface Readiness {
  readonly status: Status;
  readonly checks: readonly { name: string; ok: boolean; ms: number; error?: string }[];
}

export async function readiness(checks: readonly Check[], deadlineMs = 2000): Promise<Readiness> {
  const results = await Promise.all(
    checks.map(async (c) => {
      const t = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), deadlineMs);
      try {
        await Promise.race([c.run(ac.signal), new Promise((_, no) => ac.signal.addEventListener('abort', () => no(new Error(`no answer within ${deadlineMs} ms`))))]);
        return { name: c.name, ok: true, ms: Math.round(performance.now() - t) };
      } catch (e) {
        return { name: c.name, ok: false, ms: Math.round(performance.now() - t), error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const failed = results.filter((r) => !r.ok).map((r) => checks.find((c) => c.name === r.name)!);
  const status: Status = failed.some((c) => c.critical) ? 'down' : failed.length ? 'degraded' : 'ok';
  return { status, checks: results };
}

/** The body for a version endpoint: what is running, so a deploy can be confirmed from outside. */
export const version = (o: { commit: string; built: string; release?: string }) => ({ commit: o.commit, built: o.built, ...(o.release ? { release: o.release } : {}) });

// ---------------------------------------------------------------- graceful shutdown

export class Drain {
  private inflight = 0;
  private stopping = false;
  private waiters: (() => void)[] = [];

  /** Whether new work should be taken: false once a shutdown has begun. */
  get accepting(): boolean {
    return !this.stopping;
  }

  get busy(): number {
    return this.inflight;
  }

  /** Wraps one unit of work; refuses new work once stopping (the caller answers 503 with Retry-After). */
  async track<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new ShuttingDown();
    this.inflight++;
    try {
      return await run();
    } finally {
      this.inflight--;
      if (this.inflight === 0) for (const w of this.waiters.splice(0)) w();
    }
  }

  /** Stops taking work and waits for what is in flight, up to `graceMs`; returns how many were cut off. */
  async stop(graceMs: number): Promise<number> {
    this.stopping = true;
    if (this.inflight === 0) return 0;
    await Promise.race([new Promise<void>((ok) => this.waiters.push(ok)), new Promise<void>((ok) => setTimeout(ok, graceMs).unref())]);
    return this.inflight;
  }
}

export class ShuttingDown extends Error {
  constructor() {
    super('the service is shutting down; try again in a moment');
  }
}

// ---------------------------------------------------------------- maintenance

export interface Maintenance {
  readonly from: number;
  readonly to: number;
  readonly message: string;
  /** Announced this long before it starts. */
  readonly noticeMs: number;
}

export type MaintenanceState = { readonly phase: 'none' } | { readonly phase: 'notice' | 'active'; readonly message: string; readonly from: number; readonly to: number };

export function maintenance(windows: readonly Maintenance[], now: number): MaintenanceState {
  const active = windows.find((w) => now >= w.from && now < w.to);
  if (active) return { phase: 'active', message: active.message, from: active.from, to: active.to };
  const soon = windows.filter((w) => now < w.from && now >= w.from - w.noticeMs).sort((a, b) => a.from - b.from)[0];
  return soon ? { phase: 'notice', message: soon.message, from: soon.from, to: soon.to } : { phase: 'none' };
}

/** During maintenance only reads are served; a change is refused with 503 and when to come back. */
export const allowedDuring = (state: MaintenanceState, method: string) => state.phase !== 'active' || ['GET', 'HEAD', 'OPTIONS', 'PROPFIND'].includes(method.toUpperCase());

// ---------------------------------------------------------------- environment badge

export type Environment = 'dev' | 'test' | 'uat' | 'production';

/** The badge every screen shows outside production; production shows none, so a badge always means "not real". */
export function badge(env: Environment, commit: string): { label: string; colour: string; text: string } | null {
  const c: Record<Exclude<Environment, 'production'>, [string, string]> = { dev: ['Development', '#6b3fa0'], test: ['Test', '#a05a00'], uat: ['UAT', '#00707a'] };
  if (env === 'production') return null;
  const [label, colour] = c[env];
  return { label, colour, text: `${label} · ${commit.slice(0, 7)}` };
}

// ---------------------------------------------------------------- status

export interface Component {
  readonly name: string;
  readonly status: Status;
}

export interface Incident {
  readonly title: string;
  readonly components: readonly string[];
  readonly status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  readonly updates: readonly { at: string; text: string }[];
}

/**
 * What a status page and an in-app banner show: each component's state (worst of its checks and any open
 * incident on it), the overall state, and the open incidents with their latest update.
 */
export function statusPage(components: readonly Component[], incidents: readonly Incident[]) {
  const open = incidents.filter((i) => i.status !== 'resolved');
  const rank: Record<Status, number> = { ok: 0, degraded: 1, down: 2 };
  const comps = components.map((c) => {
    const hit = open.some((i) => i.components.includes(c.name));
    const status: Status = hit && c.status === 'ok' ? 'degraded' : c.status;
    return { name: c.name, status };
  });
  const overall = comps.reduce<Status>((w, c) => (rank[c.status] > rank[w] ? c.status : w), 'ok');
  const words: Record<Status, string> = { ok: 'Everything is working', degraded: 'Some things are slow or unavailable', down: 'The service is down' };
  return { overall, headline: words[overall], components: comps, incidents: open.map((i) => ({ title: i.title, status: i.status, latest: i.updates.at(-1) ?? null })) };
}
