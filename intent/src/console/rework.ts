/**
 * Rework: what QA has sent back. For the latest build, every journey that failed is a return, with the evidence of its
 * failure; for the product in the studio, the same. Nothing is inferred: with no build published there are no returns
 * to show, and the page says so.
 */
import { loadFeed } from './feed.ts';
import { flowInFocus, handoff, paintLine } from './line.ts';
import { factoryFlows, studioFlow, type Flow } from './pipeline.ts';
import { $ } from './shell.ts';
import { esc, when } from './views.ts';

const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

const returns = (f: Flow): string => {
  const failed = f.items.filter((i) => i.status === 'fail');
  const walked = f.items.filter((i) => i.status !== 'not measured').length;
  if (!walked) return `<p class="muted">${esc(f.product)}: no journey has been walked in this build, so nothing has been returned.</p>`;
  if (!failed.length) return `<p>${esc(f.product)}: all ${walked} journeys walked pass. Nothing is waiting in rework.</p>`;
  return `<p>${esc(f.product)}: ${failed.length} of ${walked} walked journeys failed and are waiting in rework.</p><ul class="jlist">${failed.map((i) => `<li><span class="jrow"><span class="lamp fail" role="img" aria-label="failing"><span aria-hidden="true">✕</span></span><span class="jgoal">${esc(i.label)}</span><span class="jmeta">${i.persona ? `As ${esc(i.persona)}. ` : ''}<code>${esc(i.id)}</code> · <a href="/reference/factory/intent.html">the failing evidence</a></span></span></li>`).join('')}</ul>`;
};

async function start() {
  document.documentElement.classList.add('js');
  const feed = await loadFeed();
  const s = studioFlow(studioRaw(), feed);
  const flows = [...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])];
  paintLine(flowInFocus(flows));
  const ref = flows.filter((f) => f.source !== 'studio');
  $('rework-live').innerHTML = `<section class="sheet" aria-labelledby="h-now"><h2 id="h-now">Returns open now</h2>${
    feed
      ? `<p class="small muted">From build <code>${esc(feed.commit.slice(0, 7))}</code>, ${esc(when(feed.builtAt))}: each journey that fails is returned with the evidence of its failure, and QA inspects the whole product again once it is fixed.</p>${ref.map(returns).join('') || '<p class="muted">The build lists no journeys.</p>'}`
      : '<p><strong>The factory has not published its feed yet.</strong> The returns of the reference product show here once it does; until then none is shown, and none is implied.</p>'
  }${s ? `<h3>${esc(s.product)}, in the studio</h3>${returns(s)}` : ''}</section>`;
  $('handoff-slot').innerHTML = handoff('rework', !!feed && ref.every((f) => f.measure.fail === 0), 'A fixed product goes back through QA: every journey walked again, every gate and ratchet held, before anything ships.');
}

void start();
