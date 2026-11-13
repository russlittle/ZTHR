// Verifies docs/flows/resource-guide.md
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Advocate } from '../src/agents/advocate.js';
import { ACTIONS } from '../src/agents/actions.js';
import { find, remindable } from '../src/guide/barriers.js';
import { BARRIER } from '../src/guide/taxonomy.js';
import { PULSES } from '../src/domain/pulses.js';
import type { NeedCategory } from '../src/domain/types.js';
import { maria } from './helpers.js';

/**
 * Model-based simulation: weeks of a student's life with the guide, as random sequences of what a student does
 * (raise a need, answer a check-in, say "not yet", "not today" or "it is sorted out", text something, say whether a
 * resource helped, let days pass). After every step the real Advocate is compared with a model that holds only the
 * promises: which needs are open, which are paused for today, and what the student has said. Any difference, any
 * message the tone rubric holds, any reply with no next step, or more than three signals fails the run, and
 * fast-check shrinks the sequence to the shortest one that still fails.
 */
const NEEDS: NeedCategory[] = ['emergency', 'housing', 'food', 'utilities', 'transportation', 'goods', 'documents', 'belonging', 'career', 'wellbeing'];
const SAID = ['I have nowhere to sleep tonight', "I'm hungry", 'my lights are getting shut off', 'I need a winter coat', 'I lost my ID', 'I feel really alone here', 'I need a job', 'is there a free gym', 'hi', 'what is today'];
const PHRASE_NEED: Record<string, NeedCategory | undefined> = { 'I have nowhere to sleep tonight': 'emergency' };

interface Model {
  open: Map<NeedCategory, { paused?: string }>;
  resolved: Set<NeedCategory>;
  day: number;
}
interface Real {
  a: Advocate;
  sid: string;
  setDay: (d: number) => void;
}
const dateOf = (d: number) => new Date(Date.parse('2026-11-02T12:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);

function check(m: Model, r: Real) {
  const book = r.a.barriers(r.sid);
  const today = dateOf(m.day);
  for (const [need, st] of m.open) {
    const b = find(book, need);
    expect(b?.status, `${need} should be open`).not.toBe('resolved');
    expect(b, `${need} should exist`).toBeTruthy();
    if (st.paused === today) expect(remindable(b!, today), `${need} is paused today`).toBe(false);
  }
  for (const need of m.resolved) if (!m.open.has(need)) expect(find(book, need)?.status, `${need} should be resolved`).toBe('resolved');
  const sig = r.a.signals(r.sid);
  expect(sig.length).toBeLessThanOrEqual(3);
  for (const s of sig) expect(m.open.has(s.need), `signal for ${s.need}, which is not open`).toBe(true);
  for (const s of sig) expect(m.open.get(s.need)?.paused, `signal for ${s.need}, paused today`).not.toBe(today);
  const held = r.a.messages(r.sid).filter((x) => x.status === 'held');
  expect(held.map((h) => `${h.text.slice(0, 60)} :: ${h.holdReason}`)).toEqual([]);
  const plan = r.a.carePlan(r.sid);
  expect(plan.map((p) => p.barrier.need).sort()).toEqual([...m.open.keys()].sort());
}

const open = (need: NeedCategory): fc.Command<Model, Real> => ({
  check: () => true,
  run: (m, r) => {
    r.a.openBarrier(r.sid, need, 'student');
    m.open.set(need, m.open.get(need) ?? {});
    m.resolved.delete(need);
    check(m, r);
  },
  toString: () => `open(${need})`,
});
const resolve = (need: NeedCategory): fc.Command<Model, Real> => ({
  check: (m) => m.open.has(need),
  run: (m, r) => {
    ACTIONS.barrier!(r.a, r.sid, `resolve:${need}`);
    m.open.delete(need);
    m.resolved.add(need);
    check(m, r);
  },
  toString: () => `resolve(${need})`,
});
const notToday = (need: NeedCategory): fc.Command<Model, Real> => ({
  check: (m) => m.open.has(need),
  run: (m, r) => {
    ACTIONS.barrier!(r.a, r.sid, `not-today:${need}`);
    m.open.set(need, { paused: dateOf(m.day) });
    check(m, r);
  },
  toString: () => `notToday(${need})`,
});
const notYet = (need: NeedCategory): fc.Command<Model, Real> => ({
  check: (m) => m.open.has(need),
  run: (m, r) => {
    const reply = ACTIONS['barrier-still']!(r.a, r.sid, need).message;
    expect(reply.text.length).toBeGreaterThan(10);
    check(m, r);
  },
  toString: () => `notYet(${need})`,
});
const pulse = (yes: boolean): fc.Command<Model, Real> => ({
  check: () => true,
  run: (m, r) => {
    const q = r.a.pulse(r.sid);
    if (q) {
      const due = /sorted out/.test(q.text) ? (q.nextSteps[0]!.action.split(':')[2] as NeedCategory) : undefined;
      r.a.converse(r.sid, yes ? 'yes' : 'no');
      if (due && yes) {
        m.open.delete(due);
        m.resolved.add(due);
      } else if (!due) {
        const pending = PULSES.find((p) => q.text.startsWith(p.question));
        if (pending && (yes ? 'yes' : 'no') === pending.needOn) {
          m.open.set(pending.need, m.open.get(pending.need) ?? {});
          m.resolved.delete(pending.need);
        }
      }
    }
    check(m, r);
  },
  toString: () => `pulse(${yes ? 'yes' : 'no'})`,
});
const say = (text: string): fc.Command<Model, Real> => ({
  check: () => true,
  run: (m, r) => {
    const [reply] = r.a.converse(r.sid, text);
    expect(reply, text).toBeTruthy();
    expect(reply!.urgency === 'safety' || reply!.nextSteps.length > 0, `a reply to "${text}" with no next step`).toBe(true);
    const n = PHRASE_NEED[text];
    if (n) {
      m.open.set(n, m.open.get(n) ?? {});
      m.resolved.delete(n);
    }
    check(m, r);
  },
  toString: () => `say(${JSON.stringify(text)})`,
});
const feedback = (rid: string, o: 'helped' | 'did-not-help' | 'could-not-reach'): fc.Command<Model, Real> => ({
  check: () => true,
  run: (m, r) => {
    r.a.resourceFeedback(r.sid, rid, o);
    expect(r.a.resourceRecord(rid).tried).toBeLessThanOrEqual(1);
    check(m, r);
  },
  toString: () => `feedback(${rid}, ${o})`,
});
const pass = (days: number): fc.Command<Model, Real> => ({
  check: () => true,
  run: (m, r) => {
    m.day += days;
    r.setDay(m.day);
    check(m, r);
  },
  toString: () => `pass(${days}d)`,
});

const need = fc.constantFrom(...NEEDS);
const commands = [
  need.map(open),
  need.map(resolve),
  need.map(notToday),
  need.map(notYet),
  fc.boolean().map(pulse),
  fc.constantFrom(...SAID).map(say),
  fc.tuple(fc.constantFrom('daybreak', 'house-of-bread', 'ohio-state-id'), fc.constantFrom('helped' as const, 'did-not-help' as const, 'could-not-reach' as const)).map(([a, b]) => feedback(a, b)),
  fc.integer({ min: 1, max: 9 }).map(pass),
];

describe('weeks of a student\'s life with the guide match the model of its promises', () => {
  it('for random sequences of up to 40 steps', () => {
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 40 }), (cmds) => {
        let day = 0;
        const a = new Advocate({ today: () => dateOf(day), now: () => new Date(`${dateOf(day)}T15:00:00Z`) });
        const s = maria(a);
        const model: Model = { open: new Map(), resolved: new Set(), day: 0 };
        fc.modelRun(() => ({ model, real: { a, sid: s.id, setDay: (d) => (day = d) } }), cmds);
      }),
      // Each run is a whole sequence of up to 40 steps, so the nightly run is capped well below other generated tests.
      { numRuns: Math.min(400, Number(process.env.FUZZ_RUNS ?? 150)) },
    );
  }, 300_000);

  it('the model knows every barrier it uses', () => {
    for (const n of NEEDS) expect(BARRIER[n], n).toBeDefined();
  });
});
