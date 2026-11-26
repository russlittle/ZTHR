/**
 * Cron watchdog. Every scheduled job checks in when it starts and when it ends. From the schedule and the
 * check-ins, the watchdog says which runs were missed, which ran too long, and which overlapped; and a lease lets
 * only one copy run at a time, expiring on its own if the holder dies.
 */

export interface Job {
  readonly name: string;
  /** Minutes between runs. */
  readonly everyMin: number;
  /** Minutes past each period the run may start late before it counts as missed. */
  readonly graceMin: number;
  /** Minutes a run may take. */
  readonly maxMin: number;
}

export interface CheckIn {
  readonly job: string;
  readonly run: string;
  readonly at: number;
  readonly kind: 'start' | 'end';
  readonly ok?: boolean;
}

export interface Finding {
  readonly job: string;
  readonly problem: 'missed' | 'overlong' | 'overlap' | 'failed' | 'never ran';
  readonly detail: string;
}

const MIN = 60_000;

export function check(jobs: readonly Job[], ins: readonly CheckIn[], now: number): Finding[] {
  const out: Finding[] = [];
  for (const j of jobs) {
    const mine = ins.filter((x) => x.job === j.name).sort((a, b) => a.at - b.at);
    const runs = [...new Set(mine.map((x) => x.run))].map((run) => ({ run, start: mine.find((x) => x.run === run && x.kind === 'start')?.at ?? null, end: mine.find((x) => x.run === run && x.kind === 'end') ?? null }));
    const starts = runs.filter((r) => r.start !== null).sort((a, b) => a.start! - b.start!);
    const last = starts.at(-1);
    if (!last) out.push({ job: j.name, problem: 'never ran', detail: 'no run has checked in' });
    else if (now - last.start! > (j.everyMin + j.graceMin) * MIN) out.push({ job: j.name, problem: 'missed', detail: `last started ${Math.round((now - last.start!) / MIN)} minutes ago; due every ${j.everyMin}` });
    for (const r of starts) {
      const end = r.end?.at ?? now;
      if (end - r.start! > j.maxMin * MIN) out.push({ job: j.name, problem: 'overlong', detail: `run ${r.run} ${r.end ? 'took' : 'has run'} ${Math.round((end - r.start!) / MIN)} minutes; allowed ${j.maxMin}` });
      if (r.end && r.end.ok === false) out.push({ job: j.name, problem: 'failed', detail: `run ${r.run} ended in failure` });
    }
    for (let i = 1; i < starts.length; i++) {
      const prev = starts[i - 1]!;
      const prevEnd = prev.end?.at ?? now;
      if (starts[i]!.start! < prevEnd) out.push({ job: j.name, problem: 'overlap', detail: `run ${starts[i]!.run} started while ${prev.run} was still running` });
    }
  }
  return out;
}

export interface Lease {
  readonly holder: string;
  readonly until: number;
}

/** Take the lease if it is free or expired, or renew it if this holder has it. Null: someone else holds it. */
export function acquire(current: Lease | null, holder: string, now: number, ttlMs: number): Lease | null {
  if (current && current.until > now && current.holder !== holder) return null;
  return { holder, until: now + ttlMs };
}
