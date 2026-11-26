/**
 * The drawings. Every view is drawn from the one graph of the intent, so each box and line is a real relation in
 * the package. The intent map is a FAST diagram: why to the left, how to the right. A revision cloud, the red
 * scalloped outline a checker draws on a print, rings anything that still has an open question.
 */
import type { Ballooned } from '../frame.ts';
import { instruments, LANES, neighbours, uncovered, type Graph, type Lane, type Node } from '../graph.ts';
import type { Suggestion } from '../journeys.ts';
import { BUILD_ORDER, MAINTAINER_LABEL, MAINTAINER_WHAT, SOURCE_LABEL, SOURCE_WHAT, type Line, type Manifest, type Source } from '../manifest.ts';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------- shared marks

/** Small symbols for each kind, drawn at 16 by 16, so the map reads without a legend once it has been seen. */
export const ICON: Record<string, string> = {
  end: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2.5" fill="currentColor"/>',
  gauge: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 11 11 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  forbidden: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.8 12.2 12.2 3.8" stroke="currentColor" stroke-width="1.5"/>',
  ratchet: '<path d="M1.5 12.5h13M2 12.5l3-6v6M5 12.5l3-6v6M8 12.5l3-6v6M11 12.5l3-6v6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  scenario: '<rect x="2" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5 8 2 2 4-4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  control: '<path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 5v4M8 10.6v.8" stroke="currentColor" stroke-width="1.5"/>',
  statement: '',
  doc: '<path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 8h5M5.5 11h5" stroke="currentColor" stroke-width="1.2"/>',
  group: '<path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" stroke-width="1.5"/>',
};
export const icon = (k: string, cls = 'ico') => (ICON[k] ? `<svg class="${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ICON[k]}</svg>` : '');

/** A revision cloud around a box: scallops along each side, as a checker draws them in red pencil. */
function cloud(x: number, y: number, w: number, h: number): string {
  const r = 7;
  const pad = 6;
  const X = x - pad;
  const Y = y - pad;
  const W = w + pad * 2;
  const H = h + pad * 2;
  const side = (len: number) => Math.max(1, Math.round(len / (r * 2)));
  let d = `M${X} ${Y}`;
  const nx = side(W);
  for (let i = 0; i < nx; i++) d += ` a${W / nx / 2} ${r} 0 0 1 ${W / nx} 0`;
  const ny = side(H);
  for (let i = 0; i < ny; i++) d += ` a${r} ${H / ny / 2} 0 0 1 0 ${H / ny}`;
  for (let i = 0; i < nx; i++) d += ` a${W / nx / 2} ${r} 0 0 1 ${-W / nx} 0`;
  for (let i = 0; i < ny; i++) d += ` a${r} ${H / ny / 2} 0 0 1 0 ${-H / ny}`;
  return `<path class="cloud" d="${d}Z"/>`;
}

function wrap(text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept[max - 1] = `${kept[max - 1]!.replace(/\s+\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

// ---------------------------------------------------------------- the intent map

/** Boxes on the map: graph nodes, or a group standing for several. */
interface Box {
  readonly id: string;
  readonly lane: Lane;
  readonly section: string;
  readonly label: string;
  readonly sub: string;
  readonly kind: string;
  readonly members: readonly Node[];
  readonly node?: Node;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
  readonly lines: string[];
}

const SECTION: Record<string, string> = {
  end: 'To what end',
  whyit: 'Why it matters',
  problem: 'What goes wrong today',
  measures: 'Measures',
  feel: 'How it should feel',
  rules: 'Must and must never',
  also: 'Also needed, affected and left out',
  gauge: 'Journeys',
  forbidden: 'Forbidden outcomes',
  ratchet: 'Ratchets',
  scenario: 'Scenarios',
  control: 'Controls',
};

function sectionOf(n: Node): string {
  if (n.lane === 'instruments') return n.kind;
  if (n.lane === 'why') return n.kind === 'end' ? 'end' : n.statement?.slot === 'problem' ? 'problem' : 'whyit';
  if (n.lane !== 'checks') return '';
  const s = n.statement!;
  if (s.supplied.kind === 'lexicon') return 'feel';
  if (s.slot === 'measures') return 'measures';
  if (s.slot === 'constraints') return 'rules';
  return 'also';
}

const W = 206;
const GAP = 46;
const CHARS = 25;
/** Sections that fold by default, and how many boxes before they do: the rest show every statement. */
const COLLAPSE: Record<string, number> = { also: 3, control: 3, forbidden: 4 };
const FOLD_AT = 10;

export interface MapState {
  readonly expanded: ReadonlySet<string>;
  readonly focus: string | null;
  /** On a phone the lanes stack top to bottom, why first, and the lines run down a spine on the left. */
  readonly vertical?: boolean;
}

export function intentMap(g: Graph, st: MapState): string {
  const V = !!st.vertical;
  const BW = V ? 300 : W;
  const CH = V ? 40 : CHARS;
  const boxes: Box[] = [];
  const memberOf = new Map<string, string>();
  for (const lane of LANES) {
    const nodes = g.nodes.filter((n) => n.lane === lane.key);
    const sections = [...new Set(nodes.map(sectionOf))];
    for (const sec of sections) {
      const ns = nodes.filter((n) => sectionOf(n) === sec);
      const key = `group:${lane.key}:${sec}`;
      const collapse = sec && ns.length > (COLLAPSE[sec] ?? FOLD_AT) && !st.expanded.has(key);
      if (collapse) {
        const label = `${ns.length} ${(SECTION[sec] ?? sec).toLowerCase()}`;
        const open = ns.reduce((a, n) => a + n.open.length, 0);
        const lines = wrap(ns.slice(0, 2).map((n) => n.label).join('; '), CH, 2);
        boxes.push({ id: key, lane: lane.key, section: sec, label, sub: open ? `${open} open` : 'select to open the group', kind: 'group', members: ns, x: 0, y: 0, w: BW, h: 50 + lines.length * 16, lines });
        for (const n of ns) memberOf.set(n.id, key);
      } else
        for (const n of ns) {
          const lines = wrap(n.label, CH, 3);
          boxes.push({ id: n.id, lane: lane.key, section: sec, label: n.label, sub: n.sub, kind: n.kind, members: [n], node: n, x: 0, y: 0, w: BW, h: 38 + lines.length * 16, lines });
        }
    }
  }
  const at = (id: string) => memberOf.get(id) ?? id;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // Edges between boxes, merged when a group stands for several nodes.
  const seen = new Set<string>();
  const edges: { from: Box; to: Box; rel: string }[] = [];
  for (const e of g.edges) {
    const a = byId.get(at(e.from));
    const b = byId.get(at(e.to));
    if (!a || !b || a === b || a.lane === b.lane) continue;
    const k = `${a.id}>${b.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ from: a, to: b, rel: e.rel });
  }
  const laneIx = (l: Lane) => LANES.findIndex((x) => x.key === l);
  if (V) return verticalMap(boxes, edges, st, laneIx);
  // Order each lane by where its neighbours already sit, so lines cross as little as they can.
  const HEAD = 70;
  const colH: number[] = [];
  LANES.forEach((lane, li) => {
    const inLane = boxes.filter((b) => b.lane === lane.key);
    const sections = [...new Set(inLane.map((b) => b.section))];
    let y = HEAD;
    for (const sec of sections) {
      const bs = inLane.filter((b) => b.section === sec);
      if (li > 0) {
        const score = (b: Box) => {
          const ys = edges.filter((e) => (e.from === b && laneIx(e.to.lane) < li) || (e.to === b && laneIx(e.from.lane) < li)).map((e) => (e.from === b ? e.to : e.from)).map((o) => o.y + o.h / 2);
          return ys.length ? ys.reduce((a, c) => a + c, 0) / ys.length : 1e6;
        };
        bs.sort((a, b) => score(a) - score(b));
      }
      if (sec) y += 36;
      for (const b of bs) {
        b.x = li * (W + GAP) + 20;
        b.y = y;
        y += b.h + 14;
      }
      y += 10;
    }
    colH[li] = y;
  });
  // Centre each column on the tallest, so the flow reads as one piece.
  const tallest = Math.max(...colH, 300);
  // The chain from the end to the outcomes sits level with the middle of what holds it, so the eye runs straight across.
  const hold = boxes.filter((b) => b.lane === 'checks' || b.lane === 'instruments');
  const mid = hold.length ? Math.min(...hold.map((b) => b.y)) + Math.min(420, (Math.max(...hold.map((b) => b.y + b.h)) - Math.min(...hold.map((b) => b.y))) / 2) : HEAD;
  LANES.forEach((lane, li) => {
    if (lane.key === 'checks' || lane.key === 'instruments') return;
    const shift = Math.max(0, mid - (colH[li]! + HEAD) / 2);
    for (const b of boxes.filter((x) => x.lane === lane.key)) b.y += shift;
  });
  const width = LANES.length * (W + GAP) - GAP + 40;
  const height = tallest + 30;

  const near = st.focus ? new Set([st.focus, ...edges.filter((e) => e.from.id === st.focus || e.to.id === st.focus).flatMap((e) => [e.from.id, e.to.id])]) : null;
  const headers = LANES.map((l, i) => {
    const x = i * (W + GAP) + 20;
    return `<g class="lane-head"><text x="${x}" y="26" class="lane-label">${esc(l.label)}</text><text x="${x}" y="44" class="lane-q">${esc(l.question)}</text><line x1="${x}" x2="${x + W}" y1="54" y2="54"/></g>`;
  }).join('');
  const sectionLabels = LANES.flatMap((lane) => {
    const inLane = boxes.filter((b) => b.lane === lane.key);
    return [...new Set(inLane.map((b) => b.section))].filter(Boolean).map((sec) => {
      const top = Math.min(...inLane.filter((b) => b.section === sec).map((b) => b.y));
      const b0 = inLane[0]!;
      return `<text class="sec-label" x="${b0.x}" y="${top - 20}">${esc(SECTION[sec] ?? sec)}</text>`;
    });
  }).join('');
  // Between neighbouring lanes, lines run as brackets: out from the source to its own trunk, along it, and into each
  // target, as a FAST diagram draws them. Lines that skip a lane curve behind the boxes.
  const trunks = new Map<string, number>();
  const trunkFor = (src: Box, to: Lane) => {
    const k = `${src.id}>${to}`;
    if (!trunks.has(k)) trunks.set(k, [...trunks.keys()].filter((x) => x.endsWith(`>${to}`)).length);
    return trunks.get(k)!;
  };
  const lines = edges
    .map((e) => {
      const [l, r] = laneIx(e.from.lane) < laneIx(e.to.lane) ? [e.from, e.to] : [e.to, e.from];
      const x1 = l.x + l.w;
      const y1 = l.y + l.h / 2;
      const x2 = r.x;
      const y2 = r.y + r.h / 2;
      const on = near && near.has(e.from.id) && near.has(e.to.id) && (e.from.id === st.focus || e.to.id === st.focus);
      let d: string;
      if (laneIx(r.lane) - laneIx(l.lane) === 1) {
        const k = trunkFor(l, r.lane);
        const bx = Math.max(x1 + 10, x2 - 16 - (k % 5) * 6);
        const rr = Math.min(6, Math.abs(y2 - y1) / 2);
        const dir = y2 > y1 ? 1 : -1;
        d = Math.abs(y2 - y1) < 1 ? `M${x1} ${y1} H${x2}` : `M${x1} ${y1} H${bx - rr} Q${bx} ${y1} ${bx} ${y1 + dir * rr} V${y2 - dir * rr} Q${bx} ${y2} ${bx + rr} ${y2} H${x2}`;
      } else {
        const dx = Math.max(30, (x2 - x1) / 2);
        d = `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
      }
      return `<path class="edge${on ? ' on' : near ? ' dim' : ''}" data-a="${esc(e.from.id)}" data-b="${esc(e.to.id)}" d="${d}"><title>${esc(e.rel)}</title></path>`;
    })
    .join('');
  const cards = boxes.map((b) => card(b, st, near)).join('');
  const axis = `<g class="axis" aria-hidden="true"><text x="20" y="${height - 6}">Why</text><path d="M60 ${height - 10} h${width - 160}" marker-start="url(#arrow-l)" marker-end="url(#arrow-r)"/><text x="${width - 60}" y="${height - 6}">How</text></g>`;
  return `<svg class="map" viewBox="0 0 ${width} ${height + 14}" width="${width}" height="${height + 14}" role="group" aria-label="Intent map: why to the left, how to the right. Each box opens its detail.">
<defs><marker id="arrow-r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10Z" fill="currentColor"/></marker><marker id="arrow-l" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10 0 0 5 10 10Z" fill="currentColor"/></marker></defs>
${headers}<g class="edges">${lines}</g>${sectionLabels}${cards}${axis}</svg>`;
}

function card(b: Box, st: MapState, near: Set<string> | null): string {
  const s: Ballooned | undefined = b.node?.statement;
  const open = b.members.reduce((a, n) => a + n.open.length, 0);
  const cls = ['card', `k-${b.kind}`, s ? `s-${s.state}` : '', s?.mark ? `m-${s.mark}` : '', near && !near.has(b.id) ? 'dim' : '', st.focus === b.id ? 'focus' : ''].filter(Boolean).join(' ');
  const label = `${b.node?.balloon ? `Balloon ${b.node.balloon}: ` : ''}${b.label}. ${b.sub}.${open ? ` ${open} open question${open === 1 ? '' : 's'}.` : ''}`;
  const balloon = b.node?.balloon ? `<circle class="balloon-c" cx="${b.x}" cy="${b.y}" r="13"/><text class="balloon-t" x="${b.x}" y="${b.y + 4.5}" text-anchor="middle">${b.node.balloon}</text>` : '';
  const ic = ICON[b.kind] ? `<svg x="${b.x + b.w - 24}" y="${b.y + b.h - 23}" width="16" height="16" viewBox="0 0 16 16" class="kind-ico">${ICON[b.kind]}</svg>` : '';
  const text = b.lines.map((t, i) => `<tspan x="${b.x + 20}" y="${b.y + 26 + i * 16}">${esc(t)}</tspan>`).join('');
  return `<g class="${cls}" data-node="${esc(b.id)}" tabindex="0" role="button" aria-label="${esc(label)}">${open ? cloud(b.x, b.y, b.w, b.h) : ''}<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3"/>${ic}<text class="card-t">${text}</text><text class="card-sub" x="${b.x + 20}" y="${b.y + b.h - 11}">${esc(b.kind === 'group' ? b.sub : b.sub)}</text>${balloon}${open ? `<g class="flag"><path d="M${b.x + b.w - 6} ${b.y - 18} l12 0 l-6 -11Z"/><text x="${b.x + b.w}" y="${b.y - 21}" text-anchor="middle">${open}</text></g>` : ''}</g>`;
}

function verticalMap(boxes: Box[], edges: { from: Box; to: Box; rel: string }[], st: MapState, laneIx: (l: Lane) => number): string {
  const X = 34;
  let y = 16;
  const bands: string[] = [];
  for (const lane of LANES) {
    const inLane = boxes.filter((b) => b.lane === lane.key);
    if (!inLane.length) continue;
    bands.push(`<g class="lane-head"><text x="${X - 20}" y="${y + 16}" class="lane-label">${esc(lane.label)}</text><text x="${X - 20}" y="${y + 34}" class="lane-q">${esc(lane.question)}</text><line x1="${X - 20}" x2="${X + 306}" y1="${y + 44}" y2="${y + 44}"/></g>`);
    y += 62;
    let last = '';
    for (const b of inLane) {
      if (b.section && b.section !== last) {
        bands.push(`<text class="sec-label" x="${X}" y="${y + 6}">${esc(SECTION[b.section] ?? b.section)}</text>`);
        y += 22;
      }
      last = b.section;
      b.x = X;
      b.y = y + 6;
      y += b.h + 18;
    }
    y += 12;
  }
  const height = y + 10;
  // Lines run down a spine on the left: out of each box, along the spine, into the box it connects to.
  const lines = edges
    .map((e) => {
      const [a, b] = laneIx(e.from.lane) < laneIx(e.to.lane) ? [e.from, e.to] : [e.to, e.from];
      const gx = 10 + (laneIx(b.lane) % 3) * 6;
      const y1 = a.y + a.h / 2;
      const y2 = b.y + b.h / 2;
      return `<path class="edge" data-a="${esc(e.from.id)}" data-b="${esc(e.to.id)}" d="M${a.x} ${y1} H${gx + 5} Q${gx} ${y1} ${gx} ${y1 + 5} V${y2 - 5} Q${gx} ${y2} ${gx + 5} ${y2} H${b.x}"><title>${esc(e.rel)}</title></path>`;
    })
    .join('');
  return `<svg class="map vertical" viewBox="0 0 350 ${height}" width="350" height="${height}" role="group" aria-label="Intent map, top to bottom: why first, then how. Each box opens its detail.">${bands.join('')}<g class="edges">${lines}</g>${boxes.map((b) => card(b, st, null)).join('')}</svg>`;
}

// ---------------------------------------------------------------- the datum structure

export interface Counts {
  readonly sources: number;
  readonly readings: number;
  readonly families: readonly string[];
  readonly revisions: number;
  readonly files: number;
  readonly defaults: number;
  readonly notes: number;
  readonly variants: number;
  readonly questions: number;
  readonly suggested: number;
}

interface Entity {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  readonly attrs: readonly string[];
  /** Grid cell: column and row. */
  readonly c: number;
  readonly r: number;
  readonly what: string;
}

export function entities(g: Graph, c: Counts): Entity[] {
  const n = (k: Node['kind']) => g.nodes.filter((x) => x.kind === k).length;
  const statements = g.nodes.filter((x) => x.statement).length;
  return [
    { id: 'intent', name: 'Intent', count: 1, attrs: ['title', 'revision', 'status'], c: 0, r: 0, what: 'The whole drawing: one title, one revision at a time, released as one package.' },
    { id: 'end', name: 'End in mind', count: g.nodes.find((x) => x.id === 'end')?.label === 'Not stated yet' ? 0 : 1, attrs: ['text', 'source line'], c: 0, r: 1, what: 'What everything serves. It leads the package and every model call.' },
    { id: 'note', name: 'Engineering note', count: c.notes + c.variants, attrs: ['text', 'stance', 'variant letter'], c: 0, r: 2, what: 'How it is to be made for now, and lettered variants. Never what it must do.' },
    { id: 'revision', name: 'Revision', count: c.revisions, attrs: ['number', 'reason', 'package hash'], c: 0, r: 3, what: 'Each release, with why it was made. A change notice lists what changed, balloon by balloon.' },
    { id: 'source', name: 'Source', count: c.sources, attrs: ['path', 'form', 'sha-256'], c: 1, r: 0, what: 'The person’s own files, hashed. Every statement of theirs points to a line in one.' },
    { id: 'reading', name: 'Reading', count: c.readings, attrs: ['family', 'problem', 'outcomes'], c: 1, r: 1, what: `Independent readings by different model families${c.families.length ? `: ${c.families.join(', ')}` : ''}. Agreement becomes a statement; difference becomes a question.` },
    { id: 'default', name: 'Title block default', count: c.defaults, attrs: ['key', 'value', 'from'], c: 1, r: 2, what: 'Defaults every statement inherits unless it says otherwise: language, contrast, layout, feedback time.' },
    { id: 'file', name: 'Package file', count: c.files, attrs: ['path', 'sha-256'], c: 1, r: 3, what: 'Every file in the package, each hashed in the manifest. The same input always gives the same bytes.' },
    { id: 'statement', name: 'Statement', count: statements, attrs: ['balloon', 'slot', 'state', 'supplier', 'tolerance', 'mark'], c: 2, r: 0, what: 'One thing that will be built, numbered by balloon. The balloon stays with it through every revision.' },
    { id: 'question', name: 'Question', count: c.questions, attrs: ['origin', 'protects', 'consequence'], c: 2, r: 1, what: 'An open redline. Each one changes what gets built; release waits until none is left.' },
    { id: 'gauge', name: 'Journey gauge', count: n('gauge'), attrs: ['persona', 'goal', 'budget', 'forbidden'], c: 3, r: 0, what: `A journey walked as a person would. ${c.suggested} more are suggested in the inspection plan.` },
    { id: 'ratchet', name: 'Ratchet', count: n('ratchet'), attrs: ['working range', 'direction', 'floor', 'confidence'], c: 3, r: 1, what: 'The tolerance a person confirmed, as the floor the factory starts from. It only tightens.' },
    { id: 'scenario', name: 'Scenario test', count: n('scenario'), attrs: ['given', 'when', 'then'], c: 3, r: 2, what: 'A confirmed example, pending until the factory builds and proves it.' },
    { id: 'control', name: 'Control', count: n('control'), attrs: ['mark', 'controls', 'traced'], c: 3, r: 3, what: 'Every critical or significant statement and the controls it needs before it ships.' },
    { id: 'forbidden', name: 'Forbidden outcome', count: n('forbidden'), attrs: ['text'], c: 4, r: 0, what: 'Checked on every journey. If it happens, the journey fails.' },
  ];
}

/** Relations, with how each is routed: beside, below, or along the gutter to the right or left of the first. */
const RELS: readonly [string, string, 'one' | 'many', 'one' | 'many', string, 'h' | 'v' | 'busR' | 'busL'][] = [
  ['intent', 'source', 'one', 'many', 'drawn from', 'h'],
  ['intent', 'end', 'one', 'one', 'serves', 'v'],
  ['intent', 'note', 'one', 'many', 'notes', 'busL'],
  ['intent', 'revision', 'one', 'many', 'released as', 'busL'],
  ['revision', 'file', 'one', 'many', 'contains', 'h'],
  ['source', 'reading', 'one', 'many', 'read by', 'v'],
  ['source', 'statement', 'one', 'many', 'states', 'h'],
  ['reading', 'statement', 'many', 'many', 'agrees on', 'busR'],
  ['default', 'statement', 'many', 'many', 'inherited by', 'busR'],
  ['statement', 'question', 'one', 'many', 'raises', 'v'],
  ['statement', 'gauge', 'one', 'many', 'walked by', 'h'],
  ['statement', 'ratchet', 'one', 'one', 'floored by', 'busR'],
  ['statement', 'scenario', 'one', 'one', 'proved by', 'busR'],
  ['statement', 'control', 'one', 'one', 'controlled by', 'busR'],
  ['gauge', 'forbidden', 'many', 'many', 'checks', 'h'],
];

export function datumStructure(es: Entity[], focus: string | null): string {
  const EW = 196;
  const STEP = 284;
  const PAD = 104;
  const hOf = (e: Entity) => 40 + e.attrs.length * 19;
  const rows = [0, 1, 2, 3].map((r) => Math.max(0, ...es.filter((e) => e.r === r).map(hOf)));
  const top = (r: number) => 30 + rows.slice(0, r).reduce((a, h) => a + h + 56, 0);
  const pos = new Map(es.map((e) => [e.id, { x: PAD + e.c * STEP, y: top(e.r), h: hOf(e) }]));
  const width = PAD + 4 * STEP + EW + 20;
  const height = top(3) + rows[3]! + 30;
  const near = focus ? new Set([focus, ...RELS.filter((r) => r[0] === focus || r[1] === focus).flatMap((r) => [r[0], r[1]])]) : null;
  const HY = 15;
  const rels = RELS.map(([a, b, ca, cb, label, how]) => {
    const A = pos.get(a)!;
    const B = pos.get(b)!;
    let d: string;
    let lx: number;
    let ly: number;
    let anchor = 'start';
    if (how === 'h') {
      d = `M${A.x + EW} ${A.y + HY} H${B.x}`;
      lx = A.x + EW + 8;
      ly = A.y + HY - 6;
    } else if (how === 'v') {
      d = `M${A.x + 40} ${A.y + A.h} V${B.y}`;
      lx = A.x + 48;
      ly = (A.y + A.h + B.y) / 2 + 4;
    } else if (how === 'busR') {
      // The gutter on the right of whichever box is further left.
      const [L, R, toRight] = A.x < B.x ? [A, B, true] : [B, A, false];
      const gx = L.x + EW + (STEP - EW) / 2 + (toRight ? 6 : -6);
      const y1 = L.y + HY + (toRight ? 0 : 8);
      const y2 = R.y + HY + (toRight ? 0 : 8);
      d = `M${L.x + EW} ${y1} H${gx} V${y2} H${R.x}`;
      // The label sits at the end no other line shares, so labels on a busy box never pile up.
      const shared = RELS.filter((x) => x[5] === 'busR' && (x[0] === (toRight ? a : b) || x[1] === (toRight ? a : b))).length > 1;
      [lx, ly, anchor] = shared ? [R.x - 6, y2 - 6, 'end'] : [L.x + EW + 6, y1 - 6, 'start'];
    } else {
      const gx = A.x - 84;
      d = `M${A.x} ${A.y + HY} H${gx} V${B.y + HY} H${B.x}`;
      lx = gx + 6;
      ly = B.y + HY - 6;
    }
    const on = near ? near.has(a) && near.has(b) && (a === focus || b === focus) : false;
    return `<path class="rel${on ? ' on' : near ? ' dim' : ''}" data-a="${a}" data-b="${b}" d="${d}" marker-start="url(#er-${ca})" marker-end="url(#er-${cb})"/><text class="rel-t${on ? ' on' : near ? ' dim' : ''}" data-a="${a}" data-b="${b}" x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(label)}</text>`;
  }).join('');
  const boxes = es
    .map((e) => {
      const { x, y, h } = pos.get(e.id)!;
      const cls = ['ent', near && !near.has(e.id) ? 'dim' : '', focus === e.id ? 'focus' : '', e.count === 0 ? 'empty' : ''].filter(Boolean).join(' ');
      return `<g class="${cls}" data-entity="${e.id}" tabindex="0" role="button" aria-label="${esc(`${e.name}: ${e.count}. ${e.what}`)}"><rect x="${x}" y="${y}" width="${EW}" height="${h}" rx="3"/><rect class="ent-head" x="${x}" y="${y}" width="${EW}" height="30" rx="3"/><text class="ent-name" x="${x + 12}" y="${y + 20}">${esc(e.name)}</text><text class="ent-count" x="${x + EW - 12}" y="${y + 20}" text-anchor="end">${e.count}</text>${e.attrs.map((t, i) => `<text class="ent-attr" x="${x + 12}" y="${y + 48 + i * 19}">${esc(t)}</text>`).join('')}</g>`;
    })
    .join('');
  // Crow's feet: toes at the box for many, a double bar for exactly one. Drawn pointing into the box at either end.
  const one = '<path d="M9 2v12M13 2v12" stroke="currentColor" fill="none" stroke-width="1.4"/>';
  const many = '<path d="M2 8 16 2M2 8H16M2 8 16 14M6 3v10" stroke="currentColor" fill="none" stroke-width="1.4"/>';
  const mk = (id: string, path: string) => `<marker id="${id}" viewBox="0 0 16 16" refX="16" refY="8" markerWidth="16" markerHeight="16" orient="auto-start-reverse" markerUnits="userSpaceOnUse">${path}</marker>`;
  return `<svg class="erd" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Datum structure: the parts of this intent, how many of each, and how they relate. Each part opens its list.">
<defs>${mk('er-one', one)}${mk('er-many', many)}</defs>
<g class="rels">${rels}</g>${boxes}</svg>`;
}

// ---------------------------------------------------------------- the inspection plan

export function inspectionPlan(g: Graph, suggestions: readonly Suggestion[], accepted: ReadonlySet<string>, filter: string, people: readonly string[]): string {
  const ins = instruments(g);
  const max = Math.max(1, ...ins.map((i) => i.count));
  const bars = ins
    .map(
      (i) => `<li class="ins"><button type="button" class="ins-row" data-kind="${i.kind}">${icon(i.kind)}<span class="ins-name">${esc(i.label)}</span><span class="ins-bar" aria-hidden="true"><span style="width:${Math.round((i.count / max) * 100)}%"></span></span><span class="ins-n">${i.count}</span></button><p class="ins-what">${esc(i.what)} <button type="button" class="chip file" data-file="${esc(i.file.split(',')[0]!.replace('*', ''))}">${esc(i.file)}</button></p></li>`,
    )
    .join('');
  const rows = g.nodes.filter((n) => n.statement && (n.statement.slot === 'outcome' || n.statement.slot === 'measures' || n.statement.mark || /^never/i.test(n.statement.text)));
  const KINDS = ['gauge', 'forbidden', 'ratchet', 'scenario', 'control'] as const;
  const cover = (n: Node, k: (typeof KINDS)[number]) => neighbours(g, n.id).filter((x) => x.node.kind === k && x.dir === 'from');
  const needs = (n: Node, k: (typeof KINDS)[number]) => {
    const s = n.statement!;
    if (k === 'gauge') return s.slot === 'outcome';
    if (k === 'forbidden') return /^never/i.test(s.text);
    if (k === 'ratchet') return s.slot === 'measures' && s.tolerance !== 'exactly as stated';
    if (k === 'scenario') return s.slot === 'measures' && s.tolerance === 'exactly as stated';
    return !!s.mark;
  };
  const matrix = `<div class="matrix-wrap"><table class="matrix"><caption>What checks each statement. A red square is a statement that needs that check and has none yet.</caption><thead><tr><th scope="col">Statement</th>${KINDS.map((k) => `<th scope="col"><span class="th-ico">${icon(k)}</span>${esc(k === 'gauge' ? 'Journeys' : k === 'forbidden' ? 'Forbidden' : k === 'ratchet' ? 'Ratchet' : k === 'scenario' ? 'Scenario' : 'Control')}</th>`).join('')}</tr></thead><tbody>${rows
    .map((n) => {
      const cells = KINDS.map((k) => {
        const c = cover(n, k);
        if (c.length) return `<td><button type="button" class="cell yes" data-node="${esc(c[0]!.node.id)}" aria-label="${esc(`${c.length} ${k}${c.length === 1 ? '' : 's'} for balloon ${n.balloon}`)}">${c.length}</button></td>`;
        if (needs(n, k)) return `<td><span class="cell gap" role="img" aria-label="needed, not there yet"></span></td>`;
        return '<td><span class="cell na" aria-hidden="true"></span></td>';
      }).join('');
      return `<tr><th scope="row"><button type="button" class="link-row" data-node="${esc(n.id)}"><span class="mini-balloon">${n.balloon}</span>${esc(n.label)}</button></th>${cells}</tr>`;
    })
    .join('')}</tbody></table></div>`;
  const gaps = uncovered(g);
  const kinds = [...new Set(suggestions.map((s) => s.kind))];
  const shown = suggestions.filter((s) => filter === 'all' || s.kind === filter || (filter === 'first' && s.priority === 'first'));
  const firstLeft = suggestions.filter((s) => s.priority === 'first' && !accepted.has(s.id)).length;
  const sug = `<section class="suggest" aria-labelledby="h-suggest"><div class="suggest-head"><h3 id="h-suggest">Journeys to add <span class="count-pill">${accepted.size} of ${suggestions.length} added</span></h3>${firstLeft ? `<button type="button" class="btn primary" data-add-first>Add the ${firstLeft} to walk first</button>` : ''}</div>
<p class="lede">One journey per outcome is the least a release carries. Software is tested well by many: every kind of person, every way in, and every attempt at what must never happen. Each suggestion is worked out by rule from your drawing and names the balloons it comes from.</p>
<div class="filters" role="group" aria-label="Show">${['all', 'first', ...kinds].map((k) => `<button type="button" class="chip${filter === k ? ' on' : ''}" aria-pressed="${filter === k}" data-filter="${esc(k)}">${esc(k === 'all' ? `All ${suggestions.length}` : k === 'first' ? 'Walk first' : k)}</button>`).join('')}</div>
<ul class="sug-list">${shown
    .map((s) => {
      const on = accepted.has(s.id);
      return `<li class="sug${on ? ' added' : ''}${s.priority === 'first' ? ' first' : ''}"><div class="sug-main">${icon('gauge')}<div><p class="sug-goal">${esc(s.card.goal)}</p><p class="sug-meta"><span class="kind-tag">${esc(s.kind)}</span> as <strong>${esc(s.card.persona)}</strong> · ${s.card.modes.join(', ')} · by ${s.card.channels.join(' and ')} · up to ${s.card.budget.actions} steps${s.balloons.length ? ` · from ${s.balloons.map((b) => `<button type="button" class="mini-balloon" data-node="b${b}" aria-label="Balloon ${b}">${b}</button>`).join(' ')}` : ''}</p><p class="sug-why">${esc(s.why)}</p></div></div><button type="button" class="btn${on ? '' : ' primary'} sug-btn" data-journey="${esc(s.id)}" aria-pressed="${on}">${on ? 'Added ✓' : 'Add'}</button></li>`;
    })
    .join('')}</ul>
<form class="own" id="own-journey" autocomplete="off"><h4>Write a journey of your own</h4><label for="own-goal">What should someone be able to do?</label><input id="own-goal" type="text" placeholder="For example: see what is owed this week in one look" minlength="10" required><label for="own-who">As whom?</label><select id="own-who">${people.map((p) => `<option>${esc(p)}</option>`).join('')}<option>someone else</option></select><button class="btn primary" type="submit">Add this journey</button></form></section>`;
  return `<div class="plan"><section aria-labelledby="h-ins"><h3 id="h-ins">What will check it</h3><ul class="ins-list">${bars}</ul></section>
<section aria-labelledby="h-cov"><h3 id="h-cov">Coverage</h3>${matrix}${gaps.length ? `<div class="gaps"><h4>Not covered yet (${gaps.length})</h4><ul>${gaps.map((x) => `<li><button type="button" class="link-row" data-node="${esc(x.node.id)}">${x.node.balloon ? `<span class="mini-balloon">${x.node.balloon}</span>` : ''}${esc(x.node.label)}</button>: ${esc(x.why)}</li>`).join('')}</ul></div>` : '<p class="ok-line">Every outcome is walked, every measure is held, every mark is controlled.</p>'}</section>
${sug}</div>`;
}

// ---------------------------------------------------------------- the release preview

const KIND_OF_FILE = (f: string) =>
  f.startsWith('gauges/') ? ['gauge', 'journey card'] : f.startsWith('tests/') ? ['scenario', 'test'] : f === 'ratchets.json' || f === 'tolerances.json' ? ['ratchet', 'ranges'] : f === 'control-plan.yaml' ? ['control', 'controls'] : f.startsWith('knowledge/') ? ['group', 'knowledge'] : ['doc', 'drawing'];

export function releasePreview(files: Readonly<Record<string, string>>, prior: Readonly<Record<string, string>> | null, open: string, priorRev: number | null): string {
  const paths = Object.keys(files).sort((a, b) => (a.includes('/') === b.includes('/') ? a.localeCompare(b) : a.includes('/') ? 1 : -1));
  const changed = (f: string) => (prior ? (prior[f] === undefined ? 'new' : prior[f] !== files[f] ? 'changed' : '') : '');
  const folders = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    folders.set(dir, [...(folders.get(dir) ?? []), p]);
  }
  const size = (s: string) => (s.length > 1024 ? `${(s.length / 1024).toFixed(1)} KB` : `${s.length} B`);
  const total = paths.reduce((a, p) => a + files[p]!.length, 0);
  const tree = [...folders.entries()]
    .map(([dir, fs]) => {
      const items = fs
        .map((f) => {
          const [k, what] = KIND_OF_FILE(f);
          const c = changed(f);
          return `<li><button type="button" class="file-row${f === open ? ' on' : ''}" data-file="${esc(f)}"${f === open ? ' aria-current="true"' : ''}>${icon(k!)}<span class="fname">${esc(f.slice(dir ? dir.length + 1 : 0))}</span>${c ? `<span class="chg ${c}">${c}</span>` : ''}<span class="fsize">${size(files[f]!)}</span><span class="sr"> (${what})</span></button></li>`;
        })
        .join('');
      return dir ? `<li class="dir"><details open><summary>${esc(dir)}/ <span class="dcount">${fs.length}</span></summary><ul>${items}</ul></details></li>` : items;
    })
    .join('');
  const body = files[open] ?? '';
  const lines = body.replace(/\n$/, '').split('\n');
  const code = lines.map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n');
  const n = (pre: string) => paths.filter((p) => p.startsWith(pre)).length;
  return `<div class="preview"><div class="pv-summary"><span><strong>${paths.length}</strong> files</span><span><strong>${size(' '.repeat(total))}</strong></span><span><strong>${n('gauges/')}</strong> journey cards</span><span><strong>${n('tests/')}</strong> test files</span><span><strong>${n('knowledge/')}</strong> knowledge pages</span>${prior && priorRev !== null ? `<span>Compared with revision ${priorRev}: <strong>${paths.filter((p) => changed(p)).length}</strong> new or changed</span>` : ''}</div>
<div class="pv-body"><nav class="pv-tree" aria-label="Package files"><ul>${tree}</ul></nav><section class="pv-file" aria-label="${esc(open)}"><div class="pv-file-head"><span class="pv-path">${esc(open)}</span><span class="fsize">${size(body)} · ${lines.length} lines</span></div><pre tabindex="0"><code>${code}</code></pre></section></div></div>`;
}

// ---------------------------------------------------------------- the drawer

export function detail(g: Graph, id: string, files: Readonly<Record<string, string>>): { title: string; html: string } | null {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) return null;
  const s = n.statement;
  const rel = neighbours(g, id);
  const rows: [string, string][] = [];
  if (s) {
    rows.push(['What it is', esc(n.sub)]);
    rows.push(['State', `<span class="state ${s.state}">${s.state === 'confirmed' ? 'yours, confirmed' : s.state === 'assumed' ? 'read from your words: confirm or correct' : s.state === 'default' ? 'a default' : 'open'}</span>`]);
    rows.push(['Came from', esc(s.supplied.kind === 'person' ? (s.supplied.origin ? `your words, line ${s.supplied.origin.line}` : 'your answer') : s.supplied.kind === 'parse' ? `both readings: ${s.supplied.families.join(' and ')}` : s.supplied.kind === 'lexicon' ? `your word "${s.supplied.term}"` : s.supplied.kind === 'derived' ? `the rule "${s.supplied.rule}"` : `the ${s.supplied.part} part`)]);
    if (s.words && s.words !== s.text) rows.push(['Your words', `“${esc(s.words)}”`]);
    if (s.tolerance) rows.push(['Held to', esc(s.tolerance)]);
    if (n.range) rows.push(['Working range', esc(n.range.kind === 'time' ? `at most ${n.range.maxMs} ms` : n.range.kind === 'rate' ? `at least ${Math.round(n.range.min * 1000) / 10}% of runs` : n.range.kind === 'count' ? `at most ${n.range.max}` : n.range.kind === 'relative' ? `${n.range.direction === 'down' ? 'lower' : 'higher'} than ${n.range.against}` : n.range.kind === 'exact' ? 'exactly as stated' : n.range.why)]);
    if (s.mark) rows.push(['Mark', `<span class="mark ${s.mark}">${s.mark}</span> must reach a control before it ships`]);
  } else {
    rows.push(['What it is', esc(n.sub)]);
    if (n.gauge) {
      rows.push(['As', esc(n.gauge.persona)]);
      rows.push(['Budget', `${n.gauge.budget.actions} steps, ${n.gauge.budget.ms} ms`]);
      rows.push(['Mode and channel', `${esc(n.gauge.modes.join(', '))}; ${esc(n.gauge.channels.join(', '))}`]);
      rows.push(['Must never', `<ul>${n.gauge.forbidden.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`]);
      if (n.suggestion) rows.push(['Why it was added', esc(n.suggestion.why)]);
    }
  }
  const groups = new Map<string, typeof rel>();
  for (const r of rel) {
    const k = r.dir === 'to' ? r.rel : inverse(r.rel);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const relHtml = rel.length
    ? `<h4>Connected to (${rel.length})</h4>${[...groups.entries()]
        .map(([k, rs]) => `<p class="rel-name">${esc(k[0]!.toUpperCase() + k.slice(1))} (${rs.length})</p><ul class="rel-list">${rs.map((r) => `<li><button type="button" class="link-row" data-node="${esc(r.node.id)}">${r.node.balloon ? `<span class="mini-balloon">${r.node.balloon}</span>` : icon(r.node.kind)}${esc(r.node.label)}</button></li>`).join('')}</ul>`)
        .join('')}`
    : '';
  const openHtml = n.open.length ? `<h4 class="red">Open (${n.open.length})</h4><ul class="open-list">${n.open.map((q) => `<li>${esc(q.text)} <button type="button" class="btn quiet" data-answer="${esc(q.id)}">Answer it</button></li>`).join('')}</ul>` : '';
  const file = n.file && files[n.file] !== undefined ? `<h4>In the package</h4><button type="button" class="chip file" data-file="${esc(n.file)}">${esc(n.file)}</button><pre class="snip">${esc(files[n.file]!.split('\n').slice(0, 14).join('\n'))}</pre>` : '';
  const title = `${n.balloon ? `Balloon ${n.balloon}` : n.kind === 'end' ? 'The end in mind' : n.sub}`;
  return {
    title,
    html: `<p class="dr-text">${esc(n.label)}</p><dl class="dr-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${openHtml}${relHtml}${file}${s ? `<button type="button" class="btn" data-not-quite="${n.balloon}">Not quite? Correct it in your words</button>` : ''}`,
  };
}

const INVERSE: Record<string, string> = {
  serves: 'served by',
  solves: 'solved by',
  for: 'for whom',
  measures: 'measured by',
  limits: 'limited by',
  checks: 'checked by',
  forbids: 'forbidden by',
  floors: 'floored by',
  proves: 'proved by',
  controls: 'controlled by',
  'follows from': 'leads to',
};
const inverse = (r: string) => INVERSE[r] ?? r;

// ---------------------------------------------------------------- the build manifest


const SRC_CLASS: Record<Source, string> = { stock: 'stock', modify: 'modify', 'make: catalogued': 'make-cat', 'make: new': 'make-new' };
export const sourceBadge = (s: Source) => `<span class="srcb ${SRC_CLASS[s]}"><span class="sw" aria-hidden="true"></span>${esc(SOURCE_LABEL[s])}</span>`;

/**
 * How the factory will build: foundations as bands, laid top to bottom in the order the factory lays them, and this
 * intent's features in a column on the right, each joined to the parts it is assembled from.
 */
function routing(m: Manifest): string {
  const groups = BUILD_ORDER.filter((g) => g !== 'This intent' && m.lines.some((l) => l.group === g));
  const LABEL = 150;
  const CW = 196;
  const PER = 4;
  const GAP = 8;
  const leftW = LABEL + PER * (CW + GAP);
  const FX = leftW + 110;
  const FW = 250;
  const pos = new Map<number, { x: number; y: number; w: number; h: number }>();
  let y = 40;
  const bands = groups
    .map((g, gi) => {
      const ls = m.lines.filter((l) => l.group === g);
      const y0 = y;
      let rowH = 0;
      const chips = ls
        .map((l, i) => {
          const col = i % PER;
          if (col === 0 && i > 0) {
            y += rowH + GAP;
            rowH = 0;
          }
          const lines = wrap(l.part, 25, 2);
          const h = 14 + lines.length * 15;
          rowH = Math.max(rowH, h);
          const x = LABEL + col * (CW + GAP);
          pos.set(l.find, { x, y, w: CW, h });
          return `<g class="chip-g ${SRC_CLASS[l.source]}${l.floor ? ' floor' : ''}" data-node="line:${l.find}" tabindex="0" role="button" aria-label="${esc(`${l.find}. ${l.part}. ${SOURCE_LABEL[l.source]}.`)}"><rect x="${x}" y="${y}" width="${CW}" height="${h}" rx="3"/><text class="chip-n" x="${x + 8}" y="${y + 17}">${l.find}</text>${lines.map((t, k) => `<text class="chip-t" x="${x + 30}" y="${y + 17 + k * 15}">${esc(t)}</text>`).join('')}</g>`;
        })
        .join('');
      y += rowH + 22;
      return `<g class="band"><rect class="band-bg${gi % 2 ? ' alt' : ''}" x="0" y="${y0 - 10}" width="${leftW}" height="${y - y0}"/><text class="band-n" x="10" y="${y0 + 12}">${gi + 1}</text>${wrap(g, 15, 2).map((t, k) => `<text class="lane-label small-l" x="30" y="${y0 + 12 + k * 17}">${esc(t)}</text>`).join('')}<text class="lane-q" x="30" y="${y0 + 14 + wrap(g, 15, 2).length * 17}">${ls.length} part${ls.length === 1 ? '' : 's'}</text>${chips}</g>`;
    })
    .join('');
  const feats = m.lines.filter((l) => l.source === 'make: new');
  let fy = 40;
  const fcards = feats
    .map((l) => {
      const lines = wrap(l.part.replace(/^Custom assembly: /, ''), 31, 3);
      const h = 34 + lines.length * 16;
      pos.set(l.find, { x: FX, y: fy, w: FW, h });
      const out = `<g class="chip-g make-new" data-node="line:${l.find}" tabindex="0" role="button" aria-label="${esc(`${l.find}. ${l.part}. Made new, assembled from ${l.uses.length} parts.`)}"><rect x="${FX}" y="${fy}" width="${FW}" height="${h}" rx="3"/><text class="chip-n" x="${FX + 8}" y="${fy + 18}">${l.find}</text>${lines.map((t, k) => `<text class="chip-t strong" x="${FX + 32}" y="${fy + 18 + k * 16}">${esc(t)}</text>`).join('')}<text class="chip-sub" x="${FX + 32}" y="${fy + h - 10}">${l.uses.length ? `assembled from ${l.uses.length} part${l.uses.length === 1 ? '' : 's'}` : 'new code only'}</text></g>`;
      fy += h + 12;
      return out;
    })
    .join('');
  const height = Math.max(y, fy) + 10;
  const width = FX + FW + 10;
  const edges = feats
    .flatMap((f) =>
      f.uses.map((u) => {
        const a = pos.get(u)!;
        const b = pos.get(f.find)!;
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + Math.min(b.h / 2, 26);
        const dx = Math.max(60, (x2 - x1) / 2);
        return `<path class="edge" data-a="line:${f.find}" data-b="line:${u}" d="M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}"><title>assembled into ${esc(f.part)}</title></path>`;
      }),
    )
    .join('');
  const head = `<text class="lane-label" x="10" y="22">Standard assemblies and parts: the fleet maintains</text><text class="lane-label" x="${FX}" y="22">Custom assemblies: your team maintains</text>`;
  return `<svg class="map route" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="How the factory will build: foundations top to bottom in the order they are laid, this intent's features on the right. Each part opens its detail.">${head}${bands}<g class="edges">${edges}</g>${fcards}</svg>`;
}

export function buildView(m: Manifest, filter: Source | 'all', drawingTitle: string, controls = ''): string {
  const n = m.lines.length;
  const seg = (s: Source) => (m.counts[s] ? `<span class="seg ${SRC_CLASS[s]}" style="width:${(m.counts[s] / n) * 100}%" title="${m.counts[s]} ${esc(SOURCE_LABEL[s])}"></span>` : '');
  const order: Source[] = ['stock', 'modify', 'make: catalogued', 'make: new'];
  const made = m.counts['make: catalogued'] + m.counts['make: new'];
  const summary = `<div class="bom-sum"><p class="bom-big">The factory starts from <strong>${n}</strong> lines</p><div class="mbar big" role="img" aria-label="${order.map((s) => `${m.counts[s]} ${SOURCE_LABEL[s]}`).join(', ')}">${order.map(seg).join('')}</div>
<ul class="src-legend">${order.map((s) => `<li><button type="button" class="srcf${filter === s ? ' on' : ''}" data-src="${esc(s)}" aria-pressed="${filter === s}">${sourceBadge(s)}<strong>${m.counts[s]}</strong></button><span class="muted">${esc(SOURCE_WHAT[s])}</span></li>`).join('')}</ul>
<p class="gapfill"><strong>Filled in, because the library does not have them now: ${made}.</strong> ${m.counts['make: catalogued']} catalogued part${m.counts['make: catalogued'] === 1 ? '' : 's'} the factory makes once and adds to the library, and ${m.counts['make: new']} custom assembl${m.counts['make: new'] === 1 ? 'y' : 'ies'} made new for ${esc(drawingTitle)}.</p>
<div class="maint"><p class="maint-h"><strong>Who maintains it after it ships</strong></p><div class="mbar big" role="img" aria-label="${m.maintained.fleet} maintained by the fleet, ${m.maintained.local} by your team"><span class="seg fleet" style="width:${(m.maintained.fleet / n) * 100}%"></span><span class="seg local" style="width:${(m.maintained.local / n) * 100}%"></span></div><ul class="maint-legend"><li><span class="sw fleet" aria-hidden="true"></span><strong>${m.maintained.fleet}</strong> by the fleet: standard assemblies and parts. A fix made once is pushed to every app that uses them. ${m.baseline.count} of these are the <button type="button" class="linklike" data-baseline>${esc(m.baseline.name)}</button>, inherited by every app this team builds.</li><li><span class="sw local" aria-hidden="true"></span><strong>${m.maintained.local}</strong> by your team: the custom assemblies that exist only in this app, held by its journeys.</li></ul></div>
${m.gaps.length ? `<div class="gaps"><h4>On the drawing, but nothing on the manifest builds it (${m.gaps.length})</h4><ul>${m.gaps.map((g) => `<li><button type="button" class="link-row" data-node="b${g.balloon}"><span class="mini-balloon">${g.balloon}</span>${esc(g.text)}</button>: ${esc(g.why)}</li>`).join('')}</ul></div>` : '<p class="ok-line">Every balloon on the drawing is built by a line on this manifest, or is left out or taken as given on purpose.</p>'}</div>`;
  const shown = m.lines.filter((l) => filter === 'all' || l.source === filter);
  const bom = `<div class="matrix-wrap"><table class="matrix bom"><caption>The bill of materials, in build order. ${filter === 'all' ? '' : `Showing ${esc(SOURCE_LABEL[filter])} only. <button type="button" class="btn quiet" data-src="all">Show all</button>`}</caption><thead><tr><th scope="col">Find</th><th scope="col">Part</th><th scope="col">Source</th><th scope="col">Maintained by</th><th scope="col">Standard assembly</th><th scope="col">Called for by</th><th scope="col">Journeys</th></tr></thead><tbody>${shown
    .map((l) => `<tr class="${SRC_CLASS[l.source]}"><td class="find">${l.find}</td><th scope="row"><button type="button" class="link-row" data-node="line:${l.find}">${esc(l.part.replace(/^Custom assembly: /, ''))}</button><span class="bom-gives">${l.source === 'make: new' ? `Assembled from ${l.uses.length ? l.uses.map((u) => `<button type="button" class="findref" data-node="line:${u}">${u}</button>`).join(' ') : 'new code only'}` : esc(l.gives)}</span></th><td>${sourceBadge(l.source)}</td><td><span class="mt ${l.maintainedBy}">${esc(MAINTAINER_LABEL[l.maintainedBy])}</span>${l.floor ? '<span class="muted small"> inherited</span>' : ''}</td><td>${l.library.length ? l.library.map((b) => `<span class="lib">${esc(b.name)}</span><span class="muted small"> ${b.tests} tests${b.mutationFloor !== null ? `, floor ${b.mutationFloor}%` : ''}</span>`).join('<br>') : '<span class="muted">none yet</span>'}</td><td>${l.balloons.length ? l.balloons.map((b) => `<button type="button" class="mini-balloon" data-node="b${b}" aria-label="Balloon ${b}">${b}</button>`).join(' ') : '<span class="muted small">team minimum</span>'}</td><td class="num">${l.journeys.length}</td></tr>`)
    .join('')}</tbody></table></div>`;
  const trace = `<div class="matrix-wrap"><table class="matrix trace"><caption>The drawing against the manifest: each balloon and the lines that build it.</caption><thead><tr><th scope="col">Balloon</th><th scope="col">Statement</th><th scope="col">Built by</th></tr></thead><tbody>${m.trace
    .map((t) => {
      const gap = !t.by.length && !t.note;
      return `<tr${gap ? ' class="gaprow"' : ''}><td><button type="button" class="mini-balloon" data-node="b${t.balloon}">${t.balloon}</button></td><td>${esc(t.text)}</td><td>${t.by.length ? t.by.map((f) => `<button type="button" class="findref" data-node="line:${f}" title="${esc(m.lines[f - 1]!.part)}">${f}</button>`).join(' ') : t.note ? `<span class="muted small">${esc(t.note)}</span>` : '<strong class="red">nothing builds it</strong>'}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;
  return `<div class="view-bar"><p class="view-lede">What the factory will start from, and why. Read it before you release: every line is a standard assembly from the library, a catalogued part the factory makes, or a custom assembly new for this intent; every one is traced to the balloons that call for it, and says who maintains it after it ships.</p>${controls}</div>${summary}
<section aria-labelledby="h-route"><h3 id="h-route">How the factory will build</h3><p class="muted small">Foundations are laid top to bottom, in the order the factory lays them; this intent's features are on the right, each assembled from the parts it is joined to. Hover or select a feature to trace its parts.</p><div class="canvas" id="canvas" tabindex="-1">${routing(m)}</div></section>
<section aria-labelledby="h-bom"><h3 id="h-bom">Bill of materials</h3>${bom}</section>
<section aria-labelledby="h-trace"><h3 id="h-trace">The drawing, balloon by balloon</h3>${trace}</section>`;
}

export function lineDetail(m: Manifest, find: number): { title: string; html: string } | null {
  const l: Line | undefined = m.lines[find - 1];
  if (!l) return null;
  const usedBy = m.lines.filter((x) => x.uses.includes(find));
  const rows: [string, string][] = [
    ['Source', `${sourceBadge(l.source)}<p class="muted small">${esc(SOURCE_WHAT[l.source])}</p>`],
    ['Maintained by', `<strong>${esc(MAINTAINER_LABEL[l.maintainedBy])}</strong>${l.floor ? `, inherited from the ${esc(m.baseline.name)}` : ''}<p class="muted small">${esc(MAINTAINER_WHAT[l.source])}</p>`],
    ['Group', esc(l.group)],
  ];
  if (l.library.length) rows.push(['Standard assembly', l.library.map((b) => `<strong>${esc(b.name)}</strong>: ${b.tests} tests${b.mutationFloor !== null ? `, mutation floor ${b.mutationFloor}%` : ''}${b.requires.length ? `; needs ${esc(b.requires.join(', '))}` : ''}`).join('<br>')]);
  if (l.from) rows.push(['Covered today by', esc(l.from)]);
  rows.push(['Proved by', l.journeys.length ? `${l.journeys.length} journey${l.journeys.length === 1 ? '' : 's'}` : 'no journey yet']);
  const why = `<h4>Why it is on the manifest</h4><ul class="rel-list">${l.why.map((w) => `<li>${esc(w.text)}${w.balloons.length ? ` <span class="balloons">${w.balloons.map((b) => `<button type="button" class="mini-balloon" data-node="b${b}" aria-label="Balloon ${b}">${b}</button>`).join(' ')}</span>` : ''}</li>`).join('')}</ul>`;
  const uses = l.uses.length ? `<h4>Assembled from (${l.uses.length})</h4><ul class="rel-list">${l.uses.map((u) => `<li><button type="button" class="link-row" data-node="line:${u}"><span class="findref">${u}</span>${esc(m.lines[u - 1]!.part)}</button></li>`).join('')}</ul>` : '';
  const used = usedBy.length ? `<h4>Used in (${usedBy.length})</h4><ul class="rel-list">${usedBy.map((u) => `<li><button type="button" class="link-row" data-node="line:${u.find}"><span class="findref">${u.find}</span>${esc(u.part)}</button></li>`).join('')}</ul>` : '';
  const js = l.journeys.length ? `<h4>Journeys that prove it</h4><ul class="rel-list">${l.journeys.slice(0, 12).map((j) => `<li><button type="button" class="chip file" data-file="gauges/${esc(j)}.yaml">${esc(j)}</button></li>`).join('')}${l.journeys.length > 12 ? `<li class="muted small">and ${l.journeys.length - 12} more</li>` : ''}</ul>` : '';
  return { title: `Find ${l.find}`, html: `<p class="dr-text">${esc(l.part)}</p>${l.source === 'make: new' ? '' : `<p class="muted">${esc(l.gives)}</p>`}<dl class="dr-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${why}${uses}${used}${js}` };
}
