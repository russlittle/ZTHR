/**
 * The Advocate's data, declared once. Every collection the app writes is listed here with its fields and how it
 * relates to the others. The data-model document and its ERD are generated from this list, and tests fail when the
 * code writes a collection or a field this list does not declare, so the picture can never drift from the system.
 */
export interface FieldDef {
  name: string;
  type: string;
  note?: string;
  optional?: boolean;
}

export interface CollectionDef {
  name: string;
  purpose: string;
  key: string;
  fields: FieldDef[];
  /** Other collections this one points at: [target, label, cardinality as in Mermaid, e.g. "||--o{"]. */
  relations?: [string, string, string][];
  /** Kept only as long as needed; not part of the student's lasting record. */
  transient?: boolean;
}

const f = (name: string, type: string, note?: string, optional = false): FieldDef => ({ name, type, note, optional });
const o = (name: string, type: string, note?: string): FieldDef => f(name, type, note, true);

export const COLLECTIONS: CollectionDef[] = [
  {
    name: 'students',
    purpose: 'Who the student is and how they want to be helped. Sealed facts are never stored here.',
    key: 'id',
    fields: [f('id', 'string', 'stable id'), o('phone', 'string'), f('chosenName', 'string'), o('pronouns', 'string'), f('zip', 'string'), o('county', 'string'), o('age', 'number'), o('goal', 'string'), f('dial', 'HelpDial', 'depth, channel, reading grade, language, quiet hours'), f('household', 'Household', 'size, income, children'), f('enrollment', 'Enrollment', 'college, credits, work hours'), o('receives', 'object', 'benefits already received'), f('helpAreas', 'string[]'), o('communities', 'string[]', 'chosen, never inferred'), f('createdAt', 'date')],
    relations: [
      ['deadlines', 'has', '||--o{'], ['classes', 'attends', '||--o{'], ['shifts', 'works', '||--o{'], ['holds', 'holds time', '||--o{'], ['reminders', 'is reminded', '||--o{'],
      ['drafts', 'approves', '||--o{'], ['messages', 'receives', '||--o{'], ['playbook_runs', 'runs', '||--o{'], ['sources', 'connects', '||--o{'], ['api_tokens', 'creates', '||--o{'],
      ['webhooks', 'registers', '||--o{'], ['vault', 'keeps', '||--o{'], ['money', 'tracks', '||--o|'], ['household_plan', 'plans', '||--o|'], ['meetings', 'attends', '||--o{'],
      ['courses', 'takes', '||--o{'], ['pulse_state', 'answers', '||--o|'], ['dismissed', 'dismisses', '||--o{'], ['aid', 'expects', '||--o|'],
    ],
  },
  { name: 'deadlines', purpose: 'Every date that matters: assignments, exams, aid, bills, appointments. Found dates stay unconfirmed until the student checks them.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string', 'owner'), f('title', 'string'), f('due', 'date or date-time'), o('course', 'string'), f('kind', 'enum', 'assignment, exam, reading, college, aid, benefit, bill, appointment, other'), f('source', 'object', 'where it was found, with the line'), f('confirmed', 'boolean'), o('effortHours', 'number'), o('durationMin', 'number'), o('done', 'boolean')], relations: [['holds', 'gets time in', '||--o{']] },
  { name: 'classes', purpose: 'Weekly class meetings, from the schedule or a room-change email.', key: 'student:course:index', fields: [f('course', 'string'), f('days', 'weekday[]'), f('start', 'time'), f('end', 'time'), o('building', 'string'), o('room', 'string'), o('campus', 'string')] },
  { name: 'shifts', purpose: 'Work shifts, typed by the student or sent through the API.', key: 'student:date:start', fields: [f('date', 'date'), f('start', 'time'), f('end', 'time'), o('employer', 'string')] },
  { name: 'holds', purpose: 'Time the student asked the Advocate to keep for a piece of work.', key: 'id', fields: [f('id', 'string'), o('deadlineId', 'string'), f('title', 'string'), f('date', 'date'), f('start', 'time'), f('end', 'time')] },
  { name: 'reminders', purpose: 'Reminders the student asked for.', key: 'id', fields: [f('id', 'string'), f('about', 'string'), f('at', 'date or date-time'), f('text', 'string')] },
  { name: 'drafts', purpose: 'Messages the Advocate wrote for the student to send. Nothing leaves without the student approving the exact text.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string'), f('to', 'string'), f('recipient', 'string'), f('body', 'string'), f('purpose', 'string'), f('status', 'enum', 'shown, sent, discarded')] },
  { name: 'messages', purpose: 'Everything the team said to the student, with why and what the tone gate decided.', key: 'id', fields: [f('id', 'string'), f('studentId', 'string'), f('author', 'string', 'which agent'), f('text', 'string'), f('nextSteps', 'NextStep[]'), f('urgency', 'enum', 'safety, time-sensitive, routine'), o('why', 'string'), f('at', 'date-time'), f('status', 'enum', 'delivered, deferred, held'), o('holdReason', 'string')] },
  { name: 'last_steps', purpose: 'The choices on the last message, so a reply of "1" by text picks the first.', key: 'student', fields: [f('steps', 'NextStep[]')], transient: true },
  { name: 'playbook_runs', purpose: 'Where the student is in each playbook, with every checkpoint.', key: 'student:playbook', fields: [f('playbook', 'string'), f('studentId', 'string'), f('stepId', 'string'), f('status', 'enum', 'active, waiting, done, unresolved'), f('startedAt', 'date'), f('history', 'object[]'), o('waitingSince', 'date')] },
  { name: 'pulse_state', purpose: 'Quick questions: which were asked when, how often, or off.', key: 'student', fields: [f('asked', 'record'), f('everyDays', 'number'), o('off', 'boolean')] },
  { name: 'pulse_pending', purpose: 'A quick question waiting for a yes or no.', key: 'student', fields: [f('pulse', 'string')], transient: true },
  { name: 'sources', purpose: 'What the student connected: calendar, forwarding, class site, location. Each grant is also in the consent ledger.', key: 'student:source', fields: [f('source', 'enum'), f('connectedAt', 'date')] },
  { name: 'api_tokens', purpose: 'Tokens the student created to connect other tools. Only a hash is stored.', key: 'sha256(token)', fields: [f('id', 'string', 'sha256 of the token'), f('label', 'string'), f('scopes', 'enum[]', 'read, write, actions'), f('createdAt', 'date')] },
  { name: 'webhooks', purpose: 'Where the student asked to be notified. Https only; payloads carry ids, never message text.', key: 'id', fields: [f('id', 'string'), f('url', 'url'), f('events', 'string[]'), f('secret', 'string', 'signs each delivery')] },
  { name: 'vault', purpose: 'Names of documents the student keeps; contents are sealed.', key: 'student:name', fields: [f('name', 'string'), f('addedAt', 'date')] },
  { name: 'money', purpose: 'Balance, bills and pay, for spotting a short month ahead of time.', key: 'student', fields: [f('balance', 'number'), f('bills', 'Bill[]'), o('pay', 'Paycheck')] },
  { name: 'household_plan', purpose: 'Child care hours, commute and sleep, for the week solver.', key: 'student', fields: [o('childCare', 'ChildCare'), o('commuteMin', 'number'), o('sleepHours', 'number')] },
  { name: 'meetings', purpose: 'Group meetings to prepare for.', key: 'id', fields: [f('id', 'string'), f('title', 'string'), f('date', 'date'), f('start', 'time'), f('attendees', 'string[]'), o('course', 'string')] },
  { name: 'courses', purpose: 'Each course and its AI policy, read from the syllabus.', key: 'student:course', fields: [f('course', 'string'), f('aiPolicy', 'enum'), o('aiPolicyLine', 'string')] },
  { name: 'dismissed', purpose: 'Alerts the student said are fine.', key: 'student:subject', fields: [f('subject', 'string'), f('at', 'date')] },
  { name: 'aid', purpose: 'When financial aid is expected, for book timing.', key: 'student', fields: [f('disbursement', 'date')] },
];

/** The other stores, each its own database with its own guarantees. */
export const OTHER_STORES = [
  { name: 'consent ledger', purpose: 'Every grant, revoke, approval, export and deletion, hash-chained and append-only.', fields: ['seq', 'at', 'student_id', 'kind', 'subject', 'detail', 'prev_hash', 'hash'] },
  { name: 'sealed facts', purpose: 'Facts only granted identities can open; encrypted with a per-student key wrapped by the master key.', fields: ['studentId', 'wrappedKey', 'facts (encrypted)', 'grants'] },
  { name: 'evidence', purpose: 'What the factory and the product did, pseudonymous and append-only; never message content.', fields: ['seq', 'at', 'kind', 'subject (keyed hash)', 'data'] },
] as const;

export const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name);
