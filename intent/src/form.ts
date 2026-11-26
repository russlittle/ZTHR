/**
 * The questions as a page a person can answer in a few taps: radio buttons where the options are few, check
 * boxes where several can be true, a yes for a proposal, and "Other" everywhere, with typing only when nothing
 * can be offered. It works on a phone, meets WCAG 2.2 AA, and produces the answers file the read-back takes.
 */
import type { Question } from './frame.ts';
import type { Prepared } from './pipeline.ts';
import { ranked } from './readback.ts';
import { PROGRESS_CSS, progressHtml, stageOf } from './progress.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WHY: Record<Question['origin'], string> = {
  diff: 'The two readings of your words disagree here, and only you know which you meant.',
  completeness: 'A rule in your words has no answer for some case, so the factory would have to guess.',
  overlap: 'Two of your rules both claim the same case and say different things.',
  state: 'A step in the flow has no way out, no way in, or nobody who owns it.',
  pairing: 'One thing you said usually comes with another that has not been said.',
  marker: 'A word you used needs a number before anything can be checked against it.',
  missing: 'Nothing says this yet, and it changes what gets built.',
};

export function field(q: Question, n: number | string, nested = false): string {
  const id = `q${String(n).replace(/\W/g, '-')}`;
  const a = q.answer ?? { kind: 'text' as const };
  const name = esc(q.id);
  const hint = `<p class="hint" id="${id}-hint">It decides ${esc(q.protects)}.</p>${nested ? '' : `<details class="why"><summary>Why this is asked</summary><p>${WHY[q.origin]}${q.sourceOrigin ? ` It comes from line ${q.sourceOrigin.line} of ${esc(q.sourceOrigin.path)}.` : ''}</p></details>`}`;
  const other = (type: 'radio' | 'checkbox') =>
    `<div class="opt other"><input type="${type}" id="${id}-o" name="${name}" value="__other__"><label for="${id}-o">Other</label><input type="text" class="other-text" aria-label="Other, in your words" data-for="${id}-o"></div>`;
  const branch = (opt: string, k: number) =>
    (q.follow?.[opt] ?? []).map((f, j) => `<div class="follow" data-when="${id}-${k}">${field(f, `${n}-${k}-${j}`, true)}</div>`).join('');
  let body: string;
  if (a.kind === 'confirm')
    body = `<blockquote>${esc(a.proposal)}</blockquote><div class="opt"><input type="radio" id="${id}-y" name="${name}" value="__yes__"><label for="${id}-y">Yes</label></div>${other('radio').replace('>Other<', '>Not quite<').replace('Other, in your words', 'Not quite: what would you say?')}`;
  else if (a.kind === 'text') body = `<textarea id="${id}-t" name="${name}" rows="2" aria-labelledby="${id}-legend" aria-describedby="${id}-hint"></textarea>`;
  else {
    const type = a.kind === 'single' ? 'radio' : 'checkbox';
    body =
      a.options
        .map((o, k) => {
          const rec = a.recommended === o;
          return `<div class="opt"><input type="${type}" id="${id}-${k}" name="${name}" value="${esc(o)}"${rec ? ' checked' : ''}><label for="${id}-${k}">${esc(o)}${rec ? ' <span class="rec">recommended</span>' : ''}</label></div>${branch(o, k)}`;
        })
        .join('') + other(type);
  }
  const any = (q.follow?.['__any__'] ?? []).map((f, j) => `<div class="follow" data-when-any="${id}">${field(f, `${n}-a-${j}`, true)}</div>`).join('');
  return `<fieldset class="${nested ? 'nested' : ''}" data-q="${id}" aria-describedby="${id}-hint"><legend id="${id}-legend">${nested ? '' : `<span class="n">${n}.</span> `}${esc(q.text)}</legend>${hint}${body}</fieldset>${any}`;
}

export function questionsPage(p: Prepared, budget = 5): string {
  const { ask, held } = ranked(p.questions, budget);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A few questions: ${esc(p.model.title)}</title>
<style>
:root[data-theme=dark] { --ink:#e8ecf2; --muted:#b4bccb; --line:#3b4452; --field:#8a94a5; --bg:#14181e; --card:#1b2028; --accent:#8db8f0; --focus:#f0a35e; }
:root, :root[data-theme=light] { --ink:#1d2430; --muted:#4a5565; --line:#c9cfd8; --field:#6b7585; --bg:#fbfbf8; --card:#fff; --accent:#1f5fae; --focus:#b8530b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { --ink:#e8ecf2; --muted:#b4bccb; --line:#3b4452; --field:#8a94a5; --bg:#14181e; --card:#1b2028; --accent:#8db8f0; --focus:#f0a35e; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font: 1.0625rem/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 .5rem; }
.end { color: var(--muted); margin: 0 0 1.5rem; }
fieldset { border: 1px solid var(--line); border-radius: .5rem; background: var(--card); margin: 0 0 1rem; padding: 1rem; }
legend { font-weight: 600; padding: 0 .25rem; }
.n { color: var(--muted); }
.hint { color: var(--muted); font-size: .9375rem; margin: .25rem 0 .75rem; }
blockquote { margin: 0 0 .75rem; padding: .5rem .75rem; border-left: 3px solid var(--accent); }
.opt { display: flex; align-items: center; gap: .625rem; min-height: 2.75rem; flex-wrap: wrap; }
.opt input[type=radio], .opt input[type=checkbox] { width: 1.375rem; height: 1.375rem; margin: 0; accent-color: var(--accent); flex: none; }
.opt label { flex: 1; min-width: 8rem; padding: .375rem 0; cursor: pointer; }
.other-text, textarea { flex-basis: 100%; font: inherit; color: inherit; background: transparent; border: 1px solid var(--field); border-radius: .375rem; padding: .5rem .625rem; min-height: 2.75rem; }
textarea { width: 100%; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
button { font: inherit; font-weight: 600; min-height: 2.75rem; padding: .5rem 1.25rem; border-radius: .375rem; border: 0; background: var(--accent); color: var(--bg); cursor: pointer; }
output { display: block; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .875rem; margin-top: 1rem; }
.held { color: var(--muted); }${PROGRESS_CSS}
.rec { font-size: .8125rem; font-weight: 600; color: var(--accent); margin-left: .375rem; }
.follow { margin: .25rem 0 .75rem 2rem; }
.js .follow[hidden] { display: none; }
fieldset.nested { margin: .5rem 0 0; border-style: dashed; }
@media (prefers-reduced-motion: no-preference) { button { transition: filter .15s; } button:hover { filter: brightness(1.1); } }
</style>
</head>
<body>
<main>
${progressHtml(stageOf(p))}
<h1>A few questions before building ${esc(p.model.title)}</h1>
${p.model.end ? `<p class="end">To what end: ${esc(p.model.end)}</p>` : ''}
<form id="answers">
${ask.map((q, i) => field(q, i + 1)).join('\n')}
${held ? `<p class="held">${held} smaller question${held === 1 ? '' : 's'} can wait until these are answered.</p>` : ''}
<button type="button" id="done">Save my answers</button>
<p id="status" role="status"></p>
<output id="result"></output>
</form>
</main>
<script>
(function () {
  document.documentElement.classList.add('js');
  var form = document.getElementById('answers');
  // A branch opens only when its option is chosen; without script every branch simply shows.
  function sync() {
    form.querySelectorAll('.follow[data-when]').forEach(function (f) { var on = document.getElementById(f.getAttribute('data-when')); f.hidden = !(on && on.checked); });
    form.querySelectorAll('.follow[data-when-any]').forEach(function (f) { var fs = form.querySelector('fieldset[data-q="' + f.getAttribute('data-when-any') + '"]'); f.hidden = !(fs && fs.querySelector(':scope > .opt input:checked')); });
  }
  form.addEventListener('change', sync);
  sync();
  form.addEventListener('input', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('other-text') && t.value) document.getElementById(t.getAttribute('data-for')).checked = true;
  });
  document.getElementById('done').addEventListener('click', function () {
    var out = {};
    form.querySelectorAll('fieldset').forEach(function (fs) {
      if (fs.closest('.follow[hidden]')) return;
      var inputs = fs.querySelectorAll(':scope > .opt input[type=radio]:checked, :scope > .opt input[type=checkbox]:checked');
      var area = fs.querySelector(':scope > textarea');
      var name = (fs.querySelector(':scope > .opt [name], :scope > textarea') || {}).name;
      if (!name) return;
      var a = {};
      var picks = [];
      inputs.forEach(function (i) {
        if (i.value === '__yes__') a.yes = true;
        else if (i.value === '__other__') { var txt = fs.querySelector(':scope > .opt .other-text').value.trim(); if (txt) a.other = txt; }
        else picks.push(i.value);
      });
      if (area && area.value.trim()) a.other = area.value.trim();
      if (picks.length) { if (fs.querySelector(':scope > .opt input[type=checkbox]')) a.picks = picks; else a.pick = picks[0]; }
      if (Object.keys(a).length) out[name] = a;
    });
    var json = JSON.stringify(out, null, 2);
    var result = document.getElementById('result');
    var status = document.getElementById('status');
    result.textContent = json;
    // Copy where the browser allows it, and save a file where it allows that; the answers stay on the page either way.
    try {
      navigator.clipboard.writeText(json).then(function () { status.textContent = 'Your answers are copied. Paste them back to continue.'; }, function () { status.textContent = 'Select the answers below and copy them.'; });
    } catch (e) { status.textContent = 'Select the answers below and copy them.'; }
    try {
      var link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      link.download = 'answers.json';
      link.click();
    } catch (e) {}
  });
})();
</script>
</body>
</html>
`;
}
