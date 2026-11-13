import type { Advocate } from './advocate.js';
import type { Deadline, NeedCategory, OutboundMessage } from '../domain/types.js';
import { addDays, relDay, sentence, shortDate, time12 } from '../domain/dates.js';
import { openBlocks, planSteps } from '../domain/planner.js';
import { TERMS } from '../domain/college.js';
import type { Situation } from '../domain/crisis.js';
import * as campusLife from './campus-life.js';
import { collegeById } from '../domain/colleges.js';
import * as academics from './academics.js';
import { BARRIER } from '../guide/taxonomy.js';
import { OUTCOMES, type Outcome } from '../guide/feedback.js';

/**
 * Every button the team offers, in one registry (PRD P3: every message carries a next step the student can take
 * in one tap). The web app, the text channel and the journeys all run actions through Advocate.perform, so a
 * button works the same everywhere, and the no-dead-ends gate can prove that every verb an agent emits has a
 * handler here.
 *
 * A result always carries a message, so the text channel can answer. It may also name a screen for the app.
 */
export type View = 'today' | 'money' | 'help' | 'settings' | 'week' | 'syllabus' | 'shifts' | 'dates' | 'drafts' | 'resource' | 'ask' | 'deleted' | 'share' | 'letter' | 'meals' | 'school' | 'drop' | 'advisor-share' | 'degree' | 'guide' | 'plan';

export interface ActionResult {
  message: OutboundMessage;
  view?: View;
  viewArg?: string;
}

type Handler = (a: Advocate, sid: string, arg: string) => ActionResult;

/** Every barrier in the taxonomy is a need the student can ask about. */
const NEEDS: NeedCategory[] = Object.keys(BARRIER) as NeedCategory[];
const isNeed = (x: string): x is NeedCategory => Object.hasOwn(BARRIER, x);
const SITUATIONS: Situation[] = ['eviction', 'utility-shutoff', 'car', 'no-food', 'rent-short'];

const msg = (sid: string, text: string, nextSteps: { label: string; action: string }[], author = 'chief-of-staff', why?: string): OutboundMessage => ({
  studentId: sid,
  author,
  urgency: 'routine',
  text,
  nextSteps,
  why,
});

const back = { label: 'Show my day', action: 'today' };

const deadline = (a: Advocate, sid: string, id: string): Deadline | undefined => a.deadlines(sid).find((d) => d.id === id);

const showDraft = (a: Advocate, sid: string, purpose: string, to: string, body: string, intro: string): ActionResult => {
  const d = a.draftFor(sid, purpose) ?? a.createDraft(sid, to, to, body, purpose);
  return {
    message: msg(sid, `${intro} Here is a draft to ${d.to}:\n"${d.body}"\nNothing is sent until you say so.`, [{ label: 'Send it', action: `approve:${d.id}` }, back]),
    view: 'drafts',
    viewArg: purpose,
  };
};

const CONTACTS: Record<string, { name: string; phone?: string; url?: string }> = {
  lawo: { name: 'Legal Aid of Western Ohio', phone: '888-534-1432', url: 'https://www.lawolaw.org' },
  vita: { name: 'free tax help (VITA)', url: 'https://www.irs.gov/vita' },
  '211': { name: '2-1-1', phone: '211' },
};

const PREPARE: Record<string, string[]> = {
  legal: ['Any papers you got, like a notice, lease or court letter', 'Dates: when you got them and any deadline on them', 'A short list of what happened, in order', 'Your questions, written down'],
  tax: ['Photo ID and Social Security cards or ITINs for everyone on the return', 'W-2s and 1099s', 'Form 1098-T from your college', 'Last year\'s return if you have it', 'Bank routing and account number for a refund'],
  medical: ['Your symptoms and when they started', 'Medicines you take', 'Your insurance card, or say you need a free clinic', 'Questions you want answered'],
  investment: ['What you want the money for', 'What you owe and the interest rates', 'Your monthly income and bills'],
};

export const ACTIONS: Record<string, Handler> = {
  school: (a, sid) => ({ message: academics.schoolMessage(a, sid), view: 'school' }),
  'final-need': (a, sid, arg) => ({ message: academics.finalNeedMessage(a, sid, arg || undefined), view: 'school' }),
  drop: (a, sid, arg) => ({ message: academics.dropMessage(a, sid, arg || undefined), view: 'drop', viewArg: arg }),
  'aid-progress': (a, sid) => ({ message: academics.aidProgressMessage(a, sid), view: 'school' }),
  degree: (a, sid) => ({ message: academics.degreeMessage(a, sid), view: 'degree' }),
  'advisor-share': (a, sid, arg) => ({
    message: msg(sid, `You can make a read-only link for your advisor, or anyone you choose. You pick what it shows and how long it works, you can turn it off any time, and you'll see each time it's opened. Links are made on the Share screen in the app, so the link itself is never stored in your messages.`, [back]),
    view: 'advisor-share',
    viewArg: arg,
  }),
  today: (a, sid) => ({ message: a.todayMessage(sid), view: 'today' }),
  settings: (a, sid) => {
    const s = a.student(sid);
    return { message: msg(sid, sentence(`You get ${s.dial.depth.replace(/-/g, ' ')} answers, with quiet hours from ${time12(s.dial.quietStart)} to ${time12(s.dial.quietEnd)}`), [{ label: 'Shorter answers', action: 'dial:brief' }, { label: 'Walk me through things', action: 'dial:walk-me-through' }]), view: 'settings' };
  },
  ask: (_a, sid) => ({ message: msg(sid, 'Ask me anything about school, money or life. You can type it in your own words.', [back]), view: 'ask' }),

  // money
  screen: (a, sid) => ({ message: a.moneyFoundMessage(sid), view: 'money' }),
  'screen-more': (_a, sid) => ({
    message: msg(sid, 'Tell me a little more and I can check again: how many people live with you, and about how much your household earns a month. Like "3 people, $1800".', [{ label: 'Check money I qualify for', action: 'screen' }], 'navigator'),
    view: 'money',
  }),
  'why-qualify': (a, sid) => {
    const likely = a.screen(sid).filter((r) => r.status === 'likely');
    const brief = a.student(sid).dial.depth === 'brief';
    const text = !likely.length
      ? 'I did not find a likely match yet. Tell me more and I will check again.'
      : brief
        ? `You meet the main rules for:\n${likely.map((r) => r.title).join('\n')}\nThe agency decides.`
        : `Here is why:\n${likely.map((r) => `${r.title}: ${r.reasons[0] ?? 'you meet the main rule'}`).join('\n')}\nThe agency makes the final call.`;
    return { message: msg(sid, text, likely[0] ? [{ label: `Start ${likely[0].title}`, action: `start-program:${likely[0].program}` }, back] : [{ label: 'Answer a question', action: 'screen-more' }], 'navigator'), view: 'money' };
  },
  'start-program': (a, sid, arg) => ACTIONS['start-resource']!(a, sid, { snap: 'ohio-benefits-snap', lifeline: 'lifeline', 'ohio-heap': 'ohio-heap', 'sinclair-emergency-grant': 'sinclair-emergency-grant' }[arg] ?? arg),
  'start-resource': (a, sid, arg) => {
    const r = a.catalog.find((x) => x.id === arg);
    if (!r) return { message: msg(sid, 'That one is not in my list anymore. Let us look for another option.', [{ label: 'Find help', action: 'find-help' }], 'navigator'), view: 'help' };
    return { message: msg(sid, `${r.name}.\nFirst step: ${r.howToApply[0] ?? r.description}${r.phone ? ` Call ${r.phone}.` : ''}`, [...(r.phone ? [{ label: `Call ${r.name}`, action: `call:${r.phone}` }] : []), { label: 'Share this', action: `share:${r.id}` }], 'navigator'), view: 'resource', viewArg: r.id };
  },

  // help
  'find-help': (a, sid, arg) => {
    if (!arg) return { message: msg(sid, "What's hard right now? Food, rent, bills, rides, child care, or something else. Tell me and I'll find help that fits.", [{ label: 'Food', action: 'need:food' }, { label: 'Rent or housing', action: 'need:housing' }, { label: 'Bills', action: 'need:utilities' }], 'navigator'), view: 'help' };
    if ((NEEDS as string[]).includes(arg)) return { message: a.helpMessage(sid, arg as NeedCategory), view: 'help' };
    if (deadline(a, sid, arg)) return { message: a.assignmentHelp(sid, arg) };
    return ACTIONS['find-help']!(a, sid, '');
  },
  need: (a, sid, arg) => {
    if (!isNeed(arg)) return ACTIONS['find-help']!(a, sid, '');
    // Saying something is hard opens a barrier: it stays in the plan until the student says it is resolved.
    a.openBarrier(sid, arg, 'student', BARRIER[arg].urgent ? 'tonight' : 'soon');
    if (arg === 'emergency') return { message: a.tonightMessage(sid), view: 'plan' };
    return { message: a.helpMessage(sid, arg), view: 'help' };
  },
  tonight: (a, sid) => {
    a.openBarrier(sid, 'emergency', 'student', 'tonight');
    return { message: a.tonightMessage(sid), view: 'plan' };
  },
  barrier: (a, sid, arg) => {
    const [verb, need] = arg.split(':');
    if (!need || !isNeed(need)) return { message: msg(sid, 'I could not find that one. Here is your plan.', [back], 'navigator'), view: 'plan' };
    const label = BARRIER[need].label.toLowerCase();
    if (verb === 'resolve') {
      a.resolveBarrier(sid, need);
      return { message: msg(sid, `Good. I marked ${label} as resolved. If it comes back, tell me and I will pick it up again.`, [back], 'navigator'), view: 'plan' };
    }
    if (verb === 'not-today') {
      a.notTodayBarrier(sid, need);
      return { message: msg(sid, `Okay. No reminders about ${label} today. It is still in your plan for when you are ready.`, [back], 'navigator'), view: 'plan' };
    }
    if (verb === 'start') {
      a.startBarrier(sid, need);
      return { message: msg(sid, `Noted: you are working on ${label}. I will check in, not nag.`, [back], 'navigator'), view: 'plan' };
    }
    a.openBarrier(sid, need, 'student', BARRIER[need].urgent ? 'tonight' : 'soon');
    return { message: a.helpMessage(sid, need), view: 'plan' };
  },
  feedback: (a, sid, arg) => {
    const [rid, outcome] = arg.split(':');
    if (!rid || !OUTCOMES.includes(outcome as Outcome)) return { message: msg(sid, 'Thanks.', [back], 'navigator') };
    a.resourceFeedback(sid, rid, outcome as Outcome);
    return { message: msg(sid, outcome === 'helped' ? 'Thank you. That helps the next student know what works.' : 'Thank you for telling me. I will find you another option, and this helps the next student too.', outcome === 'helped' ? [back] : [{ label: 'Find another option', action: `need:${a.catalog.find((r) => r.id === rid)?.categories[0] ?? 'food'}` }, back], 'navigator'), view: 'resource', viewArg: rid };
  },
  situation: (a, sid, arg) => ({ message: a.crisis(sid, (SITUATIONS.includes(arg as Situation) ? arg : 'no-food') as Situation).message, view: 'help' }),
  call: (_a, sid, arg) => ({ message: msg(sid, `Call ${arg === '988' ? 'or text 988' : arg}. ${arg === '211' ? '2-1-1 answers any time and knows local help.' : arg === '988' ? 'Someone answers any time, day or night.' : 'Tell them you are a student; it often opens more options.'}`, [back]) }),
  contact: (_a, sid, arg) => {
    const c = (Object.hasOwn(CONTACTS, arg) ? CONTACTS[arg] : undefined) ?? { name: arg };
    return { message: msg(sid, `${c.name}${c.phone ? `: call ${c.phone}` : ''}${c.url ? `${c.phone ? ' or visit' : ': visit'} ${c.url}` : ''}. Want help getting ready first?`, [...(c.phone ? [{ label: `Call ${c.name}`, action: `call:${c.phone}` }] : []), back]) };
  },
  prepare: (_a, sid, arg) => ({ message: msg(sid, `Bring these and you will get more out of it:\n${((Object.hasOwn(PREPARE, arg) ? PREPARE[arg] : undefined) ?? PREPARE.legal!).map((x, i) => `${i + 1}. ${x}`).join('\n')}`, [{ label: 'Set a reminder', action: `remind:getting ready (${arg})` }, back]) }),
  share: (a, sid, arg) => {
    const sh = a.shareText(sid, arg || undefined);
    return { message: msg(sid, `You can send this to a friend:\n"${sh.text}"`, [back]), view: 'share', viewArg: arg };
  },

  // coursework
  plan: (a, sid, arg) => (deadline(a, sid, arg) ? { message: a.planMessage(sid, arg) } : ACTIONS['plan-next']!(a, sid, '')),
  'plan-next': (a, sid) => {
    const next = a.deadlines(sid).find((d) => !d.done && d.confirmed && d.due >= a.today_(sid).date);
    return next ? { message: a.planMessage(sid, next.id) } : { message: msg(sid, 'Nothing is due yet. Add a syllabus and I will find every date.', [{ label: 'Add a syllabus', action: 'upload-syllabus' }]), view: 'syllabus' };
  },
  'plan-free-time': (a, sid) => ACTIONS['plan-next']!(a, sid, ''),
  'find-tutor': (a, sid) => {
    const next = a.deadlines(sid).find((d) => !d.done && d.due >= a.today_(sid).date);
    return next ? { message: a.assignmentHelp(sid, next.id) } : ACTIONS['find-help']!(a, sid, 'academic');
  },
  'hold-block': (a, sid, arg) => {
    const [id, date, start] = [arg.split(':')[0]!, arg.split(':')[1]!, arg.split(':').slice(2).join(':')];
    const d = deadline(a, sid, id);
    const endMin = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + 120;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    a.holdTime(sid, { deadlineId: id, title: d ? `Work on ${d.title}` : 'Study time', date, start, end });
    a.remind(sid, d?.title ?? 'study time', `${date}T${start}`, `Your time for ${d?.title ?? 'studying'} starts in 15 minutes.`);
    return { message: msg(sid, `Held. ${relDay(a.today_(sid).date, date)[0]!.toUpperCase()}${relDay(a.today_(sid).date, date).slice(1)}, ${time12(start)} to ${time12(end)} is for ${d?.title ?? 'studying'}. I will remind you 15 minutes before.`, [{ label: 'Break it into steps', action: `plan:${id}` }, back], 'coursework-planner'), view: 'today' };
  },
  'calendar-steps': (a, sid, arg) => {
    const d = deadline(a, sid, arg);
    if (!d) return ACTIONS['plan-next']!(a, sid, '');
    const steps = planSteps(d, a.today_(sid).date, a.classes(sid), a.shifts(sid));
    for (const s of steps) {
      const endMin = Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3, 5)) + s.minutes;
      a.holdTime(sid, { deadlineId: d.id, title: s.step, date: s.date, start: s.start, end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}` });
    }
    return { message: msg(sid, `Done. ${steps.length} short work sessions for ${d.title} are on your calendar, and I will remind you before each one.`, [{ label: 'See my week', action: 'week' }, back], 'coursework-planner'), view: 'week' };
  },
  'edit-steps': (a, sid, arg) => {
    const d = deadline(a, sid, arg);
    if (!d) return ACTIONS['plan-next']!(a, sid, '');
    const today = a.today_(sid).date;
    const options = openBlocks(addDays(today, 1), d.due, a.classes(sid), a.shifts(sid), 3);
    return {
      message: msg(sid, options.length ? 'Here are other open times. Pick one and I will hold it.' : 'Your week is full before it is due. A short 30 minutes still helps, or we can ask your instructor for a plan.', options.length ? options.map((b) => ({ label: `${relDay(today, b.date)} ${time12(b.start)}`, action: `hold-block:${d.id}:${b.date}:${b.start}` })) : [{ label: 'Draft a note to my instructor', action: `draft-instructor-note:${d.id}` }], 'coursework-planner'),
    };
  },
  'mark-done': (a, sid, arg) => {
    a.markDone(sid, arg);
    return { message: msg(sid, 'Nice work. I checked it off.', [back], 'coursework-planner'), view: 'today' };
  },
  'confirm-deadlines': (a, sid, arg) => {
    a.confirmDeadlines(sid, !arg || arg === 'all' ? 'all' : [arg]);
    return { message: msg(sid, 'Thanks. Those dates are on your calendar now, and I will plan around them.', [back], 'coursework-planner'), view: 'today' };
  },
  'confirm-deadline': (a, sid, arg) => {
    a.confirmDeadlines(sid, [arg]);
    return { message: msg(sid, 'Confirmed.', [{ label: 'Check the other dates', action: 'review-deadlines' }], 'coursework-planner'), view: 'dates' };
  },
  'remove-deadline': (a, sid, arg) => {
    a.removeDeadline(sid, arg);
    return { message: msg(sid, 'Removed. Thanks for catching it.', [{ label: 'Check the other dates', action: 'review-deadlines' }], 'coursework-planner'), view: 'dates' };
  },
  'review-deadlines': (a, sid) => {
    const unconfirmed = a.deadlines(sid).filter((d) => !d.confirmed && !d.done);
    return { message: msg(sid, unconfirmed.length ? `Here are the dates to check:\n${unconfirmed.map((d, i) => `${i + 1}. ${d.title}${d.course ? ` (${d.course})` : ''}, ${shortDate(d.due)}`).join('\n')}` : 'All your dates are confirmed.', unconfirmed.length ? [{ label: 'They look right', action: 'confirm-deadlines:all' }] : [back], 'coursework-planner'), view: 'dates' };
  },
  'upload-syllabus': (_a, sid) => ({ message: msg(sid, 'Paste the schedule part of your syllabus, or forward the email it came in. I will find every date and ask you to check them.', [back], 'coursework-planner'), view: 'syllabus' }),
  'add-shifts': (_a, sid) => ({ message: msg(sid, 'Send me your shifts like this: Tue 3pm-9pm, Thu 4-10pm. I will plan around them.', [back]), view: 'shifts' }),
  'draft-instructor-note': (a, sid, arg) => {
    const d = deadline(a, sid, arg);
    const s = a.student(sid);
    return showDraft(a, sid, `instructor-note:${arg}`, `instructor (${d?.course ?? 'your class'})`, `Hello, this is ${s.chosenName} from ${d?.course ?? 'your class'}. I would like to talk about a plan for ${d?.title ?? 'an assignment'}. Is there a time this week that works, or a way I can still turn it in? Thank you.`, 'Instructors usually say yes when you ask early.');
  },

  // calendar and week
  week: (a, sid) => ({ message: a.week(sid).message, view: 'week' }),
  'draft-week-fix': (a, sid) => {
    const p = a.week(sid).problems[0];
    const s = a.student(sid);
    return showDraft(a, sid, 'week-fix', 'your manager', `Hi, this is ${s.chosenName}. ${p ? `On ${shortDate(p.date)} my shift runs into child care pickup.` : 'One of my shifts is hard to make work this week.'} Could I start or end earlier that day, or swap with someone? Thank you.`, 'A small change to one shift usually fixes it.');
  },
  'draft-reschedule': (a, sid, arg) => {
    const ap = deadline(a, sid, arg);
    const s = a.student(sid);
    return showDraft(a, sid, `reschedule:${arg}`, 'the office', `Hello, this is ${s.chosenName}. I have ${ap?.title ?? 'an appointment'} on ${ap ? shortDate(ap.due) : 'that day'}, but it overlaps a class or shift I can't move. Could we find another time? Thank you.`, 'Offices move appointments all the time.');
  },
  dismiss: (a, sid, arg) => {
    a.dismiss(sid, arg);
    return { message: msg(sid, 'Okay, I will leave it as is.', [back]) };
  },
  'pick-class': (a, sid) => ({ message: msg(sid, `Which class moved? Send the course and the new room, like "${a.classes(sid)[0]?.course ?? 'ENG 1101'} moved to Building 3 room 212".`, [back]) }),
  remind: (a, sid, arg) => {
    const at = addDays(a.today_(sid).date, 7);
    a.remind(sid, arg, at, `A reminder about ${arg}.`);
    return { message: msg(sid, `I will remind you about ${arg} on ${shortDate(at)}.`, [back]) };
  },
  'remind-meeting': (a, sid, arg) => {
    a.remind(sid, `meeting:${arg}`, a.today_(sid).date, 'Your meeting starts in 30 minutes.');
    return { message: msg(sid, 'I will remind you 30 minutes before it starts.', [back]) };
  },
  'draft-group-note': (a, sid, arg) => {
    const s = a.student(sid);
    return showDraft(a, sid, `group-note:${arg}`, 'your group', `Hi all, it's ${s.chosenName}. Before we meet, can we each send what we've done so far and what we're stuck on? That way we can use the time well.`, 'A quick note before a meeting saves time.');
  },

  // aid and offices
  'aid-verification-checklist': (_a, sid) => ({
    message: msg(sid, 'Verification asks you to prove what your FAFSA said. Most schools ask for some of these:\n1. The verification worksheet from your aid portal\n2. A tax return transcript, or a signed copy of the return\n3. W-2s for everyone who worked\n4. Proof of household size\nYour aid portal lists exactly what yours needs.', [{ label: 'Draft a question to the aid office', action: 'draft:aid-office' }, back], 'navigator'),
  }),
  draft: (a, sid, arg) => {
    const s = a.student(sid);
    if (arg.startsWith('ask:')) {
      const term = TERMS.find((t) => t.term === arg.slice(4));
      return showDraft(a, sid, `ask:${arg.slice(4)}`, term?.ask ?? 'the office', `Hello, this is ${s.chosenName}. I have a question about ${term?.term ?? 'a college rule'} and how it applies to me. Could you tell me what I need to know or do? Thank you.`, 'Offices answer questions like this every day.');
    }
    if (arg === 'career') return showDraft(a, sid, 'career', 'career services', `Hello, this is ${s.chosenName}. I'm a student and I would like help finding a job that fits my classes. Could I set up a time to meet, and what should I bring? Thank you.`, 'Career offices are glad to hear from students.');
    if (arg.startsWith('job:')) {
      const p = a.campusFeed(s.enrollment.college)?.postings.find((x) => x.id === arg.slice(4));
      if (!p) return { message: msg(sid, 'That posting is no longer open.', [{ label: 'Jobs that fit', action: 'jobs-fit' }, back]) };
      return showDraft(a, sid, `job:${p.id}`, p.employer, `Hello, this is ${s.chosenName}. I'm a student and I'm interested in the ${p.title} job. The hours fit my class schedule. What is the best way to apply, and is there anything I should send? Thank you.`, 'A short note shows you are serious.');
    }
    if (arg.startsWith('late:')) {
      const course = decodeURIComponent(arg.slice(5));
      return showDraft(a, sid, `late:${course}`, `your ${course} instructor`, `Hello, this is ${s.chosenName} from ${course}. My bus is running late today, so I may be a few minutes late to class. I will come in quietly. Thank you for understanding.`, 'A quick note before class is all it takes.');
    }
    if (arg.startsWith('letter:')) {
      const to = decodeURIComponent(arg.slice(7)) || 'the sender';
      return showDraft(a, sid, `letter:${to}`, to, `Hello, this is ${s.chosenName}. I got your letter and want to make sure I understand it. What exactly do you need from me, and by what date? Thank you.`, 'Asking is always okay.');
    }
    return showDraft(a, sid, 'aid-office', 'Financial Aid', `Hello, this is ${s.chosenName}. I got a message about verification for my financial aid. Could you tell me exactly which documents you need from me and the deadline? Thank you.`, 'Asking early keeps your aid on time.');
  },
  approve: (a, sid, arg) => {
    const d = a.drafts(sid).find((x) => x.id === arg);
    if (!d) return { message: msg(sid, 'That draft is gone. Nothing was sent.', [back]) };
    if (d.status === 'sent') return { message: msg(sid, `That one already went to ${d.to}.`, [back]) };
    const token = a.approve(sid, arg);
    void a.send(sid, arg, token);
    return { message: msg(sid, `Sent to ${d.to}. I will watch for a reply and let you know.`, [back]), view: 'drafts' };
  },
  'show-draft': (a, sid, arg) => {
    const d = arg ? a.draftFor(sid, arg) : a.drafts(sid).find((x) => x.status === 'shown');
    if (!d) return { message: msg(sid, 'No drafts are waiting.', [back]), view: 'drafts' };
    return { message: msg(sid, `Here is the draft to ${d.to}:\n"${d.body}"\nNothing is sent until you say so.`, [{ label: 'Send it', action: `approve:${d.id}` }, back]), view: 'drafts', viewArg: arg };
  },

  // careers
  career: (a, sid) => ({ message: a.careerMessage(sid), view: 'help' }),
  'fair-chance': (a, sid) => ({ message: a.fairChanceMessage(sid) }),

  'jobs-fit': (a, sid) => ({ message: a.jobsMessage(sid), view: 'help' }),
  'jobs-fair-chance': (a, sid) => ({ message: a.jobsMessage(sid, { fairChance: true }), view: 'help' }),
  mentors: (a, sid) => ({ message: a.mentorsMessage(sid), view: 'help' }),
  'mentor-intro': (a, sid, arg) => {
    const s = a.student(sid);
    const m = a.campusFeed(s.enrollment.college)?.mentors.find((x) => x.id === arg);
    if (!m) return { message: msg(sid, 'That mentor is not taking new people right now.', [{ label: 'Other mentors', action: 'mentors' }, back]) };
    return showDraft(a, sid, `mentor:${m.id}`, m.displayName, `Hi ${m.displayName.split(' ')[0]}, I'm ${s.chosenName}, a student at ${collegeById(s.enrollment.college)?.short ?? 'my college'}. I'd like to learn about working in ${m.field}. Could we talk for 20 minutes sometime? Thank you.`, 'Only your first name and this note are shared.');
  },

  // campus life and getting there
  'campus-food': (a, sid) => ({ message: a.campusFoodMessage(sid), view: 'help' }),
  'free-food': (a, sid) => ({ message: a.freeFoodMessage(sid), view: 'help' }),
  'study-spots': (a, sid) => ({ message: a.studySpotsMessage(sid), view: 'help' }),
  'book-room': (a, sid, arg) => ({ message: campusLife.bookRoom(a, sid, arg), view: 'help' }),
  'leave-by': (a, sid) => ({ message: a.leaveByMessage(sid), view: 'today' }),
  'next-bus': (a, sid) => ({ message: a.nextBusMessage(sid), view: 'today' }),
  'set-stop': (a, sid, arg) => {
    if (!arg) {
      a.setCommute(sid, { homeStop: '' });
      return { message: a.leaveByMessage(sid), view: 'today' };
    }
    const stop = a.campusFeed(a.student(sid).enrollment.college)?.stops.find((s) => s.id === arg);
    if (!stop) return { message: msg(sid, 'I don\'t know that stop.', [{ label: 'Pick my stop', action: 'leave-by' }, back]) };
    a.setCommute(sid, { mode: 'bus', homeStop: stop.id });
    return { message: msg(sid, `Got it: you leave from ${stop.name}. I will plan your bus to class each morning.`, [{ label: 'Next bus', action: 'next-bus' }, back]), view: 'today' };
  },

  // meals
  'meal-plan': (a, sid) => ({ message: a.mealPlanMessage(sid), view: 'meals' }),
  meals: (a, sid) => ({ message: a.mealPlanMessage(sid), view: 'meals' }),

  // letters
  letter: (_a, sid) => ({ message: msg(sid, 'Paste the letter, or forward the email it came in. I will say what it means, what to do and by when.', [back], 'navigator'), view: 'letter' }),
  'add-date': (a, sid, arg) => {
    const [date, label] = [arg.slice(0, 10), decodeURIComponent(arg.slice(11) || 'Date from a letter')];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ACTIONS.letter!(a, sid, '');
    a.addDeadline(sid, { title: label, due: date, kind: /court|interview|appointment/i.test(label) ? 'appointment' : 'other', source: { type: 'student', line: 'From a letter' }, confirmed: true });
    return { message: msg(sid, sentence(`Added: ${label}, ${shortDate(date)}. I will remind you before it`), [{ label: 'See my dates', action: 'review-deadlines' }, back]), view: 'dates' };
  },

  // pulses and settings
  pulse: (a, sid, arg) => {
    const [pid, ans] = arg.split(':');
    return { message: a.answerPulse(sid, pid!, ans === 'yes' ? 'yes' : 'no') };
  },
  'my-plan': (_a, sid) => ({ message: msg(sid, 'Here is your plan, most urgent first.', [back], 'navigator'), view: 'plan' }),
  'barrier-still': (a, sid, arg) => (isNeed(arg) ? { message: a.answerBarrierCheck(sid, arg, false) } : { message: msg(sid, 'I could not tell which need that was.', [back]) }),
  'pulses-off': (a, sid) => {
    a.setPulses(sid, { off: true });
    return { message: msg(sid, 'Done. No more quick questions. You can turn them back on in Settings.', [{ label: 'Settings', action: 'settings' }]) };
  },
  'pulses-on': (a, sid) => {
    a.setPulses(sid, { off: false });
    return { message: msg(sid, 'Quick questions are back on, at most every few days.', [back]), view: 'settings' };
  },
  dial: (a, sid, arg) => {
    a.setDial(sid, { depth: (['brief', 'standard', 'walk-me-through'].includes(arg) ? arg : 'standard') as never });
    return { message: msg(sid, arg === 'brief' ? 'Done. Short answers from now on.' : arg === 'walk-me-through' ? 'Okay. I will go step by step.' : 'Okay. Regular detail from now on.', [back]), view: 'settings' };
  },
  'source-on': (a, sid, arg) => {
    a.connectSource(sid, arg as never);
    return { message: msg(sid, `Your ${arg.replace(/-/g, ' ')} is connected. You can turn it off any time.`, [back]), view: 'settings' };
  },
  'source-off': (a, sid, arg) => {
    a.disconnectSource(sid, arg);
    return { message: msg(sid, `Your ${arg.replace(/-/g, ' ')} is off. I stopped reading it.`, [back]), view: 'settings' };
  },
  playbook: (a, sid, arg) => {
    const [id, ev, value] = arg.split(':');
    const def = a.playbooks.get(id!);
    if (!def) return { message: msg(sid, 'That checklist is not available right now.', [back]) };
    if (ev === 'draft') return ACTIONS['show-draft']!(a, sid, '');
    if (ev === 'help') return { message: msg(sid, `${def.recovery[0] ?? 'This step is one people often get stuck on.'} 2-1-1 can also help any time.`, [{ label: 'Call 2-1-1', action: 'call:211' }, { label: 'Done with this step', action: `playbook:${id}:confirm` }], `playbook:${id}`) };
    const started = a.store.get('playbook_runs', `${sid}:${id}`);
    const run = !started || ev === 'start' ? a.startPlaybook(sid, id!) : a.playbookEvent(sid, id!, ev === 'answer' ? { type: 'answer', value: value! } : { type: 'confirm' });
    return { message: a.playbookMessage(sid, run) };
  },
  'delete-account': (a, sid) => {
    a.deleteStudent(sid);
    return { message: { studentId: sid, author: 'chief-of-staff', urgency: 'routine', text: 'Everything is deleted. You can start again any time.', nextSteps: [] }, view: 'deleted' };
  },
};
