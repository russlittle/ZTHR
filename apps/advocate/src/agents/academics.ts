import { createHash, randomBytes } from 'node:crypto';
import type { Advocate } from './advocate.js';
import type { NextStep, OutboundMessage } from '../domain/types.js';
import { collegeById, type CollegeDef } from '../domain/colleges.js';
import { asOfToday, currentGrade, gpa, neededFor, project, sap, standing, type AcademicPolicy, type Gradebook, type Letter, type SapResult, type Standing, type TranscriptCourse } from '../domain/academics.js';
import { r2t4, type AidDisbursed, type R2T4Result } from '../domain/r2t4.js';
import { degreeProgress, programById, type DegreeProgress } from '../domain/degree.js';
import { daysBetween, friendly } from '../domain/dates.js';

/**
 * Staying enrolled (Phase 5): grades, standing, financial-aid progress, the choice to drop or withdraw, degree
 * progress, and sharing any of it with an advisor. Every figure is computed from a published rule; the college and
 * the aid office make the official decisions, and the messages say so.
 */

export interface AcademicRecord {
  program?: string;
  /** Credits the program takes, for the maximum timeframe, when no program is declared. */
  programCredits?: number;
  transcript: TranscriptCourse[];
  /** Federal aid paid this term, for the withdrawal estimate. Only what the student enters. */
  aid?: AidDisbursed;
  /** Tuition and fees charged this term. */
  charges?: number;
  /** Aid kept this term on an approved appeal, with the plan the term must meet. */
  aidProbation?: { term: string; termGpa: number; termPace: number; planDue?: string };
}

export type Term = NonNullable<CollegeDef['academic']>['terms'][number];

const back: NextStep = { label: 'Show my day', action: 'today' };
const school: NextStep = { label: 'My classes and standing', action: 'school' };
const msg = (sid: string, text: string, nextSteps: NextStep[], author = 'academic-coach', why?: string): OutboundMessage => ({ studentId: sid, author, urgency: 'routine', text, nextSteps, ...(why ? { why } : {}) });
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pctS = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function policyFor(a: Advocate, sid: string): { college: CollegeDef; policy: AcademicPolicy | undefined; term: Term | undefined } {
  const college = collegeById(a.student(sid).enrollment.college)!;
  const ac = college.academic;
  const today = a.localNow().date;
  const term = ac?.terms.find((t) => t.start <= today && today <= t.end) ?? ac?.terms.find((t) => t.start > today);
  return { college, policy: ac ? { standing: ac.standing, sap: ac.sap } : undefined, term };
}

export interface AcademicView {
  record: AcademicRecord;
  books: (Gradebook & { now: ReturnType<typeof currentGrade> })[];
  gpa: number | undefined;
  standing: Standing | undefined;
  sap: SapResult | undefined;
  /** Aid progress if the term ended with today's grades. */
  sapIfToday: SapResult | undefined;
  degree: DegreeProgress | undefined;
  college: CollegeDef;
  term: Term | undefined;
  programCredits: number | undefined;
}

export function academicView(a: Advocate, sid: string): AcademicView {
  const record = a.academicRecord(sid);
  const books = a.gradebooks(sid).map((b) => ({ ...b, now: currentGrade(b) }));
  const { college, policy, term } = policyFor(a, sid);
  const program = programById(record.program);
  const programCredits = program?.credits ?? record.programCredits ?? (college.academic?.level === 'bachelor' ? 120 : college.academic?.level === 'associate' ? 60 : undefined);
  const g = gpa(record.transcript).gpa;
  const st = policy ? standing(record.transcript, policy.standing) : undefined;
  const s = policy ? sap(record.transcript, policy.sap, programCredits) : undefined;
  const ifToday = policy ? sap(project(record.transcript, asOfToday(record.transcript, books)), policy.sap, programCredits) : undefined;
  const load = record.transcript.filter((c) => !c.grade).reduce((n, c) => n + c.credits, 0) || a.student(sid).enrollment.creditHours || 12;
  const degree = program ? degreeProgress(program, record.transcript, term?.term ?? 'Fall 2026', load) : undefined;
  return { record, books, gpa: g, standing: st, sap: s, sapIfToday: ifToday, degree, college, term, programCredits };
}

// ---------- grades ----------

/** "What do I need on the final?" for one course, or the closest call among the student's courses. */
export function finalNeedMessage(a: Advocate, sid: string, course?: string): OutboundMessage {
  const books = a.gradebooks(sid);
  if (!books.length) return msg(sid, "I don't have any grades yet. Connect your class site, or tell me a score, like: I got 41 out of 50 on quiz 3 in CHM 1210.", [{ label: 'Connect my class site', action: 'connect-class-site' }, back]);
  const pick = course ? books.find((b) => b.course.replace(/\s/g, '').toLowerCase() === course.replace(/\s/g, '').toLowerCase()) : undefined;
  const list = pick ? [pick] : books;
  const lines: string[] = [];
  for (const b of list) {
    const now = currentGrade(b);
    const fin = b.categories.find((c) => /final/i.test(c.name));
    if (!now) {
      lines.push(`${b.course}: nothing graded yet.`);
      continue;
    }
    if (!fin) {
      lines.push(`${b.course}: ${now.letter} (${now.percent}%) so far. The syllabus has no separate final.`);
      continue;
    }
    const order = ['A', 'B', 'C', 'D'] as const;
    const art = (l: string) => (l === 'A' ? 'an' : 'a');
    const res = order.map((t) => ({ t, r: neededFor(b, fin.name, t)! }));
    const ci = order.indexOf(now.letter as (typeof order)[number]);
    const above = res.slice(0, ci < 0 ? 4 : ci);
    const up = [...above].reverse().filter((x) => x.r.possible).pop();
    const keep = ci >= 0 ? res[ci]! : undefined;
    const out = above.filter((x) => !x.r.possible).map((x) => x.t);
    const bits = [
      up ? `${up.r.needed}% on it gets you ${art(up.t)} ${up.t}` : '',
      keep ? (keep.r.already ? `your ${keep.t} is safe whatever the ${fin.name.toLowerCase()} brings` : `${keep.r.needed}% keeps your ${keep.t}`) : now.letter === 'F' ? 'a D or better needs more than the final alone; ask about an incomplete or extra credit' : '',
      out.length && !up ? `${art(out[out.length - 1]!)} ${out[out.length - 1]} is out of reach on the ${fin.name.toLowerCase()} alone` : '',
    ].filter(Boolean);
    lines.push(`${b.course}: ${now.letter} (${now.percent}%) now. The ${fin.name.toLowerCase()} is ${fin.weight}% of the grade: ${bits.join('; ')}.`);
  }
  return msg(sid, lines.join('\n'), [school, { label: 'Plan study time', action: 'week' }, back], 'academic-coach', 'From the weights in your syllabus and the scores your class site or you gave me. Work not yet graded is left out.');
}

// ---------- standing and aid progress ----------

export function aidProgressMessage(a: Advocate, sid: string): OutboundMessage {
  const v = academicView(a, sid);
  if (!v.college.academic) return msg(sid, `${v.college.short} has not published its aid-progress rules in a form I can check yet. The federal rule is a 2.0 GPA, finishing about two out of three credits you try, and no more than 150% of your program's credits. The financial aid office can tell you where you stand.`, [school, back]);
  if (!v.sap || v.record.transcript.every((c) => !c.grade)) return msg(sid, `You don't have finished terms on record yet, so there's nothing to measure. At ${v.college.short}, keeping aid means a ${v.college.academic.sap.gpa.toFixed(1)} GPA and finishing ${v.college.academic.sap.pace}% of the credits you try.`, [school, back]);
  const prob = v.record.aidProbation;
  if (prob) {
    const plan = termPlan(v.record, v.books)!;
    return msg(
      sid,
      `Your appeal was approved, so you have aid for ${prob.term}. The plan for this term: a ${prob.termGpa.toFixed(1)} term GPA and finishing ${prob.termPace}% of this term's credits.${prob.planDue ? ` The signed plan is due ${friendly(prob.planDue)}.` : ''} So far your term GPA is ${plan.gpa?.toFixed(2) ?? 'not graded yet'}${plan.meets === false ? ', under the plan' : plan.meets ? ', on plan' : ''}. A W in a class counts against the plan.`,
      [{ label: 'What do I need on my finals?', action: 'final-need' }, { label: 'Thinking about dropping a class', action: 'drop' }, back],
      'academic-coach',
      `${v.college.academic.sap.statuses} Source: ${v.college.academic.sap.source}`,
    );
  }
  const bad = v.sap.checks.filter((c) => c.meets === false);
  const ifToday = v.sapIfToday?.checks.filter((c) => c.meets === false) ?? [];
  const appeal = v.college.academic.sap.appeal?.find((w) => w.opens <= a.localNow().date && a.localNow().date <= w.closes);
  if (bad.length) {
    return msg(
      sid,
      `You're under ${v.college.short}'s aid-progress rule. ${bad.map((b) => (b.rule === 'pace' ? `You finished ${b.value}% of the credits you tried. The rule is ${b.need}%.` : b.rule === 'gpa' ? `Your GPA is ${b.value}. The rule is ${b.need}.` : `You have tried ${b.value} credits. The limit is ${b.need}.`)).join(' ')} This can stop federal aid. If something outside your control got in the way, you can appeal.${appeal ? ` The ${appeal.term} appeal is open until ${friendly(appeal.closes)}.` : ''}`,
      [{ label: 'Start an appeal', action: 'playbook:sap-appeal:start' }, school, back],
      'academic-coach',
      `${v.college.academic.sap.evaluated} Source: ${v.college.academic.sap.source}`,
    );
  }
  if (ifToday.length) {
    return msg(sid, `You meet the aid-progress rule now. If this term ended with today's grades, you'd drop under it on ${ifToday.map((b) => b.label.toLowerCase()).join(' and ')}. There's still time to change that.`, [{ label: 'What do I need on my finals?', action: 'final-need' }, school, back], 'academic-coach', 'Projected from your current class grades.');
  }
  return msg(sid, `You're meeting ${v.college.short}'s aid-progress rule: GPA ${v.gpa?.toFixed(2)}, and ${v.sap.earned} of ${v.sap.attempted} credits completed.`, [school, back]);
}

/** How this term would meet an aid-probation plan if it ended with these outcomes. */
export function termPlan(record: AcademicRecord, books: Gradebook[], outcome: Record<string, Letter> = {}, dropped?: string): { gpa: number | undefined; pace: number | undefined; meets: boolean | undefined } | undefined {
  const p = record.aidProbation;
  if (!p) return undefined;
  const now = project(record.transcript.filter((c) => !(dropped && !c.grade && c.course === dropped)), { ...asOfToday(record.transcript, books), ...outcome }).filter((c) => c.term === p.term && c.grade);
  const g = gpa(now).gpa;
  const att = now.reduce((n, c) => n + c.credits, 0);
  const earned = now.filter((c) => ['A', 'B', 'C', 'D', 'P'].includes(c.grade!)).reduce((n, c) => n + c.credits, 0);
  const pace = att ? Math.round((earned / att) * 1000) / 10 : undefined;
  return { gpa: g, pace, meets: g === undefined || pace === undefined ? undefined : g >= p.termGpa && pace >= p.termPace };
}

// ---------- drop or withdraw ----------

export interface DropOption {
  choice: 'stay' | 'drop' | 'withdraw' | 'withdraw-all';
  title: string;
  available: boolean;
  when: string;
  refund: string;
  transcript: string;
  aidProgress: string;
  aidReturn?: string;
  /** Effect on an aid-probation plan, when the student is on one. */
  plan?: string;
}

export function dropOptions(a: Advocate, sid: string, course?: string): { course?: TranscriptCourse; term?: Term; options: DropOption[]; r2t4?: R2T4Result; note?: string } {
  const v = academicView(a, sid);
  const today = a.localNow().date;
  const current = v.record.transcript.filter((c) => !c.grade);
  const c = course ? current.find((x) => x.course.replace(/\s/g, '').toLowerCase() === course.replace(/\s/g, '').toLowerCase()) : current[0];
  const t = v.term;
  const policy = v.college.academic;
  if (!policy) return { course: c, options: [], note: `${v.college.short}'s drop and withdrawal rules aren't declared yet; the registrar has them.` };
  const books = v.books;
  const now = c ? books.find((b) => b.course === c.course)?.now?.letter : undefined;
  const sapWith = (outcome: Record<string, Letter>) => sap(project(v.record.transcript, { ...asOfToday(v.record.transcript, books), ...outcome }), policy.sap, v.programCredits);
  const describe = (r: SapResult) => {
    const pace = r.checks.find((x) => x.rule === 'pace')!;
    const g = r.checks.find((x) => x.rule === 'gpa')!;
    return `${pace.value ?? '-'}% of credits completed${pace.meets === false ? ' (under the line)' : ''}, GPA ${g.value?.toFixed(2) ?? '-'}${g.meets === false ? ' (under the line)' : ''}`;
  };
  const stay = c ? sapWith({}) : undefined;
  const w = c ? sapWith({ [c.course]: 'W' }) : undefined;
  const all = sapWith(Object.fromEntries(current.map((x) => [x.course, 'W' as Letter])));
  const planWord = (o: Record<string, Letter>, dropped?: string) => {
    const r = termPlan(v.record, books, o, dropped);
    return r ? `Term plan: GPA ${r.gpa?.toFixed(2) ?? 'not graded yet'}, ${r.pace ?? '-'}% of term credits finished, ${r.meets === false ? 'misses the plan' : r.meets ? 'meets the plan' : 'not measurable yet'}` : undefined;
  };
  const refundOpen = t ? today <= t.refund100By : undefined;
  const wOpen = t ? today <= t.withdrawBy : undefined;
  const r = t && v.record.aid ? r2t4({ start: t.start, end: t.end, breaks: t.breaks }, today, v.record.aid, v.record.charges ?? 0) : undefined;
  const unknown = 'Not known: the college has not published this term\'s dates in a form I can read. Check the registration calendar.';
  const options: DropOption[] = [];
  if (c) {
    options.push({ choice: 'stay', title: `Stay in ${c.course}`, available: true, when: 'Any time', refund: 'No change to what you pay', transcript: now ? `A grade; ${now} as of today` : 'A grade at the end of the term', aidProgress: stay ? describe(stay) : 'Not measured', plan: planWord({}) });
    options.push({
      choice: 'drop',
      title: `Drop ${c.course} for a refund`,
      available: refundOpen === true,
      when: t ? `By ${friendly(t.refund100By)}${refundOpen ? '' : ' (passed)'}` : unknown,
      refund: policy.refund,
      transcript: 'Nothing on your transcript',
      aidProgress: 'No change; the class is as if never taken. Aid for the term may be recalculated for fewer credits.',
      plan: planWord({}, c.course),
    });
    options.push({
      choice: 'withdraw',
      title: `Withdraw from ${c.course} (a W)`,
      available: wOpen === true,
      when: t ? `By ${friendly(t.withdrawBy)}${wOpen ? '' : ' (passed); ask the registrar about a late withdrawal for documented circumstances'}` : unknown,
      refund: refundOpen === false ? 'No refund after the refund date' : 'See the refund date',
      transcript: 'A W, which does not change your GPA',
      aidProgress: w ? describe(w) : 'Not measured',
      plan: planWord({ [c.course]: 'W' }),
    });
  }
  options.push({
    choice: 'withdraw-all',
    title: 'Withdraw from every class this term',
    available: true,
    when: t ? `Any time before ${friendly(t.end)}` : unknown,
    refund: refundOpen === false ? 'No tuition refund after the refund date' : 'See the refund date',
    transcript: 'A W in each class',
    aidProgress: describe(all),
    plan: planWord(Object.fromEntries(current.map((x) => [x.course, 'W' as Letter]))),
    aidReturn: !t ? unknown : !r ? `Your federal aid for the term is not on file, so I can't estimate a return. The 60% point this term is ${friendly(sixtyPoint(t))}.` : r.allEarned ? `You're past the 60% point (${friendly(r.sixtyPercentDay)}), so all ${usd(r.aidDisbursed)} of aid is earned and none goes back.` : `You've completed ${pctS(r.percentCompleted)} of the term. About ${usd(r.unearned)} of ${usd(r.aidDisbursed)} would be unearned: the college returns about ${usd(r.schoolReturns)}${r.studentLoanRepay ? `, ${usd(r.studentLoanRepay)} of your loans would be repaid on the loan's normal terms` : ''}${r.studentGrantReturn ? `, and you would owe about ${usd(r.studentGrantReturn)} of grant money` : ', and you would not owe grant money back'}. After ${friendly(r.sixtyPercentDay)} all of it is earned.`,
  });
  return { course: c, term: t, options, ...(r ? { r2t4: r } : {}) };
}

const sixtyPoint = (t: Term) => r2t4({ start: t.start, end: t.end, breaks: t.breaks }, t.start, {}, 0).sixtyPercentDay;

export function dropMessage(a: Advocate, sid: string, course?: string): OutboundMessage {
  const d = dropOptions(a, sid, course);
  if (!d.options.length) return msg(sid, d.note ?? 'I could not find that class.', [school, back]);
  const stop = (x: string) => x.replace(/[.\s]+$/, '');
  const short = (o: DropOption) => {
    if (o.choice === 'stay') return `Stay: you get a grade${d.course && a.academicView(sid).books.find((b) => b.course === d.course!.course)?.now ? `, ${a.academicView(sid).books.find((b) => b.course === d.course!.course)!.now!.letter} today` : ''}`;
    if (o.choice === 'drop') return `Drop for a refund: ${o.available ? stop(o.when) : o.when.startsWith('Not known') ? 'date not published' : 'the date has passed'}`;
    if (o.choice === 'withdraw') return `Withdraw with a W: ${o.available ? stop(o.when) : o.when.startsWith('Not known') ? 'date not published' : 'the date has passed'}`;
    return `Leave every class: ${o.aidReturn ? stop(o.aidReturn.split('. ')[0]!) : 'see the screen'}`;
  };
  return msg(
    sid,
    `Your choices${d.course ? ` for ${d.course.course}` : ''}:\n${d.options.map((o) => `${short(o)}.`).join('\n')}\nThe School screen shows what each does to your aid. Your advisor and the aid office make the final call.`,
    [{ label: 'See each choice side by side', action: `drop:${d.course?.course ?? ''}` }, { label: 'Share this with my advisor', action: 'advisor-share:school' }, back],
    'academic-coach',
    `From ${d.term ? `${d.term.term} dates (${d.term.source})` : 'the college policy'} and the federal Return of Title IV rule (34 CFR 668.22). Estimates; the aid office calculates the real amounts.`,
  );
}

// ---------- degree progress ----------

export function degreeMessage(a: Advocate, sid: string): OutboundMessage {
  const v = academicView(a, sid);
  if (!v.degree) return msg(sid, "I don't know your program yet. Tell me what you're studying, and I'll track every requirement toward it.", [school, back]);
  const d = v.degree;
  const open = d.areas.filter((x) => x.done + x.inProgress < x.need);
  return msg(
    sid,
    `${d.program.name}: ${d.earned} of ${d.program.credits} credits done, ${d.inProgress} in progress.${d.ot36 ? ` Ohio Transfer 36: ${d.ot36.done} of ${d.ot36.need} core hours${d.ot36.complete ? ', complete, so they transfer to any Ohio public university' : ''}.` : ''} ${open.length ? `Still open: ${open.map((x) => `${x.area} (${x.need - x.done - x.inProgress} hours)`).join(', ')}.` : 'Every area is covered.'}${d.finish ? ` At your pace you finish in ${d.finish}.` : ''}`,
    [school, { label: 'Share with my advisor', action: 'advisor-share:degree' }, back],
    'academic-coach',
    `From ${d.program.source}`,
  );
}

// ---------- the summary ----------

export function schoolMessage(a: Advocate, sid: string): OutboundMessage {
  const v = academicView(a, sid);
  const now = v.books.filter((b) => b.now).map((b) => `${b.course} ${b.now!.letter}`);
  const parts = [
    now.length ? `Right now: ${now.join(', ')}.` : 'No grades in yet this term.',
    v.gpa !== undefined ? `GPA ${v.gpa.toFixed(2)}.` : '',
    v.standing ? `${v.standing.label}.` : '',
    v.sap ? (v.sap.meets ? 'Aid progress: on track.' : 'Aid progress: under the line; you can appeal.') : '',
  ].filter(Boolean);
  return msg(sid, parts.join(' '), [{ label: 'What do I need on my finals?', action: 'final-need' }, { label: 'Thinking about dropping a class', action: 'drop' }, { label: 'Will I keep my financial aid?', action: 'aid-progress' }, back]);
}

// ---------- share with an advisor ----------

export type ShareScope = 'schedule' | 'school' | 'degree' | 'plan';
export const SHARE_SCOPES: Record<ShareScope, string> = { schedule: 'My week: classes, work and held study time', school: 'My classes, grades, standing and aid progress', degree: 'My degree progress', plan: 'What I am working on: the one thing, open dates and help I have started' };
export const SHARE_DAYS = [1, 7, 30] as const;

export interface Share {
  id: string; // sha256 of the token
  studentId: string;
  label: string;
  scopes: ShareScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  views: number;
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function createShare(a: Advocate, sid: string, label: string, scopes: ShareScope[], days: number): { token: string; share: Share } {
  const token = randomBytes(24).toString('base64url');
  const at = a.clock();
  const share: Share = { id: tokenHash(token), studentId: sid, label: label.slice(0, 60) || 'My advisor', scopes: [...new Set(scopes)].filter((x) => Object.hasOwn(SHARE_SCOPES, x)), createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + Math.min(30, Math.max(1, days)) * 86_400_000).toISOString(), views: 0 };
  return { token, share };
}

export const shareLive = (s: Share | undefined, now: Date) => !!s && !s.revokedAt && Date.parse(s.expiresAt) > now.getTime();

export const daysLeft = (s: Share, today: string) => Math.max(0, daysBetween(today, s.expiresAt.slice(0, 10)));
