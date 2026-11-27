/**
 * The delivery pipeline as data, so anyone can ask "where is my change?". A pipeline is a list of stages (review,
 * checks, staging, production); each change records events as it moves (entered, passed, failed, waiting on a
 * person). From the events the model answers where each change is, how long it has been there, what it is waiting
 * for, and the flow measures the industry uses: lead time, deployment frequency, change failure rate and time to
 * restore.
 */

export interface Stage {
  readonly id: string;
  readonly title: string;
  /** Hours after which a change sitting here is called stuck. */
  readonly stuckAfterHours?: number;
}

export type Kind = 'entered' | 'passed' | 'failed' | 'waiting' | 'rolledBack';

export interface Event {
  readonly change: string;
  readonly stage: string;
  readonly kind: Kind;
  readonly at: string;
  readonly note?: string;
}

export interface Where {
  readonly change: string;
  readonly stage: string;
  readonly title: string;
  readonly state: 'moving' | 'waiting' | 'failed' | 'done' | 'rolled back';
  readonly sinceHours: number;
  readonly stuck: boolean;
  readonly waitingFor?: string;
  readonly done: readonly string[];
  readonly next?: string;
}

export class Pipeline {
  readonly stages: readonly Stage[];
  private readonly events: Event[] = [];
  constructor(stages: readonly Stage[]) {
    if (!stages.length) throw new Error('a pipeline needs at least one stage');
    this.stages = stages;
  }

  record(e: Event): void {
    const i = this.stages.findIndex((s) => s.id === e.stage);
    if (i < 0) throw new Error(`no stage ${e.stage}`);
    const mine = this.events.filter((x) => x.change === e.change);
    if (e.kind === 'entered' && i > 0 && !mine.some((x) => x.stage === this.stages[i - 1]!.id && x.kind === 'passed')) throw new Error(`${e.change} cannot enter ${e.stage} before passing ${this.stages[i - 1]!.id}`);
    this.events.push(e);
  }

  where(change: string, now: Date): Where | undefined {
    const mine = this.events.filter((e) => e.change === change).sort((a, b) => a.at.localeCompare(b.at));
    const last = mine.at(-1);
    if (!last) return undefined;
    const i = this.stages.findIndex((s) => s.id === last.stage);
    const stage = this.stages[i]!;
    const lastProd = this.stages.at(-1)!.id;
    const done = this.stages.filter((s) => mine.some((e) => e.stage === s.id && e.kind === 'passed')).map((s) => s.id);
    const state: Where['state'] = last.kind === 'rolledBack' ? 'rolled back' : last.kind === 'failed' ? 'failed' : last.kind === 'waiting' ? 'waiting' : last.kind === 'passed' && last.stage === lastProd ? 'done' : 'moving';
    const sinceHours = (now.getTime() - Date.parse(last.at)) / 3_600_000;
    const next = state === 'done' ? undefined : last.kind === 'passed' ? this.stages[i + 1]?.id : stage.id;
    return { change, stage: stage.id, title: stage.title, state, sinceHours: Math.round(sinceHours * 10) / 10, stuck: state !== 'done' && state !== 'rolled back' && stage.stuckAfterHours !== undefined && sinceHours > stage.stuckAfterHours, ...(last.kind === 'waiting' && last.note ? { waitingFor: last.note } : {}), done, ...(next ? { next } : {}) };
  }

  /** Changes stuck anywhere, longest first. */
  stuck(now: Date): Where[] {
    return [...new Set(this.events.map((e) => e.change))].map((c) => this.where(c, now)!).filter((w) => w.stuck).sort((a, b) => b.sinceHours - a.sinceHours);
  }

  /** The four flow measures over a window. */
  measures(from: string, to: string): { deploys: number; perDay: number; leadTimeHoursMedian: number | null; changeFailureRate: number | null; restoreHoursMedian: number | null } {
    const prod = this.stages.at(-1)!.id;
    const first = this.stages[0]!.id;
    const inWin = (at: string) => at >= from && at < to;
    const deploys = this.events.filter((e) => e.stage === prod && e.kind === 'passed' && inWin(e.at));
    const median = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
    };
    const lead = deploys.map((d) => {
      const start = this.events.find((e) => e.change === d.change && e.stage === first && e.kind === 'entered');
      return start ? (Date.parse(d.at) - Date.parse(start.at)) / 3_600_000 : NaN;
    }).filter((x) => !Number.isNaN(x));
    const failed = deploys.filter((d) => this.events.some((e) => e.change === d.change && e.kind === 'rolledBack'));
    const restore = failed.map((d) => {
      const rb = this.events.find((e) => e.change === d.change && e.kind === 'rolledBack')!;
      return (Date.parse(rb.at) - Date.parse(d.at)) / 3_600_000;
    });
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    return { deploys: deploys.length, perDay: Math.round((deploys.length / days) * 100) / 100, leadTimeHoursMedian: median(lead), changeFailureRate: deploys.length ? failed.length / deploys.length : null, restoreHoursMedian: median(restore) };
  }
}
