/**
 * The control surface, drawn as the studio's schematics are: one sheet per concern, lamps for verdicts with a symbol
 * as well as a colour, and every count a link to the evidence that makes it.
 */
import { EVIDENCE, tally, type Feed, type IntentRow, type Reading, type Status } from './feed.ts';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const GH = 'https://github.com/russlittle/ZTHR/commit/';

const WORD: Record<Status, string> = { pass: 'passes', fail: 'fails', 'not measured': 'not measured' };
export const lamp = (s: Status, label = WORD[s]) => `<span class="lamp ${s === 'not measured' ? 'unk' : s}" role="img" aria-label="${esc(label)}"><span aria-hidden="true">${s === 'pass' ? '✓' : s === 'fail' ? '✕' : '?'}</span></span>`;

export function measure(row: IntentRow): string {
  const t = tally(row);
  const n = row.journeys.length || 1;
  const seg = (k: Status, cls: string) => (t[k] ? `<span class="seg ${cls}" style="width:${(t[k] / n) * 100}%" title="${t[k]} ${WORD[k]}"></span>` : '');
  return `<div class="mbar" role="img" aria-label="${t.pass} of ${row.journeys.length} journeys pass, ${t.fail} fail, ${t['not measured']} not measured">${seg('pass', 'pass')}${seg('fail', 'fail')}${seg('not measured', 'unk')}</div>`;
}

export function headline(row: IntentRow | null, feed: Feed | null): string {
  if (!row) return `<div class="headline"><p class="big">No intent yet</p><p class="muted">Write one in the <a href="/intent">studio</a>; it appears here as soon as you do.</p></div>`;
  const t = tally(row);
  const all = row.journeys.length;
  const verdict = !all ? 'No journeys yet' : t.pass === all ? 'Working software' : t.fail ? 'Not working yet' : t.pass ? 'Partly proven' : row.source === 'studio' ? 'Not built yet' : 'Not measured in this build';
  const none = all > 0 && t.pass + t.fail === 0;
  return `<div class="headline"><div><p class="eyebrowless">The measure for <strong>${esc(row.title)}</strong></p><p class="big">${none ? `<span class="num">${all}</span> journeys waiting to be walked` : `<span class="num">${t.pass}</span> of <span class="num">${all}</span> journeys pass`}</p><p class="verdict v-${t.pass === all && all ? 'ok' : t.fail ? 'bad' : 'unk'}">${esc(verdict)}${t.fail ? `: ${t.fail} fail` : ''}${t['not measured'] ? `${t.fail ? ',' : ':'} ${t['not measured']} not measured` : ''}</p></div>${measure(row)}<p class="muted small">Working software is the measure: a journey passes only when a person's goal is reached, in every mode and channel it names, with nothing forbidden happening.${feed ? ` Factory build <a href="${GH}${esc(feed.commit)}">${esc(feed.commit.slice(0, 7))}</a>, ${esc(when(feed.builtAt))}.` : ''}</p></div>`;
}

export function when(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'time not recorded';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function intentCard(row: IntentRow, selected: boolean): string {
  const t = tally(row);
  return `<li><button type="button" class="icard${selected ? ' on' : ''}" data-intent="${esc(row.id)}" aria-pressed="${selected}"><span class="src-tag">${row.source === 'factory' ? 'in the factory' : 'in your studio'}</span><span class="ititle">${esc(row.title)}</span>${row.end ? `<span class="iend">${esc(row.end)}</span>` : ''}<span class="inote">${esc(row.note)}</span>${measure(row)}<span class="icount"><span>${t.pass} pass</span><span>${t.fail} fail</span><span>${t['not measured']} not measured</span></span></button></li>`;
}

export function journeys(row: IntentRow, filter: Status | 'all'): string {
  const shown = row.journeys.filter((j) => filter === 'all' || j.status === filter);
  const t = tally(row);
  const groups = new Map<string, typeof shown>();
  for (const j of shown) {
    const k = j.phase === null ? 'Journeys' : `Phase ${j.phase}`;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  const chips = (['all', 'pass', 'fail', 'not measured'] as const).map((k) => `<button type="button" class="chip${filter === k ? ' on' : ''}" aria-pressed="${filter === k}" data-filter="${k}">${k === 'all' ? `All ${row.journeys.length}` : `${k === 'not measured' ? 'Not measured' : k === 'pass' ? 'Pass' : 'Fail'} ${t[k]}`}</button>`).join('');
  return `<div class="filters" role="group" aria-label="Show journeys">${chips}</div>${
    shown.length
      ? [...groups.entries()]
          .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
          .map(([k, js]) => `<h3 class="phase-h">${esc(k)} <span class="muted">${js.filter((j) => j.status === 'pass').length} of ${js.length} pass</span></h3><ul class="jlist">${js.map((j) => `<li><button type="button" class="jrow" data-journey="${esc(j.id)}">${lamp(j.status)}<span class="jgoal">${esc(j.goal)}</span><span class="jmeta">as ${esc(j.persona)}${j.channels.length ? ` · ${esc(j.channels.join(' and '))}` : ''}${j.modes.length ? ` · ${esc(j.modes.join(', '))}` : ''}</span></button></li>`).join('')}</ul>`)
          .join('')
      : '<p class="muted">None here.</p>'
  }`;
}

const pct = (r: Reading) => (r.value === null || r.of === null || !r.of ? null : r.value / r.of);

export function readings(feed: Feed): string {
  return `<ul class="readings">${feed.readings
    .map((r) => {
      const p = pct(r);
      const held = r.value !== null && (r.floor != null ? r.value >= r.floor : r.of !== null && r.value >= r.of);
      const val = r.value === null ? 'not measured' : `${r.value.toLocaleString()}${r.unit ?? ''}${r.of !== null && r.unit !== '%' ? ` of ${r.of.toLocaleString()}` : ''}`;
      return `<li><a class="reading" href="${EVIDENCE}/${esc(r.href)}"><span class="rlabel">${esc(r.label)}</span><span class="rval">${r.value === null ? lamp('not measured') : lamp(held ? 'pass' : 'fail', held ? 'held' : 'below its floor')}${esc(val)}</span><span class="gauge" aria-hidden="true"><span style="width:${p === null ? 0 : Math.round(p * 100)}%"></span>${r.floor != null && r.of ? `<i style="left:${Math.round((r.floor / r.of) * 100)}%" title="floor ${r.floor}${r.unit ?? ''}"></i>` : ''}</span></a></li>`;
    })
    .join('')}</ul>`;
}

export function phases(feed: Feed, compact = false): string {
  return `<ol class="phases">${feed.phases
    .map((p) => {
      const built = p.features.filter((f) => f.status === 'built').length;
      const s: Status = p.certified === true ? 'pass' : p.certified === false ? 'fail' : 'not measured';
      return `<li class="phase">${lamp(s, p.certified === true ? 'certified' : p.certified === false ? 'not certified' : 'no certificate in this build')}<span class="pname">Phase ${p.n}: ${esc(p.name)}</span><span class="pmeta">${built} of ${p.features.length} features built${p.certifiedAt ? ` · certificate at ${esc(p.certifiedAt.slice(0, 7))}` : ''}</span>${compact ? '' : `<ul class="features">${p.features.map((f) => `<li><span class="fstat ${f.status === 'built' ? 'ok' : 'warn'}">${esc(f.status)}</span> ${esc(f.name)}</li>`).join('')}</ul>`}</li>`;
    })
    .join('')}</ol>`;
}

export function gatesLine(feed: Feed): string {
  const v = feed.gates.filter((g) => g.proof === 'valid').length;
  return `<a class="gates-line" href="${EVIDENCE}/gates.html">${lamp(v === feed.gates.length ? 'pass' : 'fail', v === feed.gates.length ? 'every gate proven' : 'a gate is not proven')}<span><strong>${v} of ${feed.gates.length}</strong> gates proven able to fail</span></a>`;
}

export function factoryPanel(feed: Feed | null): string {
  if (!feed)
    return `<div class="empty-state"><p><strong>The factory has not published its feed yet.</strong></p><p class="muted">It arrives with the next build of the reference implementation, written by that build from its own evidence. Until then the evidence pages hold every reading.</p><p><a class="btn" href="${EVIDENCE}/index.html">Open the evidence</a></p></div>`;
  return `<p class="stamp-line">Build <a href="${GH}${esc(feed.commit)}"><code>${esc(feed.commit.slice(0, 7))}</code></a> · ${esc(when(feed.builtAt))}</p>${readings(feed)}${gatesLine(feed)}<h3 class="sub-h">Phases</h3>${phases(feed, true)}<p class="more-links"><a href="/factory">The factory console</a> · <a href="${EVIDENCE}/index.html">All evidence</a></p>`;
}

export function journeyDetail(row: IntentRow, id: string): { title: string; html: string } | null {
  const j = row.journeys.find((x) => x.id === id);
  if (!j) return null;
  const rows: [string, string][] = [
    ['Verdict', `${lamp(j.status)} ${esc(WORD[j.status])}`],
    ['As', esc(j.persona)],
    ['Phase', j.phase === null ? 'not set' : String(j.phase)],
    ['Modes', esc(j.modes.join(', ') || 'standard')],
    ['Channels', esc(j.channels.join(', ') || 'app')],
  ];
  if (j.feature) rows.push(['Proves the feature', esc(j.feature)]);
  const why =
    j.status === 'not measured'
      ? row.source === 'studio'
        ? '<p class="muted">Not built yet. Release the intent in the studio and hand its package to the factory; a person signs its journey cards into the factory, and the next build walks them.</p>'
        : '<p class="muted">This build did not walk this journey, so it is reported as not measured, never as passed.</p>'
      : j.status === 'fail'
        ? '<p class="bad-line">The person did not reach their goal, or something forbidden happened. The build that found it is in the evidence; the defect it found becomes a ratchet.</p>'
        : '<p class="ok-line">Walked as the person would, in every mode and channel it names, and reached the goal with nothing forbidden happening.</p>';
  return {
    title: j.id,
    html: `<p class="dr-text">${esc(j.goal)}</p><dl class="dr-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${why}${row.source === 'factory' ? `<p><a href="${EVIDENCE}/intent.html">Every journey in the evidence</a> · <a href="${EVIDENCE}/features.html">Features and the journeys that prove them</a></p>` : '<p><a href="/intent">Open it in the studio</a></p>'}`,
  };
}
