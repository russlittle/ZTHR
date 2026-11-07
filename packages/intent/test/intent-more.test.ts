// Verifies docs/blocks/intent.md
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JourneyCard, cardHash, loadCards, lockVerdict, runJourney, type Lock } from '../src/index.js';

const card = JourneyCard.parse({ id: 'pay-rent', persona: 'Maria', phase: 1, goal: 'Find rent help this week', forbidden: ['scolded', 'dead end'], budget: { actions: 3, ms: 200 } });
const locked: Lock = { cards: { 'pay-rent': cardHash(card) } };

describe('cards', () => {
  it('fill in defaults for modes, channels, requirements and time', () => {
    expect(card).toMatchObject({ modes: ['standard'], channels: ['app'], requirements: [], budget: { actions: 3, ms: 200 } });
    expect(JourneyCard.parse({ ...card, budget: { actions: 1 } }).budget.ms).toBe(10_000);
  });
  it('refuse bad ids, phases, short goals and no forbidden outcomes', () => {
    for (const bad of [{ id: 'Pay Rent' }, { phase: 10 }, { phase: 0 }, { goal: 'short' }, { forbidden: [] }, { budget: { actions: 0 } }]) expect(JourneyCard.safeParse({ ...card, ...bad }).success).toBe(false);
    expect(JourneyCard.safeParse({ ...card, phase: 5 }).success).toBe(true);
  });
  it('load sorted from a folder of YAML, ignoring other files', () => {
    const d = mkdtempSync(join(tmpdir(), 'cards-'));
    writeFileSync(join(d, 'b.yaml'), 'id: b-card\npersona: B\nphase: 2\ngoal: a goal of some length\nforbidden: [x]\nbudget: { actions: 2 }\n');
    writeFileSync(join(d, 'a.yaml'), 'id: a-card\npersona: A\nphase: 1\ngoal: a goal of some length\nforbidden: [y]\nbudget: { actions: 2 }\n');
    writeFileSync(join(d, 'notes.md'), 'not a card');
    expect(loadCards(d).map((c) => c.id)).toEqual(['a-card', 'b-card']);
  });
  it('hash changes with any content change', () => {
    expect(cardHash({ ...card, goal: 'Find rent help this month' })).not.toBe(cardHash(card));
    expect(cardHash({ ...card })).toBe(cardHash(card));
  });
});

describe('running a journey', () => {
  const ok = async (_: unknown, ctx: Parameters<NonNullable<Parameters<typeof runJourney>[1]>>[1]) => {
    ctx.act('open');
    ctx.expect(true, 'fine');
    ctx.forbid('scolded', false);
    ctx.forbid('dead end', false);
  };
  it('passes when the goal is met within budget and every forbidden outcome was checked', async () => {
    const r = await runJourney(card, ok, () => ({}), locked, 'standard', 'app');
    expect(r).toMatchObject({ journey: 'pay-rent', persona: 'Maria', phase: 1, mode: 'standard', channel: 'app', status: 'pass', reason: 'goal met; no forbidden outcome occurred', actions: 1 });
  });
  it('is unknown when the card is not locked at its content, or has no implementation', async () => {
    expect(await runJourney(card, ok, () => ({}), { cards: {} }, 'standard', 'app')).toMatchObject({ status: 'unknown', reason: 'card is not locked at its current content', actions: 0, ms: 0 });
    expect(await runJourney(card, undefined, () => ({}), locked, 'standard', 'app')).toMatchObject({ status: 'unknown', reason: 'no implementation for this journey' });
  });
  it('fails past the action budget, but not at it', async () => {
    const at = await runJourney(card, async (_a, c) => { c.act('1'); c.act('2'); c.act('3'); c.forbid('scolded', false); c.forbid('dead end', false); }, () => ({}), locked, 'standard', 'app');
    expect(at.status).toBe('pass');
    expect(at.actions).toBe(3);
    const over = await runJourney(card, async (_a, c) => { for (let i = 0; i < 4; i++) c.act(String(i)); }, () => ({}), locked, 'standard', 'app');
    expect(over).toMatchObject({ status: 'fail', reason: 'action budget of 3 exceeded', actions: 4 });
  });
  it('fails a broken expectation or a forbidden outcome that happened, with the detail', async () => {
    expect((await runJourney(card, async (_a, c) => c.expect(false, 'saw help'), () => ({}), locked, 'standard', 'app')).reason).toBe('expectation failed: saw help');
    expect((await runJourney(card, async (_a, c) => c.forbid('scolded', true, 'said overdue'), () => ({}), locked, 'standard', 'app')).reason).toBe('forbidden outcome occurred: scolded (said overdue)');
    expect((await runJourney(card, async (_a, c) => c.forbid('scolded', true), () => ({}), locked, 'standard', 'app')).reason).toBe('forbidden outcome occurred: scolded');
    expect((await runJourney(card, async (_a, c) => c.forbid('not on card', false), () => ({}), locked, 'standard', 'app')).reason).toBe('forbidden outcome "not on card" is not on the locked card');
  });
  it('fails past the time budget, and is unknown on a crash', async () => {
    const slow = await runJourney(card, () => new Promise((r) => setTimeout(r, 1000)), () => ({}), locked, 'standard', 'app');
    expect(slow).toMatchObject({ status: 'fail', reason: 'time budget of 200ms exceeded' });
    expect(await runJourney(card, async () => { throw new Error('crash'); }, () => ({}), locked, 'standard', 'app')).toMatchObject({ status: 'unknown', reason: 'crash' });
  });
  it('is unknown when a forbidden outcome was never checked', async () => {
    expect((await runJourney(card, async (_a, c) => c.forbid('scolded', false), () => ({}), locked, 'brief', 'text')).reason).toBe('forbidden outcomes never checked: dead end');
  });
});

describe('the lock', () => {
  const other = JourneyCard.parse({ ...card, id: 'other' });
  it('passes when every card is locked, counts them', () => expect(lockVerdict([card], locked)).toMatchObject({ status: 'pass', reason: '1 cards locked' }));
  it('is unknown for a changed card and fails for a removed one', () => {
    expect(lockVerdict([card, other], locked)).toMatchObject({ status: 'unknown', reason: 'cards changed without a recorded lock change: other' });
    expect(lockVerdict([], locked)).toMatchObject({ status: 'fail', reason: 'locked journeys were removed: pay-rent' });
  });
});
