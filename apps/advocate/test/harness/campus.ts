import { routedEgress } from '@zthr/egress';
import { startAll } from '../../../campus-services/src/index.js';
import { Advocate } from '../../src/agents/advocate.js';
import { PERSONAS, PERSONA_NAMES } from '../../src/server/demo.js';

/**
 * Campus feeds for the walks. The walks are synchronous and never touch the network, so the operator runs once
 * here, against the synthetic campus services, and the walk seeds start from what it fetched: every campus feed,
 * plus Maria riding the bus from Salem Ave with her trips planned and live arrivals in hand.
 */
export interface SeedDoc {
  collection: string;
  id: string;
  studentId: string;
  json: string;
}

export const WALK_DAY = '2026-11-02';
export const WALK_NOW = `${WALK_DAY}T15:00:00Z`;

let cached: SeedDoc[] | undefined;

export async function campusSeedDocs(): Promise<SeedDoc[]> {
  if (cached) return cached;
  const a = new Advocate({ today: () => WALK_DAY, now: () => new Date(WALK_NOW), egress: routedEgress(startAll()) });
  for (const n of PERSONA_NAMES) PERSONAS[n]!(a);
  a.setCommute('maria', { mode: 'bus', homeStop: 'salem-catalpa' });
  await a.operator.tick();
  await a.operator.tick();
  const rows = a.store.db.prepare("SELECT collection, id, student_id AS studentId, json FROM docs WHERE collection IN ('campus_feeds', 'commute_plans', 'transit_now', 'household_plan') ORDER BY rowid").all() as unknown as SeedDoc[];
  cached = rows;
  return rows;
}

/** Put the shared feeds, and this student's own campus documents, into a fresh Advocate. */
export function applyCampus(a: Advocate, studentId: string, docs: SeedDoc[]): void {
  for (const d of docs) if (d.studentId === '_operator' || d.studentId === studentId) a.store.put(d.collection, d.id, d.studentId, JSON.parse(d.json));
}
