/**
 * Mission control: the platform as one system, intent in and software out, at three levels. The platform shows every
 * intent at every station and the library they draw on; an intent shows its five stations and what was measured at
 * each; an item shows one journey's trail from intent to release.
 */
import { loadFeed, type Feed } from './feed.ts';
import { factoryFlows, library, studioFlow, type Flow, type StageKey } from './pipeline.ts';
import { along, intent, platform, product, trail, waiting } from './missionViews.ts';
import { flowInFocus, paintLine, setFocus } from './line.ts';
import { lines, products as productRows } from './products.ts';
import { preparedFrom } from './pipeline.ts';
import { esc } from './views.ts';
import { drawer, $ } from './shell.ts';

let feed: Feed | null = null;
let flows: Flow[] = [];
let level: 'platform' | 'product' | 'intent' = 'platform';
let productName = '';
let selected = '';
let station: StageKey = 'qa';
let filter = 'all';

function studioRaw(): string | null {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
}

function crumbs(): string {
  const f = flows.find((x) => x.id === selected);
  const prod = level === 'intent' && f ? f.product : productName;
  const parts = [`<li>${level === 'platform' ? '<span aria-current="page">Platform</span>' : '<button type="button" class="linklike" data-level="platform">Platform</button>'}</li>`];
  if (level !== 'platform' && prod) parts.push(`<li>${level === 'product' ? `<span aria-current="page">${esc(prod)}</span>` : `<button type="button" class="linklike" data-product="${esc(prod)}">${esc(prod)}</button>`}</li>`);
  if (level === 'intent' && f) parts.push(`<li><span aria-current="page">${esc(f.title)}</span></li>`);
  return `<ol class="crumbs">${parts.join('')}</ol><div class="levels" role="group" aria-label="Level">${(['platform', 'product', 'intent'] as const).map((l) => `<button type="button" class="chip${level === l ? ' on' : ''}" aria-pressed="${level === l}" data-level="${l}"${l !== 'platform' && !flows.length ? ' disabled' : ''}>${l === 'platform' ? 'The platform' : l === 'product' ? 'One product' : 'One intent'}</button>`).join('')}<span class="muted small">Select any journey for its trail through every area.</span></div>`;
}

/** What waits on a person, as far as this browser knows: the studio's work and the products kept beside it. */
function waitingItems(): { what: string; href: string; act: string }[] {
  const out: { what: string; href: string; act: string }[] = [];
  const got = preparedFrom(studioRaw());
  if (got) {
    const name = got.s.product?.trim() || got.p.model.title;
    const q = got.p.questions.length;
    const signed = !!got.s.signed;
    const rel = (got.s.releases ?? []).at(-1);
    if (q) out.push({ what: `${name}: ${q} question${q === 1 ? '' : 's'} only you can answer`, href: '/intent', act: 'Answer them' });
    else if (!signed) out.push({ what: `${name}: ready for you to sign as what you mean`, href: '/intent', act: 'Review and sign' });
    else if (!rel?.ready) out.push({ what: `${name}: signed; engineering can release the package`, href: '/engineering', act: 'Open engineering' });
  }
  for (const r of productRows().filter((x) => !x.open && !x.released)) out.push({ what: `${r.name}: ${r.signed ? 'signed, not released' : 'not signed yet'}`, href: `/intent?product=${encodeURIComponent(r.name)}`, act: 'Open it' });
  return out;
}

function front(): string {
  const ls = lines();
  return `<section class="sheet" aria-labelledby="h-wait"><h2 id="h-wait">Waiting on you</h2>${waiting(waitingItems())}<p class="small muted">The factory's own decisions for a person (clarifications it may not make, production approvals, cases that stopped converging) are read with <code>intent agents proposals</code>.</p></section>
<section class="sheet" aria-labelledby="h-along"><h2 id="h-along">Products along the line</h2><p class="muted">${ls.length ? `${ls.length} product line${ls.length === 1 ? '' : 's'}: ${ls.map((l) => esc(l.name)).join(', ')}. ` : ''}Each product, and where it stands in each area. Select a lamp to go to that area with the product in focus.</p>${along(flows, ls)}<p><a class="btn" href="/lines">Product lines</a></p></section>`;
}

function render() {
  $('crumbs').innerHTML = crumbs();
  const f = flows.find((x) => x.id === selected) ?? flows[0];
  if (level === 'product' && flows.length) {
    if (!flows.some((x) => x.product === productName)) productName = f!.product;
    $('body').innerHTML = product(productName, flows);
  } else if (level === 'intent' && f) {
    selected = f.id;
    $('body').innerHTML = `${flows.filter((x) => x.product === f.product).length > 1 ? `<div class="flow-pick" role="group" aria-label="Intent">${flows.filter((x) => x.product === f.product).map((x) => `<button type="button" class="chip${x.id === f.id ? ' on' : ''}" aria-pressed="${x.id === f.id}" data-flow="${esc(x.id)}">${esc(x.title)}</button>`).join('')}</div>` : ''}${intent(f, station, filter)}`;
  } else {
    level = 'platform';
    $('body').innerHTML = platform(flows, library(), front()) + (feed ? '' : `<section class="sheet"><p><strong>The factory has not published its feed yet.</strong> The next reference build writes it from its own evidence; until then the factory's row is missing here, and every reading is on <a href="/reference/factory/index.html">the evidence pages</a>.</p></section>`);
  }
}

async function start() {
  document.documentElement.classList.add('js');
  feed = await loadFeed();
  const studio = studioFlow(studioRaw(), feed);
  flows = [...(feed ? factoryFlows(feed) : []), ...(studio ? [studio] : [])];
  productName = flows[0]?.product ?? '';
  selected = flows[0]?.id ?? '';
  const q = new URLSearchParams(location.search);
  if (q.get('intent') && flows.some((x) => x.id === q.get('intent'))) {
    selected = q.get('intent')!;
    level = 'intent';
  }
  render();
  paintLine(flowInFocus(flows));
  $('handoff-slot').innerHTML = `<section class="handoff" aria-label="Where to start"><p>${lines().length ? 'Open a product line to start a product, or pick one up where it stands.' : 'Define a product line: who it serves and the defaults its products start from.'}</p><a class="btn primary" href="/lines">${lines().length ? 'Open a product line' : 'Define a product line'}</a></section>`;
  document.body.addEventListener('click', (e) => {
    const f = (e.target as HTMLElement).closest<HTMLElement>('[data-focus]');
    if (f) setFocus(f.dataset['focus']!);
  });
  document.body.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-level], [data-product], [data-flow], [data-stage], [data-stage-all], [data-filter], [data-item]');
    if (!t) return;
    const d = t.dataset;
    if (d['level']) {
      level = d['level'] as typeof level;
      if (level === 'product' && !productName) productName = flows[0]?.product ?? '';
    } else if (d['product'] !== undefined) {
      productName = d['product'];
      level = 'product';
    }
    else if (d['stageAll']) {
      station = d['stageAll'] as StageKey;
      level = 'intent';
      filter = 'all';
    } else if (d['flow'] !== undefined && d['stage'] === undefined) {
      selected = d['flow'];
      productName = flows.find((x) => x.id === selected)?.product ?? productName;
      level = 'intent';
      filter = 'all';
    } else if (d['stage']) {
      if (d['flow']) selected = d['flow'];
      station = d['stage'] as StageKey;
      level = 'intent';
      filter = 'all';
    } else if (d['filter']) filter = d['filter'];
    else if (d['item']) {
      const f = flows.find((x) => x.id === selected);
      const r = f && trail(f, d['item']);
      if (r) drawer.open(r.title, r.html, t);
      return;
    }
    render();
    const again = document.querySelector<HTMLElement>(Object.entries(d).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${v}"]`).join(''));
    again?.focus();
  });
  window.addEventListener('storage', (e) => {
    if (e.key !== 'intent-studio:v1') return;
    const s = studioFlow(e.newValue, feed);
    flows = [...flows.filter((x) => x.source !== 'studio'), ...(s ? [s] : [])];
    render();
  });
}

void start();
