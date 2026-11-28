/**
 * Manufacturing engineering, live part: what the latest build proved about the gates and ratchets of the process.
 * The routing, the required checks and the gate definitions are read from the repository when the site is built.
 */
import { loadFeed } from './feed.ts';
import { flowInFocus, handoff, paintLine } from './line.ts';
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
  const feed = await loadFeed();
  const s = studioFlow(studioRaw(), feed);
  paintLine(flowInFocus([...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])]));
  const proven = feed?.gates.filter((g) => g.proof === 'valid').length ?? 0;
  $('process-live').innerHTML = `<section class="sheet" aria-labelledby="h-live"><h2 id="h-live">What the latest build proved</h2>${
    feed
      ? `<p class="small muted">Build <code>${esc(feed.commit.slice(0, 7))}</code>, ${esc(when(feed.builtAt))}.</p><ul class="readings"><li>${proven} of ${feed.gates.length} gates proven able to fail</li><li>${feed.ratchets.length} ratchets held, each only ever tightening</li><li>Process capability: not measured yet</li></ul>`
      : '<p><strong>The factory has not published its feed yet.</strong> Gate proofs and ratchets show here once it does; until then they are not measured.</p>'
  }</section>`;
  $('handoff-slot').innerHTML = handoff('process', !!feed, 'The factory floor builds to the build package: its operator agent drives each product down the line, station by station.');
}

void start();
