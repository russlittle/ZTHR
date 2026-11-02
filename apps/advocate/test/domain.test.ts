import { describe, expect, it } from 'vitest';
import { classifyAiPolicy, parseSyllabus } from '../src/domain/syllabus.js';
import { checkTone, readingGrade } from '../src/domain/tone.js';
import { openBlocks, upcomingMessages } from '../src/domain/planner.js';
import { classifyInbound } from '../src/domain/inbound.js';
import { findGap } from '../src/domain/money.js';
import { detectSituation } from '../src/domain/crisis.js';
import { parseIcs } from '../src/domain/ics.js';
import { CalendarFeedTwin } from '@zthr/twins';
import { makeAdvocate, maria, TODAY } from './helpers.js';

export const SYLLABUS = `ENG 1101 English Composition I - Fall 2026
Use of AI: Generative AI tools such as ChatGPT may not be used to write any graded work unless you disclose it and cite the tool.
Week 9 (Oct 27): Read Chapter 6
Tue Nov 4 - Essay 2 draft due
Thursday, November 6: Essay 2 final due
11/18 Quiz on rhetorical appeals
Dec 9 Final portfolio due`;

describe('syllabus mapping', () => {
  it('extracts dated items with their source lines', () => {
    const r = parseSyllabus('ENG 1101', SYLLABUS, '2026-08-24');
    expect(r.deadlines.map((d) => d.due)).toEqual(['2026-10-27', '2026-11-04', '2026-11-06', '2026-11-18', '2026-12-09']);
    expect(r.deadlines.every((d) => d.source.line && !d.confirmed)).toBe(true);
    expect(r.deadlines.find((d) => d.due === '2026-11-18')?.kind).toBe('exam');
  });
  it('rolls spring dates into the next year', () => {
    const r = parseSyllabus('X', 'Jan 20 project due', '2026-08-24');
    expect(r.deadlines[0]?.due).toBe('2027-01-20');
  });
  it('classifies AI policies', () => {
    expect(classifyAiPolicy(SYLLABUS).policy).toBe('allowed-with-limits');
    expect(classifyAiPolicy('Use of ChatGPT is prohibited and is academic dishonesty.').policy).toBe('not-allowed');
    expect(classifyAiPolicy('You are encouraged to use AI tools to study.').policy).toBe('allowed');
    expect(classifyAiPolicy('Bring a pencil.').policy).toBe('unstated');
  });
});

describe('tone rubric', () => {
  const ok = { text: 'Your essay is due Thursday. Tuesday after class is open. Want me to hold that time?', nextSteps: [{ label: 'Hold it', action: 'x' }], urgency: 'routine' as const };
  it('passes a plain, kind message with a next step', () => expect(checkTone(ok, 'standard', 8).ok).toBe(true));
  it.each([
    "You're late on your essay.",
    'You missed the deadline.',
    'You should have started earlier.',
    'WARNING: your bill is overdue.',
    'Unfortunately you did not qualify.',
    'You must submit this today.',
  ])('fails scolding: %s', (text) => expect(checkTone({ ...ok, text }, 'standard', 8).ok).toBe(false));
  it('fails a message with no next step', () => expect(checkTone({ ...ok, nextSteps: [] }, 'standard', 8).ok).toBe(false));
  it('fails dense prose for a walk-me-through student', () => {
    const dense = 'Notwithstanding institutional verification requirements, documentation substantiating extraordinary circumstances necessitates comprehensive administrative consideration.';
    expect(readingGrade(dense)).toBeGreaterThan(12);
    expect(checkTone({ ...ok, text: dense }, 'walk-me-through', 6).ok).toBe(false);
  });
  it('limits length in brief mode', () => expect(checkTone({ ...ok, text: 'Okay. '.repeat(80) }, 'brief', 8).ok).toBe(false));
});

describe('planner', () => {
  it('finds open blocks around classes and shifts', () => {
    const blocks = openBlocks('2026-11-03', '2026-11-06', [{ course: 'ENG', days: ['Tue', 'Thu'], start: '09:00', end: '12:00' }], [{ date: '2026-11-04', start: '09:00', end: '21:00' }], 3);
    expect(blocks[0]).toMatchObject({ date: '2026-11-03', start: '12:30' });
    expect(blocks.some((b) => b.date === '2026-11-04')).toBe(false);
  });
  it('raises a deadline early with a plan, and a passed one with a recovery path', () => {
    const a = makeAdvocate();
    const s = maria(a);
    const due = a.addDeadline(s.id, { title: 'Essay 2', course: 'ENG 1101', due: '2026-11-05', kind: 'assignment', effortHours: 8, source: { type: 'syllabus', line: 'Essay 2 due' }, confirmed: true });
    const passed = a.addDeadline(s.id, { title: 'Lab 3', course: 'BIO 1111', due: '2026-10-30', kind: 'assignment', effortHours: 3, source: { type: 'syllabus', line: 'Lab 3' }, confirmed: true });
    const msgs = upcomingMessages(s, TODAY, [due, passed], [], []);
    expect(msgs).toHaveLength(2);
    for (const m of msgs) expect(checkTone(m, 'standard', 8).ok).toBe(true);
    expect(msgs.find((m) => m.text.includes('passed'))?.nextSteps[0]?.label).toMatch(/instructor/);
  });
});

describe('inbound, money, crisis, feeds', () => {
  it('classifies forwarded notices', () => {
    expect(classifyInbound('Your service will be disconnected on 11/10/2026 unless $142.50 is paid.').kind).toBe('utility-shutoff');
    expect(classifyInbound('You have been selected for verification. Please submit additional documents to financial aid.').kind).toBe('aid-verification');
    expect(classifyInbound('Notice to vacate the premises').kind).toBe('eviction-notice');
  });
  it('finds a rent gap before it happens', () => {
    const gap = findGap(400, [{ name: 'Rent', amount: 850, dueDay: 1, kind: 'rent' }], { amount: 600, next: '2026-12-05', everyDays: 14 }, '2026-11-20');
    expect(gap).toMatchObject({ date: '2026-12-01', bill: 'Rent' });
  });
  it('detects life situations', () => {
    expect(detectSituation('my landlord gave me an eviction notice')).toBe('eviction');
    expect(detectSituation("they're shutting off my power friday")).toBe('utility-shutoff');
    expect(detectSituation('my car died and I need a ride to class')).toBe('car');
  });
  it('reads learning-platform calendar feeds', () => {
    const ics = new CalendarFeedTwin([{ uid: 'a1', summary: 'Quiz 4', start: '20261110T235900' }]).ics();
    expect(parseIcs(ics, 'MAT 1470')[0]).toMatchObject({ title: 'Quiz 4', due: '2026-11-10T23:59', kind: 'exam' });
  });
});
