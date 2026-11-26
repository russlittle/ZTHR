/**
 * Journeys to add. One gauge per outcome is the least a release carries; software is only tested well by many
 * journeys, walked by every kind of person, through every way in, including the ones that try what must never
 * happen. Each suggestion here is worked out by rule from the datum and says which balloons it comes from. A
 * person adds it with one tap, and only then is it in the package; their own journeys go in beside them.
 */
import type { Ballooned } from './frame.ts';
import type { Prepared } from './pipeline.ts';
import { same } from './diff.ts';
import { outcomeGauges, type Gauge } from './release.ts';

export type JourneyKind = 'other side' | 'refusal' | 'take back' | 'first time' | 'returning' | 'by text' | 'low vision' | 'another language' | 'small phone' | 'missing input' | 'own';

export interface Suggestion {
  readonly id: string;
  readonly kind: JourneyKind;
  /** Why it is worth walking, in a sentence. */
  readonly why: string;
  readonly balloons: readonly number[];
  readonly card: Gauge;
  /** Walk these first: they prove what must never happen, and what other people can see. */
  readonly priority: 'first' | 'next';
}

export interface OwnJourney {
  readonly goal: string;
  readonly persona: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'journey';
const who = (s: Ballooned) => s.text.replace(/\s*\(.*\)$/, '').trim();
const singular = (p: string) => p.replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
const plain = (s: string) => s.replace(/^never:?\s*/i, '').replace(/^the person\b/i, 'someone');

export function suggestJourneys(p: Prepared): Suggestion[] {
  const base = outcomeGauges(p);
  const st = p.statements;
  const out: Suggestion[] = [];
  if (!base.length) return out;
  const first = base[0]!;
  const forbidden = first.forbidden.length ? first.forbidden : ['the person is shown anything that is not theirs'];
  const add = (kind: JourneyKind, why: string, balloons: number[], card: Partial<Gauge> & { goal: string; persona: string }, idHint: string) => {
    const id = slug(`${kind}-${idHint}`);
    if (out.some((x) => x.id === id || (x.kind === kind && x.kind === 'refusal' && same(x.card.goal, card.goal, 0.8))) || base.some((g) => g.id === id)) return;
    out.push({ id, kind, why, balloons, priority: kind === 'refusal' || kind === 'other side' || kind === 'take back' ? 'first' : 'next', card: { id, phase: 2, forbidden, budget: first.budget, requirements: first.requirements, modes: ['standard'], channels: ['app'], ...(first.delight ? { delight: first.delight } : {}), ...card } });
  };
  const outcomes = st.filter((s) => s.slot === 'outcome');

  // Everyone on the other side of an activity walks their own part, and only their part.
  for (const person of st.filter((s) => s.slot === 'people' && /other side/.test(s.text))) {
    const name = who(person);
    const rule = st.find((s) => s.slot === 'constraints' && s.text.toLowerCase().includes(singular(name.split(/[ ,]/)[0]!.toLowerCase())) && !/^never/i.test(s.text));
    add('other side', `${name} use it too. Their journey proves they can do their part and see no more than they should.`, [person.balloon, ...(rule ? [rule.balloon] : [])], { persona: singular(name), goal: rule ? `As ${name}: ${rule.text}` : `As ${name}, do their part in "${outcomes[0]?.text ?? first.goal}", and see nothing beyond it` }, name);
  }
  // Every thing that must never happen gets a journey that tries to make it happen, and must be refused.
  for (const n of st.filter((s) => s.slot === 'constraints' && /^never\b/i.test(s.text))) {
    const thing = plain(n.text);
    add('refusal', 'A forbidden outcome is only proven by a journey that tries to cause it and is refused.', [n.balloon], { phase: 3, persona: /\bstaff\b/i.test(thing) ? 'staff' : first.persona, goal: `Try to make this happen, and be refused plainly: ${thing}`, forbidden: [thing] }, thing);
  }
  // Anything a person can give, they can take back, and the taking back must hold at once.
  for (const t of st.filter((s) => /\b(withdraw|revoke|take back|turn .* off|stop)\b/i.test(s.text) && s.slot === 'constraints'))
    add('take back', 'Permission given must be just as easy to take back, and the change must hold everywhere at once.', [t.balloon], { phase: 3, persona: first.persona, goal: `Take it back, and see the change hold at once: ${t.text}` }, t.text);
  // The same outcome for someone new, and for someone who does it every week.
  for (const g of base) {
    const o = outcomes.find((x) => slug(x.text) === g.id);
    const b = o ? [o.balloon] : [];
    add('first time', 'Someone new needs to be walked through it; the journey proves they get there without help.', b, { persona: `${g.persona}, first time`, goal: `For the first time, with no help: ${g.goal}`, modes: ['walk-me-through'], budget: { actions: g.budget.actions + 3, ms: g.budget.ms } }, g.id);
    add('returning', 'Someone who does this often wants it fast; the journey holds it to fewer steps.', b, { persona: `${g.persona}, returning`, goal: `As someone who does this often, quickly: ${g.goal}`, modes: ['brief'], budget: { actions: Math.max(2, g.budget.actions - 2), ms: g.budget.ms } }, g.id);
  }
  // Anything that reaches people by message is walked by message too.
  const texts = st.find((s) => s.supplied.kind === 'derived' && s.supplied.rule === 'contacts-people');
  if (texts) for (const g of base) add('by text', 'It contacts people, so the journey is walked from the message as well as the app.', [texts.balloon], { persona: g.persona, goal: `From the message alone: ${g.goal}`, channels: ['text'] }, g.id);
  // The experience is part of the intent: the same outcome in low vision mode, in another language, on a small phone.
  for (const g of base.slice(0, 2)) {
    add('low vision', 'Low vision and high contrast are offered, so the outcome must be reachable with them on.', [], { persona: `${g.persona} with low vision`, goal: `With low vision mode and high contrast on: ${g.goal}` }, g.id);
    add('another language', 'The whole app can switch language; the outcome must hold in it, not only in English.', [], { persona: `${g.persona} who reads Spanish`, goal: `With the app in Spanish: ${g.goal}` }, g.id);
  }
  const phone = st.find((s) => s.supplied.kind === 'lexicon' && s.supplied.term === 'on a phone');
  if (phone) for (const g of base) add('small phone', 'You said it should work on a phone: walked one-handed on a 320-pixel screen over a slow connection.', [phone.balloon], { persona: `${g.persona} on a small phone`, goal: `One-handed, on a small phone, on a slow connection: ${g.goal}` }, g.id);
  // What it depends on will sometimes be missing or late; the person must be told plainly and nothing wrong may happen.
  for (const pre of st.filter((s) => s.slot === 'prerequisites'))
    add('missing input', 'What it depends on will sometimes be missing or late; the journey proves the person is told plainly and nothing wrong happens.', [pre.balloon], { phase: 3, persona: first.persona, goal: `Without this, or with it out of date, be told plainly and come to no harm: ${pre.text}` }, pre.text);
  return out;
}

/** The journeys in the package: one per outcome, every suggestion the person added, and their own. */
export function chosenJourneys(p: Prepared): { card: Gauge; from: Suggestion | null }[] {
  const all = suggestJourneys(p);
  const picked = all.filter((s) => p.journeys.accepted.includes(s.id)).map((s) => ({ card: s.card, from: s }));
  const base = outcomeGauges(p);
  const own = p.journeys.own
    .filter((j) => j.goal.trim().length >= 10)
    .map((j) => ({ card: { ...(base[0] ?? { phase: 1, forbidden: ['the person is shown anything that is not theirs'], budget: { actions: 5, ms: 10_000 }, requirements: [], modes: ['standard'], channels: ['app'] }), id: slug(`own-${j.goal}`), persona: j.persona.trim() || 'person', goal: j.goal.trim(), phase: 2 } as Gauge, from: null }));
  return [...picked, ...own];
}
