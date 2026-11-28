/**
 * The read-back: what will be built, rendered from the prepared structure by fixed templates, in the person's
 * terms. No model writes a word of it, so what the person confirms is exactly what will be built.
 */
import { SLOTS, type Ballooned, type Consequence, type Question, type Slot } from './frame.ts';
import type { Prepared } from './pipeline.ts';
import { progressLine, stageOf } from './progress.ts';

const HEAD: Record<Slot, string> = {
  problem: 'The problem',
  why: 'Why it matters',
  outcome: 'When it works',
  people: 'Who it is for, and who else it reaches',
  measures: 'How everyone will know it worked',
  constraints: 'What it must do, and must never do',
  nonGoals: 'Left out on purpose',
  prerequisites: 'What it will also need',
  implications: 'What else this affects',
  assumptions: 'Taken as given',
};

const STATE: Record<Ballooned['state'], string> = { confirmed: 'yours', open: 'open', assumed: 'my reading, change it if wrong', default: 'a default' };

function source(s: Ballooned): string {
  switch (s.supplied.kind) {
    case 'person':
      return s.supplied.origin ? `${s.supplied.origin.path}:${s.supplied.origin.line}` : 'you';
    case 'parse':
      return `both readings (${s.supplied.families.join(', ')})`;
    case 'lexicon':
      return `from "${s.words ?? s.supplied.term}"`;
    case 'derived':
      return `follows from "${s.words ?? ''}"`;
    case 'part':
      return `from the ${s.supplied.part} part`;
  }
}

function line(s: Ballooned): string {
  const mark = s.mark ? ` **(${s.mark})**` : '';
  const tol = s.tolerance && s.tolerance !== 'exactly as stated' ? `, held to ${s.tolerance}` : '';
  return `- **[${s.balloon}]** ${s.text}${tol}${mark}. _${STATE[s.state]}; ${source(s)}_`;
}

const RANK: Record<Consequence, number> = { high: 0, medium: 1, low: 2 };

/** The questions worth asking now, most consequential first, within the budget; the rest are counted, not shown. */
export function ranked(questions: readonly Question[], budget: number): { ask: Question[]; held: number } {
  const sorted = [...questions].sort((a, b) => RANK[a.consequence] - RANK[b.consequence]);
  return { ask: sorted.slice(0, budget), held: Math.max(0, sorted.length - budget) };
}

export function readBack(p: Prepared, budget = 5): string {
  const out: string[] = [`# Read-back: ${p.model.title}`, '', progressLine(stageOf(p)), '', 'This is what will be built. Numbers in brackets stay with each statement, and the evidence will answer each one by number.', ''];

  out.push('## The end in mind', '', p.model.end ? p.model.end : '_Not stated yet. Every feature needs to know to what end it is built; see the first question below._', '');

  out.push('## Defaults for everything below', '');
  const changed = Object.entries(p.title).filter(([, e]) => e.from !== 'default');
  const kept = Object.entries(p.title).filter(([, e]) => e.from === 'default');
  for (const [k, e] of changed) out.push(`- **${k}**: ${e.value}${e.from === 'clash' ? '' : e.from === 'your choice' ? ', your choice' : `, because you said ${e.from}${e.replaces ? ` (instead of ${e.replaces.value})` : ''}`}`);
  if (kept.length) out.push(`- ${changed.length ? 'Unchanged' : 'All standard'}: ${kept.map(([k, e]) => `${k} ${e.value}`).join('; ')}`);
  out.push('');

  const feel = p.statements.filter((s) => s.supplied.kind === 'lexicon' && s.slot === 'constraints');
  if (feel.length) out.push('## How it should feel', '', ...feel.map(line), '');

  for (const slot of SLOTS) {
    const items = p.statements.filter((s) => s.slot === slot && !(s.supplied.kind === 'lexicon' && s.slot === 'constraints'));
    if (!items.length) continue;
    out.push(`## ${HEAD[slot]}`, '', ...items.map(line), '');
  }

  if (p.model.notes.length) {
    out.push('## Engineering notes: how, for now', '', 'These say how it is to be made, not what it must do. Changing one never changes the intent above.', '');
    for (const n of p.model.notes) out.push(`- ${n.text}${n.reason ? '' : ' _(no reason given)_'} _${n.stance === 'ideal' ? 'the ideal' : 'the practical choice now'}_`);
    out.push('');
  }
  if (p.model.variants.length) {
    out.push('## Variants, each authoritative where it applies', '');
    for (const v of p.model.variants) out.push(`- **${v.id}**: ${v.text}${v.effectivity ? `. _Applies to ${v.effectivity}._` : '. _Applies to: not stated._'}`);
    out.push('');
  }

  const marked = p.statements.filter((s) => s.mark);
  if (marked.length) out.push('## Needs a control before it ships', '', ...marked.map((s) => `- **[${s.balloon}]** ${s.mark}: ${s.text}`), '');

  const { ask, held } = ranked(p.questions, budget);
  if (ask.length) {
    out.push('## Before I can build, I need to know', '');
    const render = (q: Question, pad: string) => {
      const a = q.answer;
      if (!a || a.kind === 'text') out.push(`${pad}- Your answer: ______`);
      else if (a.kind === 'confirm') out.push(`${pad}> ${a.proposal}`, `${pad}- ( ) Yes`, `${pad}- ( ) Not quite: ______`);
      else {
        const box = a.kind === 'single' ? '( )' : '[ ]';
        for (const o of a.options) {
          out.push(`${pad}- ${box} ${o}${a.recommended === o ? ' _(recommended)_' : ''}`);
          for (const f of q.follow?.[o] ?? []) {
            out.push(`${pad}  - If so: ${f.text}`);
            render(f, `${pad}    `);
          }
        }
        out.push(`${pad}- ${box} Other: ______`);
      }
      for (const f of q.follow?.['__any__'] ?? []) {
        out.push(`${pad}- Then: ${f.text}`);
        render(f, `${pad}  `);
      }
    };
    ask.forEach((q, i) => {
      out.push(`${i + 1}. ${q.text} _It decides ${q.protects}._`);
      render(q, '   ');
    });
    if (held) out.push('', `${held} smaller question${held === 1 ? '' : 's'} can wait until these are answered.`);
    out.push('');
  }

  if (p.unread.length) out.push('## Not read yet', '', ...p.unread.map((u) => `- ${u}`), '');
  if (p.untied.length) out.push('## Your words not yet tied to anything', '', ...p.untied.map((u) => `- "${u}"`), '');
  return out.join('\n');
}
