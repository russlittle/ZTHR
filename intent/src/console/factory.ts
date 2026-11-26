/**
 * The factory console: what the latest build measured, every journey and its verdict, every phase and its
 * certificate, every gate and its proof, every ratchet and its floor. Read-only; the evidence pages hold the detail.
 */
import { EVIDENCE, factoryIntent, loadFeed, type Feed, type Status } from './feed.ts';
import { esc, headline, journeyDetail, journeys, lamp, phases, readings, when } from './views.ts';
import { drawer, $ } from './shell.ts';
import { flowInFocus, handoff, paintLine, type Dept } from './line.ts';
import { factoryFlows, studioFlow } from './pipeline.ts';

/** One script serves the factory and QA: each page holds the sections it shows. */
const DEPT: Dept = document.body.dataset['dept'] === 'qa' ? 'qa' : 'factory';
const put = (id: string, html: () => string) => {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html();
};
const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

let feed: Feed | null = null;
let filter: Status | 'all' = 'all';

function render() {
  if (!feed) {
    put('handoff-slot', () => '');
    $('factory-body').innerHTML = `<div class="empty-state wide"><p><strong>The factory has not published its feed yet.</strong></p><p class="muted">The next build of the reference implementation writes it from its own evidence. Every reading is already on the evidence pages.</p><p><a class="btn" href="${EVIDENCE}/index.html">Open the evidence</a></p></div>`;
    return;
  }
  const row = factoryIntent(feed);
  put('measure', () => headline(row, feed));
  put('readings', () => readings(feed!));
  put('journeys', () => journeys(row, filter));
  put('phases', () => phases(feed!));
  put('gates', () => `<table class="gtable"><caption class="sr">Every gate and whether its proof is valid</caption><thead><tr><th scope="col">Gate</th><th scope="col">What it protects</th><th scope="col">Proof</th></tr></thead><tbody>${feed!.gates.map((g) => `<tr><th scope="row"><code>${esc(g.id)}</code></th><td>${esc(g.protects)}</td><td>${lamp(g.proof === 'valid' ? 'pass' : g.proof === 'invalid' ? 'fail' : 'not measured', g.proof === 'valid' ? 'proven' : g.proof === 'invalid' ? 'proof no longer valid' : 'not proven')} ${esc(g.proof === 'valid' ? 'proven' : g.proof === 'invalid' ? 'invalid' : 'not proven')}</td></tr>`).join('')}</tbody></table>`);
  put('ratchets', () => (feed!.ratchets.length ? `<ul class="rlist">${feed!.ratchets.map((r) => `<li><code>${esc(r.id)}</code> <span>floor <strong>${r.floor}</strong>${r.direction ? `, only ${r.direction === 'down' ? 'falls' : 'rises'}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No ratchets in this build.</p>'));
  const failing = row.journeys.filter((j) => j.status === 'fail').length;
  const walked = row.journeys.filter((j) => j.status !== 'not measured').length;
  put('handoff-slot', () =>
    DEPT === 'factory'
      ? handoff('factory', true, `Build ${feed!.commit.slice(0, 7)} is made. QA walks its ${row.journeys.length} journeys as a person would, and checks every gate and ratchet.`)
      : handoff('qa', walked > 0 && failing === 0, walked ? (failing ? `${failing} journey${failing === 1 ? '' : 's'} failing: those go back to the factory as cases, and only certified phases ship.` : 'Every walked journey passes. Certified phases go to shipping.') : 'Nothing walked in this build yet. Shipping takes only phases QA has certified.'),
  );
  $('stamp').innerHTML = `Build <code>${esc(feed.commit.slice(0, 7))}</code>, ${esc(when(feed.builtAt))}`;
}

async function start() {
  document.documentElement.classList.add('js');
  feed = await loadFeed();
  render();
  const studio = studioFlow(studioRaw(), feed);
  const focus = flowInFocus([...(feed ? factoryFlows(feed) : []), ...(studio ? [studio] : [])]);
  paintLine(focus);
  // Say plainly when the product in focus is not the one this build measured, rather than let one stand for the other.
  if (focus && focus.source === 'studio' && feed) {
    const note = document.createElement('section');
    note.className = 'sheet focus-note';
    note.setAttribute('aria-label', 'The product in focus');
    const st = focus.stages.find((x) => x.key === (DEPT === 'qa' ? 'qa' : 'build'))!;
    note.innerHTML = `<p><strong>${esc(focus.product)}:</strong> ${esc(st.headline)}. The factory has not reported on it yet. Below is what the factory's latest build measured for ${esc(feed.app.name)}, the reference product.</p>`;
    document.getElementById('main')?.prepend(note);
  }
  document.body.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-filter], [data-journey]');
    if (!t || !feed) return;
    if (t.dataset['filter']) {
      filter = t.dataset['filter'] as Status | 'all';
      render();
      document.querySelector<HTMLElement>(`[data-filter="${filter}"]`)?.focus();
    } else if (t.dataset['journey']) {
      const d = journeyDetail(factoryIntent(feed), t.dataset['journey']);
      if (d) drawer.open(d.title, d.html, t);
    }
  });
}

void start();
