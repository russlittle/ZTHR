/**
 * Mission control, at three levels: the platform (every intent through every stage, and the library they all draw
 * on), one intent (its five stations, each opening what was measured there), and one item (a journey's trail from
 * intent to release). Lamps carry a symbol as well as a colour; every count links to the evidence behind it.
 */
import { STAGES, type Flow, type Item, type Light, type Stage, type StageKey } from './pipeline.ts';
import { esc } from './views.ts';

const WORD: Record<Light, string> = { pass: 'holds', fail: 'open or failing', 'not measured': 'not measured', waiting: 'waiting' };
export const lamp = (l: Light, label = WORD[l]) => `<span class="lamp ${l === 'not measured' ? 'unk' : l}" role="img" aria-label="${esc(label)}"><span aria-hidden="true">${l === 'pass' ? '✓' : l === 'fail' ? '✕' : l === 'waiting' ? '…' : '?'}</span></span>`;

function bar(m: Flow['measure']): string {
  const n = m.total || 1;
  const seg = (v: number, c: string, t: string) => (v ? `<span class="seg ${c}" style="width:${(v / n) * 100}%" title="${v} ${t}"></span>` : '');
  return `<div class="mbar" role="img" aria-label="${m.pass} of ${m.total} journeys pass, ${m.fail} fail, ${m.unmeasured} not yet measured">${seg(m.pass, 'pass', 'pass')}${seg(m.fail, 'fail', 'fail')}${seg(m.unmeasured, 'unk', 'not yet measured')}</div>`;
}

/** The measure, said honestly: nothing measured is not the same as nothing passing. */
export function measureLine(f: Flow): { big: string; verdict: string; cls: string } {
  const m = f.measure;
  if (!m.total) return { big: 'No journeys yet', verdict: 'Add an outcome to the drawing: each becomes a journey', cls: 'unk' };
  if (m.pass + m.fail === 0) return { big: `${m.total} journey${m.total === 1 ? '' : 's'} waiting to be walked`, verdict: f.source === 'studio' ? 'Not built yet: release the intent and hand the package to the factory' : 'Not measured in this build', cls: 'unk' };
  if (m.pass === m.total) return { big: `All ${m.total} journeys pass`, verdict: 'Working software', cls: 'ok' };
  return { big: `${m.pass} of ${m.total} journeys pass`, verdict: m.fail ? `Not working yet: ${m.fail} fail${m.unmeasured ? `, ${m.unmeasured} not walked` : ''}` : `Partly proven: ${m.unmeasured} not walked`, cls: m.fail ? 'bad' : 'unk' };
}

export function platform(flows: readonly Flow[], lib: { assemblies: readonly { name: string; tests: number; mutationFloor?: number }[]; parts: number; groups: number; minimum: number; minimumName: string }): string {
  const total = flows.reduce((a, f) => ({ pass: a.pass + f.measure.pass, fail: a.fail + f.measure.fail, unmeasured: a.unmeasured + f.measure.unmeasured, total: a.total + f.measure.total }), { pass: 0, fail: 0, unmeasured: 0, total: 0 });
  const stageCount = (k: StageKey, l: Light) => flows.filter((f) => f.stages.find((s) => s.key === k)!.light === l).length;
  const station = (s: (typeof STAGES)[number], i: number) =>
    `<li class="station"><button type="button" class="st-card" data-stage-all="${s.key}"><span class="st-n">${i + 1}</span><span class="st-name">${esc(s.label)}</span><span class="st-asks">${esc(s.asks)}</span><span class="st-lamps">${flows.map((f) => lamp(f.stages.find((x) => x.key === s.key)!.light, `${f.title}: ${WORD[f.stages.find((x) => x.key === s.key)!.light]}`)).join('')}</span><span class="st-sum">${stageCount(s.key, 'pass')} of ${flows.length} hold</span></button></li>`;
  const tests = lib.assemblies.reduce((a, b) => a + b.tests, 0);
  const flow = `<div class="sysflow" role="group" aria-label="The platform: intent in, software out">
<p class="io in">Intent in</p>
<ol class="stations">${STAGES.map(station).join('')}</ol>
<p class="io out">Working software out</p>
<div class="loops"><p class="loop ratchet"><span aria-hidden="true">↺</span> QA to build: every defect found becomes a ratchet, so it can never come back</p><p class="loop fleet"><span aria-hidden="true">↻</span> Release to the library: a fix to a standard assembly is pushed to every app that uses it</p></div>
<div class="libbox"><p class="lib-h"><strong>The library every intent draws on in design</strong>, maintained by the fleet</p><ul class="lib-stats"><li><span class="n">${lib.assemblies.length}</span> standard assemblies, ${tests} tests between them</li><li><span class="n">${lib.parts}</span> catalogued parts in ${lib.groups} groups</li><li><span class="n">${lib.minimum}</span> in the ${esc(lib.minimumName)}, inherited by every app</li></ul><details><summary>The standard assemblies</summary><ul class="asm">${lib.assemblies.map((a) => `<li><code>${esc(a.name)}</code> <span class="muted">${a.tests} tests${a.mutationFloor ? `, mutation floor ${a.mutationFloor}%` : ''}</span></li>`).join('')}</ul></details></div>
</div>`;
  const rows = flows
    .map((f) => {
      const ml = measureLine(f);
      return `<tr><th scope="row"><button type="button" class="link-row" data-flow="${esc(f.id)}"><span class="src-tag">${f.source === 'factory' ? 'in the factory' : 'in your studio'}</span><span class="ftitle">${esc(f.title)}</span></button></th>${f.stages.map((s) => `<td><button type="button" class="cell-btn" data-flow="${esc(f.id)}" data-stage="${s.key}" aria-label="${esc(`${f.title}, ${s.key}: ${s.headline}`)}">${lamp(s.light)}<span class="cell-t">${esc(s.headline)}</span></button></td>`).join('')}<td class="measure-cell">${bar(f.measure)}<span class="small">${esc(ml.big)}</span></td></tr>`;
    })
    .join('');
  const table = `<div class="tbl-wrap"><table class="swim"><caption>Every intent, every stage. Select a row to open it, or a cell to open that stage.</caption><thead><tr><th scope="col"><span class="sr">Intent</span></th>${STAGES.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('')}<th scope="col">The measure</th></tr></thead><tbody>${rows || `<tr><td colspan="7">No intents yet. <a href="/intent">Write one in the studio</a>.</td></tr>`}</tbody></table></div>`;
  return `<section class="sheet measure" aria-label="The measure across the platform"><div class="headline"><p class="eyebrowless">Across the platform</p><p class="big">${total.total && total.pass + total.fail === 0 ? `<span class="num">${total.total}</span> journeys waiting to be walked` : `<span class="num">${total.pass}</span> of <span class="num">${total.total}</span> journeys pass`}</p><p class="verdict v-${total.total && total.pass === total.total ? 'ok' : total.fail ? 'bad' : 'unk'}">${total.pass + total.fail === 0 ? 'Nothing walked yet: the measure fills in as the factory walks each journey' : total.fail ? `${total.fail} failing, ${total.unmeasured} not walked` : `${total.unmeasured} not walked yet`}</p>${bar(total)}</div></section>
<section class="sheet" aria-labelledby="h-sys"><h2 id="h-sys">How the platform works</h2><p class="muted">Every intent goes through the same five stations the factory runs. Lamps show where each intent stands at each station: ✓ holds, ✕ open or failing, ? not measured, … waiting for an earlier station.</p>${flow}</section>
<section class="sheet" aria-labelledby="h-swim"><h2 id="h-swim">Intents through the stations</h2>${table}</section>`;
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
