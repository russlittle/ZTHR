/**
 * Alert rules, from a sample to a message to a person. A rule watches one metric and holds a condition: a series
 * becomes pending when the condition first holds, firing once it has held for the whole `for` duration, and
 * resolved when it stops holding (after an optional keep-firing time, so a flapping value does not page twice). A
 * series that disappears counts as not holding. Firing alerts are then silenced (matchers over a time range, never
 * one that would match everything), inhibited (a firing source alert mutes target alerts that agree on the named
 * labels, as Alertmanager's inhibit rules do), routed down a tree of label matchers (first matching child wins
 * unless it says `continue`), and grouped by the labels a route names. Each group is told about on a schedule: the
 * first message waits `groupWaitMs` so related alerts arrive together, a changed set waits `groupIntervalMs`, an
 * unchanged set repeats only after `repeatIntervalMs`, and resolution is announced once. Every notification carries
 * a stable dedupe key, so a sender that retries cannot message twice. Matcher syntax follows Prometheus
 * Alertmanager (`=`, `!=`, `=~`, `!~`; regular expressions are anchored; a missing label is the empty string).
 * Out of scope: expression languages (a rule takes a metric name and a threshold), delivery itself (pass the
 * notifications to the notify block), and clustering between several dispatchers.
 */
import { createHash } from 'node:crypto';

export class AlertRulesError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Labels = Readonly<Record<string, string>>;

export interface Matcher {
  readonly name: string;
  readonly op: '=' | '!=' | '=~' | '!~';
  readonly value: string;
}

const MAX_REGEX = 200;
const regexCache = new Map<string, RegExp>();

function anchored(pattern: string): RegExp {
  if (pattern.length > MAX_REGEX) throw new AlertRulesError(`a matcher pattern may be at most ${MAX_REGEX} characters`);
  let r = regexCache.get(pattern);
  if (!r) {
    try {
      r = new RegExp(`^(?:${pattern})$`, 'u');
    } catch {
      throw new AlertRulesError(`"${pattern}" is not a valid pattern`);
    }
    if (regexCache.size > 1000) regexCache.clear();
    regexCache.set(pattern, r);
  }
  return r;
}

/** Parses `severity="page"`, `env=~"prod|stage"`, `team!="x"`, or `team!~"a.*"`. */
export function parseMatcher(text: string): Matcher {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*(?:"((?:[^"\\]|\\.)*)"|([^"\s]*))\s*$/.exec(text);
  if (!m) throw new AlertRulesError(`"${text}" is not a matcher such as name="value"`);
  const raw = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : (m[4] ?? '');
  const matcher: Matcher = { name: m[1]!, op: m[2] as Matcher['op'], value: raw };
  if (matcher.op === '=~' || matcher.op === '!~') anchored(matcher.value);
  return matcher;
}

function one(m: Matcher, labels: Labels): boolean {
  const v = labels[m.name] ?? '';
  switch (m.op) {
    case '=':
      return v === m.value;
    case '!=':
      return v !== m.value;
    case '=~':
      return anchored(m.value).test(v);
    case '!~':
      return !anchored(m.value).test(v);
  }
}

/** True when every matcher holds for the labels. No matchers match everything. */
export function matches(ms: readonly Matcher[], labels: Labels): boolean {
  return ms.every((m) => one(m, labels));
}

const asMatchers = (ms: readonly (Matcher | string)[] | undefined): Matcher[] => (ms ?? []).map((m) => (typeof m === 'string' ? parseMatcher(m) : m));

/** A short stable identity for a label set, independent of key order. */
export function fingerprint(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return createHash('sha256').update(JSON.stringify(keys.map((k) => [k, labels[k]]))).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

export interface Sample {
  readonly metric: string;
  readonly labels: Labels;
  readonly value: number;
}

export interface Rule {
  readonly name: string;
  readonly metric: string;
  readonly op: '>' | '>=' | '<' | '<=' | '==' | '!=';
  readonly threshold: number;
  /** How long the condition must hold before the alert fires. Default 0: fires on the first evaluation. */
  readonly forMs?: number;
  /** How long a firing alert stays firing after the condition stops holding. Default 0. */
  readonly keepFiringForMs?: number;
  /** Only samples whose labels match are considered. */
  readonly selector?: readonly (Matcher | string)[];
  readonly labels?: Labels;
  readonly annotations?: Readonly<Record<string, string>>;
}

export type AlertState = 'pending' | 'firing' | 'resolved';

export interface Alert {
  readonly rule: string;
  readonly labels: Labels;
  readonly annotations: Readonly<Record<string, string>>;
  readonly fingerprint: string;
  readonly state: AlertState;
  readonly value: number;
  /** When the condition first held in this run. */
  readonly activeAt: number;
  readonly firedAt?: number;
  readonly resolvedAt?: number;
}

function holds(op: Rule['op'], v: number, t: number): boolean {
  if (Number.isNaN(v)) return false;
  switch (op) {
    case '>':
      return v > t;
    case '>=':
      return v >= t;
    case '<':
      return v < t;
    case '<=':
      return v <= t;
    case '==':
      return v === t;
    case '!=':
      return v !== t;
  }
}

interface Track {
  labels: Labels;
  value: number;
  activeAt: number;
  firedAt?: number;
  lastTrueAt: number;
}

export class RuleEngine {
  private readonly rules: readonly (Rule & { sel: Matcher[] })[];
  private readonly tracks = new Map<string, Track>();

  constructor(rules: readonly Rule[]) {
    const seen = new Set<string>();
    for (const r of rules) {
      if (!r.name) throw new AlertRulesError('a rule needs a name');
      if (seen.has(r.name)) throw new AlertRulesError(`two rules are named "${r.name}"`);
      seen.add(r.name);
      if (!Number.isFinite(r.threshold)) throw new AlertRulesError(`rule "${r.name}" needs a finite threshold`);
      if ((r.forMs ?? 0) < 0 || (r.keepFiringForMs ?? 0) < 0) throw new AlertRulesError(`rule "${r.name}" has a negative duration`);
    }
    this.rules = rules.map((r) => ({ ...r, sel: asMatchers(r.selector) }));
  }

  /**
   * One evaluation round at `now`. Returns every pending and firing alert, plus those that resolved in this round
   * (reported once, in the round they resolve). A pending alert whose condition stops holding vanishes unannounced.
   */
  evaluate(now: number, samples: readonly Sample[]): Alert[] {
    const out: Alert[] = [];
    for (const rule of this.rules) {
      const seen = new Set<string>();
      for (const s of samples) {
        if (s.metric !== rule.metric || !matches(rule.sel, s.labels)) continue;
        const labels: Labels = { ...s.labels, ...(rule.labels ?? {}), alertname: rule.name };
        const key = `${rule.name}/${fingerprint(labels)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!holds(rule.op, s.value, rule.threshold)) continue;
        const t = this.tracks.get(key);
        if (t) {
          t.value = s.value;
          t.lastTrueAt = now;
        } else this.tracks.set(key, { labels, value: s.value, activeAt: now, lastTrueAt: now });
      }
      for (const [key, t] of [...this.tracks]) {
        if (!key.startsWith(`${rule.name}/`)) continue;
        const stillTrue = t.lastTrueAt === now;
        const annotations = rule.annotations ?? {};
        const base = { rule: rule.name, labels: t.labels, annotations, fingerprint: fingerprint(t.labels), value: t.value, activeAt: t.activeAt };
        if (!stillTrue) {
          if (t.firedAt !== undefined && now - t.lastTrueAt < (rule.keepFiringForMs ?? 0)) {
            out.push({ ...base, state: 'firing', firedAt: t.firedAt });
            continue;
          }
          this.tracks.delete(key);
          if (t.firedAt !== undefined) out.push({ ...base, state: 'resolved', firedAt: t.firedAt, resolvedAt: now });
          continue;
        }
        if (t.firedAt === undefined && now - t.activeAt >= (rule.forMs ?? 0)) t.firedAt = now;
        out.push(t.firedAt === undefined ? { ...base, state: 'pending' } : { ...base, state: 'firing', firedAt: t.firedAt });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Silences

export interface SilenceInput {
  readonly matchers: readonly (Matcher | string)[];
  readonly startsAt: number;
  readonly endsAt: number;
  readonly createdBy: string;
  readonly comment: string;
}

export interface Silence {
  readonly id: string;
  readonly matchers: readonly Matcher[];
  readonly startsAt: number;
  endsAt: number;
  readonly createdBy: string;
  readonly comment: string;
}

export class Silences {
  private readonly all = new Map<string, Silence>();
  private n = 0;
  private readonly newId: () => string;
  constructor(newId?: () => string) {
    this.newId = newId ?? (() => `silence-${++this.n}`);
  }

  create(input: SilenceInput): Silence {
    const matchers = asMatchers(input.matchers);
    if (!matchers.length) throw new AlertRulesError('a silence needs at least one matcher');
    if (matchers.every((m) => one(m, {}))) throw new AlertRulesError('a silence whose matchers all match an empty label would silence everything; add one that needs a value');
    if (!(input.endsAt > input.startsAt)) throw new AlertRulesError('a silence must end after it starts');
    if (!input.createdBy.trim() || !input.comment.trim()) throw new AlertRulesError('a silence records who made it and why');
    const s: Silence = { id: this.newId(), matchers, startsAt: input.startsAt, endsAt: input.endsAt, createdBy: input.createdBy, comment: input.comment };
    this.all.set(s.id, s);
    return s;
  }

  state(id: string, now: number): 'pending' | 'active' | 'expired' {
    const s = this.all.get(id);
    if (!s) throw new AlertRulesError(`no silence ${id}`);
    return now < s.startsAt ? 'pending' : now >= s.endsAt ? 'expired' : 'active';
  }

  /** Ends a silence now. An already expired one is left as it was. */
  expire(id: string, now: number): void {
    const s = this.all.get(id);
    if (!s) throw new AlertRulesError(`no silence ${id}`);
    if (now < s.endsAt) s.endsAt = Math.max(now, s.startsAt);
  }

  /** The ids of the active silences that match these labels. */
  silencing(labels: Labels, now: number): string[] {
    return [...this.all.values()].filter((s) => now >= s.startsAt && now < s.endsAt && matches(s.matchers, labels)).map((s) => s.id);
  }

  list(): Silence[] {
    return [...this.all.values()];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Routing

export interface Route {
  readonly receiver?: string;
  readonly match?: readonly (Matcher | string)[];
  /** Label names to group by; `['...']` groups by every label. Inherited from the parent when absent. */
  readonly groupBy?: readonly string[];
  readonly groupWaitMs?: number;
  readonly groupIntervalMs?: number;
  readonly repeatIntervalMs?: number;
  /** Keep trying the following siblings after this route matches. */
  readonly continue?: boolean;
  readonly routes?: readonly Route[];
}

interface Resolved {
  id: string;
  receiver: string;
  groupBy: readonly string[];
  groupWaitMs: number;
  groupIntervalMs: number;
  repeatIntervalMs: number;
  match: Matcher[];
  continue: boolean;
  children: Resolved[];
}

function resolveRoute(r: Route, parent: Resolved | null, id: string): Resolved {
  const receiver = r.receiver ?? parent?.receiver;
  if (!receiver) throw new AlertRulesError('the root route needs a receiver');
  if (!parent && (r.match?.length ?? 0) > 0) throw new AlertRulesError('the root route matches everything and takes no matchers');
  const out: Resolved = {
    id,
    receiver,
    groupBy: r.groupBy ?? parent?.groupBy ?? ['alertname'],
    groupWaitMs: r.groupWaitMs ?? parent?.groupWaitMs ?? 30_000,
    groupIntervalMs: r.groupIntervalMs ?? parent?.groupIntervalMs ?? 300_000,
    repeatIntervalMs: r.repeatIntervalMs ?? parent?.repeatIntervalMs ?? 4 * 3_600_000,
    match: asMatchers(r.match),
    continue: r.continue ?? false,
    children: [],
  };
  out.children = (r.routes ?? []).map((c, i) => resolveRoute(c, out, `${id}.${i}`));
  return out;
}

/** The routes an alert lands on: a matching child replaces its parent; `continue` lets later siblings match too. */
function route(r: Resolved, labels: Labels): Resolved[] {
  const hit: Resolved[] = [];
  for (const c of r.children) {
    if (!matches(c.match, labels)) continue;
    hit.push(...route(c, labels));
    if (!c.continue) break;
  }
  return hit.length ? hit : [r];
}

// ---------------------------------------------------------------------------------------------------------------
// Inhibition and dispatch

export interface InhibitRule {
  /** Alerts that, while firing, mute the targets. */
  readonly source: readonly (Matcher | string)[];
  readonly target: readonly (Matcher | string)[];
  /** Label names whose values must be equal on source and target. */
  readonly equal: readonly string[];
}

export interface Notification {
  readonly receiver: string;
  readonly route: string;
  readonly groupKey: string;
  readonly groupLabels: Labels;
  readonly firing: readonly Alert[];
  readonly resolved: readonly Alert[];
  readonly reason: 'first' | 'changed' | 'repeat' | 'resolved';
  /** Identical for the same receiver, group and sets: pass it on as the idempotency key. */
  readonly dedupeKey: string;
  readonly at: number;
}

export interface Suppression {
  readonly silencedBy: readonly string[];
  readonly inhibitedBy: readonly string[];
}

interface Group {
  r: Resolved;
  key: string;
  labels: Labels;
  createdAt: number;
  lastNotifiedAt: number | undefined;
  notified: Map<string, Alert>;
  current: Map<string, Alert>;
}

export interface DispatcherOptions {
  readonly route: Route;
  readonly inhibit?: readonly InhibitRule[];
  readonly silences?: Silences;
}

export class Dispatcher {
  readonly silences: Silences;
  private readonly root: Resolved;
  private readonly inhibit: { source: Matcher[]; target: Matcher[]; equal: readonly string[] }[];
  private readonly groups = new Map<string, Group>();

  constructor(o: DispatcherOptions) {
    this.root = resolveRoute(o.route, null, '0');
    this.silences = o.silences ?? new Silences();
    this.inhibit = (o.inhibit ?? []).map((i) => ({ source: asMatchers(i.source), target: asMatchers(i.target), equal: i.equal }));
  }

  /** Why an alert would not be sent right now: the silences covering it and the alerts inhibiting it. */
  suppression(alert: Pick<Alert, 'labels' | 'fingerprint'>, firing: readonly Pick<Alert, 'labels' | 'fingerprint'>[], now: number): Suppression {
    const silencedBy = this.silences.silencing(alert.labels, now);
    const inhibitedBy: string[] = [];
    for (const rule of this.inhibit) {
      if (!matches(rule.target, alert.labels)) continue;
      for (const src of firing) {
        if (src.fingerprint === alert.fingerprint || !matches(rule.source, src.labels)) continue;
        if (this.silences.silencing(src.labels, now).length) continue;
        if (rule.equal.every((k) => (src.labels[k] ?? '') === (alert.labels[k] ?? ''))) inhibitedBy.push(src.fingerprint);
      }
    }
    return { silencedBy, inhibitedBy: [...new Set(inhibitedBy)] };
  }

  /** One dispatch round at `now` with the alerts from the latest evaluation. Returns the messages due. */
  process(now: number, alerts: readonly Alert[]): Notification[] {
    const firing = alerts.filter((a) => a.state === 'firing');
    const active = firing.filter((a) => {
      const s = this.suppression(a, firing, now);
      return !s.silencedBy.length && !s.inhibitedBy.length;
    });
    const wanted = new Map<string, { r: Resolved; key: string; labels: Labels; alerts: Map<string, Alert> }>();
    for (const a of active)
      for (const r of route(this.root, a.labels)) {
        const gl: Record<string, string> = {};
        if (r.groupBy.length === 1 && r.groupBy[0] === '...') Object.assign(gl, a.labels);
        else for (const k of r.groupBy) gl[k] = a.labels[k] ?? '';
        const key = JSON.stringify(Object.keys(gl).sort().map((k) => [k, gl[k]]));
        const full = `${r.id}|${r.receiver}|${key}`;
        let w = wanted.get(full);
        if (!w) wanted.set(full, (w = { r, key, labels: gl, alerts: new Map() }));
        w.alerts.set(a.fingerprint, a);
      }
    // A group that had alerts but has none now still needs its resolution announced.
    for (const [full, g] of this.groups) if (!wanted.has(full) && g.notified.size) wanted.set(full, { r: g.r, key: g.key, labels: g.labels, alerts: new Map() });
    const out: Notification[] = [];
    for (const [full, w] of wanted) {
      let g = this.groups.get(full);
      if (!g) this.groups.set(full, (g = { r: w.r, key: w.key, labels: w.labels, createdAt: now, lastNotifiedAt: undefined, notified: new Map(), current: new Map() }));
      g.current = w.alerts;
      const added = [...g.current.keys()].filter((k) => !g.notified.has(k));
      const gone = [...g.notified.keys()].filter((k) => !g.current.has(k));
      let reason: Notification['reason'] | null = null;
      if (g.lastNotifiedAt === undefined) {
        if (g.current.size && now - g.createdAt >= w.r.groupWaitMs) reason = 'first';
      } else if (added.length || gone.length) {
        if (now - g.lastNotifiedAt >= w.r.groupIntervalMs) reason = g.current.size ? 'changed' : 'resolved';
      } else if (g.current.size && now - g.lastNotifiedAt >= w.r.repeatIntervalMs) reason = 'repeat';
      if (!reason) {
        if (!g.current.size && !g.notified.size) this.groups.delete(full);
        continue;
      }
      const resolved = gone.map((k) => g!.notified.get(k)!);
      const firingNow = [...g.current.values()];
      const dedupeKey = createHash('sha256')
        .update(JSON.stringify([w.r.receiver, w.key, [...g.current.keys()].sort(), gone.sort(), g.lastNotifiedAt === undefined ? 0 : 1, reason === 'repeat' ? Math.floor(now / w.r.repeatIntervalMs) : 0]))
        .digest('hex')
        .slice(0, 32);
      out.push({ receiver: w.r.receiver, route: w.r.id, groupKey: w.key, groupLabels: w.labels, firing: firingNow, resolved, reason, dedupeKey, at: now });
      g.lastNotifiedAt = now;
      g.notified = new Map(g.current);
      if (!g.current.size) this.groups.delete(full);
    }
    return out;
  }
}
