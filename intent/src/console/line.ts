/**
 * The line: every surface of zthr.ai in the order work moves through it, from mission control to the fleet. Each
 * page carries the same bar, the product in focus, and a lamp for where that product stands at each department, so a
 * person can move along the line without losing the thread.
 */
import type { Flow, Light, StageKey } from './pipeline.ts';

export type Dept = 'mission' | 'lines' | 'intent' | 'engineering' | 'factory' | 'qa' | 'shipping' | 'fleet';

export interface Department {
  readonly key: Dept;
  readonly href: string;
  readonly label: string;
  /** What the department does, in a line. */
  readonly does: string;
  /** The factory station it reports on, when it has one. */
  readonly station?: StageKey;
}

export const DEPARTMENTS: readonly Department[] = [
  { key: 'mission', href: '/mission', label: 'Mission control', does: 'Every product line and product, where each stands, and what is waiting on a person.' },
  { key: 'lines', href: '/lines', label: 'Product lines', does: 'Define a line: who it serves, and the defaults every product in it starts from.' },
  { key: 'intent', href: '/intent', label: 'Intent studio', does: 'Say what a product must do, settle the questions, and sign the schematic as what you mean.', station: 'intent' },
  { key: 'engineering', href: '/engineering', label: 'Engineering', does: 'Turn the signed schematic into a complete specification: outcomes, data, compliance, operations, measures and tests.', station: 'design' },
  { key: 'factory', href: '/factory', label: 'Factory', does: 'Build to the released package, and measure what was built.', station: 'build' },
  { key: 'qa', href: '/qa', label: 'QA', does: 'Walk every journey as a person would, prove every gate can fail, hold every ratchet.', station: 'qa' },
  { key: 'shipping', href: '/shipping', label: 'Shipping', does: 'Move a certified build to the people it is for, stage by stage, with a person approving production.', station: 'release' },
  { key: 'fleet', href: '/fleet', label: 'Fleet', does: 'Everything in service, the library each app draws on, and the data it keeps.' },
];

export const dept = (k: Dept) => DEPARTMENTS.find((d) => d.key === k)!;
export const nextDept = (k: Dept): Department | null => DEPARTMENTS[DEPARTMENTS.findIndex((d) => d.key === k) + 1] ?? null;

/** The bar, as static HTML: the line in order, the current department marked, lamps filled in by the page's script. */
export function lineBar(current: Dept): string {
  return `<header class="zbar"><a class="brand" href="/">ZTHR</a><nav aria-label="Departments"><ol class="zline">${DEPARTMENTS.map(
    (d, i) => `<li><a href="${d.href}"${d.key === current ? ' aria-current="page"' : ''} data-dept="${d.key}"><span class="zl-n" aria-hidden="true">${i + 1}</span><span class="zl-name">${d.label}</span><span class="zl-lamp" data-lamp="${d.key}" aria-hidden="true"></span></a></li>`,
  ).join('')}</ol></nav><a class="zl-product" id="zl-product" href="/lines" hidden></a></header>`;
}

/** The one action that hands the work to the next department. */
export function handoff(current: Dept, ready: boolean, why: string): string {
  const n = nextDept(current);
  if (!n) return '';
  return `<section class="handoff" aria-label="Next department"><p><strong>Next: ${n.label}.</strong> ${why}</p><a class="btn ${ready ? 'primary' : 'secondary'}" href="${n.href}">Go on to ${n.label}</a></section>`;
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

const WORD: Record<Light, string> = { pass: 'holds', fail: 'open or failing', 'not measured': 'not measured', waiting: 'waiting for an earlier department' };

/** Fill the bar's lamps for the product in focus. */
export function paintLine(flow: Flow | null): void {
  const chip = document.getElementById('zl-product');
  // On a narrow screen the line scrolls: keep the department you are in, and its neighbours, in view.
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
    const light: Light | null = !flow ? null : d.station ? flow.stages.find((s) => s.key === d.station)!.light : d.key === 'fleet' ? (flow.stages.find((s) => s.key === 'release')!.light === 'pass' ? 'pass' : 'waiting') : null;
    el.className = `zl-lamp${light ? ` l-${light.replace(' ', '-')}` : ''}`;
    a.title = light ? `${d.label}: ${flow!.product}, ${WORD[light]}` : d.does;
    const sr = a.querySelector('.sr') ?? a.appendChild(Object.assign(document.createElement('span'), { className: 'sr' }));
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
