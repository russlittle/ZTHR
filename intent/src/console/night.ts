/**
 * Maintenance, the night shift: what the day shift tagged, what the crew did with it, and what each block's gauges
 * score. Read from the records the crew and the mutation runs write; a record that is not there is reported as not
 * there, never filled in. "No shift has run yet" is a reading, not an error.
 */
import { BAR, KINDS, PRICES, STATIONS, kind as kindOf, model, standing, type Perf, type PriceTable, type Station, type TaskKind } from './crew.ts';
import { lamp } from './missionViews.ts';
import { esc } from './views.ts';

/** What is not working, where, how it is known, and the test that will prove it fixed. Raised instead of stopping the line. */
export interface Tag {
  readonly id: string;
  /** The area, gate, reviewer, run or report that raised it. */
  readonly raisedBy: string;
  readonly station: Station;
  readonly where: string;
  readonly what: string;
  readonly evidence: string;
  readonly proof: string;
  readonly state: TagState;
  readonly raisedAt: string;
  readonly closedAt?: string;
}
export type TagState = 'open' | 'in work' | 'fixed' | 'escalated' | 'equivalent';

export interface Task {
  readonly id: string;
  readonly tag: string;
  readonly kind: TaskKind;
  readonly state: 'queued' | 'in work' | 'accepted' | 'rejected' | 'escalated' | 'held';
  readonly shift?: string;
  readonly model?: string;
  readonly checkedBy?: string;
  readonly attempts?: number;
  readonly usd?: number;
}

export interface ShiftLog {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly budgetUSD: number;
  readonly spentUSD: number;
  readonly fixed: readonly { tag: string; task: string; evidence: string }[];
  readonly escalated: readonly { tag: string; to: string; why: string }[];
  readonly raised: readonly string[];
}

export interface Ruling {
  readonly id: string;
  readonly block: string;
  readonly mutant: string;
  readonly claimant: string;
  readonly judge: string;
  readonly verdict: 'equivalent' | 'not equivalent';
  readonly reasoning: string;
  readonly at: string;
}

export interface BlockScore {
  readonly block: string;
  readonly at: string;
  readonly score: number | null;
  readonly killed: number;
  readonly survived: number;
  readonly equivalent: number;
  readonly floor: number | null;
}

export interface Night {
  readonly schema: 'zthr-night/1';
  readonly tags: readonly Tag[];
  readonly tasks: readonly Task[];
  readonly shifts: readonly ShiftLog[];
  readonly rulings: readonly Ruling[];
  readonly scores: readonly BlockScore[];
  /** Files found where the records live that are not in a form this reads: counted, not guessed at. */
  readonly unread: readonly string[];
  /** Whether the crew's runner is serving yet. Until it is, no shift runs. */
  readonly runner: 'live' | 'not live yet';
}

export const NIGHT_URL = '/maintenance/night.json';

export const emptyNight = (): Night => ({ schema: 'zthr-night/1', tags: [], tasks: [], shifts: [], rulings: [], scores: [], unread: [], runner: 'not live yet' });

export function parseNight(raw: unknown): Night | null {
  const d = raw as Partial<Night> | null;
  if (!d || d.schema !== 'zthr-night/1') return null;
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return { schema: 'zthr-night/1', tags: arr(d.tags), tasks: arr(d.tasks), shifts: arr(d.shifts), rulings: arr(d.rulings), scores: arr(d.scores), unread: arr(d.unread), runner: d.runner === 'live' ? 'live' : 'not live yet' };
}

export async function loadNight(url = NIGHT_URL): Promise<Night | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? parseNight(await r.json()) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- readings

export const lastShift = (n: Night): ShiftLog | null => [...n.shifts].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null;

const OPEN: readonly Task['state'][] = ['queued', 'in work', 'held'];

/** The queue: tasks not yet settled, by kind in round order, and the station each came from. */
export function queue(n: Night): { kind: TaskKind; station: readonly Station[]; queued: number; inWork: number; held: number }[] {
  return KINDS.map((k) => {
    const ts = n.tasks.filter((t) => t.kind === k.key);
    return { kind: k.key, station: k.station, queued: ts.filter((t) => t.state === 'queued').length, inWork: ts.filter((t) => t.state === 'in work').length, held: ts.filter((t) => t.state === 'held').length };
  });
}

export function byStation(n: Night): { station: Station; open: number; escalated: number; fixed: number }[] {
  return STATIONS.map((s) => {
    const ts = n.tags.filter((t) => t.station === s.key);
    return { station: s.key, open: ts.filter((t) => t.state === 'open' || t.state === 'in work').length, escalated: ts.filter((t) => t.state === 'escalated').length, fixed: ts.filter((t) => t.state === 'fixed' || t.state === 'equivalent').length };
  });
}

/** Pass rate per model per kind, from every settled task: the router's evidence. */
export function performance(n: Night): Perf[] {
  const out = new Map<string, Perf>();
  for (const t of n.tasks) {
    if (!t.model || OPEN.includes(t.state)) continue;
    const k = `${t.model} ${t.kind}`;
    const p = out.get(k) ?? { model: t.model, kind: t.kind, attempts: 0, accepted: 0, usd: 0 };
    out.set(k, { ...p, attempts: p.attempts + (t.attempts ?? 1), accepted: p.accepted + (t.state === 'accepted' ? 1 : 0), usd: p.usd + (t.usd ?? 0) });
  }
  return [...out.values()].sort((a, b) => KINDS.findIndex((k) => k.key === a.kind) - KINDS.findIndex((k) => k.key === b.kind) || a.model.localeCompare(b.model));
}

/** Dollars spent on settled tasks, over the changes accepted: what a fix costs, failures included. Null until one is accepted. */
export function costPerAccepted(n: Night): number | null {
  const settled = n.tasks.filter((t) => !OPEN.includes(t.state));
  const accepted = settled.filter((t) => t.state === 'accepted').length;
  return accepted ? settled.reduce((a, t) => a + (t.usd ?? 0), 0) / accepted : null;
}

/** The median hours from a tag being raised to its fix being accepted. Null until a tag is fixed. */
export function tagToFix(n: Night): number | null {
  const hs = n.tags
    .filter((t) => (t.state === 'fixed' || t.state === 'equivalent') && t.closedAt)
    .map((t) => (Date.parse(t.closedAt!) - Date.parse(t.raisedAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  if (!hs.length) return null;
  const m = Math.floor(hs.length / 2);
  return hs.length % 2 ? hs[m]! : (hs[m - 1]! + hs[m]!) / 2;
}

export type ScoreLight = 'pass' | 'fail' | 'waiting' | 'not measured';

/** A block holds when no survivor is left but recorded equivalents; it fails below its floor; otherwise its survivors wait for the crew. */
export function scoreLight(s: BlockScore): ScoreLight {
  if (s.score === null) return 'not measured';
  if (s.floor !== null && s.score < s.floor) return 'fail';
  return s.survived === 0 ? 'pass' : 'waiting';
}

/** One line for the area: what the night shift has done, or that it has not run. */
export function status(n: Night): string {
  const s = lastShift(n);
  if (!s) return n.runner === 'live' ? 'No shift has run yet.' : 'No shift has run yet: the crew’s runner is not live yet.';
  return `${n.shifts.length} shift${n.shifts.length === 1 ? '' : 's'} logged; the latest started ${s.startedAt.slice(0, 10)}: ${s.fixed.length} fixed, ${s.escalated.length} escalated, ${s.raised.length} new on the list.`;
}

// ---------------------------------------------------------------- the panel

const stationLabel = (k: Station) => STATIONS.find((s) => s.key === k)!.label;
const money = (x: number) => `$${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)}`;
const pc = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;

export function headline(n: Night): string {
  const s = lastShift(n);
  const open = n.tags.filter((t) => t.state === 'open' || t.state === 'in work').length;
  if (!s)
    return `<section class="sheet measure" aria-label="The night shift"><div class="headline"><p class="eyebrowless">The night shift</p><p class="big">No shift has run yet</p><p class="verdict v-unk">${open ? `${open} tag${open === 1 ? '' : 's'} on the list, waiting for the first shift` : 'Nothing tagged yet: the list fills as the day shift tags what is not working'}</p><p class="muted small">${n.runner === 'live' ? 'The crew’s runner is live; its first shift’s morning report shows here.' : 'The crew’s runner is not live yet. Until it is, no shift runs, and this page says so.'}</p></div></section>`;
  const cls = s.escalated.length ? 'unk' : 'ok';
  return `<section class="sheet measure" aria-label="The night shift"><div class="headline"><p class="eyebrowless">The last shift, started ${esc(s.startedAt.slice(0, 16).replace('T', ' '))}</p><p class="big"><span class="num">${s.fixed.length}</span> fixed, with evidence</p><p class="verdict v-${cls}">${s.escalated.length} escalated · ${s.raised.length} new on the list · ${open} open</p><p class="muted small">Every fix went through the same gates as day work: a failing test first, then the fix, nothing weakened, and a check by another model family.</p></div></section>`;
}

export function queueTable(n: Night): string {
  const q = queue(n);
  const st = byStation(n);
  const total = q.reduce((a, r) => a + r.queued + r.inWork + r.held, 0);
  return `<ul class="lib-stats">${st.map((s) => `<li><span class="n">${s.open}</span> ${esc(stationLabel(s.station).toLowerCase())}</li>`).join('')}</ul>
<p class="small muted">Open tags by station. ${total ? `${total} task${total === 1 ? '' : 's'} in the queue.` : 'The queue is empty.'}</p>
<div class="tbl-wrap" tabindex="0" role="region" aria-label="The queue by kind"><table class="gtable"><thead><tr><th scope="col">Kind, in round order</th><th scope="col">Stations</th><th scope="col" class="num">Queued</th><th scope="col" class="num">In work</th><th scope="col" class="num">Held for budget</th><th scope="col">Accepted when</th></tr></thead><tbody>${q
    .map((r) => `<tr><th scope="row"><code>${r.kind}</code></th><td>${r.station.map((s) => esc(stationLabel(s))).join(', ')}</td><td class="num">${r.queued}</td><td class="num">${r.inWork}</td><td class="num">${r.held}</td><td class="small">${esc(kindOf(r.kind).accepted)}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

export function report(n: Night): string {
  const s = lastShift(n);
  if (!s) return '<p class="muted">No shift has run yet. The first shift ends with a morning report here: what was fixed, with its evidence; what was escalated, and why; and what is new on the list.</p>';
  const tag = (id: string) => n.tags.find((t) => t.id === id);
  const line = (id: string) => esc(tag(id)?.what ?? id);
  return `<p class="stamp-line">Shift ${esc(s.id)} · ${esc(s.startedAt.slice(0, 16).replace('T', ' '))} to ${s.endedAt ? esc(s.endedAt.slice(11, 16)) : 'still running'} · spent ${money(s.spentUSD)} of ${money(s.budgetUSD)}</p>
<h3 class="sub-h">Fixed, with evidence</h3>${s.fixed.length ? `<ul class="jlist">${s.fixed.map((f) => `<li class="jrow">${lamp('pass', 'fixed')}<span class="jgoal">${line(f.tag)}</span><span class="jmeta">${esc(f.evidence)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing fixed this shift.</p>'}
<h3 class="sub-h">Escalated, and why</h3>${s.escalated.length ? `<ul class="jlist">${s.escalated.map((e) => `<li class="jrow">${lamp('waiting', 'escalated')}<span class="jgoal">${line(e.tag)}</span><span class="jmeta">to ${esc(e.to)}: ${esc(e.why)}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing escalated this shift.</p>'}
<h3 class="sub-h">New on the list</h3>${s.raised.length ? `<ul class="jlist">${s.raised.map((id) => `<li class="jrow">${lamp('not measured', 'new')}<span class="jgoal">${line(id)}</span><span class="jmeta">${esc(tag(id) ? `${stationLabel(tag(id)!.station)} · raised by ${tag(id)!.raisedBy}` : 'not in the tag records')}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing new.</p>'}`;
}

const SCORE_WORD: Record<ScoreLight, string> = { pass: 'no survivors but recorded equivalents', fail: 'below its floor', waiting: 'survivors queued for the crew', 'not measured': 'not measured' };

export function scoresTable(n: Night): string {
  if (!n.scores.length) return '<p class="muted">No mutation run has reported a score yet.</p>';
  const rows = [...n.scores].sort((a, b) => a.block.localeCompare(b.block));
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Mutation scores per block"><table class="gtable"><thead><tr><th scope="col">Block</th><th scope="col">Score</th><th scope="col" class="num">Floor</th><th scope="col" class="num">Killed</th><th scope="col" class="num">Survived</th><th scope="col" class="num">Recorded equivalent</th></tr></thead><tbody>${rows
    .map((s) => {
      const l = scoreLight(s);
      return `<tr><th scope="row"><code>${esc(s.block)}</code></th><td>${lamp(l, SCORE_WORD[l])}${s.score === null ? 'not measured' : `${s.score.toFixed(1)}%`}</td><td class="num">${s.floor === null ? '<span class="muted">none</span>' : `${s.floor}%`}</td><td class="num">${s.killed}</td><td class="num">${s.survived}</td><td class="num">${s.equivalent}</td></tr>`;
    })
    .join('')}</tbody></table></div><p class="small muted">A block's score cannot go down. A higher floor is proposed for a person to sign; floors are person-only.</p>`;
}

export function crewTable(n: Night, t: PriceTable = PRICES): string {
  const perf = performance(n);
  const cpa = costPerAccepted(n);
  const ttf = tagToFix(n);
  const stats = `<ul class="lib-stats"><li><span class="n">${cpa === null ? '?' : money(cpa)}</span> per accepted change</li><li><span class="n">${ttf === null ? '?' : ttf < 48 ? `${ttf.toFixed(1)} h` : `${(ttf / 24).toFixed(1)} d`}</span> median, tag to fix</li><li><span class="n">${n.rulings.length}</span> rulings recorded</li></ul>`;
  const rates = perf.length
    ? `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Pass rate per model per kind"><table class="gtable"><thead><tr><th scope="col">Model</th><th scope="col">Kind</th><th scope="col" class="num">Attempts</th><th scope="col" class="num">Accepted</th><th scope="col">Pass rate</th><th scope="col" class="num">Spent</th></tr></thead><tbody>${perf
        .map((p) => {
          const s = standing(perf, p.model, p.kind);
          return `<tr><th scope="row">${esc(model(p.model, t)?.name ?? p.model)}</th><td><code>${p.kind}</code></td><td class="num">${p.attempts}</td><td class="num">${p.accepted}</td><td>${lamp(s === 'proven' ? 'pass' : s === 'below the bar' ? 'fail' : 'not measured', s)}${pc(p.accepted, p.attempts)} <span class="small muted">${s}</span></td><td class="num">${money(p.usd)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : '<p class="muted">No task has been settled yet, so no model has a pass rate. Every model starts on trial.</p>';
  return `${stats}${rates}<p class="small muted">A model is proven for a kind after ${BAR.attempts} attempts at ${Math.round(BAR.rate * 100)}% or better accepted. The router gives each task the cheapest proven model allowed to take it, moves a failed task a tier up, and holds what the day's budget cannot cover for the next shift.</p>`;
}

export function priceTable(t: PriceTable = PRICES): string {
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="The price table the router reads"><table class="gtable"><caption class="small muted">${esc(t.where)}, ${esc(t.unit)}, as listed on ${esc(t.checked)} at <a href="${esc(t.source)}">${esc(t.source.replace(/^https:\/\//, ''))}</a>. The router reads this table; it is re-read and re-dated, never assumed current.</caption><thead><tr><th scope="col">Model</th><th scope="col">Tier</th><th scope="col">Family</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th></tr></thead><tbody>${t.models
    .map((m) => `<tr><th scope="row">${esc(m.name)}</th><td>${m.tier}</td><td>${esc(m.family)}</td><td class="num">${m.price.in.toFixed(2)}</td><td class="num">${m.price.out.toFixed(2)}${m.price.longContext ? `<span class="small muted"> (${m.price.longContext.in.toFixed(2)} / ${m.price.longContext.out.toFixed(2)} from ${m.price.longContext.from / 1000}K input)</span>` : ''}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

/** The whole page body, in the order a person reads a morning: the report, the list, the gauges, the crew. */
export function nightBody(n: Night): string {
  const unread = n.unread.length ? `<p class="small muted">${n.unread.length} file${n.unread.length === 1 ? '' : 's'} where the records live ${n.unread.length === 1 ? 'is' : 'are'} not in a form this page reads, and ${n.unread.length === 1 ? 'is' : 'are'} not counted: ${n.unread.slice(0, 4).map((u) => `<code>${esc(u)}</code>`).join(', ')}${n.unread.length > 4 ? ' and more' : ''}.</p>` : '';
  return `${headline(n)}
<section class="sheet" aria-labelledby="h-rep"><h2 id="h-rep">The morning report</h2>${report(n)}</section>
<section class="sheet" aria-labelledby="h-q"><h2 id="h-q">The list, by station and kind</h2>${queueTable(n)}${unread}</section>
<section class="sheet" aria-labelledby="h-sc"><h2 id="h-sc">Gauge calibration: scores per block</h2>${scoresTable(n)}</section>
<section class="sheet" aria-labelledby="h-crew"><h2 id="h-crew">The crew: cost and pass rates</h2>${crewTable(n)}<h3 class="sub-h">The price table the router reads</h3>${priceTable()}</section>
<section class="sheet" aria-labelledby="h-run"><h2 id="h-run">Where the crew runs</h2><p>On the owner's Google Cloud project, through Workload Identity Federation: each run is given a short-lived identity, and no key is stored anywhere. ${n.runner === 'live' ? 'The runner is live.' : '<strong>The runner is not live yet.</strong> Until it is, no shift runs; the queue and the gauges above are read from the records the day shift writes.'}</p></section>`;
}
