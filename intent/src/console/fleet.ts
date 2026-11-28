/**
 * The fleet: every app in service, the library they share, and the data they keep, governed one way. A fix to a
 * standard assembly reaches every app that uses it; sensitive data is gated and audited the same way in each.
 */
import { loadFeed } from './feed.ts';
import { flowInFocus, handoff, paintLine } from './line.ts';
import { bar, fleetSensitive, lamp, whereUsed } from './missionViews.ts';
import { factoryFlows, library, studioFlow, type Flow } from './pipeline.ts';
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
  const flows: Flow[] = [...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])];
  paintLine(flowInFocus(flows));
  const lib = library();
  const inService = feed ? [feed] : [];
  const notYet = flows.filter((f) => f.source === 'studio');
  const m = flows.filter((f) => f.source !== 'studio').reduce((a, f) => ({ pass: a.pass + f.measure.pass, fail: a.fail + f.measure.fail, unmeasured: a.unmeasured + f.measure.unmeasured, total: a.total + f.measure.total }), { pass: 0, fail: 0, unmeasured: 0, total: 0 });
  $('fleet-body').innerHTML = `<section class="sheet" aria-labelledby="h-svc"><h2 id="h-svc">In service</h2>
${inService.length ? `<ul class="prod-list">${inService.map((f) => `<li><div class="pcard"><span class="src-tag">in service</span><span class="ftitle">${esc(f.app.name)}</span><span class="small">Build <code>${esc(f.commit.slice(0, 7))}</code>, ${esc(when(f.builtAt))} · <a href="${esc(f.app.href)}">open it</a> · <a href="/qa">its journeys</a></span>${bar(m)}<span class="small muted">${m.pass + m.fail ? `${m.pass} of ${m.total} journeys pass` : `${m.total} journeys waiting to be walked`}</span></div></li>`).join('')}</ul>` : '<p class="muted">Nothing in service yet.</p>'}
${notYet.length ? `<h3>On the way</h3><ul class="plist">${notYet.map((f) => `<li><span class="pname">${esc(f.product)}</span><span class="lamps">${f.stages.map((st) => lamp(st.light)).join('')}</span><span class="small muted">${esc(f.stages.find((st) => st.light !== 'pass')?.headline ?? 'in service')}</span></li>`).join('')}</ul>` : ''}</section>
<section class="sheet" aria-labelledby="h-lib"><h2 id="h-lib">The library every app draws on</h2><p class="muted">${lib.assemblies.length} standard assemblies and ${lib.parts} catalogued parts, maintained by the fleet. A fix made once is pushed to every app that uses it, and each app's own tests prove it still holds.</p>${whereUsed(lib, flows)}</section>
<section class="sheet" aria-labelledby="h-sd"><h2 id="h-sd">Sensitive data across the fleet</h2>${fleetSensitive(flows)}</section>`;
  $('handoff-slot').innerHTML = `<section class="handoff" aria-label="Back to the start"><p><strong>The loop closes here.</strong> What people report in service, and every alert, comes back as a case: a bug goes to the factory, an idea to the person who holds the intent, and the line runs again.</p><a class="btn" href="/mission">Back to mission control</a></section>`;
  void handoff;
}

void start();
