import type { JourneyContext, JourneyImpl } from '@zthr/intent';
import { routedEgress, type Egress } from '@zthr/egress';
import { startAll } from '../../campus-services/src/index.js';
import { openAt } from '../src/integrations/campus.js';
import { PERSONAS } from '../src/server/demo.js';
import { COLLEGES } from '../src/domain/colleges.js';
import { Advocate, type Delivered } from '../src/agents/advocate.js';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import { checkTone, readingGrade } from '../src/domain/tone.js';
import { daysBetween } from '../src/domain/dates.js';
import { leadDays } from '../src/domain/planner.js';
import { DEFAULT_DIAL, type ClassMeeting, type Shift, type Student } from '../src/domain/types.js';

/**
 * Journey implementations for the locked cards in control/journeys. Each one
 * walks the Advocate the way the persona would, through the same methods the
 * text channel and web app use, and checks every forbidden outcome on its card.
 */
export const DAY = '2026-11-02'; // a Monday
export interface JourneyApp {
  a: Advocate;
}

export const makeApp = (nowIso = `${DAY}T15:00:00Z`, catalog = DAYTON_CATALOG): JourneyApp => ({
  a: new Advocate({ today: () => DAY, now: () => new Date(nowIso), catalog }),
});

let phoneSeq = 0;
function student(app: JourneyApp, ctx: JourneyContext, over: Partial<Student> & Pick<Student, 'chosenName'>): Student {
  phoneSeq += 1;
  return app.a.createStudent({
    zip: '45402',
    phone: `+1937555${String(1000 + phoneSeq).slice(-4)}`,
    ...over,
    dial: { ...DEFAULT_DIAL, depth: ctx.mode, channel: ctx.channel, ...(over.dial ?? {}) },
  });
}

/** Show a message the way each channel would: by text for text students, in the app otherwise. */
function show(app: JourneyApp, ctx: JourneyContext, m: Parameters<Advocate['deliver']>[0]): Delivered {
  ctx.act('read a message');
  return app.a.deliver(m, { force: true });
}

function say(app: JourneyApp, ctx: JourneyContext, s: Student, text: string): Delivered[] {
  ctx.act(`say: ${text}`);
  if (ctx.channel === 'text' && s.phone) {
    const before = app.a.messages(s.id).length;
    app.a.textIn(s.phone, text);
    return app.a.messages(s.id).slice(before);
  }
  return app.a.converse(s.id, text);
}

const delivered = (app: JourneyApp, s: Student) => app.a.messages(s.id);
const anyHeld = (app: JourneyApp, s: Student) => delivered(app, s).filter((m) => m.status === 'held');
const noStep = (app: JourneyApp, s: Student) => delivered(app, s).filter((m) => m.urgency !== 'safety' && m.nextSteps.length === 0);
const STATUS_QUESTION = /\b(what is your|are you a|do you have|tell me your|enter your)\b[^.?]*\b(citizen(ship)?|immigration|legal status|green card|visa|social security)\b/i;

function forbidTone(app: JourneyApp, ctx: JourneyContext, s: Student) {
  const held = anyHeld(app, s);
  ctx.forbid('a message fails the tone rubric', held.length > 0, held.map((h) => h.holdReason).join(' | '));
}

const overlaps = (date: string, start: string, minutes: number, classes: ClassMeeting[], shifts: Shift[]) => {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s0 = toMin(start);
  const e0 = s0 + minutes;
  const wd = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const)[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
  return (
    classes.some((c) => c.days.includes(wd) && s0 < toMin(c.end) && e0 > toMin(c.start)) ||
    shifts.some((x) => x.date === date && s0 < toMin(x.end) && e0 > toMin(x.start))
  );
};

const ENG_SYLLABUS = `ENG 1101 English Composition I - Fall 2026
Use of AI: Generative AI tools such as ChatGPT may not be used to write any graded work unless you disclose it and cite the tool.
Week 9 (Oct 27): Read Chapter 6
Tue Nov 4 - Essay 2 draft due
Thursday, November 6: Essay 2 final due
11/18 Quiz on rhetorical appeals
Dec 9 Final portfolio due`;

/** An app wired to the synthetic campus services through its egress door, at a campus-local wall time. */
function campusApp(localIso: string, scenario?: string, egress?: Egress) {
  let now = new Date(`${localIso}-05:00`);
  const e = egress ?? routedEgress(startAll(), undefined, (): Record<string, string> => (scenario ? { 'x-twin-scenario': scenario } : {}));
  const a = new Advocate({ today: () => localIso.slice(0, 10), now: () => now, egress: e });
  return { a, setNow: (iso: string) => void (now = new Date(`${iso}-05:00`)) };
}

export const JOURNEYS: Record<string, JourneyImpl<JourneyApp>> = {
  'persona-1b-bill-gap': async (app, ctx) => {
    const s = student(app, ctx, {
      chosenName: 'Maria',
      age: 27,
      household: { size: 3, monthlyGrossIncome: 2100, monthlyEarnedIncome: 2100, childrenUnder6: 1, childrenUnder12: 2, singleParent: true },
      enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 30, workStudy: false },
    });
    ctx.act('enter bills and pay');
    app.a.setMoney(s.id, 300, [
      { name: 'Rent', amount: 1050, dueDay: 1, kind: 'rent' },
      { name: 'Phone', amount: 60, dueDay: 15, kind: 'phone' },
      { name: 'Electric', amount: 140, dueDay: 20, kind: 'utility' },
    ], { amount: 400, next: '2026-11-05', everyDays: 14 });
    const m = app.a.moneyCheck(s.id);
    ctx.expect(!!m, 'a gap is found before it happens');
    const d = show(app, ctx, m!);
    ctx.expect(/Rent/.test(d.text) && /December 1/.test(d.text), 'the gap names the bill and the date ahead of time');
    ctx.expect(d.nextSteps.some((n) => /emergency grant/i.test(n.label)), 'a real way to cover it is offered');
    ctx.expect(app.a.drafts(s.id).some((x) => x.to === 'landlord'), 'a message to the landlord is drafted');
    if (ctx.channel === 'text') ctx.expect(app.a.sms.outbox.some((x) => x.to === s.phone && /Rent/.test(x.body)), 'the text arrives by SMS');
    forbidTone(app, ctx, s);
    ctx.forbid('a message reports a problem without a next step', noStep(app, s).length > 0);
    ctx.forbid("something is sent without the student's approval", app.a.outboundLog.length > 0);
  },

  'persona-2c-adult-know-how': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Jayden', age: 19, enrollment: { college: 'wright-state', creditHours: 15 } });
    const lease = say(app, ctx, s, 'how do I sign a lease for an apartment?');
    ctx.expect(lease.some((m) => /photos/i.test(m.text)), 'lease steps are plain and practical');
    const bank = say(app, ctx, s, 'how do I open a bank account');
    ctx.expect(bank.some((m) => /overdraft/i.test(m.text)), 'bank account steps cover fees');
    const audit = say(app, ctx, s, 'the IRS sent me an audit letter, what do I do');
    const routed = audit.some((m) => /won't guess/.test(m.text) && /VITA|irs\.gov\/vita/i.test(m.text));
    forbidTone(app, ctx, s);
    ctx.forbid('the team gives licensed legal or tax advice instead of routing it', !routed);
  },

  'persona-3c-no-judgment': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Darnell', age: 34, household: { size: 1, monthlyGrossIncome: 1600 }, enrollment: { college: 'sinclair', creditHours: 9, degreeSeeking: true, weeklyWorkHours: 40 } });
    ctx.act('seal a fact');
    app.a.seal(s.id, 'justice_involvement', 'home from prison eight months, on parole');
    say(app, ctx, s, 'I need food help');
    say(app, ctx, s, 'today');
    say(app, ctx, s, 'can you help with my electric bill');
    const leaked = delivered(app, s).some((m) => /\b(parole|prison|record|incarcerat|convict|felon)/i.test(m.text));
    const opened = app.a.ledger.entries(s.id).some((e) => e.kind === 'release' && e.subject === 'sealed:justice_involvement');
    ctx.expect(delivered(app, s).length >= 3, 'he gets the same help as anyone');
    ctx.forbid('a sealed fact appears in a message or is opened by an ungranted identity', leaked || opened);
    forbidTone(app, ctx, s);
  },

  'persona-4c-short-and-direct': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Ana', age: 31, household: { size: 1, monthlyGrossIncome: 2400 }, enrollment: { college: 'wright-state', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 10 } });
    app.a.addClasses(s.id, [{ course: 'EGR 1010', days: ['Mon', 'Wed'], start: '10:10', end: '11:05', building: 'Russ Engineering Center', room: '146' }]);
    say(app, ctx, s, 'today');
    say(app, ctx, s, 'I need help with food');
    say(app, ctx, s, 'what do I qualify for');
    const long = delivered(app, s).filter((m) => m.text.length > 320);
    ctx.forbid('a brief-mode message runs long', long.length > 0, long.map((m) => `${m.author}:${m.text.length}`).join(', '));
    ctx.forbid('a message reports a problem without a next step', noStep(app, s).length > 0);
  },

  'persona-5b-college-explained': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Tyler', age: 18, enrollment: { college: 'sinclair', creditHours: 12 } });
    const qs = ["what's a registrar", 'how do I drop a class', 'what is SAP'];
    const answers = qs.flatMap((q) => say(app, ctx, s, q));
    ctx.expect(answers.length === 3, 'every question gets an answer');
    forbidTone(app, ctx, s);
    ctx.forbid('an answer claims a college rule without pointing to the office that decides', answers.some((m) => !/is the place to confirm/.test(m.text)));
  },

  'persona-5c-money-saved': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Tyler', age: 18, household: { size: 4, monthlyGrossIncome: 3400 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 22 } });
    ctx.act('add required books');
    const [psy] = app.a.books(s.id, [{ course: 'PSY 1100', title: 'Psychology', isbn: '9781975076450' }]);
    const costs = psy!.options.map((o) => o.cost);
    const firstPaid = costs.indexOf('varies');
    const lastFree = costs.lastIndexOf('free');
    ctx.expect(costs.filter((c) => c === 'free').length >= 2, 'at least two free routes are offered');
    ctx.forbid('a paid option is listed before the free ones', firstPaid !== -1 && firstPaid < lastFree);
    ctx.act('look for transportation help');
    const help = app.a.findHelp(s.id, 'transportation');
    const bad = help.options.filter((o) => o.eligibility?.status === 'unlikely' || Date.parse(DAY) - Date.parse(o.resource.verifiedOn) > o.resource.freshnessDays * 86_400_000);
    ctx.forbid('a resource is offered that is stale or the student is ineligible for', bad.length > 0);
  },

  'persona-6a-calendar-mastery': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Priya', age: 20, enrollment: { college: 'wright-state', creditHours: 17 } });
    ctx.act('upload syllabus');
    const up = app.a.uploadSyllabus(s.id, 'ENG 1101', ENG_SYLLABUS, '2026-08-24');
    show(app, ctx, up.message);
    ctx.act('confirm dates');
    app.a.confirmDeadlines(s.id, 'all');
    const ahead = app.a.lookAhead(s.id);
    ahead.forEach((m) => show(app, ctx, m));
    const due = app.a.deadlines(s.id).filter((d) => !d.done && daysBetween(DAY, d.due) >= 0 && daysBetween(DAY, d.due) <= leadDays(d) + 2);
    const raisedTitles = ahead.map((m) => m.text);
    const missed = due.filter((d) => !raisedTitles.some((t) => t.includes(d.title)));
    ctx.forbid('a deadline the team could see coming is raised too late to act on', missed.length > 0, missed.map((d) => d.title).join(', '));
    const meet = app.a.addMeeting(s.id, { title: 'ENG 1101 peer review group', date: '2026-11-03', start: '16:00', attendees: ['Jordan', 'Mia', 'Prof. Lee'], course: 'ENG 1101', purpose: 'feedback on Essay 2 before the final is due' });
    const prep = show(app, ctx, app.a.meetingPrep(s.id, meet.id));
    ctx.expect(/Who:/.test(prep.text) && /Still to do/.test(prep.text) && /Why it matters/.test(prep.text), 'meeting prep covers who, what remains and why');
    forbidTone(app, ctx, s);
  },

  'persona-7b-money-and-shifts': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Destiny', age: 22, household: { size: 1, monthlyGrossIncome: 1500, monthlyEarnedIncome: 1500 }, enrollment: { college: 'wright-state', creditHours: 15, degreeSeeking: true, weeklyWorkHours: 24 } });
    const classes: ClassMeeting[] = [{ course: 'BIO 1120', days: ['Mon', 'Wed', 'Fri'], start: '09:05', end: '10:00' }, { course: 'COM 1010', days: ['Tue', 'Thu'], start: '12:30', end: '13:50' }];
    const shifts: Shift[] = [
      { date: '2026-11-02', start: '16:00', end: '21:00', employer: 'Grocery' },
      { date: '2026-11-03', start: '14:00', end: '18:00', employer: 'Campus library' },
      { date: '2026-11-04', start: '16:00', end: '21:00', employer: 'Grocery' },
    ];
    app.a.addClasses(s.id, classes);
    app.a.addShifts(s.id, shifts);
    app.a.addDeadline(s.id, { title: 'Lab report 4', course: 'BIO 1120', due: '2026-11-05', kind: 'assignment', effortHours: 4, source: { type: 'syllabus', line: 'Lab report 4 due Nov 5' }, confirmed: true });
    say(app, ctx, s, 'what do I qualify for');
    say(app, ctx, s, 'today');
    const ahead = app.a.lookAhead(s.id);
    ahead.forEach((m) => show(app, ctx, m));
    const holds = ahead.flatMap((m) => m.nextSteps.filter((n) => n.action.startsWith('hold-block:')).map((n) => n.action.split(':')));
    ctx.expect(holds.length > 0, 'a study block is proposed');
    const clash = holds.some(([, , date, hh, mm]) => overlaps(date!, `${hh}:${mm}`, 120, classes, shifts));
    ctx.forbid('a study block is placed on top of a class or a shift', clash);
    const offered = app.a.screen(s.id).filter((r) => r.status === 'likely');
    ctx.expect(offered.length > 0, 'money found');
    ctx.forbid('a resource is offered that is stale or the student is ineligible for', app.a.findHelp(s.id, 'food').options.some((o) => o.eligibility?.status === 'unlikely'));
  },

  'persona-8a-small-steps': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Sam', age: 21, dial: { readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } });
    app.a.addClasses(s.id, [{ course: 'ENG 1101', days: ['Tue', 'Thu'], start: '11:00', end: '12:15' }]);
    const d = app.a.addDeadline(s.id, { title: 'Essay 2', course: 'ENG 1101', due: '2026-11-09', kind: 'assignment', effortHours: 6, source: { type: 'syllabus', line: 'Essay 2 due Nov 9' }, confirmed: true });
    const plan = show(app, ctx, app.a.planMessage(s.id, d.id));
    const minutes = [...plan.text.matchAll(/(\d+) min\)/g)].map((m) => Number(m[1]));
    ctx.expect(minutes.length >= 4, 'the work is broken into several steps');
    ctx.forbid('a step is longer than an hour', minutes.some((n) => n > 60));
    forbidTone(app, ctx, s);
  },

  'persona-9a-simple': async (app, ctx) => {
    const phone = '+19375559090';
    const replies: string[] = [];
    for (const t of ['I need help with my electric bill', 'Sinclair 45417', '2 people, $1400', '6 credits, 20 hours', 'walk me through']) {
      ctx.act(`text: ${t}`);
      replies.push(...app.a.textIn(phone, t));
    }
    const s = app.a.findByPhone(phone);
    ctx.expect(!!s, 'Linda is helped without installing anything');
    ctx.expect(replies.some((r) => /HEAP|energy|utility|electric/i.test(r)), 'she gets help with the electric bill');
    ctx.forbid('the student is asked to install an app or create an account before getting help', replies.some((r) => /\b(download|install|create an account|sign up|app store)\b/i.test(r)));
    const tooHard = replies.filter((r) => readingGrade(r) > 9);
    ctx.forbid('a message fails the tone rubric', anyHeld(app, s!).length > 0 || tooHard.length > 0, tooHard.map((r) => r.slice(0, 60)).join(' | '));
  },

  'persona-10a-privacy': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Luis', age: 19, household: { size: 5, monthlyGrossIncome: 3900 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 15 } });
    ctx.act('turn on forwarding');
    app.a.connectSource(s.id, 'forwarding');
    const first = app.a.forward(s.id, 'Your service will be disconnected on 11/12/2026 unless $180.00 is paid.', { from: 'utility', subject: 'Final notice' });
    if (first.message) show(app, ctx, first.message);
    say(app, ctx, s, 'what do I qualify for');
    ctx.act('turn off forwarding');
    app.a.disconnectSource(s.id, 'forwarding');
    const inboundBefore = app.a.evidence.events('inbound').length;
    const second = app.a.forward(s.id, 'Room change: CHE 1211 moved to Building 12 room 140', { subject: 'Room change' });
    ctx.forbid('data from a turned-off source is used', !second.refused || app.a.evidence.events('inbound').length !== inboundBefore);
    ctx.forbid('the team asks about immigration or citizenship status', delivered(app, s).some((m) => STATUS_QUESTION.test(m.text)));
    ctx.act('export');
    const exp = app.a.exportData(s.id);
    ctx.expect(Array.isArray(exp.students) && Array.isArray(exp.consent), 'export includes everything, with the consent ledger');
    ctx.act('delete');
    const del = app.a.deleteStudent(s.id);
    ctx.forbid('anything remains after deletion', del.remaining !== 0 || app.a.sealed.raw(s.id) !== undefined);
  },

  'persona-10c-aid-that-fits': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Luis', age: 19, household: { size: 5, monthlyGrossIncome: 3900 }, enrollment: { college: 'sinclair', creditHours: 12, degreeSeeking: true, weeklyWorkHours: 15 } });
    ctx.act('see what fits');
    const results = app.a.screen(s.id);
    show(app, ctx, app.a.moneyFoundMessage(s.id));
    ctx.expect(results.find((r) => r.program === 'snap')?.statusRuleNote !== undefined, 'programs with status rules show the rule');
    ctx.forbid('an eligibility result is shown without its rule and source', results.some((r) => !r.source || (r.reasons.length === 0 && r.needs.length === 0)));
    ctx.forbid('the team asks about immigration or citizenship status', delivered(app, s).some((m) => STATUS_QUESTION.test(m.text)));
  },

  'persona-11a-fafsa-without-parents': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Alex', pronouns: 'they/them', age: 20, enrollment: { college: 'wright-state', creditHours: 15 } });
    ctx.act('seal family circumstances');
    app.a.seal(s.id, 'family_circumstances', 'estranged from parents since 17; no contact');
    app.a.grantToPlaybook(s.id, 'family_circumstances', 'fafsa-2027-28');
    const id = 'fafsa-2027-28';
    show(app, ctx, app.a.playbookMessage(s.id, app.a.startPlaybook(s.id, id)));
    app.a.playbookEvent(s.id, id, { type: 'confirm' });
    let run = app.a.playbookEvent(s.id, id, { type: 'answer', value: 'no' });
    ctx.expect(run.stepId === 'unusual-circumstances', 'the no-parents answer takes the unusual circumstances path');
    show(app, ctx, app.a.playbookMessage(s.id, run));
    run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    ctx.expect(run.stepId === 'gather-letter', 'documentation is lined up next');
    run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    ctx.expect(run.stepId === 'tell-aid-office', 'a note to the aid office is next');
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:tell-aid-office`);
    ctx.expect(!!draft && draft.body.includes('Alex'), 'the note is drafted in Alex\'s chosen name');
    ctx.act('try to send without approving');
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    const sent = await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    run = app.a.playbookEvent(s.id, id, { type: 'approved' });
    ctx.expect(sent.sent && run.stepId === 'submission-summary', 'Alex sends it and the playbook waits for the summary');
    ctx.forbid("something is sent without the student's approval", unapproved.sent || app.a.outboundLog.length !== 1);
    const leaked = delivered(app, s).some((m) => /estranged|no contact since/i.test(m.text)) || /estranged/i.test(draft!.body);
    const badOpen = app.a.ledger.entries(s.id).some((e) => e.kind === 'release' && e.detail.identity !== 'playbook:fafsa-2027-28');
    ctx.forbid('a sealed fact appears in a message or is opened by an ungranted identity', leaked || badOpen);
  },

  'persona-12b-work-fitted-coursework': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Keisha', age: 25, zip: '30310', county: 'Fulton', enrollment: { college: 'wright-state', creditHours: 6 } });
    const shifts: Shift[] = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((date) => ({ date, start: '08:00', end: '17:00', employer: 'Hospital billing office' }));
    app.a.addShifts(s.id, shifts);
    app.a.addDeadline(s.id, { title: 'Case study 3', course: 'HCA 3100', due: '2026-11-07', kind: 'assignment', effortHours: 6, source: { type: 'calendar-feed', ref: 'cs3' }, confirmed: true });
    const ahead = app.a.lookAhead(s.id);
    ahead.forEach((m) => show(app, ctx, m));
    const holds = ahead.flatMap((m) => m.nextSteps.filter((n) => n.action.startsWith('hold-block:')).map((n) => n.action.split(':')));
    ctx.forbid('a deadline the team could see coming is raised too late to act on', ahead.length === 0);
    ctx.forbid('a study block is placed on top of a class or a shift', holds.length === 0 || holds.some(([, , date, hh, mm]) => overlaps(date!, `${hh}:${mm}`, 120, [], shifts)));
  },

  'req-crisis-routing': async (_app, ctx) => {
    const quiet = makeApp(`${DAY}T08:30:00Z`); // 3:30 a.m. Eastern
    const phrasings = ['I want to kill myself', 'i dont want to be alive anymore', 'my boyfriend hits me', 'I took too many pills'];
    const results: Delivered[] = [];
    for (const p of phrasings) {
      const s = student(quiet, ctx, { chosenName: 'Any', enrollment: { college: 'sinclair' } });
      results.push(...say(quiet, ctx, s, p));
    }
    ctx.forbid('a crisis message is answered without 988', results.length < phrasings.length || results.some((m) => !/988/.test(m.text)));
    ctx.forbid('a crisis message waits for quiet hours or limits', results.some((m) => m.status !== 'delivered'));
  },

  'req-stale-never-offered': async (_app, ctx) => {
    const stale = DAYTON_CATALOG.map((r) => (r.id === 'house-of-bread' ? { ...r, verifiedOn: '2026-01-15' } : r));
    const app = makeApp(undefined, stale);
    const s = student(app, ctx, { chosenName: 'Any', enrollment: { college: 'sinclair', creditHours: 12 } });
    ctx.act('look for food');
    const food = app.a.findHelp(s.id, 'food');
    ctx.forbid('a resource is offered that is stale or the student is ineligible for', food.options.some((o) => o.resource.id === 'house-of-bread' || o.eligibility?.status === 'unlikely'));
    ctx.act('look for tutoring help, which has no listed resource yet');
    const before = app.a.evidence.events('unmet_need').length;
    const m = show(app, ctx, app.a.helpMessage(s.id, 'academic'));
    ctx.forbid('a gap is hidden instead of counted', !/couldn't find/.test(m.text) || app.a.evidence.events('unmet_need').length <= before);
  },

  'req-quiet-hours': async (_app, ctx) => {
    const night = makeApp(`${DAY}T04:30:00Z`); // 11:30 p.m. Eastern
    const s = student(night, ctx, { chosenName: 'Any', enrollment: { college: 'sinclair' } });
    ctx.act('send a routine message at night');
    const m1 = night.a.deliver({ studentId: s.id, author: 'test', urgency: 'routine', text: 'Your week looks open on Thursday. Want to plan it?', nextSteps: [{ label: 'Plan', action: 'plan' }] });
    const noon = makeApp(`${DAY}T17:00:00Z`);
    const s2 = student(noon, ctx, { chosenName: 'Any', enrollment: { college: 'sinclair' } });
    const statuses: string[] = [];
    for (let i = 0; i < 5; i++) {
      ctx.act('send routine');
      statuses.push(noon.a.deliver({ studentId: s2.id, author: 'test', urgency: 'routine', text: `Quick idea number ${i + 1}. Want to try it?`, nextSteps: [{ label: 'Yes', action: 'y' }] }).status);
    }
    ctx.forbid('a routine message is delivered in quiet hours or over the daily limit', m1.status === 'delivered' || statuses.filter((x) => x === 'delivered').length > 4);
  },
  'persona-4a-gi-bill-tracked': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Ana', age: 31, enrollment: { college: 'wright-state', creditHours: 12 } });
    ctx.act('seal veteran status');
    app.a.seal(s.id, 'veteran_status', 'Army veteran, Post-9/11 GI Bill chapter 33');
    app.a.grantToPlaybook(s.id, 'veteran_status', 'gi-bill-term');
    const id = 'gi-bill-term';
    show(app, ctx, app.a.playbookMessage(s.id, app.a.startPlaybook(s.id, id)));
    let run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:tell-certifying-official`);
    ctx.expect(!!draft, 'a note to the certifying official is drafted');
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    run = app.a.playbookEvent(s.id, id, { type: 'approved' });
    show(app, ctx, app.a.playbookMessage(s.id, run));
    ctx.expect(run.stepId === 'monthly-verification', 'monthly verification is next');
    run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    ctx.expect(run.status === 'waiting', 'the playbook watches for the payment');
    run = app.a.playbookEvent(s.id, id, { type: 'tick', today: '2026-12-15' });
    const recovery = app.a.playbookMessage(s.id, run);
    ctx.forbid('a late payment goes unnoticed', run.status !== 'unresolved' || recovery.nextSteps.length === 0);
    ctx.forbid("something is sent without the student's approval", unapproved.sent || app.a.outboundLog.length !== 1);
    const leaked = delivered(app, s).some((m) => /chapter 33|Army veteran/i.test(m.text));
    const badOpen = app.a.ledger.entries(s.id).some((e) => e.kind === 'release' && e.detail.identity !== 'playbook:gi-bill-term');
    ctx.forbid('a sealed fact appears in a message or is opened by an ungranted identity', leaked || badOpen);
  },

  'persona-8c-accommodation-letters': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Sam', pronouns: 'they/them', age: 21, dial: { readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } });
    ctx.act('seal accommodations');
    app.a.seal(s.id, 'disability_accommodations', 'extended test time and a quiet testing room');
    app.a.grantToPlaybook(s.id, 'disability_accommodations', 'accommodation-letters');
    const id = 'accommodation-letters';
    show(app, ctx, app.a.playbookMessage(s.id, app.a.startPlaybook(s.id, id)));
    app.a.playbookEvent(s.id, id, { type: 'confirm' });
    let run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    show(app, ctx, app.a.playbookMessage(s.id, run));
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:note-to-office`);
    ctx.expect(!!draft, 'a note to the disability office is drafted');
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    run = app.a.playbookEvent(s.id, id, { type: 'approved' });
    ctx.expect(run.stepId === 'confirm-received' && run.status === 'waiting', 'the team checks the letters arrived');
    ctx.forbid("something is sent without the student's approval", unapproved.sent || app.a.outboundLog.length !== 1);
    const leaked = delivered(app, s).some((m) => /extended test time|quiet testing/i.test(m.text)) || /extended|quiet/i.test(draft!.body);
    ctx.forbid('a sealed fact appears in a message or is opened by an ungranted identity', leaked);
    forbidTone(app, ctx, s);
  },

  'persona-9b-letter-explained': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Linda', age: 46, household: { size: 2, monthlyGrossIncome: 1400 }, enrollment: { college: 'sinclair', creditHours: 6, weeklyWorkHours: 20 } });
    const letter = 'Montgomery County Job and Family Services\nYour SNAP interview is scheduled for Nov 18 at 10:00 AM. Please call (937) 225-4148 if you cannot attend.';
    const [m] = say(app, ctx, s, `explain this letter: ${letter}`);
    ctx.expect(!!m && /Job and Family Services/.test(m.text), 'says who sent it');
    ctx.expect(!!m && /renew|interview/i.test(m.text), 'says what it means and what to do');
    ctx.expect(!!m && /November 18/.test(m.text), 'says by when');
    const pick = m!.nextSteps.findIndex((n) => n.action.startsWith('add-date:2026-11-18'));
    ctx.expect(pick === 0, 'the first choice puts the interview on the calendar');
    say(app, ctx, s, '1');
    ctx.expect(app.a.deadlines(s.id).some((d) => d.due === '2026-11-18' && d.kind === 'appointment'), 'the interview is on the calendar');
    const invented = delivered(app, s).some((x) => [...x.text.matchAll(/(\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g)].some((p) => p[0].trim() !== '(937) 225-4148') || /\$\s?\d/.test(x.text));
    ctx.forbid('a date, amount or phone number appears that is not in the letter', invented);
    ctx.forbid("something is sent without the student's approval", app.a.outboundLog.length > 0);
    forbidTone(app, ctx, s);
  },

  'playbook-snap-recertification': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Linda', age: 46, household: { size: 2, monthlyGrossIncome: 1400 }, enrollment: { college: 'sinclair', creditHours: 6, weeklyWorkHours: 20 } });
    const notice = 'Montgomery County Job and Family Services. Your SNAP benefits must be recertified. Submit your renewal by Nov 30 or your benefits may stop.';
    const [m] = say(app, ctx, s, `I got my SNAP recertification notice: ${notice}`);
    ctx.expect(!!m && /recertification/i.test(m.text), 'the recertification playbook starts');
    ctx.expect(app.a.deadlines(s.id).some((d) => d.due === '2026-11-30' && d.kind === 'benefit'), 'the due date from the notice is on the calendar');
    ctx.expect(app.a.reminders(s.id).some((r) => r.about === 'snap-recertification' && r.at.slice(0, 10) < '2026-11-30'), 'a reminder is set before the deadline');
    const id = 'snap-recertification';
    const run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    ctx.act('see the documents step');
    const docs = show(app, ctx, app.a.playbookMessage(s.id, run));
    ctx.expect(run.stepId === 'documents' && /Proof of income/i.test(JSON.stringify(app.a.playbooks.get(id))) && docs.nextSteps.length > 0, 'documents are lined up next');
    ctx.forbid("something is sent without the student's approval", app.a.outboundLog.length > 0);
    forbidTone(app, ctx, s);
  },

  'scout-montgomery-caregiving': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Any', zip: '45402', county: 'Montgomery', enrollment: { college: 'sinclair', creditHours: 12 } });
    ctx.act('look for caregiving help');
    const before = app.a.evidence.events('unmet_need').length;
    const m = show(app, ctx, app.a.helpMessage(s.id, 'caregiving'));
    const offered = app.a.findHelp(s.id, 'caregiving').options;
    const stale = offered.filter((o) => daysBetween(o.resource.verifiedOn, DAY) > 90 || o.eligibility?.status === 'unlikely');
    ctx.forbid('a resource is offered that is stale or the student is ineligible for', stale.length > 0, stale.map((o) => o.resource.id).join(', '));
    ctx.forbid('a gap is hidden instead of counted', offered.length === 0 && (!/couldn't find/.test(m.text) || app.a.evidence.events('unmet_need').length <= before));
    ctx.expect(offered.length > 0 || /couldn't find/.test(m.text), 'a verified resource is offered, or the gap is said plainly');
  },

  'p2-food-on-campus-late': async (_app, ctx) => {
    for (const [at, scenario] of [['2026-11-02T23:30', undefined], ['2026-11-03T03:00', undefined], ['2026-11-02T23:30', 'outage']] as const) {
      const { a } = campusApp(at, scenario);
      const s = PERSONAS.Jayden!(a);
      a.setDial(s.id, { depth: ctx.mode, channel: ctx.channel });
      await a.operator.tick();
      const [m] = say({ a }, ctx, a.student(s.id), "what's open on campus?");
      const feed = a.campusFeed('wright-state');
      if (scenario === 'outage') {
        ctx.forbid('a missing dining feed is shown as nothing being open', !m || /Nothing on campus is open/.test(m.text));
        ctx.expect(!!m && /can't see campus dining/.test(m.text), 'says plainly it cannot see campus dining');
        continue;
      }
      const { date, min } = a.localNow();
      const reallyOpen = new Set(openAt(feed!, date, min).map((o) => o.location.name));
      const named = (feed?.locations ?? []).filter((l) => m?.text.includes(`${l.name},`)).map((l) => l.name);
      ctx.forbid('a place is said to be open when its posted hours say it is closed', named.some((n) => !reallyOpen.has(n)), named.join(', '));
      ctx.expect(reallyOpen.size ? /Open now on campus/.test(m!.text) : /Nothing on campus is open right now\. .+ opens/.test(m!.text), 'what is open, or what opens next');
      forbidTone({ a }, ctx, a.student(s.id));
    }
  },

  'p2-bus-to-class': async (_app, ctx) => {
    const { a, setNow } = campusApp('2026-11-02T06:30', 'snow-delays');
    const s = PERSONAS.Maria!(a);
    a.setDial(s.id, { depth: ctx.mode, channel: ctx.channel });
    await a.operator.tick();
    ctx.act('pick a home stop');
    a.perform(s.id, 'set-stop:salem-catalpa');
    await a.operator.tick();
    const plan = a.commutePlans(s.id).find((p) => p.date === '2026-11-02')!;
    ctx.forbid('a trip is offered that arrives after the class starts', a.commutePlans(s.id).some((p) => p.itineraries.some((it) => it.arrive > p.classStart)));
    const it = plan.itineraries[0]!;
    const dep = Number(it.depart.slice(0, 2)) * 60 + Number(it.depart.slice(3));
    setNow(`2026-11-02T${String(Math.floor((dep - 15) / 60)).padStart(2, '0')}:${String((dep - 15) % 60).padStart(2, '0')}`);
    await a.operator.tick();
    const [m] = say({ a }, ctx, a.student(s.id), 'when should I leave for class?');
    ctx.expect(!!m && m.text.startsWith('For BIO 1111'), 'says when to leave for the first class');
    const lateBtn = m!.nextSteps.findIndex((n) => n.action.startsWith('draft:late:'));
    ctx.expect(lateBtn === 0, 'the first choice is a note to the instructor when the bus will make the student late');
    ctx.act('open the note');
    const draftMsg = a.perform(s.id, m!.nextSteps[lateBtn]!.action)!.message;
    ctx.forbid("something is sent without the student's approval", a.outboundLog.length > 0);
    ctx.act('approve and send');
    a.perform(s.id, draftMsg.nextSteps[0]!.action);
    await new Promise((r) => setTimeout(r, 0));
    ctx.expect(a.outboundLog.length === 1, 'the note goes out once, after approval');
    setNow('2026-11-02T09:30');
    const stale = a.nextBusMessage(s.id);
    ctx.forbid('live bus times older than ten minutes are shown as live', /^Next buses at/.test(stale.text));
    forbidTone({ a }, ctx, a.student(s.id));
  },

  'p2-study-room-booked-once': async (_app, ctx) => {
    const services = startAll();
    const inner = routedEgress(services);
    let drop = 1;
    const flaky: Egress = { log: inner.log, send: async (req) => { if (req.method === 'POST' && drop-- > 0) { await inner.send(req); throw new Error('connection reset'); } return inner.send(req); } };
    const { a } = campusApp('2026-11-04T13:20', undefined, flaky);
    const s = PERSONAS.Jayden!(a);
    await a.operator.tick();
    ctx.act('look for a study spot');
    const m = a.studySpotsMessage(s.id);
    ctx.act('book the room');
    const r = a.perform(s.id, m.nextSteps[0]!.action)!;
    ctx.forbid('the student is told a booking is done before the room system confirms it', /Booked|booked\./.test(r.message.text) || a.messages(s.id).some((x) => /^Booked:/.test(x.text)));
    ctx.act('book it again by mistake');
    a.perform(s.id, m.nextSteps[0]!.action);
    await a.operator.tick();
    await a.operator.tick();
    const avail = (await (await services['places.campus.example']!.request('/v1/rooms/wright-room-241/availability?date=2026-11-04')).json()) as { free: string[] };
    ctx.forbid('the same booking is made twice', a.operator.dispatches(s.id).length !== 1 || avail.free.includes('14:00') || !avail.free.includes('15:00'));
    ctx.expect(a.messages(s.id).filter((x) => /^Booked:/.test(x.text)).length === 1, 'told once, after confirmation');
  },

  'p2-jobs-that-fit': async (_app, ctx) => {
    const { a } = campusApp('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.setDial(s.id, { depth: ctx.mode, channel: ctx.channel });
    a.addShifts(s.id, [{ date: '2026-11-07', start: '08:00', end: '17:00', employer: 'Store' }]);
    await a.operator.tick();
    const [m] = say({ a }, ctx, a.student(s.id), 'any part-time jobs that fit my week?');
    const posts = a.campusFeed('sinclair')!.postings;
    const listed = posts.filter((p) => m!.text.includes(p.title));
    const classes = a.store.list<ClassMeeting>('classes', s.id);
    const clash = listed.filter((p) => p.schedule.some((x) => classes.some((c) => c.days.includes(x.day) && x.start < c.end && c.start < x.end) || (x.day === 'Sat' && x.start < '17:00' && '08:00' < x.end)));
    ctx.expect(listed.length > 0, 'lists jobs that fit');
    ctx.forbid('a job is listed whose hours overlap a class or a work shift', clash.length > 0, clash.map((p) => p.title).join(', '));
    ctx.act('draft a note about the first job');
    const d = a.perform(s.id, m!.nextSteps[0]!.action)!;
    ctx.forbid("something is sent without the student's approval", a.outboundLog.length > 0);
    ctx.expect(/Nothing is sent until you say so/.test(d.message.text), 'the note waits for approval');
    forbidTone({ a }, ctx, a.student(s.id));
  },

  'p3-class-site-sync': async (_app, ctx) => {
    let scenario: string | undefined;
    const services = startAll();
    const egress = routedEgress(services, undefined, (): Record<string, string> => (scenario ? { 'x-twin-scenario': scenario } : {}));
    const { a } = campusApp('2026-11-02T12:00', undefined, egress);
    const s = PERSONAS.Jayden!(a);
    ctx.act('connect the class site');
    a.connectClassSite(s.id, 'lms-jayden');
    await a.operator.tick();
    await a.operator.tick();
    const refs = a.deadlines(s.id).map((d) => d.source.ref).filter(Boolean);
    ctx.forbid('an assignment appears twice in the student\'s dates', new Set(refs).size !== refs.length);
    ctx.expect(refs.length > 30, 'every assignment is in the student\'s dates');
    scenario = 'reschedule';
    await a.operator.tick();
    const tok = { authorization: 'Bearer lms-jayden', 'x-twin-scenario': 'reschedule' };
    const courses = (await (await services['lms.campus.example']!.request('/api/v1/courses', { headers: tok })).json()) as { id: number }[];
    const want = new Map<string, string>();
    for (const c of courses) for (const x of (await (await services['lms.campus.example']!.request(`/api/v1/courses/${c.id}/assignments`, { headers: tok })).json()) as { id: number; due_at: string }[]) want.set(`lms:${x.id}`, x.due_at.slice(0, 16));
    const stale = a.deadlines(s.id).filter((d) => d.source.ref && want.get(d.source.ref) !== d.due);
    ctx.forbid('a moved due date is left at its old date', stale.length > 0, stale.map((d) => d.title).join(', '));
    ctx.expect(a.messages(s.id).some((m) => /Your class site changed a date/.test(m.text)), 'the student is told');
    const opened = a.ledger.entries(s.id).filter((e) => e.kind === 'release');
    ctx.forbid('the class-site token is opened by anything but the sync job', opened.some((e) => e.detail.identity !== 'operator:class-site'));
  },

  'p4-mentor-introduction': async (_app, ctx) => {
    const { a } = campusApp('2026-11-02T12:00');
    const s = PERSONAS.Maria!(a);
    a.setCommunities(s.id, ['student-parents']);
    await a.operator.tick();
    ctx.act('ask for a mentor');
    const [m] = say({ a }, ctx, a.student(s.id), 'can you find me a mentor');
    const mentors = a.campusFeed('sinclair')!.mentors;
    const offered = mentors.filter((x) => m!.text.includes(x.displayName));
    ctx.forbid('a mentor with no open slot is offered', offered.some((x) => x.openSlots === 0));
    ctx.expect(offered[0]?.experiences.includes('student-parents') === true, 'a mentor who shares a chosen community comes first');
    ctx.act('ask for the introduction');
    const d = a.perform(s.id, m!.nextSteps[0]!.action)!;
    const body = a.drafts(s.id).find((x) => x.purpose.startsWith('mentor:'))!.body;
    const st = a.student(s.id);
    ctx.forbid('more than the student\'s first name and note is shared', [st.phone, st.zip, st.pronouns, String(st.age)].some((v) => v && body.includes(v)) || /\d{3}[-.]\d{4}|@/.test(body));
    ctx.forbid("something is sent without the student's approval", a.outboundLog.length > 0 || a.operator.dispatches(s.id).length > 0 || !/Nothing is sent until you say so/.test(d.message.text));
    ctx.act('approve the introduction');
    a.perform(s.id, d.message.nextSteps[0]!.action);
    await new Promise((r) => setTimeout(r, 0));
    await a.operator.tick();
    const sentReq = a.operator.dispatches(s.id)[0];
    ctx.forbid('more than the student\'s first name and note is shared', !sentReq || Object.keys(sentReq.request).sort().join(',') !== 'firstName,mentor,note' || sentReq.request.firstName !== st.chosenName.split(' ')[0]);
  },

  'p2-foster-youth-aid': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Alex', pronouns: 'they/them', age: 20, enrollment: { college: 'antioch', creditHours: 15 } });
    const id = 'foster-youth-aid';
    const [m] = say(app, ctx, s, 'I was in foster care until I was 18, can that help with college money?');
    ctx.expect(!!m && /independent/.test(m.text), 'the FAFSA counts them as independent');
    let run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    ctx.expect(run.stepId === 'etv-check', 'asks about the voucher');
    run = app.a.playbookEvent(s.id, id, { type: 'answer', value: 'yes' });
    show(app, ctx, app.a.playbookMessage(s.id, run));
    run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:ask-agency`);
    ctx.expect(!!draft && draft.body.includes('Alex') && draft.body.includes('Antioch College'), 'a note to the agency in Alex\'s chosen name');
    ctx.act('try to send without approving');
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    const sent = await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    ctx.forbid("something is sent without the student's approval", unapproved.sent || !sent.sent || app.a.outboundLog.length !== 1);
    const opened = app.a.ledger.entries(s.id).filter((e) => e.kind === 'release');
    const said = delivered(app, s).some((x) => /stated by the student|foster_care_history/.test(x.text)) || JSON.stringify(app.a.store.exportStudent(s.id)).match(/foster care until|stated by the student/);
    ctx.forbid('the foster care fact appears in a message or is opened by any identity but this playbook', !!said || opened.some((e) => e.detail.identity !== `playbook:${id}`));
    forbidTone(app, ctx, s);
  },

  'p2-retraining': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Darnell', age: 34, county: 'Montgomery', enrollment: { college: 'sinclair', creditHours: 6, weeklyWorkHours: 0 } });
    const id = 'retraining';
    const [m] = say(app, ctx, s, 'I got laid off last month and want to train for a new career');
    ctx.expect(!!m && /OhioMeansJobs/.test(m.text), 'names the county OhioMeansJobs center');
    app.a.playbookEvent(s.id, id, { type: 'confirm' });
    let run = app.a.playbookEvent(s.id, id, { type: 'answer', value: 'yes' });
    ctx.expect(run.stepId === 'gather', 'lists what to bring');
    show(app, ctx, app.a.playbookMessage(s.id, run));
    run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:ask-center`);
    ctx.expect(!!draft && /Montgomery County/.test(draft.body) && /Sinclair/.test(draft.body) && !/\[\w+\]/.test(draft.body), 'the note names his county and college, with no blanks');
    ctx.forbid("something is sent without the student's approval", app.a.outboundLog.length > 0);
    forbidTone(app, ctx, s);
  },

  'persona-2a-break-housing': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Jayden', age: 19, enrollment: { college: 'sinclair', creditHours: 15 } });
    const id = 'break-housing';
    show(app, ctx, app.a.playbookMessage(s.id, app.a.startPlaybook(s.id, id)));
    let run = app.a.playbookEvent(s.id, id, { type: 'confirm' });
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:ask-housing-office`);
    ctx.expect(!!draft, 'a note to the housing office is drafted');
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    run = app.a.playbookEvent(s.id, id, { type: 'approved' });
    ctx.expect(run.stepId === 'backup', 'backup housing is next');
    const backup = show(app, ctx, app.a.helpMessage(s.id, 'housing'));
    ctx.expect(/housing help|couldn't find/.test(backup.text), 'backup housing help is lined up');
    ctx.forbid("something is sent without the student's approval", unapproved.sent || app.a.outboundLog.length !== 1);
    ctx.forbid('a gap is hidden instead of counted', /couldn't find/.test(backup.text) && app.a.evidence.events('unmet_need').length === 0);
  },

  'persona-3a-parole-schedule-proof': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Darnell', age: 34, enrollment: { college: 'sinclair', creditHours: 9 } });
    app.a.seal(s.id, 'justice_involvement', 'on parole, check-ins every other week');
    const classes: ClassMeeting[] = [{ course: 'HVA 1101', days: ['Tue', 'Thu'], start: '18:00', end: '20:45', building: 'Building 9', room: '010' }];
    app.a.addClasses(s.id, classes);
    app.a.addShifts(s.id, [{ date: '2026-11-03', start: '07:00', end: '15:30', employer: 'Warehouse' }]);
    ctx.act('add check-ins');
    app.a.addDeadline(s.id, { title: 'Check-in appointment', due: '2026-11-03T14:30', durationMin: 45, kind: 'appointment', source: { type: 'student' }, confirmed: true });
    app.a.addDeadline(s.id, { title: 'Check-in appointment', due: '2026-11-17T10:00', durationMin: 45, kind: 'appointment', source: { type: 'student' }, confirmed: true });
    const conflicts = app.a.conflictMessages(s.id);
    conflicts.forEach((m) => show(app, ctx, m));
    ctx.forbid('an appointment collides with a class or shift without being raised', conflicts.length !== 1 || !/overlaps your work shift/.test(conflicts[0]!.text));
    const id = 'enrollment-verification';
    show(app, ctx, app.a.playbookMessage(s.id, app.a.startPlaybook(s.id, id)));
    app.a.playbookEvent(s.id, id, { type: 'confirm' });
    app.a.playbookEvent(s.id, id, { type: 'confirm' });
    const draft = app.a.drafts(s.id).find((d) => d.purpose === `${id}:share`);
    const unapproved = await app.a.send(s.id, draft!.id, undefined);
    ctx.act('approve and send');
    await app.a.send(s.id, draft!.id, app.a.approve(s.id, draft!.id));
    ctx.forbid("something is sent without the student's approval", unapproved.sent || app.a.outboundLog.length !== 1);
    const leaked = delivered(app, s).some((m) => /parole|prison|record/i.test(m.text)) || /parole/i.test(draft!.body);
    ctx.forbid('a sealed fact appears in a message or is opened by an ungranted identity', leaked);
  },

  'persona-8b-predictability': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Sam', age: 21, dial: { readingGrade: 6 } as Student['dial'], enrollment: { college: 'sinclair', creditHours: 9 } });
    app.a.addClasses(s.id, [{ course: 'CHE 1211', days: ['Mon', 'Wed'], start: '10:00', end: '11:15', building: 'Building 12', room: '120' }]);
    app.a.addShifts(s.id, [{ date: '2026-11-04', start: '16:00', end: '20:00' }, { date: '2026-11-10', start: '16:00', end: '20:00' }, { date: '2026-11-12', start: '16:00', end: '20:00' }]);
    app.a.addDeadline(s.id, { title: 'Lab 6', course: 'CHE 1211', due: '2026-11-11', kind: 'assignment', effortHours: 3, source: { type: 'syllabus', line: 'Nov 11 Lab 6' }, confirmed: true });
    const preview = show(app, ctx, app.a.weeklyPreview(s.id));
    ctx.expect(/Different from this week/.test(preview.text) && /Lab 6/.test(preview.text), 'the preview shows what is different and what is due');
    ctx.act('forward a room change');
    app.a.connectSource(s.id, 'forwarding');
    const r = app.a.forward(s.id, 'CHE 1211 has moved to Building 14, room 210 starting Wednesday.', { subject: 'Room change' });
    const alert = r.message ? show(app, ctx, r.message) : undefined;
    const updated = app.a.today_(s.id);
    void updated;
    ctx.forbid('a change the team saw is not announced', !alert || !/Building 14/.test(alert.text));
    forbidTone(app, ctx, s);
  },
  'persona-1a-week-puzzle': async (app, ctx) => {
    const s = student(app, ctx, { chosenName: 'Maria', age: 27, enrollment: { college: 'sinclair', creditHours: 12 } });
    const classes: ClassMeeting[] = [{ course: 'BIO 1111', days: ['Mon', 'Wed'], start: '09:00', end: '10:50' }, { course: 'MAT 1130', days: ['Tue', 'Thu'], start: '12:30', end: '13:45' }];
    const shifts: Shift[] = [
      { date: '2026-11-02', start: '14:00', end: '22:00', employer: 'Care center' },
      { date: '2026-11-04', start: '11:30', end: '17:30', employer: 'Care center' },
      { date: '2026-11-06', start: '07:00', end: '15:00', employer: 'Care center' },
    ];
    ctx.act('enter schedule and child care');
    app.a.addClasses(s.id, classes);
    app.a.addShifts(s.id, shifts);
    app.a.setHousehold(s.id, { childCare: { name: 'Little Steps Daycare', open: '06:30', close: '18:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] }, commuteMin: 20, sleepHours: 7 });
    const w = app.a.week(s.id);
    const msg = show(app, ctx, w.message);
    const studyClash = w.blocks.filter((b) => b.kind === 'study').some((b) => overlaps(b.date, b.start, 90, classes, shifts));
    ctx.forbid('a study block is placed on top of a class or a shift', studyClash);
    const mondayPickupProblem = w.problems.some((p) => p.date === '2026-11-02' && /closes/.test(p.text));
    ctx.forbid('a pickup that cannot be made goes unmentioned', !mondayPickupProblem || !/closes at 6:00 p\.m\./.test(msg.text));
    ctx.expect(w.blocks.some((b) => b.kind === 'pickup' && b.date === '2026-11-04'), 'pickups that fit are placed');
    forbidTone(app, ctx, s);
  },
  'persona-10b-spanish': async (app, ctx) => {
    const phone = '+19375558181';
    const replies: string[] = [];
    for (const m of ['Hola, necesito ayuda con la comida por favor', 'Sinclair 45403']) {
      ctx.act(`text: ${m}`);
      replies.push(...app.a.textIn(phone, m));
    }
    const english = replies.filter((r) => /\b(Here's|Want me|which college|help that fits)\b/.test(r));
    ctx.expect(replies.some((r) => /comida/.test(r)), 'food help is found');
    ctx.forbid('a student who wrote in Spanish is answered in English', english.length > 0, english.map((r) => r.slice(0, 50)).join(' | '));
    ctx.forbid('the team asks about immigration or citizenship status', replies.some((r) => /ciudadan|inmigra|estatus migratorio|green card|visa/i.test(r) || STATUS_QUESTION.test(r)));
  },
};

export { checkTone };

/**
 * Cards the builder writes for new basic-needs scouts (scout-<county>-basic-needs) share one implementation: a
 * student at a college in that county looks for food, housing and utility help.
 */
export function scoutJourney(id: string): JourneyImpl<JourneyApp> | undefined {
  const m = id.match(/^scout-([a-z-]+)-basic-needs$/);
  if (!m) return undefined;
  const county = m[1]!.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  return async (app, ctx) => {
    const college = COLLEGES.find((c) => c.county === county);
    ctx.expect(!!college, `a declared college in ${county} County`);
    if (!college) return;
    const s = student(app, ctx, { chosenName: 'Any', zip: '45501', county, enrollment: { college: college.college, creditHours: 12 } });
    for (const need of ['food', 'housing', 'utilities'] as const) {
      const before = app.a.evidence.events('unmet_need').length;
      const m2 = show(app, ctx, app.a.helpMessage(s.id, need));
      const offered = app.a.findHelp(s.id, need).options;
      const wrong = offered.filter((o) => daysBetween(o.resource.verifiedOn, DAY) > o.resource.freshnessDays || (!o.resource.serves.national && !(o.resource.serves.counties ?? []).includes(county) && !(o.resource.serves.colleges ?? []).includes(college.college) && !o.resource.serves.counties?.length));
      ctx.forbid("a resource is offered that is stale or does not serve the student's county", wrong.length > 0, wrong.map((o) => o.resource.id).join(', '));
      ctx.forbid('a gap is hidden instead of counted', offered.length === 0 && (!/couldn't find/.test(m2.text) || app.a.evidence.events('unmet_need').length <= before));
    }
  };
}
