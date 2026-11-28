/**
 * Metrology: the measures QA uses and the references they trace to, the certificate of every gauge, control charts on
 * the factory's own process, and the audit of its claims. Read from the calibration runs' certificates; until a block
 * has one, it is shown as not measured.
 */
import { loadFeed } from './feed.ts';
import { labBody } from './lab.ts';
import { flowInFocus, paintLine } from './line.ts';
import { emptyNight, loadNight } from './night.ts';
import { factoryFlows, studioFlow, type Flow } from './pipeline.ts';
import { $ } from './shell.ts';

const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

async function start() {
  document.documentElement.classList.add('js');
  const [feed, night] = await Promise.all([loadFeed(), loadNight()]);
  const s = studioFlow(studioRaw(), feed);
  const flows: Flow[] = [...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])];
  paintLine(flowInFocus(flows));
  $('lab-body').innerHTML = `${night ? '' : '<section class="sheet"><p><strong>The calibration records have not been published yet.</strong> They arrive with the next build of this site, read from the repository; until then no certificate below is measured.</p></section>'}${labBody(night ?? emptyNight())}`;
  $('handoff-slot').innerHTML = `<section class="handoff" aria-label="Where certificates go"><p><strong>Certificates go to QA; tags go to maintenance.</strong> QA judges a build only with gauges certified here. Every planted defect a gauge failed to reject, and every drift a control chart signals, is a work order for the night shift.</p><a class="btn" href="/maintenance">Go to maintenance</a></section>`;
}

void start();
