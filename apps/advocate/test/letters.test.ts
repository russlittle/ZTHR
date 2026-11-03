// Verifies docs/flows/letters.md
import { describe, expect, it } from 'vitest';
import { EvidenceStore } from '@zthr/evidence';
import { MeteredModel, TwinModelClient } from '@zthr/models';
import { explainLetter, factsPreserved, letterText } from '../src/domain/letters.js';
import { checkTone } from '../src/domain/tone.js';
import { Advocate } from '../src/agents/advocate.js';
import { PERSONAS } from '../src/server/demo.js';

const DAY = '2026-11-02';

const LETTERS: { name: string; text: string; kind: string; dates: string[]; amounts?: number[]; phones?: string[]; urgent?: boolean }[] = [
  { name: 'utility shut-off', text: 'FINAL NOTICE\nYour electric service will be disconnected on 11/20/2026 unless $412.55 is paid. Call AES Ohio at 800-433-8500.', kind: 'utility-shutoff', dates: ['2026-11-20'], amounts: [412.55], phones: ['800-433-8500'], urgent: true },
  { name: 'eviction', text: 'NOTICE TO LEAVE THE PREMISES. You are hereby notified to vacate by November 12, 2026. Your landlord, Maple Court Apartments.', kind: 'eviction-notice', dates: ['2026-11-12'], urgent: true },
  { name: 'SNAP interview', text: 'Montgomery County Job and Family Services\nYour interview is scheduled for Nov 18 at 10:00 AM. Please call (937) 225-4148 if you cannot attend.', kind: 'benefit-recertification', dates: ['2026-11-18'], phones: ['(937) 225-4148'] },
  { name: 'aid verification', text: 'Dear student, your FAFSA has been selected for verification by the financial aid office. Please submit missing documents by 12/1/2026.', kind: 'aid-verification', dates: ['2026-12-01'] },
  { name: 'collections', text: 'This is an attempt to collect a debt. Our records show you owe $1,250.00 to Midwest Recovery. Pay by December 15, 2026.', kind: 'collections', dates: ['2026-12-15'], amounts: [1250] },
  { name: 'court summons', text: 'Dayton Municipal Court. Summons. You must appear for a hearing on November 30, 2026 at 9:00 AM.', kind: 'court', dates: ['2026-11-30'], urgent: true },
  { name: 'IRS', text: 'Internal Revenue Service. We need more information about your 2025 return. Respond by Jan 10, 2027.', kind: 'irs', dates: ['2027-01-10'] },
  { name: 'unknown', text: 'Hello, thank you for your purchase.', kind: 'other', dates: [] },
];

describe('the letter explainer reads what the letter says, and only that', () => {
  for (const L of LETTERS) {
    it(`${L.name}: kind, dates, amounts and phones`, () => {
      const l = explainLetter(L.text, DAY);
      expect(l.kind).toBe(L.kind);
      expect(l.dates.map((d) => d.date)).toEqual(L.dates);
      if (L.amounts) expect(l.amounts).toEqual(L.amounts);
      if (L.phones) expect(l.phones).toEqual(L.phones);
      expect(l.urgent).toBe(!!L.urgent);
    });
    it(`${L.name}: the explanation reads plainly and kindly`, () => {
      const t = checkTone({ text: letterText(explainLetter(L.text, DAY)), nextSteps: [{ label: 'x', action: 'x' }], urgency: 'routine' }, 'walk-me-through', 8, 'en');
      expect(t.problems).toEqual([]);
    });
  }
  it('labels each date by what it is for', () => {
    const l = explainLetter('Your interview is on 11/18/2026. Return the form by 11/25/2026. Hearing on 12/2/2026.', DAY);
    expect(l.dates.map((d) => d.label)).toEqual(['Interview', 'Due', 'Court date']);
  });
  it('drops dates already past', () => {
    expect(explainLetter('Your bill was due 10/1/2026 and the next is due 12/1/2026.', DAY).dates.map((d) => d.date)).toEqual(['2026-12-01']);
  });
  it('a date without a year is this year, or next year if already past', () => {
    expect(explainLetter('Respond by Jan 5.', DAY).dates[0]!.date).toBe('2027-01-05');
    expect(explainLetter('Respond by Dec 5.', DAY).dates[0]!.date).toBe('2026-12-05');
  });
  it('never calls the eviction a reason to leave today', () => {
    expect(letterText(explainLetter(LETTERS[1]!.text, DAY))).toMatch(/does not mean you have to leave today/);
  });
});

describe('in the Advocate', () => {
  const setup = () => {
    const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`) });
    return { a, sid: PERSONAS.Maria!(a).id };
  };
  it('a pasted letter is explained by text, with each date one tap from the calendar', () => {
    const { a, sid } = setup();
    const [m] = a.converse(sid, `explain this letter: ${LETTERS[0]!.text}`);
    expect(m!.text).toContain('utility company');
    const add = m!.nextSteps.find((n) => n.action.startsWith('add-date:'))!;
    a.perform(sid, add.action);
    expect(a.deadlines(sid).some((d) => d.due === '2026-11-20' && d.title === 'Shut-off date')).toBe(true);
  });
  it('a long letter pasted without asking is recognized as a letter', () => {
    const { a, sid } = setup();
    const long = `Dear Resident,\n${LETTERS[2]!.text}\n${'This notice concerns your case number 12345. '.repeat(6)}\nSincerely, Case Worker`;
    expect(a.converse(sid, long)[0]!.text).toContain('Job and Family Services');
  });
  it('drafts a question to the sender, sent only with approval', () => {
    const { a, sid } = setup();
    const m = a.letterMessage(sid, LETTERS[4]!.text);
    const r = a.perform(sid, m.nextSteps.find((n) => n.action.startsWith('draft:letter:'))!.action)!;
    expect(r.view).toBe('drafts');
    expect(a.drafts(sid).some((d) => d.status === 'shown' && d.to === 'a debt collector')).toBe(true);
  });
});

describe('the model rewrite, inside the deterministic sandwich', () => {
  const withModel = (respond: (plain: string) => string) => {
    const evidence = new EvidenceStore();
    const model = new MeteredModel(new TwinModelClient((req) => respond(req.messages[1]!.content)), evidence as never, [{ maxTokens: 100_000, key: () => 'letters' }]);
    const a = new Advocate({ today: () => DAY, now: () => new Date(`${DAY}T15:00:00Z`), model, evidence });
    return { a, sid: PERSONAS.Maria!(a).id, evidence };
  };
  it('keeps a rewrite that preserves every fact and reads plainly', async () => {
    const { a, sid } = withModel((plain) => `Here is the short version. ${plain.split('\n').slice(1).join(' ')}`);
    const r = await a.letterMessageWithModel(sid, LETTERS[0]!.text);
    expect(r.usedModel).toBe(true);
    expect(r.message.text).toContain('Here is the short version');
  });
  it('rejects a rewrite that drops a date, and falls back to the plain explanation', async () => {
    const { a, sid } = withModel(() => 'Your power might get shut off soon. Call them about $412.55 at 800-433-8500.');
    const r = await a.letterMessageWithModel(sid, LETTERS[0]!.text);
    expect(r.usedModel).toBe(false);
    expect(r.reason).toMatch(/dropped the date/);
    expect(r.message.text).toContain('Dates in the letter');
  });
  it('rejects a rewrite that invents an amount or a phone number', () => {
    const l = explainLetter(LETTERS[0]!.text, DAY);
    expect(factsPreserved(l, `${letterText(l)} You may also owe $99.`)).toMatchObject({ ok: false });
    expect(factsPreserved(l, `${letterText(l)} Or call 555-123-4567.`)).toMatchObject({ ok: false });
  });
  it('rejects a rewrite that scolds', async () => {
    const { a, sid } = withModel((plain) => `You should have paid this sooner. ${plain}`);
    const r = await a.letterMessageWithModel(sid, LETTERS[0]!.text);
    expect(r.usedModel).toBe(false);
    expect(r.reason).toMatch(/tone/);
  });
  it('never sends a letter with crisis words to a model', async () => {
    let called = false;
    const { a, sid } = withModel((plain) => ((called = true), plain));
    const r = await a.letterMessageWithModel(sid, `${LETTERS[1]!.text} I want to end my life.`);
    expect(called).toBe(false);
    expect(r.reason).toMatch(/crisis/);
  });
  it('falls back when the model errors', async () => {
    const { a, sid } = withModel(() => {
      throw new Error('provider down');
    });
    const r = await a.letterMessageWithModel(sid, LETTERS[2]!.text);
    expect(r.usedModel).toBe(false);
    expect(r.message.text).toContain('Job and Family Services');
  });
  it('every model call is metered in evidence', async () => {
    const { a, sid, evidence } = withModel((plain) => plain);
    await a.letterMessageWithModel(sid, LETTERS[3]!.text);
    expect((evidence.db.prepare('SELECT COUNT(*) AS n FROM model_calls').get() as { n: number }).n).toBeGreaterThan(0);
  });
});
