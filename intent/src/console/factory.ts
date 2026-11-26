/**
 * The factory console: what the latest build measured, every journey and its verdict, every phase and its
 * certificate, every gate and its proof, every ratchet and its floor. Read-only; the evidence pages hold the detail.
 */
import { EVIDENCE, factoryIntent, loadFeed, type Feed, type Status } from './feed.ts';
import { esc, headline, journeyDetail, journeys, lamp, phases, readings, when } from './views.ts';
import { drawer, $ } from './shell.ts';

let feed: Feed | null = null;
let filter: Status | 'all' = 'all';

function render() {
  if (!feed) {
    $('factory-body').innerHTML = `<div class="empty-state wide"><p><strong>The factory has not published its feed yet.</strong></p><p class="muted">The next build of the reference implementation writes it from its own evidence. Every reading is already on the evidence pages.</p><p><a class="btn" href="${EVIDENCE}/index.html">Open the evidence</a></p></div>`;
    return;
  }
  const row = factoryIntent(feed);
  $('measure').innerHTML = headline(row, feed);
  $('readings').innerHTML = readings(feed);
  $('journeys').innerHTML = journeys(row, filter);
  $('phases').innerHTML = phases(feed);
  $('gates').innerHTML = `<table class="gtable"><caption class="sr">Every gate and whether its proof is valid</caption><thead><tr><th scope="col">Gate</th><th scope="col">What it protects</th><th scope="col">Proof</th></tr></thead><tbody>${feed.gates.map((g) => `<tr><th scope="row"><code>${esc(g.id)}</code></th><td>${esc(g.protects)}</td><td>${lamp(g.proof === 'valid' ? 'pass' : g.proof === 'invalid' ? 'fail' : 'not measured', g.proof === 'valid' ? 'proven' : g.proof === 'invalid' ? 'proof no longer valid' : 'not proven')} ${esc(g.proof === 'valid' ? 'proven' : g.proof === 'invalid' ? 'invalid' : 'not proven')}</td></tr>`).join('')}</tbody></table>`;
  $('ratchets').innerHTML = feed.ratchets.length ? `<ul class="rlist">${feed.ratchets.map((r) => `<li><code>${esc(r.id)}</code> <span>floor <strong>${r.floor}</strong>${r.direction ? `, only ${r.direction === 'down' ? 'falls' : 'rises'}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">No ratchets in this build.</p>';
  $('stamp').innerHTML = `Build <code>${esc(feed.commit.slice(0, 7))}</code>, ${esc(when(feed.builtAt))}`;
}

async function start() {
  document.documentElement.classList.add('js');
  feed = await loadFeed();
  render();
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
