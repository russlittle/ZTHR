// Verifies docs/blocks/runtime.md
// Verifies docs/flows/drafts-and-approval.md
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// Each rule below is worked by hand from docs/blocks/runtime.md; the expected text is the fixed text a student reads.
describe('crisis replies, word for word', () => {
  const opening = "I'm really glad you told me. You deserve support right now. You can call or text 988 any time to reach the Suicide & Crisis Lifeline, free and confidential.";
  const danger = 'If you are in immediate danger, call 911.';
  const hotline = 'The National Domestic Violence Hotline is 1-800-799-7233, or text START to 88788.';
  const close = "I'm here too. Would it help if I stayed with you while you reach out?";
  it('self-harm alone names 988 and stays, with no 911 and no hotline', () => {
    expect(crisisReply(['self-harm'])).toBe(`${opening} ${close}`);
  });
  it('danger from others alone adds 911 and no hotline', () => {
    expect(crisisReply(['danger-from-others'])).toBe(`${opening} ${danger} ${close}`);
  });
  it('a medical emergency alone adds 911 and no hotline', () => {
    expect(crisisReply(['medical-emergency'])).toBe(`${opening} ${danger} ${close}`);
  });
  it('abuse alone adds 911 and then the hotline', () => {
    expect(crisisReply(['abuse'])).toBe(`${opening} ${danger} ${hotline} ${close}`);
  });
  it('more than one category still says 911 once', () => {
    expect(crisisReply(['self-harm', 'danger-from-others', 'medical-emergency', 'abuse'])).toBe(`${opening} ${danger} ${hotline} ${close}`);
  });
});

describe('the second check only adds a route', () => {
  it('a route the patterns found is kept whole, whatever the model says', () => {
    const first = { crisis: true, categories: ['abuse' as const] };
    expect(mergeSecondCheck(first, true)).toEqual({ crisis: true, categories: ['abuse'] });
    expect(mergeSecondCheck(first, false)).toEqual({ crisis: true, categories: ['abuse'] });
  });
  it('a model that sees a crisis the patterns missed routes it as self-harm', () => {
    expect(mergeSecondCheck({ crisis: false, categories: [] }, true)).toEqual({ crisis: true, categories: ['self-harm'] });
  });
  it('no route from either check stays no route', () => {
    expect(mergeSecondCheck({ crisis: false, categories: [] }, false)).toEqual({ crisis: false, categories: [] });
    expect(mergeSecondCheck({ crisis: false, categories: [] }, undefined)).toEqual({ crisis: false, categories: [] });
  });
});

describe('the sandwich, step by step', () => {
  const okPost = (o: string) => (o === 'good' ? { ok: true as const } : { ok: false as const, reason: 'not good' });
  it('a failed pre-check never calls the model and falls back with its reason', async () => {
    let calls = 0;
    const r = await sandwich({ pre: () => ({ ok: false, reason: 'too long' }), model: async () => { calls++; return 'good'; }, post: okPost, fallback: (i: number, why) => `fallback ${i}: ${why}` }, 7);
    expect(r).toEqual({ output: 'fallback 7: too long', usedModel: false, reason: 'too long' });
    expect(calls).toBe(0);
  });
  it('model output that passes the post-check is used, with no reason', async () => {
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => 'good', post: okPost, fallback: () => 'safe' }, 1);
    expect(r).toEqual({ output: 'good', usedModel: true });
  });
  it('tries the model twice by default, then falls back with the last reason', async () => {
    let calls = 0;
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => { calls++; return 'bad'; }, post: okPost, fallback: (_i, why) => `safe: ${why}` }, 1);
    expect(calls).toBe(2);
    expect(r).toEqual({ output: 'safe: not good', usedModel: false, reason: 'not good' });
  });
  it('a second attempt that passes is used', async () => {
    let calls = 0;
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => (++calls === 2 ? 'good' : 'bad'), post: okPost, fallback: () => 'safe' }, 1);
    expect(r).toEqual({ output: 'good', usedModel: true });
  });
  it('honours the attempts asked for: one, three, and none', async () => {
    for (const attempts of [1, 3]) {
      let calls = 0;
      await sandwich({ pre: () => ({ ok: true }), model: async () => { calls++; return 'bad'; }, post: okPost, fallback: () => 'safe', attempts }, 1);
      expect(calls).toBe(attempts);
    }
    const none = await sandwich({ pre: () => ({ ok: true }), model: async () => 'good', post: okPost, fallback: (_i, why) => why, attempts: 0 }, 1);
    expect(none).toEqual({ output: 'model not attempted', usedModel: false, reason: 'model not attempted' });
  });
  it('a model that throws falls back naming the error', async () => {
    const r = await sandwich({ pre: () => ({ ok: true }), model: async () => { throw new Error('down'); }, post: () => ({ ok: true }), fallback: () => 'safe' }, 1);
    expect(r).toEqual({ output: 'safe', usedModel: false, reason: 'model error: down' });
  });
});

describe('refusing to start, condition by condition', () => {
  it('starts when every condition holds', () => {
    expect(() => refuseToStartUnless([])).not.toThrow();
    expect(() => refuseToStartUnless([{ name: 'secret', check: () => true }])).not.toThrow();
  });
  it('names each failed condition on its own line, with its reason or "failed"', () => {
    expect(() =>
      refuseToStartUnless([
        { name: 'secret', check: () => 'missing' },
        { name: 'sign-in', check: () => true },
        { name: 'database', check: () => false },
      ]),
    ).toThrow(new Error('refusing to start:\n  secret: missing\n  database: failed'));
  });
});

describe('approval tokens, refusal by refusal', () => {
  const secret = randomBytes(32);
  it('a secret under 32 bytes is refused by name; 32 bytes is accepted', () => {
    expect(() => new ApprovalService(randomBytes(31))).toThrow(new Error('approval secret must be at least 32 bytes'));
    expect(() => new ApprovalService(randomBytes(32))).not.toThrow();
  });
  it('a token carries a 64-character hex signature', () => {
    expect(new ApprovalService(secret).issue(action).signature).toMatch(/^[0-9a-f]{64}$/);
  });
  it('no token is refused by name', () => {
    expect(new ApprovalService(secret).consume(undefined, action)).toEqual({ ok: false, reason: 'no approval token' });
  });
  it('a signature of the wrong length, or one that no longer matches an edited field, is invalid', () => {
    const svc = new ApprovalService(secret);
    const t = svc.issue(action);
    expect(svc.consume({ ...t, signature: 'abcd' }, action)).toEqual({ ok: false, reason: 'signature invalid' });
    const later = new Date(Date.parse(t.expiresAt) + 24 * 60 * 60 * 1000).toISOString();
    expect(svc.consume({ ...t, expiresAt: later }, action)).toEqual({ ok: false, reason: 'signature invalid' });
    expect(svc.consume(t, action)).toEqual({ ok: true });
  });
  it('each mismatch is refused with its own reason', () => {
    const svc = new ApprovalService(secret);
    const t = svc.issue(action);
    expect(svc.consume(t, { ...action, studentId: 's2' })).toEqual({ ok: false, reason: 'token belongs to another student' });
    expect(svc.consume(t, { ...action, recipient: 'someone@else' })).toEqual({ ok: false, reason: 'token does not match this content and recipient' });
  });
  it('a token is good through the last millisecond of its 30 minutes and expired one after', () => {
    const issuedAt = Date.parse('2026-11-02T17:00:00Z');
    const svc = new ApprovalService(secret);
    const t = svc.issue(action, issuedAt);
    expect(t.expiresAt).toBe('2026-11-02T17:30:00.000Z');
    expect(svc.consume(t, action, issuedAt + 30 * 60 * 1000 + 1)).toEqual({ ok: false, reason: 'token expired' });
    expect(svc.consume(t, action, issuedAt + 30 * 60 * 1000)).toEqual({ ok: true });
  });
});

describe('quiet hours that start and end at the same minute', () => {
  it('a window of no length holds nothing, at that minute or any other', () => {
    const none = { maxPerDay: 3, quietStart: '22:00', quietEnd: '22:00', timeZone: 'America/New_York' };
    // 22:00, 21:59 and 03:00 Eastern on Nov 2, 2026 (UTC-5).
    for (const at of ['2026-11-03T03:00:00Z', '2026-11-03T02:59:00Z', '2026-11-02T08:00:00Z']) {
      expect(inQuietHours(none, new Date(at))).toBe(false);
      expect(decideContact(none, new Date(at), 0, 'routine')).toEqual({ action: 'send' });
    }
  });
});

describe('the consent ledger, entry by entry', () => {
  it('append returns the entry as it is stored, the first chained to genesis', () => {
    const l = new ConsentLedger();
    const first = l.append('s1', 'grant', 'calendar', { scope: 'read' });
    const second = l.append('s1', 'revoke', 'calendar');
    expect(l.entries()).toEqual([first, second]);
    expect(first).toMatchObject({ seq: 1, studentId: 's1', kind: 'grant', subject: 'calendar', detail: { scope: 'read' }, prevHash: 'genesis' });
    expect(second).toMatchObject({ seq: 2, kind: 'revoke', detail: {}, prevHash: first.hash });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a ledger made without a path is held in memory, and one made with a path is written to that file', () => {
    // SQLite keeps an in-memory database's journal in memory; a database on disk journals to a file beside it.
    const journal = (l: ConsentLedger) => (l.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    expect(journal(new ConsentLedger())).toBe('memory');
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'consent.db');
    const onDisk = new ConsentLedger(path);
    onDisk.append('s1', 'grant', 'calendar');
    expect(journal(onDisk)).toBe('delete');
    expect(existsSync(path)).toBe(true);
    onDisk.db.close();
  });
  it('a copy holds every row, hashes and all, and its chain still verifies and continues', () => {
    const l = new ConsentLedger();
    l.append('s1', 'grant', 'calendar');
    l.append('s2', 'share', 'transcript', { to: 'advisor' });
    const copy = new ConsentLedger();
    l.copyInto(copy);
    expect(copy.dump()).toEqual(l.dump());
    expect(copy.dump()).toHaveLength(2);
    expect(copy.dump()[1]).toMatchObject({ seq: 2, student_id: 's2', kind: 'share', subject: 'transcript', detail: '{"to":"advisor"}' });
    expect(copy.entries('s2')).toEqual(l.entries('s2'));
    const next = copy.append('s1', 'export', 'all');
    expect(next.seq).toBe(3);
    expect(next.prevHash).toBe(l.entries()[1]!.hash);
    expect(ConsentLedger.verify(copy.entries())).toEqual({ ok: true });
  });
});

describe('sealed facts, rule by rule', () => {
  const key = randomBytes(32);
  const ledgerOf = (l: ConsentLedger) => l.entries('s1').map((e) => [e.kind, e.subject, e.detail]);
  it('a master key must be exactly 32 bytes', () => {
    expect(() => new SealedStore(randomBytes(31), new ConsentLedger())).toThrow('master key must be 32 bytes');
    expect(() => new SealedStore(randomBytes(33), new ConsentLedger())).toThrow('master key must be 32 bytes');
    expect(() => new SealedStore(randomBytes(32), new ConsentLedger())).not.toThrow();
  });
  it('sealing, granting, opening and revoking each write their own ledger entry', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    store.seal('s1', 'veteran_status', 'yes');
    store.grant('s1', 'veteran_status', 'playbook:gi-bill');
    expect(store.open('s1', 'veteran_status', 'playbook:gi-bill', 'certify')).toBe('yes');
    store.revoke('s1', 'veteran_status', 'playbook:gi-bill');
    expect(ledgerOf(l)).toEqual([
      ['grant', 'sealed:veteran_status', { action: 'sealed' }],
      ['grant', 'sealed:veteran_status', { identity: 'playbook:gi-bill' }],
      ['release', 'sealed:veteran_status', { identity: 'playbook:gi-bill', purpose: 'certify' }],
      ['revoke', 'sealed:veteran_status', { identity: 'playbook:gi-bill' }],
    ]);
  });
  it('a fact never sealed cannot be granted or opened, for a known student or an unknown one', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    expect(() => store.grant('s1', 'income', 'a')).toThrow('no sealed fact income');
    expect(() => store.open('s1', 'income', 'a', 'p')).toThrow('no sealed fact income');
    store.seal('s1', 'veteran_status', 'yes');
    expect(() => store.grant('s1', 'income', 'a')).toThrow('no sealed fact income');
    expect(() => store.open('s1', 'income', 'a', 'p')).toThrow('no sealed fact income');
    expect(ledgerOf(l)).toEqual([['grant', 'sealed:veteran_status', { action: 'sealed' }]]);
  });
  it('a fact sealed with no grants opens for no one, and a refused open is not logged', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    store.seal('s1', 'veteran_status', 'yes');
    expect(() => store.open('s1', 'veteran_status', 'playbook:gi-bill', 'certify')).toThrow('playbook:gi-bill is not granted veteran_status');
    expect(l.entries('s1').filter((e) => e.kind === 'release')).toEqual([]);
  });
  it('granting twice lists the identity once; revoking removes only that identity', () => {
    const store = new SealedStore(key, new ConsentLedger());
    store.seal('s1', 'veteran_status', 'yes');
    store.grant('s1', 'veteran_status', 'a');
    store.grant('s1', 'veteran_status', 'a');
    store.grant('s1', 'veteran_status', 'b');
    expect(store.raw('s1')!.grants).toEqual({ veteran_status: ['a', 'b'] });
    store.revoke('s1', 'veteran_status', 'a');
    expect(store.raw('s1')!.grants).toEqual({ veteran_status: ['b'] });
    expect(() => store.open('s1', 'veteran_status', 'a', 'p')).toThrow('a is not granted veteran_status');
    expect(store.open('s1', 'veteran_status', 'b', 'p')).toBe('yes');
  });
  it('revoking where nothing was granted leaves an empty list; revoking for an unknown student does nothing', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    store.seal('s1', 'veteran_status', 'yes');
    store.revoke('s1', 'veteran_status', 'a');
    expect(store.raw('s1')!.grants).toEqual({ veteran_status: [] });
    store.revoke('s9', 'veteran_status', 'a');
    expect(store.raw('s9')).toBeUndefined();
    expect(l.entries('s9')).toEqual([]);
  });
  it('has says whether a fact is sealed, for a known student and an unknown one', () => {
    const store = new SealedStore(key, new ConsentLedger());
    expect(store.has('s1', 'veteran_status')).toBe(false);
    store.seal('s1', 'veteran_status', 'yes');
    expect(store.has('s1', 'veteran_status')).toBe(true);
    expect(store.has('s1', 'income')).toBe(false);
  });
  it('removing a fact drops it and its grants, logs the deletion, and leaves other facts', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    store.seal('s1', 'veteran_status', 'yes');
    store.seal('s1', 'income', '12000');
    store.grant('s1', 'veteran_status', 'a');
    store.remove('s1', 'veteran_status');
    expect(store.has('s1', 'veteran_status')).toBe(false);
    expect(store.raw('s1')!.grants).toEqual({});
    expect(store.has('s1', 'income')).toBe(true);
    expect(l.entries('s1').at(-1)).toMatchObject({ kind: 'delete', subject: 'sealed:veteran_status', detail: {} });
    store.remove('s9', 'veteran_status');
    expect(l.entries('s9')).toEqual([]);
  });
  it('forgetting a student drops every record and logs one deletion of everything', () => {
    const l = new ConsentLedger();
    const store = new SealedStore(key, l);
    store.seal('s1', 'veteran_status', 'yes');
    store.forget('s1');
    expect(store.raw('s1')).toBeUndefined();
    expect(store.has('s1', 'veteran_status')).toBe(false);
    expect(l.entries('s1').at(-1)).toMatchObject({ kind: 'delete', subject: 'sealed:*', detail: {} });
  });
  it('a copy under the same master key holds every record, still encrypted, and opens as the original does', () => {
    const store = new SealedStore(key, new ConsentLedger());
    store.seal('s1', 'veteran_status', 'yes');
    store.grant('s1', 'veteran_status', 'a');
    store.seal('s2', 'income', '12000');
    const copy = new SealedStore(key, new ConsentLedger());
    store.copyInto(copy);
    expect(copy.dump()).toEqual(store.dump());
    expect(copy.dump().map(([k]) => k)).toEqual(['s1', 's2']);
    expect(JSON.stringify(copy.dump())).not.toContain('12000');
    expect(copy.open('s1', 'veteran_status', 'a', 'p')).toBe('yes');
    copy.grant('s2', 'income', 'b');
    expect(copy.open('s2', 'income', 'b', 'p')).toBe('12000');
    expect(store.raw('s2')!.grants).toEqual({});
  });
});

// The safety patterns and the sealed store's cipher are made once, as each module loads. These tests load the module
// afresh, so what they check is what the module makes as it loads, not a copy another test file already holds.
describe('the safety router as it loads', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  // Each phrase routes to its own category and no other, with single spaces and with every space doubled, since the
  // patterns allow any run of spaces between words.
  const routes = async (category: string, phrases: string[]) => {
    const S = await import('../src/safety.js');
    for (const p of phrases) {
      for (const text of [p, p.replace(/ /g, '  ')]) expect([text, S.screen(text).categories]).toEqual([text, [category]]);
    }
  };

  it('a medical emergency: cannot breathe, with or without the apostrophe, and chest pain', async () => {
    await routes('medical-emergency', ["I can't breathe", 'I cant breathe', 'I cannot breathe', 'I have chest pain', 'he had a seizure', 'she is unconscious']);
  });

  it('abuse: in Spanish, by a partner, and the word abuse with me or my anywhere after it', async () => {
    await routes('abuse', [
      'mi novio me pega',
      'mi esposo me golpea',
      'mi pareja me maltrata',
      'my boyfriend hits me',
      'my partner choked me',
      'they beat me',
      'the abuse at home scares me',
      'abusive words from my ex',
    ]);
  });

  it('danger from others: a threat in Spanish, not being safe, and fear of being hurt', async () => {
    await routes('danger-from-others', [
      'mi ex me quiere matar',
      'I am not safe at home',
      'I am not safe here',
      'I am not safe right now',
      "I'm afraid he'll hurt me",
      'scared they will kill me',
      'afraid she will hurt me',
    ]);
  });

  it('self-harm: hurting myself, with or without a space before self', async () => {
    await routes('self-harm', ['I keep hurting myself', 'I want to hurt my self']);
  });

  it('self-harm: ending my life or ending it all, with or without -ing', async () => {
    await routes('self-harm', ['I want to end my life', 'I am thinking of ending it all']);
  });

  it('self-harm: wanting to die, said either way', async () => {
    await routes('self-harm', ['I want to die', 'I wanna die']);
  });

  it("self-harm: not wanting to be alive, to live or to wake up", async () => {
    await routes('self-harm', ["I don't want to be alive", 'I dont want to live', "I don't want to wake up"]);
  });

  it('self-harm: no reason to live, better off dead or without me, too many pills or tablets', async () => {
    await routes('self-harm', ['there is no reason to live', 'I would be better off dead', 'they are better off without me', 'I took too many pills', 'I swallowed too many tablets']);
  });

  it('self-harm: disappearing or vanishing forever or for good', async () => {
    await routes('self-harm', ['I want to disappear for good', 'I just want to vanish forever']);
  });

  it('self-harm: nobody would care, notice or miss me, with words between that and being gone', async () => {
    await routes('self-harm', ['nobody would care if I was gone', 'nobody would miss me if I died']);
    // "no one" allows one space or none, so these are checked as written, not with the spaces doubled.
    const S = await import('../src/safety.js');
    for (const text of ['no one would notice if I disappeared', 'noone would miss me when I am dead']) {
      expect([text, S.screen(text).categories]).toEqual([text, ['self-harm']]);
    }
  });

  it('a plan to end my life or kill myself routes as self-harm', async () => {
    await routes('self-harm', ['I have a plan to end my life', 'I am planning to kill myself']);
  });

  it('danger from others: someone following me', async () => {
    await routes('danger-from-others', ['I think someone is following me']);
  });

  it('self-harm in Spanish: wanting to kill myself or to die, taking my life, suicide, not wanting to live', async () => {
    await routes('self-harm', [
      'me quiero matar',
      'quiero morir',
      'quiero morirme',
      'voy a matarme',
      'quiero suicidarme',
      'pienso en el suicidio',
      'quiero quitarme la vida',
      'no quiero vivir',
    ]);
  });

  it('danger from others: he, she, they or someone threatening me or threatening to, with or without "is"', async () => {
    await routes('danger-from-others', [
      'he threatened me',
      'she is threatening me',
      'they threaten me',
      'someone is threatening me',
      'he threatened to take my kids',
      'she is threatening to call my boss',
    ]);
  });

  it('danger from others: someone is going to hurt or kill me', async () => {
    await routes('danger-from-others', ['someone is going to hurt me', 'he is going to kill me', 'she is going to hurt me', 'they going to kill me']);
  });

  it("danger from others: he's, she's, they're or they are threatening, threatened or going to kill or hurt me", async () => {
    await routes('danger-from-others', [
      "he's threatening to kill me",
      "she's threatened to hurt me",
      "they're threaten to kill me",
      'they are threatening to hurt me',
      "he's going to kill me",
      "they're going to hurt me",
      'they are going to kill me',
    ]);
  });

  it('a message with none of these routes nowhere', async () => {
    const S = await import('../src/safety.js');
    expect(S.screen('I need help with my rent')).toEqual({ crisis: false, categories: [] });
  });
});

describe('the sealed store as it loads', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a sealed fact opens to what was sealed, under the cipher the module makes', async () => {
    const { SealedStore: Store } = await import('../src/sealed.js');
    const { ConsentLedger: Ledger } = await import('../src/ledger.js');
    const store = new Store(randomBytes(32), new Ledger());
    store.seal('s1', 'veteran_status', 'yes');
    store.grant('s1', 'veteran_status', 'playbook:gi-bill');
    expect(store.open('s1', 'veteran_status', 'playbook:gi-bill', 'certify')).toBe('yes');
  });
});
