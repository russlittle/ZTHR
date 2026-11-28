/**
 * Maintenance: the night shift beneath the line. What every department tagged, what the crew fixed and escalated,
 * each block's gauge scores, and what the work cost, read from the records the crew and the mutation runs write.
 * Until a shift has run, the page says so.
 */
import { loadFeed } from './feed.ts';
import { flowInFocus, paintLine } from './line.ts';
import { emptyNight, loadNight, nightBody } from './night.ts';
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
  $('night-body').innerHTML = `${night ? '' : '<section class="sheet"><p><strong>The night shift has not published its records yet.</strong> They arrive with the next build of this site, read from the repository; until then nothing below is measured.</p></section>'}${nightBody(night ?? emptyNight())}`;
  $('handoff-slot').innerHTML = `<section class="handoff" aria-label="The morning report"><p><strong>The morning report goes to mission control.</strong> What was fixed carries its evidence; what was escalated waits there for the person it needs; what is new is already on tonight's list.</p><a class="btn" href="/mission">Back to mission control</a></section>`;
}

void start();
