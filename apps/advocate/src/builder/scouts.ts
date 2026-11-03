import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Resource } from '../catalog/types.js';

/**
 * Scouts keep the catalog true. Each scout covers one geography and need area,
 * re-reads its sources of record, and dates what still verifies. A scout whose
 * precision falls below its declared datum retires itself and holds its entries
 * for review (PRD section on scouts; ZTHR Patterns 12 and 27).
 */
export const ScoutDef = z.object({
  scout: z.string().regex(/^[a-z0-9-]+$/),
  geography: z.object({ county: z.string().optional(), college: z.string().optional(), national: z.boolean().optional() }),
  needs: z.array(z.string()).min(1),
  sources: z.array(z.object({ url: z.string().url(), kind: z.enum(['agency', 'college', 'directory', 'news']) })).min(1, 'a scout needs at least one source of record'),
  entries: z.array(z.string()).default([]),
  freshness_days: z.number().int().positive(),
  datum: z.object({ precision_min: z.number().min(0).max(1) }),
  owner: z.string(),
  /** Who admitted it: the factory, when every check passed. Only destructive changes go to a listed person. */
  admitted_by: z.enum(['factory', 'person']),
});
export type ScoutDef = z.infer<typeof ScoutDef>;

export function loadScouts(dir: string): ScoutDef[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ScoutDef.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}

/** What a source of record says about an entry today. In production a fetch; in tests a twin. */
export type SourceCheck = (entry: Resource) => Promise<'confirmed' | 'changed' | 'gone' | 'unreachable'>;

export interface ScoutRun {
  scout: string;
  checked: number;
  confirmed: string[];
  changed: string[];
  gone: string[];
  unreachable: string[];
  precision: number | undefined;
  status: 'active' | 'retired';
  reason: string;
}

/**
 * Precision is the share of entries the scout had marked available that its
 * sources still confirm. Unreachable sources are unknown: they neither count
 * as confirmed nor as wrong, and the entry goes stale on its own window.
 */
export async function runScout(def: ScoutDef, catalog: Resource[], check: SourceCheck, today: string): Promise<{ run: ScoutRun; catalog: Resource[] }> {
  const mine = catalog.filter((r) => def.entries.includes(r.id));
  const run: ScoutRun = { scout: def.scout, checked: 0, confirmed: [], changed: [], gone: [], unreachable: [], precision: undefined, status: 'active', reason: '' };
  const updated = new Map<string, Resource>();
  for (const r of mine) {
    const result = await check(r);
    run.checked += 1;
    run[result === 'confirmed' ? 'confirmed' : result === 'changed' ? 'changed' : result === 'gone' ? 'gone' : 'unreachable'].push(r.id);
    if (result === 'confirmed') updated.set(r.id, { ...r, verifiedOn: today });
    // A changed or gone entry is held back: its verification date is left as is, so it ages out instead of being offered.
  }
  const decided = run.confirmed.length + run.changed.length + run.gone.length;
  run.precision = decided === 0 ? undefined : run.confirmed.length / decided;
  if (run.precision !== undefined && run.precision < def.datum.precision_min) {
    run.status = 'retired';
    run.reason = `precision ${(run.precision * 100).toFixed(0)}% below the declared ${(def.datum.precision_min * 100).toFixed(0)}%; entries held for review`;
    // Retirement holds every entry this scout owns: none is refreshed.
    return { run, catalog };
  }
  run.reason = run.precision === undefined ? 'no source answered; nothing refreshed' : `${run.confirmed.length} confirmed, ${run.changed.length + run.gone.length} held for review`;
  return { run, catalog: catalog.map((r) => updated.get(r.id) ?? r) };
}
