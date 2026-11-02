import { describe, expect, it } from 'vitest';
import { EvidenceStore, costSummary, distribution, intentCompletion, revisionRate } from '@zthr/evidence';

describe('evidence store', () => {
  it('is append-only', () => {
    const s = new EvidenceStore();
    s.append('candidate', 'c1', { outcome: 'accepted' });
    s.recordModelCall({ provider: 'p', model: 'm', purpose: 'gen', inputTokens: 1, outputTokens: 1 });
    expect(() => s.db.exec("UPDATE events SET kind = 'x'")).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM model_calls')).toThrow(/append-only/);
  });

  it('computes intent completion from the latest run per journey', () => {
    const s = new EvidenceStore();
    s.append('journey_run', 'j1', { journey: 'j1', persona: 'maria', status: 'fail' });
    s.append('journey_run', 'j1', { journey: 'j1', persona: 'maria', status: 'pass' });
    s.append('journey_run', 'j2', { journey: 'j2', persona: 'ana', status: 'unknown' });
    const ic = intentCompletion(s);
    expect(ic.numerator).toBe(1);
    expect(ic.denominator).toBe(2);
    expect(ic.byPersona.maria?.value).toBe(1);
    expect(ic.byPersona.ana?.value).toBe(0);
  });

  it('reports not measured rather than zero', () => {
    expect(intentCompletion(new EvidenceStore()).value).toBeUndefined();
    expect(revisionRate(new EvidenceStore()).value).toBeUndefined();
  });

  it('prices tokens as paid and at today', () => {
    const s = new EvidenceStore();
    s.setPrice({ model: 'm', effectiveFrom: '2026-01-01', inputPerMTok: 10, outputPerMTok: 20 });
    s.setPrice({ model: 'm', effectiveFrom: '2026-06-01', inputPerMTok: 5, outputPerMTok: 10 });
    s.recordModelCall({ at: '2026-03-01T00:00:00Z', provider: 'p', model: 'm', purpose: 'gen', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const c = costSummary(s);
    expect(c.asPaid).toBeCloseTo(30);
    expect(c.atToday).toBeCloseTo(15);
  });

  it('unpriced calls make cost unknown, not zero', () => {
    const s = new EvidenceStore();
    s.recordModelCall({ provider: 'p', model: 'unpriced', purpose: 'gen', inputTokens: 10, outputTokens: 10 });
    const c = costSummary(s);
    expect(c.asPaid).toBeUndefined();
    expect(c.unpricedModels).toEqual(['unpriced']);
  });

  it('distributions report median and tail', () => {
    expect(distribution([1, 2, 3, 4, 100])).toMatchObject({ n: 5, median: 3 });
    expect(distribution([]).median).toBeUndefined();
  });
});
