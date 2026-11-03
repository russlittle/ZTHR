// Verifies docs/blocks/runtime.md
// Verifies docs/flows/drafts-and-approval.md
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  ApprovalService, ConsentLedger, OutboundGate, SealedStore, crisisReply, decideContact, inQuietHours,
  mergeSecondCheck, refuseToStartUnless, sandwich, screen, type OutboundAction,
} from '@zthr/runtime';

const action: OutboundAction = { studentId: 's1', kind: 'email', recipient: 'landlord@example.com', content: { body: 'Can we set up a payment plan?' } };

describe('approval tokens', () => {
  const svc = new ApprovalService(randomBytes(32));
  it('admits exactly the approved action once', () => {
    const t = svc.issue(action);
    expect(svc.consume(t, action)).toEqual({ ok: true });
    expect(svc.consume(t, action)).toMatchObject({ ok: false, reason: 'token already used' });
  });
  it('refuses changed content, other recipients, other students and forgeries', () => {
    const t = svc.issue(action);
    expect(svc.consume(t, { ...action, content: { body: 'changed' } }).ok).toBe(false);
    expect(svc.consume(t, { ...action, recipient: 'someone@else' }).ok).toBe(false);
    expect(svc.consume(t, { ...action, studentId: 's2' }).ok).toBe(false);
    expect(svc.consume({ ...t, signature: '00'.repeat(32) }, action).ok).toBe(false);
  });
  it('refuses expired tokens', () => {
    const t = svc.issue(action, Date.now() - 60 * 60 * 1000);
    expect(svc.consume(t, action)).toMatchObject({ ok: false, reason: 'token expired' });
  });
  it('the outbound gate sends nothing without a token', async () => {
    const sent: OutboundAction[] = [];
    const gate = new OutboundGate(svc, async (a) => void sent.push(a));
    expect((await gate.dispatch(action, undefined)).sent).toBe(false);
    expect(sent).toHaveLength(0);
    expect((await gate.dispatch(action, svc.issue(action))).sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe('contact governor', () => {
  const prefs = { maxPerDay: 3, quietStart: '22:00', quietEnd: '08:00', timeZone: 'America/New_York' };
  it('holds routine messages in quiet hours but never safety messages', () => {
    const lateNight = new Date('2026-11-02T04:30:00Z'); // 11:30 pm Eastern on Nov 1
    expect(inQuietHours(prefs, lateNight)).toBe(true);
    expect(decideContact(prefs, lateNight, 0, 'routine').action).toBe('defer');
    expect(decideContact(prefs, lateNight, 0, 'safety').action).toBe('send');
  });
  it('enforces the daily limit for routine messages', () => {
    const noon = new Date('2026-11-02T17:00:00Z');
    expect(decideContact(prefs, noon, 3, 'routine').action).toBe('defer');
    expect(decideContact(prefs, noon, 3, 'time-sensitive').action).toBe('send');
  });
});

describe('safety router', () => {
  it.each([
    'I want to kill myself',
    "honestly i dont want to be alive anymore",
    'thinking about ending my life',
    'everyone would be better off without me',
    'I took too many pills, I think I overdosed',
    'my boyfriend hits me',
    'I am not safe at home',
  ])('routes: %s', (m) => expect(screen(m).crisis).toBe(true));
  it.each(['I killed it on my exam', 'this assignment is killing me lol', 'my rent is due Friday'])('does not route: %s', (m) =>
    expect(screen(m).crisis).toBe(false),
  );
  it('always names 988', () => expect(crisisReply(['self-harm'])).toMatch(/988/));
  it('a model can add a route but never remove one', () => {
    expect(mergeSecondCheck({ crisis: true, categories: ['self-harm'] }, false).crisis).toBe(true);
    expect(mergeSecondCheck({ crisis: false, categories: [] }, true).crisis).toBe(true);
  });
});

describe('sandwich and startup guard', () => {
  it('falls back when the model output fails the post-check', async () => {
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => 'bad', post: (o) => (o === 'good' ? { ok: true } : { ok: false, reason: 'not good' }), fallback: () => 'safe' }, 1);
    expect(r).toMatchObject({ output: 'safe', usedModel: false });
  });
  it('falls back when the model throws', async () => {
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => { throw new Error('down'); }, post: () => ({ ok: true }), fallback: () => 'safe' }, 1);
    expect(r.output).toBe('safe');
  });
  it('refuses to start misconfigured', () => {
    expect(() => refuseToStartUnless([{ name: 'secret', check: () => 'missing' }])).toThrow(/refusing to start/);
  });
});

describe('consent ledger and sealed store', () => {
  it('detects tampering', () => {
    const l = new ConsentLedger();
    l.append('s1', 'grant', 'calendar');
    l.append('s1', 'revoke', 'calendar');
    const entries = l.entries();
    expect(ConsentLedger.verify(entries)).toEqual({ ok: true });
    const tampered = entries.map((e, i) => (i === 0 ? { ...e, subject: 'email' } : e));
    expect(ConsentLedger.verify(tampered).ok).toBe(false);
    expect(ConsentLedger.verify(entries.slice(1)).ok).toBe(false);
  });
  it('seals facts, opens only for granted identities, and logs every opening', () => {
    const ledger = new ConsentLedger();
    const store = new SealedStore(randomBytes(32), ledger);
    store.seal('s1', 'veteran_status', 'yes');
    expect(JSON.stringify(store.raw('s1'))).not.toContain('"yes"');
    expect(() => store.open('s1', 'veteran_status', 'playbook:gi-bill', 'certify')).toThrow(/not granted/);
    store.grant('s1', 'veteran_status', 'playbook:gi-bill');
    expect(store.open('s1', 'veteran_status', 'playbook:gi-bill', 'certify')).toBe('yes');
    expect(() => store.open('s1', 'veteran_status', 'agent:chief-of-staff', 'curious')).toThrow(/not granted/);
    expect(ledger.entries('s1').filter((e) => e.kind === 'release')).toHaveLength(1);
  });
});
