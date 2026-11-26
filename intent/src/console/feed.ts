/**
 * What the factory publishes about its latest build (factory/factory.json, written by the reference build from its
 * own evidence), and what the studio keeps about a person's intent in this browser. The console only reads both.
 * Anything the build did not measure arrives as null or "not measured" and is shown that way, never filled in.
 */
import { gauges, type Gauge } from '../release.ts';
import { prepare, type Given } from '../pipeline.ts';
import type { OwnJourney } from '../journeys.ts';

export type Status = 'pass' | 'fail' | 'not measured';

export interface Reading {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly of: number | null;
  readonly floor?: number | null;
  readonly unit?: string;
  readonly href: string;
}

export interface FeedJourney {
  readonly id: string;
  readonly persona: string;
  readonly goal: string;
  readonly phase: number;
  readonly modes: readonly string[];
  readonly channels: readonly string[];
  readonly status: string;
}

export interface Feed {
  readonly schema: 'zthr-factory/1';
  readonly app: { readonly name: string; readonly href: string; readonly evidence: string };
  readonly commit: string;
  readonly builtAt: string;
  readonly readings: readonly Reading[];
  readonly journeys: readonly FeedJourney[];
  readonly phases: readonly { n: number; name: string; certified: boolean | null; certifiedAt: string | null; features: readonly { name: string; what: string; status: string; journeys: readonly string[] }[] }[];
  readonly gates: readonly { id: string; protects: string; proof: 'valid' | 'invalid' | 'none' }[];
  readonly ratchets: readonly { id: string; floor: number; metric?: string; direction?: string }[];
}

export const FEED_URL = '/reference/factory/factory.json';
export const EVIDENCE = '/reference/factory';

export async function loadFeed(url = FEED_URL): Promise<Feed | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<Feed>;
    return d.schema === 'zthr-factory/1' && Array.isArray(d.journeys) ? (d as Feed) : null;
  } catch {
    return null;
  }
}

export const statusOf = (s: string): Status => (s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'not measured');

/** One intent on the control surface: what it means, the journeys that measure it, and how each one stands. */
export interface IntentRow {
  readonly id: string;
  readonly title: string;
  readonly end: string | null;
  readonly source: 'factory' | 'studio';
  readonly where: string;
  readonly note: string;
  readonly journeys: readonly { id: string; goal: string; persona: string; phase: number | null; modes: readonly string[]; channels: readonly string[]; status: Status; feature: string | null }[];
}

export function factoryIntent(f: Feed): IntentRow {
  const featureOf = (id: string) => f.phases.flatMap((p) => p.features).find((x) => x.journeys.includes(id))?.name ?? null;
  return {
    id: 'factory',
    title: f.app.name,
    end: null,
    source: 'factory',
    where: f.app.href,
    note: `Built by the factory at ${f.commit}`,
    journeys: f.journeys.map((j) => ({ id: j.id, goal: j.goal, persona: j.persona, phase: j.phase, modes: j.modes, channels: j.channels, status: statusOf(j.status), feature: featureOf(j.id) })),
  };
}

interface Saved {
  path?: string;
  words?: string;
  readings?: unknown[];
  answers?: Record<string, Given>;
  journeys?: { accepted: string[]; own: OwnJourney[] };
  releases?: { revision: number; ready: boolean; reason: string | null }[];
}

/** The intent the studio keeps in this browser, measured against whatever the factory has built of it. */
export function studioIntent(raw: string | null, f: Feed | null): IntentRow | null {
  if (!raw) return null;
  let s: Saved;
  try {
    s = JSON.parse(raw) as Saved;
  } catch {
    return null;
  }
  if (!s.words?.trim()) return null;
  const p = prepare({ files: [{ path: s.path ?? 'intent.md', text: s.words }], readings: s.readings ?? [], answers: s.answers ?? {}, ...(s.journeys ? { journeys: s.journeys } : {}) });
  const built = new Map((f?.journeys ?? []).map((j) => [j.id, statusOf(j.status)]));
  const last = s.releases?.at(-1);
  const gs: Gauge[] = gauges(p);
  return {
    id: 'studio',
    title: p.model.title && p.model.title !== s.path ? p.model.title : 'Your intent',
    end: p.model.end,
    source: 'studio',
    where: '/intent',
    note: last ? `Revision ${last.revision}, ${last.ready ? 'released' : 'a draft'}` : p.questions.length ? `${p.questions.length} redline${p.questions.length === 1 ? '' : 's'} open, not released` : 'Ready to release',
    journeys: gs.map((g) => ({ id: g.id, goal: g.goal, persona: g.persona, phase: g.phase, modes: g.modes, channels: g.channels, status: built.get(g.id) ?? 'not measured', feature: null })),
  };
}

export function tally(row: IntentRow): Record<Status, number> {
  const t: Record<Status, number> = { pass: 0, fail: 0, 'not measured': 0 };
  for (const j of row.journeys) t[j.status]++;
  return t;
}
