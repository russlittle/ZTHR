// Verifies docs/flows/careers.md
import { describe, expect, it } from 'vitest';
import { Advocate } from '../src/agents/advocate.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';
import { checkTone } from '../src/domain/tone.js';
import { careerText, fairChanceText } from '../src/domain/careers.js';

const fresh = (name: string) => {
  const a = new Advocate({ today: () => '2026-11-02' });
  return { a, sid: PERSONAS[name]!(a).id };
};

describe('career help', () => {
  for (const name of PERSONA_NAMES) {
    it(`${name}: asking about jobs points to their own college's free career help`, () => {
      const { a, sid } = fresh(name);
      const [m] = a.converse(sid, 'I am looking for a job');
      expect(m!.text).toMatch(/free help to find a job/);
      expect(m!.status).toBe('delivered');
    });
  }
  it('names Sinclair\'s office and number for a Sinclair student', () => expect(careerText(fresh('Maria').a.student('maria'))).toContain('937-512-2509'));
  it('reads plainly', () => {
    expect(checkTone({ text: careerText(fresh('Tyler').a.student('tyler')), nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' }, 'walk-me-through', 8, 'en').problems).toEqual([]);
    expect(checkTone({ text: fairChanceText(), nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' }, 'standard', 8, 'en').problems).toEqual([]);
  });
});

describe('fair-chance hiring, only when the student brings it up', () => {
  const ASKS = ['can I get a job with a felony', 'will a background check stop me from getting hired', 'I have a record, can I still work in healthcare', 'I got out of prison last year and need work'];
  for (const text of ASKS) {
    it(`"${text}" gets the CQE path`, () => {
      const { a, sid } = fresh('Tyler');
      expect(a.converse(sid, text)[0]!.text).toContain('CQE');
    });
  }
  it('is never offered from a sealed fact: Darnell asking about jobs gets general career help', () => {
    const { a, sid } = fresh('Darnell');
    const [m] = a.converse(sid, 'I am looking for a job');
    expect(m!.text).not.toMatch(/record|CQE|prison|conviction/i);
  });
  it('the sealed fact is never opened or shown, even when Darnell asks himself', () => {
    const { a, sid } = fresh('Darnell');
    const before = a.ledger.entries(sid).filter((e) => e.kind === 'open').length;
    const [m] = a.converse(sid, 'can I get a job with a felony');
    expect(m!.text).not.toContain('synthetic sealed fact');
    expect(a.ledger.entries(sid).filter((e) => e.kind === 'open').length).toBe(before);
  });
  it('saves nothing about the record', () => {
    const { a, sid } = fresh('Tyler');
    a.converse(sid, 'can I get a job with a felony');
    const stored = JSON.stringify(a.store.exportStudent(sid).students);
    expect(stored).not.toMatch(/felony|record/i);
  });
  it('offers the fair-chance path to everyone as a choice, without assuming', () => {
    const { a, sid } = fresh('Ana');
    const m = a.careerMessage(sid);
    expect(m.nextSteps.map((n) => n.label)).toContain('Jobs if you have a record');
  });
});
