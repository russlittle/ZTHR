/**
 * A sales pipeline: leads that are scored and given an owner, deals that move through stages with a probability, the
 * activities on them, and a forecast that adds it all up.
 *
 * - Pipeline definition: ordered stages, each with a probability (0 to 1, never falling as a deal advances), optional
 *   fields a deal must have before it may enter the stage, and a limit on days without activity ("rotting"). Won
 *   (probability 1) and lost (0) end it. The stages become a workflow (the workflow block), so the moves are checked
 *   the same way as every other state machine: forward to any later stage, back one stage, lose from any open stage
 *   with a reason, reopen only by a manager.
 * - Leads: names kept as written (the contact block), phone numbers normalised to E.164, email compared case
 *   insensitively so the same person is not entered twice; a lead is converted to a deal, once.
 * - Scoring: rules over lead fields add points, activity adds points, and points fade with days of silence; the total is
 *   0 to 100 with a breakdown and a grade, so a person can see why a lead scored what it did.
 * - Assignment: ordered rules choose an owner or a pool; pools are round robin or least loaded, skip owners who are away
 *   or at capacity, and fall back to a default; nothing is random.
 * - Forecast: money is whole minor units (cents) so sums are exact; weighted amount is amount times the stage
 *   probability, rounded once per deal; the forecast is by month, owner and stage, with commit (deals at or above a
 *   probability), best case (everything open), closed won, and attainment against a quota. Mixed currencies are refused
 *   unless rates are given.
 *
 * Out of scope: storing anything (the pipeline holds records in memory for the caller to persist), email, and
 * permissions beyond the roles named on moves (sales, manager).
 */
import { Workflow, Refused } from '../workflow/index.ts';
import type { Instance, Transition } from '../workflow/index.ts';
import { name as makeName, phone as e164 } from '../contact/index.ts';
import type { Name } from '../contact/index.ts';

export class CrmError extends Error {}
export class Duplicate extends CrmError {
  readonly existing: string;
  constructor(existing: string, what: string) {
    super(`${what} is already a lead (${existing})`);
    this.existing = existing;
  }
}
export { Refused };

export interface Stage {
  readonly id: string;
  readonly name: string;
  readonly probability: number;
  readonly kind?: 'open' | 'won' | 'lost';
  /** Deal fields that must be set before a deal can enter this stage. */
  readonly requires?: readonly string[];
  /** Days without activity after which a deal here is rotting. */
  readonly rotAfterDays?: number;
}
export interface PipelineDef {
  readonly name: string;
  readonly stages: readonly Stage[];
}

export function checkPipeline(d: PipelineDef): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const s of d.stages) {
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(s.id)) out.push(`stage id ${JSON.stringify(s.id.slice(0, 20))} is not allowed`);
    if (ids.has(s.id)) out.push(`two stages share the id ${s.id}`);
    ids.add(s.id);
    if (!(s.probability >= 0 && s.probability <= 1)) out.push(`${s.id}: probability is 0 to 1`);
  }
  const open = d.stages.filter((s) => (s.kind ?? 'open') === 'open');
  const won = d.stages.filter((s) => s.kind === 'won');
  const lost = d.stages.filter((s) => s.kind === 'lost');
  if (open.length < 1) out.push('a pipeline needs at least one open stage');
  if (won.length !== 1) out.push('a pipeline has exactly one won stage');
  if (lost.length !== 1) out.push('a pipeline has exactly one lost stage');
  if (won[0] && won[0].probability !== 1) out.push('the won stage has probability 1');
  if (lost[0] && lost[0].probability !== 0) out.push('the lost stage has probability 0');
  for (let i = 1; i < open.length; i++) if (open[i]!.probability < open[i - 1]!.probability) out.push(`${open[i]!.id} has a lower probability than the stage before it`);
  const last = d.stages.at(-1);
  const firstFinal = d.stages.findIndex((s) => s.kind === 'won' || s.kind === 'lost');
  if (firstFinal >= 0 && d.stages.slice(firstFinal).some((s) => (s.kind ?? 'open') === 'open')) out.push('won and lost come after the open stages');
  void last;
  return out;
}

// -------------------------------------------------------------------------------------------------------------
// Records

export interface Lead {
  readonly id: string;
  readonly name: Name;
  readonly email?: string;
  readonly phone?: string;
  readonly company?: string;
  readonly source?: string;
  readonly country?: string;
  readonly attrs: Readonly<Record<string, string | number | boolean>>;
  owner?: string;
  status: 'new' | 'working' | 'qualified' | 'disqualified' | 'converted';
  readonly createdAt: number;
  lastActivityAt: number;
  activityCount: number;
  dealId?: string;
}

export type ActivityKind = 'call' | 'email' | 'meeting' | 'note' | 'task';
export interface Activity {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly by: string;
  readonly at: number;
  readonly summary: string;
  /** For a task: when it is due, and whether it is done. */
  readonly dueAt?: number;
  done?: boolean;
}

export interface Deal {
  readonly id: string;
  title: string;
  /** Whole minor units of `currency`. */
  amount: number;
  readonly currency: string;
  owner: string;
  /** ISO date YYYY-MM-DD. */
  expectedClose?: string;
  readonly leadId?: string;
  readonly createdAt: number;
  stageEnteredAt: number;
  closedAt?: number;
  lostReason?: string;
  readonly activities: Activity[];
  readonly wf: Instance;
}
export const stageOf = (d: Deal): string => d.wf.state;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => ISO_DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const DAY = 86_400_000;

// -------------------------------------------------------------------------------------------------------------
// Scoring

export type Cmp = 'eq' | 'neq' | 'gte' | 'lte' | 'in' | 'contains' | 'present';
export interface ScoreRule {
  readonly field: string;
  readonly cmp: Cmp;
  readonly value?: string | number | boolean | readonly (string | number)[];
  readonly points: number;
  readonly why?: string;
}
export interface Scoring {
  readonly rules: readonly ScoreRule[];
  /** Points per recorded activity, up to `activityCap` points. */
  readonly perActivity?: number;
  readonly activityCap?: number;
  /** Points halve for every this many days without activity. */
  readonly halfLifeDays?: number;
  readonly grades?: readonly { readonly grade: string; readonly min: number }[];
}
export interface ScoreResult {
  readonly score: number;
  readonly grade: string;
  readonly parts: { readonly why: string; readonly points: number }[];
  readonly decay: number;
}

function fieldOf(l: Lead, f: string): unknown {
  switch (f) {
    case 'email':
      return l.email;
    case 'phone':
      return l.phone;
    case 'company':
      return l.company;
    case 'source':
      return l.source;
    case 'country':
      return l.country;
    case 'emailDomain':
      return l.email?.split('@')[1];
    default:
      return Object.hasOwn(l.attrs, f) ? l.attrs[f] : undefined;
  }
}
function ruleHolds(r: ScoreRule, v: unknown): boolean {
  if (r.cmp === 'present') return v !== undefined && v !== null && v !== '';
  if (v === undefined || v === null) return false;
  switch (r.cmp) {
    case 'eq':
      return v === r.value || String(v).toLowerCase() === String(r.value).toLowerCase();
    case 'neq':
      return !(v === r.value || String(v).toLowerCase() === String(r.value).toLowerCase());
    case 'gte':
      return typeof v === 'number' && typeof r.value === 'number' && v >= r.value;
    case 'lte':
      return typeof v === 'number' && typeof r.value === 'number' && v <= r.value;
    case 'in':
      return Array.isArray(r.value) && r.value.some((x) => String(x).toLowerCase() === String(v).toLowerCase());
    case 'contains':
      return typeof v === 'string' && typeof r.value === 'string' && v.toLowerCase().includes(r.value.toLowerCase());
  }
}

export function scoreLead(l: Lead, s: Scoring, now: number): ScoreResult {
  const parts: { why: string; points: number }[] = [];
  for (const r of s.rules) if (ruleHolds(r, fieldOf(l, r.field))) parts.push({ why: r.why ?? `${r.field} ${r.cmp}${r.value !== undefined ? ` ${String(r.value)}` : ''}`, points: r.points });
  if (s.perActivity) {
    const p = Math.min(s.activityCap ?? 20, l.activityCount * s.perActivity);
    if (p) parts.push({ why: `${l.activityCount} activities`, points: p });
  }
  const raw = parts.reduce((n, p) => n + p.points, 0);
  const idle = Math.max(0, (now - l.lastActivityAt) / DAY);
  const decay = s.halfLifeDays && s.halfLifeDays > 0 ? 0.5 ** (idle / s.halfLifeDays) : 1;
  const score = Math.max(0, Math.min(100, Math.round(raw * decay)));
  const grades = [...(s.grades ?? [{ grade: 'A', min: 70 }, { grade: 'B', min: 40 }, { grade: 'C', min: 15 }, { grade: 'D', min: 0 }])].sort((a, b) => b.min - a.min);
  return { score, grade: grades.find((g) => score >= g.min)?.grade ?? grades.at(-1)!.grade, parts, decay: Math.round(decay * 1000) / 1000 };
}

// -------------------------------------------------------------------------------------------------------------
// Assignment

export interface Owner {
  readonly id: string;
  readonly away?: boolean;
  /** Most open leads and deals this owner takes; unlimited if not set. */
  readonly capacity?: number;
}
export interface AssignRule {
  /** All must hold; no conditions matches everything. */
  readonly when?: readonly { readonly field: string; readonly cmp: Cmp; readonly value?: string | number | boolean | readonly (string | number)[] }[];
  /** A fixed owner, or a pool of owner ids. */
  readonly to: string | { readonly pool: readonly string[]; readonly by: 'round-robin' | 'least-loaded' };
}

export class Assigner {
  private readonly rules: readonly AssignRule[];
  private readonly owners: ReadonlyMap<string, Owner>;
  private readonly fallback: string | undefined;
  private readonly load = new Map<string, number>();
  private readonly cursor = new Map<number, number>();
  constructor(rules: readonly AssignRule[], owners: readonly Owner[], fallback?: string) {
    this.rules = rules;
    this.owners = new Map(owners.map((o) => [o.id, o]));
    this.fallback = fallback;
    for (const r of rules) {
      const ids = typeof r.to === 'string' ? [r.to] : r.to.pool;
      if (!ids.length) throw new CrmError('a pool has at least one owner');
      for (const id of ids) if (!this.owners.has(id)) throw new CrmError(`${id} is not a known owner`);
    }
    if (fallback && !this.owners.has(fallback)) throw new CrmError(`${fallback} is not a known owner`);
  }
  setLoad(owner: string, n: number): void {
    this.load.set(owner, n);
  }
  loadOf(owner: string): number {
    return this.load.get(owner) ?? 0;
  }
  private free(id: string): boolean {
    const o = this.owners.get(id)!;
    return !o.away && (o.capacity === undefined || this.loadOf(id) < o.capacity);
  }
  /** The owner for a lead, and which rule chose them; increases that owner's load. */
  assign(l: Lead): { owner: string; rule: number | 'fallback' } {
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i]!;
      if (!(r.when ?? []).every((c) => ruleHolds({ field: c.field, cmp: c.cmp, ...(c.value !== undefined ? { value: c.value } : {}), points: 0 }, fieldOf(l, c.field)))) continue;
      const ids = typeof r.to === 'string' ? [r.to] : r.to.pool;
      const ok = ids.filter((id) => this.free(id));
      if (!ok.length) continue;
      let pick: string;
      if (typeof r.to === 'string' || ok.length === 1) pick = ok[0]!;
      else if (r.to.by === 'least-loaded') pick = [...ok].sort((a, b) => this.loadOf(a) - this.loadOf(b) || ids.indexOf(a) - ids.indexOf(b))[0]!;
      else {
        const start = this.cursor.get(i) ?? 0;
        pick = ids[0]!;
        for (let k = 0; k < ids.length; k++) {
          const cand = ids[(start + k) % ids.length]!;
          if (this.free(cand)) {
            pick = cand;
            this.cursor.set(i, (start + k + 1) % ids.length);
            break;
          }
        }
      }
      this.load.set(pick, this.loadOf(pick) + 1);
      return { owner: pick, rule: i };
    }
    if (this.fallback) {
      this.load.set(this.fallback, this.loadOf(this.fallback) + 1);
      return { owner: this.fallback, rule: 'fallback' };
    }
    throw new CrmError('no owner is free and there is no fallback');
  }
}

// -------------------------------------------------------------------------------------------------------------
// Forecast

export interface ForecastOptions {
  /** Only deals expected to close from this date to this date, inclusive (YYYY-MM-DD). */
  readonly from: string;
  readonly to: string;
  readonly commitAt?: number;
  /** Quota in minor units, to compute attainment of closed won. */
  readonly quota?: number;
  /** Rates into the target currency, for mixed currencies: `{ EUR: 1.08 }` means 1 EUR = 1.08 of the target. */
  readonly rates?: Readonly<Record<string, number>>;
  readonly currency?: string;
}
export interface Forecast {
  readonly currency: string;
  readonly open: number;
  readonly weighted: number;
  readonly commit: number;
  readonly bestCase: number;
  readonly won: number;
  readonly lost: number;
  readonly attainment?: number;
  readonly byMonth: Readonly<Record<string, { weighted: number; open: number; won: number }>>;
  readonly byOwner: Readonly<Record<string, { weighted: number; open: number; won: number }>>;
  readonly byStage: Readonly<Record<string, { count: number; open: number; weighted: number }>>;
  readonly noCloseDate: number;
}

export class Pipeline {
  readonly def: PipelineDef;
  readonly leads = new Map<string, Lead>();
  readonly deals = new Map<string, Deal>();
  private readonly wf: Workflow;
  private readonly now: () => number;
  private readonly newId: (kind: 'lead' | 'deal' | 'activity') => string;
  private readonly byEmail = new Map<string, string>();
  private counter = 0;
  private readonly stageById: ReadonlyMap<string, Stage>;
  private readonly open: readonly Stage[];
  constructor(def: PipelineDef, o: { now?: () => number; id?: (kind: 'lead' | 'deal' | 'activity') => string } = {}) {
    const p = checkPipeline(def);
    if (p.length) throw new CrmError(`${def.name}: ${p.join('; ')}`);
    this.def = def;
    this.now = o.now ?? Date.now;
    this.newId = o.id ?? ((k) => `${k}-${++this.counter}`);
    this.stageById = new Map(def.stages.map((s) => [s.id, s]));
    this.open = def.stages.filter((s) => (s.kind ?? 'open') === 'open');
    const won = def.stages.find((s) => s.kind === 'won')!;
    const lost = def.stages.find((s) => s.kind === 'lost')!;
    const guardFor = (to: Stage) => (rec: Readonly<Record<string, unknown>>) => {
      const missing = (to.requires ?? []).filter((f) => rec[f] === undefined || rec[f] === null || rec[f] === '');
      return missing.length ? `${to.name} needs: ${missing.join(', ')}` : undefined;
    };
    const t: Transition[] = [];
    this.open.forEach((s, i) => {
      for (const later of this.open.slice(i + 1)) t.push({ from: s.id, to: later.id, action: `to:${later.id}`, roles: ['sales', 'manager'], guard: guardFor(later) });
      if (i > 0) t.push({ from: s.id, to: this.open[i - 1]!.id, action: `to:${this.open[i - 1]!.id}`, roles: ['sales', 'manager'] });
      t.push({ from: s.id, to: won.id, action: 'win', roles: ['sales', 'manager'], guard: (r) => guardFor(won)(r) ?? (typeof r.amount === 'number' && r.amount > 0 ? undefined : 'a won deal has an amount') });
      t.push({ from: s.id, to: lost.id, action: 'lose', roles: ['sales', 'manager'], guard: (r) => (typeof r.lostReason === 'string' && r.lostReason.trim() ? undefined : 'say why the deal was lost') });
    });
    t.push({ from: lost.id, to: this.open[0]!.id, action: 'reopen', roles: ['manager'] });
    this.wf = new Workflow({ name: def.name, start: this.open[0]!.id, final: [won.id, lost.id], transitions: t }, this.now);
  }

  // ---- leads

  createLead(i: { name: string; callMe?: string; email?: string; phone?: string; country?: string; company?: string; source?: string; attrs?: Record<string, string | number | boolean> }): Lead {
    const email = i.email?.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CrmError('that does not look like an email address');
    if (email && this.byEmail.has(email)) throw new Duplicate(this.byEmail.get(email)!, email);
    let phone: string | undefined;
    if (i.phone) {
      try {
        phone = e164(i.phone, i.country ?? 'US');
      } catch (e) {
        throw new CrmError(`phone: ${(e as Error).message}`);
      }
    }
    let nm: Name;
    try {
      nm = makeName(i.name, i.callMe ? { callMe: i.callMe } : {});
    } catch (e) {
      throw new CrmError((e as Error).message);
    }
    const t = this.now();
    const l: Lead = { id: this.newId('lead'), name: nm, ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(i.company ? { company: i.company.trim() } : {}), ...(i.source ? { source: i.source } : {}), ...(i.country ? { country: i.country.toUpperCase() } : {}), attrs: { ...(i.attrs ?? {}) }, status: 'new', createdAt: t, lastActivityAt: t, activityCount: 0 };
    this.leads.set(l.id, l);
    if (email) this.byEmail.set(email, l.id);
    return l;
  }

  lead(id: string): Lead {
    const l = this.leads.get(id);
    if (!l) throw new CrmError(`no lead ${id}`);
    return l;
  }

  touchLead(id: string): void {
    const l = this.lead(id);
    l.lastActivityAt = this.now();
    l.activityCount++;
    if (l.status === 'new') l.status = 'working';
  }

  assignLead(id: string, a: Assigner): string {
    const l = this.lead(id);
    const r = a.assign(l);
    l.owner = r.owner;
    return r.owner;
  }

  convertLead(id: string, d: { title?: string; amount: number; currency: string; expectedClose?: string }): Deal {
    const l = this.lead(id);
    if (l.status === 'converted') throw new CrmError(`${id} is already converted to ${l.dealId}`);
    if (l.status === 'disqualified') throw new CrmError(`${id} was disqualified`);
    if (!l.owner) throw new CrmError('give the lead an owner before converting it');
    const deal = this.createDeal({ title: d.title ?? (l.company ? `${l.company} deal` : `${l.name.full} deal`), amount: d.amount, currency: d.currency, owner: l.owner, ...(d.expectedClose ? { expectedClose: d.expectedClose } : {}), leadId: id });
    l.status = 'converted';
    l.dealId = deal.id;
    return deal;
  }

  // ---- deals

  createDeal(i: { title: string; amount: number; currency: string; owner: string; expectedClose?: string; leadId?: string }): Deal {
    if (!i.title.trim()) throw new CrmError('a deal has a title');
    if (!Number.isInteger(i.amount) || i.amount < 0 || i.amount > Number.MAX_SAFE_INTEGER / 1000) throw new CrmError('the amount is a whole number of minor units (cents), 0 or more');
    if (!/^[A-Z]{3}$/.test(i.currency)) throw new CrmError('the currency is a three-letter code like USD');
    if (i.expectedClose !== undefined && !validDate(i.expectedClose)) throw new CrmError('expectedClose is a real date like 2026-12-31');
    const t = this.now();
    const id = this.newId('deal');
    const wf = this.wf.start(id, i.owner, { amount: i.amount, ...(i.expectedClose ? { expectedClose: i.expectedClose } : {}) });
    const d: Deal = { id, title: i.title.trim(), amount: i.amount, currency: i.currency, owner: i.owner, ...(i.expectedClose ? { expectedClose: i.expectedClose } : {}), ...(i.leadId ? { leadId: i.leadId } : {}), createdAt: t, stageEnteredAt: t, activities: [], wf };
    this.deals.set(id, d);
    return d;
  }

  deal(id: string): Deal {
    const d = this.deals.get(id);
    if (!d) throw new CrmError(`no deal ${id}`);
    return d;
  }

  /** Sets a field a stage may require ("contract", "budget", ...). */
  setField(id: string, field: string, value: string | number | boolean): void {
    const d = this.deal(id);
    if (['amount', 'expectedClose', 'lostReason'].includes(field)) throw new CrmError(`${field} has its own way to change`);
    d.wf.data[field] = value;
  }

  update(id: string, ch: { amount?: number; expectedClose?: string; title?: string; owner?: string }): void {
    const d = this.deal(id);
    if (stageOf(d) === this.won.id || stageOf(d) === this.lost.id) throw new CrmError('a closed deal cannot be changed; reopen it first');
    if (ch.amount !== undefined) {
      if (!Number.isInteger(ch.amount) || ch.amount < 0) throw new CrmError('the amount is a whole number of minor units, 0 or more');
      d.amount = ch.amount;
      d.wf.data.amount = ch.amount;
    }
    if (ch.expectedClose !== undefined) {
      if (!validDate(ch.expectedClose)) throw new CrmError('expectedClose is a real date like 2026-12-31');
      d.expectedClose = ch.expectedClose;
      d.wf.data.expectedClose = ch.expectedClose;
    }
    if (ch.title !== undefined) d.title = ch.title.trim() || d.title;
    if (ch.owner !== undefined) d.owner = ch.owner;
  }
  private get won(): Stage {
    return this.def.stages.find((s) => s.kind === 'won')!;
  }
  private get lost(): Stage {
    return this.def.stages.find((s) => s.kind === 'lost')!;
  }

  /** The stage moves this person can make now, and why the others cannot. */
  moves(id: string, roles: readonly string[]) {
    return this.wf.actions(this.deal(id).wf, roles);
  }

  move(id: string, to: string, who: string, roles: readonly string[]): Deal {
    const d = this.deal(id);
    const st = this.stageById.get(to);
    if (!st) throw new CrmError(`no stage ${to}`);
    const action = st.kind === 'won' ? 'win' : st.kind === 'lost' ? 'lose' : d.wf.state === this.lost.id ? 'reopen' : `to:${to}`;
    const before = d.wf.state;
    this.wf.act(d.wf, action, who, roles);
    if (d.wf.state !== before) {
      d.stageEnteredAt = this.now();
      if (st.kind === 'won' || st.kind === 'lost') d.closedAt = this.now();
      else delete d.closedAt;
    }
    return d;
  }

  lose(id: string, who: string, roles: readonly string[], reason: string): Deal {
    const d = this.deal(id);
    const prev = d.lostReason;
    d.wf.data.lostReason = reason;
    try {
      this.move(id, this.lost.id, who, roles);
    } catch (e) {
      delete d.wf.data.lostReason;
      if (prev !== undefined) d.wf.data.lostReason = prev;
      throw e;
    }
    d.lostReason = reason.trim();
    return d;
  }

  win(id: string, who: string, roles: readonly string[]): Deal {
    return this.move(id, this.won.id, who, roles);
  }

  reopen(id: string, who: string, roles: readonly string[]): Deal {
    const d = this.deal(id);
    this.move(id, this.open[0]!.id, who, roles);
    delete d.lostReason;
    delete d.wf.data.lostReason;
    return d;
  }

  // ---- activities

  addActivity(id: string, a: { kind: ActivityKind; by: string; summary: string; at?: number; dueAt?: number }): Activity {
    const d = this.deal(id);
    if (!['call', 'email', 'meeting', 'note', 'task'].includes(a.kind)) throw new CrmError(`unknown activity ${a.kind}`);
    if (!a.summary.trim()) throw new CrmError('an activity has a summary');
    if (a.kind === 'task' && a.dueAt === undefined) throw new CrmError('a task has a due time');
    const act: Activity = { id: this.newId('activity'), kind: a.kind, by: a.by, at: a.at ?? this.now(), summary: a.summary.trim(), ...(a.dueAt !== undefined ? { dueAt: a.dueAt } : {}), ...(a.kind === 'task' ? { done: false } : {}) };
    d.activities.push(act);
    if (d.leadId && this.leads.has(d.leadId)) this.touchLead(d.leadId);
    return act;
  }

  completeTask(dealId: string, activityId: string): void {
    const a = this.deal(dealId).activities.find((x) => x.id === activityId);
    if (!a || a.kind !== 'task') throw new CrmError('no such task');
    a.done = true;
  }

  overdueTasks(): { deal: string; task: Activity; lateByDays: number }[] {
    const now = this.now();
    const out: { deal: string; task: Activity; lateByDays: number }[] = [];
    for (const d of this.deals.values()) for (const a of d.activities) if (a.kind === 'task' && !a.done && a.dueAt !== undefined && a.dueAt < now) out.push({ deal: d.id, task: a, lateByDays: Math.floor((now - a.dueAt) / DAY) });
    return out.sort((x, y) => y.lateByDays - x.lateByDays || x.deal.localeCompare(y.deal));
  }

  /** Open deals with no activity (or none since entering the stage) for longer than their stage allows. */
  rotting(): { deal: string; stage: string; idleDays: number; limit: number }[] {
    const now = this.now();
    const out: { deal: string; stage: string; idleDays: number; limit: number }[] = [];
    for (const d of this.deals.values()) {
      const st = this.stageById.get(stageOf(d))!;
      if ((st.kind ?? 'open') !== 'open' || st.rotAfterDays === undefined) continue;
      const lastTouch = Math.max(d.stageEnteredAt, ...d.activities.filter((a) => a.kind !== 'task' || a.done).map((a) => a.at));
      const idle = Math.floor((now - lastTouch) / DAY);
      if (idle > st.rotAfterDays) out.push({ deal: d.id, stage: st.id, idleDays: idle, limit: st.rotAfterDays });
    }
    return out.sort((a, b) => b.idleDays - a.idleDays || a.deal.localeCompare(b.deal));
  }

  // ---- forecast

  forecast(o: ForecastOptions): Forecast {
    if (!validDate(o.from) || !validDate(o.to) || o.from > o.to) throw new CrmError('from and to are real dates, from not after to');
    const cur = o.currency ?? [...this.deals.values()][0]?.currency ?? 'USD';
    const commitAt = o.commitAt ?? 0.75;
    const conv = (d: Deal): number => {
      if (d.currency === cur) return d.amount;
      const r = o.rates?.[d.currency];
      if (!r || !(r > 0)) throw new CrmError(`${d.id} is in ${d.currency}; give a rate to ${cur} or forecast one currency`);
      return Math.round(d.amount * r);
    };
    const zero = () => ({ weighted: 0, open: 0, won: 0 });
    const byMonth: Record<string, { weighted: number; open: number; won: number }> = {};
    const byOwner: Record<string, { weighted: number; open: number; won: number }> = {};
    const byStage: Record<string, { count: number; open: number; weighted: number }> = {};
    let open = 0, weighted = 0, commit = 0, won = 0, lost = 0, noClose = 0;
    for (const d of this.deals.values()) {
      const st = this.stageById.get(stageOf(d))!;
      const kind = st.kind ?? 'open';
      const when = kind === 'open' ? d.expectedClose : d.closedAt !== undefined ? new Date(d.closedAt).toISOString().slice(0, 10) : d.expectedClose;
      if (!when) {
        if (kind === 'open') noClose++;
        continue;
      }
      if (when < o.from || when > o.to) continue;
      const amt = conv(d);
      const month = when.slice(0, 7);
      const m = (byMonth[month] ??= zero());
      const ow = (byOwner[d.owner] ??= zero());
      if (kind === 'won') {
        won += amt;
        m.won += amt;
        ow.won += amt;
      } else if (kind === 'lost') lost += amt;
      else {
        const w = Math.round(amt * st.probability);
        open += amt;
        weighted += w;
        if (st.probability >= commitAt) commit += amt;
        m.open += amt;
        m.weighted += w;
        ow.open += amt;
        ow.weighted += w;
        const bs = (byStage[st.id] ??= { count: 0, open: 0, weighted: 0 });
        bs.count++;
        bs.open += amt;
        bs.weighted += w;
      }
    }
    return { currency: cur, open, weighted, commit, bestCase: open + won, won, lost, ...(o.quota ? { attainment: Math.round((won / o.quota) * 1000) / 1000 } : {}), byMonth, byOwner, byStage, noCloseDate: noClose };
  }
}
