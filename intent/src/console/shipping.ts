/**
 * Shipping: a certified build moves to people stage by stage, each with its gate, a person approving production,
 * and going back always one step. For the product in focus: where it stands, its service levels, and the pipeline in
 * its package. For the reference product: what the factory's feed says was certified and where it is served.
 */
import { objectives, STAGES } from '../delivery.ts';
import { loadDelivery, loadFeed, referenceStages, type Delivery, type Feed } from './feed.ts';
import { flowInFocus, handoff, paintLine } from './line.ts';
import { lamp } from './missionViews.ts';
import { factoryFlows, preparedFrom, studioFlow, type Flow, type Light } from './pipeline.ts';
import { $ } from './shell.ts';
import { esc, when } from './views.ts';

const studioRaw = () => {
  try {
    return localStorage.getItem('intent-studio:v1');
  } catch {
    return null;
  }
};

function stages(lights: readonly Light[], notes: readonly string[]): string {
  return `<ol class="ship">${STAGES.map((s, i) => `<li class="ship-st"><span class="ship-n">${i + 1}</span><div><h3>${lamp(lights[i] ?? 'waiting')} ${esc(s.name)}</h3><p class="small">${esc(s.proves.join('; '))}.</p><p class="gate"><strong>Gate:</strong> ${esc(s.gate)}.</p>${notes[i] ? `<p class="small muted">${esc(notes[i]!)}</p>` : ''}</div></li>`).join('')}</ol>`;
}

function reference(feed: Feed, delivery: Delivery | null): string {
  const results = referenceStages(feed, delivery);
  const certified = feed.phases.filter((p) => p.certified === true);
  return `<section class="sheet" aria-labelledby="h-ref"><h2 id="h-ref">${esc(feed.app.name)}: what the factory shipped</h2>
<p>Build <code>${esc(feed.commit.slice(0, 7))}</code>, ${esc(when(feed.builtAt))}. Served at <a href="${esc(feed.app.href)}">${esc(feed.app.href)}</a>. ${certified.length} of ${feed.phases.length} phase${feed.phases.length === 1 ? '' : 's'} certified.</p>
<div class="tbl-wrap" tabindex="0" role="region" aria-label="Phases and their certificates"><table class="swim"><thead><tr><th scope="col">Phase</th><th scope="col">Certificate</th><th scope="col">Features</th></tr></thead><tbody>${feed.phases.map((p) => `<tr><th scope="row">${p.n}. ${esc(p.name)}</th><td>${lamp(p.certified === true ? 'pass' : p.certified === false ? 'fail' : 'not measured')} ${p.certified === true ? `certified ${esc(when(p.certifiedAt ?? feed.builtAt))}` : p.certified === false ? 'not certified' : 'not measured'}</td><td>${p.features.length}</td></tr>`).join('')}</tbody></table></div>
<h3>Delivery stages</h3>
<p class="small muted">Each judged only from what the build and zthr.ai's deploy recorded. A stage the reference pipeline does not have yet shows as not measured.</p>
${stages(results.map((x) => x.status), results.map((x) => x.note))}</section>`;
}

function own(flow: Flow | null): string {
  const got = preparedFrom(studioRaw());
  if (!got || !flow || flow.source !== 'studio') return '';
  const qa = flow.stages.find((s) => s.key === 'qa')!;
  const released = flow.outputs.spec.light === 'pass';
  const o = objectives(got.p);
  const notes = [released ? 'Its pipeline is in the package: delivery/ and ops/.' : 'Waiting for engineering to release a revision.', qa.light === 'pass' ? '' : 'Waits for QA: every journey walked and passing.'];
  return `<section class="sheet" aria-labelledby="h-own"><h2 id="h-own">${esc(flow.product)}</h2>
<p>${released ? `Revision released; the factory builds to it. ${esc(qa.headline)}.` : 'Not released yet: shipping starts from a build of a released revision that QA has certified.'}</p>
${stages(STAGES.map(() => 'waiting'), notes)}
<h3>The service levels it will be held to</h3>
<p class="small muted">Set by its schematic, watched from the first canary on. A fast burn of any budget rolls it back.</p>
<ul class="slo">${o.list.map((x) => `<li><strong>${(x.goal * 100).toFixed(1)}%</strong> ${esc(x.what)} <span class="small muted">(${esc(x.from)})</span></li>`).join('')}</ul></section>`;
}

async function start() {
  document.documentElement.classList.add('js');
  const [feed, delivery] = await Promise.all([loadFeed(), loadDelivery()]);
  const s = studioFlow(studioRaw(), feed);
  const flows = [...(feed ? factoryFlows(feed) : []), ...(s ? [s] : [])];
  const focus = flowInFocus(flows);
  paintLine(focus);
  const mine = own(focus);
  $('ship-body').innerHTML = `${mine}${feed ? reference(feed, delivery) : '<section class="sheet"><p><strong>The factory has not published its feed yet.</strong> The reference product shows here once it does.</p></section>'}
<section class="sheet" aria-labelledby="h-who"><h2 id="h-who">Who does what</h2><p>The operator requests each stage in order; the pipeline runs it under its own identity and records what it proved; a named person approves production after the canary; rolling back is always allowed and takes one step. No one, agent or person, skips a stage. <a href="https://github.com/russlittle/ZTHR/blob/main/intent/docs/operations.md">How delivery and operations work</a>.</p></section>`;
  $('handoff-slot').innerHTML = handoff('shipping', !!feed, 'What ships joins the fleet: updated over the air, with rollback, watched against its service levels, and reporting back to mission control.');
}

void start();
