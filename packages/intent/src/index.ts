import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { contentHash, type Verdict, fail, pass, unknown } from '@zthr/gates';

/**
 * Intent as the primary datum (Patterns 15 to 18). A journey card states a
 * user's goal, the outcomes that must never happen, and an action budget. Cards
 * are locked by hash: the change being judged cannot edit the goal it is judged by.
 */
export const JourneyCard = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  persona: z.string(),
  delight: z.string().optional(),
  phase: z.number().int().min(1).max(4),
  goal: z.string().min(10),
  forbidden: z.array(z.string()).min(1),
  budget: z.object({ actions: z.number().int().positive(), ms: z.number().int().positive().default(10_000) }),
  requirements: z.array(z.string()).default([]),
  modes: z.array(z.enum(['brief', 'standard', 'walk-me-through'])).default(['standard']),
  channels: z.array(z.enum(['app', 'text'])).default(['app']),
});
export type JourneyCard = z.infer<typeof JourneyCard>;

export function loadCards(dir: string): JourneyCard[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => JourneyCard.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}

export const cardHash = (c: JourneyCard): string => contentHash(c);

export interface Lock {
  cards: Record<string, string>;
}

export interface JourneyContext {
  card: JourneyCard;
  mode: JourneyCard['modes'][number];
  channel: JourneyCard['channels'][number];
  /** Count an action against the budget. Drivers call this for every user-visible step. */
  act(label: string): void;
  expect(condition: boolean, message: string): void;
  /** Report a forbidden outcome check. `occurred` true fails the journey. The label must be on the card. */
  forbid(label: string, occurred: boolean, detail?: string): void;
}

export type JourneyImpl<App> = (app: App, ctx: JourneyContext) => Promise<void>;

class JourneyFailure extends Error {}

export interface JourneyRun {
  journey: string;
  persona: string;
  delight?: string;
  phase: number;
  mode: string;
  channel: string;
  status: Verdict['status'];
  reason: string;
  actions: number;
  ms: number;
}

export async function runJourney<App>(
  card: JourneyCard,
  impl: JourneyImpl<App> | undefined,
  makeApp: () => Promise<App> | App,
  lock: Lock,
  mode: JourneyCard['modes'][number],
  channel: JourneyCard['channels'][number],
): Promise<JourneyRun> {
  const base = { journey: card.id, persona: card.persona, delight: card.delight, phase: card.phase, mode, channel };
  if (lock.cards[card.id] !== cardHash(card)) {
    return { ...base, status: 'unknown', reason: 'card is not locked at its current content', actions: 0, ms: 0 };
  }
  if (!impl) return { ...base, status: 'unknown', reason: 'no implementation for this journey', actions: 0, ms: 0 };

  let actions = 0;
  const checked = new Set<string>();
  const ctx: JourneyContext = {
    card,
    mode,
    channel,
    act: () => {
      actions += 1;
      if (actions > card.budget.actions) throw new JourneyFailure(`action budget of ${card.budget.actions} exceeded`);
    },
    expect: (cond, message) => {
      if (!cond) throw new JourneyFailure(`expectation failed: ${message}`);
    },
    forbid: (label, occurred, detail) => {
      if (!card.forbidden.includes(label)) throw new JourneyFailure(`forbidden outcome "${label}" is not on the locked card`);
      checked.add(label);
      if (occurred) throw new JourneyFailure(`forbidden outcome occurred: ${label}${detail ? ` (${detail})` : ''}`);
    },
  };
  const started = Date.now();
  try {
    const app = await makeApp();
    await Promise.race([
      impl(app, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new JourneyFailure(`time budget of ${card.budget.ms}ms exceeded`)), card.budget.ms)),
    ]);
  } catch (e) {
    const status = e instanceof JourneyFailure ? 'fail' : 'unknown';
    return { ...base, status, reason: (e as Error).message, actions, ms: Date.now() - started };
  }
  const unchecked = card.forbidden.filter((f) => !checked.has(f));
  if (unchecked.length > 0) {
    return { ...base, status: 'unknown', reason: `forbidden outcomes never checked: ${unchecked.join('; ')}`, actions, ms: Date.now() - started };
  }
  return { ...base, status: 'pass', reason: 'goal met; no forbidden outcome occurred', actions, ms: Date.now() - started };
}

export function lockVerdict(cards: JourneyCard[], lock: Lock): Verdict {
  const unlocked = cards.filter((c) => lock.cards[c.id] !== cardHash(c)).map((c) => c.id);
  const orphaned = Object.keys(lock.cards).filter((id) => !cards.some((c) => c.id === id));
  if (orphaned.length > 0) return fail('journey-lock', `locked journeys were removed: ${orphaned.join(', ')}`);
  if (unlocked.length > 0) return unknown('journey-lock', `cards changed without a recorded lock change: ${unlocked.join(', ')}`);
  return pass('journey-lock', `${cards.length} cards locked`);
}
