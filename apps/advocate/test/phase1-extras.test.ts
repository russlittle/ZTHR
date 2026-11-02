import { describe, expect, it } from 'vitest';
import { checkTone } from '../src/domain/tone.js';
import { makeAdvocate, maria } from './helpers.js';

describe('pulses', () => {
  it('asks one optional question at a time, at most every few days, and every answer returns value', () => {
    const a = makeAdvocate();
    const s = maria(a);
    const q = a.pulse(s.id)!;
    expect(q.text).toMatch(/skip/);
    expect(a.pulse(s.id)).toBeUndefined(); // not again the same day
    const need = a.answerPulse(s.id, 'ride', 'no');
    expect(need.text).toMatch(/transportation help/);
    const fine = a.answerPulse(s.id, 'food', 'no');
    expect(fine.nextSteps.length).toBeGreaterThan(0);
    for (const m of [q, need, fine]) expect(checkTone(m, 'standard', 8).ok).toBe(true);
  });
  it('a yes or no by text answers the pending pulse', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.deliver(a.pulse(s.id)!, { force: true });
    const r = a.converse(s.id, 'no');
    expect(r[0]!.text).toMatch(/transportation/);
  });
  it('turning pulses off stops them', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.setPulses(s.id, { off: true });
    expect(a.pulse(s.id)).toBeUndefined();
  });
});

describe('coursework boundaries and help', () => {
  it('refuses to do coursework and offers the plan and people instead', () => {
    const a = makeAdvocate();
    const s = maria(a);
    const r = a.converse(s.id, 'can you write my essay for ENG 1101');
    expect(r[0]!.text).toMatch(/can't do the assignment itself/);
  });
  it('lines up help for a paper and states the course AI policy', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.uploadSyllabus(s.id, 'ENG 1101', 'ChatGPT and other AI tools are prohibited.\nNov 6 Essay 2 due', '2026-08-24');
    const d = a.deadlines(s.id)[0]!;
    const m = a.assignmentHelp(s.id, d.id);
    expect(m.text).toMatch(/writing center/);
    expect(m.text).toMatch(/does not allow AI help/);
    expect(checkTone(m, 'standard', 8).ok).toBe(true);
  });
});

describe('sharing, adult confirmation, aid timing', () => {
  it('shares the Advocate or a single resource as a ready text', () => {
    const a = makeAdvocate();
    const s = maria(a);
    expect(a.shareText(s.id).text).toMatch(/free/);
    expect(a.shareText(s.id, 'house-of-bread').smsLink).toMatch(/^sms:/);
  });
  it('text onboarding records the adult confirmation in the consent ledger', () => {
    const a = makeAdvocate();
    a.textIn('+19375553003', 'hi');
    a.textIn('+19375553003', 'Sinclair 45402');
    const s = a.findByPhone('+19375553003')!;
    expect(a.ledger.entries(s.id).some((e) => e.subject === 'terms' && e.detail.confirmedAdult === true)).toBe(true);
  });
  it('flags books needed before aid arrives', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.setAidDisbursement(s.id, '2026-11-20');
    const [b] = a.books(s.id, [{ course: 'BIO 1111', title: 'Biology', neededBy: '2026-11-04' }]);
    expect(b!.beforeAid).toBe(true);
  });
});
