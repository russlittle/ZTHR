/**
 * The Advocate's data, declared once. Every collection the app writes is listed here with its fields and how it
 * relates to the others. The data-model document and its ERD are generated from this list, and tests fail when the
 * code writes a collection or a field this list does not declare, so the picture can never drift from the system.
 */
import type { CollectionDef as BlockCollectionDef, DataClass, FieldDef } from '@zthr/store';

export type { DataClass, FieldDef };
export interface CollectionDef extends BlockCollectionDef {
  /** Which part of the record it belongs to, for drawing. */
  group?: 'schedule' | 'conversation' | 'help and money' | 'connections' | 'campus' | 'school';
}

const f = (name: string, type: string, note?: string, optional = false): FieldDef => ({ name, type, ...(note ? { note } : {}), optional });
const o = (name: string, type: string, note?: string): FieldDef => f(name, type, note, true);

const DECLARED: CollectionDef[] = [
  {
    name: 'students',
    purpose: 'Who the student is and how they want to be helped. Sealed facts are never stored here.',
    key: 'id',
    fields: [f('id', 'string', 'stable id'), o('phone', 'string'), f('chosenName', 'string'), o('pronouns', 'string'), f('zip', 'string'), o('county', 'string'), o('age', 'number'), o('goal', 'string'), f('dial', 'HelpDial', 'depth, channel, reading grade, language, quiet hours'), f('household', 'Household', 'size, income, children'), f('enrollment', 'Enrollment', 'college, credits, work hours'), o('receives', 'object', 'benefits already received'), f('helpAreas', 'string[]'), o('communities', 'string[]', 'chosen, never inferred'), o('account', 'string', 'keyed hash of the sign-in subject'), f('createdAt', 'date')],
    relations: [
      ['deadlines', 'has', '||--o{'], ['classes', 'attends', '||--o{'], ['shifts', 'works', '||--o{'], ['holds', 'holds time', '||--o{'], ['reminders', 'is reminded', '||--o{'],
      ['drafts', 'approves', '||--o{'], ['messages', 'receives', '||--o{'], ['playbook_runs', 'runs', '||--o{'], ['sources', 'connects', '||--o{'], ['api_tokens', 'creates', '||--o{'],
      ['webhooks', 'registers', '||--o{'], ['vault', 'keeps', '||--o{'], ['money', 'tracks', '||--o|'], ['household_plan', 'plans', '||--o|'], ['meetings', 'attends', '||--o{'],
      ['courses', 'takes', '||--o{'], ['pulse_state', 'answers', '||--o|'], ['dismissed', 'dismisses', '||--o{'], ['aid', 'expects', '||--o|'], ['commute_plans', 'rides', '||--o{'], ['transit_now', 'waits at', '||--o|'], ['dispatches', 'asks for', '||--o{'],
      ['academic', 'keeps a record in', '||--o|'], ['gradebooks', 'is graded in', '||--o{'], ['shares', 'shares through', '||--o{'], ['barriers', 'faces', '||--o|'], ['resource_feedback', 'rates', '||--o{'],
    ],
  },
  { group: 'schedule', name: 'deadlines', purpose: 'Every date that matters: assignments, exams, aid, bills, appointments. Found dates stay unconfirmed until the student checks them.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string', 'owner'), f('title', 'string'), f('due', 'date or date-time'), o('course', 'string'), f('kind', 'enum', 'assignment, exam, reading, college, aid, benefit, bill, appointment, other'), f('source', 'object', 'where it was found, with the line'), f('confirmed', 'boolean'), o('effortHours', 'number'), o('durationMin', 'number'), o('done', 'boolean')], relations: [['holds', 'gets time in', '||--o{']] },
  { group: 'schedule', name: 'classes', purpose: 'Weekly class meetings, from the schedule or a room-change email.', key: 'student:course:index', fields: [f('course', 'string'), f('days', 'weekday[]'), f('start', 'time'), f('end', 'time'), o('building', 'string'), o('room', 'string'), o('campus', 'string')] },
  { group: 'schedule', name: 'shifts', purpose: 'Work shifts, typed by the student or sent through the API.', key: 'student:date:start', fields: [f('date', 'date'), f('start', 'time'), f('end', 'time'), o('employer', 'string')] },
  { group: 'schedule', name: 'holds', purpose: 'Time the student asked the Advocate to keep for a piece of work.', key: 'id', fields: [f('id', 'string'), o('deadlineId', 'string'), f('title', 'string'), f('date', 'date'), f('start', 'time'), f('end', 'time')] },
  { group: 'schedule', name: 'reminders', purpose: 'Reminders the student asked for.', key: 'id', fields: [f('id', 'string'), f('about', 'string'), f('at', 'date or date-time'), f('text', 'string')] },
  { group: 'conversation', name: 'drafts', purpose: 'Messages the Advocate wrote for the student to send. Nothing leaves without the student approving the exact text.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string'), f('to', 'string'), f('recipient', 'string'), f('body', 'string'), f('purpose', 'string'), f('status', 'enum', 'shown, sent, discarded')] },
  { group: 'conversation', name: 'messages', purpose: 'Everything the team said to the student, with why and what the tone gate decided.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string'), f('author', 'string', 'which agent'), f('text', 'string'), f('nextSteps', 'NextStep[]'), f('urgency', 'enum', 'safety, time-sensitive, routine'), o('why', 'string'), f('at', 'date-time'), f('status', 'enum', 'delivered, deferred, held'), o('holdReason', 'string')] },
  { group: 'conversation', name: 'last_steps', purpose: 'The choices on the last message, so a reply of "1" by text picks the first.', key: 'student', fields: [f('steps', 'NextStep[]')], transient: true },
  { group: 'help and money', name: 'playbook_runs', purpose: 'Where the student is in each playbook, with every checkpoint.', key: 'student:playbook', fields: [f('playbook', 'string'), f('studentId', 'string'), f('stepId', 'string'), f('status', 'enum', 'active, waiting, done, unresolved'), f('startedAt', 'date'), f('history', 'object[]'), o('waitingSince', 'date')] },
  { group: 'conversation', name: 'pulse_state', purpose: 'Quick questions: which were asked when, how often, or off.', key: 'student', fields: [f('asked', 'record'), f('everyDays', 'number'), o('off', 'boolean')] },
  { group: 'conversation', name: 'pulse_pending', purpose: 'A quick question waiting for a yes or no.', key: 'student', fields: [f('pulse', 'string')], transient: true },
  { group: 'connections', name: 'sources', purpose: 'What the student connected: calendar, forwarding, class site, location. Each grant is also in the consent ledger.', key: 'student:source', fields: [f('source', 'enum'), f('connectedAt', 'date')] },
  { group: 'connections', name: 'api_tokens', purpose: 'Tokens the student created to connect other tools. Only a hash is stored.', key: 'sha256(token)', fields: [f('id', 'string', 'sha256 of the token'), f('label', 'string'), f('scopes', 'enum[]', 'read, write, actions'), f('createdAt', 'date')] },
  { group: 'connections', name: 'webhooks', purpose: 'Where the student asked to be notified. Https only; payloads carry ids, never message text.', key: 'id', fields: [f('id', 'string'), f('url', 'url'), f('events', 'string[]'), f('secret', 'string', 'signs each delivery')] },
  { group: 'help and money', name: 'barriers', purpose: 'What is hard right now, from check-ins, the student or the Advocate asking. Each stays open until the student says it is resolved; "not today" pauses reminders and closes nothing.', key: 'student', fields: [f('items', 'StudentBarrier[]', 'need, opened by, urgency (tonight, soon, someday), status (open, in-progress, resolved), dates, history')] },
  { group: 'help and money', name: 'resource_feedback', purpose: 'Whether a resource helped, one answer per student per resource. Shown only as counts, and only once enough students answered.', key: 'resource|student', fields: [f('resourceId', 'string'), f('outcome', 'enum', 'helped, did-not-help, could-not-reach'), f('on', 'date')] },
  { group: 'help and money', name: 'vault', purpose: 'Names of documents the student keeps; contents are sealed.', key: 'student:name', fields: [f('name', 'string'), f('addedAt', 'date')] },
  { group: 'help and money', name: 'money', purpose: 'Balance, bills and pay, for spotting a short month ahead of time.', key: 'student', fields: [f('balance', 'number'), f('bills', 'Bill[]'), o('pay', 'Paycheck')] },
  { group: 'help and money', name: 'household_plan', purpose: 'Child care hours, commute and sleep, for the week solver.', key: 'student', fields: [o('childCare', 'ChildCare'), o('commuteMin', 'number'), o('sleepHours', 'number'), o('commuteMode', 'enum', 'bus, car, walk'), o('homeStop', 'string', 'transit stop id the student picked')] },
  { group: 'campus', name: 'commute_plans', purpose: 'Bus trips that get the student to their first class each day, from the transit planner.', key: 'student|date', fields: [f('date', 'date'), f('course', 'string'), f('classStart', 'time'), f('from', 'string', 'stop id'), f('to', 'string', 'stop id'), f('itineraries', 'Itinerary[]'), o('notice', 'string'), f('fetchedAt', 'date-time')], transient: true },
  { group: 'campus', name: 'transit_now', purpose: 'Live arrivals and alerts at the student\'s stop; used only while under ten minutes old.', key: 'student', fields: [f('stop', 'string'), f('at', 'date-time'), f('arrivals', 'Arrival[]'), f('alerts', 'Alert[]')], transient: true },
  { group: 'campus', name: 'dispatches', purpose: 'Writes the student asked for (room bookings), each sent once with an idempotency key and confirmed by looking it up.', key: 'idempotency key', fields: [f('id', 'string'), f('studentId', 'string'), f('kind', 'enum', 'room-booking'), f('request', 'object'), f('key', 'string'), f('status', 'enum', 'queued, sent, ambiguous, confirmed, refused'), f('attempts', 'number'), o('result', 'object'), f('queuedAt', 'date-time')] },
  { group: 'campus', name: 'campus_feeds', purpose: 'What the operator last fetched from each campus service: dining, places, careers and transit stops. Shared, not about any student.', key: 'campus', fields: [f('campus', 'string'), f('fetchedAt', 'date-time'), f('locations', 'DiningLocation[]'), f('hours', 'record'), f('menus', 'record'), f('spaces', 'Space[]'), f('events', 'Event[]'), f('postings', 'Posting[]'), f('mentors', 'Mentor[]'), f('stops', 'Stop[]'), f('unknown', 'string[]', 'parts that could not be fetched')], transient: true },
  { group: 'campus', name: 'leases', purpose: 'Which operator holds which job, with a heartbeat, so two never run the same job.', key: 'job', fields: [f('job', 'string'), f('holder', 'string'), f('until', 'date-time'), f('beats', 'number')], transient: true },
  { group: 'schedule', name: 'meetings', purpose: 'Group meetings to prepare for.', key: 'id', fields: [f('id', 'string'), f('title', 'string'), f('date', 'date'), f('start', 'time'), f('attendees', 'string[]'), o('course', 'string')] },
  { group: 'schedule', name: 'courses', purpose: 'Each course and its AI policy, read from the syllabus.', key: 'student:course', fields: [f('course', 'string'), f('aiPolicy', 'enum'), o('aiPolicyLine', 'string')] },
  { group: 'conversation', name: 'dismissed', purpose: 'Alerts the student said are fine.', key: 'student:subject', fields: [f('subject', 'string'), f('at', 'date')] },
  { group: 'school', name: 'academic', purpose: 'The student\'s record for staying enrolled: program, finished and current courses with grades, and the aid and charges this term, for standing, aid progress and the withdrawal estimate.', key: 'student', fields: [o('program', 'string', 'declared program id'), o('programCredits', 'number'), f('transcript', 'TranscriptCourse[]', 'course, credits, grade, term'), o('aid', 'AidDisbursed', 'federal aid paid this term'), o('charges', 'number', 'tuition and fees this term'), o('aidProbation', 'object', 'term, plan GPA and pace, after an approved appeal')] },
  { group: 'school', name: 'gradebooks', purpose: 'Each class\'s graded categories from the syllabus and the scores in them, from the class site or typed by the student.', key: 'student:course', fields: [f('course', 'string'), f('credits', 'number'), f('categories', 'GradeCategory[]', 'name and weight'), f('items', 'GradeItem[]', 'title, score, out of'), f('source', 'enum', 'class-site, student'), o('scale', 'object', 'lowest percent for each letter')] },
  { group: 'school', name: 'shares', purpose: 'Read-only links the student made for an advisor or anyone they choose. Only a hash of the link is kept; each view is in the consent ledger.', key: 'sha256(token)', fields: [f('id', 'string', 'sha256 of the link token'), f('studentId', 'string'), f('label', 'string', 'who it is for, in the student\'s words'), f('scopes', 'enum[]', 'schedule, school, degree, plan'), f('createdAt', 'date-time'), f('expiresAt', 'date-time'), o('revokedAt', 'date-time'), f('views', 'number')] },
  { group: 'help and money', name: 'aid', purpose: 'When financial aid is expected, for book timing.', key: 'student', fields: [f('disbursement', 'date')] },
];

/**
 * How sensitive each field is (the store block's classes). Personal: identifies or describes the student.
 * Sensitive: special-category facts (money, benefits, family, health, identity, which help they need).
 * Secret: credentials, kept only hashed or encrypted. Fields not listed are internal or public as named below.
 * The sensitive-data trace plants a marker in each personal, sensitive and secret field and checks where it goes.
 */
export const CLASSIFICATION: Record<string, DataClass> = {
  // students
  'students.phone': 'personal', 'students.chosenName': 'personal', 'students.pronouns': 'sensitive', 'students.zip': 'personal', 'students.county': 'personal', 'students.age': 'personal', 'students.goal': 'personal',
  'students.household': 'sensitive', 'students.enrollment': 'personal', 'students.receives': 'sensitive', 'students.helpAreas': 'sensitive', 'students.communities': 'sensitive',
  // schedule
  'deadlines.title': 'personal', 'deadlines.due': 'personal', 'deadlines.course': 'personal', 'deadlines.source': 'personal',
  'classes.course': 'personal', 'classes.days': 'personal', 'classes.start': 'personal', 'classes.end': 'personal', 'classes.building': 'personal', 'classes.room': 'personal', 'classes.campus': 'personal',
  'shifts.date': 'personal', 'shifts.start': 'personal', 'shifts.end': 'personal', 'shifts.employer': 'personal',
  'holds.title': 'personal', 'holds.date': 'personal', 'holds.start': 'personal', 'holds.end': 'personal',
  'reminders.about': 'personal', 'reminders.at': 'personal', 'reminders.text': 'personal',
  'meetings.title': 'personal', 'meetings.date': 'personal', 'meetings.start': 'personal', 'meetings.attendees': 'personal', 'meetings.course': 'personal',
  'courses.course': 'personal', 'courses.aiPolicy': 'public', 'courses.aiPolicyLine': 'public',
  // conversation
  'drafts.to': 'personal', 'drafts.recipient': 'personal', 'drafts.body': 'personal',
  'messages.text': 'personal', 'dismissed.subject': 'personal',
  // help and money
  'playbook_runs.playbook': 'sensitive', 'playbook_runs.history': 'sensitive',
  'vault.name': 'sensitive', 'money.balance': 'sensitive', 'money.bills': 'sensitive', 'money.pay': 'sensitive', 'aid.disbursement': 'sensitive',
  'household_plan.childCare': 'sensitive', 'household_plan.commuteMin': 'personal', 'household_plan.sleepHours': 'personal', 'household_plan.commuteMode': 'personal', 'household_plan.homeStop': 'personal',
  // school: education records are sensitive
  'academic.program': 'personal', 'academic.programCredits': 'personal', 'academic.transcript': 'sensitive', 'academic.aid': 'sensitive', 'academic.charges': 'sensitive', 'academic.aidProbation': 'sensitive',
  'gradebooks.course': 'personal', 'gradebooks.credits': 'personal', 'gradebooks.categories': 'personal', 'gradebooks.items': 'sensitive', 'gradebooks.scale': 'public',
  'shares.label': 'personal', 'shares.scopes': 'personal',
  'barriers.items': 'sensitive', 'resource_feedback.outcome': 'personal',
  // connections
  'api_tokens.label': 'personal', 'webhooks.url': 'personal', 'webhooks.secret': 'secret',
  // campus
  'commute_plans.date': 'personal', 'commute_plans.course': 'personal', 'commute_plans.classStart': 'personal', 'commute_plans.from': 'personal', 'commute_plans.to': 'personal', 'commute_plans.itineraries': 'personal', 'commute_plans.notice': 'public',
  'transit_now.stop': 'personal', 'transit_now.arrivals': 'public', 'transit_now.alerts': 'public',
  'dispatches.request': 'personal', 'dispatches.result': 'personal',
  'campus_feeds.campus': 'public', 'campus_feeds.locations': 'public', 'campus_feeds.hours': 'public', 'campus_feeds.menus': 'public', 'campus_feeds.spaces': 'public', 'campus_feeds.events': 'public', 'campus_feeds.postings': 'public', 'campus_feeds.mentors': 'public', 'campus_feeds.stops': 'public',
};

/** Every collection with every field classified: listed above, or internal (ids, times, settings, statuses). */
export const COLLECTIONS: CollectionDef[] = DECLARED.map((c) => ({ ...c, fields: c.fields.map((x) => ({ ...x, cls: CLASSIFICATION[`${c.name}.${x.name}`] ?? 'internal' })) }));

/** Facts kept sealed (encrypted, opened only by granted identities), and how sensitive each is. */
export const SEALED_FACTS: { fact: string; cls: DataClass; why: string }[] = [
  { fact: 'justice_involvement', cls: 'sensitive', why: 'Justice history; used only for the fair-chance path when the student asks.' },
  { fact: 'foster_care_history', cls: 'sensitive', why: 'Foster care history; opens foster-youth aid.' },
  { fact: 'class_site_token', cls: 'secret', why: 'The student\'s class-site login token; granted only to the class-site sync.' },
  { fact: 'doc:<keyed hash of the name>', cls: 'sensitive', why: 'The contents of documents the student keeps; the name itself stays out of the sealed store and the ledger.' },
];

/** The other stores, each its own database with its own guarantees. */
export const OTHER_STORES = [
  { name: 'consent ledger', purpose: 'Every grant, revoke, approval, export and deletion, hash-chained and append-only.', fields: ['seq', 'at', 'student_id', 'kind', 'subject', 'detail', 'prev_hash', 'hash'] },
  { name: 'sealed facts', purpose: 'Facts only granted identities can open; encrypted with a per-student key wrapped by the master key.', fields: ['studentId', 'wrappedKey', 'facts (encrypted)', 'grants'] },
  { name: 'evidence', purpose: 'What the factory and the product did, pseudonymous and append-only; never message content.', fields: ['seq', 'at', 'kind', 'subject (keyed hash)', 'data'] },
] as const;

export const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name);
