/**
 * The intent studio: the whole front door in one page. The person writes, speaks or drops their intent; Claude
 * and any other model read it; every difference and gap is a redline answered in a tap; the schematic fills in
 * as they go; a revision is released as the package the factory builds to. The engine is the same one the
 * command line runs, so a release made here and one made there are the same bytes.
 */
import { checkReading, type Ballooned, type Question, type Slot } from '../frame.ts';
import { field } from '../form.ts';
import { htmlToMarkdown, isHtml } from '../intake/html.ts';
import { prepare, type Given, type Prepared } from '../pipeline.ts';
import { STAGES, stageOf, type Stage } from '../progress.ts';
import { readingPrompt } from '../prompt.ts';
import { ranked } from '../readback.ts';
import { release } from '../release.ts';
import { zip } from '../zip.ts';
import { graph, type Graph } from '../graph.ts';
import { suggestJourneys, type OwnJourney } from '../journeys.ts';
import { buildView, specSheet, outcomesView, reviewView, type TrailStep, datumStructure, detail, entities, inspectionPlan, intentMap, lineDetail, releasePreview, icon } from './views.ts';
import { manifest, type Manifest, type Source } from '../manifest.ts';
import { review, type Review } from '../review.ts';
import type { Tune } from '../pipeline.ts';
import { sha256 } from '../hash.ts';
import { settle, type Options } from '../interfaces.ts';
import { framework } from '../outcomes.ts';

// ---------------------------------------------------------------- platform capabilities, each optional

type Use = (name: string) => Promise<unknown>;
const claudeUse: Use = (name) => {
  const c = (window as unknown as { claude?: { use: Use } }).claude;
  return c ? c.use(name).catch(() => null) : Promise.resolve(null);
};

// ---------------------------------------------------------------- state

interface Issued {
  readonly revision: number;
  readonly reason: string | null;
  readonly package: string;
  readonly ready: boolean;
  readonly datum: { revision: number; statements: Ballooned[] };
  readonly balloons: Record<string, number>;
  /** What it was built from, so the same bytes can be rebuilt on any later visit. */
  readonly inputs?: { path: string; words: string; readings: unknown[]; answers: Record<string, Given>; journeys?: { accepted: string[]; own: OwnJourney[] }; options?: Options; people?: { holder?: { name: string; role: string }; tune?: Record<string, Tune> } };
}
interface State {
  v: 1;
  path: string;
  words: string;
  readings: unknown[];
  answers: Record<string, Given>;
  releases: Issued[];
  showAll: boolean;
  /** The person's signature on one exact datum: change a word and it lapses. */
  signed: { datum: string; at: string; by?: string } | null;
  /** Who holds the intent, and the product (part family) it belongs to. */
  holder: { name: string; role: string };
  product: string;
  /** How each person who will use it is tuned. */
  tune: Record<string, Tune>;
  /** The factory spec sheet: which interfaces are switched on. */
  options: Options;
  /** Answers the person took on the suggestion without being sure: carried as assumptions to revisit. */
  unsure: Record<string, true>;
  /** The question each answer was given to, so an answer can be shown and changed later. */
  asked: Record<string, string>;
  /** Questions put to the back for now: still open, just not in the way. */
  skipped: string[];
  /** Journeys the person added from the suggestions, and their own. */
  journeys: { accepted: string[]; own: OwnJourney[] };
  view: View;
  expanded: string[];
  previewFile: string;
  planFilter: string;
  zoom: number;
  wide: boolean;
  buildFilter: Source | 'all';
}
type View = 'map' | 'review' | 'hire' | 'outcomes' | 'structure' | 'plan' | 'build' | 'preview' | 'parts';
const VIEWS: readonly { key: View; label: string; ico: string }[] = [
  { key: 'map', label: 'Intent map', ico: 'end' },
  { key: 'review', label: 'Review', ico: 'scenario' },
  { key: 'hire', label: 'The hire', ico: 'doc' },
  { key: 'outcomes', label: 'Outcomes', ico: 'gauge' },
  { key: 'structure', label: 'Datum structure', ico: 'group' },
  { key: 'plan', label: 'Inspection plan', ico: 'gauge' },
  { key: 'build', label: 'Build manifest', ico: 'group' },
  { key: 'preview', label: 'Release preview', ico: 'scenario' },
  { key: 'parts', label: 'Parts list', ico: 'statement' },
];
const empty = (): State => ({ v: 1, path: 'intent.md', words: '', readings: [], answers: {}, releases: [], showAll: false, signed: null, unsure: {}, asked: {}, skipped: [], journeys: { accepted: [], own: [] }, view: 'map', expanded: [], previewFile: 'schematic.md', planFilter: 'all', zoom: 0, wide: false, buildFilter: 'all', holder: { name: '', role: '' }, product: '', tune: {}, options: {} });
let state: State = empty();
let prepared: Prepared | null = null;
let lastBalloons = new Set<number>();

const cssEsc = (v: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\\]\[]/g, '\\$&'));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const say = (id: string, text: string, bad = false) => {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('bad', bad);
};

// ---------------------------------------------------------------- saving: the person's own private space, or this browser

const LOCAL = 'intent-studio:v1';
let remote: { set(d: Record<string, unknown>): Promise<void>; get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> } | null = null;
let saving = false;
let pending = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave() {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(state));
  } catch {
    /* a browser that keeps nothing still works for this visit */
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 1200);
}
async function flush() {
  if (!remote) return;
  if (saving) {
    pending = true;
    return;
  }
  saving = true;
  try {
    await remote.set({ v: 1, json: JSON.stringify(state) });
    say('words-status', 'Saved to your private space.');
  } catch {
    say('words-status', 'Saved in this browser only.');
  } finally {
    saving = false;
    if (pending) {
      pending = false;
      void flush();
    }
  }
}

// ---------------------------------------------------------------- the engine, run on every change

function compute(): Prepared {
  const last = state.releases.at(-1);
  return prepare({
    files: [{ path: state.path, text: state.words }],
    readings: state.readings,
    answers: state.answers,
    journeys: state.journeys,
    people: { ...(state.holder.name || state.holder.role ? { holder: state.holder } : {}), tune: state.tune },
    options: state.options,
    ...(last ? { prior: last.balloons } : {}),
  });
}

/** One change on the spec sheet, as a new options object. */
function specChange(o: Options, key: string, t: HTMLInputElement | HTMLSelectElement): Options {
  const checked = (t as HTMLInputElement).checked;
  const toggle = (list: readonly string[] | undefined, v: string) => (checked ? [...new Set([...(list ?? []), v])] : (list ?? []).filter((x) => x !== v));
  switch (key) {
    case 'api-reach': return { ...o, api: { ...o.api, reach: t.value as 'off' | 'all' | 'some' } };
    case 'api-feature': return { ...o, api: { ...o.api, features: toggle(o.api?.features, t.value) } };
    case 'api-events': return { ...o, api: { ...o.api, events: checked } };
    case 'api-agents': return { ...o, api: { ...o.api, agents: checked } };
    case 'training-reach': return { ...o, training: { ...o.training, reach: t.value as 'off' | 'all' | 'some' } };
    case 'training-feature': return { ...o, training: { ...o.training, features: toggle(o.training?.features, t.value) } };
    case 'query': return { ...o, admin: { query: t.value as 'off' | 'non-production' | 'everywhere' } };
    case 'tickets': return { ...o, connect: { ...o.connect, tickets: t.value as never } };
    case 'wiki': return { ...o, connect: { ...o.connect, wiki: t.value as never } };
    case 'feed': return { ...o, connect: { ...o.connect, feed: checked } };
    case 'usage': return { ...o, usage: t.value as 'off' | 'counts' | 'consented' };
    case 'chat': return { ...o, connect: { ...o.connect, chat: t.value } };
    case 'feedTo': return { ...o, connect: { ...o.connect, feedTo: t.value } };
    case 'identity': return { ...o, connect: { ...o.connect, identity: t.value } };
    default: return o;
  }
}

const built = new WeakMap<Prepared, Map<string, ReturnType<typeof release>>>();
function currentRelease(p: Prepared, reason?: string) {
  const last = state.releases.at(-1);
  const key = `${last?.revision ?? 0}:${reason ?? ''}`;
  const m = built.get(p) ?? new Map<string, ReturnType<typeof release>>();
  built.set(p, m);
  const hit = m.get(key);
  if (hit) return hit;
  const out = buildRelease(p, last, reason);
  m.set(key, out);
  return out;
}
function buildRelease(p: Prepared, last: Issued | undefined, reason?: string) {
  return release(p, { revision: (last?.revision ?? 0) + 1, ...(last ? { prior: { revision: last.revision, datum: last.datum } } : {}), ...(reason ? { reason } : {}) });
}

function stage(p: Prepared): Stage {
  const last = state.releases.at(-1);
  if (last && last.ready) {
    const again = release(p, { revision: last.revision, ...(state.releases.length > 1 ? { prior: { revision: state.releases.at(-2)!.revision, datum: state.releases.at(-2)!.datum }, reason: last.reason ?? '' } : {}) });
    const same = JSON.parse(again.files['manifest.json']!).package === last.package;
    if (same) return 'released';
  }
  if (!state.words.trim()) return 'rough';
  return stageOf(p, false, isSigned(p));
}

function datumHash(p: Prepared): string {
  return sha256(currentRelease(p, 'check').files['datum.json']!);
}
function isSigned(p: Prepared): boolean {
  return !!state.signed && !p.questions.length && !p.unread.length && state.signed.datum === datumHash(p);
}

let wordsOpenedByPerson = false;

function render(fromAnswer = false) {
  prepared = compute();
  const has = !!state.words.trim();
  document.body.classList.toggle('has-words', has);
  const box = document.getElementById('words-box') as HTMLDetailsElement | null;
  if (box) {
    if (!has) box.open = true;
    else if (!wordsOpenedByPerson && box.open && document.activeElement?.id !== 'words') box.open = false;
    const lines = state.words.split('\n').filter((l) => l.trim()).length;
    $('words-meta').innerHTML = has ? `<span class="closed-only">${lines} line${lines === 1 ? '' : 's'} · Edit</span>` : '';
  }
  const rb = document.getElementById('readings-meta');
  if (rb) {
    const ok = state.readings.filter((r) => checkReading(r).ok).length;
    rb.innerHTML = `<span class="closed-only">${ok ? `${ok} reading${ok === 1 ? '' : 's'}` : 'none yet: add one'}</span>`;
  }
  lastGraph = graph(prepared);
  lastManifest = manifest(prepared);
  lastReview = review(prepared);
  lastFiles = currentRelease(prepared, state.releases.length ? 'preview' : undefined).files;
  renderSteps(prepared);
  renderReadings(prepared);
  renderRedlines(prepared, fromAnswer);
  renderSheet(prepared);
  renderRelease(prepared);
  renderChain(prepared);
}

/** The chain at the top: what these words have become so far, each step a way into the view that shows it. */
function renderChain(p: Prepared) {
  const el = $('chain');
  if (!state.words.trim() || !lastGraph || !lastManifest) {
    el.className = 'chain promise';
    el.innerHTML = [
      ['Your words', 'rough is fine'],
      ['A numbered schematic', 'every statement traced to its source'],
      ['A few questions', 'only the ones that change the build'],
      ['A build manifest', 'what exists, and what gets made'],
      ['Journeys that prove it', 'walked as a person would'],
    ]
      .map(([n, w]) => `<li><span class="link" role="presentation"><span class="n">${n}</span><span class="w">${w}</span></span></li>`)
      .join('') + '<li><button type="button" class="link go" data-chain="example"><span class="n">See it on an example</span><span class="w">one click, nothing sent anywhere</span></button></li>';
    return;
  }
  el.className = 'chain';
  const lines = state.words.split('\n').filter((l) => l.trim()).length;
  const checks = lastGraph.nodes.filter((n) => n.lane === 'instruments').length;
  const m = lastManifest;
  const made = m.counts['make: catalogued'] + m.counts['make: new'];
  const journeys = lastGraph.nodes.filter((n) => n.kind === 'gauge').length;
  const q = p.questions.length;
  const suggested = suggestJourneys(p).filter((x) => !state.journeys.accepted.includes(x.id)).length;
  const step = (n: string | number, w: string, go: string, cls = '') => `<li><button type="button" class="link ${cls}" data-chain="${go}"><span class="n">${n}</span><span class="w">${w}</span></button></li>`;
  el.innerHTML = [
    step(lines, `line${lines === 1 ? '' : 's'} in your words`, 'words'),
    step(p.statements.length, 'numbered statements on the schematic', 'map'),
    q ? step(q, `question${q === 1 ? '' : 's'} only you can settle`, 'redlines', 'red') : step('0', 'questions left: ready to sign', 'release'),
    step(checks, 'tests and checks that will hold it', 'plan'),
    step(m.lines.length, `parts to build it: ${made} the library lacks today`, 'build'),
    step(journeys, `${journeys === 1 ? 'journey proves' : 'journeys prove'} it works${suggested ? `; ${suggested} more suggested` : ''}`, 'plan'),
  ].join('');
}

// ---------------------------------------------------------------- the stepper

function renderSteps(p: Prepared) {
  const s = stage(p);
  const i = STAGES.findIndex((x) => x.key === s);
  document.body.dataset['step'] = String(i + 1);
  $('steps').innerHTML = `<div class="track" aria-hidden="true"><div class="fill" style="--to:${Math.round((i / (STAGES.length - 1)) * 100)}%"></div></div><ol>${STAGES.map(
    (x, k) => `<li class="${k < i ? 'done' : k === i ? 'now' : 'next'}"${k === i ? ' aria-current="step"' : ''}><button type="button" class="jump" data-jump="${k + 1}" aria-label="Step ${k + 1}, ${x.label}${k < i ? ', done' : k === i ? ', you are here' : ''}: go to it"><span class="dot" aria-hidden="true">${k < i ? '✓' : k + 1}</span><span class="name">${x.label}</span></button></li>`,
  ).join('')}</ol><p class="doing">Step ${i + 1} of ${STAGES.length}: ${esc(state.words.trim() ? STAGES[i]!.doing : 'Start with a few rough lines, or try the example.')}</p>`;
}

// ---------------------------------------------------------------- readings

function renderReadings(p: Prepared) {
  const items = state.readings.map((r, i) => {
    const c = checkReading(r);
    const fam = typeof r === 'object' && r !== null && typeof (r as { family?: unknown }).family === 'string' ? (r as { family: string }).family : 'unknown';
    return `<li><span class="fam">${esc(fam)}</span>: ${c.ok ? 'read' : `not usable (${esc(c.problems.join('; '))})`} <button class="btn quiet" type="button" data-remove-reading="${i}">Remove</button></li>`;
  });
  $('readings').innerHTML = items.join('') || '<li class="note">No readings yet. Your words are checked by rule as you type; readings add what rules cannot.</li>';
  const families = new Set(state.readings.filter((r) => checkReading(r).ok).map((r) => (r as { family: string }).family));
  if (p.unread.length && state.words.trim()) say('read-status', families.size === 1 ? 'One family has read this. Its reading shows as proposals for you to confirm; a second family turns agreement into fact.' : '');
}

// ---------------------------------------------------------------- redlines

function renderRedlines(p: Prepared, fromAnswer: boolean) {
  const form = $('redlines');
  const panel = $('redlines-panel');
  if (!state.words.trim()) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const budget = state.showAll ? 99 : 5;
  const later = new Set(state.skipped);
  const now = ranked(p.questions.filter((q) => !later.has(q.id)), budget);
  const back = ranked(p.questions.filter((q) => later.has(q.id)), Math.max(0, budget - now.ask.length));
  const ask = [...now.ask, ...back.ask];
  const held = p.questions.length - ask.length;
  const settled = Object.keys(state.answers).length;
  const total = settled + p.questions.length;
  $('h-redlines').textContent = ask.length ? 'Redlines: questions to settle' : 'No redlines left';
  $('redlines-count').innerHTML = total ? `<span>${settled} settled, ${p.questions.length} to go</span><span class="meter" aria-hidden="true"><span style="width:${Math.round((settled / total) * 100)}%"></span></span>` : '';
  $('redlines-lede').textContent = ask.length ? 'Each one changes what gets built. Tap an answer; "Other" is always there.' : 'Everything that would change what gets built is settled. Check the schematic, then release it.';
  // In the studio nothing is pre-chosen: a recommended option is marked, and one tap takes it.
  form.innerHTML =
    ask
      .map((q, i) => {
        const rec = q.answer && 'recommended' in q.answer ? q.answer.recommended : undefined;
        const unsure = rec
          ? `<button class="btn quiet unsure" type="button" data-unsure="${esc(q.id)}" data-pick="${esc(rec)}">Not sure yet: use the recommended answer for now</button>`
          : later.has(q.id) || ask.length < 2
            ? ''
            : `<button class="btn quiet unsure" type="button" data-skip="${esc(q.id)}">Skip for now</button>`;
        return field(q, i + 1).replace(/ checked>/g, '>').replace(/<\/fieldset>(?![\s\S]*<\/fieldset>)/, `${unsure}</fieldset>`);
      })
      .join('') +
    (held ? `<p class="held">${held} smaller redline${held === 1 ? '' : 's'} can wait. <button class="btn quiet" type="button" id="show-all">Show all</button></p>` : '') +
    (state.showAll && p.questions.length > 5 ? '<p class="held"><button class="btn quiet" type="button" id="show-fewer">Show the most important five</button></p>' : '');
  syncBranches();
  renderAnswers();
  if (fromAnswer && !ask.length) {
    const sign = document.getElementById('sign');
    say('redlines-status', 'All settled. Check the schematic, then sign it below.');
    sign?.focus();
    return;
  }
  if (fromAnswer) {
    say('redlines-status', `Settled. ${p.questions.length} to go.`);
    const next = form.querySelector<HTMLInputElement>('fieldset:not(.nested) input, fieldset:not(.nested) textarea');
    next?.focus({ preventScroll: false });
  }
}

function renderAnswers() {
  const ids = Object.keys(state.answers);
  const box = $('answers');
  box.hidden = !ids.length;
  if (!ids.length) return;
  const show = (g: Given) => [g.pick, ...(g.picks ?? []), g.yes ? 'Yes' : undefined, g.other].filter(Boolean).join(', ');
  box.innerHTML = `<summary>Your answers (${ids.length})</summary><ul>${ids
    .map((id) => `<li><span class="q">${esc(state.asked[id] ?? id)}</span> <strong>${esc(show(state.answers[id]!))}</strong>${state.unsure[id] ? ' <span class="state assumed">not sure yet</span>' : ''} <button class="btn quiet" type="button" data-undo="${esc(id)}">Change</button></li>`)
    .join('')}</ul>`;
}

function syncBranches() {
  const form = $('redlines');
  form.querySelectorAll<HTMLElement>('.follow[data-when]').forEach((f) => {
    const on = document.getElementById(f.dataset['when'] ?? '') as HTMLInputElement | null;
    f.hidden = !on?.checked;
  });
  form.querySelectorAll<HTMLElement>('.follow[data-when-any]').forEach((f) => {
    const fs = form.querySelector(`fieldset[data-q="${f.dataset['whenAny']}"]`);
    f.hidden = !fs?.querySelector(':scope > .opt input:checked');
  });
}

/** The answer one fieldset holds now: picks, a yes, or the person's own words. */
function gather(fs: Element): { id: string; given: Given | null } | null {
  const named = fs.querySelector<HTMLInputElement | HTMLTextAreaElement>(':scope > .opt [name], :scope > textarea');
  if (!named) return null;
  const given: { pick?: string; picks?: string[]; yes?: boolean; other?: string } = {};
  const picks: string[] = [];
  fs.querySelectorAll<HTMLInputElement>(':scope > .opt input[type=radio]:checked, :scope > .opt input[type=checkbox]:checked').forEach((i) => {
    if (i.value === '__yes__') given.yes = true;
    else if (i.value === '__other__') {
      const t = fs.querySelector<HTMLInputElement>(':scope > .opt .other-text')?.value.trim();
      if (t) given.other = t;
    } else picks.push(i.value);
  });
  const area = fs.querySelector<HTMLTextAreaElement>(':scope > textarea');
  if (area?.value.trim()) given.other = area.value.trim();
  if (picks.length) {
    if (fs.querySelector(':scope > .opt input[type=checkbox]')) given.picks = picks;
    else given.pick = picks[0]!;
  }
  return { id: named.name, given: Object.keys(given).length ? given : null };
}

// ---------------------------------------------------------------- the schematic

const HEAD: Record<Slot, string> = {
  problem: 'The problem',
  why: 'Why it matters',
  outcome: 'When it works',
  people: 'Who it is for, and who else it reaches',
  constraints: 'What it must do, and must never do',
  measures: 'How everyone will know it worked',
  nonGoals: 'Left out on purpose',
  prerequisites: 'What it will also need',
  implications: 'What else this affects',
  assumptions: 'Taken as given',
};

function source(s: Ballooned): string {
  switch (s.supplied.kind) {
    case 'person':
      return s.supplied.origin ? `your words, line ${s.supplied.origin.line}` : 'your answer';
    case 'parse':
      return `both readings (${s.supplied.families.join(' and ')})`;
    case 'lexicon':
      return `from your word "${s.words ?? s.supplied.term}"`;
    case 'derived':
      return `follows from "${s.words ?? ''}"`;
    case 'part':
      return `the ${s.supplied.part} part`;
  }
}

function stmt(s: Ballooned, fresh: boolean): string {
  const state = s.state === 'confirmed' ? 'yours' : s.state === 'assumed' ? 'a reading: change it if wrong' : s.state === 'default' ? 'a default' : 'open';
  const tol = s.tolerance && s.tolerance !== 'exactly as stated' ? `, held to ${esc(s.tolerance)}` : '';
  const quote = s.words && s.words !== s.text && s.supplied.kind !== 'person' ? ` <span class="words-q">You said "${esc(s.words)}".</span>` : '';
  return `<div class="stmt${fresh ? ' stamp' : ''}" id="b${s.balloon}"><span class="balloon" aria-label="Balloon ${s.balloon}">${s.balloon}</span><div>${esc(s.text)}${tol}${s.mark ? `<span class="mark ${s.mark}">${s.mark}</span>` : ''}<span class="src"><span class="state ${s.state}">${state}</span> · ${esc(source(s))}.${quote} <button class="btn link" type="button" data-not-quite="${s.balloon}" aria-label="Not quite: correct balloon ${s.balloon}">Not quite?</button></span></div></div>`;
}

function renderSheet(p: Prepared) {
  const now = new Set(p.statements.map((s) => s.balloon));
  const fresh = new Set([...now].filter((b) => !lastBalloons.has(b)));
  const first = lastBalloons.size === 0;
  lastBalloons = now;
  const sheet = $('sheet');
  const zones = `<div class="zones top" aria-hidden="true">${[8, 7, 6, 5, 4, 3, 2, 1].map((n) => `<span>${n}</span>`).join('')}</div><div class="zones side" aria-hidden="true">${['D', 'C', 'B', 'A'].map((n) => `<span>${n}</span>`).join('')}</div>`;
  const revs = state.releases.length
    ? state.releases
        .map((r) => `<tr><td>${r.revision}</td><td>${esc(r.reason ?? 'First release')}</td><td>${r.ready ? 'released' : 'draft'}</td></tr>`)
        .join('')
    : '<tr><td colspan="3">Not released yet</td></tr>';
  const head = `<div class="sheet-head"><div><h2 id="sheet-title"><span class="proc" data-step="4">4</span>${esc(p.model.title && p.model.title !== state.path ? p.model.title : 'Untitled intent')}</h2>${p.model.end ? `<p class="end"><strong>To what end:</strong> ${esc(p.model.end)}</p>` : ''}</div><div class="revblock"><table><thead><tr><th>Rev</th><th>Why</th><th>Status</th></tr></thead><tbody>${revs}</tbody></table></div></div>`;
  if (!state.words.trim()) {
    sheet.innerHTML = `${zones}${head}<p class="empty">The schematic fills in here as you write: every statement numbered, with where it came from. Start with a few rough lines, or try the example.</p>${titleBlock(p)}`;
    return;
  }
  const feel = p.statements.filter((s) => s.supplied.kind === 'lexicon' && s.slot === 'constraints');
  const sections: string[] = [];
  const order: Slot[] = ['problem', 'why', 'outcome', 'people', 'constraints', 'measures', 'nonGoals', 'prerequisites', 'implications', 'assumptions'];
  for (const slot of order) {
    const items = p.statements.filter((s) => s.slot === slot && !(s.supplied.kind === 'lexicon' && s.slot === 'constraints'));
    if (items.length) sections.push(`<section><h3>${HEAD[slot]}</h3>${items.map((s) => stmt(s, !first && fresh.has(s.balloon))).join('')}</section>`);
    if (slot === 'people' && feel.length) sections.push(`<section><h3>How it should feel</h3>${feel.map((s) => stmt(s, !first && fresh.has(s.balloon))).join('')}</section>`);
  }
  const notes = p.model.notes.length ? `<section class="notes"><h3>Engineering notes: how, for now</h3><ul>${p.model.notes.map((n) => `<li>${esc(n.text)} <span class="src">${n.stance === 'ideal' ? 'the ideal' : 'the practical choice now'}${n.reason ? '' : '; no reason given'}</span></li>`).join('')}</ul></section>` : '';
  const variants = p.model.variants.length ? `<section class="variants"><h3>Variants</h3><ul>${p.model.variants.map((v) => `<li><strong>${esc(v.id)}</strong>: ${esc(v.text)}. <span class="src">${v.effectivity ? `Applies to ${esc(v.effectivity)}` : 'Where it applies: not stated'}</span></li>`).join('')}</ul></section>` : '';
  const changed = Object.entries(p.title).filter(([, e]) => e.from !== 'default');
  const defaults = changed.length ? `<section><h3>Defaults for everything above</h3><ul>${changed.map(([k, e]) => `<li><strong>${esc(k)}</strong>: ${esc(e.value)}${e.from.startsWith('"') ? ` <span class="src">because you said ${esc(e.from)}</span>` : ''}</li>`).join('')}</ul></section>` : '';
  const parts = `${sections.join('')}${notes}${variants}${defaults}`;
  const canvas = document.getElementById('canvas');
  const keep = canvas ? { left: canvas.scrollLeft, top: canvas.scrollTop } : null;
  const tabs = `<div class="tabs" role="tablist" aria-label="Views of the schematic">${VIEWS.map((v) => `<button type="button" role="tab" id="tab-${v.key}" aria-controls="view" aria-selected="${state.view === v.key}" tabindex="${state.view === v.key ? 0 : -1}" data-view="${v.key}">${icon(v.ico)}<span>${v.label}</span>${tabCount(p, v.key)}</button>`).join('')}</div>`;
  sheet.innerHTML = `${zones}${head}${tabs}<div class="view v-${state.view}" id="view" role="tabpanel" aria-labelledby="tab-${state.view}">${viewBody(p, parts)}</div>${titleBlock(p)}`;
  document.body.classList.toggle('wide', state.wide);
  const svg = document.querySelector<SVGSVGElement>('#canvas svg');
  if (svg) {
    if (lastViewShown !== state.view) svg.classList.add('enter');
    const natural = Number(svg.getAttribute('width'));
    const room = (document.getElementById('canvas')?.clientWidth ?? natural) - 2;
    const z = state.zoom === 0 ? Math.max(svg.classList.contains('vertical') ? 0.3 : 0.72, Math.min(1.25, room / natural)) : state.zoom;
    svg.style.width = `${natural * z}px`;
    const label = document.querySelector('[data-zoom="0"]');
    if (label) label.textContent = state.zoom === 0 ? `Fit ${Math.round(z * 100)}%` : `${Math.round(z * 100)}%`;
  }
  lastViewShown = state.view;
  const c2 = document.getElementById('canvas');
  if (c2 && keep) {
    c2.scrollLeft = keep.left;
    c2.scrollTop = keep.top;
  }
  if (drawerFor) openDrawer(drawerFor, false);
}

// ---------------------------------------------------------------- the views

let lastGraph: Graph | null = null;
let lastManifest: Manifest | null = null;
let lastReview: Review | null = null;
let lastViewShown: View | null = null;
const narrow = () => typeof window !== 'undefined' && window.innerWidth < 700;
let wasNarrow = narrow();
let lastFiles: Readonly<Record<string, string>> = {};
let drawerFor: { kind: 'node' | 'entity' | 'line'; id: string } | null = null;

/** Who has shaped this intent, and when: the holder's words, each reading, the answers, the signature, each release. */
function trailOf(p: Prepared): TrailStep[] {
  const holder = state.holder.name || 'The person who holds it';
  const lines = state.words.split('\n').filter((l) => l.trim()).length;
  const fams = state.readings.filter((r) => checkReading(r).ok).map((r) => (r as { family: string }).family);
  const out: TrailStep[] = [{ who: holder, what: `wrote the intent in their own words: ${lines} line${lines === 1 ? '' : 's'}${state.holder.role ? `, as ${state.holder.role}` : ''}` }];
  if (fams.length) out.push({ who: fams.join(' and '), what: `read it independently${fams.some((f) => f.startsWith('sample-')) ? ' (hand-written samples for the example)' : ''}; where they agreed it went on the schematic for confirming, where they differed it became a question` });
  out.push({ who: 'The rules', what: `added ${p.statements.filter((s) => s.supplied.kind === 'derived' || s.supplied.kind === 'lexicon').length} statements from your words, each showing which words it came from` });
  const answered = Object.keys(state.answers).length;
  if (answered) out.push({ who: holder, what: `settled ${answered} question${answered === 1 ? '' : 's'}${Object.keys(state.unsure).length ? `, ${Object.keys(state.unsure).length} on the recommended answer for now` : ''}` });
  const tuned = Object.keys(state.tune).filter((k) => Object.values(state.tune[k] ?? {}).some(Boolean));
  if (tuned.length) out.push({ who: holder, what: `tuned ${tuned.join(' and ')} to how they will really use it` });
  if (state.journeys.accepted.length || state.journeys.own.length) out.push({ who: holder, what: `added ${state.journeys.accepted.length + state.journeys.own.length} journeys to the inspection plan` });
  if (state.signed) out.push({ who: state.signed.by || holder, what: 'signed the schematic as what they mean', when: new Date(state.signed.at).toLocaleString() });
  for (const r of state.releases) out.push({ who: state.signed?.by || holder, what: `released revision ${r.revision}${r.reason ? `: ${r.reason}` : ''}${r.ready ? '' : ' as a draft'}` });
  return out;
}

function tabCount(p: Prepared, v: View): string {
  if (!lastGraph) return '';
  const n = v === 'map' ? lastGraph.nodes.length : v === 'plan' ? lastGraph.nodes.filter((x) => x.lane === 'instruments').length : v === 'preview' ? Object.keys(lastFiles).length : v === 'build' ? (lastManifest?.lines.length ?? 0) : v === 'review' ? 0 : v === 'outcomes' ? p.statements.filter((x) => x.slot === 'outcome').length : v === 'parts' ? p.statements.length : 0;
  return n ? `<span class="tab-n">${n}</span>` : '';
}

function priorFiles(): { files: Readonly<Record<string, string>>; rev: number } | null {
  const last = state.releases.at(-1);
  if (!last) return null;
  const f = packages.get(last.revision) ?? rebuild(last.revision);
  return f ? { files: f, rev: last.revision } : null;
}

function people(p: Prepared): string[] {
  return [...new Set(p.statements.filter((s) => s.slot === 'people').map((s) => s.text.replace(/\s*\(.*\)$/, '')))];
}

function viewBody(p: Prepared, parts: string): string {
  const g = lastGraph!;
  const wide = `<button type="button" class="btn quiet wide-toggle" data-wide aria-pressed="${state.wide}">${state.wide ? 'Back to the desk' : 'Full width'}</button>`;
  const zoom = `${wide}<div class="zoom" role="group" aria-label="Zoom"><button type="button" class="btn quiet" data-zoom="-1" aria-label="Zoom out">−</button><button type="button" class="btn quiet" data-zoom="0" aria-label="Fit to width, or full size">Fit</button><button type="button" class="btn quiet" data-zoom="1" aria-label="Zoom in">+</button></div>`;
  switch (state.view) {
    case 'map': {
      const legend = `<ul class="legend" aria-label="Key"><li><span class="lg solid"></span>yours</li><li><span class="lg dashed"></span>read from your words</li><li><span class="lg dotted"></span>a default</li><li><svg width="26" height="14" aria-hidden="true"><path class="cloud" d="M2 12a4 4 0 0 1 4-8a5 5 0 0 1 9 0a4 4 0 0 1 9 4"/></svg>open question</li><li><span class="mini-balloon">7</span>balloon</li>${['gauge', 'forbidden', 'ratchet', 'scenario', 'control'].map((k) => `<li>${icon(k)}${k === 'gauge' ? 'journey' : k === 'forbidden' ? 'never' : k}</li>`).join('')}</ul>`;
      return `<div class="view-bar"><p class="view-lede">${narrow() ? 'Read down for how, up for why. Tap any box to see where it came from and what checks it.' : 'Read right to left for how, left to right for why. Select any box to see where it came from and what checks it; hover to trace its lines.'}</p>${zoom}</div>${legend}<div class="canvas" id="canvas" tabindex="-1" style="--z:${state.zoom}">${intentMap(g, { expanded: new Set(state.expanded), focus: null, vertical: narrow() })}</div>`;
    }
    case 'structure': {
      const valid = state.readings.filter((r) => checkReading(r).ok) as { family: string }[];
      const es = entities(g, {
        sources: p.model.sources.length,
        readings: valid.length,
        families: valid.map((r) => r.family),
        revisions: state.releases.length,
        files: Object.keys(lastFiles).length,
        defaults: Object.keys(p.title).length,
        notes: p.model.notes.length,
        variants: p.model.variants.length,
        questions: p.questions.length,
        suggested: suggestJourneys(p).filter((x) => !state.journeys.accepted.includes(x.id)).length,
      });
      return `<div class="view-bar"><p class="view-lede">The parts of this intent, how many of each, and how they relate. One statement, many journeys; each part opens its list.</p>${zoom}</div><div class="canvas" id="canvas" tabindex="-1" style="--z:${state.zoom}">${datumStructure(es, null)}</div>`;
    }
    case 'plan':
      return inspectionPlan(g, suggestJourneys(p), new Set(state.journeys.accepted), state.planFilter, people(p));
    case 'review':
      return reviewView(lastReview!, state.holder, state.tune, trailOf(p), state.product);
    case 'hire':
      return `<div class="view-bar"><p class="view-lede">The same schematic, in the terms a leader uses for any hire: the job, how you would know it is done well, and what would make it a good hire a year from now.</p></div>${hireCard(p)}`;
    case 'outcomes':
      return outcomesView(framework(p, lastManifest!), p.questions);
    case 'build':
      return specSheet(lastManifest!, settle(state.options)) + buildView(lastManifest!, state.buildFilter, p.model.title && p.model.title !== state.path ? p.model.title : 'this intent', `${wide}<div class="zoom" role="group" aria-label="Zoom"><button type="button" class="btn quiet" data-zoom="-1" aria-label="Zoom out">−</button><button type="button" class="btn quiet" data-zoom="0" aria-label="Fit to width, or full size">Fit</button><button type="button" class="btn quiet" data-zoom="1" aria-label="Zoom in">+</button></div>`);
    case 'preview': {
      const prior = priorFiles();
      const open = lastFiles[state.previewFile] !== undefined ? state.previewFile : 'schematic.md';
      return `<div class="view-bar"><p class="view-lede">Every file the release will carry, exactly as the factory will read it. ${prior ? `Changes since revision ${prior.rev} are marked.` : 'Nothing is issued until you release it.'}</p>${wide}</div>${releasePreview(lastFiles, prior?.files ?? null, open, prior?.rev ?? null)}`;
    }
    default:
      return parts;
  }
}

/** Trace one box's lines without redrawing: everything not touching it fades. */
function highlight(id: string | null) {
  const svg = document.querySelector<SVGElement>('#canvas svg');
  if (!svg) return;
  svg.classList.toggle('tracing', !!id);
  const near = new Set<string>(id ? [id] : []);
  svg.querySelectorAll<SVGElement>('[data-a]').forEach((e) => {
    const on = !!id && (e.dataset['a'] === id || e.dataset['b'] === id);
    e.classList.toggle('on', on);
    if (on) {
      near.add(e.dataset['a']!);
      near.add(e.dataset['b']!);
    }
  });
  svg.querySelectorAll<SVGElement>('[data-node], [data-entity]').forEach((e) => e.classList.toggle('near', near.has(e.dataset['node'] ?? e.dataset['entity'] ?? '')));
}

function openDrawer(what: { kind: 'node' | 'entity' | 'line'; id: string }, focus = true) {
  if (!lastGraph || !prepared) return;
  const d = $('drawer');
  let title = '';
  let html = '';
  if (what.kind === 'line') {
    const r = lastManifest && lineDetail(lastManifest, Number(what.id));
    if (!r) {
      closeDrawer();
      return;
    }
    ({ title, html } = r);
  } else if (what.kind === 'node') {
    const r = detail(lastGraph, what.id, lastFiles);
    if (!r) {
      closeDrawer();
      return;
    }
    ({ title, html } = r);
  } else {
    const r = entityList(what.id);
    title = r.title;
    html = r.html;
  }
  drawerFor = what;
  $('dr-title').textContent = title;
  $('dr-body').innerHTML = html;
  d.hidden = false;
  document.body.classList.add('drawer-open');
  if (focus) $('dr-close').focus();
}

const GLOSSARY: readonly [string, string, string][] = [
  ['Intent', 'What you mean the software to do, and why, in your own words, before anyone decides how.', 'The design intent behind a part.'],
  ['The schematic', 'Your intent organised, like a spec but laid out to be read at a glance: the end in mind, the problem, the people, the outcomes, the measures and the rules, each numbered.', 'An engineering drawing or schematic: the controlled definition everything is made and inspected to.'],
  ['Datum', 'The fixed reference everything is measured from. Here it is your intent: every check is taken against it.', 'A datum feature on an engineering drawing.'],
  ['Balloon', 'The number on each statement. It stays with the statement through every revision, so a test, a part or a change can point at it.', 'Balloon numbers on an engineering drawing, used by the inspection report.'],
  ['Redline', 'A question only you can settle: where readings disagree, a rule has a missing case, or a measure has no tolerance.', 'A checker’s red mark on a print.'],
  ['Revision cloud', 'The red outline around anything with an open question.', 'The cloud drawn round a changed or questioned area.'],
  ['Tolerance', 'How close is close enough for a measure. It becomes the starting floor the factory must hold.', 'The allowed variation on a dimension.'],
  ['Gauge, or journey', 'A person’s goal walked as they would walk it, inside a budget of steps and time, with what must never happen.', 'A go/no-go gauge.'],
  ['Ratchet', 'A measure that may only get better: once held, the floor never drops without a person signing for it.', 'A ratchet that turns one way only.'],
  ['Control plan', 'Every critical or significant statement, and the controls it needs before it ships.', 'The control plan for special characteristics.'],
  ['Build manifest', 'The bill of materials the factory starts from: each part from the library, extended, catalogued to make, or made new.', 'A bill of materials with make-or-buy codes.'],
  ['Release', 'The signed schematic issued as a package, with a revision number and a reason, that the factory builds to.', 'Release of a drawing under document control.'],
];

function openGlossary() {
  drawerFor = null;
  $('dr-title').textContent = 'The words we use';
  $('dr-body').innerHTML = `<p class="muted">The studio borrows the vocabulary of engineering drawings and schematics, because it has kept made things matching their intent for a century. Each term, in plain words, and the drafting term it comes from.</p><dl class="gloss">${GLOSSARY.map(([t, d, m]) => `<dt>${esc(t)}</dt><dd>${esc(d)}<br><span class="mfg">From: ${esc(m)}</span></dd>`).join('')}</dl>`;
  $('drawer').hidden = false;
  document.body.classList.add('drawer-open');
  $('dr-close').focus();
}

function closeDrawerQuiet() {
  drawerFor = null;
  $('drawer').hidden = true;
  document.body.classList.remove('drawer-open');
}

function closeDrawer() {
  const was = drawerFor;
  drawerFor = null;
  $('drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  if (was) document.querySelector<HTMLElement>(`[data-node="${cssEsc(was.kind === 'line' ? `line:${was.id}` : was.id)}"], [data-entity="${cssEsc(was.id)}"]`)?.focus();
}

function entityList(id: string): { title: string; html: string } {
  const g = lastGraph!;
  const p = prepared!;
  const list = (items: { id?: string; label: string; balloon?: number; file?: string }[]) =>
    items.length
      ? `<ul class="rel-list">${items.map((i) => `<li>${i.id ? `<button type="button" class="link-row" data-node="${esc(i.id)}">${i.balloon ? `<span class="mini-balloon">${i.balloon}</span>` : ''}${esc(i.label)}</button>` : i.file ? `<button type="button" class="chip file" data-file="${esc(i.file)}">${esc(i.label)}</button>` : esc(i.label)}</li>`).join('')}</ul>`
      : '<p class="note">None yet.</p>';
  const nodes = (k: string) => g.nodes.filter((n) => n.kind === k).map((n) => ({ id: n.id, label: n.label, ...(n.balloon ? { balloon: n.balloon } : {}) }));
  switch (id) {
    case 'statement': {
      const by = new Map<string, Ballooned[]>();
      for (const s of p.statements) by.set(HEAD[s.slot], [...(by.get(HEAD[s.slot]) ?? []), s]);
      return { title: `Statements (${p.statements.length})`, html: [...by.entries()].map(([h, ss]) => `<h4>${esc(h)} (${ss.length})</h4>${list(ss.map((s) => ({ id: `b${s.balloon}`, label: s.text, balloon: s.balloon })))}`).join('') };
    }
    case 'question':
      return { title: `Open questions (${p.questions.length})`, html: p.questions.length ? `<ul class="open-list">${p.questions.map((q) => `<li>${esc(q.text)} <button type="button" class="btn quiet" data-answer="${esc(q.id)}">Answer it</button></li>`).join('')}</ul>` : '<p class="note">None open.</p>' };
    case 'source':
      return { title: 'Sources', html: list(p.model.sources.map((x) => ({ label: `${x.path} (${x.form}), sha-256 ${x.sha256.slice(0, 12)}` }))) };
    case 'reading':
      return { title: 'Readings', html: list(state.readings.map((r) => ({ label: checkReading(r).ok ? `${(r as { family: string }).family}: usable` : 'not usable' }))) + '<p class="note">Add readings in the Readings panel.</p>' };
    case 'default':
      return { title: 'Title block defaults', html: list(Object.entries(p.title).map(([k, e]) => ({ label: `${k}: ${e.value}${e.from !== 'default' ? ` (because you said ${e.from})` : ''}` }))) };
    case 'note':
      return { title: 'Engineering notes and variants', html: list([...p.model.notes.map((n) => ({ label: n.text })), ...p.model.variants.map((v) => ({ label: `${v.id}: ${v.text}` }))]) };
    case 'revision':
      return { title: 'Revisions', html: list(state.releases.map((r) => ({ label: `Revision ${r.revision}, ${r.ready ? 'released' : 'draft'}: ${r.reason ?? 'first release'}` }))) };
    case 'file':
      return { title: `Package files (${Object.keys(lastFiles).length})`, html: list(Object.keys(lastFiles).sort().map((f) => ({ label: f, file: f }))) };
    case 'end':
      return { title: 'The end in mind', html: list(nodes('end')) };
    case 'intent':
      return { title: p.model.title || 'This intent', html: `<p>${p.statements.length} statements, ${g.nodes.filter((n) => n.lane === 'instruments').length} checks, ${p.questions.length} open questions.</p>` };
    default:
      return { title: { gauge: 'Journey gauges', forbidden: 'Forbidden outcomes', ratchet: 'Ratchets', scenario: 'Scenario tests', control: 'Controls' }[id] ?? id, html: list(nodes(id)) };
  }
}

function setView(v: View, focusTab = true) {
  state.view = v;
  scheduleSave();
  render();
  if (focusTab) document.getElementById(`tab-${v}`)?.focus();
}

/**
 * The hire: Christensen's questions, answered from the frame. What job is this hired for; how would you know
 * it is doing a good job; at the end of the year, what says it was a good hire. Empty answers show as gaps.
 */
function hireCard(p: Prepared): string {
  const of = (slot: Slot) => p.statements.filter((s) => s.slot === slot);
  const job = [...of('problem'), ...of('outcome')];
  const good = of('measures');
  const year = p.model.end ? [p.model.end] : of('why').map((s) => s.text);
  const list = (xs: string[], gap: string) =>
    xs.length ? `<ul>${xs.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${xs.length > 3 ? `<p class="more">and ${xs.length - 3} more on the schematic</p>` : ''}` : `<p class="gap">${gap}</p>`;
  return `<section class="hire" aria-labelledby="h-hire"><h3 id="h-hire">If this were a hire</h3><div class="hire-grid">
<div><h4>The job it is hired for</h4>${list(job.map((s) => s.text), 'Not said yet: what goes wrong today, and what will be true when it is fixed?')}</div>
<div><h4>How you would know it is doing a good job</h4>${list(good.map((s) => `${s.text}${s.tolerance && s.tolerance !== 'exactly as stated' ? `, held to ${s.tolerance}` : ''}`), 'Not said yet: what would you check, and how close is close enough?')}</div>
<div><h4>At the end of the year, a good hire if</h4>${list(year, 'Not said yet: what is all this ultimately for?')}</div>
</div><p class="credit">These are Clayton M. Christensen's hiring questions, from his jobs-to-be-done theory: <cite>Competing Against Luck</cite> (Christensen, Hall, Dillon and Duncan, HarperBusiness, 2016) and "Know Your Customers' Jobs to Be Done" (<cite>Harvard Business Review</cite>, September 2016).</p></section>`;
}

function titleBlock(p: Prepared): string {
  const last = state.releases.at(-1);
  const s = STAGES.find((x) => x.key === stage(p))!;
  return `<div class="titleblock" aria-label="Title block"><div class="wide"><span class="k">Title</span>${esc(p.model.title && p.model.title !== state.path ? p.model.title : 'Untitled intent')}</div><div><span class="k">Next revision</span>${(last?.revision ?? 0) + 1}</div><div><span class="k">Status</span>${esc(s.label)}</div><div><span class="k">Balloons</span>${p.statements.length}</div><div><span class="k">Open redlines</span>${state.words.trim() ? p.questions.length : 0}</div><div class="wide"><span class="k">Signed</span>${isSigned(p) ? `by you, ${esc(new Date(state.signed!.at).toLocaleString())}` : 'not yet'}</div><div class="wide"><span class="k">Last package</span><span class="hash">${last ? esc(last.package.slice(0, 16)) : 'none yet'}</span></div></div>`;
}

/**
 * Correcting the schematic goes back to the datum: the person's own words. A statement from a line of theirs
 * opens that line; one read or derived from a word opens where the word is; anything else gets a new line.
 */
function notQuite(balloon: number) {
  const s = prepared!.statements.find((x) => x.balloon === balloon);
  if (!s) return;
  const w = $('words') as HTMLTextAreaElement;
  const lines = w.value.split('\n');
  let line = s.supplied.kind === 'person' && s.supplied.origin ? s.supplied.origin.line - 1 : -1;
  if (line < 0 && s.words) line = lines.findIndex((l) => l.toLowerCase().includes(s.words!.toLowerCase()));
  const why =
    s.supplied.kind === 'derived'
      ? `Balloon ${balloon} follows by rule from your words, so change the words it follows from, or add a line that says otherwise.`
      : s.supplied.kind === 'parse'
        ? `Both readings took this from your words. Add a line that says what you mean instead.`
        : `Edit your words: the schematic follows them.`;
  if (line >= 0) {
    const start = lines.slice(0, line).join('\n').length + (line ? 1 : 0);
    w.focus();
    w.setSelectionRange(start, start + lines[line]!.length);
  } else {
    w.value = `${w.value.replace(/\s*$/, '')}\n- `;
    w.focus();
    w.setSelectionRange(w.value.length, w.value.length);
  }
  say('words-status', `${why} The schematic updates as you type.`);
}

// ---------------------------------------------------------------- release

let downloads: { save(r: { filename: string; data: Blob | string }): Promise<{ status: string }> } | null = null;

function renderRelease(p: Prepared) {
  const panel = $('release');
  if (!state.words.trim()) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const last = state.releases.at(-1);
  const draft = currentRelease(p, 'check');
  const problems = [...new Set([...p.unread, ...draft.problems.filter((x) => !/must say why/.test(x)), ...(p.questions.length ? [`${p.questions.length} redline${p.questions.length === 1 ? '' : 's'} to clear`] : [])])];
  const ready = problems.length === 0;
  const next = (last?.revision ?? 0) + 1;
  panel.innerHTML = `<h2 id="h-release"><span class="proc" data-step="5">5</span>Sign and release</h2>
<p class="lede">The release is the package the factory builds to: the schematic, the gauges in the factory's own format, the control plan, working ranges and starting ratchets, pending tests, and the knowledge bundle.</p>
${Object.keys(state.unsure).length ? `<p class="note">You were not sure about ${Object.keys(state.unsure).length} answer${Object.keys(state.unsure).length === 1 ? '' : 's'}; ${Object.keys(state.unsure).length === 1 ? 'it is' : 'they are'} released on the recommended answer and listed in Your answers so you can come back.</p>` : ''}
${ready ? '<p class="ok"><strong>Ready to release.</strong> Nothing that changes what gets built is open.</p>' : `<p class="todo"><strong>Not ready yet.</strong> You can still issue a draft revision to share or keep.</p><ol>${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`}
${lastReview ? `<div class="bom-mini"><p><strong>Review: ${lastReview.overall} overall.</strong> ${lastReview.panel.map((x) => `${esc(x.name)} ${x.grade}`).join(', ')}; ${lastReview.people.map((x) => `${esc(x.name)} ${x.grade}`).join(', ')}.</p><button class="btn" type="button" data-view="review">Open the review</button></div>` : ''}
${lastManifest ? `<div class="bom-mini"><p><strong>The factory will start from ${lastManifest.lines.length} parts:</strong> ${lastManifest.counts.stock + lastManifest.counts.modify} from the library, ${lastManifest.counts['make: catalogued']} catalogued parts to make, ${lastManifest.counts['make: new']} new for this intent.${lastManifest.gaps.length ? ` <strong class="red">${lastManifest.gaps.length} balloon${lastManifest.gaps.length === 1 ? '' : 's'} nothing builds.</strong>` : ''}</p><button class="btn" type="button" data-view="build">Preview the build</button></div>` : ''}
${ready ? `<div class="sign"><label class="opt"><input type="checkbox" id="sign"${isSigned(p) ? ' checked' : ''}> <span><strong>I have checked the schematic and the build manifest. It says what I mean.</strong> Your signature holds for this exact schematic; change a word and it needs signing again.</span></label></div>` : ''}
${last ? `<label for="reason"><strong>Why this revision?</strong> Required after the first.</label><input type="text" id="reason" autocomplete="off" placeholder="For example: staff confirmed as college counseling">` : ''}
<div class="row"><button class="btn primary" type="button" id="issue"${ready && !isSigned(p) ? ' aria-describedby="sign-first"' : ''}>${ready ? `Release revision ${next}` : `Issue draft revision ${next}`}</button>${ready && !isSigned(p) ? '<span class="note" id="sign-first">Sign the schematic first to release it.</span>' : ''}</div>
<p class="status" id="release-status" role="status"></p>
${last?.ready ? `<div class="next-steps"><strong>What happens next</strong><ol><li>Download the package and give it to the factory. Its journey cards go into the factory's proposals; nothing an agent writes can lock them.</li><li>A person signs the journeys in. From then on they judge every build, and a change to your intent cannot quietly change what they judge.</li><li>The factory designs from the build manifest, then loops: build, then test, cheapest check first. Types and unit tests, then scenarios, gates and ratchets, then the journeys walked in the state graph, all by rule; a model is opened only to make or repair what a check has named, and only once the cheaper checks before it pass. It goes round until every test and every journey passes.</li><li>Each phase is released only when its journeys pass. <a href="https://zthr.ai/mission">Mission control</a> shows the measure: journeys walked and passing.</li></ol></div>` : ''}
${state.releases.length ? `<h3>Revisions</h3><ul class="history">${state.releases
    .slice()
    .reverse()
    .map((r) => `<li>Revision ${r.revision}, ${r.ready ? 'released' : 'draft'}: ${esc(r.reason ?? 'first release')} <span class="hash">${esc(r.package.slice(0, 12))}</span> <button class="btn quiet" type="button" data-download="${r.revision}">Download the package</button></li>`)
    .join('')}</ul>` : ''}`;
}

function issue() {
  if (!prepared) return;
  const last = state.releases.at(-1);
  const reason = ($('reason') as HTMLInputElement | null)?.value.trim() ?? '';
  if (last && !reason) {
    say('release-status', 'Say why this revision exists first. Every revision after the first carries its reason.', true);
    ($('reason') as HTMLInputElement).focus();
    return;
  }
  const blocking = !prepared.questions.length && !prepared.unread.length && !isSigned(prepared);
  if (blocking) {
    say('release-status', 'Tick "I have checked the schematic" first. A release carries your signature.', true);
    ($('sign') as HTMLInputElement | null)?.focus();
    return;
  }
  const r = currentRelease(prepared, reason || undefined);
  const m = JSON.parse(r.files['manifest.json']!) as { package: string; ready: boolean; revision: number };
  state.releases.push({ revision: m.revision, reason: reason || null, package: m.package, ready: m.ready && isSigned(prepared), datum: JSON.parse(r.files['datum.json']!), balloons: JSON.parse(r.files['balloons.json']!), inputs: { path: state.path, words: state.words, readings: JSON.parse(JSON.stringify(state.readings)), answers: JSON.parse(JSON.stringify(state.answers)), journeys: JSON.parse(JSON.stringify(state.journeys)), options: JSON.parse(JSON.stringify(state.options)), people: JSON.parse(JSON.stringify({ ...(state.holder.name || state.holder.role ? { holder: state.holder } : {}), tune: state.tune })) } });
  packages.set(m.revision, r.files);
  scheduleSave();
  render();
  say('release-status', `Revision ${m.revision} ${state.releases.at(-1)!.ready ? 'released' : 'issued as a draft'}. Package ${m.package.slice(0, 12)}.`);
}

/** Packages are rebuilt from the saved revision on demand; the engine is deterministic, so the bytes match. */
const packages = new Map<number, Readonly<Record<string, string>>>();

/** Rebuild a saved revision from its inputs; only bytes that hash to the recorded package are handed over. */
function rebuild(rev: number): Readonly<Record<string, string>> | null {
  const k = state.releases.findIndex((r) => r.revision === rev);
  const r = state.releases[k];
  if (!r?.inputs) return null;
  const before = state.releases[k - 1];
  const p = prepare({ files: [{ path: r.inputs.path, text: r.inputs.words }], readings: r.inputs.readings, answers: r.inputs.answers, ...(r.inputs.journeys ? { journeys: r.inputs.journeys } : {}), ...(r.inputs.options ? { options: r.inputs.options } : {}), ...(r.inputs.people ? { people: r.inputs.people } : {}), ...(before ? { prior: before.balloons } : {}) });
  const out = release(p, { revision: rev, ...(before ? { prior: { revision: before.revision, datum: before.datum }, reason: r.reason ?? '' } : {}) });
  if (JSON.parse(out.files['manifest.json']!).package !== r.package) return null;
  packages.set(rev, out.files);
  return out.files;
}

async function download(rev: number) {
  if (!prepared) return;
  const files = packages.get(rev) ?? rebuild(rev);
  if (!files) {
    say('release-status', `Revision ${rev} could not be rebuilt to the same bytes, so it is not offered. Issue a new revision.`, true);
    return;
  }
  const title = (prepared.model.title || 'intent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'intent';
  try {
    const bytes = zip(files, `${title}-rev-${rev}`);
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    if (downloads) await downloads.save({ filename: `${title}-rev-${rev}.zip`, data: blob });
    else {
      // On a plain web page the browser saves it.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${title}-rev-${rev}.zip`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    say('release-status', `Revision ${rev} saved.`);
  } catch (e) {
    const code = (e as { code?: string }).code;
    say('release-status', code === 'declined' ? 'Not saved.' : 'This view cannot save files. Open the studio in a browser to download the package.', code !== 'declined');
  }
}

// ---------------------------------------------------------------- reading with Claude, and with any other model

let sample: ((input: string, opts?: Record<string, unknown>) => Promise<{ text: string }>) | null = null;

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

async function readWithClaude() {
  if (!sample || !prepared) return;
  const btn = $<HTMLButtonElement>('read-claude');
  btn.disabled = true;
  say('read-status', 'Claude is reading your words…');
  try {
    const r = await sample(readingPrompt(prepared.model, 'claude'), { modelTier: 'default' });
    const value = parseJson(r.text);
    const c = checkReading(value);
    if (!c.ok) {
      say('read-status', `Claude's reading did not match the schema (${c.problems.join('; ')}), so it counts as unknown. Try again.`, true);
      return;
    }
    state.readings = [...state.readings.filter((x) => (x as { family?: string }).family !== 'claude'), { ...c.reading, family: 'claude' }];
    scheduleSave();
    render();
    say('read-status', 'Claude has read it. Its reading shows as proposals to confirm until a second family reads it too.');
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'not_granted') btn.hidden = true;
    say('read-status', code === 'rate_limited' ? 'Claude is busy. Try again in a moment.' : code === 'not_granted' ? 'Reading with Claude is not allowed in this view.' : 'Claude could not read it this time. Try again.', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- speaking instead of typing

interface Dictation {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFinal(f: (e: { text: string }) => void): void;
  onPartial(f: (e: { text: string }) => void): void;
  onState(f: (e: { state: string; reason?: string }) => void): void;
}
let dictation: Dictation | null = null;
let listening = false;

// ---------------------------------------------------------------- the example

const EXAMPLE = `# Student bill reminders

## The end in mind

Students stay housed and in school, because a missed bill never becomes a shut-off.

## What I want

I want students to stop getting their power shut off. Make it feel calm, not scary.

- Remind students before bills are due
- It should be snappy on a phone
- When a bill is paid then reminders stop
- Staff should see who is struggling

## Engineering notes

- Use the student records already in place, until the new records system is live
`;
const EXAMPLE_READINGS = [
  { family: 'sample-a', problem: 'students get their power shut off after missing bills', why: 'stay housed and in school', outcomes: ['no shut-off from a missed due date'], people: [{ name: 'students', side: 'primary' }, { name: 'advisor', side: 'other' }], measures: [{ text: 'shut-offs avoided', tolerance: 'none in a term' }], constraints: ['never message during quiet hours'], nonGoals: ['paying bills for students'] },
  { family: 'sample-b', problem: 'students getting their power shut off after missed bills', why: 'avoid late fees', outcomes: ['no shut-off from a missed due date', 'a warning when money will be short'], people: [{ name: 'students', side: 'primary' }], measures: [{ text: 'shut-offs avoided', tolerance: 'fewer than last term' }], constraints: ['never message during quiet hours'], nonGoals: ['paying bills for students'] },
];

// ---------------------------------------------------------------- wiring

function setWords(text: string, path = 'intent.md') {
  state.words = text;
  state.path = path;
  ($('words') as HTMLTextAreaElement).value = text;
  scheduleSave();
  render();
}

async function openFile(f: File) {
  const raw = await f.text();
  const html = isHtml(f.name, raw);
  setWords(html ? htmlToMarkdown(raw) : raw, html ? f.name.replace(/\.x?html?$/i, '.md') : f.name);
  say('words-status', html ? `Read ${f.name} as a page and turned it into text you can edit.` : `Read ${f.name}.`);
}

function wire() {
  document.documentElement.classList.add('js');
  const words = $('words') as HTMLTextAreaElement;
  let typing: ReturnType<typeof setTimeout> | undefined;
  words.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.words = words.value;
      scheduleSave();
      render();
    }, 300);
  });
  $('steps').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (!b) return;
    const n = Number(b.dataset['jump']);
    const target = n === 1 ? 'words-box' : n === 2 ? 'readings-box' : n === 3 ? 'redlines-panel' : n === 4 ? 'sheet' : 'release';
    const el = $(target);
    if (el instanceof HTMLDetailsElement) {
      el.open = true;
      wordsOpenedByPerson = true;
    }
    if (n === 4) setView('review', false);
    $(target).scrollIntoView?.({ block: 'start' });
  });
  $('chain').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-chain]');
    if (!t) return;
    const go = t.dataset['chain']!;
    if (go === 'example') $('example').click();
    else if (go === 'words') {
      const b = $('words-box') as HTMLDetailsElement;
      b.open = true;
      wordsOpenedByPerson = true;
      $('words').focus();
    } else if (go === 'redlines') {
      $('redlines-panel').scrollIntoView?.({ block: 'start' });
      $('redlines').querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: true });
    } else if (go === 'release') {
      $('release').scrollIntoView?.({ block: 'start' });
    } else {
      setView(go as View, false);
      $('sheet').scrollIntoView?.({ block: 'start' });
      document.getElementById(`tab-${go}`)?.focus({ preventScroll: true });
    }
  });
  $('words-box').addEventListener('toggle', () => {
    if (($('words-box') as HTMLDetailsElement).open && state.words.trim()) wordsOpenedByPerson = true;
  });
  $('glossary-open').addEventListener('click', () => openGlossary());
  $('example').addEventListener('click', () => {
    if (state.words.trim() && !confirmReplace()) return;
    state = { ...empty(), readings: EXAMPLE_READINGS };
    lastBalloons = new Set();
    state.holder = { name: 'Denise Harper (an example)', role: 'Director of Student Success' };
    state.product = 'Student success';
    setWords(EXAMPLE, 'student-bill-reminders.md');
    say('words-status', 'Loaded an example. Its two readings, sample-a and sample-b, were written by hand for this example to stand in for two model families, so you can see agreement and redlines without calling a model.');
    wordsOpenedByPerson = false;
  });
  $('start-new').addEventListener('click', () => {
    if (!armed($('start-new'), 'Clear everything and start again?', 'Start a new intent')) {
      say('words-status', 'Press again to clear your words, answers and revisions. Download any package you want to keep first.');
      return;
    }
    state = empty();
    lastBalloons = new Set();
    packages.clear();
    setWords('');
    say('words-status', 'Cleared. Start with a few rough lines.');
    ($('words') as HTMLTextAreaElement).focus();
  });
  $('file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void openFile(f);
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files[0];
    if (f) void openFile(f);
  });
  $('redlines').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('other-text')) {
      const radio = document.getElementById(t.dataset['for'] ?? '') as HTMLInputElement | null;
      if (radio && t.value.trim()) radio.checked = true;
    }
    syncBranches();
    const fs = t.closest('fieldset');
    if (!fs) return;
    // A branch's own choice waits for its follow-ups; anything else is applied at once.
    const g = gather(fs);
    if (!g) return;
    if (g.given) {
      state.answers[g.id] = g.given;
      state.asked[g.id] = fs.querySelector('legend')?.textContent?.replace(/^\d+\.\s*/, '') ?? g.id;
      delete state.unsure[g.id];
    } else delete state.answers[g.id];
    scheduleSave();
    render(true);
  });
  $('redlines').addEventListener('submit', (e) => e.preventDefault());
  $('redlines').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const sk = t.dataset['skip'];
    if (sk) {
      state.skipped = [...state.skipped.filter((x) => x !== sk), sk];
      scheduleSave();
      render(true);
      say('redlines-status', 'Moved to the end. It stays open until you answer it.');
      return;
    }
    const u = t.dataset['unsure'];
    if (u) {
      state.answers[u] = { pick: t.dataset['pick']! };
      state.unsure[u] = true;
      state.asked[u] = t.closest('fieldset')?.querySelector('legend')?.textContent?.replace(/^\d+\.\s*/, '') ?? u;
      scheduleSave();
      render(true);
      return;
    }
    if (t.id === 'show-all') {
      state.showAll = true;
      render();
    } else if (t.id === 'show-fewer') {
      state.showAll = false;
      render();
    }
  });
  $('answers').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).dataset['undo'];
    if (!id) return;
    delete state.answers[id];
    delete state.unsure[id];
    scheduleSave();
    render();
    const back = [...$('redlines').querySelectorAll<HTMLInputElement>('[name]')].find((x) => x.name === id);
    back?.focus();
    say('redlines-status', 'Answer cleared. Choose again.');
  });
  $('redlines').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (!/^[1-9]$/.test(e.key) || t.matches('textarea, input[type=text]') || e.altKey || e.ctrlKey || e.metaKey) return;
    const fs = t.closest('fieldset');
    const opts = fs ? [...fs.querySelectorAll<HTMLInputElement>(':scope > .opt > input[type=radio], :scope > .opt > input[type=checkbox]')] : [];
    const o = opts[Number(e.key) - 1];
    if (!o) return;
    e.preventDefault();
    o.click();
  });
  const onPick = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-not-quite], [data-node], [data-entity], [data-view], [data-file], [data-zoom], [data-journey], [data-add-first], [data-filter], [data-answer], [data-wide], [data-src], [data-baseline], [data-add-words]');
    if (!t || !prepared) return;
    const d = t.dataset;
    if (d['addWords'] !== undefined) {
      closeDrawerQuiet();
      const box = $('words-box') as HTMLDetailsElement;
      box.open = true;
      wordsOpenedByPerson = true;
      const w = $('words') as HTMLTextAreaElement;
      w.value = `${w.value.replace(/\s*$/, '')}\n${d['addWords']}`;
      w.focus();
      w.setSelectionRange(w.value.length, w.value.length);
      box.scrollIntoView?.({ block: 'start' });
      say('words-status', 'Added to your words. Finish the line; the schematic updates as you type.');
      return;
    }
    if (d['baseline'] !== undefined && lastManifest) {
      const m = lastManifest;
      drawerFor = null;
      $('dr-title').textContent = m.baseline.name;
      $('dr-body').innerHTML = `<p>${esc(m.baseline.what)}</p><p class="muted small">A team sets its own minimum in <code>catalog/baseline.json</code>: one line per part, with why. Every app that team builds inherits it, and the fleet maintains it.</p><ul class="rel-list">${m.lines.filter((l) => l.floor).map((l) => `<li><button type="button" class="link-row" data-node="line:${l.find}"><span class="findref">${l.find}</span>${esc(l.part)}</button></li>`).join('')}</ul>`;
      $('drawer').hidden = false;
      document.body.classList.add('drawer-open');
      $('dr-close').focus();
      return;
    }
    if (d['src']) {
      state.buildFilter = d['src'] as Source | 'all';
      scheduleSave();
      render();
      document.querySelector<HTMLElement>(`[data-src="${cssEsc(d['src'])}"]`)?.focus();
      return;
    }
    if (d['wide'] !== undefined) {
      state.wide = !state.wide;
      scheduleSave();
      render();
      document.querySelector<HTMLElement>('[data-wide]')?.focus();
      return;
    }
    if (d['notQuite']) {
      closeDrawerQuiet();
      notQuite(Number(d['notQuite']));
    } else if (d['view']) setView(d['view'] as View);
    else if (d['node']) {
      if (d['node'].startsWith('group:')) {
        state.expanded = state.expanded.includes(d['node']) ? state.expanded.filter((x) => x !== d['node']) : [...state.expanded, d['node']];
        scheduleSave();
        render();
        document.querySelector<HTMLElement>(`[data-node="${cssEsc(d['node'])}"]`)?.focus();
        return;
      }
      if (d['node'].startsWith('line:')) openDrawer({ kind: 'line', id: d['node'].slice(5) });
      else openDrawer({ kind: 'node', id: d['node'] });
    } else if (d['entity']) openDrawer({ kind: 'entity', id: d['entity'] });
    else if (d['file'] !== undefined) {
      const f = d['file'];
      const real = lastFiles[f] !== undefined ? f : Object.keys(lastFiles).sort().find((x) => x.startsWith(f)) ?? 'schematic.md';
      state.previewFile = real;
      closeDrawerQuiet();
      setView('preview', false);
      document.querySelector<HTMLElement>(`.file-row[data-file="${cssEsc(real)}"]`)?.focus();
    } else if (d['zoom'] !== undefined) {
      const z = Number(d['zoom']);
      const svgNow = document.querySelector<SVGSVGElement>('#canvas svg');
      const current = svgNow ? svgNow.getBoundingClientRect().width / Number(svgNow.getAttribute('width')) : 1;
      state.zoom = z === 0 ? (state.zoom === 0 ? 1 : 0) : Math.min(2, Math.max(0.4, Math.round((current + z * 0.15) * 20) / 20));
      scheduleSave();
      render();
      document.querySelector<HTMLElement>(`[data-zoom="${z}"]`)?.focus();
    } else if (d['journey']) {
      const id = d['journey'];
      state.journeys.accepted = state.journeys.accepted.includes(id) ? state.journeys.accepted.filter((x) => x !== id) : [...state.journeys.accepted, id];
      scheduleSave();
      render();
      document.querySelector<HTMLElement>(`[data-journey="${cssEsc(id)}"]`)?.focus();
      say('words-status', state.journeys.accepted.includes(id) ? 'Journey added to the package.' : 'Journey taken out of the package.');
    } else if (d['addFirst'] !== undefined) {
      const first = suggestJourneys(prepared).filter((x) => x.priority === 'first').map((x) => x.id);
      state.journeys.accepted = [...new Set([...state.journeys.accepted, ...first])];
      scheduleSave();
      render();
      document.getElementById('h-suggest')?.scrollIntoView?.({ block: 'start' });
    } else if (d['filter']) {
      state.planFilter = d['filter'];
      render();
      document.querySelector<HTMLElement>(`[data-filter="${cssEsc(d['filter'])}"]`)?.focus();
    } else if (d['answer']) {
      closeDrawerQuiet();
      const id = d['answer'];
      if (!$('redlines').querySelector(`[name="${cssEsc(id)}"]`)) {
        state.showAll = true;
        render();
      }
      const el = $('redlines').querySelector<HTMLElement>(`[name="${cssEsc(id)}"]`);
      el?.closest('fieldset')?.scrollIntoView?.({ block: 'center' });
      el?.focus();
    }
  };
  $('sheet').addEventListener('click', onPick);
  $('sheet').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.dataset['tune']) {
      const who = t.dataset['tune'];
      const key = t.dataset['key'] as keyof Tune;
      const cur: Record<string, string> = { ...(state.tune[who] as Record<string, string> | undefined) };
      if (t.value) cur[key] = t.value;
      else delete cur[key];
      state.tune = { ...state.tune, [who]: cur as Tune };
    } else if (t.id === 'holder-name') state.holder = { ...state.holder, name: t.value.trim() };
    else if (t.id === 'holder-role') state.holder = { ...state.holder, role: t.value.trim() };
    else if (t.id === 'product-name') state.product = t.value.trim();
    else if (t.dataset['opt']) state.options = specChange(state.options, t.dataset['opt'], t);
    else return;
    scheduleSave();
    const id = t.id;
    render();
    document.getElementById(id)?.focus();
  });
  $('release').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-view]')) onPick(e);
  });
  $('drawer').addEventListener('click', onPick);
  $('sheet').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('[data-node][role=button], [data-entity][role=button]')) {
      e.preventDefault();
      onPick(e);
    }
    if (t.getAttribute('role') === 'tab' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const i = VIEWS.findIndex((v) => v.key === state.view);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length;
      setView(VIEWS[n]!.key);
    }
  });
  const trace = (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('#canvas [data-node], #canvas [data-entity]');
    highlight(t ? (t.dataset['node'] ?? t.dataset['entity'] ?? null) : null);
  };
  $('sheet').addEventListener('mouseover', trace);
  $('sheet').addEventListener('focusin', trace);
  $('sheet').addEventListener('mouseleave', () => highlight(null));
  $('sheet').addEventListener('submit', (e) => {
    const f = e.target as HTMLFormElement;
    if (f.id !== 'own-journey') return;
    e.preventDefault();
    const goal = (document.getElementById('own-goal') as HTMLInputElement).value.trim();
    const persona = (document.getElementById('own-who') as HTMLSelectElement).value;
    if (goal.length < 10) {
      say('words-status', 'Say a little more about the journey: at least a short sentence.', true);
      return;
    }
    state.journeys.own = [...state.journeys.own, { goal, persona }];
    scheduleSave();
    render();
    say('words-status', 'Your journey is in the package.');
    document.getElementById('own-goal')?.focus();
  });
  $('dr-close').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerFor) closeDrawer();
  });
  for (const starter of document.querySelectorAll<HTMLButtonElement>('[data-starter]'))
    starter.addEventListener('click', () => {
      const w = $('words') as HTMLTextAreaElement;
      w.value = `${w.value}${w.value && !w.value.endsWith('\n') ? '\n' : ''}${starter.dataset['starter']} `;
      w.focus();
      w.setSelectionRange(w.value.length, w.value.length);
    });
  $('readings').addEventListener('click', (e) => {
    const i = (e.target as HTMLElement).dataset['removeReading'];
    if (i === undefined) return;
    state.readings.splice(Number(i), 1);
    scheduleSave();
    render();
  });
  $('copy-prompt').addEventListener('click', async () => {
    if (!prepared) return;
    try {
      await navigator.clipboard.writeText(readingPrompt(prepared.model, 'the name of your model family, for example gemini'));
      say('read-status', 'Copied. Paste it into another model, then paste its answer below.');
    } catch {
      say('read-status', 'Copying is not allowed here. Select the text in your words box instead.', true);
    }
  });
  $('add-reading').addEventListener('click', () => {
    const box = $('paste-reading') as HTMLTextAreaElement;
    try {
      const value = parseJson(box.value);
      const c = checkReading(value);
      if (!c.ok) {
        say('read-status', `That reading does not match the schema (${c.problems.join('; ')}).`, true);
        return;
      }
      if (state.readings.some((r) => (r as { family?: string }).family === c.reading.family)) {
        say('read-status', `There is already a reading from ${c.reading.family}. Two readings must come from different families.`, true);
        return;
      }
      state.readings.push(c.reading);
      box.value = '';
      scheduleSave();
      render();
      say('read-status', `Added the reading from ${c.reading.family}.`);
    } catch {
      say('read-status', 'That is not JSON. Paste the model\'s whole answer.', true);
    }
  });
  $('read-claude').addEventListener('click', () => void readWithClaude());
  $('release').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'issue') issue();
    if (t.id === 'sign' && prepared) {
      state.signed = (t as HTMLInputElement).checked ? { datum: datumHash(prepared), at: new Date().toISOString(), ...(state.holder.name ? { by: state.holder.name } : {}) } : null;
      scheduleSave();
      render();
      $('sign').focus();
    }
    const d = t.dataset['download'];
    if (d) void download(Number(d));
  });
  $('mic').addEventListener('click', () => {
    if (!dictation) return;
    if (listening) {
      void dictation.stop();
      return;
    }
    dictation.start().catch((e: { code?: string }) => {
      if (e.code === 'not_granted') $('mic').hidden = true;
      say('words-status', e.code === 'not_granted' ? 'Speaking is off here. Typing works the same.' : 'Could not start listening. Try again.', true);
    });
  });
}

/** No browser dialogs in a sandboxed frame: the first press asks, the second acts, and moving away disarms. */
function armed(b: HTMLElement, ask: string, label: string): boolean {
  if (b.dataset['armed'] === '1') {
    b.dataset['armed'] = '';
    b.textContent = label;
    return true;
  }
  b.dataset['armed'] = '1';
  b.textContent = ask;
  b.addEventListener('blur', () => {
    b.dataset['armed'] = '';
    b.textContent = label;
  }, { once: true });
  return false;
}

function confirmReplace(): boolean {
  // No browser dialogs in a sandboxed frame: the first press warns, the second replaces.
  const b = $('example');
  if (b.dataset['armed'] === '1') {
    b.dataset['armed'] = '';
    b.textContent = 'Try an example';
    return true;
  }
  b.dataset['armed'] = '1';
  b.textContent = 'Replace my words with the example?';
  say('words-status', 'Press again to replace your words with the example. Your current words are saved until you do.');
  return false;
}

/** Keep the work in a private space: the artifact's own store, or, on zthr.ai, the invited person's workspace. */
async function attach(r: NonNullable<typeof remote>) {
  remote = r;
  const snap = await remote.get();
  const saved = snap.exists ? (snap.data()?.['json'] as string | undefined) : undefined;
  if (saved && !state.words.trim()) {
    state = { ...empty(), ...(JSON.parse(saved) as State) };
    ($('words') as HTMLTextAreaElement).value = state.words;
    lastBalloons = new Set();
    say('words-status', 'Picked up where you left off.');
  } else if (state.words.trim()) void flush();
}
function onAccess() {
  const a = (window as { zthrAccess?: { workspace: NonNullable<typeof remote> } }).zthrAccess;
  if (!a) return;
  void attach(a.workspace)
    .then(() => render())
    .catch(() => {
      remote = null;
    });
}
window.addEventListener('zthr:access', onAccess);

async function capabilities() {
  const [db, user, s, d, dl] = await Promise.all([claudeUse('db'), claudeUse('user'), claudeUse('sample'), claudeUse('dictation'), claudeUse('downloads')]);
  if (typeof s === 'function') {
    sample = s as typeof sample;
    $('read-claude').hidden = false;
  }
  if (d) {
    dictation = d as Dictation;
    $('mic').hidden = false;
    const words = $('words') as HTMLTextAreaElement;
    dictation.onFinal(({ text }) => {
      words.value = `${words.value}${words.value && !/\s$/.test(words.value) ? ' ' : ''}${text}`;
      state.words = words.value;
      scheduleSave();
      render();
    });
    dictation.onPartial(({ text }) => say('words-status', `Hearing: ${text}`));
    dictation.onState(({ state: st }) => {
      listening = st === 'listening';
      $('mic').setAttribute('aria-pressed', String(listening));
      $('mic').textContent = listening ? 'Stop' : 'Speak';
      if (!listening) say('words-status', '');
    });
  }
  if (dl) downloads = dl as typeof downloads;
  if (db && user) {
    try {
      const id = await (user as { id(): Promise<string | null> }).id();
      if (id) await attach((db as { collection(p: string): { doc(k: string): NonNullable<typeof remote> } }).collection(`data/users/${id}`).doc('studio'));
    } catch {
      remote = null;
    }
  }
  render();
}

window.addEventListener('resize', () => {
  if (narrow() !== wasNarrow) {
    wasNarrow = narrow();
    if (prepared) render();
  } else if (state.zoom === 0 && document.querySelector('#canvas svg')) render();
});

function start() {
  try {
    const saved = localStorage.getItem(LOCAL);
    if (saved) state = { ...empty(), ...(JSON.parse(saved) as State) };
  } catch {
    /* nothing kept in this browser */
  }
  ($('words') as HTMLTextAreaElement).value = state.words;
  wire();
  render();
  void capabilities();
  onAccess();
}

start();
