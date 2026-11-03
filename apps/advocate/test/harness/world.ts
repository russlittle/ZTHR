// Verifies docs/testing/exploration.md (the exhaustive walk of every button, in app and text).
import { applyCampus, type SeedDoc } from './campus.js';
import { explore, exploreAsync, hash, type ExploreReport, type ExploreSpec, type Step } from '@zthr/explore';
import { Advocate } from '../../src/agents/advocate.js';
import type { ActionResult } from '../../src/agents/actions.js';
import { PERSONAS, PERSONA_NAMES } from '../../src/server/demo.js';
import { checkTone } from '../../src/domain/tone.js';
import type { NeedCategory } from '../../src/domain/types.js';

/**
 * The Advocate as an explorable world. One seed per demonstration student. From any state, the student can tap
 * any button on the last message, use the app's navigation, or type one of the things students actually type
 * (including a number to pick an option by text). The explorer runs that to a fixpoint and checks the
 * invariants below after every single step.
 */
export const DAY = '2026-11-02';

export interface World {
  a: Advocate;
  sid: string;
  deleted?: boolean;
  /** The seed's first Advocate, kept so thawed copies share its options and keys. */
  root?: Advocate;
}

export type Outcome = { via: 'tap'; result: ActionResult } | { via: 'text'; replies: { text: string; nextSteps: { action: string }[] }[] };

/** What the app's navigation and screens always offer, whatever the last message said. */
export const NAV = ['today', 'screen', 'find-help', 'week', 'settings', 'review-deadlines', 'add-shifts', 'upload-syllabus', 'show-draft'];
/** Settings are independent switches. They are explored on their own and as seed variants, not multiplied into every path. */
export const SETTINGS = ['pulses-on', 'pulses-off', 'dial:brief', 'dial:standard', 'dial:walk-me-through', 'source-on:calendar', 'source-off:calendar', 'source-on:forwarding', 'source-off:forwarding', 'source-on:learning-feed', 'source-off:learning-feed', 'source-on:location', 'source-off:location'];
const NEEDS: NeedCategory[] = ['food', 'housing', 'utilities', 'money', 'transportation', 'phone-internet', 'childcare', 'legal', 'mental-health'];
const SITUATIONS = ['eviction', 'utility-shutoff', 'car', 'no-food', 'rent-short'];
export const HELP_SCREEN = [...NEEDS.map((n) => `need:${n}`), ...SITUATIONS.map((x) => `situation:${x}`), 'campus-food', 'free-food', 'study-spots', 'leave-by', 'jobs-fit', 'mentors'];

/** Things students type, including a number to pick from the last message's options. */
export const TYPED = ['today', 'plan', 'fafsa', 'I need food', 'what is a registrar', 'how do I sign a lease', 'can you write my essay', 'brief', 'walk me through', 'I work Tue 3pm-9pm', 'can you make me a meal plan', 'I am looking for a job', 'can I get a job with a felony', "what's open on campus", 'next bus', 'jobs that fit my week', 'explain this letter: FINAL NOTICE. Your electric service will be disconnected on 11/20/2026 unless $412.55 is paid.', '1', '2', '3', 'yes', 'no', 'asdf qwerty'];

export const IDEMPOTENT = new Set(['mark-done', 'confirm-deadlines', 'confirm-deadline', 'dismiss', 'source-on', 'source-off', 'dial', 'pulses-off', 'pulses-on', 'hold-block', 'calendar-steps', 'remind', 'remind-meeting']);

const ID = /(dl|hd|rm|dr|mt)_[0-9a-f]{8}/g;

/**
 * The abstract state: what changes what the student can do or will be told next. Exact state multiplies
 * independent features together (every combination of drafts, reminders and held times) and never reaches a
 * fixpoint; this abstraction keeps each feature's own progress (every deadline's status, every playbook's step,
 * whether a draft is waiting, whether a question is pending) and the buttons on screen, so every screen is
 * reached in every state that changes its behavior, and the walk ends.
 */
export function signature(w: World, last: Outcome | undefined): string {
  if (w.deleted) return 'deleted';
  const parts = stateParts(w);
  const next = last ? (last.via === 'tap' ? last.result.message.nextSteps.map((n) => n.action.replace(ID, '*')) : last.replies.flatMap((r) => r.nextSteps.map((n) => n.action.replace(ID, '*')))) : [];
  return hash(`${parts.join('\n')}\n--\n${next.join(',')}`);
}

export function stateParts(w: World): string[] {
  const a = w.a;
  const sid = w.sid;
  const s = a.student(sid);
  const store = a.store;
  const has = (c: string) => (store.list(c, sid).length ? 1 : 0);
  const parts = [
    `dial:${s.dial.depth}:${s.dial.channel}:${s.chosenName === 'there' ? 'unnamed' : 'named'}`,
    `deadlines:${a.deadlines(sid).map((d) => `${d.title}/${d.done ? 'done' : d.confirmed ? 'on' : 'unconfirmed'}`).sort().join(',')}`,
    // A playbook's step shows in the buttons on screen while the student is in it, so its progress is not
    // multiplied into every other feature's state (they do not interact).
    `runs:${store.list<{ status: string }>('playbook_runs', sid).filter((r) => r.status === 'done').length}`,
    `drafts:${a.drafts(sid).some((d) => d.status === 'shown') ? 'waiting' : 'none'}:${a.drafts(sid).some((d) => d.status === 'sent') ? 'sent' : ''}`,
    `holds:${has('holds')} reminders:${has('reminders')} shifts:${a.shifts(sid).length} dismissed:${has('dismissed')}`,
    `pulse:${a.pulseState(sid).off ? 'off' : 'on'}:${store.get('pulse_pending', sid) ? 'pending' : ''}`,
    `sources:${['calendar', 'forwarding', 'learning-feed', 'location'].filter((x) => a.hasSource(sid, x)).join(',')}`,
    `commute:${a.commuteSettings(sid).mode ?? ''}:${a.commuteSettings(sid).homeStop ? 'stop' : ''}`,
    `dispatches:${a.operator.dispatches(sid).map((d) => d.status).sort().join(',')}`,
  ];
  return parts;
}

export function perform(w: World, action: string): Outcome {
  if (action.startsWith('say:')) {
    const replies = w.a.converse(w.sid, action.slice(4));
    return { via: 'text', replies };
  }
  const r = w.a.perform(w.sid, action);
  if (!r) throw new Error(`dead end: no handler for ${action}`);
  if (r.view === 'deleted') w.deleted = true;
  else w.a.deliver(r.message, { force: true });
  return { via: 'tap', result: r };
}

export function actions(w: World, last: Outcome | undefined): string[] {
  if (w.deleted) return [];
  const fromLast = last ? (last.via === 'tap' ? last.result.message.nextSteps.map((n) => n.action) : last.replies.flatMap((r) => r.nextSteps.map((n) => n.action))) : [];
  return [...fromLast, ...NAV, ...HELP_SCREEN, ...TYPED.map((t) => `say:${t}`), 'delete-account'];
}

const CITIZENSHIP = /\b(citizen(ship)?|immigration|green card|visa status|undocumented|legal status)\b.*\?/i;

export function invariants(otherNames: string[], sealedValues: string[]) {
  return (w: World, step: Step<Outcome>): string[] => {
    const problems: string[] = [];
    if (w.deleted) {
      if (w.a.store.countFor(w.sid) !== 0) problems.push('delete left data behind');
      return problems;
    }
    const s = w.a.student(w.sid);
    const msgs = step.outcome.via === 'tap' ? [step.outcome.result.message] : step.outcome.replies;
    if (msgs.length === 0) problems.push('no reply at all');
    for (const m of msgs) {
      const full = { text: m.text, nextSteps: m.nextSteps as { label: string; action: string }[], urgency: ('urgency' in m ? m.urgency : 'routine') as 'routine' | 'safety' | 'time-sensitive' };
      if (full.urgency !== 'safety') {
        const tone = checkTone(full, s.dial.depth, s.dial.readingGrade, s.dial.language);
        if (!tone.ok) problems.push(`tone: ${tone.problems.join('; ')} :: ${m.text.slice(0, 120)}`);
      }
      if ('status' in m && (m as { status: string }).status === 'held') problems.push(`held by the tone gate: ${m.text.slice(0, 80)}`);
      if (CITIZENSHIP.test(m.text)) problems.push('asks about citizenship or immigration status');
      for (const v of sealedValues) if (m.text.includes(v)) problems.push('a sealed fact appeared in a message');
      for (const n of otherNames) if (new RegExp(`\\b${n}\\b`).test(m.text)) problems.push(`another student's name appeared: ${n}`);
      if (/still being built|not sure i got that/i.test(m.text) && step.action.startsWith('say:') === false) problems.push(`fallback reply to a button: ${step.action}`);
    }
    return problems;
  };
}

/** Idempotent buttons: tapping twice leaves the same state as tapping once. */
export function idempotency(w: World, step: Step<Outcome>): string[] {
  const verb = step.action.split(':')[0]!;
  if (w.deleted || !IDEMPOTENT.has(verb)) return [];
  const before = signature(w, step.outcome);
  w.a.perform(w.sid, step.action);
  const after = signature(w, step.outcome);
  return before === after ? [] : [`not idempotent: tapping ${verb} twice changed the state`];
}

/** Each student as seeded, and again at each other depth, so every path is walked at every depth. */
export function personaSeeds(only?: string[], depths: ('own' | 'brief' | 'standard' | 'walk-me-through')[] = ['own', 'brief', 'walk-me-through'], campus?: SeedDoc[]) {
  return PERSONA_NAMES
    .filter((n) => !only || only.includes(n))
    .flatMap((name) =>
      depths.map((depth) => ({
        name: depth === 'own' ? name : `${name}/${depth}`,
        make: (): World => {
          const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`) });
          const s = PERSONAS[name]!(a);
          if (campus) applyCampus(a, s.id, campus);
          if (depth !== 'own') a.setDial(s.id, { depth });
          return { a, sid: s.id };
        },
      })),
    );
}

export function exploreAdvocate(opts: { only?: string[]; maxNodes?: number; withTyping?: boolean; campus?: SeedDoc[] } = {}): ExploreReport {
  return mergeReports(advocateSpecs(opts).map((sp) => explore(sp)));
}

/** The same walk, yielding to the event loop as it goes (for test runners). */
export async function exploreAdvocateAsync(opts: { only?: string[]; maxNodes?: number; withTyping?: boolean; campus?: SeedDoc[] } = {}): Promise<ExploreReport> {
  const out: ExploreReport[] = [];
  for (const sp of advocateSpecs(opts)) out.push(await exploreAsync(sp));
  return mergeReports(out);
}

function advocateSpecs(opts: { only?: string[]; maxNodes?: number; withTyping?: boolean; campus?: SeedDoc[] }): ExploreSpec<World, Outcome>[] {
  return personaSeeds(opts.only, undefined, opts.campus).map((seed) => {
    const others = PERSONA_NAMES.filter((n) => n !== seed.name.split('/')[0]);
    const check = invariants(others, ['synthetic sealed fact for the demonstration']);
    return {
      seeds: [seed],
      actions: (w: World, last: Outcome | undefined) => actions(w, last).filter((x) => opts.withTyping !== false || !x.startsWith('say:')),
      perform,
      signature,
      // Frozen states hold plain data plus the seed's first Advocate, whose options and keys every thaw reuses.
      freeze: (w: World) => ({ snap: w.a.snapshot(), sid: w.sid, deleted: w.deleted, root: w.root ?? w.a }),
      thaw: (f: unknown) => {
        const x = f as { snap: ReturnType<Advocate['snapshot']>; sid: string; deleted?: boolean; root: Advocate };
        return { a: x.root.restore(x.snap), sid: x.sid, deleted: x.deleted, root: x.root };
      },
      check: (w: World, step: Step<Outcome>) => [...check(w, step), ...idempotency(w, step)],
      maxNodes: opts.maxNodes ?? 20_000,
    };
  });
}

function mergeReports(reports: ExploreReport[]): ExploreReport {
  const merged: ExploreReport = { seeds: [], states: 0, transitions: 0, actionsSeen: [], verbsSeen: {}, violations: [], exhausted: true };
  for (const r of reports) {
    merged.seeds.push(...r.seeds);
    merged.states += r.states;
    merged.transitions += r.transitions;
    merged.violations.push(...r.violations);
    merged.exhausted &&= r.exhausted;
    for (const [k, v] of Object.entries(r.verbsSeen)) merged.verbsSeen[k] = (merged.verbsSeen[k] ?? 0) + v;
    merged.actionsSeen.push(...r.actionsSeen);
  }
  merged.actionsSeen = [...new Set(merged.actionsSeen)].sort();
  return merged;
}
