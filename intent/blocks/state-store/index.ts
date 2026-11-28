/**
 * What every thing in the house is doing right now, and what it did before. A state machine in the shape Home
 * Assistant made familiar: each entity (an id like "sensor.kitchen_temp", lower-case domain and object id) has a
 * state string up to 255 characters and a bag of attributes (JSON, at most 16 KiB), with last_changed (when the
 * state string last differed), last_updated (when state or attributes last differed) and last_reported (when
 * anything was last said about it). Saying the same thing again changes only last_reported and publishes
 * nothing; a new attribute value publishes with last_changed untouched. Every real change is published on the
 * events block's hub as a CloudEvent "state.changed" (old and new state), removals as "state.removed". History
 * is kept per entity with compaction: full detail for a recent window, then one point per bucket, then dropped.
 * Statistics fold numeric states into time buckets with min, max, time-weighted mean, last, count and, for
 * meters that only go up, a running sum that survives resets. The small time-series helper this needs lives in
 * here (points, downsampling, rate). Time is injected. Out of scope: persistence to disk or a database,
 * long-term statistics units conversion, and templates or automations on top of states.
 */
import { Catalogue, Hub, type CloudEvent, type EventType } from '../events/index.ts';

export class StateError extends Error {
  constructor(why: string) {
    super(why);
  }
}

export type Attributes = Readonly<Record<string, unknown>>;

export interface State {
  readonly entityId: string;
  readonly state: string;
  readonly attributes: Attributes;
  readonly lastChanged: number;
  readonly lastUpdated: number;
  readonly lastReported: number;
}

export const STATE_EVENTS: readonly EventType[] = [
  { type: 'state.changed', version: 1, owner: 'state-store', description: 'An entity changed state or attributes.', fields: { entity_id: 'string', new_state: 'object' } },
  { type: 'state.removed', version: 1, owner: 'state-store', description: 'An entity was removed.', fields: { entity_id: 'string', old_state: 'object' } },
];

const ID_RE = /^[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/;
export const MAX_STATE = 255;
export const MAX_ATTRIBUTES_BYTES = 16 * 1024;

export const domainOf = (id: string) => id.slice(0, id.indexOf('.'));

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function cleanAttributes(a: Attributes): Attributes {
  const text = stable(a);
  if (Buffer.byteLength(text) > MAX_ATTRIBUTES_BYTES) throw new StateError('attributes are at most 16 KiB');
  const out = JSON.parse(text) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(a, '__proto__')) throw new StateError('an attribute may not be called __proto__');
  return Object.freeze(out);
}

// ---------------------------------------------------------------- time series

export interface Point {
  readonly t: number;
  readonly v: number;
}

/** A sorted run of numeric points. */
export class Timeseries {
  private pts: Point[] = [];
  add(t: number, v: number) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) throw new StateError('a point needs a finite time and value');
    let i = this.pts.length;
    while (i > 0 && this.pts[i - 1]!.t > t) i--;
    this.pts.splice(i, 0, { t, v });
  }
  get length() {
    return this.pts.length;
  }
  points(from = -Infinity, to = Infinity): Point[] {
    return this.pts.filter((p) => p.t >= from && p.t < to);
  }
  /** One point per bucket of `width` ms: the last value in each, stamped at the bucket start. */
  downsample(width: number, from = -Infinity, to = Infinity): Point[] {
    if (!(width > 0)) throw new StateError('a bucket width is positive');
    const out = new Map<number, Point>();
    for (const p of this.points(from, to)) out.set(Math.floor(p.t / width) * width, { t: Math.floor(p.t / width) * width, v: p.v });
    return [...out.values()];
  }
  /** Change per second between the first and last point in the range; undefined with fewer than two points. */
  rate(from = -Infinity, to = Infinity): number | undefined {
    const p = this.points(from, to);
    if (p.length < 2) return undefined;
    const a = p[0]!;
    const b = p[p.length - 1]!;
    return b.t === a.t ? undefined : ((b.v - a.v) / (b.t - a.t)) * 1000;
  }
  replace(pts: Point[]) {
    this.pts = pts;
  }
}

// ---------------------------------------------------------------- history

export interface HistoryPoint {
  readonly t: number;
  readonly state: string;
  readonly attributes: Attributes;
}

export interface CompactionPolicy {
  /** Keep every change newer than this many ms. */
  readonly fullFor: number;
  /** After that keep the last change in each bucket of this many ms. */
  readonly bucket: number;
  /** Drop everything older than this many ms. */
  readonly keepFor: number;
}

export class History {
  private readonly byEntity = new Map<string, HistoryPoint[]>();
  record(id: string, p: HistoryPoint) {
    const list = this.byEntity.get(id) ?? [];
    list.push(p);
    this.byEntity.set(id, list);
  }
  get(id: string, from = -Infinity, to = Infinity): HistoryPoint[] {
    return (this.byEntity.get(id) ?? []).filter((p) => p.t >= from && p.t < to);
  }
  /** The value at a moment: the last point at or before it. */
  at(id: string, t: number): HistoryPoint | undefined {
    const l = this.byEntity.get(id) ?? [];
    let hit: HistoryPoint | undefined;
    for (const p of l) if (p.t <= t) hit = p;
    return hit;
  }
  size(id?: string): number {
    if (id) return this.byEntity.get(id)?.length ?? 0;
    let n = 0;
    for (const l of this.byEntity.values()) n += l.length;
    return n;
  }
  /** Thins history as of `now`; returns how many points were removed. */
  compact(now: number, policy: CompactionPolicy): number {
    if (!(policy.bucket > 0) || policy.fullFor < 0 || policy.keepFor < policy.fullFor) throw new StateError('a compaction policy needs fullFor <= keepFor and a positive bucket');
    let removed = 0;
    for (const [id, list] of this.byEntity) {
      const out: HistoryPoint[] = [];
      let lastBucket: number | undefined;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        const age = now - p.t;
        if (age > policy.keepFor) continue;
        if (age <= policy.fullFor) {
          out.push(p);
          continue;
        }
        const b = Math.floor(p.t / policy.bucket);
        const next = list[i + 1];
        const nextOld = next && now - next.t > policy.fullFor && Math.floor(next.t / policy.bucket) === b;
        if (nextOld) continue; // a later point in the same bucket wins
        lastBucket = b;
        out.push(p);
      }
      void lastBucket;
      removed += list.length - out.length;
      if (out.length) this.byEntity.set(id, out);
      else this.byEntity.delete(id);
    }
    return removed;
  }
}

// ---------------------------------------------------------------- statistics

export interface Bucket {
  readonly start: number;
  readonly min: number;
  readonly max: number;
  /** Mean weighted by how long each value held. */
  readonly mean: number;
  readonly last: number;
  readonly count: number;
  /** For total_increasing meters: how much the meter grew in this bucket (resets count from zero). */
  readonly sum?: number;
}

export type StatKind = 'measurement' | 'total_increasing';

export function statistics(points: readonly HistoryPoint[], o: { from: number; to: number; width: number; kind?: StatKind }): Bucket[] {
  if (!(o.width > 0) || o.to <= o.from) throw new StateError('statistics need a positive bucket width and a range');
  const nums = points.map((p) => ({ t: p.t, v: Number(p.state), ok: p.state.trim() !== '' && Number.isFinite(Number(p.state)) })).filter((p) => p.ok);
  const buckets = new Map<number, { min: number; max: number; weighted: number; span: number; last: number; count: number; sum: number }>();
  let prevMeter: number | undefined;
  for (let i = 0; i < nums.length; i++) {
    const p = nums[i]!;
    const nextT = nums[i + 1]?.t ?? o.to;
    let delta = 0;
    if (o.kind === 'total_increasing') {
      delta = prevMeter === undefined ? 0 : p.v >= prevMeter ? p.v - prevMeter : p.v;
      prevMeter = p.v;
    }
    if (p.t >= o.to) break;
    // spread the time this value held across the buckets it touches
    const from = Math.max(p.t, o.from);
    const till = Math.min(nextT, o.to);
    const startB = Math.floor((p.t >= o.from ? p.t : o.from) / o.width) * o.width;
    const b = buckets.get(startB) ?? { min: Infinity, max: -Infinity, weighted: 0, span: 0, last: p.v, count: 0, sum: 0 };
    if (p.t >= o.from) {
      b.min = Math.min(b.min, p.v);
      b.max = Math.max(b.max, p.v);
      b.count++;
      b.last = p.v;
      b.sum += delta;
    }
    for (let s = Math.floor(from / o.width) * o.width; s < till; s += o.width) {
      const bb = s === startB ? b : (buckets.get(s) ?? { min: p.v, max: p.v, weighted: 0, span: 0, last: p.v, count: 0, sum: 0 });
      const lo = Math.max(from, s);
      const hi = Math.min(till, s + o.width);
      if (hi > lo) {
        bb.weighted += p.v * (hi - lo);
        bb.span += hi - lo;
        bb.min = Math.min(bb.min, p.v);
        bb.max = Math.max(bb.max, p.v);
        bb.last = p.v;
      }
      buckets.set(s, bb);
    }
    buckets.set(startB, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).filter(([, b]) => Number.isFinite(b.min)).map(([start, b]) => ({
    start, min: b.min, max: b.max, mean: b.span > 0 ? b.weighted / b.span : b.last, last: b.last, count: b.count,
    ...(o.kind === 'total_increasing' ? { sum: b.sum } : {}),
  }));
}

// ---------------------------------------------------------------- the state machine

export interface SetResult {
  readonly state: State;
  readonly changed: boolean;
  readonly updated: boolean;
}

export class StateMachine {
  private readonly states = new Map<string, State>();
  readonly hub: Hub;
  readonly history = new History();
  private readonly catalogue = new Catalogue(STATE_EVENTS);
  private readonly o: { now: () => number; source?: string; hub?: Hub };

  constructor(o: { now: () => number; source?: string; hub?: Hub }) {
    this.o = o;
    this.hub = o.hub ?? new Hub();
  }

  private emit(type: 'state.changed' | 'state.removed', id: string, data: Record<string, unknown>, at: number): CloudEvent {
    const e = this.catalogue.make(this.o.source ?? 'urn:zthr:state-store', type, data, { subject: id, now: new Date(at) });
    this.hub.publish(e);
    return e;
  }

  set(entityId: string, state: string, attributes: Attributes = {}, o: { force?: boolean } = {}): SetResult {
    if (!ID_RE.test(entityId)) throw new StateError(`${JSON.stringify(entityId.slice(0, 40))} is not an entity id like sensor.kitchen_temp`);
    if (typeof state !== 'string') throw new StateError('a state is a string');
    if (state.length > MAX_STATE) throw new StateError('a state is at most 255 characters');
    const attrs = cleanAttributes(attributes);
    const now = this.o.now();
    const old = this.states.get(entityId);
    const stateSame = old?.state === state;
    const attrsSame = old !== undefined && stable(old.attributes) === stable(attrs);
    if (old && stateSame && attrsSame && !o.force) {
      const same: State = { ...old, lastReported: now };
      this.states.set(entityId, same);
      return { state: same, changed: false, updated: false };
    }
    const next: State = {
      entityId, state, attributes: attrs,
      lastChanged: old && stateSame ? old.lastChanged : now,
      lastUpdated: now,
      lastReported: now,
    };
    this.states.set(entityId, next);
    this.history.record(entityId, { t: now, state, attributes: attrs });
    this.emit('state.changed', entityId, { entity_id: entityId, new_state: { ...next }, ...(old ? { old_state: { ...old } } : {}) }, now);
    return { state: next, changed: !old || !stateSame, updated: true };
  }

  get(entityId: string): State | undefined {
    return this.states.get(entityId);
  }

  all(domain?: string): State[] {
    return [...this.states.values()].filter((s) => !domain || domainOf(s.entityId) === domain).sort((a, b) => a.entityId.localeCompare(b.entityId));
  }

  /** Is the entity in this state? */
  is(entityId: string, ...states: string[]): boolean {
    const s = this.states.get(entityId);
    return !!s && states.includes(s.state);
  }

  remove(entityId: string): boolean {
    const old = this.states.get(entityId);
    if (!old) return false;
    this.states.delete(entityId);
    this.emit('state.removed', entityId, { entity_id: entityId, old_state: { ...old } }, this.o.now());
    return true;
  }

  count(domain?: string): number {
    return this.all(domain).length;
  }

  /** Calls `fn` for each change to entities matching the filter (an id, a domain with ".*", or a function). */
  onChange(filter: string | ((s: State) => boolean), fn: (e: { entityId: string; old?: State; next: State }) => void): () => void {
    const match = typeof filter === 'function' ? filter : filter.endsWith('.*') ? (s: State) => domainOf(s.entityId) === filter.slice(0, -2) : (s: State) => s.entityId === filter;
    return this.hub.subscribe((e) => e.type === 'state.changed', (e) => {
      const d = e.data as { new_state: State; old_state?: State };
      if (match(d.new_state)) fn({ entityId: d.new_state.entityId, ...(d.old_state ? { old: d.old_state } : {}), next: d.new_state });
    }).stop;
  }

  /** Numeric statistics for an entity from its history. */
  statistics(entityId: string, o: { from: number; to: number; width: number; kind?: StatKind }): Bucket[] {
    const before = this.history.at(entityId, o.from - 1);
    const pts = [...(before ? [{ ...before, t: Math.min(before.t, o.from) }] : []), ...this.history.get(entityId, o.from, o.to)];
    return statistics(pts, o);
  }

  /** The numeric history of an entity as a time series. */
  series(entityId: string): Timeseries {
    const ts = new Timeseries();
    for (const p of this.history.get(entityId)) {
      const n = Number(p.state);
      if (p.state.trim() !== '' && Number.isFinite(n)) ts.add(p.t, n);
    }
    return ts;
  }

  /** Thins history; see History.compact. */
  compact(policy: CompactionPolicy): number {
    return this.history.compact(this.o.now(), policy);
  }
}
