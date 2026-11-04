import * as ui from '@zthr/ui';
import { PERSONA_LINES } from './demo.js';

/**
 * The Student Advocate's product page: what it is, who it is for, what it does, how and why it works, what it is
 * worth, and a way to try it as any of twelve students. Served as the app's front page, and published as the front
 * of the reference site, so the same words describe the product wherever someone meets it.
 */
export interface ProductLinks {
  /** Where the app is mounted, e.g. "/advocate". */
  app: string;
  docs: string;
  factory: string;
  /** The factory pages people most want, relative to factory. */
  factoryPage: (page: string) => string;
  admin: string;
  /** Asset base for fonts (the app serves them at {base}/_ui/). */
  fontBase: string;
  head?: string;
  /** Live: links go to a running app. Static: the app may not be deployed where the page is read. */
  live: boolean;
}

/** Said wherever someone meets the Advocate: whose it is not, where its facts come from, and why these colleges. */
export const NOT_AFFILIATED = { title: 'Not affiliated with any college', body: 'Not affiliated with any educational institution. All data from public sources.' };

const FEATURES: [string, string, string][] = [
  ['today', 'Runs your day', 'Classes, shifts, child care and due dates on one line. It holds time for the work that matters and tells you the one thing to do today.'],
  ['money', 'Finds money you are missing', 'Checks SNAP, phone and heating help, and campus emergency grants against what you told it, using the agencies\' own published limits.'],
  ['help', 'Finds help and does the legwork', 'Food, rent, power, child care, legal help: verified, current programs near you, what to bring, and a drafted message you can send.'],
  ['bus', 'Handles campus life', 'What is open to eat right now, free food today, a quiet room booked and confirmed, and when to leave for the bus with live delays.'],
  ['book', 'Keeps up with your classes', 'Reads your syllabus and your class site, moves a date when your instructor moves it, and plans the work in the time you have.'],
  ['route', 'Opens doors to work', 'Jobs that fit around your classes and shifts, a fair-chance path when you ask for it, and an introduction to a mentor in your field.'],
];

const PRINCIPLES: [string, string][] = [
  ['Nothing leaves without you', 'Every message it writes for you waits for your approval of the exact words. A tap on Send is the only way anything goes out.'],
  ['Rules before guesses', 'Eligibility, open hours and bus times are computed from published sources, not guessed by a model. When it does not know, it says so.'],
  ['Your facts stay yours', 'Sensitive facts are sealed with your own key. You can see, export or delete everything, any time, in one step.'],
  ['Kind, plain and short', 'It never scolds. Every message offers a next step, at the reading level and length you chose.'],
  ['Crisis comes first', 'Words that mean someone is in danger go straight to 988 or 911 information, before anything else happens.'],
  ['Checked every build', 'More than a thousand tests, every button walked for every student, attacks people really send, and a trace of where your data can go.'],
];

export function productPage(l: ProductLinks): string {
  const students = Object.entries(PERSONA_LINES);
  const try_ = (name: string) => `${l.app}/s/${name.toLowerCase()}`;
  const css = `
.pp{max-width:1120px;margin:0 auto;padding:0 max(16px,env(safe-area-inset-left,0px)) 80px max(16px,env(safe-area-inset-right,0px))}
.pp-top{display:flex;align-items:center;gap:16px;padding:16px 0}
.pp-top nav{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.pp-top nav a{padding:8px 12px;border-radius:999px;font-weight:700;font-size:15px;color:var(--muted);text-decoration:none}
.pp-top nav a:hover{background:var(--calm);color:var(--ink)}
.pp-hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:36px;align-items:center;padding:36px 0 28px}
.pp-hero h1{font-size:clamp(36px,5vw,56px);line-height:1.05;letter-spacing:-.025em;text-wrap:balance}
.pp-hero h1 em{font-style:normal;background:linear-gradient(transparent 62%,color-mix(in srgb,var(--mark) 55%,transparent) 62%)}
.pp-hero p.lede{font-size:20px;color:var(--muted);max-width:34em;margin:16px 0 22px}
.pp-cta{display:flex;flex-wrap:wrap;gap:10px}
.pp-cta .btn{min-height:50px;padding:12px 22px;font-size:16px}
.pp-phone{background:var(--surface);border:1px solid var(--line);border-radius:28px;box-shadow:var(--shadow-lg);padding:18px;max-width:380px;justify-self:center;width:100%}
.pp-phone .bub{border-radius:16px;padding:10px 14px;margin:8px 0;font-size:15px;line-height:1.4;max-width:88%}
.pp-phone .me{background:var(--action);color:var(--action-ink);margin-left:auto;border-bottom-right-radius:4px}
.pp-phone .it{background:var(--calm);border-bottom-left-radius:4px}
.pp-phone .pill{display:inline-block;margin:4px 4px 0 0;padding:5px 10px;border-radius:999px;border:1.5px solid var(--action);color:var(--action);font-weight:700;font-size:13px}
.pp-sec{padding:44px 0 8px}
.pp-sec>h2{font-size:clamp(26px,3vw,34px);letter-spacing:-.015em;text-wrap:balance}
.pp-sec>p.sub{color:var(--muted);font-size:18px;max-width:44em;margin:8px 0 20px}
.pp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.pp-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;box-shadow:var(--shadow)}
.pp-card h3{font-size:19px;margin:10px 0 6px}
.pp-card p{color:var(--muted);margin:0}
.pp-card .ic{color:var(--action);background:var(--tint);border-radius:12px;padding:9px;width:44px;height:44px}
.pp-who{display:flex;flex-wrap:wrap;gap:8px}
.pp-who span{padding:9px 14px;border-radius:999px;background:var(--surface);border:1px solid var(--line);font-weight:700}
.pp-steps{counter-reset:s;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.pp-steps li{list-style:none;counter-increment:s;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:20px 20px 20px 66px;position:relative;box-shadow:var(--shadow)}
.pp-steps li::before{content:counter(s);position:absolute;left:18px;top:18px;width:34px;height:34px;border-radius:50%;background:var(--action);color:var(--action-ink);display:grid;place-items:center;font-weight:700}
.pp-steps b{display:block;font-size:18px;margin-bottom:4px}
.pp-steps span{color:var(--muted)}
.pp-value{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.pp-value .pp-card ul{margin:10px 0 0;padding-left:20px;color:var(--ink)}
.pp-value .pp-card li{margin:6px 0}
.pp-try{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.pp-try a{display:block;text-decoration:none;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px 18px;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s,border-color .15s}
.pp-try a:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:color-mix(in srgb,var(--action) 45%,var(--line))}
.pp-try .nm{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}
.pp-try .av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--tint);color:var(--action);font-weight:700}
.pp-try .ln{display:block;color:var(--muted);font-size:15px;margin:8px 0 6px}
.pp-try .tr{display:block;font-size:14px}
.pp-try .tr::before{content:"Try: ";font-weight:700}
.pp-note{background:var(--tint);border:1px solid color-mix(in srgb,var(--action) 25%,var(--line));border-radius:var(--r-md);padding:12px 16px;margin:14px 0;font-size:15px}
.pp-built{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.pp-built a{display:block;padding:16px;border-radius:var(--r-lg);background:var(--surface);border:1px solid var(--line);text-decoration:none;color:var(--ink);box-shadow:var(--shadow)}
.pp-built a b{display:block;margin-bottom:4px}
.pp-built a span{color:var(--muted);font-size:15px}
.pp-foot{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
@media (max-width:860px){.pp-hero{grid-template-columns:1fr;padding-top:16px}.pp-top nav a.opt{display:none}}`;
  const body = `<div class="pp">
<header class="pp-top"><a class="brand" href="${l.app}/"><span class="brand-mark">${ui.icon('route', 18)}</span>Student Advocate</a><nav aria-label="Product"><a class="opt" href="#what">What it does</a><a class="opt" href="#why">Why it works</a><a href="#try">Try it</a><a href="${l.docs}">Docs</a><a href="${l.factory}">Factory</a><a class="opt" href="https://github.com/russlittle/ZTHR/tree/reference-implementation">Source</a></nav></header>
<main id="main">
<section class="pp-hero">
  <div>
    <h1>A team that works for <em>every student</em>, every day.</h1>
    <p class="lede">Student Advocate runs a student's day, finds the money and help they qualify for, and does the legwork to get it. It belongs to the student, it speaks plainly, and it never shares anything unless they say so.</p>
    <div class="pp-cta">${ui.button({ label: 'Try it as a student', href: '#try' })}${ui.button({ label: 'Try it by text', href: `${l.app}/text`, variant: 'quiet', icon: 'send' })}${ui.button({ label: 'See how it was built', href: l.factory, variant: 'quiet', icon: 'shield' })}</div>
  </div>
  <div class="pp-phone" aria-label="An example conversation by text">
    <div class="bub me">I can't make rent this month</div>
    <div class="bub it">That's stressful. You're about $90 short on December 1. Three ways to cover it:<br><span class="pill">Emergency grant</span><span class="pill">Ask for more time</span><span class="pill">Talk to 2-1-1</span></div>
    <div class="bub me">Emergency grant</div>
    <div class="bub it">You meet Sinclair's grant rules. I filled in what I know and wrote the note. Read it, then tap Send if it sounds like you.</div>
  </div>
</section>

<section class="pp-sec" aria-labelledby="who"><h2 id="who">Who it is for</h2><p class="sub">Students who carry more than classes: the ones most likely to stop out for reasons that have nothing to do with ability.</p>
<div class="pp-who"><span>Working students</span><span>Student parents</span><span>First in their family</span><span>Adults returning to school</span><span>Students short on food or rent</span><span>Students who were in foster care</span><span>Veterans</span><span>Students who prefer texting</span></div></section>

<section class="pp-sec" id="what" aria-labelledby="what-h"><h2 id="what-h">What it does</h2><p class="sub">Six things a good advisor, a benefits navigator and a well-organized friend would do, all at once, by app or by text.</p>
<div class="pp-grid">${FEATURES.map(([ic, t, d]) => `<div class="pp-card">${ui.icon(ic, 26)}<h3>${ui.esc(t)}</h3><p>${ui.esc(d)}</p></div>`).join('')}</div></section>

<section class="pp-sec" aria-labelledby="how"><h2 id="how">How it works</h2><p class="sub">A small team of specialist agents behind one friendly voice, with every step a student can see.</p>
<ol class="pp-steps"><li><b>Tell it once</b><span>By text or in the app: your classes, your shifts, what is hard right now. Or forward the email and it reads it.</span></li><li><b>It plans and checks</b><span>The planner, money coach and help finder work from rules and verified sources, and a tone check makes sure every message is kind and has a next step.</span></li><li><b>You decide</b><span>Anything that would leave on your behalf waits for your yes on the exact words. Bookings are confirmed with the room system before it says they are done.</span></li></ol></section>

<section class="pp-sec" id="why" aria-labelledby="why-h"><h2 id="why-h">Why it works</h2><p class="sub">Students stop out over a few hundred dollars, a missed form or a bus that never came. Help exists for most of it; finding it, qualifying and doing the paperwork is the barrier. The Advocate removes the barrier, and earns trust by how it behaves.</p>
<div class="pp-grid">${PRINCIPLES.map(([t, d]) => `<div class="pp-card"><h3>${ui.esc(t)}</h3><p>${ui.esc(d)}</p></div>`).join('')}</div></section>

<section class="pp-sec" aria-labelledby="value"><h2 id="value">What it is worth</h2>
<div class="pp-value">
  <div class="pp-card"><h3>For students</h3><ul><li>Money they qualify for and were not getting, found in minutes</li><li>Time held for the work that matters, around shifts and child care</li><li>Fewer missed deadlines and fewer surprise bills</li><li>Help that comes to them, in their words, with no judgment</li></ul></div>
  <div class="pp-card"><h3>For colleges</h3><ul><li>A support layer that reaches every student, at night and on weekends</li><li>Outcome measures that never show a group smaller than five</li><li>Any college added with one file; local help kept fresh automatically</li><li>No model spend in the product; costs measured in cents</li></ul></div>
  <div class="pp-card"><h3>For the field</h3><ul><li>A complete, open reference built by AI under fixtures</li><li>Every block reusable, every test public, every decision recorded</li><li>Proof that zero-trust AI development produces software people can trust</li></ul></div>
</div></section>

<section class="pp-sec" id="try" aria-labelledby="try-h"><h2 id="try-h">Try it as one of twelve students</h2><p class="sub">Pick a student and you are signed in as them. Everything works: tap the buttons, book a room, draft a message, ask a question.</p>
<p class="pp-note">${l.live ? 'Each visitor gets a private copy of all twelve students for two hours. Nothing you do reaches anyone else, and nothing is sent anywhere real: the campus services are synthetic twins.' : 'These links open the live demonstration at zthr.ai/advocate, where each visitor gets a private copy of all twelve students for two hours. The campus services there are synthetic twins.'}</p>
<div class="pp-try">${students.map(([n, p]) => `<a href="${try_(n)}"><span class="nm"><span class="av" aria-hidden="true">${n[0]}</span>${ui.esc(n)} <span class="chip">${ui.esc(p.college)}</span></span><span class="ln">${ui.esc(p.line)}</span><span class="tr">${ui.esc(p.tries)}</span></a>`).join('')}</div>
<div class="pp-cta" style="margin-top:16px">${ui.button({ label: 'Try it by text instead', href: `${l.app}/text`, variant: 'quiet', icon: 'send' })}${ui.button({ label: 'Open the app admin', href: l.admin, variant: 'quiet', icon: 'you' })}</div></section>

<section class="pp-sec" aria-labelledby="built"><h2 id="built">Built by the ZTHR factory</h2><p class="sub">No person wrote this code. Agents built it inside fixtures that decide what is admitted: gates proven able to fail, intent locked in plain words, every button walked for every student. All of it is public.</p>
<div class="pp-built">
  <a href="https://zthr.ai/reference/case"><b>The case</b><span>What an AI factory can build, and what it is worth: the business and technical write-up</span></a>
  <a href="${l.factory}"><b>The factory console</b><span>Phases, guardrails, red team, walks, every test, mutation, cost</span></a>
  <a href="${l.docs}"><b>The documentation</b><span>Architecture, flows, data model, API, glossary, every diagram</span></a>
  <a href="${l.factoryPage('features')}"><b>Every feature</b><span>What it does, by phase, with the journey that proves it</span></a>
  <a href="${l.factoryPage('blocks')}"><b>The block library</b><span>Fifteen reusable parts, each with its own tests and mutation score</span></a>
  <a href="${l.factoryPage('sensitive')}"><b>Sensitive data trace</b><span>Where each personal fact may go, and where it actually went</span></a>
  <a href="${l.factoryPage('twins')}"><b>Campus twins</b><span>Dining, transit, rooms, jobs and class sites as synthetic APIs</span></a>
  <a href="https://github.com/russlittle/ZTHR/tree/reference-implementation"><b>The full source</b><span>The app, blocks, gates, pipeline and every journey card</span></a>
  <a href="https://github.com/russlittle/ZTHR/discussions"><b>Discuss it</b><span>Questions, experience reports and objections, in the open</span></a>
  <a href="https://zthr.ai"><b>ZTHR</b><span>The pattern language this was built with</span></a>
</div></section>
<footer class="pp-foot">Student Advocate is the reference application for ZTHR, a pattern language for software built by AI. ${ui.esc(NOT_AFFILIATED.body)} Code under the Apache License 2.0.</footer>
</main></div>`;
  return ui.bareShell({ title: 'Student Advocate', description: 'A team that works for every student: runs their day, finds money and help they qualify for, and does the legwork.', body, base: l.fontBase, head: `<style>${css}</style>${l.head ?? ''}` });
}

/** The app's own front door: pick a student and you are signed in as them, or start by text. */
export function startPage(l: Pick<ProductLinks, 'app' | 'admin' | 'fontBase'> & { product: string; reference: string; live: boolean }): string {
  const students = Object.entries(PERSONA_LINES);
  const body = `<div class="hero"><h1>Student Advocate</h1><p class="date">Pick a student and you are signed in as them. ${l.live ? 'You get a private copy of all twelve for two hours; nothing you do reaches anyone else.' : ''}</p></div>
<div class="tiles" role="list" aria-label="Sample students" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">${students.map(([n, p]) => `<div role="listitem"><a class="tile" href="${l.app}/s/${n.toLowerCase()}"><span style="display:flex;align-items:center;gap:8px">${ui.esc(n)} <span class="chip">${ui.esc(p.college)}</span></span><span class="small muted" style="font-weight:400">${ui.esc(p.line)}</span><span class="small" style="font-weight:400"><b>Try:</b> ${ui.esc(p.tries)}</span></a></div>`).join('')}</div>
${ui.actions([{ label: 'Try it by text', href: `${l.app}/text`, icon: 'send' }, { label: 'App admin', href: l.admin, variant: 'quiet', icon: 'you' }, { label: 'About the Advocate', href: l.product, variant: 'quiet', icon: 'home' }, { label: 'Reports and docs', href: l.reference, variant: 'quiet', icon: 'shield' }])}
<p class="small muted" style="margin-top:28px">${ui.esc(NOT_AFFILIATED.body)}</p>`;
  return ui.appShell({ title: 'Start · Student Advocate', body, base: l.fontBase, brand: 'Student Advocate', brandHref: `${l.app}/`, nav: [{ href: `${l.app}/`, label: 'Start', icon: 'today', current: true }, { href: `${l.app}/text`, label: 'Try by text', icon: 'send' }] });
}
