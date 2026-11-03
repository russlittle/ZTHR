// Verifies docs/flows/money.md
import { describe, expect, it } from 'vitest';
import { heap, lifeline, sinclairEmergencyGrant, snap } from '../src/eligibility/engine.js';
import { makeAdvocate, maria, TODAY } from './helpers.js';

describe('eligibility engine', () => {
  it('Maria likely qualifies for SNAP through the young-child and work exemptions, with an estimate', () => {
    const a = makeAdvocate();
    const r = snap(maria(a), TODAY);
    expect(r.status).toBe('likely');
    expect(r.estimatedMonthlyValue).toBeGreaterThan(0);
    expect(r.estimatedMonthlyValue).toBeLessThanOrEqual(808);
    expect(r.reasons.join(' ')).toMatch(/exemption/);
  });
  it('a full-time student with no exemption is unlikely, and is told why', () => {
    const a = makeAdvocate();
    const s = a.createStudent({ chosenName: 'P', zip: '45402', age: 20, household: { size: 1, monthlyGrossIncome: 600 }, enrollment: { college: 'sinclair', creditHours: 15, weeklyWorkHours: 5, workStudy: false } });
    const r = snap(s, TODAY);
    expect(r.status).toBe('unlikely');
    expect(r.reasons.join(' ')).toMatch(/exemption/);
  });
  it('missing facts produce needs-info, not a guess', () => {
    const a = makeAdvocate();
    const s = a.createStudent({ chosenName: 'Q', zip: '45402', household: { size: 1 }, enrollment: { college: 'sinclair' } });
    expect(snap(s, TODAY).status).toBe('needs-info');
    expect(lifeline(s, TODAY).status).toBe('needs-info');
  });
  it('a date outside every verified period is unconfirmed', () => {
    const a = makeAdvocate();
    expect(snap(maria(a), '2027-12-01').status).toBe('unconfirmed');
    expect(heap(maria(a), '2027-07-01').status).toBe('unconfirmed');
  });
  it('income limits follow the published tables', () => {
    const a = makeAdvocate();
    const over = a.createStudent({ chosenName: 'R', zip: '45402', household: { size: 1, monthlyGrossIncome: 1730 }, enrollment: { college: 'sinclair', creditHours: 3 } });
    expect(snap(over, TODAY).status).toBe('unlikely'); // limit $1,729 for one person
    const under = a.createStudent({ chosenName: 'S', zip: '45402', household: { size: 1, monthlyGrossIncome: 1729 }, enrollment: { college: 'sinclair', creditHours: 3 } });
    expect(snap(under, TODAY).status).toBe('likely');
    expect(heap(under, TODAY).status).toBe('likely'); // 1729*12 = 20,748 < 27,930
  });
  it('programs with status rules carry the note and never ask', () => {
    const a = makeAdvocate();
    expect(snap(maria(a), TODAY).statusRuleNote).toMatch(/never ask/);
  });
  it('Sinclair emergency grant follows its published criteria', () => {
    const a = makeAdvocate();
    expect(sinclairEmergencyGrant(maria(a)).status).toBe('likely');
    expect(sinclairEmergencyGrant(maria(a, { enrollment: { college: 'sinclair', creditHours: 4, degreeSeeking: true } })).status).toBe('unlikely');
    expect(sinclairEmergencyGrant(maria(a, { enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true } })).status).toBe('unlikely');
  });
});
