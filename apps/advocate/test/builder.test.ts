// Verifies docs/agents.md
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { EvidenceStore } from '@zthr/evidence';
import { propose } from '../src/builder/builder.js';
import { loadScouts, runScout, ScoutDef, type SourceCheck } from '../src/builder/scouts.js';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import { loadPlaybooks, PlaybookDef } from '../src/playbooks/engine.js';
import { makeAdvocate } from './helpers.js';

const CONTROL = fileURLToPath(new URL('../../../control', import.meta.url));

describe('the builder', () => {
  const demand = (need: string, n: number, zip = '45402') => {
    const a = makeAdvocate();
    for (let i = 0; i < n; i++) a.findHelp(a.createStudent({ chosenName: `S${i}`, zip, enrollment: { college: 'sinclair' } }).id, need as never);
    return a.evidence;
  };
  const opts = { today: '2026-11-02', existingScouts: [], existingPlaybooks: [] };

  it('does nothing below the threshold, so one request never spawns an agent', () => {
    expect(propose(demand('caregiving', 2), opts)).toHaveLength(0);
  });
  it('drafts a scout with a journey card and falsification case once demand crosses the threshold', () => {
    const [p] = propose(demand('caregiving', 3), opts);
    expect(p).toMatchObject({ kind: 'scout', status: 'certified' });
    expect(p!.journey).toBeDefined();
    expect(p!.falsification).toBeDefined();
  });
  it('leaves a draft unresolved when it has no source of record', () => {
    const [p] = propose(demand('career', 3), opts);
    expect(p!.status).toBe('unresolved');
    expect(p!.checks.find((c) => !c.ok)?.detail).toMatch(/source of record/);
  });
  it('does not duplicate a scout that already covers the need', () => {
    expect(propose(demand('caregiving', 3), { ...opts, existingScouts: [{ geography: { county: 'Montgomery' }, needs: ['caregiving'] }] })).toHaveLength(0);
  });
  it('retires a question that almost never reveals a need', () => {
    const ev = new EvidenceStore();
    for (let i = 0; i < 40; i++) ev.append('pulse', 'x', { pulse: 'phone', event: 'answered', revealedNeed: false });
    expect(propose(ev, opts)[0]).toMatchObject({ kind: 'retire-pulse', status: 'certified' });
  });
  it('every declared scout and playbook in the control plane parses', () => {
    for (const s of loadScouts(`${CONTROL}/scouts`)) expect(ScoutDef.safeParse(s).success).toBe(true);
    for (const p of loadPlaybooks(`${CONTROL}/playbooks`).values()) expect(PlaybookDef.safeParse(p).success).toBe(true);
  });
  it('every catalog entry is owned by a declared scout', () => {
    const owned = new Set(loadScouts(`${CONTROL}/scouts`).flatMap((s) => s.entries));
    expect(DAYTON_CATALOG.filter((r) => !owned.has(r.id)).map((r) => r.id)).toEqual([]);
  });
});

describe('scouts manage themselves', () => {
  const def = ScoutDef.parse({
    scout: 'test-scout', geography: { county: 'Montgomery' }, needs: ['food'], sources: [{ url: 'https://example.org', kind: 'directory' }],
    entries: ['house-of-bread', 'good-neighbor-house', 'css-choice-pantry', 'sinclair-food-pantry', 'foodbank-dayton'], freshness_days: 45, datum: { precision_min: 0.8 }, owner: 'builder', admitted_by: 'factory',
  });
  it('refreshes what its sources confirm and holds what changed', async () => {
    const check: SourceCheck = async (r) => (r.id === 'css-choice-pantry' ? 'changed' : 'confirmed');
    const { run, catalog } = await runScout(def, DAYTON_CATALOG, check, '2026-12-01');
    expect(run.status).toBe('active');
    expect(catalog.find((r) => r.id === 'house-of-bread')!.verifiedOn).toBe('2026-12-01');
    expect(catalog.find((r) => r.id === 'css-choice-pantry')!.verifiedOn).toBe('2026-11-02');
  });
  it('retires itself when precision falls below its datum, refreshing nothing', async () => {
    const check: SourceCheck = async (r) => (['house-of-bread', 'good-neighbor-house'].includes(r.id) ? 'gone' : 'confirmed');
    const { run, catalog } = await runScout(def, DAYTON_CATALOG, check, '2026-12-01');
    expect(run.status).toBe('retired');
    expect(run.precision).toBeCloseTo(0.6);
    expect(catalog.every((r) => r.verifiedOn === '2026-11-02')).toBe(true);
  });
  it('unreachable sources are unknown, not confirmations', async () => {
    const { run } = await runScout(def, DAYTON_CATALOG, async () => 'unreachable', '2026-12-01');
    expect(run.precision).toBeUndefined();
    expect(run.reason).toMatch(/no source answered/);
  });
});
