/**
 * The fleet: every app in service, where the library is used, and the data they keep, governed one way. A fix to a
 * standard assembly reaches every app that uses it; sensitive data is gated and audited the same way in each.
 */
import { loadFeed } from './feed.ts';
import { flowInFocus, paintLine } from './line.ts';
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
<section class="sheet" aria-labelledby="h-lib"><h2 id="h-lib">Where the library is used</h2><p class="muted">Product engineering keeps ${lib.assemblies.length} standard assemblies and ${lib.parts} catalogued parts. The fleet shows which apps use each, and which version each app runs, so a fix made once can be sent to every app that uses it and each app's own tests prove it still holds.</p>${whereUsed(lib, flows)}</section>
<section class="sheet" aria-labelledby="h-ota"><h2 id="h-ota">Updates over the air</h2><p>A release reaches an app in service over the air, in stages, with the previous revision kept ready to take traffic back in one step. An update that burns an error budget fast is rolled back without waiting for a person. What the field shows goes back to mission control as it happens: alerts, service levels and what people report.</p><p class="small muted">${inService.length ? 'No update history is recorded for the apps above yet.' : 'Nothing is in service, so there are no updates to show.'} The environments and the rollback path are on <a href="/deployment">Deployment engineering</a>.</p></section>
<section class="sheet" aria-labelledby="h-sd"><h2 id="h-sd">Sensitive data across the fleet</h2>${fleetSensitive(flows)}</section>`;
  $('handoff-slot').innerHTML = `<section class="handoff" aria-label="Back to the start"><p><strong>The field reports back.</strong> What people report in service, and every alert, goes to mission control: a bug goes to rework, an idea to the person who holds the intent, and the plant runs again.</p><a class="btn" href="/mission">Report to mission control</a></section>`;
}

void start();
