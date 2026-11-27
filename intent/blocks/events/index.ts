/**
 * Events in CloudEvents 1.0 form, from a catalogue: each event type is declared with its owner, a description, a
 * version and the fields its data must carry, so nothing is published that the catalogue does not describe. A hub
 * fans events out to subscribers (in-process, or to a server-sent-events stream for real-time screens) with a
 * replay buffer so a reconnecting client catches up from its last id. Presence says who is looking at what now.
 */
import { randomUUID } from 'node:crypto';

export interface EventType {
  readonly type: string;
  readonly version: number;
  readonly owner: string;
  readonly description: string;
  readonly fields: Readonly<Record<string, 'string' | 'number' | 'boolean' | 'object'>>;
}

export interface CloudEvent {
  readonly specversion: '1.0';
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly time: string;
  readonly subject?: string;
  readonly datacontenttype: 'application/json';
  readonly dataschema: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export class Catalogue {
  private readonly types = new Map<string, EventType>();
  constructor(list: readonly EventType[]) {
    for (const t of list) {
      if (!/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(t.type)) throw new Error(`${t.type}: event types are lower-case and dotted, like files.file.created`);
      this.types.set(t.type, t);
    }
  }
  get(type: string): EventType | undefined {
    return this.types.get(type);
  }
  list(): EventType[] {
    return [...this.types.values()].sort((a, b) => a.type.localeCompare(b.type));
  }
  make(source: string, type: string, data: Record<string, unknown>, o: { subject?: string; now?: Date } = {}): CloudEvent {
    const t = this.types.get(type);
    if (!t) throw new Error(`${type} is not in the event catalogue`);
    const problems = Object.entries(t.fields).filter(([k, kind]) => typeof data[k] !== kind || data[k] === null).map(([k, kind]) => `${k} must be a ${kind}`);
    if (problems.length) throw new Error(`${type}: ${problems.join(', ')}`);
    return { specversion: '1.0', id: randomUUID(), source, type, time: (o.now ?? new Date()).toISOString(), ...(o.subject ? { subject: o.subject } : {}), datacontenttype: 'application/json', dataschema: `urn:zthr:events:${type}:v${t.version}`, data };
  }
}

export class Hub {
  private readonly subs = new Set<{ match: (e: CloudEvent) => boolean; fn: (e: CloudEvent, seq: number) => void }>();
  private readonly buffer: { seq: number; e: CloudEvent }[] = [];
  private seq = 0;
  private readonly keep: number;
  constructor(keep = 1000) {
    this.keep = keep;
  }

  publish(e: CloudEvent): number {
    const seq = ++this.seq;
    this.buffer.push({ seq, e });
    if (this.buffer.length > this.keep) this.buffer.shift();
    for (const s of this.subs)
      if (s.match(e))
        try {
          s.fn(e, seq);
        } catch {
          /* one bad subscriber does not stop the rest */
        }
    return seq;
  }

  /** Subscribes, first replaying anything after `after` still in the buffer. Returns the unsubscribe function. */
  subscribe(match: (e: CloudEvent) => boolean, fn: (e: CloudEvent, seq: number) => void, after?: number): { stop: () => void; missed: boolean } {
    let missed = false;
    if (after !== undefined) {
      const first = this.buffer[0]?.seq ?? this.seq + 1;
      missed = after + 1 < first && after < this.seq;
      for (const b of this.buffer) if (b.seq > after && match(b.e)) fn(b.e, b.seq);
    }
    const s = { match, fn };
    this.subs.add(s);
    return { stop: () => void this.subs.delete(s), missed };
  }
}

/** One server-sent-events frame. */
export const sse = (e: CloudEvent, seq: number) => `id: ${seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

export class Presence {
  private readonly seen = new Map<string, Map<string, { at: number; doing?: string }>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 30_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }
  /** Called by each open screen every few seconds. */
  beat(who: string, where: string, doing?: string): void {
    const m = this.seen.get(where) ?? new Map();
    m.set(who, { at: this.now(), ...(doing ? { doing } : {}) });
    this.seen.set(where, m);
  }
  leave(who: string, where: string): void {
    this.seen.get(where)?.delete(who);
  }
  here(where: string, except?: string): { who: string; doing?: string }[] {
    const m = this.seen.get(where);
    if (!m) return [];
    const out: { who: string; doing?: string }[] = [];
    for (const [who, v] of m) {
      if (this.now() - v.at > this.ttlMs) m.delete(who);
      else if (who !== except) out.push({ who, ...(v.doing ? { doing: v.doing } : {}) });
    }
    return out.sort((a, b) => a.who.localeCompare(b.who));
  }
}
