/**
 * Product lines: define a line once, start products in it, and open any of them in the studio. The reference line,
 * Student success, is read from the factory's feed.
 */
import { FRAMEWORKS } from '../compliance.ts';
import { byKind } from '../connectors.ts';
import type { Options } from '../interfaces.ts';
import { loadFeed, type Feed } from './feed.ts';
import { flowInFocus, handoff, paintLine, setFocus } from './line.ts';
import { factoryFlows, STAGES, studioFlow, type Flow } from './pipeline.ts';
import { addToLine, lines, openProduct, products, saveLine, startProduct, type Line } from './products.ts';
import { $ } from './shell.ts';
import { esc } from './views.ts';
import { lamp } from './missionViews.ts';

let feed: Feed | null = null;
let say = '';

const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

const ID: [string, string][] = byKind('identity').map((c) => [c.id, c.name]);
const TICKETS: [string, string][] = [['none', 'None'], ...byKind('tickets').map((c) => [c.id, c.name] as [string, string])];
const CHAT: [string, string][] = [['none', 'None'], ...byKind('chat').map((c) => [c.id, c.name] as [string, string])];
const opt = (list: [string, string][], v: string | undefined) => list.map(([k, n]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(n)}</option>`).join('');

function summary(o: Options): string {
  const fw = (o.compliance ?? []).map((id) => FRAMEWORKS.frameworks.find((f) => f.id === id)?.name ?? id);
  return [`Sign-in: ${ID.find(([k]) => k === (o.connect?.identity ?? 'google'))?.[1] ?? 'Google'}`, fw.length ? `Compliance: ${fw.join(', ')}` : 'No compliance framework named', `Report a problem: ${o.feedback ?? 'everywhere'}`, `API: ${o.api?.reach ?? 'off'}`, `Use tracking: ${o.usage ?? 'counts'}`].map((x) => `<li>${esc(x)}</li>`).join('');
}

function form(l?: Line): string {
  const o = l?.defaults ?? {};
  return `<form id="line-form" class="lform" novalidate>
<input type="hidden" name="lineid" value="${esc(l?.id ?? '')}">
<label>Name of the line <input name="name" required value="${esc(l?.name ?? '')}" placeholder="For example: Student services"></label>
<label>Who its products serve <input name="serves" value="${esc(l?.serves ?? '')}" placeholder="For example: students at community colleges, and the staff who help them"></label>
<label class="wide">The end every product in it serves <textarea name="end" rows="2" placeholder="For example: students stay enrolled, housed and fed, so they finish what they started">${esc(l?.end ?? '')}</textarea></label>
<fieldset class="wide"><legend>Compliance every product in the line lives under</legend><div class="chips">${FRAMEWORKS.frameworks.map((f) => `<label class="chk"><input type="checkbox" name="compliance" value="${esc(f.id)}"${(o.compliance ?? []).includes(f.id) ? ' checked' : ''}> ${esc(f.name)}</label>`).join('')}</div></fieldset>
<label>How people sign in <select name="identity">${opt(ID, o.connect?.identity ?? 'google')}</select></label>
<label>Report a problem <select name="feedback">${opt([['everywhere', 'In every environment'], ['testing', 'In testing only'], ['off', 'Off']], o.feedback ?? 'everywhere')}</select></label>
<label>Where tickets go <select name="tickets">${opt(TICKETS, o.connect?.tickets ?? 'none')}</select></label>
<label>Team chat <select name="chat">${opt(CHAT, o.connect?.chat ?? 'none')}</select></label>
<label>API <select name="api">${opt([['off', 'Defined, closed'], ['some', 'Open for some features'], ['all', 'Open for every feature']], o.api?.reach ?? 'off')}</select></label>
<label>Use tracking <select name="usage">${opt([['counts', 'Counts only'], ['consented', 'With consent'], ['off', 'Off']], o.usage ?? 'counts')}</select></label>
<p class="wide form-err" id="line-err" role="alert"></p>
<div class="wide actions"><button class="btn primary" type="submit">${l ? 'Save the line' : 'Define the line'}</button></div>
</form>`;
}

function lineCard(l: Line, flows: readonly Flow[]): string {
  const rows = products().filter((p) => l.products.includes(p.name));
  const lampsFor = (name: string) => {
    const f = flows.find((x) => x.product === name);
    return f ? `<span class="lamps" aria-label="Where it stands">${f.stages.map((s) => lamp(s.light, `${STAGES.find((x) => x.key === s.key)!.label}: ${s.light}`)).join('')}</span>` : '';
  };
  return `<section class="sheet line-card" aria-labelledby="ln-${esc(l.id)}"><h2 id="ln-${esc(l.id)}">${esc(l.name)}</h2>
<p>${l.serves ? `Serves ${esc(l.serves)}. ` : ''}${l.end ? `<strong>To what end:</strong> ${esc(l.end)}` : ''}</p>
<ul class="defaults">${summary(l.defaults)}</ul>
<h3>Products</h3>
${rows.length ? `<ul class="plist">${rows.map((p) => `<li><span class="pname">${esc(p.name)}</span>${lampsFor(p.name)}<span class="small muted">${p.released ? `${p.released} revision${p.released === 1 ? '' : 's'} released` : p.signed ? 'signed, not released' : `${p.words} line${p.words === 1 ? '' : 's'} of intent`}</span><button class="btn" type="button" data-open="${esc(p.name)}">${p.open ? 'Continue in the studio' : 'Open in the studio'}</button></li>`).join('')}</ul>` : '<p class="muted">No products yet.</p>'}
<form class="start" data-line="${esc(l.id)}"><label>New product in ${esc(l.name)} <input name="product" placeholder="For example: Bill help" required></label><button class="btn primary" type="submit">Start it in the studio</button></form>
<details><summary>Change the line's defaults</summary>${form(l).replace('id="line-form"', `id="line-form-${esc(l.id)}" data-edit="1"`).replace('id="line-err"', `id="line-err-${esc(l.id)}"`)}</details>
</section>`;
}

function render(flows: readonly Flow[]) {
  const ls = lines();
  const loose = products().filter((p) => !p.line);
  const ref = feed ? `<section class="sheet line-card ref" aria-labelledby="ln-ref"><h2 id="ln-ref">Student success <span class="src-tag">the reference line</span></h2><p>The line the factory's reference implementation belongs to. Its product, ${esc(flows.find((f) => f.source !== 'studio')?.product ?? 'Student Advocate')}, is built and measured by the factory; every reading is its own.</p><p><a class="btn" href="/qa">See its journeys in QA</a> <a class="btn quiet" href="/fleet">See it in the fleet</a></p></section>` : '';
  $('lines-body').innerHTML = `<p class="status" role="status" id="lines-status">${esc(say)}</p>
${ls.map((l) => lineCard(l, flows)).join('')}
${loose.length ? `<section class="sheet" aria-labelledby="h-loose"><h2 id="h-loose">Products not in a line</h2><ul class="plist">${loose.map((p) => `<li><span class="pname">${esc(p.name)}</span><button class="btn" type="button" data-open="${esc(p.name)}">${p.open ? 'Continue in the studio' : 'Open in the studio'}</button>${ls.length ? `<label class="small">Add to a line <select data-addto="${esc(p.name)}"><option value="">Choose…</option>${ls.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label>` : ''}</li>`).join('')}</ul></section>` : ''}
<section class="sheet" aria-labelledby="h-def"><h2 id="h-def">${ls.length ? 'Define another product line' : 'Define your first product line'}</h2><p class="muted">The choices here are where every product in the line starts. Each product can still change its own on the spec sheet in engineering.</p>${form()}</section>
${ref}`;
  $('handoff-slot').innerHTML = handoff('lines', ls.some((l) => l.products.length > 0) || products().length > 0, ls.length ? 'Start a product in a line, or open one, and say what it must do.' : 'Define a line, start a product in it, and say what it must do.');
}

function readForm(f: HTMLFormElement): Omit<Line, 'id' | 'at' | 'products'> & { id?: string } {
  const d = new FormData(f);
  const v = (k: string) => String(d.get(k) ?? '').trim();
  const defaults = {
    compliance: d.getAll('compliance').map(String),
    connect: { identity: v('identity'), tickets: v('tickets'), chat: v('chat') },
    feedback: v('feedback'),
    api: { reach: v('api') },
    usage: v('usage'),
  } as unknown as Options;
  return { ...(v('lineid') ? { id: v('lineid') } : {}), name: v('name'), serves: v('serves'), end: v('end'), defaults };
}

async function start() {
  document.documentElement.classList.add('js');
  feed = await loadFeed();
  const all = () => {
    const s = studioFlow(studioRaw(), feed);
    return [...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])];
  };
  const draw = () => {
    const flows = all();
    render(flows);
    paintLine(flowInFocus(flows));
  };
  draw();
  document.body.addEventListener('submit', (e) => {
    const f = e.target as HTMLFormElement;
    e.preventDefault();
    if (f.getAttribute('id')?.startsWith('line-form')) {
      const l = readForm(f);
      const err = f.querySelector<HTMLElement>('.form-err');
      if (!l.name) {
        if (err) err.textContent = 'Give the line a name.';
        f.querySelector<HTMLInputElement>('[name=name]')?.focus();
        return;
      }
      if (lines().some((x) => x.name.toLowerCase() === l.name.toLowerCase() && x.id !== l.id)) {
        if (err) err.textContent = `There is already a line called ${l.name}.`;
        return;
      }
      const saved = saveLine(l);
      say = l.id ? `Saved ${saved.name}.` : `Defined ${saved.name}. Start its first product below.`;
      draw();
      document.querySelector<HTMLInputElement>(`form.start[data-line="${saved.id}"] input`)?.focus();
    } else if (f.classList.contains('start')) {
      const line = lines().find((x) => x.id === f.dataset['line']);
      const name = String(new FormData(f).get('product') ?? '').trim();
      if (!line || !name) {
        f.querySelector<HTMLInputElement>('input')?.focus();
        return;
      }
      if (products().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        say = `There is already a product called ${name}. Open it instead, or choose another name.`;
        draw();
        return;
      }
      startProduct(name, line);
      setFocus(name);
      location.href = '/intent';
    }
  });
  document.body.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
    if (!t) return;
    openProduct(t.dataset['open']!);
    setFocus(t.dataset['open']!);
    location.href = '/intent';
  });
  document.body.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (!t.dataset['addto'] || !t.value) return;
    addToLine(t.dataset['addto'], t.value);
    say = `Added ${t.dataset['addto']} to ${lines().find((l) => l.id === t.value)?.name ?? 'the line'}.`;
    draw();
  });
}

void start();
