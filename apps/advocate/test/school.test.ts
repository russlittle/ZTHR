// Verifies docs/flows/stay-enrolled.md
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Advocate } from '../src/agents/advocate.js';
import { createApp } from '../src/server/app.js';
import { PERSONAS } from '../src/server/demo.js';
import { dropOptions } from '../src/agents/academics.js';

const DAY = '2026-11-02';
function setup(now = `${DAY}T15:00:00Z`) {
  let clock = new Date(now);
  const a = new Advocate({ today: () => clock.toISOString().slice(0, 10), now: () => clock });
  const ids = Object.fromEntries(['Maria', 'Destiny', 'Priya', 'Tyler', 'Darnell', 'Linda', 'Keisha'].map((n) => [n, PERSONAS[n]!(a).id]));
  const app = new Hono().route('/sa', createApp(a, { base: '/sa' }));
  const html = async (path: string, init?: RequestInit) => {
    const r = await app.request(`/sa${path}`, init);
    return { status: r.status, text: await r.text() };
  };
  const post = (path: string, form: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of ([] as string[]).concat(v)) body.append(k, x);
    return html(path, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  };
  return { a, ids, html, post, advance: (days: number) => (clock = new Date(clock.getTime() + days * 86_400_000)) };
}

describe('the School screen and its questions', () => {
  it('answers by text and in the app with the same rules', () => {
    const { a, ids } = setup();
    const [m] = a.converse(ids.Priya!, 'what do I need on the final in CHM 1210?');
    expect(m!.text).toMatch(/CHM 1210: B \(\d+(\.\d)?%\) now/);
    expect(m!.text).toMatch(/[\d.]+% keeps your B/);
    expect(m!.text).toMatch(/an A is out of reach on the final exam alone/);
    const [aid] = a.converse(ids.Destiny!, 'am I going to lose my financial aid?');
    expect(aid!.text).toMatch(/appeal was approved/);
    expect(aid!.text).toMatch(/2\.0 term GPA and finishing 67%/);
    const [linda] = a.converse(ids.Linda!, 'will I keep my aid');
    expect(linda!.text).toMatch(/under Sinclair's aid-progress rule/);
    expect(linda!.nextSteps[0]!.action).toBe('playbook:sap-appeal:start');
  });

  it('records a typed score and recomputes', () => {
    const { a, ids } = setup();
    const before = a.academicView(ids.Maria!).books.find((b) => b.course === 'BIO 1111')!.now!.percent;
    a.converse(ids.Maria!, 'I got 25 out of 25 on lab report 5 in BIO 1111');
    const after = a.academicView(ids.Maria!).books.find((b) => b.course === 'BIO 1111')!.now!.percent;
    expect(after).toBeGreaterThan(before);
    expect(a.recordScore(ids.Maria!, 'BIO 1111', 'x', 999, 10)).toBeUndefined();
  });

  it('drop or withdraw: dates passed are not offered, and the 60% point is explained', () => {
    const { a, ids } = setup();
    const d = dropOptions(a, ids.Destiny!, 'ACC 2010');
    expect(d.options.find((o) => o.choice === 'drop')!.available).toBe(false);
    expect(d.options.find((o) => o.choice === 'withdraw')!.when).toMatch(/October 23.*passed/);
    expect(d.r2t4).toMatchObject({ allEarned: true, percentCompleted: 0.67, sixtyPercentDay: '2026-10-26' });
    expect(d.options.find((o) => o.choice === 'withdraw')!.plan).toMatch(/misses the plan|meets the plan|not measurable/);
  });

  it('says what it does not know instead of guessing dates', () => {
    const { a, ids } = setup();
    const d = dropOptions(a, ids.Maria!, 'BIO 1111');
    expect(d.options.find((o) => o.choice === 'drop')!.when).toMatch(/^Not known/);
    expect(d.options.find((o) => o.choice === 'withdraw-all')!.aidReturn).toMatch(/^Not known/);
    const k = dropOptions(a, ids.Keisha!);
    expect(k.options.find((o) => o.choice === 'withdraw-all')).toBeDefined();
  });

  it('every new screen renders for every kind of student', async () => {
    const { html, ids } = setup();
    for (const id of Object.values(ids)) for (const p of ['/school', '/school/drop', '/school/degree', '/advisor']) expect((await html(`/s/${id}${p}`)).status).toBe(200);
  });
});

describe('sharing with an advisor', () => {
  it('shows only what was chosen, never sealed facts, and keeps no copy of the link', async () => {
    const { a, ids, html, post } = setup();
    a.seal(ids.Destiny!, 'justice_involvement', 'SEALED-MARKER-7731');
    const made = await post(`/s/${ids.Destiny}/advisor`, { label: 'Ms. Rivera', scopes: ['school'], days: '7' });
    const token = made.text.match(/\/shared\/([A-Za-z0-9_-]{30,})/)![1]!;
    expect(JSON.stringify(a.store.exportStudent(ids.Destiny!))).not.toContain(token);
    expect(a.messages(ids.Destiny!).some((m) => m.text.includes(token))).toBe(false);
    const view = await html(`/shared/${token}`);
    expect(view.status).toBe(200);
    expect(view.text).toContain('Shared by Destiny');
    expect(view.text).toContain('ACC 2010');
    expect(view.text).not.toContain('This week');
    expect(view.text).not.toContain('SEALED-MARKER-7731');
    expect(view.text).not.toMatch(/Millett Hall|Coffee shop|Grocery/);
    expect(a.ledger.entries(ids.Destiny!).filter((e) => e.kind === 'release' && e.subject.startsWith('share:'))).toHaveLength(1);
    expect(a.shares(ids.Destiny!)[0]!.views).toBe(1);
  });

  it('a revoked or expired link is gone, and an unknown one says so', async () => {
    const { a, ids, html, post, advance } = setup();
    const t1 = (await post(`/s/${ids.Priya}/advisor`, { label: 'Advisor', scopes: ['schedule'], days: '1' })).text.match(/\/shared\/([A-Za-z0-9_-]{30,})/)![1]!;
    const t2 = (await post(`/s/${ids.Priya}/advisor`, { label: 'Coach', scopes: ['degree', 'plan'], days: '7' })).text.match(/\/shared\/([A-Za-z0-9_-]{30,})/)![1]!;
    expect((await html(`/shared/${t1}`)).status).toBe(200);
    a.revokeShare(ids.Priya!, a.shares(ids.Priya!).find((s) => s.label === 'Coach')!.id);
    expect((await html(`/shared/${t2}`)).status).toBe(410);
    advance(2);
    expect((await html(`/shared/${t1}`)).status).toBe(410);
    expect((await html('/shared/not-a-real-token-at-all-0000000')).status).toBe(410);
  });

  it('cannot be revoked by another student, and needs at least one thing to show', async () => {
    const { a, ids, post } = setup();
    const { share } = a.createShare(ids.Tyler!, 'Advisor', ['degree'], 7);
    expect(a.revokeShare(ids.Maria!, share.id)).toBe(false);
    expect(() => a.createShare(ids.Tyler!, 'x', [], 7)).toThrow();
    const r = await post(`/s/${ids.Tyler}/advisor`, { label: 'x', days: '7' });
    expect(r.status).toBe(302);
  });

  it('deleting the account ends every link', async () => {
    const { a, ids } = setup();
    const { token } = a.createShare(ids.Tyler!, 'Advisor', ['degree'], 30);
    a.store.deleteStudent(ids.Tyler!);
    expect(a.hasShare(token)).toBe(false);
  });
});
