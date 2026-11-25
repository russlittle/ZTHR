// Verifies docs/flows/planning.md
// Verifies docs/flows/money.md
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('tone rubric, stated rule by rule', () => {
  const step = [{ label: 'Hold it', action: 'x' }];
  const plain = { text: 'Go. ', nextSteps: step, urgency: 'routine' as const };
  // Worked by hand: 3 words, 5 syllables each (vowel groups), 1 sentence: 0.39 * 3 + 11.8 * 5 - 15.59 = 44.58.
  const dense = { ...plain, text: 'Administration documentation consideration.' };
  it('a clean message passes with no problems and its grade', () => {
    const r = checkTone({ ...plain, text: 'Go now.' }, 'standard', 8);
    expect(r).toEqual({ ok: true, problems: [], grade: expect.any(Number) });
    // 2 words, 2 syllables, 1 sentence: 0.39 * 2 + 11.8 * 1 - 15.59 = -3.01.
    expect(r.grade).toBeCloseTo(-3.01, 5);
  });
  it('a message with no next step is named, unless it is a safety message', () => {
    expect(checkTone({ ...plain, nextSteps: [] }, 'standard', 8).problems).toEqual(['reports without offering a next step']);
    expect(checkTone({ ...plain, nextSteps: [], urgency: 'safety' }, 'standard', 8)).toMatchObject({ ok: true, problems: [] });
  });
  it('a grade above the target plus slack is named with both numbers; standard and brief allow 2 grades, walk-me-through none', () => {
    expect(checkTone(dense, 'standard', 8).problems).toEqual(['reads at grade 44.6, above 10']);
    expect(checkTone(dense, 'brief', 8).problems).toEqual(['reads at grade 44.6, above 10']);
    expect(checkTone(dense, 'walk-me-through', 8).problems).toEqual(['reads at grade 44.6, above 8']);
    expect(checkTone(dense, 'standard', 43).ok).toBe(true);
    expect(checkTone(dense, 'standard', 42).ok).toBe(false);
    expect(checkTone(dense, 'brief', 43).ok).toBe(true);
    expect(checkTone(dense, 'walk-me-through', 45).ok).toBe(true);
    expect(checkTone(dense, 'walk-me-through', 44).ok).toBe(false);
    expect(checkTone(dense, 'standard', 8).grade).toBeCloseTo(44.58, 5);
  });
  it('a safety message is not held to a grade', () => {
    expect(checkTone({ ...dense, urgency: 'safety' }, 'walk-me-through', 6)).toMatchObject({ ok: true, problems: [] });
  });
  it('Spanish is not graded: no grade problem and a grade of 0; English is the default', () => {
    expect(checkTone(dense, 'walk-me-through', 6, 'es')).toEqual({ ok: true, problems: [], grade: 0 });
    expect(checkTone(dense, 'walk-me-through', 6).problems).toEqual(['reads at grade 44.6, above 6']);
    // Not graded means no target can fail it: a grade of 0 against a limit below 0 still passes.
    expect(checkTone(dense, 'walk-me-through', -5, 'es')).toEqual({ ok: true, problems: [], grade: 0 });
  });
  it('a grade exactly at the target plus slack is admitted', () => {
    // Worked by hand: a message with no words has grade 0.
    const wordless = { ...plain, text: '1 2 3' };
    expect(checkTone(wordless, 'standard', -2)).toEqual({ ok: true, problems: [], grade: 0 });
    expect(checkTone(wordless, 'walk-me-through', 0)).toEqual({ ok: true, problems: [], grade: 0 });
    expect(checkTone(wordless, 'walk-me-through', -1).problems).toEqual(['reads at grade 0.0, above -1']);
  });
  it('length: each depth admits its limit and names one character more', () => {
    const at = (n: number) => 'Go. '.repeat(n / 4);
    expect(checkTone({ ...plain, text: at(320) }, 'brief', 8).ok).toBe(true);
    expect(checkTone({ ...plain, text: `${at(320)}x` }, 'brief', 8).problems).toEqual(['321 characters is too long for brief mode']);
    expect(checkTone({ ...plain, text: at(1200) }, 'standard', 8).ok).toBe(true);
    expect(checkTone({ ...plain, text: `${at(1200)}x` }, 'standard', 8).problems).toEqual(['1201 characters is too long for standard mode']);
    expect(checkTone({ ...plain, text: at(2400) }, 'walk-me-through', 8).ok).toBe(true);
    expect(checkTone({ ...plain, text: `${at(2400)}x` }, 'walk-me-through', 8).problems).toEqual(['2401 characters is too long for walk-me-through mode']);
  });
  it('scolding in either language is named by what it does', () => {
    expect(checkTone({ ...plain, text: 'You must go.' }, 'standard', 8).problems).toEqual(['commands the student']);
    expect(checkTone({ ...plain, text: 'Debes ir.' }, 'standard', 8, 'es').problems).toEqual(['commands the student']);
  });
  it('careless writing is named', () => {
    expect(checkTone({ ...plain, text: 'Go now..' }, 'standard', 8).problems).toEqual(['has a doubled period']);
  });
  it('a button with a blank label is named, once per button', () => {
    const blank = [{ label: '  ', action: 'x' }, { label: 'Ok', action: 'y' }, { label: '', action: 'z' }];
    expect(checkTone({ ...plain, nextSteps: blank }, 'standard', 8).problems).toEqual(['has a button with no label', 'has a button with no label']);
  });
  it('every problem is listed, in order: phrasing, next step, grade, length, care, labels', () => {
    const text = `You must read the administration documentation consideration.. ${'Go. '.repeat(80)}`;
    const r = checkTone({ text, nextSteps: [], urgency: 'routine' }, 'brief', 0);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toBe('commands the student');
    expect(r.problems[1]).toBe('reports without offering a next step');
    expect(r.problems[2]).toMatch(/^reads at grade -?\d+\.\d, above 2$/);
    expect(r.problems.slice(3)).toEqual([`${text.length} characters is too long for brief mode`, 'has a doubled period']);
  });
});

// These tests import the rubric afresh, so what they check is the phrase list and the limits the module makes as it
// loads, not a copy another test file already holds.
describe('the tone rubric as it loads', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  const step = [{ label: 'Hold it', action: 'x' }];
  // A target this high leaves the grade out of it, so each phrase is the only problem the message has.
  const problems = async (text: string, language: 'en' | 'es' = 'en') => {
    const T = await import('../src/domain/tone.js');
    return T.checkTone({ text, nextSteps: step, urgency: 'routine' }, 'standard', 99, language).problems;
  };
  const named = async (why: string, phrases: string[], language: 'en' | 'es' = 'en') => {
    for (const text of phrases) expect([text, await problems(text, language)]).toEqual([text, [why]]);
  };

  it('English: late or behind, blame, second-guessing and interrogating are each named by what they do', async () => {
    await named('tells the student they are late or behind', ["You're late.", 'You are behind.', 'You are falling behind.']);
    await named('blames the student', ['You failed the quiz.', 'You forgot the form.', 'You missed class.', 'You neglected it.']);
    await named('second-guesses the student', ['You should have asked.']);
    await named('interrogates the student', ["Why didn't you call?", 'Why didnt you call?']);
  });

  it('English: alarm, scolding, compliance, bad-news, command, collections and judging words are each named', async () => {
    await named('uses alarm language', ['This is a warning.']);
    await named('uses scolding language for a passed date', ['The bill is overdue.']);
    await named('uses compliance language', ['Failure to pay ends it.']);
    await named('opens with bad-news framing', ['Unfortunately it closed.']);
    await named('commands the student', ['You must sign it.']);
    await named('uses collections language', ['The account is delinquent.']);
    await named('judges the student', ['That was irresponsible.']);
  });

  it('Spanish: late, second-guessing, alarm and command words are each named, in either language mode', async () => {
    for (const language of ['es', 'en'] as const) {
      await named('tells the student they are late', ['Llegas tarde.', 'Estás atrasado.', 'Estás atrasada.'], language);
      await named('second-guesses the student', ['Debiste llamar.', 'Deberías haber llamado.'], language);
      await named('uses alarm language', ['Advertencia.', 'Está vencido.', 'Está vencida.'], language);
      await named('commands the student', ['Tienes que firmar.', 'Debes firmar.'], language);
    }
  });

  it('a kind message names nothing', async () => {
    expect(await problems('Your essay is due Thursday. Want me to hold Tuesday?')).toEqual([]);
  });

  it('each depth admits its own length and grade slack, and names one past either', async () => {
    const T = await import('../src/domain/tone.js');
    const m = (text: string) => ({ text, nextSteps: step, urgency: 'routine' as const });
    const at = (n: number) => 'Go. '.repeat(n / 4);
    for (const [depth, max] of [['brief', 320], ['standard', 1200], ['walk-me-through', 2400]] as const) {
      expect(T.checkTone(m(at(max)), depth, 8).problems).toEqual([]);
      expect(T.checkTone(m(`${at(max)}x`), depth, 8).problems).toEqual([`${max + 1} characters is too long for ${depth} mode`]);
    }
    // Worked by hand: 3 words, 5 syllables each, 1 sentence: 0.39 * 3 + 11.8 * 5 - 15.59 = 44.58.
    const dense = m('Administration documentation consideration.');
    expect(T.checkTone(dense, 'brief', 43).problems).toEqual([]);
    expect(T.checkTone(dense, 'brief', 42).problems).toEqual(['reads at grade 44.6, above 44']);
    expect(T.checkTone(dense, 'standard', 43).problems).toEqual([]);
    expect(T.checkTone(dense, 'standard', 42).problems).toEqual(['reads at grade 44.6, above 44']);
    expect(T.checkTone(dense, 'walk-me-through', 45).problems).toEqual([]);
    expect(T.checkTone(dense, 'walk-me-through', 44).problems).toEqual(['reads at grade 44.6, above 44']);
  });
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
