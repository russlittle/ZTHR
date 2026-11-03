// Verifies docs/blocks/intent.md
// Verifies docs/testing/journeys.md
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cardHash, loadCards, lockVerdict, runJourney } from '@zthr/intent';

const dir = fileURLToPath(new URL('./fixtures', import.meta.url));
const [card] = loadCards(dir);

describe('journeys', () => {
  it('an unlocked card is unknown', async () => {
    const r = await runJourney(card!, async () => {}, () => ({}), { cards: {} }, 'standard', 'app');
    expect(r.status).toBe('unknown');
    expect(lockVerdict([card!], { cards: {} }).status).toBe('unknown');
  });
  const lock = { cards: { [card!.id]: cardHash(card!) } };
  it('passes when the goal is met and every forbidden outcome is checked', async () => {
    const r = await runJourney(card!, async (_a, ctx) => { ctx.act('open'); ctx.expect(true, 'gap shown'); ctx.forbid('a message reports a problem without a next step', false); }, () => ({}), lock, 'standard', 'app');
    expect(r.status).toBe('pass');
  });
  it('fails when a forbidden outcome occurs', async () => {
    const r = await runJourney(card!, async (_a, ctx) => { ctx.forbid('a message reports a problem without a next step', true); }, () => ({}), lock, 'standard', 'app');
    expect(r.status).toBe('fail');
  });
  it('unknown when a forbidden outcome is never checked', async () => {
    const r = await runJourney(card!, async () => {}, () => ({}), lock, 'standard', 'app');
    expect(r.status).toBe('unknown');
  });
  it('fails when the action budget is exceeded', async () => {
    const r = await runJourney(card!, async (_a, ctx) => { for (let i = 0; i < 5; i++) ctx.act('click'); }, () => ({}), lock, 'standard', 'app');
    expect(r).toMatchObject({ status: 'fail' });
  });
  it('a removed locked journey fails the lock gate', () => {
    expect(lockVerdict([], lock).status).toBe('fail');
  });
});
