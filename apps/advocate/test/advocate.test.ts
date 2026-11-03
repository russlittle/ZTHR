// Verifies docs/agents.md
// Verifies docs/flows/text-onboarding.md
import { describe, expect, it } from 'vitest';
import { ConsentLedger } from '@zthr/runtime';
import { makeAdvocate, maria } from './helpers.js';

describe('start by text', () => {
  it('helps before any account exists and lands a money-found result in four answers', () => {
    const a = makeAdvocate();
    const phone = '+19375552002';
    expect(a.textIn(phone, 'hi')[0]).toMatch(/work for you, not your college/);
    a.textIn(phone, 'Sinclair 45402');
    a.textIn(phone, '3 people, $2000, I have a kid');
    const r = a.textIn(phone, '12 credits, 25 hours');
    expect(r[0]).toMatch(/qualify/);
    expect(a.findByPhone(phone)).toBeDefined();
    expect(a.sms.outbox.length).toBeGreaterThan(0);
  });
  it('routes crisis language before anything else, even before an account', () => {
    const a = makeAdvocate();
    expect(a.textIn('+19375552003', 'i want to kill myself')[0]).toMatch(/988/);
  });
  it('STOP ends contact', async () => {
    const a = makeAdvocate();
    const s = maria(a, { dial: { ...maria(makeAdvocate()).dial, channel: 'text' } });
    a.textIn(s.phone!, 'STOP');
    expect((await a.sms.send(s.phone!, '+1', 'hello')).status).toBe('refused');
  });
});

describe('the student sends', () => {
  it('nothing leaves without an approval token for the exact draft', async () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.crisis(s.id, 'utility-shutoff');
    const draft = a.drafts(s.id)[0]!;
    expect((await a.send(s.id, draft.id, undefined)).sent).toBe(false);
    expect(a.outboundLog).toHaveLength(0);
    const token = a.approve(s.id, draft.id);
    expect((await a.send(s.id, draft.id, token)).sent).toBe(true);
    expect((await a.send(s.id, draft.id, token)).sent).toBe(false);
    expect(a.outboundLog).toHaveLength(1);
  });
});

describe('control', () => {
  it('exports everything and deletes everything', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.addDocument(s.id, 'Photo ID', 'ID-CONTENT');
    a.addDeadline(s.id, { title: 'x', due: '2026-11-10', kind: 'other', source: { type: 'student' }, confirmed: true });
    const exp = a.exportData(s.id);
    expect(Object.keys(exp)).toEqual(expect.arrayContaining(['students', 'deadlines', 'vault', 'consent']));
    const del = a.deleteStudent(s.id);
    expect(del.remaining).toBe(0);
    expect(a.sealed.raw(s.id)).toBeUndefined();
    expect(ConsentLedger.verify(a.ledger.entries())).toEqual({ ok: true });
  });
  it('evidence carries no student identifiers or content', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.converse(s.id, 'I need food');
    const dump = JSON.stringify(a.evidence.events());
    expect(dump).not.toContain(s.id);
    expect(dump).not.toContain('Maria');
    expect(dump).not.toContain(s.phone!);
  });
  it('sealed facts open only for the playbook that declares them', () => {
    const a = makeAdvocate();
    const s = maria(a);
    a.seal(s.id, 'family_circumstances', 'estranged from parents');
    expect(() => a.grantToPlaybook(s.id, 'family_circumstances', 'snap-application')).toThrow(/does not declare/);
    a.grantToPlaybook(s.id, 'family_circumstances', 'fafsa-2027-28');
    expect(a.sealed.open(s.id, 'family_circumstances', 'playbook:fafsa-2027-28', 'aid office letter')).toMatch(/estranged/);
  });
});
