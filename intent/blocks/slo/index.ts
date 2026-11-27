/**
 * Service levels, alerts and incidents. An objective (99.9% of requests succeed over 30 days) gives an error
 * budget; alerts fire on burn rate across a long and a short window together (the multi-window method), so a brief
 * blip does not page anyone and a real outage pages fast. An incident has a timeline, a status for the public page,
 * and a postmortem that cannot be closed without a cause, an impact and actions with owners.
 */

export interface Objective {
  readonly name: string;
  /** e.g. 0.999 */
  readonly target: number;
  readonly windowDays: number;
}

export interface Window {
  readonly good: number;
  readonly total: number;
}

export function budget(o: Objective, w: Window): { allowedBad: number; bad: number; remaining: number; spent: number } {
  const allowedBad = (1 - o.target) * w.total;
  const bad = w.total - w.good;
  return { allowedBad, bad, remaining: allowedBad - bad, spent: allowedBad ? bad / allowedBad : bad ? Infinity : 0 };
}

/** How fast the budget is going: 1 spends exactly the budget over the window. */
export function burnRate(o: Objective, w: Window): number {
  if (!w.total) return 0;
  return (w.total - w.good) / w.total / (1 - o.target);
}

/** The usual pairs: page at 14.4x over 1h and 5m; page at 6x over 6h and 30m; ticket at 1x over 3d and 6h. */
export const POLICY = [
  { severity: 'page', rate: 14.4, long: '1h', short: '5m' },
  { severity: 'page', rate: 6, long: '6h', short: '30m' },
  { severity: 'ticket', rate: 1, long: '3d', short: '6h' },
] as const;

export function alerts(o: Objective, windows: Readonly<Record<string, Window>>): { severity: 'page' | 'ticket'; because: string }[] {
  const out: { severity: 'page' | 'ticket'; because: string }[] = [];
  for (const p of POLICY) {
    const l = windows[p.long];
    const s = windows[p.short];
    if (!l || !s) continue;
    const bl = burnRate(o, l);
    const bs = burnRate(o, s);
    if (bl >= p.rate && bs >= p.rate) out.push({ severity: p.severity, because: `${o.name} burning ${bl.toFixed(1)}x over ${p.long} and ${bs.toFixed(1)}x over ${p.short} (limit ${p.rate}x)` });
  }
  return out;
}

export type Status = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface Incident {
  readonly id: number;
  readonly title: string;
  severity: 1 | 2 | 3;
  status: Status;
  readonly started: string;
  resolved?: string;
  readonly timeline: { at: string; status: Status; note: string; publicNote?: string }[];
  postmortem?: Postmortem;
}

export interface Postmortem {
  readonly cause: string;
  readonly impact: string;
  readonly detection: string;
  readonly actions: readonly { what: string; owner: string; due: string }[];
}

export class Incidents {
  readonly list: Incident[] = [];
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }
  open(title: string, severity: 1 | 2 | 3, publicNote?: string): Incident {
    const at = this.now().toISOString();
    const i: Incident = { id: this.list.length + 1, title, severity, status: 'investigating', started: at, timeline: [{ at, status: 'investigating', note: 'opened', ...(publicNote ? { publicNote } : {}) }] };
    this.list.push(i);
    return i;
  }
  update(id: number, status: Status, note: string, publicNote?: string): Incident {
    const i = this.list[id - 1];
    if (!i) throw new Error(`no incident ${id}`);
    if (i.status === 'resolved') throw new Error('this incident is resolved; open a new one');
    const at = this.now().toISOString();
    i.status = status;
    i.timeline.push({ at, status, note, ...(publicNote ? { publicNote } : {}) });
    if (status === 'resolved') i.resolved = at;
    return i;
  }
  /** Minutes from start to resolution. */
  duration(i: Incident): number | undefined {
    return i.resolved ? (Date.parse(i.resolved) - Date.parse(i.started)) / 60_000 : undefined;
  }
  postmortem(id: number, p: Postmortem): void {
    const i = this.list[id - 1];
    if (!i) throw new Error(`no incident ${id}`);
    const missing = [!p.cause.trim() && 'a cause', !p.impact.trim() && 'the impact', !p.actions.length && 'at least one action', ...p.actions.filter((a) => !a.owner).map((a) => `an owner for "${a.what}"`)].filter(Boolean);
    if (missing.length) throw new Error(`a postmortem needs ${missing.join(', ')}`);
    i.postmortem = p;
  }
  /** Resolved severity 1 and 2 incidents still without a postmortem. */
  owed(): Incident[] {
    return this.list.filter((i) => i.status === 'resolved' && i.severity <= 2 && !i.postmortem);
  }
  /** What the public status page shows: only the public notes. */
  publicView(): { title: string; status: Status; updates: { at: string; note: string }[] }[] {
    return this.list.filter((i) => i.timeline.some((t) => t.publicNote)).map((i) => ({ title: i.title, status: i.status, updates: i.timeline.filter((t) => t.publicNote).map((t) => ({ at: t.at, note: t.publicNote! })) }));
  }
}
