/**
 * The bar every page of zthr.ai carries: the areas of the plant, grouped as the plant model groups them (the front
 * office, engineering, the line, the field and support), the area you are in marked, and a lamp for where the product
 * in focus stands at each. It is drawn from src/console/plant-model.ts and from nothing else, so the bar, the docs and
 * the pages cannot disagree about what the plant is made of.
 */
import type { Flow, Light } from './pipeline.ts';
import { AREAS, GROUPS, area, depthOf, nextOf, pageHref, stepOf, type Area, type AreaKey, type Station } from './plant-model.ts';

export type Dept = AreaKey;

export interface Department {
  readonly key: AreaKey;
  readonly href: string;
  readonly label: string;
  /** What the area does, in a line. */
  readonly does: string;
  /** The station it reports on in a product's flow, when it has one. */
  readonly station?: Station;
  /** Its step on the work path, when it has one. The front office and the support crews have none. */
  readonly step: number | null;
  readonly group: Area['group'];
  readonly inside?: AreaKey;
  readonly serves?: readonly AreaKey[];
  readonly serving?: string;
}

/** Every area of the plant, in the model's order. */
export const DEPARTMENTS: readonly Department[] = AREAS.map((a) => ({
  key: a.key,
  href: pageHref(a),
  label: a.label,
  does: a.does,
  ...(a.station ? { station: a.station } : {}),
  step: stepOf(a.key),
  group: a.group,
  ...(a.inside ? { inside: a.inside } : {}),
  ...(a.serves ? { serves: a.serves } : {}),
  ...(a.serving ? { serving: a.serving } : {}),
}));

export const dept = (k: Dept) => DEPARTMENTS.find((d) => d.key === k)!;
/** The area that takes the work next; the front office and the support crews hand nothing on. */
export const nextDept = (k: Dept): Department | null => {
  const n = nextOf(k);
  return n ? dept(n.key) : null;
};

/** The words a screen reader gets after an area's name: where it sits, or whom it serves. */
const placing = (d: Department): string => (d.inside ? `inside ${area(d.inside).label}` : d.serving ? d.serving : '');

/** The bar, as static HTML: the plant's areas by group, the current one marked, lamps filled in by the page's script. */
export function lineBar(current: Dept | 'plant' | null, docs = false): string {
  const item = (d: Department) => {
    const depth = depthOf(d.key);
    const mark = d.step !== null ? `<span class="zl-n" aria-hidden="true">${d.step}</span>` : d.key === 'rework' ? '<span class="zl-n zl-loop" aria-hidden="true">\u21a9</span>' : depth ? '<span class="zl-in" aria-hidden="true">\u21b3</span>' : '';
    const where = placing(d);
    const title = where ? `${d.label}, ${where}. ${d.does}` : d.does;
    return `<li class="zi${depth ? ` in${depth}` : ''}${d.group === 'support' ? ' zs' : ''}"><a href="${d.href}"${d.key === current ? ' aria-current="page"' : ''} data-dept="${d.key}" title="${title.replace(/"/g, '&quot;')}">${mark}<span class="zl-name">${d.label}</span><span class="zl-lamp" data-lamp="${d.key}" aria-hidden="true"></span>${where ? `<span class="sr">, ${where}</span>` : ''}</a></li>`;
  };
  const groups = GROUPS.map((g) => `<li class="zg" data-group="${g.key}"><span class="zg-h">${g.label}</span><ul class="zline">${DEPARTMENTS.filter((d) => d.group === g.key).map(item).join('')}</ul></li>`).join('');
  const page = current && current !== 'plant' ? area(current).page : '';
  return `<header class="zbar"><a class="brand" href="/">ZTHR</a><a class="zl-plant" href="/plant/"${current === 'plant' ? ' aria-current="page"' : ''}>Plant</a><nav aria-label="Areas of the plant"><ul class="zgroups">${groups}</ul></nav><a class="zl-product" id="zl-product" href="/lines" hidden></a><a class="zl-docs" href="/line/${!docs && page ? `${page}/` : ''}"${docs && !current ? ' aria-current="page"' : ''}>How it works</a></header>`;
}

/** The one action that hands the work to the next area. */
export function handoff(current: Dept, ready: boolean, why: string): string {
  const n = nextDept(current);
  if (!n) return '';
  return `<section class="handoff" aria-label="Next area"><p><strong>Next: ${n.label}.</strong> ${why}</p><a class="btn ${ready ? 'primary' : 'secondary'}" href="${n.href}">Go on to ${n.label}</a></section>`;
}

// ---------------------------------------------------------------- the product in focus

const FOCUS = 'zthr-product';

export function focusProduct(): string | null {
  try {
    return localStorage.getItem(FOCUS);
  } catch {
    return null;
  }
}

export function setFocus(name: string): void {
  try {
    localStorage.setItem(FOCUS, name);
  } catch {
    /* a browser that keeps nothing still works for this visit */
  }
}

const WORD: Record<Light, string> = { pass: 'holds', fail: 'open or failing', 'not measured': 'not measured', waiting: 'waiting for an earlier area' };

/** Fill the bar's lamps for the product in focus. */
export function paintLine(flow: Flow | null): void {
  const chip = document.getElementById('zl-product');
  // On a narrow screen the line scrolls: keep the area you are in, and its neighbours, in view.
  const here = document.querySelector<HTMLElement>('.zline a[aria-current=page]');
  const nav = here?.closest('nav');
  if (here && nav && nav.scrollWidth > nav.clientWidth) {
    const left = here.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    nav.scrollLeft = Math.max(0, left - (nav.clientWidth - here.offsetWidth) / 2);
  }
  for (const d of DEPARTMENTS) {
    const el = document.querySelector<HTMLElement>(`[data-lamp="${d.key}"]`);
    const a = document.querySelector<HTMLElement>(`a[data-dept="${d.key}"]`);
    if (!el || !a) continue;
    // A lamp shows only what was measured for the product at that station. The fleet's is lit only by something in service.
    const light: Light | null = !flow || !d.station ? null : (flow.stages.find((s) => s.key === d.station)?.light ?? null);
    el.className = `zl-lamp${light ? ` l-${light.replace(' ', '-')}` : ''}`;
    a.title = light ? `${d.label}: ${flow!.product}, ${WORD[light]}` : d.does;
    const sr = a.querySelector('.zl-state') ?? a.appendChild(Object.assign(document.createElement('span'), { className: 'sr zl-state' }));
    sr.textContent = light ? `, ${WORD[light]}` : '';
  }
  if (chip) {
    chip.hidden = !flow;
    if (flow) {
      chip.innerHTML = `<span class="small">Product</span> ${flow.product.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}`;
      chip.setAttribute('aria-label', `Product in focus: ${flow.product}. Open product lines`);
    }
  }
}

const RANK: Record<Light, number> = { fail: 3, 'not measured': 2, waiting: 1, pass: 0 };

/** One product's flows as one: at each station, the worst light any of its intents shows. */
export function productFlow(flows: readonly Flow[], product: string): Flow | null {
  const mine = flows.filter((f) => f.product === product);
  if (!mine.length) return null;
  if (mine.length === 1) return mine[0]!;
  return { ...mine[0]!, stages: mine[0]!.stages.map((st) => ({ ...st, light: mine.map((f) => f.stages.find((x) => x.key === st.key)!.light).sort((a, b) => RANK[b] - RANK[a])[0]! })) };
}

/** The product in focus: the one last worked on, or the studio's own, or the first there is. */
export function flowInFocus(flows: readonly Flow[]): Flow | null {
  const want = focusProduct();
  const name = flows.some((f) => f.product === want) ? want! : (flows.find((f) => f.source === 'studio') ?? flows[0])?.product;
  return name ? productFlow(flows, name) : null;
}
