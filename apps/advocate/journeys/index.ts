import type { JourneyContext, JourneyImpl } from '@zthr/intent';
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
    ctx.act('look for caregiving help');
    const before = app.a.evidence.events('unmet_need').length;
    const m = show(app, ctx, app.a.helpMessage(s.id, 'caregiving'));
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
};

export { checkTone };
