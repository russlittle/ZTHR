/**
 * Deployment engineering, live part: the delivery zthr.ai's own deploy recorded for the reference build. The
 * environments, the stages and the monitoring are read from the repository when the site is built.
 */
import { loadDelivery, loadFeed } from './feed.ts';
import { flowInFocus, paintLine } from './line.ts';
import { factoryFlows, studioFlow } from './pipeline.ts';
import { $ } from './shell.ts';
import { esc, when } from './views.ts';

const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

async function start() {
  document.documentElement.classList.add('js');
  const [feed, delivery] = await Promise.all([loadFeed(), loadDelivery()]);
  const s = studioFlow(studioRaw(), feed);
  paintLine(flowInFocus([...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])]));
  $('deployment-live').innerHTML = `<section class="sheet" aria-labelledby="h-live"><h2 id="h-live">The last verified delivery</h2>${
    delivery
      ? `<p>The running reference app served the copy built from commit <code>${esc(delivery.commit.slice(0, 7))}</code>, and every part matched that build's checksums, at ${esc(when(delivery.verifiedAt))}. Served from ${esc(delivery.served)}.</p>`
      : '<p><strong>Not measured yet.</strong> No delivery has been recorded: zthr.ai writes the record when it publishes the reference build and finds every part matches.</p>'
  }</section>`;
}

void start();
