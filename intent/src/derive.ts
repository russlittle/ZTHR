/**
 * Prerequisites and implications derived by rule, not by a model. Each rule names what it looks for and what
 * follows from it; anything it derives is a default the read-back shows, with the rule that produced it.
 */
import type { Statement } from './frame.ts';

export interface Rule {
  readonly id: string;
  /** What in the intent triggers the rule. */
  readonly when: RegExp;
  readonly prerequisites: readonly string[];
  readonly implications: readonly string[];
  /** Someone on the other side of the activity, when there is one. */
  readonly otherSide?: string;
  /** The special-characteristic mark its implications carry. */
  readonly mark?: 'critical' | 'significant';
  /** What must never happen because of it: the forbidden outcomes every gauge it touches checks. */
  readonly never?: readonly string[];
}

export const RULES: readonly Rule[] = [
  {
    id: 'contacts-people',
    when: /\b(remind|reminder|notify|notification|message|text|sms|email|alert|nudge)/i,
    prerequisites: ['a way to reach each person, and their consent to be contacted', 'quiet hours and each person\'s time zone'],
    implications: ['people get messages they did not ask for, so the contact limit and quiet hours apply'],
    mark: 'significant',
    never: ['a message is sent during quiet hours', 'a message is sent to someone who has not agreed to be contacted'],
  },
  {
    id: 'money',
    when: /(\$\d|\b(bill|bills|rent|pay|paid|payment|income|money|budget|fee|fees|debt|loan)\b)/i,
    prerequisites: ['where the amounts and due dates come from, and how current they are'],
    implications: ['financial details are sensitive: stored and shown only to the person and whoever they allow'],
    mark: 'critical',
    never: ['financial details are shown to anyone the person has not allowed'],
  },
  {
    id: 'staff-view',
    when: /\b(staff|advisor|adviser|admin|administrator|manager|case ?worker|counsel+or|coach)s?\b/i,
    prerequisites: ['which staff, and which people each may see'],
    implications: ['a second kind of user sees information about the first; every view is recorded'],
    mark: 'critical',
    never: ['staff see anything the person has not chosen to share'],
    otherSide: 'staff who see this information',
  },
  {
    id: 'irreversible',
    when: /\b(delete|remove|cancel|close (the )?account|send money|submit|pay (it|the bill)|transfer)\b/i,
    prerequisites: [],
    implications: ['an action that cannot be undone: the person confirms it first, and it is recorded'],
    mark: 'critical',
    never: ['something that cannot be undone happens without the person confirming it'],
  },
  {
    id: 'outside-service',
    when: /\b(calendar|google|utility|bank|school system|portal|api|import|sync)\b/i,
    prerequisites: ['access to the outside service, under its own credentials, never in the app'],
    implications: ['the app depends on a service it does not control: what happens when it is down is decided up front'],
    otherSide: 'the outside service and its owner',
  },
  {
    id: 'phone',
    when: /\b(phone|mobile|text message|sms|on the go)\b/i,
    prerequisites: [],
    implications: ['every screen must work one-handed on a small screen and a slow connection'],
  },
];

/** Every rule that fires on the given text, as default statements naming their rule. */
export function derive(texts: readonly string[], rules: readonly Rule[] = RULES): Statement[] {
  const all = texts.join('\n');
  const out: Statement[] = [];
  for (const r of rules) {
    const m = r.when.exec(all);
    if (!m) continue;
    const supplied = { kind: 'derived' as const, rule: r.id };
    r.prerequisites.forEach((t, i) => out.push({ id: `${r.id}.p${i + 1}`, slot: 'prerequisites', text: t, words: m[0], state: 'default', supplied }));
    r.implications.forEach((t, i) => out.push({ id: `${r.id}.i${i + 1}`, slot: 'implications', text: t, words: m[0], state: 'default', supplied, ...(r.mark ? { mark: r.mark } : {}) }));
    (r.never ?? []).forEach((t, i) => out.push({ id: `${r.id}.n${i + 1}`, slot: 'constraints', text: `never: ${t}`, words: m[0], state: 'default', supplied, ...(r.mark ? { mark: r.mark } : {}) }));
    if (r.otherSide) out.push({ id: `${r.id}.o`, slot: 'people', text: `${r.otherSide} (on the other side)`, words: m[0], state: 'default', supplied });
  }
  return out;
}
