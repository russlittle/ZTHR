import { describe, expect, it } from 'vitest';
import { Community, moderate } from '../src/domain/community.js';

const mk = (today = '2026-11-02') => new Community(() => today);
const base = { college: 'sinclair', communities: [] as string[], expires: '2026-11-09' };

describe('community moderation', () => {
  it.each([
    ['Text me at 937-555-0199 for a ride', 'phone number'],
    ['email me at someone@example.com', 'email address'],
    ['selling adderall cheap', 'cannot be traded'],
    ['check this out https://bit.ly/x', 'link'],
    ['send $20 on venmo and I will pay you back', 'payment'],
  ])('holds: %s', (text, why) => {
    const r = moderate(text);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(new RegExp(why));
  });
  it('threats go to a person', () => {
    const c = mk();
    const p = c.post('s1', { ...base, type: 'tip', category: 'campus-know-how', text: 'I will hurt you if you take my spot' });
    expect(p.status).toBe('held');
    expect(c.personQueue).toHaveLength(1);
  });
  it('held posts never surface, and two reports hold a post', () => {
    const c = mk();
    const held = c.post('s1', { ...base, type: 'offer', category: 'ride', text: 'Call 937-555-0100 for rides' });
    const ok = c.post('s2', { ...base, type: 'offer', category: 'ride', text: 'Driving from Kettering to campus Tuesday mornings' });
    expect(c.visible('sinclair').map((p) => p.id)).toEqual([ok.id]);
    c.report(ok.id);
    c.report(ok.id);
    expect(c.visible('sinclair')).toHaveLength(0);
    expect(held.status).toBe('held');
  });
});

describe('a community that runs itself', () => {
  it('matches asks to offers and shares contact only when both approve', () => {
    const c = mk();
    const ask = c.post('s1', { ...base, type: 'ask', category: 'ride', text: 'Need a ride to campus Tuesday morning', when: { date: '2026-11-03' } });
    const offer = c.post('s2', { ...base, type: 'offer', category: 'ride', text: 'Driving in Tuesday at 8', when: { date: '2026-11-03' } });
    expect(c.matches(ask.id).map((p) => p.id)).toEqual([offer.id]);
    const i = c.requestConnection(ask.id, offer.id);
    expect(c.contactAllowed(i, 's1')).toBe(false);
    expect(c.approveConnection(i, 's2')).toBe(true);
    expect(c.contactAllowed(i, 's1')).toBe(true);
    expect(c.contactAllowed(i, 's3')).toBe(false);
    expect(c.get(ask.id)!.status).toBe('matched');
  });
  it('posts expire on their own and tips retire when rated unhelpful', () => {
    const c = mk('2026-11-20');
    c.post('s1', { ...base, type: 'offer', category: 'item', text: 'Free calculus book', expires: '2026-11-10' });
    expect(c.visible('sinclair')).toHaveLength(0);
    const tip = c.post('s2', { ...base, type: 'tip', category: 'campus-know-how', text: 'The library prints for free' });
    c.rate(tip.id, 1); c.rate(tip.id, 2); c.rate(tip.id, 1);
    expect(c.get(tip.id)!.status).toBe('closed');
  });
  it('study groups form at three students for the same course', () => {
    const c = mk();
    for (const s of ['a', 'b']) c.post(s, { ...base, type: 'study-group', category: 'study', course: 'MAT 1470', text: 'Want a study group for MAT 1470' });
    expect(c.studyGroups('sinclair')).toHaveLength(0);
    c.post('c', { ...base, type: 'study-group', category: 'study', course: 'MAT 1470', text: 'Study group for MAT 1470?' });
    expect(c.studyGroups('sinclair')[0]!.members).toHaveLength(3);
  });
  it('communities filter what a student sees; pseudonyms hide identity', () => {
    const c = mk();
    const p = c.post('s1', { ...base, communities: ['student-parents'], type: 'tip', category: 'campus-know-how', text: 'The family lounge in Building 10 has a quiet corner for kids' });
    expect(c.visible('sinclair', { communities: ['veterans'] })).toHaveLength(0);
    expect(c.visible('sinclair', { communities: ['student-parents'] })).toHaveLength(1);
    expect(p.author).not.toContain('s1');
  });
});
