/**
 * Product analytics that respects consent. Nothing is recorded for someone who has not agreed; events carry a
 * pseudonymous id (a keyed hash, so the raw account id never reaches the store), only event names the product
 * declared and only properties on an allow list, so a stray email or free text cannot leak in through either. Funnels count how many people reach each step in order within
 * a time limit, with the drop at each step; journeys show the most common paths; counts below a threshold are
 * suppressed so a small group cannot be picked out.
 */
import { createHmac } from 'node:crypto';

export interface Event {
  readonly who: string;
  readonly name: string;
  readonly at: number;
  readonly props: Readonly<Record<string, string | number | boolean>>;
}

export interface AnalyticsOptions {
  readonly consented: (accountId: string) => boolean;
  readonly key: string;
  /**
   * Every event name that may be recorded. A name not on the list is dropped and counted (`unknownNames`), never
   * stored, since a name built from user input could carry personal data.
   */
  readonly events: readonly string[];
  /** Allowed property names, per event or for all events under "*". */
  readonly allow: Readonly<Record<string, readonly string[]>>;
  readonly now?: () => number;
}

export class Analytics {
  readonly events: Event[] = [];
  readonly dropped = { noConsent: 0, props: 0 };
  /** Events dropped because their name was not declared in `events`; the names themselves are not kept. */
  unknownNames = 0;
  private readonly o: AnalyticsOptions & { now: () => number };
  private readonly names: ReadonlySet<string>;

  constructor(o: AnalyticsOptions) {
    this.o = { now: Date.now, ...o };
    this.names = new Set(o.events);
  }

  pseudonym(accountId: string): string {
    return createHmac('sha256', this.o.key).update(accountId).digest('base64url').slice(0, 22);
  }

  track(accountId: string, name: string, props: Readonly<Record<string, unknown>> = {}): boolean {
    if (!this.o.consented(accountId)) {
      this.dropped.noConsent++;
      return false;
    }
    if (!this.names.has(name)) {
      this.unknownNames++;
      return false;
    }
    const list = (k: string) => (Object.hasOwn(this.o.allow, k) ? this.o.allow[k]! : []);
    const allowed = new Set([...list('*'), ...(name === '*' ? [] : list(name))]);
    const kept: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!allowed.has(k) || !['string', 'number', 'boolean'].includes(typeof v)) {
        this.dropped.props++;
        continue;
      }
      kept[k] = typeof v === 'string' ? v.slice(0, 100) : (v as number | boolean);
    }
    this.events.push({ who: this.pseudonym(accountId), name, at: this.o.now(), props: kept });
    return true;
  }

  /** Removes everything for a person who withdraws consent or leaves. */
  forget(accountId: string): number {
    const p = this.pseudonym(accountId);
    const before = this.events.length;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.who === p) this.events.splice(i, 1);
    return before - this.events.length;
  }

  private byPerson(): Map<string, Event[]> {
    const m = new Map<string, Event[]>();
    for (const e of [...this.events].sort((a, b) => a.at - b.at)) {
      const list = m.get(e.who);
      if (list) list.push(e);
      else m.set(e.who, [e]);
    }
    return m;
  }

  /** People reaching each step in order, each step within `withinMs` of the first. Counts under `min` show as null. */
  funnel(steps: readonly string[], withinMs: number, min = 5): { step: string; people: number | null; dropFromPrevious: number | null }[] {
    const reached = steps.map(() => 0);
    for (const evs of this.byPerson().values()) {
      let best = 0;
      for (let s = 0; s < evs.length; s++) {
        if (evs[s]!.name !== steps[0]) continue;
        let k = 1;
        let j = s + 1;
        for (; j < evs.length && k < steps.length; j++) {
          if (evs[j]!.at - evs[s]!.at > withinMs) break;
          if (evs[j]!.name === steps[k]) k++;
        }
        best = Math.max(best, k);
        // Every step reached, or the scan ran to the end of their events: a later start cannot do better.
        if (best === steps.length || j === evs.length) break;
      }
      for (let i = 0; i < best; i++) reached[i]!++;
    }
    return steps.map((step, i) => {
      const people = reached[i]! < min ? null : reached[i]!;
      const prev = i ? reached[i - 1]! : undefined;
      return { step, people, dropFromPrevious: i && prev! >= min && reached[i]! >= min ? Math.round((1 - reached[i]! / prev!) * 1000) / 10 : null };
    });
  }

  /** The most common paths of up to `length` events, from a starting event. */
  journeys(from: string, length: number, min = 5, top = 10): { path: string; people: number }[] {
    const counts = new Map<string, number>();
    for (const evs of this.byPerson().values()) {
      const i = evs.findIndex((e) => e.name === from);
      if (i < 0) continue;
      const path = evs.slice(i, i + length).map((e) => e.name).filter((n, j, a) => j === 0 || n !== a[j - 1]).join(' → ');
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n >= min).map(([path, people]) => ({ path, people })).sort((a, b) => b.people - a.people || a.path.localeCompare(b.path)).slice(0, top);
  }
}
