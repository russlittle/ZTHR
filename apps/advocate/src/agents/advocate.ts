import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EvidenceStore } from '@zthr/evidence';
import {
  ApprovalService,
  ConsentLedger,
  OutboundGate,
  SealedStore,
  crisisReply,
  decideContact,
  screen,
  type ApprovalToken,
  type OutboundAction,
} from '@zthr/runtime';
import { SmsTwin } from '@zthr/twins';
import type { ModelClient } from '@zthr/models';
import { DAYTON_CATALOG } from '../catalog/dayton.js';
import type { Resource } from '../catalog/types.js';
import { screenAll, type EligibilityResult } from '../eligibility/engine.js';
import { bookOptions, type Material } from '../domain/books.js';
import { crisisPlan, detectSituation, DRAFTS, type Situation } from '../domain/crisis.js';
import { daysBetween } from '../domain/dates.js';
import { parseIcs } from '../domain/ics.js';
import { classifyInbound, type InboundItem } from '../domain/inbound.js';
import { findGap, gapMessage } from '../domain/money.js';
import { COLLEGE_COUNTY, findHelp, stepsLeft, type PlanOption } from '../domain/navigator.js';
import { upcomingMessages } from '../domain/planner.js';
import { AppStore } from '../domain/store.js';
import { aiPolicySentence, parseSyllabus, type AiPolicy } from '../domain/syllabus.js';
import { buildToday, renderToday, type TodayView } from '../domain/today.js';
import { checkTone } from '../domain/tone.js';
import {
  DEFAULT_DIAL,
  type Bill,
  type ClassMeeting,
  type Deadline,
  type HelpDial,
  type NeedCategory,
  type OutboundMessage,
  type Paycheck,
  type Shift,
  type Student,
} from '../domain/types.js';
import { advance, currentStep, fillTemplate, loadPlaybooks, startRun, type PlaybookDef, type PlaybookEvent, type PlaybookRun } from '../playbooks/engine.js';

/**
 * The Advocate: one student's team behind a single voice (the chief of staff).
 * Every capability is a method here, used identically by the text channel, the
 * web app and the journeys, so text and app stay at parity (PRD P8).
 */
export interface Delivered extends OutboundMessage {
  id: string;
  at: string;
  status: 'delivered' | 'deferred' | 'held';
  holdReason?: string;
}

export interface Draft {
  id: string;
  studentId: string;
  to: string;
  recipient: string;
  body: string;
  purpose: string;
  status: 'shown' | 'sent' | 'discarded';
}

interface Onboarding {
  phone: string;
  stage: 'start' | 'where' | 'household' | 'school' | 'done';
  studentId?: string;
  partial: Partial<Student>;
}

export interface AdvocateOptions {
  today?: () => string;
  now?: () => Date;
  catalog?: Resource[];
  model?: ModelClient;
  evidence?: EvidenceStore;
  playbookDir?: string;
  fromNumber?: string;
}

const NEED_WORDS: [NeedCategory, RegExp][] = [
  ['food', /\b(food|groceries|hungry|pantry|meal|lunch|snap|food stamps)\b/i],
  ['housing', /\b(housing|rent|apartment|shelter|homeless|place to (live|stay)|evict)\b/i],
  ['utilities', /\b(utilit(y|ies)|electric|gas bill|heat(ing)?|water bill|power bill|heap)\b/i],
  ['transportation', /\b(ride|bus|transit|car|gas money|get to (class|campus|work))\b/i],
  ['childcare', /\b(child ?care|daycare|babysit)\b/i],
  ['phone-internet', /\b(phone bill|internet|wifi|lifeline)\b/i],
  ['legal', /\b(legal|lawyer|court)\b/i],
  ['books', /\b(book|textbook)s?\b/i],
  ['money', /\b(money|emergency grant|broke|cash|pay (a|my) bill)\b/i],
  ['mental-health', /\b(counsel(ing|or)|therap(y|ist)|stressed|anxious|depressed)\b/i],
];

export class Advocate {
  readonly store: AppStore;
  readonly evidence: EvidenceStore;
  readonly ledger = new ConsentLedger();
  readonly sealed: SealedStore;
  readonly approvals: ApprovalService;
  readonly sms = new SmsTwin();
  readonly outboundLog: OutboundAction[] = [];
  readonly catalog: Resource[];
  readonly playbooks: Map<string, PlaybookDef>;
  private readonly outbound: OutboundGate;
  private readonly onboarding = new Map<string, Onboarding>();
  private readonly today: () => string;
  private readonly now: () => Date;
  private readonly fromNumber: string;
  readonly model?: ModelClient;
  private readonly pseudSalt = randomBytes(32);

  /** Evidence is pseudonymous: subjects are keyed hashes, and no message content is recorded. */
  pseud(subject: string): string {
    return createHmac('sha256', this.pseudSalt).update(subject).digest('hex').slice(0, 16);
  }

  private ev(kind: string, subject: string, data: Record<string, unknown> = {}, raw = false): void {
    this.evidence.append(kind, raw ? subject : this.pseud(subject), data);
  }

  constructor(o: AdvocateOptions = {}) {
    this.store = new AppStore();
    this.evidence = o.evidence ?? new EvidenceStore();
    this.sealed = new SealedStore(randomBytes(32), this.ledger);
    this.approvals = new ApprovalService(randomBytes(32));
    this.outbound = new OutboundGate(this.approvals, async (a) => void this.outboundLog.push(a));
    this.catalog = o.catalog ?? DAYTON_CATALOG;
    this.today = o.today ?? (() => new Date().toISOString().slice(0, 10));
    this.now = o.now ?? (() => new Date());
    this.model = o.model;
    this.fromNumber = o.fromNumber ?? '+19375550100';
    this.playbooks = loadPlaybooks(o.playbookDir ?? fileURLToPath(new URL('../../../../control/playbooks', import.meta.url)));
  }

  // ---------- students ----------

  createStudent(p: Partial<Student> & Pick<Student, 'chosenName' | 'zip'>): Student {
    const s: Student = {
      id: p.id ?? `stu_${randomUUID().slice(0, 8)}`,
      phone: p.phone,
      chosenName: p.chosenName,
      pronouns: p.pronouns,
      zip: p.zip,
      county: p.county ?? COLLEGE_COUNTY[p.enrollment?.college ?? ''],
      age: p.age,
      goal: p.goal,
      dial: { ...DEFAULT_DIAL, ...(p.dial ?? {}) },
      household: { size: 1, ...(p.household ?? {}) },
      enrollment: { college: 'sinclair', ...(p.enrollment ?? {}) },
      receives: p.receives ?? {},
      helpAreas: p.helpAreas ?? [],
      createdAt: this.today(),
    };
    this.store.put('students', s.id, s.id, s);
    this.ev('student', s.id, { event: 'created', channel: s.dial.channel });
    return s;
  }

  student(id: string): Student {
    const s = this.store.get<Student>('students', id);
    if (!s) throw new Error(`unknown student ${id}`);
    return s;
  }

  updateStudent(id: string, patch: Partial<Student>): Student {
    const s = { ...this.student(id), ...patch };
    this.store.put('students', id, id, s);
    return s;
  }

  setDial(id: string, patch: Partial<HelpDial>): Student {
    const s = this.student(id);
    return this.updateStudent(id, { dial: { ...s.dial, ...patch } });
  }

  // ---------- delivery: tone gate, contact governor, record ----------

  deliver(m: OutboundMessage, opts: { force?: boolean } = {}): Delivered {
    const s = this.student(m.studentId);
    const at = this.now().toISOString();
    const base = { ...m, id: `msg_${randomUUID().slice(0, 8)}`, at };
    const tone = checkTone(m, s.dial.depth, s.dial.readingGrade);
    if (!tone.ok && m.urgency !== 'safety') {
      const held: Delivered = { ...base, status: 'held', holdReason: tone.problems.join('; ') };
      this.store.put('messages', held.id, s.id, held);
      this.ev('tone_fail', s.id, { author: m.author, problems: tone.problems });
      return held;
    }
    const sentToday = this.store.list<Delivered>('messages', s.id).filter((x) => x.status === 'delivered' && x.at.slice(0, 10) === at.slice(0, 10) && x.urgency === 'routine').length;
    const decision = opts.force ? { action: 'send' as const } : decideContact({ maxPerDay: s.dial.maxPerDay, quietStart: s.dial.quietStart, quietEnd: s.dial.quietEnd, timeZone: 'America/New_York' }, this.now(), sentToday, m.urgency);
    const d: Delivered = { ...base, status: decision.action === 'send' ? 'delivered' : 'deferred', holdReason: decision.action === 'defer' ? decision.reason : undefined };
    this.store.put('messages', d.id, s.id, d);
    this.ev('message', s.id, { author: m.author, status: d.status, urgency: m.urgency, nextSteps: m.nextSteps.length, grade: Number(tone.grade.toFixed(1)) });
    if (d.status === 'delivered' && s.dial.channel === 'text' && s.phone) {
      const steps = m.nextSteps.length ? `\n${m.nextSteps.map((n, i) => `${i + 1}) ${n.label}`).join('\n')}` : '';
      void this.sms.send(s.phone, this.fromNumber, `${m.text}${steps}`);
    }
    return d;
  }

  messages(studentId: string): Delivered[] {
    return this.store.list<Delivered>('messages', studentId);
  }

  // ---------- conversation: the chief of staff ----------

  /** Start by text (PRD ON-1): useful before an account exists. */
  textIn(phone: string, body: string): string[] {
    const keyword = this.sms.inbound(phone, body);
    if (keyword === 'stop') return [];
    const existing = this.findByPhone(phone);
    if (existing) return this.converse(existing.id, body).map((d) => this.asText(d));
    return this.onboardStep(phone, body);
  }

  private asText(d: Delivered): string {
    return d.nextSteps.length ? `${d.text}\n${d.nextSteps.map((n, i) => `${i + 1}) ${n.label}`).join('\n')}` : d.text;
  }

  findByPhone(phone: string): Student | undefined {
    const rows = this.store.db.prepare("SELECT json FROM docs WHERE collection = 'students'").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as Student).find((s) => s.phone === phone);
  }

  private onboardStep(phone: string, body: string): string[] {
    const safety = screen(body);
    if (safety.crisis) {
      this.ev('safety_route', phone, { categories: safety.categories, before: 'account' });
      return [crisisReply(safety.categories)];
    }
    const o = this.onboarding.get(phone) ?? { phone, stage: 'start', partial: {} };
    this.onboarding.set(phone, o);
    switch (o.stage) {
      case 'start':
        o.stage = 'where';
        this.ev('onboarding', phone, { stage: 'start' });
        return [
          "Hi! I'm your Advocate. I work for you, not your college, and I never share anything unless you say so. Want me to check what money and help you might qualify for? It takes 4 quick questions.",
          'First: which college, and what ZIP code do you live in? (Example: Sinclair 45402)',
        ];
      case 'where': {
        const college = /wright/i.test(body) ? 'wright-state' : /antioch/i.test(body) ? 'antioch' : /sinclair/i.test(body) ? 'sinclair' : undefined;
        const zip = body.match(/\b(\d{5})\b/)?.[1];
        if (!college || !zip) return ["Got it. I just need your college and ZIP code, like 'Sinclair 45402'."];
        o.partial.enrollment = { college };
        o.partial.zip = zip;
        o.stage = 'household';
        return ['How many people are in your household, counting you, and about how much does your household earn in a month before taxes? (Example: 3 people, $1800)'];
      }
      case 'household': {
        const nums = [...body.matchAll(/\$?\s?([\d,]+)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
        if (nums.length < 2) return ["Thanks. Two numbers please: people in your household, and monthly income. Like '2, $1500'."];
        o.partial.household = { size: Math.max(1, nums[0]!), monthlyGrossIncome: nums[1]! };
        if (/\b(kid|child|son|daughter|baby)\b/i.test(body)) o.partial.household.childrenUnder12 = 1;
        o.stage = 'school';
        return ['Last one: how many credit hours are you taking, and how many hours a week do you work? (Example: 12 credits, 25 hours)'];
      }
      case 'school': {
        const credits = Number(body.match(/(\d+)\s*(credit|cr|hour)?s?\b.*?(credit|cr)?/i)?.[1] ?? NaN);
        const work = Number(body.match(/(\d+)\s*(hours|hrs|hr)\b(?!.*credit)/i)?.[1] ?? body.match(/(\d+)\D+(\d+)/)?.[2] ?? NaN);
        o.partial.enrollment = { ...(o.partial.enrollment as Student['enrollment']), creditHours: Number.isNaN(credits) ? undefined : credits, weeklyWorkHours: Number.isNaN(work) ? undefined : work, workStudy: false, degreeSeeking: true };
        const s = this.createStudent({ chosenName: 'there', phone, zip: o.partial.zip!, enrollment: o.partial.enrollment as Student['enrollment'], household: o.partial.household as Student['household'], dial: { ...DEFAULT_DIAL, channel: 'text' } });
        o.studentId = s.id;
        o.stage = 'done';
        this.ev('onboarding', s.id, { stage: 'screened' });
        const msg = this.moneyFoundMessage(s.id);
        return [this.asText(this.deliver(msg, { force: true })), 'What should I call you? You can also tell me your pronouns.'];
      }
      default:
        return [];
    }
  }

  /** Every message from a known student goes through here. */
  converse(studentId: string, text: string): Delivered[] {
    const s = this.student(studentId);
    const safety = screen(text);
    if (safety.crisis) {
      this.ev('safety_route', s.id, { categories: safety.categories });
      return [this.deliver({ studentId: s.id, author: 'safety-router', urgency: 'safety', text: crisisReply(safety.categories), nextSteps: [{ label: 'Call or text 988', action: 'call:988' }] })];
    }
    if (s.chosenName === 'there' && text.trim().length > 0 && text.trim().split(/\s+/).length <= 6 && !/\?/.test(text)) {
      const name = text.replace(/\b(call me|i'?m|my name is|it'?s)\b/gi, '').replace(/[.,!]/g, '').trim().split(/\s+/)[0] ?? 'there';
      const pronouns = text.match(/\b(she\/her|he\/him|they\/them|she\/they|he\/they)\b/i)?.[1];
      this.updateStudent(s.id, { chosenName: name.charAt(0).toUpperCase() + name.slice(1), pronouns });
      return [this.deliver({ studentId: s.id, author: 'chief-of-staff', urgency: 'routine', text: `Nice to meet you, ${name.charAt(0).toUpperCase() + name.slice(1)}. Text me anytime. Try TODAY for your day, or tell me what's going on.`, nextSteps: [{ label: 'Show my day', action: 'today' }, { label: 'Upload a syllabus', action: 'upload-syllabus' }] }, { force: true })];
    }
    const t = text.trim().toLowerCase();
    const situation = detectSituation(text);
    if (situation) return [this.deliver(this.crisis(s.id, situation).message, { force: true })];
    if (/^(today|my day|schedule|what'?s today)\b/.test(t)) return [this.deliver(this.todayMessage(s.id), { force: true })];
    if (/\b(brief|shorter|less detail)\b/.test(t)) {
      this.setDial(s.id, { depth: 'brief' });
      return [this.deliver({ studentId: s.id, author: 'chief-of-staff', urgency: 'routine', text: 'Done. Short answers from now on.', nextSteps: [{ label: 'More detail again', action: 'dial:standard' }] }, { force: true })];
    }
    if (/\b(walk me through|more detail|step by step)\b/.test(t)) {
      this.setDial(s.id, { depth: 'walk-me-through' });
      return [this.deliver({ studentId: s.id, author: 'chief-of-staff', urgency: 'routine', text: 'Okay. I will go step by step.', nextSteps: [{ label: 'Shorter answers', action: 'dial:brief' }] }, { force: true })];
    }
    if (/\bfafsa\b/.test(t)) return [this.deliver(this.playbookMessage(s.id, this.startPlaybook(s.id, 'fafsa-2027-28')), { force: true })];
    if (/\b(qualify|benefits|money found|screen)\b/.test(t)) return [this.deliver(this.moneyFoundMessage(s.id), { force: true })];
    const need = NEED_WORDS.find(([, re]) => re.test(text))?.[0];
    if (need) return [this.deliver(this.helpMessage(s.id, need), { force: true })];
    return [
      this.deliver(
        {
          studentId: s.id,
          author: 'chief-of-staff',
          urgency: 'routine',
          text: "I'm not sure I got that. I can run your day, find money and help you qualify for, plan your assignments, or help when something goes wrong.",
          nextSteps: [
            { label: 'Show my day', action: 'today' },
            { label: 'Find help with something', action: 'find-help' },
            { label: 'Check money I qualify for', action: 'screen' },
          ],
        },
        { force: true },
      ),
    ];
  }

  // ---------- run my day ----------

  addClasses(studentId: string, classes: ClassMeeting[]): void {
    classes.forEach((c, i) => this.store.put('classes', `${studentId}:${c.course}:${i}`, studentId, c));
  }

  addShifts(studentId: string, shifts: Shift[]): void {
    shifts.forEach((x) => this.store.put('shifts', `${studentId}:${x.date}:${x.start}`, studentId, x));
  }

  addDeadline(studentId: string, d: Omit<Deadline, 'id' | 'studentId'>): Deadline {
    const full: Deadline = { ...d, id: `dl_${randomUUID().slice(0, 8)}`, studentId };
    this.store.put('deadlines', full.id, studentId, full);
    return full;
  }

  deadlines(studentId: string): Deadline[] {
    return this.store.list<Deadline>('deadlines', studentId).sort((a, b) => a.due.localeCompare(b.due));
  }

  confirmDeadlines(studentId: string, ids: string[] | 'all'): void {
    for (const d of this.deadlines(studentId)) if (ids === 'all' || ids.includes(d.id)) this.store.put('deadlines', d.id, studentId, { ...d, confirmed: true });
  }

  markDone(studentId: string, deadlineId: string): void {
    const d = this.store.get<Deadline>('deadlines', deadlineId);
    if (d && d.studentId === studentId) this.store.put('deadlines', d.id, studentId, { ...d, done: true });
  }

  today_(studentId: string): TodayView {
    return buildToday(this.today(), this.store.list<ClassMeeting>('classes', studentId), this.store.list<Shift>('shifts', studentId), this.deadlines(studentId).filter((d) => d.confirmed));
  }

  todayMessage(studentId: string): OutboundMessage {
    const s = this.student(studentId);
    const v = this.today_(studentId);
    return {
      studentId,
      author: 'chief-of-staff',
      urgency: 'routine',
      text: renderToday(v, s),
      nextSteps: v.oneThing?.deadlineId
        ? [{ label: 'Plan it for me', action: `plan:${v.oneThing.deadlineId}` }, { label: 'Find help with it', action: `find-help:${v.oneThing.deadlineId}` }]
        : [{ label: 'Add a syllabus', action: 'upload-syllabus' }, { label: 'Add my work shifts', action: 'add-shifts' }],
      why: 'Built from your classes, shifts and confirmed deadlines.',
    };
  }

  /** Anticipate, then solve: messages for deadlines coming up or just passed. */
  lookAhead(studentId: string): OutboundMessage[] {
    const s = this.student(studentId);
    return upcomingMessages(s, this.today(), this.deadlines(studentId).filter((d) => d.confirmed), this.store.list<ClassMeeting>('classes', studentId), this.store.list<Shift>('shifts', studentId));
  }

  uploadSyllabus(studentId: string, course: string, text: string, termStart: string): { deadlines: Deadline[]; aiPolicy: AiPolicy; message: OutboundMessage } {
    const r = parseSyllabus(course, text, termStart);
    const created = r.deadlines.map((d) => this.addDeadline(studentId, d));
    this.store.put('courses', `${studentId}:${course}`, studentId, { course, aiPolicy: r.aiPolicy, aiPolicyLine: r.aiPolicyLine });
    this.ev('syllabus', studentId, { course, extracted: created.length, aiPolicy: r.aiPolicy });
    return {
      deadlines: created,
      aiPolicy: r.aiPolicy,
      message: {
        studentId,
        author: 'coursework-planner',
        urgency: 'routine',
        text: `I found ${created.length} dates in your ${course} syllabus. Take a quick look to make sure I read them right. ${aiPolicySentence(r.aiPolicy, course)}`,
        nextSteps: [{ label: 'They look right', action: 'confirm-deadlines:all' }, { label: 'Show me each one', action: 'review-deadlines' }],
        why: r.aiPolicyLine ? `AI policy line: "${r.aiPolicyLine}"` : 'No AI policy line found in the syllabus.',
      },
    };
  }

  courseAiPolicy(studentId: string, course: string): AiPolicy {
    return this.store.get<{ aiPolicy: AiPolicy }>('courses', `${studentId}:${course}`)?.aiPolicy ?? 'unstated';
  }

  addCalendarFeed(studentId: string, ics: string, course?: string): Deadline[] {
    return parseIcs(ics, course).map((d) => this.addDeadline(studentId, d));
  }

  // ---------- inbound: forwarded email and texts ----------

  forward(studentId: string, text: string, meta: { from?: string; subject?: string } = {}): { item: InboundItem; message?: OutboundMessage } {
    const item = classifyInbound(text, meta);
    this.ev('inbound', studentId, { kind: item.kind });
    const map: Partial<Record<InboundItem['kind'], () => OutboundMessage>> = {
      'utility-shutoff': () => this.crisis(studentId, 'utility-shutoff').message,
      'eviction-notice': () => this.crisis(studentId, 'eviction').message,
      'rent-late': () => this.crisis(studentId, 'rent-short').message,
      'aid-verification': () => ({
        studentId,
        author: 'navigator',
        urgency: 'time-sensitive',
        text: 'Your aid office is asking for verification documents. That is common and fixable. I can list what they want and help you gather it so your aid is not held up.',
        nextSteps: [{ label: 'List what they need', action: 'aid-verification-checklist' }, { label: 'Draft a question to the aid office', action: 'draft:aid-office' }],
        why: `From a forwarded message${meta.subject ? `: "${meta.subject}"` : ''}.`,
      }),
      'room-change': () => ({ studentId, author: 'chief-of-staff', urgency: 'time-sensitive', text: 'Your class moved rooms. I updated your day so the new room shows up.', nextSteps: [{ label: 'Show my day', action: 'today' }], why: meta.subject ?? 'Forwarded message' }),
      'class-canceled': () => ({ studentId, author: 'chief-of-staff', urgency: 'time-sensitive', text: 'Heads up: your class is canceled. That frees up some time. Want to use it for what is due next?', nextSteps: [{ label: 'Plan the free time', action: 'plan-free-time' }], why: meta.subject ?? 'Forwarded message' }),
    };
    return { item, message: map[item.kind]?.() };
  }

  // ---------- money found, navigator, crisis ----------

  screen(studentId: string): EligibilityResult[] {
    return screenAll(this.student(studentId), this.today());
  }

  moneyFoundMessage(studentId: string): OutboundMessage {
    const results = this.screen(studentId).filter((r) => r.status === 'likely');
    const needsInfo = this.screen(studentId).filter((r) => r.status === 'needs-info');
    const lines = results.map((r) => (r.estimatedMonthlyValue ? `${r.title}: about $${r.estimatedMonthlyValue.toFixed(r.estimatedMonthlyValue % 1 ? 2 : 0)} a month${r.valueIsEstimate ? ' (estimate)' : ''}` : r.title));
    const text = results.length
      ? `You likely qualify for: ${lines.join('; ')}. Want me to start the first one? I'll fill in what I can.`
      : needsInfo.length
        ? `I need a bit more to check: ${[...new Set(needsInfo.flatMap((r) => r.needs))].slice(0, 2).join(', ')}.`
        : "I didn't find a match in the programs I check yet, but there's more help than benefits. Tell me what's hard right now and I'll look.";
    const first = results[0];
    return {
      studentId,
      author: 'navigator',
      urgency: 'routine',
      text,
      nextSteps: first
        ? [{ label: `Start ${first.title}`, action: `start-program:${first.program}` }, { label: 'Why do I qualify?', action: 'why-qualify' }]
        : [{ label: 'Tell you what is hard', action: 'find-help' }, { label: 'Answer a question', action: 'screen-more' }],
      why: results.map((r) => `${r.title}: ${r.reasons.join(' ')}`).join(' | ') || 'Screened SNAP, Lifeline, HEAP and campus emergency aid.',
    };
  }

  vaultDocuments(studentId: string): string[] {
    return this.store.list<{ name: string }>('vault', studentId).map((d) => d.name);
  }

  addDocument(studentId: string, name: string, content: string): void {
    this.sealed.seal(studentId, `doc:${name}`, content);
    this.store.put('vault', `${studentId}:${name}`, studentId, { name, addedAt: this.today() });
  }

  findHelp(studentId: string, need: NeedCategory): { options: PlanOption[]; unmet: boolean } {
    const r = findHelp(this.student(studentId), need, { catalog: this.catalog, today: this.today(), vaultDocuments: this.vaultDocuments(studentId) });
    if (r.unmet) this.recordUnmet(studentId, need);
    this.ev('find_help', studentId, { need, options: r.options.length, medianStepsLeft: r.options.length ? stepsLeft(r.options[0]!) : null });
    return r;
  }

  helpMessage(studentId: string, need: NeedCategory): OutboundMessage {
    const r = this.findHelp(studentId, need);
    if (r.unmet) {
      return {
        studentId,
        author: 'navigator',
        urgency: 'routine',
        text: `I couldn't find a verified ${need.replace('-', ' ')} resource near you yet. I've noted the gap so it gets counted. 2-1-1 can help right now, any time.`,
        nextSteps: [{ label: 'Call 2-1-1', action: 'call:211' }, { label: 'Look for something else', action: 'find-help' }],
        why: 'No fresh catalog entry serves your college or county for this need.',
      };
    }
    const top = r.options.slice(0, 3);
    return {
      studentId,
      author: 'navigator',
      urgency: 'routine',
      text: `Here's ${need.replace('-', ' ')} help that fits you:\n${top
        .map((o, i) => `${i + 1}. ${o.resource.name}${o.resource.hours ? ` (${o.resource.hours})` : ''}${o.resource.phone ? `, ${o.resource.phone}` : ''}`)
        .join('\n')}\nWant me to start one?`,
      nextSteps: top.slice(0, 2).map((o) => ({ label: `Start: ${o.resource.name}`, action: `start-resource:${o.resource.id}` })),
      why: top.map((o) => `${o.resource.name}: ${o.why}`).join(' | '),
    };
  }

  crisis(studentId: string, situation: Situation) {
    const plan = crisisPlan(this.student(studentId), situation, this.catalog, this.today(), this.vaultDocuments(studentId));
    for (const n of plan.unmet) this.recordUnmet(studentId, n);
    this.ev('crisis_intake', studentId, { situation, options: plan.options.length });
    const draft = DRAFTS[situation]?.(this.student(studentId));
    if (draft) this.createDraft(studentId, draft.to, draft.to, draft.body, situation);
    return plan;
  }

  recordUnmet(studentId: string, need: NeedCategory): void {
    const s = this.student(studentId);
    this.ev('unmet_need', s.county ?? 'unknown',  { need, college: s.enrollment.college }, true);
  }

  // ---------- drafts and the student sends (PRD P9) ----------

  createDraft(studentId: string, to: string, recipient: string, body: string, purpose: string): Draft {
    const d: Draft = { id: `dr_${randomUUID().slice(0, 8)}`, studentId, to, recipient, body, purpose, status: 'shown' };
    this.store.put('drafts', d.id, studentId, d);
    return d;
  }

  drafts(studentId: string): Draft[] {
    return this.store.list<Draft>('drafts', studentId);
  }

  /** Issued only when the student taps approve on the exact draft shown. */
  approve(studentId: string, draftId: string): ApprovalToken {
    const d = this.store.get<Draft>('drafts', draftId);
    if (!d || d.studentId !== studentId) throw new Error('no such draft');
    const token = this.approvals.issue({ studentId, kind: 'email', recipient: d.recipient, content: { body: d.body } });
    this.ledger.append(studentId, 'approve', `draft:${draftId}`, { recipient: d.recipient });
    return token;
  }

  async send(studentId: string, draftId: string, token: ApprovalToken | undefined): Promise<{ sent: boolean; reason?: string }> {
    const d = this.store.get<Draft>('drafts', draftId);
    if (!d || d.studentId !== studentId) return { sent: false, reason: 'no such draft' };
    const r = await this.outbound.dispatch({ studentId, kind: 'email', recipient: d.recipient, content: { body: d.body } }, token);
    if (r.sent) this.store.put('drafts', d.id, studentId, { ...d, status: 'sent' });
    this.ev('outbound', studentId, { sent: r.sent, reason: r.reason ?? null });
    return r;
  }

  // ---------- playbooks ----------

  startPlaybook(studentId: string, id: string): PlaybookRun {
    const def = this.playbooks.get(id);
    if (!def) throw new Error(`no playbook ${id}`);
    const run = startRun(def, studentId, this.today());
    this.store.put('playbook_runs', `${studentId}:${id}`, studentId, run);
    this.ev('playbook', studentId, { playbook: id, event: 'started' });
    return run;
  }

  playbookEvent(studentId: string, id: string, ev: PlaybookEvent): PlaybookRun {
    const def = this.playbooks.get(id)!;
    const run = this.store.get<PlaybookRun>('playbook_runs', `${studentId}:${id}`);
    if (!run) throw new Error('playbook not started');
    const next = advance(def, run, ev, this.today());
    this.store.put('playbook_runs', `${studentId}:${id}`, studentId, next);
    const step = currentStep(def, next);
    if (step.kind === 'draft' && next.status === 'active') {
      const s = this.student(studentId);
      const body = fillTemplate(def, step.text, { chosenName: s.chosenName, college: s.enrollment.college });
      if (!this.drafts(studentId).some((d) => d.purpose === `${id}:${step.id}`)) this.createDraft(studentId, step.to ?? 'office', step.to ?? 'office', body, `${id}:${step.id}`);
    }
    this.ev('playbook', studentId, { playbook: id, event: ev.type, step: next.stepId, status: next.status });
    return next;
  }

  playbookMessage(studentId: string, run: PlaybookRun): OutboundMessage {
    const def = this.playbooks.get(run.playbook)!;
    const step = currentStep(def, run);
    const s = this.student(studentId);
    const text = fillTemplate(def, step.text, { chosenName: s.chosenName, college: s.enrollment.college });
    const nextSteps =
      step.kind === 'question' && step.branches
        ? Object.keys(step.branches).map((k) => ({ label: k === 'yes' ? 'Yes' : k === 'no' ? 'No' : k, action: `playbook:${run.playbook}:answer:${k}` }))
        : step.kind === 'draft'
          ? [{ label: 'Show me the message', action: `playbook:${run.playbook}:draft` }]
          : [{ label: 'Done', action: `playbook:${run.playbook}:confirm` }, { label: 'Help me with this step', action: `playbook:${run.playbook}:help` }];
    return { studentId, author: `playbook:${run.playbook}`, urgency: 'routine', text: `${def.title}: ${text}`, nextSteps, why: def.purpose };
  }

  // ---------- money ----------

  setMoney(studentId: string, balance: number, bills: Bill[], pay?: Paycheck): void {
    this.store.put('money', studentId, studentId, { balance, bills, pay });
  }

  moneyCheck(studentId: string): OutboundMessage | undefined {
    const m = this.store.get<{ balance: number; bills: Bill[]; pay?: Paycheck }>('money', studentId);
    if (!m) return undefined;
    const gap = findGap(m.balance, m.bills, m.pay, this.today());
    if (!gap) return undefined;
    const s = this.student(studentId);
    const bill = m.bills.find((b) => b.name === gap.bill);
    const options = [
      ...(this.screen(studentId).some((r) => r.program === 'sinclair-emergency-grant' && r.status === 'likely') ? [{ label: 'Apply for the emergency grant', action: 'start-resource:sinclair-emergency-grant' }] : []),
      { label: `Ask ${bill?.kind === 'rent' ? 'the landlord' : 'the company'} for more time`, action: `show-draft:${bill?.kind === 'rent' ? 'rent-short' : 'utility-shutoff'}` },
      ...(bill?.kind === 'utility' ? [{ label: 'Apply for HEAP', action: 'start-resource:ohio-heap' }] : []),
      { label: 'Talk to 2-1-1', action: 'call:211' },
    ];
    if (!this.drafts(studentId).some((d) => d.purpose === 'rent-short') && bill?.kind === 'rent') this.createDraft(studentId, 'landlord', 'landlord', DRAFTS['rent-short']!(s).body, 'rent-short');
    this.ev('money_gap', studentId, { daysAhead: daysBetween(this.today(), gap.date), shortBy: gap.shortBy });
    return gapMessage(s, gap, this.today(), options);
  }

  // ---------- books ----------

  books(studentId: string, materials: Material[]) {
    const s = this.student(studentId);
    return materials.map((m) => ({ material: m, options: bookOptions(m, s.enrollment.college) }));
  }

  // ---------- sealed facts and control ----------

  seal(studentId: string, fact: string, value: string): void {
    this.sealed.seal(studentId, fact, value);
  }

  grantToPlaybook(studentId: string, fact: string, playbook: string): void {
    const def = this.playbooks.get(playbook);
    if (!def?.student_grants.sealed.includes(fact)) throw new Error(`${playbook} does not declare ${fact}`);
    this.sealed.grant(studentId, fact, `playbook:${playbook}`);
  }

  exportData(studentId: string): Record<string, unknown> {
    this.ledger.append(studentId, 'export', 'all', {});
    return { ...this.store.exportStudent(studentId), consent: this.ledger.entries(studentId) };
  }

  deleteStudent(studentId: string): { removed: number; remaining: number } {
    const removed = this.store.deleteStudent(studentId);
    this.sealed.forget(studentId);
    this.ledger.append(studentId, 'delete', 'account', { removed });
    this.ev('student', 'deleted', { removed }, true);
    return { removed, remaining: this.store.countFor(studentId) };
  }
}
