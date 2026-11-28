/**
 * Mission control, at three levels: the platform (every intent through every stage, and the library they all draw
 * on), one intent (its five stations, each opening what was measured there), and one item (a journey's trail from
 * intent to release). Lamps carry a symbol as well as a colour; every count links to the evidence behind it.
 */
import { OUTPUTS, STAGES, type Flow, type Item, type Light, type Stage, type StageKey, type Use } from './pipeline.ts';
import { esc } from './views.ts';

const WORD: Record<Light, string> = { pass: 'holds', fail: 'open or failing', 'not measured': 'not measured', waiting: 'waiting' };
export const lamp = (l: Light, label = WORD[l]) => `<span class="lamp ${l === 'not measured' ? 'unk' : l}" role="img" aria-label="${esc(label)}"><span aria-hidden="true">${l === 'pass' ? '✓' : l === 'fail' ? '✕' : l === 'waiting' ? '…' : '?'}</span></span>`;

export function bar(m: Flow['measure']): string {
  const n = m.total || 1;
  const seg = (v: number, c: string, t: string) => (v ? `<span class="seg ${c}" style="width:${(v / n) * 100}%" title="${v} ${t}"></span>` : '');
  return `<div class="mbar" role="img" aria-label="${m.pass} of ${m.total} journeys pass, ${m.fail} fail, ${m.unmeasured} not yet measured">${seg(m.pass, 'pass', 'pass')}${seg(m.fail, 'fail', 'fail')}${seg(m.unmeasured, 'unk', 'not yet measured')}</div>`;
}

/** The measure, said honestly: nothing measured is not the same as nothing passing. */
export function measureLine(f: Flow): { big: string; verdict: string; cls: string } {
  const m = f.measure;
  if (!m.total) return { big: 'No journeys yet', verdict: 'Add an outcome to the schematic: each becomes a journey', cls: 'unk' };
  if (m.pass + m.fail === 0) return { big: `${m.total} journey${m.total === 1 ? '' : 's'} waiting to be walked`, verdict: f.source === 'studio' ? 'Not built yet: release the intent and hand the package to the factory' : 'Not measured in this build', cls: 'unk' };
  if (m.pass === m.total) return { big: `All ${m.total} journeys pass`, verdict: 'Working software', cls: 'ok' };
  return { big: `${m.pass} of ${m.total} journeys pass`, verdict: m.fail ? `Not working yet: ${m.fail} fail${m.unmeasured ? `, ${m.unmeasured} not walked` : ''}` : `Partly proven: ${m.unmeasured} not walked`, cls: m.fail ? 'bad' : 'unk' };
}

export interface Lib {
  readonly assemblies: readonly { name: string; tests: number; mutationFloor?: number }[];
  readonly parts: number;
  readonly groups: number;
  readonly minimum: number;
  readonly minimumName: string;
}

/** Where each standard assembly is used, and for what: one part number, many intended uses. */
export function whereUsed(lib: Lib, flows: readonly Flow[]): string {
  const uses = flows.flatMap((f) => f.uses);
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Where used"><table class="swim wu"><caption>Where used: each standard assembly, every product and intent that uses it, and what for. One part number serves every use it was designed for; a new use that does not fit is a new part.</caption><thead><tr><th scope="col">Standard assembly</th><th scope="col">Used by</th><th scope="col">Intended uses</th></tr></thead><tbody>${lib.assemblies
    .map((a) => {
      const us = uses.filter((u) => u.assembly === a.name);
      const by = [...new Set(us.map((u) => `${u.product}`))];
      const kinds = [...new Set(us.map((u) => u.use.split(':')[0]!))];
      return `<tr><th scope="row"><code>${esc(a.name)}</code><span class="muted small"> ${a.tests} tests${a.mutationFloor ? `, floor ${a.mutationFloor}%` : ''}</span></th><td>${by.length ? by.map(esc).join(', ') : '<span class="muted">not used yet</span>'}</td><td>${kinds.length ? `${kinds.length} use${kinds.length === 1 ? '' : 's'}: ${kinds.slice(0, 6).map(esc).join('; ')}${kinds.length > 6 ? `; and ${kinds.length - 6} more` : ''}` : ''}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

export function products(flows: readonly Flow[]): { name: string; flows: Flow[] }[] {
  const by = new Map<string, Flow[]>();
  for (const f of flows) by.set(f.product, [...(by.get(f.product) ?? []), f]);
  return [...by.entries()].map(([name, fs]) => ({ name, flows: fs }));
}

const CLASS_ORDER = ['health', 'financial', 'private', 'contact'];
const FW: Record<string, string> = { soc2: 'SOC 2', hipaa: 'HIPAA', ferpa: 'FERPA', pci: 'PCI DSS', glba: 'GLBA', 'nist-800-171': 'NIST 800-171', 'nist-800-53': 'NIST 800-53', 'section-508': 'Section 508' };

/** Every app reports its sensitive data the same way, so the fleet is read, governed and gated as one. */
export function fleetSensitive(flows: readonly Flow[]): string {
  const reported = flows.filter((f) => f.sensitive);
  const total = (c: string) => reported.reduce((a, f) => a + (f.sensitive!.classes[c] ?? 0), 0);
  const rows = flows
    .map((f) => `<tr><th scope="row">${esc(f.title)}<span class="muted small"> ${esc(f.product)}</span></th>${f.sensitive ? CLASS_ORDER.map((c) => `<td class="num">${f.sensitive!.classes[c] ?? 0}</td>`).join('') + `<td>${esc(f.sensitive.frameworks.map((x) => FW[x] ?? x).join(', ') || 'none in scope')}${f.sensitive.suggested.filter((x) => x !== 'soc2').length ? `<span class="small"> · suggested: ${esc(f.sensitive.suggested.filter((x) => x !== 'soc2').map((x) => FW[x] ?? x).join(', '))}</span>` : ''}</td>` : `<td colspan="${CLASS_ORDER.length + 1}" class="muted small">not reported yet: its build does not publish compliance/data-inventory.json</td>`}</tr>`)
    .join('');
  return `<p class="muted">Every app's release carries the same inventory of its sensitive fields, and one gate policy, so a central gateway decides reads, exports and queries by class the same way for all of them, and every decision is audited.</p><ul class="lib-stats">${CLASS_ORDER.map((c) => `<li><span class="n">${total(c)}</span> ${c} fields</li>`).join('')}<li><span class="n">${reported.length}</span> of ${flows.length} intents reporting</li></ul><div class="tbl-wrap" tabindex="0" role="region" aria-label="Sensitive data by intent"><table class="swim"><thead><tr><th scope="col">Intent</th>${CLASS_ORDER.map((c) => `<th scope="col">${c}</th>`).join('')}<th scope="col">Frameworks</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function platform(flows: readonly Flow[], lib: Lib, extra = ''): string {
  const total = flows.reduce((a, f) => ({ pass: a.pass + f.measure.pass, fail: a.fail + f.measure.fail, unmeasured: a.unmeasured + f.measure.unmeasured, total: a.total + f.measure.total }), { pass: 0, fail: 0, unmeasured: 0, total: 0 });
  const stageCount = (k: StageKey, l: Light) => flows.filter((f) => f.stages.find((s) => s.key === k)!.light === l).length;
  const station = (s: (typeof STAGES)[number], i: number) =>
    `<li class="station"><button type="button" class="st-card" data-stage-all="${s.key}"><span class="st-n">${i + 1}</span><span class="st-name">${esc(s.label)}</span><span class="st-asks">${esc(s.asks)}</span><span class="st-lamps">${flows.map((f) => lamp(f.stages.find((x) => x.key === s.key)!.light, `${f.title}: ${WORD[f.stages.find((x) => x.key === s.key)!.light]}`)).join('')}</span><span class="st-sum">${stageCount(s.key, 'pass')} of ${flows.length} hold</span></button></li>`;
  const tests = lib.assemblies.reduce((a, b) => a + b.tests, 0);
  const flow = `<div class="sysflow" role="group" aria-label="The platform: intent in, software out">
<p class="io in">Intent in</p>
<ol class="stations">${STAGES.map(station).join('')}</ol>
<p class="io out">Working software out</p>
<div class="loops"><p class="loop ratchet"><span aria-hidden="true">↺</span> QA to build: every defect found becomes a ratchet, so it can never come back</p><p class="loop fleet"><span aria-hidden="true">↻</span> Release to the library: a fix to a standard assembly is pushed to every app that uses it</p><p class="loop night"><span aria-hidden="true">↻</span> Beneath every department: what is tagged by day, maintenance works by night, through the same gates</p></div>
<div class="libbox"><p class="lib-h"><strong>The library every intent draws on in design</strong>, maintained by the fleet</p><ul class="lib-stats"><li><span class="n">${lib.assemblies.length}</span> standard assemblies, ${tests} tests between them</li><li><span class="n">${lib.parts}</span> catalogued parts in ${lib.groups} groups</li><li><span class="n">${lib.minimum}</span> in the ${esc(lib.minimumName)}, inherited by every app</li></ul><details><summary>The standard assemblies</summary><ul class="asm">${lib.assemblies.map((a) => `<li><code>${esc(a.name)}</code> <span class="muted">${a.tests} tests${a.mutationFloor ? `, mutation floor ${a.mutationFloor}%` : ''}</span></li>`).join('')}</ul></details></div>
</div>`;
  const prods = products(flows)
    .map((pr) => {
      const m = pr.flows.reduce((a, f) => ({ pass: a.pass + f.measure.pass, fail: a.fail + f.measure.fail, unmeasured: a.unmeasured + f.measure.unmeasured, total: a.total + f.measure.total }), { pass: 0, fail: 0, unmeasured: 0, total: 0 });
      const validated = pr.flows.filter((f) => f.outputs.validated.light === 'pass').length;
      return `<li><button type="button" class="pcard-btn" data-product="${esc(pr.name)}"><span class="src-tag">product</span><span class="ftitle">${esc(pr.name)}</span><span class="small">${pr.flows.length} intent${pr.flows.length === 1 ? '' : 's'} · ${validated} validated · held by ${esc([...new Set(pr.flows.map((f) => f.holder ?? 'not recorded'))].join(', '))}</span>${bar(m)}<span class="small muted">${m.pass + m.fail ? `${m.pass} of ${m.total} journeys pass` : `${m.total} journeys waiting to be walked`}</span></button></li>`;
    })
    .join('');
  const table = `<ul class="prod-list">${prods || '<li>No products yet. <a href="/intent">Write an intent in the studio</a>.</li>'}</ul>`;
  return `${extra}<section class="sheet measure" aria-label="The measure across the platform"><div class="headline"><p class="eyebrowless">Across the platform</p><p class="big">${total.total && total.pass + total.fail === 0 ? `<span class="num">${total.total}</span> journeys waiting to be walked` : `<span class="num">${total.pass}</span> of <span class="num">${total.total}</span> journeys pass`}</p><p class="verdict v-${total.total && total.pass === total.total ? 'ok' : total.fail ? 'bad' : 'unk'}">${total.pass + total.fail === 0 ? 'Nothing walked yet: the measure fills in as the factory walks each journey' : total.fail ? `${total.fail} failing, ${total.unmeasured} not walked` : `${total.unmeasured} not walked yet`}</p>${bar(total)}</div></section>
<section class="sheet" aria-labelledby="h-sys"><h2 id="h-sys">How the platform works</h2><p class="muted">Every intent goes through the same departments, from the intent studio to shipping. Lamps show where each intent stands at each: ✓ holds, ✕ open or failing, ? not measured, … waiting for an earlier department. Select a department for every intent's reading there.</p>${flow}</section>
<section class="sheet" aria-labelledby="h-fl"><h2 id="h-fl">The fleet</h2><p><a href="/fleet">The fleet: what is in service, the library where used, and sensitive data across every app</a></p></section>
<section class="sheet" aria-labelledby="h-my"><h2 id="h-my">Metrology</h2><p><a href="/metrology">The lab: which gauges QA may use, the measures and their references, control charts on the factory, and the claims audit</a></p></section>
<section class="sheet" aria-labelledby="h-mt"><h2 id="h-mt">Maintenance</h2><p><a href="/maintenance">The night shift: the morning report, what every department tagged, gauge scores per block, and the crew's cost and pass rates</a></p></section>`;
}

export function intent(f: Flow, station: StageKey, filter: string): string {
  const ml = measureLine(f);
  const head = `<section class="sheet measure" aria-label="The measure"><div class="headline"><p class="eyebrowless">The measure for <strong>${esc(f.title)}</strong>${f.end ? `: ${esc(f.end)}` : ''}</p><p class="big">${esc(ml.big)}</p><p class="verdict v-${ml.cls}">${esc(ml.verdict)}</p>${bar(f.measure)}<p class="muted small">A journey passes only when a person reaches their goal, in every mode and channel it names, with nothing forbidden happening.</p></div></section>`;
  const stations = `<ol class="stations line" aria-label="Stations">${STAGES.map((s, i) => {
    const st = f.stages.find((x) => x.key === s.key)!;
    return `<li class="station"><button type="button" class="st-card${station === s.key ? ' on' : ''}" data-stage="${s.key}" aria-pressed="${station === s.key}"><span class="st-n">${i + 1}</span><span class="st-name">${lamp(st.light)}${esc(s.label)}</span><span class="st-asks">${esc(st.headline)}</span></button></li>`;
  }).join('')}</ol>`;
  const st = f.stages.find((x) => x.key === station)!;
  const detail = stageDetail(f, st, filter);
  return `${head}<section class="sheet" aria-labelledby="h-st"><h2 id="h-st" class="sr">Stations</h2>${stations}<div class="st-detail">${detail}</div></section>`;
}

function readingRows(rs: Stage['readings']): string {
  return rs.length
    ? `<ul class="readings">${rs.map((r) => `<li>${r.href ? `<a class="reading" href="${esc(r.href)}">` : '<div class="reading">'}<span class="rlabel">${esc(r.label)}</span><span class="rval">${lamp(r.light)}${r.value === null ? (r.light === 'waiting' ? 'waiting' : 'not measured') : `${r.value.toLocaleString()}${r.note === '%' ? '%' : ''}${r.of !== null && r.note !== '%' && r.of > 0 ? ` of ${r.of.toLocaleString()}` : ''}`}${r.note && r.note !== '%' ? ` <span class="muted small">${esc(r.note)}</span>` : ''}</span>${r.value !== null && r.of ? `<span class="gauge" aria-hidden="true"><span style="width:${Math.min(100, Math.round((r.value / r.of) * 100))}%"></span></span>` : ''}${r.href ? '</a>' : '</div>'}</li>`).join('')}</ul>`
    : '<p class="muted">Nothing to report at this station yet.</p>';
}

function stageDetail(f: Flow, st: Stage, filter: string): string {
  const s = STAGES.find((x) => x.key === st.key)!;
  const items = f.items.filter((i) => filter === 'all' || i.trail[st.key].light === filter);
  const counts = (['pass', 'fail', 'not measured', 'waiting'] as Light[]).map((l) => [l, f.items.filter((i) => i.trail[st.key].light === l).length] as const).filter(([, n]) => n);
  const chips = `<div class="filters" role="group" aria-label="Show">${[['all', f.items.length] as const, ...counts].map(([k, n]) => `<button type="button" class="chip${filter === k ? ' on' : ''}" aria-pressed="${filter === k}" data-filter="${esc(String(k))}">${k === 'all' ? 'All' : esc(WORD[k as Light][0]!.toUpperCase() + WORD[k as Light].slice(1))} ${n}</button>`).join('')}</div>`;
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const k = i.phase === null ? 'Journeys' : `Phase ${i.phase}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const list = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, is]) => `<h3 class="phase-h">${esc(k)} <span class="muted">${is.length}</span></h3><ul class="jlist">${is.map((i) => `<li><button type="button" class="jrow" data-item="${esc(i.id)}">${lamp(i.trail[st.key].light)}<span class="jgoal">${esc(i.label)}</span><span class="jmeta">${esc(i.trail[st.key].text)}${i.persona ? ` · as ${esc(i.persona)}` : ''}</span></button></li>`).join('')}</ul>`)
    .join('');
  return `<div class="st-grid"><div><h3 class="sub-h">${esc(s.label)}: ${esc(s.asks)}</h3>${readingRows(st.readings)}${f.source === 'studio' && (st.key === 'intent' || st.key === 'design') ? `<p><a class="btn" href="/intent">Open in the studio</a></p>` : ''}</div><div><h3 class="sub-h">Every journey at this station</h3>${chips}<div class="scroll">${list || '<p class="muted">None here.</p>'}</div></div></div>`;
}

export function trail(f: Flow, id: string): { title: string; html: string } | null {
  const i = f.items.find((x) => x.id === id);
  if (!i) return null;
  return {
    title: 'One journey, through every station',
    html: `<p class="dr-text">${esc(i.label)}</p>${i.persona ? `<p class="muted">As ${esc(i.persona)}${i.phase !== null ? `, phase ${i.phase}` : ''} · <code>${esc(i.id)}</code></p>` : ''}<ol class="trail">${STAGES.map((s) => `<li class="t-${i.trail[s.key].light === 'not measured' ? 'unk' : i.trail[s.key].light}">${lamp(i.trail[s.key].light)}<div><strong>${esc(s.label)}</strong><p>${esc(i.trail[s.key].text)}</p></div></li>`).join('')}</ol>${f.source === 'factory' ? '<p><a href="/reference/factory/intent.html">Every journey in the evidence</a></p>' : '<p><a href="/intent">Open it in the studio</a></p>'}`,
  };
}

export function product(name: string, flows: readonly Flow[]): string {
  const fs = flows.filter((f) => f.product === name);
  const m = fs.reduce((a, f) => ({ pass: a.pass + f.measure.pass, fail: a.fail + f.measure.fail, unmeasured: a.unmeasured + f.measure.unmeasured, total: a.total + f.measure.total }), { pass: 0, fail: 0, unmeasured: 0, total: 0 });
  const rows = fs
    .map((f) => `<tr><th scope="row"><button type="button" class="link-row" data-flow="${esc(f.id)}"><span class="ftitle">${esc(f.title)}</span><span class="small muted">${f.people.length} people · ${f.measure.total} journeys</span></button></th>${OUTPUTS.map((o) => `<td><button type="button" class="cell-btn" data-flow="${esc(f.id)}" data-stage="${o.key === 'spec' ? 'intent' : o.key === 'code' ? 'build' : o.key === 'tests' || o.key === 'evidence' ? 'qa' : 'release'}" aria-label="${esc(`${f.title}, ${o.label}: ${f.outputs[o.key].text}`)}">${lamp(f.outputs[o.key].light)}<span class="cell-t">${esc(f.outputs[o.key].text)}</span></button></td>`).join('')}</tr>`)
    .join('');
  return `<section class="sheet measure" aria-label="The measure for the product"><div class="headline"><p class="eyebrowless">Product</p><p class="big">${esc(name)}</p><p class="verdict v-${m.total && m.pass === m.total ? 'ok' : m.fail ? 'bad' : 'unk'}">${m.pass + m.fail ? `${m.pass} of ${m.total} journeys pass across ${fs.length} intent${fs.length === 1 ? '' : 's'}` : `${m.total} journey${m.total === 1 ? '' : 's'} across ${fs.length} intent${fs.length === 1 ? '' : 's'}, waiting to be walked`}</p>${bar(m)}</div></section>
<section class="sheet" aria-labelledby="h-pass"><h2 id="h-pass">One pass per intent</h2><p class="muted">Each intent is made into all of these together, in one pass of the factory, and the pass is not done until every one holds.</p><div class="tbl-wrap"><table class="swim"><thead><tr><th scope="col">Intent</th>${OUTPUTS.map((o) => `<th scope="col">${esc(o.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

const DEPT_HREF: Record<StageKey, string> = { intent: '/intent', design: '/engineering', build: '/factory', qa: '/qa', release: '/shipping' };

/** Every product along the line: one row each, a lamp at every department, each lamp a way into that department. */
export function along(flows: readonly Flow[], lines: readonly { name: string; products: readonly string[] }[]): string {
  const names = [...new Set(flows.map((f) => f.product))];
  if (!names.length) return '<p>No products yet. <a href="/lines">Define a product line</a> and start one.</p>';
  const lineOf = (n: string) => lines.find((l) => l.products.includes(n))?.name ?? (flows.some((f) => f.product === n && f.source !== 'studio') ? 'Student success (reference)' : 'not in a line');
  const worst = (n: string, k: StageKey): Light => {
    const ls = flows.filter((f) => f.product === n).map((f) => f.stages.find((x) => x.key === k)!.light);
    return (['fail', 'not measured', 'waiting', 'pass'] as Light[]).find((l) => ls.includes(l)) ?? 'waiting';
  };
  return `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Products along the line"><table class="swim along"><caption class="sr">Each product, and where it stands in each department</caption><thead><tr><th scope="col">Product</th><th scope="col">Line</th>${STAGES.map((st) => `<th scope="col"><a href="${DEPT_HREF[st.key]}">${esc(st.label)}</a></th>`).join('')}<th scope="col"><a href="/fleet">Fleet</a></th></tr></thead><tbody>${names
    .map((n) => {
      const rel = worst(n, 'release');
      return `<tr><th scope="row"><button type="button" class="linklike" data-product="${esc(n)}">${esc(n)}</button></th><td class="small">${esc(lineOf(n))}</td>${STAGES.map((st) => { const l = worst(n, st.key); const href = st.key === 'intent' || st.key === 'design' ? `${DEPT_HREF[st.key]}?product=${encodeURIComponent(n)}` : DEPT_HREF[st.key]; return `<td><a class="cell-lamp" href="${esc(href)}" data-focus="${esc(n)}">${lamp(l, `${n}, ${st.label}: ${WORD[l]}`)}</a></td>`; }).join('')}<td>${lamp(rel === 'pass' ? 'pass' : 'waiting', `${n}, fleet: ${rel === 'pass' ? 'in service' : 'not in service yet'}`)}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
}

/** What waits on a person: only what this browser can know; the factory's own proposals are read with the agent API. */
export function waiting(items: readonly { what: string; href: string; act: string }[]): string {
  return items.length ? `<ul class="wait">${items.map((x) => `<li><span>${esc(x.what)}</span><a class="btn" href="${esc(x.href)}">${esc(x.act)}</a></li>`).join('')}</ul>` : '<p class="muted">Nothing here is waiting on you.</p>';
}
