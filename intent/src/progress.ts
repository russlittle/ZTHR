/**
 * Where the intent is in the process, worked out from the state of the work, never stored separately:
 * rough intent, read, questions, read-back, signed, released.
 */
import type { Prepared } from './pipeline.ts';

export const STAGES = [
  { key: 'rough', label: 'Rough intent', doing: 'Your words are in.' },
  { key: 'read', label: 'Read', doing: 'Two independent readings are compared.' },
  { key: 'questions', label: 'Questions', doing: 'A few quick answers settle what the readings and checks left open.' },
  { key: 'readback', label: 'Read-back', doing: 'Check the drawing: what will be built, statement by statement.' },
  { key: 'signed', label: 'Signed', doing: 'You have signed the drawing as what you mean. Release it to issue the package.' },
  { key: 'released', label: 'Released', doing: 'The package is issued for the factory to build to.' },
] as const;
export type Stage = (typeof STAGES)[number]['key'];

export function stageOf(p: Prepared, released = false, signed = false): Stage {
  if (released) return 'released';
  if (signed) return 'signed';
  if (p.unread.length) return 'read';
  if (p.questions.length) return 'questions';
  return 'readback';
}

/** A text line for the drawing. */
export function progressLine(stage: Stage): string {
  const i = STAGES.findIndex((s) => s.key === stage);
  return `Step ${i + 1} of ${STAGES.length}: ${STAGES[i]!.label}. ${STAGES[i]!.doing}\n\n${STAGES.map((s, k) => (k < i ? `~~${s.label}~~` : k === i ? `**${s.label}**` : s.label)).join(' → ')}`;
}

/** An accessible stepper: a list with the current step marked, and one fill that moves to it on load. */
export function progressHtml(stage: Stage): string {
  const i = STAGES.findIndex((s) => s.key === stage);
  const pct = Math.round((i / (STAGES.length - 1)) * 100);
  return `<nav class="steps" aria-label="Where this intent is">
<div class="track" aria-hidden="true"><div class="fill" style="--to:${pct}%"></div></div>
<ol>${STAGES.map((s, k) => `<li class="${k < i ? 'done' : k === i ? 'now' : 'next'}"${k === i ? ' aria-current="step"' : ''}><span class="dot" aria-hidden="true">${k < i ? '✓' : k + 1}</span><span class="name">${s.label}</span>${k < i ? '<span class="sr"> (done)</span>' : ''}</li>`).join('')}</ol>
<p class="doing">Step ${i + 1} of ${STAGES.length}: ${STAGES[i]!.doing}</p>
</nav>`;
}

export const PROGRESS_CSS = `
.steps { margin: 0 0 1.5rem; }
.steps ol { list-style: none; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: .25rem; margin: 0; padding: 0; position: relative; }
.steps li { display: grid; justify-items: center; gap: .25rem; text-align: center; font-size: .8125rem; color: var(--muted); }
.steps .dot { width: 1.75rem; height: 1.75rem; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: .8125rem; border: 2px solid var(--field); background: var(--card); color: var(--muted); position: relative; z-index: 1; }
.steps li.done .dot { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.steps li.now .dot { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
.steps li.now .name { color: var(--ink); font-weight: 600; }
.steps .track { position: relative; height: 2px; background: var(--line); margin: 0 8.33%; top: calc(.875rem + 1px); }
.steps .fill { position: absolute; inset: 0 auto 0 0; width: var(--to); background: var(--accent); }
.steps .doing { margin: .75rem 0 0; font-weight: 600; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 30rem) { .steps .name { font-size: .6875rem; } }
@media (prefers-reduced-motion: no-preference) { .steps .fill { animation: fill .9s ease-out both; } @keyframes fill { from { width: 0; } to { width: var(--to); } } }
`;
