// Verifies docs/flows/resource-guide.md
// The barrier book, the help record and the signals at their edges: each event is written to the history by name,
// nothing changes a resolved barrier but the student reopening it, and every limit lands on the side the rule states.
import { describe, expect, it } from 'vitest';
import type { Resource } from '../src/catalog/types.js';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import * as B from '../src/guide/barriers.js';
import { helpScore, MIN_SHOWN, needsReview, OUTCOME_LABEL, OUTCOMES, recordLine, tally } from '../src/guide/feedback.js';
import { packageFor } from '../src/guide/packages.js';
import { MAX, signals } from '../src/guide/signals.js';

const D = '2026-11-02';
const events = (book: B.BarrierBook, need: Parameters<typeof B.find>[1]) => B.find(book, need)!.history.map((h) => `${h.on} ${h.event}`);

describe('barriers: each event by name, and a resolved barrier left alone', () => {
  it('opens, raises only upward, starts, resolves and reopens, writing each event', () => {
    let b = B.open(B.empty(), 'food', 'student', 'someday', D);
    expect(B.find(b, 'food')).toMatchObject({ need: 'food', openedBy: 'student', urgency: 'someday', status: 'open', openedOn: D });
    const same = B.open(b, 'food', 'student', 'someday', '2026-11-03');
    expect(same).toBe(b);
    b = B.open(b, 'food', 'check-in', 'soon', '2026-11-03');
    expect(B.open(b, 'food', 'check-in', 'someday', '2026-11-04')).toBe(b);
    b = B.open(b, 'food', 'check-in', 'tonight', '2026-11-04');
    expect(B.find(b, 'food')!.urgency).toBe('tonight');
    b = B.start(b, 'food', '2026-11-05');
    expect(B.start(b, 'food', '2026-11-06')).toBe(b);
    b = B.resolve(b, 'food', '2026-11-07');
    expect(B.find(b, 'food')).toMatchObject({ status: 'resolved', resolvedOn: '2026-11-07' });
    b = B.open(b, 'food', 'check-in', 'soon', '2026-11-09');
    expect(B.find(b, 'food')).toMatchObject({ status: 'open', openedBy: 'check-in', urgency: 'soon', openedOn: '2026-11-09', resolvedOn: undefined, quietUntil: undefined });
    expect(events(b, 'food')).toEqual(['2026-11-02 opened', '2026-11-03 raised', '2026-11-04 raised', '2026-11-05 started', '2026-11-07 resolved', '2026-11-09 reopened']);
  });

  it('nothing but reopening changes a resolved barrier', () => {
    const r = B.resolve(B.open(B.empty(), 'housing', 'student', 'soon', D), 'housing', D);
    expect(B.resolve(r, 'housing', '2026-11-03')).toBe(r);
    expect(B.notToday(r, 'housing', '2026-11-03')).toBe(r);
    expect(B.asked(r, 'housing', '2026-11-03')).toBe(r);
    expect(B.start(r, 'housing', '2026-11-03')).toBe(r);
    for (const f of [B.resolve, B.notToday, B.asked, B.start]) expect(f(B.empty(), 'housing', D)).toEqual(B.empty());
  });

  it('not today quiets it until tomorrow, across a month, and asking is recorded', () => {
    let b = B.open(B.empty(), 'health', 'student', 'soon', '2026-11-20');
    b = B.notToday(b, 'health', '2026-11-30');
    const h = B.find(b, 'health')!;
    expect(h.quietUntil).toBe('2026-12-01');
    expect(B.remindable(h, '2026-11-30')).toBe(false);
    expect(B.remindable(h, '2026-12-01')).toBe(true);
    b = B.asked(b, 'health', '2026-12-02');
    expect(B.find(b, 'health')!.lastAskedOn).toBe('2026-12-02');
    expect(events(b, 'health')).toEqual(['2026-11-20 opened', '2026-11-30 not-today', '2026-12-02 asked']);
    // A resolved barrier is never remindable, quiet or not; resolving also lifts any quiet.
    const done = B.find(B.resolve(b, 'health', '2026-12-03'), 'health')!;
    expect(done.quietUntil).toBeUndefined();
    expect(B.remindable(done, '2026-12-10')).toBe(false);
  });

  it('a week without a mention is due one question: at seven days, not six, from the last ask', () => {
    const b = B.open(B.empty(), 'money', 'student', 'soon', D);
    expect(B.dueForCheck(b, '2026-11-08')).toBeUndefined();
    expect(B.dueForCheck(b, '2026-11-09')?.need).toBe('money');
    const asked = B.asked(b, 'money', '2026-11-09');
    expect(B.dueForCheck(asked, '2026-11-15')).toBeUndefined();
    expect(B.dueForCheck(asked, '2026-11-16')?.need).toBe('money');
    expect(B.dueForCheck(b, '2026-11-05', 3)?.need).toBe('money');
    expect(B.dueForCheck(B.notToday(b, 'money', '2026-11-09'), '2026-11-09')).toBeUndefined();
  });

  it('active is most urgent first, then oldest first, and leaves out what is resolved', () => {
    let b = B.open(B.empty(), 'food', 'student', 'someday', '2026-11-01');
    b = B.open(b, 'housing', 'student', 'soon', '2026-11-03');
    b = B.open(b, 'health', 'student', 'soon', '2026-11-02');
    b = B.open(b, 'emergency', 'student', 'tonight', '2026-11-04');
    b = B.open(b, 'money', 'student', 'tonight', '2026-11-05');
    b = B.resolve(b, 'money', '2026-11-06');
    expect(B.active(b).map((x) => x.need)).toEqual(['emergency', 'health', 'housing', 'food']);
    expect(B.empty()).toEqual({ items: [] });
    expect(B.empty()).not.toBe(B.empty());
  });
});

describe('the help record at its edges', () => {
  it('names the three answers in the words a student sees', () => {
    expect(OUTCOMES).toEqual(['helped', 'did-not-help', 'could-not-reach']);
    expect(OUTCOME_LABEL).toEqual({ helped: 'It helped', 'did-not-help': 'I tried; it did not help', 'could-not-reach': 'I could not reach them' });
  });
  it('shows a record only from the fifth answer, and says who could not reach them only when some could not', () => {
    const four = tally(['helped', 'helped', 'did-not-help', 'could-not-reach']);
    expect(recordLine(four)).toBeUndefined();
    expect(recordLine(tally(['helped', 'helped', 'did-not-help', 'did-not-help', 'helped']))).toBe('Helped 3 of 5 students who tried it.');
    expect(recordLine(tally([...Array(MIN_SHOWN - 1).fill('helped'), 'could-not-reach']))).toBe('Helped 4 of 5 students who tried it; 1 could not reach them.');
  });
  it('ranks with a score pulled toward one half, and flags for review at ten tries under a quarter', () => {
    expect(helpScore({ helped: 0, tried: 0, unreachable: 0 })).toBe(0.5);
    expect(helpScore({ helped: 4, tried: 4, unreachable: 0 })).toBe(5 / 6);
    expect(needsReview({ helped: 0, tried: 9, unreachable: 0 })).toBe(false);
    expect(needsReview({ helped: 2, tried: 10, unreachable: 0 })).toBe(true);
    expect(needsReview({ helped: 3, tried: 12, unreachable: 0 })).toBe(false);
  });
});

describe('signals at their edges', () => {
  const base = DAYTON_CATALOG.find((r) => r.id === 'daybreak')!;
  const make = (id: string, over: Partial<Resource> = {}): Resource => ({ ...base, id, name: `Name ${id}`, description: `About ${id}.`, availability: [], ...over });
  const none = () => tally([]);

  it('orders by urgency across barriers and shows at most three', () => {
    let book = B.open(B.empty(), 'food', 'student', 'someday', D);
    book = B.open(book, 'housing', 'student', 'soon', D);
    book = B.open(book, 'health', 'student', 'someday', D);
    book = B.open(book, 'emergency', 'student', 'tonight', '2026-11-03');
    const s = signals({ book, today: '2026-11-03', optionsFor: (n) => [make(`r-${n}`)], record: none });
    expect(MAX).toBe(3);
    expect(s.map((x) => [x.need, x.urgency, x.title])).toEqual([
      ['emergency', 'tonight', 'Tonight: Name r-emergency'],
      ['housing', 'soon', 'Name r-housing'],
      ['food', 'someday', 'Name r-food'],
    ]);
    expect(s[1]!.why).toBe('For housing: About r-housing.');
  });

  it('a barrier with nothing current is a counted gap with 2-1-1', () => {
    const book = B.open(B.empty(), 'food', 'student', 'soon', D);
    const [g] = signals({ book, today: D, optionsFor: () => [], record: none });
    expect(g).toEqual({ need: 'food', urgency: 'soon', title: 'Food: call 2-1-1', why: 'I have no checked resource near you for this yet. 2-1-1 can help any time, and I have counted the gap.', gap: true });
  });

  it('picks by deadline, then the package order, then the record', () => {
    const book = B.open(B.empty(), 'emergency', 'student', 'soon', D);
    const pkg = packageFor('emergency')!;
    const [first, second] = pkg.entries;
    const pick = (opts: Resource[], record: (id: string) => ReturnType<typeof tally> = none) => signals({ book, today: D, optionsFor: () => opts, record })[0]!;
    expect(pick([make('outside'), make(second!), make(first!)]).resource!.id).toBe(first);
    expect(pick([make(first!), make('outside', { availability: [{ fact: 'applications-open', value: 'yes', source: 'https://x.org', checkedOn: D }] })]).resource!.id).toBe('outside');
    const rec = (id: string) => (id === 'b' ? tally(['helped', 'helped', 'helped']) : tally(['did-not-help']));
    expect(pick([make('a'), make('b')], rec).resource!.id).toBe('b');
    expect(pick([make(first!)]).packageId).toBe(pkg.id);
  });
});
