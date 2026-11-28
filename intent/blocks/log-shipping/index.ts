/**
 * Getting logs and traces off the machine without ever hurting the thing that writes them, and without hiding what
 * was lost. Three parts:
 *
 * - `Batcher`: a bounded queue that groups entries into batches by count, bytes and age. When the queue is full it
 *   drops (the oldest by default, the newest if asked) and counts what it dropped and why; a batch that fails to send
 *   is retried with backoff up to a limit and then dropped and counted; nothing blocks the caller. `lossRecord()`
 *   turns the unreported drops into one log entry ("dropped 12 entries: queue-full") that is shipped like any other,
 *   so the loss shows up where the logs are read. Time is passed in, never read.
 * - Loki push shape: `labelsFor` applies the label rules (names match [a-zA-Z_][a-zA-Z0-9_]*, values are short and
 *   not empty, at most N labels, only the allowed keys, and a per-label cap on distinct values so one request id can
 *   never become a label; what is refused moves to structured metadata), and `lokiPush` groups entries into streams
 *   by label set with each stream in time order and nanosecond timestamps as strings, as Loki requires.
 * - OTLP JSON shape: `otlpLogs` and `otlpSpans` write the OTLP/HTTP JSON bodies (resource, scope, records with
 *   64-bit numbers as strings, attributes as typed values, severity numbers, hex trace and span ids), taking the
 *   spans of the observe block. Attributes and bodies pass through observe's `redact`, so nothing sensitive leaves.
 *
 * Out of scope: the HTTP call itself (the caller sends the batch; this gives it the body and says how it went),
 * gzip, and protobuf.
 */
import { redact } from '../observe/index.ts';
import type { SpanRecord, Severity } from '../observe/index.ts';

export class ShipError extends Error {}

export interface LogEntry {
  /** Epoch milliseconds. */
  readonly time: number;
  /** Extra nanoseconds within the millisecond, 0 to 999999, to keep order for entries in the same millisecond. */
  readonly nanos?: number;
  readonly severity: Severity;
  readonly message: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly trace?: string;
  readonly span?: string;
}

export type DropReason = 'queue-full' | 'too-large' | 'send-failed' | 'invalid';
export interface Stats {
  readonly accepted: number;
  readonly sent: number;
  readonly dropped: Readonly<Record<DropReason, number>>;
  readonly droppedTotal: number;
  readonly queued: number;
  readonly queuedBytes: number;
  readonly inFlight: number;
  readonly retries: number;
}

export interface BatcherOptions {
  readonly maxBatchItems?: number;
  readonly maxBatchBytes?: number;
  /** A batch is due when its oldest entry is this old, even if it is small. */
  readonly maxAgeMs?: number;
  readonly maxQueueItems?: number;
  readonly maxQueueBytes?: number;
  /** Which to drop when full. */
  readonly dropPolicy?: 'oldest' | 'newest';
  readonly maxAttempts?: number;
  readonly backoffMs?: (attempt: number) => number;
  /** One entry larger than this is dropped as too-large. */
  readonly maxItemBytes?: number;
}

interface Queued<T> {
  readonly item: T;
  readonly bytes: number;
  readonly at: number;
}
const DROP_REASONS: DropReason[] = ['queue-full', 'too-large', 'send-failed', 'invalid'];

export class Batcher<T> {
  private q: Queued<T>[] = [];
  private queuedBytes = 0;
  private accepted = 0;
  private sent = 0;
  private retries = 0;
  private inFlight = 0;
  private readonly dropped: Record<DropReason, number> = { 'queue-full': 0, 'too-large': 0, 'send-failed': 0, invalid: 0 };
  private reported: Record<DropReason, number> = { 'queue-full': 0, 'too-large': 0, 'send-failed': 0, invalid: 0 };
  private attempts = 0;
  private notBefore = 0;
  private readonly o: Required<Omit<BatcherOptions, 'backoffMs'>> & { backoffMs: (n: number) => number };
  private readonly sizeOf: (item: T) => number;
  constructor(o: BatcherOptions = {}, sizeOf: (item: T) => number = (i) => JSON.stringify(i).length) {
    this.sizeOf = sizeOf;
    this.o = {
      maxBatchItems: o.maxBatchItems ?? 500,
      maxBatchBytes: o.maxBatchBytes ?? 1_000_000,
      maxAgeMs: o.maxAgeMs ?? 5000,
      maxQueueItems: o.maxQueueItems ?? 10_000,
      maxQueueBytes: o.maxQueueBytes ?? 20_000_000,
      dropPolicy: o.dropPolicy ?? 'oldest',
      maxAttempts: o.maxAttempts ?? 5,
      backoffMs: o.backoffMs ?? ((n) => Math.min(30_000, 500 * 2 ** (n - 1))),
      maxItemBytes: o.maxItemBytes ?? 256_000,
    };
    if (this.o.maxBatchItems < 1 || this.o.maxQueueItems < 1 || this.o.maxBatchBytes < 1) throw new ShipError('batch and queue sizes are at least 1');
  }

  private drop(reason: DropReason, n = 1): void {
    this.dropped[reason] += n;
  }

  /** Never throws and never waits. Returns whether this entry was accepted (an older one may have been dropped for it). */
  add(item: T, now: number): boolean {
    let bytes: number;
    try {
      bytes = this.sizeOf(item);
    } catch {
      this.drop('invalid');
      return false;
    }
    if (!Number.isFinite(bytes) || bytes < 0) {
      this.drop('invalid');
      return false;
    }
    if (bytes > this.o.maxItemBytes || bytes > this.o.maxBatchBytes) {
      this.drop('too-large');
      return false;
    }
    const full = () => this.q.length >= this.o.maxQueueItems || this.queuedBytes + bytes > this.o.maxQueueBytes;
    if (full() && this.o.dropPolicy === 'newest') {
      this.drop('queue-full');
      return false;
    }
    while (full() && this.q.length) {
      const old = this.q.shift()!;
      this.queuedBytes -= old.bytes;
      this.drop('queue-full');
    }
    this.q.push({ item, bytes, at: now });
    this.queuedBytes += bytes;
    this.accepted++;
    return true;
  }

  /** Whether a batch should go now. */
  due(now: number): boolean {
    if (!this.q.length || now < this.notBefore) return false;
    if (this.q.length >= this.o.maxBatchItems || this.queuedBytes >= this.o.maxBatchBytes) return true;
    return now - this.q[0]!.at >= this.o.maxAgeMs;
  }

  private take(): Queued<T>[] {
    const batch: Queued<T>[] = [];
    let bytes = 0;
    while (this.q.length && batch.length < this.o.maxBatchItems && (batch.length === 0 || bytes + this.q[0]!.bytes <= this.o.maxBatchBytes)) {
      const x = this.q.shift()!;
      bytes += x.bytes;
      this.queuedBytes -= x.bytes;
      batch.push(x);
    }
    return batch;
  }

  /**
   * Sends one batch if one is due (or `force`). A failed send puts the batch back at the front and waits out the
   * backoff; after `maxAttempts` the batch is dropped and counted. Returns what happened.
   */
  async flush(send: (batch: readonly T[]) => Promise<void>, now: number, force = false): Promise<'sent' | 'idle' | 'retry' | 'dropped'> {
    if (!force && !this.due(now)) return 'idle';
    if (!this.q.length || (now < this.notBefore && !force)) return 'idle';
    const batch = this.take();
    this.inFlight = batch.length;
    try {
      await send(batch.map((b) => b.item));
      this.sent += batch.length;
      this.attempts = 0;
      this.notBefore = 0;
      return 'sent';
    } catch {
      this.attempts++;
      if (this.attempts >= this.o.maxAttempts) {
        this.drop('send-failed', batch.length);
        this.attempts = 0;
        this.notBefore = 0;
        return 'dropped';
      }
      this.retries++;
      this.q.unshift(...batch);
      this.queuedBytes += batch.reduce((n, b) => n + b.bytes, 0);
      // The queue may now be over its bounds; the oldest are the ones put back, so trim from the back under 'newest'.
      while (this.q.length > this.o.maxQueueItems) {
        const gone = this.o.dropPolicy === 'oldest' ? this.q.shift()! : this.q.pop()!;
        this.queuedBytes -= gone.bytes;
        this.drop('queue-full');
      }
      this.notBefore = now + this.o.backoffMs(this.attempts);
      return 'retry';
    } finally {
      this.inFlight = 0;
    }
  }

  /** Sends everything left, ignoring age and backoff, stopping at the first batch that cannot be sent after its attempts. */
  async drain(send: (batch: readonly T[]) => Promise<void>, now: number): Promise<void> {
    let guard = 0;
    while (this.q.length && guard++ < 100_000) {
      const r = await this.flush(send, now, true);
      if (r === 'retry') {
        // Retry at once while attempts remain: draining is shutdown, not steady state.
        this.notBefore = 0;
      }
    }
  }

  stats(): Stats {
    const dropped = { ...this.dropped };
    return { accepted: this.accepted, sent: this.sent, dropped, droppedTotal: DROP_REASONS.reduce((n, r) => n + dropped[r], 0), queued: this.q.length, queuedBytes: this.queuedBytes, inFlight: this.inFlight, retries: this.retries };
  }

  /** Entries that were accepted but are neither sent, queued nor dropped: always 0 unless there is a bug. */
  unaccounted(): number {
    const s = this.stats();
    return s.accepted - s.sent - s.queued - (s.droppedTotal - this.droppedBeforeAccept());
  }
  private droppedBeforeAccept(): number {
    // too-large and invalid entries are never accepted; queue-full may be either an accepted older entry or a refused new one; send-failed are accepted.
    return this.dropped['too-large'] + this.dropped.invalid + this.refusedNewest;
  }
  private get refusedNewest(): number {
    return this.o.dropPolicy === 'newest' ? this.dropped['queue-full'] : 0;
  }

  /**
   * One log entry saying how many entries were dropped since the last call and why, or undefined if none were.
   * Ship it with the rest so the loss is visible where the logs are read.
   */
  lossRecord(now: number, labels: Readonly<Record<string, string>> = {}): LogEntry | undefined {
    const delta = DROP_REASONS.map((r) => [r, this.dropped[r] - this.reported[r]] as const).filter(([, n]) => n > 0);
    if (!delta.length) return undefined;
    this.reported = { ...this.dropped };
    const total = delta.reduce((n, [, c]) => n + c, 0);
    return { time: now, severity: 'WARNING', message: `log shipping dropped ${total} ${total === 1 ? 'entry' : 'entries'}: ${delta.map(([r, c]) => `${r}=${c}`).join(', ')}`, labels: { ...labels, kind: 'log-loss' }, fields: Object.fromEntries(delta) };
  }
}

// -------------------------------------------------------------------------------------------------------------
// Labels and Loki

export interface LabelRules {
  /** The only keys that may be labels. */
  readonly allow: readonly string[];
  readonly maxLabels?: number;
  readonly maxValueLength?: number;
  /** Distinct values one label may take before further new values are refused as labels. */
  readonly maxDistinct?: number;
}
export class LabelGuard {
  private readonly seen = new Map<string, Set<string>>();
  readonly rules: Required<LabelRules>;
  constructor(rules: LabelRules) {
    this.rules = { allow: rules.allow, maxLabels: rules.maxLabels ?? 15, maxValueLength: rules.maxValueLength ?? 256, maxDistinct: rules.maxDistinct ?? 100 };
    for (const k of rules.allow) if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) || k.startsWith('__')) throw new ShipError(`${JSON.stringify(k)} cannot be a label name`);
    if (this.rules.allow.length > this.rules.maxLabels) throw new ShipError('more allowed labels than the maximum');
  }
  /** The labels that pass the rules, and the rest, which belong in structured metadata. */
  split(all: Readonly<Record<string, string>>): { labels: Record<string, string>; rest: Record<string, string>; refused: { key: string; why: string }[] } {
    const labels: Record<string, string> = {};
    const rest: Record<string, string> = {};
    const refused: { key: string; why: string }[] = [];
    for (const k of Object.keys(all).sort()) {
      const val = all[k]!;
      const no = (why: string) => {
        refused.push({ key: k, why });
        rest[k] = val;
      };
      if (!this.rules.allow.includes(k)) no('not an allowed label');
      else if (typeof val !== 'string' || val === '') no('empty value');
      else if ([...val].length > this.rules.maxValueLength) no('value too long');
      else if (/[\u0000-\u001f]/.test(val)) no('control characters');
      else {
        const set = this.seen.get(k) ?? this.seen.set(k, new Set()).get(k)!;
        if (!set.has(val) && set.size >= this.rules.maxDistinct) no('too many distinct values');
        else {
          set.add(val);
          labels[k] = val;
        }
      }
    }
    return { labels, rest, refused };
  }
  distinct(key: string): number {
    return this.seen.get(key)?.size ?? 0;
  }
}

const NS = (e: { time: number; nanos?: number }): bigint => {
  if (!Number.isFinite(e.time) || e.time < 0) throw new ShipError('an entry has no valid time');
  const n = e.nanos ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new ShipError('nanos is 0 to 999999');
  return BigInt(Math.floor(e.time)) * 1_000_000n + BigInt(n);
};

const SEVERITY_NUMBER: Readonly<Record<Severity, number>> = { DEBUG: 5, INFO: 9, NOTICE: 10, WARNING: 13, ERROR: 17, CRITICAL: 21 };
export const severityNumber = (s: Severity): number => SEVERITY_NUMBER[s];

export interface LokiPush {
  readonly streams: { readonly stream: Record<string, string>; readonly values: ([string, string] | [string, string, Record<string, string>])[] }[];
}

function line(e: LogEntry, redactKeys: readonly string[]): string {
  const msg = String(redact(e.message));
  const fields = e.fields && Object.keys(e.fields).length ? (redact(e.fields, redactKeys) as Record<string, unknown>) : undefined;
  return fields ? `${msg} ${JSON.stringify(fields)}` : msg;
}

/** The Loki push body. Streams are by label set; within a stream entries are in time order; the line is redacted. */
export function lokiPush(entries: readonly LogEntry[], guard: LabelGuard, o: { staticLabels?: Readonly<Record<string, string>>; redactKeys?: readonly string[] } = {}): LokiPush {
  const streams = new Map<string, { stream: Record<string, string>; values: { ns: bigint; v: [string, string] | [string, string, Record<string, string>] }[] }>();
  for (const e of entries) {
    const all: Record<string, string> = { ...(o.staticLabels ?? {}), ...(e.labels ?? {}), level: e.severity.toLowerCase() };
    const { labels, rest } = guard.split(all);
    const meta: Record<string, string> = { ...rest };
    if (e.trace) meta.trace_id = e.trace;
    if (e.span) meta.span_id = e.span;
    const ns = NS(e);
    const key = JSON.stringify(Object.entries(labels));
    const s = streams.get(key) ?? streams.set(key, { stream: labels, values: [] }).get(key)!;
    const text = line(e, o.redactKeys ?? []);
    s.values.push({ ns, v: Object.keys(meta).length ? [ns.toString(), text, meta] : [ns.toString(), text] });
  }
  return {
    streams: [...streams.values()]
      .filter((s) => Object.keys(s.stream).length > 0)
      .map((s) => ({ stream: s.stream, values: s.values.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0)).map((x) => x.v) })),
  };
}

// -------------------------------------------------------------------------------------------------------------
// OTLP JSON

export interface OtlpResource {
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly scope?: { readonly name: string; readonly version?: string };
}
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } } | { kvlistValue: { values: KeyValue[] } };
interface KeyValue {
  key: string;
  value: AnyValue;
}

export function anyValue(v: unknown, depth = 0): AnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { intValue: String(v) } : { doubleValue: Number.isFinite(v) ? v : 0 };
  if (typeof v === 'bigint') return { intValue: v.toString() };
  if (depth > 4) return { stringValue: '[deep]' };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => anyValue(x, depth + 1)) } };
  if (v && typeof v === 'object') return { kvlistValue: { values: attrs(v as Record<string, unknown>, depth + 1) } };
  return { stringValue: v === null || v === undefined ? '' : String(v) };
}
function attrs(o: Readonly<Record<string, unknown>>, depth = 0): KeyValue[] {
  return Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((key) => ({ key, value: anyValue(o[key], depth) }));
}

const resourceOf = (r: OtlpResource) => ({ attributes: attrs(r.attributes) });
const scopeOf = (r: OtlpResource) => ({ name: r.scope?.name ?? 'log-shipping', ...(r.scope?.version ? { version: r.scope.version } : {}) });
const isId = (s: string | undefined, len: number) => s !== undefined && new RegExp(`^[0-9a-f]{${len}}$`).test(s) && !/^0+$/.test(s);

export function otlpLogs(entries: readonly LogEntry[], resource: OtlpResource, o: { redactKeys?: readonly string[] } = {}) {
  return {
    resourceLogs: [
      {
        resource: resourceOf(resource),
        scopeLogs: [
          {
            scope: scopeOf(resource),
            logRecords: entries.map((e) => {
              const ns = NS(e).toString();
              return {
                timeUnixNano: ns,
                observedTimeUnixNano: ns,
                severityNumber: SEVERITY_NUMBER[e.severity],
                severityText: e.severity,
                body: { stringValue: String(redact(e.message)) },
                attributes: attrs({ ...((redact({ ...(e.labels ?? {}), ...(e.fields ?? {}) }, o.redactKeys ?? []) as Record<string, unknown>) ?? {}) }),
                ...(isId(e.trace, 32) ? { traceId: e.trace } : {}),
                ...(isId(e.trace, 32) && isId(e.span, 16) ? { spanId: e.span } : {}),
              };
            }),
          },
        ],
      },
    ],
  };
}

/** Spans of the observe block as OTLP. `origin` is the epoch time in ms at which performance.now() was 0. */
export function otlpSpans(spans: readonly SpanRecord[], resource: OtlpResource, origin: number, o: { redactKeys?: readonly string[] } = {}) {
  const toNs = (ms: number) => (BigInt(Math.round((origin + ms) * 1000)) * 1000n).toString();
  return {
    resourceSpans: [
      {
        resource: resourceOf(resource),
        scopeSpans: [
          {
            scope: scopeOf(resource),
            spans: spans
              .filter((s) => isId(s.trace, 32) && isId(s.span, 16) && s.end !== undefined)
              .map((s) => ({
                traceId: s.trace,
                spanId: s.span,
                ...(isId(s.parent, 16) ? { parentSpanId: s.parent } : {}),
                name: s.name,
                kind: 1,
                startTimeUnixNano: toNs(s.start),
                endTimeUnixNano: toNs(Math.max(s.start, s.end!)),
                attributes: attrs(redact(s.attrs, o.redactKeys ?? []) as Record<string, unknown>),
                status: { code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0 },
              })),
          },
        ],
      },
    ],
  };
}
