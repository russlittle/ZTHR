/**
 * The model behind the admin console, the housekeeping console and the feature explorer. It reads the registries
 * an app already keeps (screens, flags, the job queue, housekeeping check-ins, dependency reviews and expiries,
 * restore drills, service levels, incidents and readiness) and turns them into sections of items. Every item has a
 * status (ok, attention or action), the reason in a plain sentence, the path to open it, and the permission a
 * person needs to see it. A person only ever sees items they are allowed to see, and sections with nothing for
 * them are left out. The summary line counts what needs action and attention.
 *
 * The housekeeping section lists every chore (sweeps, drills, rotations, expiries, watchdogs, upkeep) with when it
 * last ran, what it did and when it is next due, so housekeeping that silently stopped is shown as stopped.
 *
 * The feature explorer joins each feature to its screens, flags, journeys, evidence, parts, permissions and
 * history, reports any reference that points at nothing, and finds features by a few typed letters.
 *
 * Everything here is data. The optional HTML rendering escapes every value it writes.
 */
import type { Surface } from '../surfaces/index.ts';
import type { Flag } from '../flags/index.ts';
import type { Job as QueuedJob } from '../jobs/index.ts';
import { check as watch, type CheckIn, type Job as Chore } from '../watchdog/index.ts';
import type { expiry, review } from '../upkeep/index.ts';
import type { Drill } from '../backups/index.ts';
import { alerts, budget, type Incident, type Objective, type Window } from '../slo/index.ts';
import type { Readiness } from '../health/index.ts';
import { score } from '../palette/index.ts';

export type Status = 'ok' | 'attention' | 'action';

export interface Item {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
  readonly reason: string;
  readonly path: string;
  readonly permission: string;
}

export interface Section {
  readonly id: SectionId;
  readonly title: string;
  readonly status: Status;
  readonly items: readonly Item[];
}

export type SectionId = 'service' | 'incidents' | 'housekeeping' | 'jobs' | 'backups' | 'upkeep' | 'expiries' | 'flags' | 'screens';

export interface HousekeepingChore {
  readonly job: Chore;
  readonly title: string;
  readonly kind: 'sweep' | 'drill' | 'rotation' | 'expiry' | 'watchdog' | 'upkeep' | 'other';
  /** What the last run did, in a sentence ("removed 41 expired sessions"). */
  readonly did?: string;
}

export interface Sources {
  /** Milliseconds since the epoch; the clock every "how long ago" is measured from. */
  readonly now: number;
  readonly surfaces?: readonly Surface[];
  readonly flags?: readonly Flag[];
  readonly jobs?: readonly QueuedJob[];
  readonly housekeeping?: { readonly chores: readonly HousekeepingChore[]; readonly checkIns: readonly CheckIn[] };
  readonly dependencies?: ReturnType<typeof review>;
  readonly expiries?: ReturnType<typeof expiry>;
  /** Restore drills, and how many days may pass between them before one is overdue. */
  readonly drills?: { readonly list: readonly Drill[]; readonly everyDays: number };
  readonly objectives?: readonly { readonly objective: Objective; readonly window: Window; readonly windows?: Readonly<Record<string, Window>> }[];
  readonly incidents?: readonly Incident[];
  readonly readiness?: Readiness;
}

/** The permission each section needs, and where its items live; both can be replaced. */
export const PERMISSIONS: Readonly<Record<SectionId, string>> = {
  service: 'admin:service',
  incidents: 'admin:service',
  housekeeping: 'admin:housekeeping',
  jobs: 'admin:jobs',
  backups: 'admin:backups',
  upkeep: 'admin:upkeep',
  expiries: 'admin:upkeep',
  flags: 'admin:flags',
  screens: 'admin:screens',
};

const TITLES: Readonly<Record<SectionId, string>> = {
  service: 'Service',
  incidents: 'Incidents',
  housekeeping: 'Housekeeping',
  jobs: 'Background jobs',
  backups: 'Backups',
  upkeep: 'Dependencies',
  expiries: 'Things that expire',
  flags: 'Feature flags',
  screens: 'Screens',
};

const RANK: Readonly<Record<Status, number>> = { ok: 0, attention: 1, action: 2 };
export const worst = (xs: readonly Status[]): Status => xs.reduce<Status>((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok');

const DAY = 86_400_000;
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const enc = encodeURIComponent;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface Options {
  readonly base?: string;
  readonly permissions?: Partial<Record<SectionId, string>>;
}

/** Every section the sources allow, before any permission filter, in the order a person should read them. */
export function sections(src: Sources, o: Options = {}): Section[] {
  const base = (o.base ?? '/admin').replace(/\/$/, '');
  const perm = (s: SectionId) => o.permissions?.[s] ?? PERMISSIONS[s];
  const out: Section[] = [];
  const add = (id: SectionId, items: Item[]) => {
    if (items.length) out.push({ id, title: TITLES[id], status: worst(items.map((i) => i.status)), items: items.sort((a, b) => RANK[b.status] - RANK[a.status] || a.title.localeCompare(b.title)) });
  };
  const item = (sec: SectionId, id: string, title: string, status: Status, reason: string, path: string): Item => ({ id: `${sec}:${id}`, title, status, reason, path: `${base}${path}`, permission: perm(sec) });

  // Service: readiness and each objective's error budget.
  const service: Item[] = [];
  if (src.readiness) {
    const r = src.readiness;
    const failed = r.checks.filter((c) => !c.ok);
    service.push(item('service', 'readiness', 'Readiness', r.status === 'down' ? 'action' : r.status === 'degraded' ? 'attention' : 'ok', failed.length ? `${failed.map((c) => `${c.name} is not answering${c.error ? ` (${c.error})` : ''}`).join('; ')}.` : `All ${plural(r.checks.length, 'check')} answered.`, '/service'));
  }
  for (const s of src.objectives ?? []) {
    const b = budget(s.objective, s.window);
    const fired = s.windows ? alerts(s.objective, s.windows) : [];
    const left = b.allowedBad ? Math.max(0, Math.round((b.remaining / b.allowedBad) * 100)) : b.bad ? 0 : 100;
    const status: Status = fired.some((a) => a.severity === 'page') || b.remaining < 0 ? 'action' : fired.length || left < 25 ? 'attention' : 'ok';
    const reason = b.remaining < 0 ? `The error budget is spent: ${b.bad} failures against ${Math.floor(b.allowedBad)} allowed.` : fired.length ? `${fired[0]!.because}.` : `${left}% of the error budget is left.`;
    service.push(item('service', `slo-${s.objective.name}`, s.objective.name, status, reason, `/service/objectives/${enc(s.objective.name)}`));
  }
  add('service', service);

  // Incidents: open ones need action; resolved serious ones without a postmortem need attention.
  const incidents: Item[] = [];
  for (const i of src.incidents ?? []) {
    if (i.status !== 'resolved') incidents.push(item('incidents', String(i.id), i.title, 'action', `Severity ${i.severity}, ${i.status} since ${i.started.slice(0, 16).replace('T', ' ')}.`, `/incidents/${i.id}`));
    else if (i.severity <= 2 && !i.postmortem) incidents.push(item('incidents', String(i.id), i.title, 'attention', 'Resolved, and still owes a postmortem.', `/incidents/${i.id}`));
  }
  add('incidents', incidents);

  // Housekeeping: every chore, when it last ran, what it did, when it is next due.
  if (src.housekeeping) {
    const { chores, checkIns } = src.housekeeping;
    const findings = watch(chores.map((c) => c.job), checkIns, src.now);
    add('housekeeping', chores.map((c) => {
      const mine = findings.filter((f) => f.job === c.job.name);
      const starts = checkIns.filter((x) => x.job === c.job.name && x.kind === 'start').map((x) => x.at);
      const last = starts.length ? Math.max(...starts) : null;
      const status: Status = mine.some((f) => f.problem === 'missed' || f.problem === 'never ran' || f.problem === 'failed') ? 'action' : mine.length ? 'attention' : 'ok';
      const when = last === null ? 'It has never run.' : `Last ran ${iso(last)}${c.did ? ` and ${c.did}` : ''}.`;
      const due = last === null ? '' : ` Next due ${iso(last + c.job.everyMin * MIN)}.`;
      const problems = mine.length ? ` ${mine.map((f) => sentence(f.problem, f.detail)).join(' ')}` : '';
      return item('housekeeping', c.job.name, c.title, status, `${when}${due}${problems}`, `/housekeeping/${enc(c.job.name)}`);
    }));
  }

  // Jobs: dead letters need action, a long-waiting queue needs attention.
  if (src.jobs) {
    const dead = src.jobs.filter((j) => j.state === 'dead');
    const late = src.jobs.filter((j) => j.state === 'waiting' && src.now - j.runAt > 15 * MIN);
    const kinds = [...new Set(src.jobs.map((j) => j.kind))].sort();
    add('jobs', kinds.map((k) => {
      const d = dead.filter((j) => j.kind === k);
      const l = late.filter((j) => j.kind === k);
      const status: Status = d.length ? 'action' : l.length ? 'attention' : 'ok';
      const reason = d.length ? `${plural(d.length, 'job')} gave up; the last error was "${d.at(-1)!.lastError ?? 'unknown'}". Fix the cause, then replay.` : l.length ? `${plural(l.length, 'job')} waiting more than 15 minutes past due.` : 'Nothing waiting past due and nothing given up.';
      return item('jobs', k, k, status, reason, `/jobs/${enc(k)}`);
    }));
  }

  // Backups: the latest drill must have passed and be recent enough.
  if (src.drills) {
    const latest = [...src.drills.list].sort((a, b) => b.ran.localeCompare(a.ran))[0];
    const age = latest ? Math.floor((src.now - Date.parse(latest.ran)) / DAY) : null;
    const status: Status = !latest || !latest.ok ? 'action' : age! > src.drills.everyDays ? 'attention' : 'ok';
    const reason = !latest ? 'No backup has ever been restored. A backup is only proved by restoring it.' : !latest.ok ? `The last restore drill failed: ${latest.problems.join('; ')}.` : `Restored ${latest.backup} ${age === 0 ? 'today' : `${plural(age!, 'day')} ago`} in ${latest.ms} ms, every collection matched.${age! > src.drills.everyDays ? ` Drills are due every ${plural(src.drills.everyDays, 'day')}.` : ''}`;
    add('backups', [item('backups', 'drill', 'Restore drill', status, reason, '/backups')]);
  }

  // Upkeep: dependency verdicts.
  if (src.dependencies) add('upkeep', src.dependencies.map((d) => item('upkeep', d.name, d.name, d.verdict === 'urgent' ? 'action' : d.verdict === 'update' ? 'attention' : 'ok', `${d.verdict === 'urgent' ? 'Update now' : d.verdict === 'update' ? 'Update soon' : 'Fine'}: ${d.because}.`, `/upkeep/${enc(d.name)}`)));
  if (src.expiries) add('expiries', src.expiries.map((e) => item('expiries', e.what, e.what, e.state === 'expired' ? 'action' : e.state === 'soon' ? 'attention' : 'ok', e.state === 'expired' ? `Expired ${plural(-e.daysLeft, 'day')} ago. ${e.owner} renews it.` : `${plural(e.daysLeft, 'day')} left. ${e.owner} renews it.`, `/upkeep/expiring/${enc(e.what)}`)));

  // Flags: killed or past their removal date.
  if (src.flags) {
    const today = new Date(src.now).toISOString().slice(0, 10);
    add('flags', src.flags.map((f) => {
      const state = f.killed ? 'switched off for everyone' : !f.on ? 'off' : !f.rules?.length ? 'on for everyone' : `on by ${plural(f.rules.length, 'rule')}`;
      const stale = !f.removeBy || f.removeBy < today;
      const status: Status = f.killed ? 'attention' : stale ? 'attention' : 'ok';
      const reason = `${cap(state)}. ${!f.removeBy ? 'It has no removal date.' : f.removeBy < today ? `It was due out of the code by ${f.removeBy}.` : `Due out of the code by ${f.removeBy}.`} ${f.owner} owns it.`;
      return item('flags', f.key, f.key, status, reason, `/flags/${enc(f.key)}`);
    }));
  }

  if (src.surfaces) add('screens', src.surfaces.map((s) => item('screens', s.id, s.title, 'ok', `${s.purpose} For ${s.audience.join(', ')}.`, `/screens/${enc(s.id)}`)));
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (problem: string, detail: string) => `${cap(problem)}: ${detail}.`;

export interface View {
  readonly sections: readonly Section[];
  readonly counts: Readonly<Record<Status, number>>;
  readonly summary: string;
}

/** The console one person sees: only what their permissions allow, with a summary line. */
export function view(src: Sources, can: (permission: string) => boolean, o: Options = {}): View {
  const shown = sections(src, o)
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.permission)) }))
    .filter((s) => s.items.length)
    .map((s) => ({ ...s, status: worst(s.items.map((i) => i.status)) }));
  const all = shown.flatMap((s) => s.items);
  const counts = { ok: 0, attention: 0, action: 0 };
  for (const i of all) counts[i.status]++;
  return { sections: shown, counts, summary: summarise(counts) };
}

export function summarise(c: Readonly<Record<Status, number>>): string {
  if (!c.ok && !c.attention && !c.action) return 'There is nothing here for you to look after.';
  if (!c.attention && !c.action) return `Everything is fine: ${plural(c.ok, 'item')} checked.`;
  const parts = [c.action && `${c.action} need${c.action === 1 ? 's' : ''} action`, c.attention && `${c.attention} need${c.attention === 1 ? 's' : ''} attention`, c.ok && `${c.ok} ${c.ok === 1 ? 'is' : 'are'} fine`].filter(Boolean);
  return `${parts.join(', ')}.`.replace(/^./, (x) => x.toUpperCase());
}

// ---------------------------------------------------------------- feature explorer

export interface JourneyRef {
  readonly id: string;
  readonly persona: string;
  readonly goal: string;
  readonly status: string;
}

export interface EvidenceRef {
  readonly id: string;
  readonly kind: 'test' | 'run' | 'screenshot' | 'report' | 'other';
  readonly href: string;
  readonly at: string;
  /** Journey ids this evidence proves. */
  readonly proves: readonly string[];
  readonly passed?: boolean;
}

export interface Feature {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly parts?: readonly string[];
  readonly data?: readonly string[];
  readonly surfaces?: readonly string[];
  readonly flags?: readonly string[];
  readonly journeys?: readonly JourneyRef[];
  readonly evidence?: readonly EvidenceRef[];
  /** Who may do what: a role and the actions it may take. */
  readonly permissions?: readonly { readonly role: string; readonly may: readonly string[] }[];
  readonly history?: readonly { readonly at: string; readonly what: string; readonly by?: string }[];
  /** Where its audit trail is read. */
  readonly audit?: string;
}

export interface Explored {
  readonly id: string;
  readonly name: string;
  readonly what: string;
  readonly status: Status;
  readonly path: string;
  readonly parts: readonly string[];
  readonly data: readonly string[];
  readonly surfaces: readonly { id: string; title: string; path: string }[];
  readonly flags: readonly { key: string; state: string }[];
  readonly journeys: readonly (JourneyRef & { evidence: readonly EvidenceRef[] })[];
  readonly evidence: readonly EvidenceRef[];
  readonly permissions: readonly { role: string; may: readonly string[] }[];
  readonly history: readonly { at: string; what: string; by?: string }[];
  readonly audit: string | null;
  readonly problems: readonly string[];
}

export class Explorer {
  private readonly features: readonly Feature[];
  private readonly surfaces: Map<string, Surface>;
  private readonly flags: Map<string, Flag>;
  private readonly base: string;
  constructor(features: readonly Feature[], o: { surfaces?: readonly Surface[]; flags?: readonly Flag[]; base?: string } = {}) {
    const ids = new Set<string>();
    for (const f of features) {
      if (ids.has(f.id)) throw new Error(`two features are called ${f.id}`);
      ids.add(f.id);
    }
    this.features = features;
    this.surfaces = new Map((o.surfaces ?? []).map((s) => [s.id, s]));
    this.flags = new Map((o.flags ?? []).map((f) => [f.key, f]));
    this.base = (o.base ?? '/admin').replace(/\/$/, '');
  }

  list(): { id: string; name: string; what: string; status: Status; journeys: number; evidence: number }[] {
    return this.features.map((f) => {
      const e = this.open(f.id)!;
      return { id: f.id, name: f.name, what: f.what, status: e.status, journeys: e.journeys.length, evidence: e.evidence.length };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Everything about one feature, with every reference resolved, and anything that points at nothing named. */
  open(id: string): Explored | undefined {
    const f = this.features.find((x) => x.id === id);
    if (!f) return undefined;
    const problems: string[] = [];
    const surfaces = (f.surfaces ?? []).flatMap((s) => {
      const hit = this.surfaces.get(s);
      if (!hit) problems.push(`It names a screen, ${s}, that is not registered.`);
      return hit ? [{ id: hit.id, title: hit.title, path: hit.path }] : [];
    });
    const flags = (f.flags ?? []).map((k) => {
      const hit = this.flags.get(k);
      if (!hit) problems.push(`It names a flag, ${k}, that does not exist.`);
      return { key: k, state: hit ? (hit.killed ? 'switched off for everyone' : !hit.on ? 'off' : hit.rules?.length ? 'on for some people' : 'on for everyone') : 'missing' };
    });
    const evidence = [...(f.evidence ?? [])].sort((a, b) => b.at.localeCompare(a.at));
    const journeyIds = new Set((f.journeys ?? []).map((j) => j.id));
    for (const e of evidence) for (const p of e.proves) if (!journeyIds.has(p)) problems.push(`Evidence ${e.id} proves a journey, ${p}, the feature does not have.`);
    const journeys = (f.journeys ?? []).map((j) => {
      const ev = evidence.filter((e) => e.proves.includes(j.id));
      if (!ev.length) problems.push(`Journey ${j.id} has no evidence.`);
      return { ...j, evidence: ev };
    });
    if (!journeys.length) problems.push('No journey proves this feature.');
    const failing = journeys.filter((j) => j.status === 'fail' || j.evidence[0]?.passed === false);
    for (const j of failing) problems.push(`Journey ${j.id} is failing.`);
    const status: Status = failing.length || !journeys.length ? 'action' : problems.length ? 'attention' : 'ok';
    return { id: f.id, name: f.name, what: f.what, status, path: `${this.base}/features/${enc(f.id)}`, parts: f.parts ?? [], data: f.data ?? [], surfaces, flags, journeys, evidence, permissions: f.permissions ?? [], history: [...(f.history ?? [])].sort((a, b) => b.at.localeCompare(a.at)), audit: f.audit ?? null, problems };
  }

  /** Features matching a few typed letters, best first: names count most, then what it does, parts, screens and journeys. */
  search(query: string, limit = 10): { id: string; name: string; score: number; matched: string }[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { id: string; name: string; score: number; matched: string }[] = [];
    for (const f of this.features) {
      const fields: [string, number][] = [[f.name, 0], [f.what, 6], ...(f.parts ?? []).map((p): [string, number] => [p, 8]), ...(f.surfaces ?? []).map((s): [string, number] => [this.surfaces.get(s)?.title ?? s, 8]), ...(f.journeys ?? []).map((j): [string, number] => [j.goal, 10]), ...(f.flags ?? []).map((k): [string, number] => [k, 10])];
      let best: { s: number; m: string } | undefined;
      for (const [text, penalty] of fields) {
        const raw = score(query, text);
        const whole = text.toLowerCase().includes(q);
        // Letters scattered across a long sentence are not a match: the query must appear whole, or score well.
        if (raw < 0 || (!whole && raw < q.replace(/\s+/g, '').length * 7)) continue;
        const s = raw + (whole ? 20 : 0) - penalty;
        if (!best || s > best.s) best = { s, m: text };
      }
      if (best) out.push({ id: f.id, name: f.name, score: Math.round(best.s * 100) / 100, matched: best.m });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }
}

// ---------------------------------------------------------------- rendering

export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const WORDS: Readonly<Record<Status, string>> = { ok: 'Fine', attention: 'Needs attention', action: 'Needs action' };

/** The console as plain HTML, every value escaped; status is written in words, never colour alone. */
export function html(v: View): string {
  const sec = v.sections.map((s) => `<section data-status="${s.status}"><h2>${escape(s.title)} <small>${WORDS[s.status]}</small></h2><ul>${s.items.map((i) => `<li data-status="${i.status}"><a href="${escape(i.path)}">${escape(i.title)}</a> <strong>${WORDS[i.status]}</strong> <span>${escape(i.reason)}</span></li>`).join('')}</ul></section>`);
  return `<main><p role="status">${escape(v.summary)}</p>${sec.join('')}</main>`;
}
