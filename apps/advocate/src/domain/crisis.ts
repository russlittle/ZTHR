import type { NeedCategory, OutboundMessage, Student } from './types.js';
import type { Resource } from '../catalog/types.js';
import { findHelp, type PlanOption } from './navigator.js';

/**
 * Crisis intake for life emergencies (PRD NAV-4). Not the safety router: this
 * handles evictions, shutoffs, a broken-down car, no food, no money. Replies
 * within one exchange with steps, contacts, documents and a draft to send.
 */
export type Situation = 'eviction' | 'utility-shutoff' | 'car' | 'no-food' | 'rent-short';

export function detectSituation(text: string): Situation | undefined {
  if (/\b(evict|eviction|notice to (leave|vacate)|kicked out|landlord.*(court|leave))\b/i.test(text)) return 'eviction';
  if (/\b(shut ?off|shutting off|disconnect|power (is )?(off|getting cut)|lights? (off|cut)|gas (off|cut)|water (off|cut))\b/i.test(text)) return 'utility-shutoff';
  if (/\b(car (died|broke|won'?t start|broke down)|no (car|ride)|need a ride|can'?t get to (class|campus|work))\b/i.test(text)) return 'car';
  if (/\b(no food|hungry|can'?t afford (food|groceries)|out of food|nothing to eat)\b/i.test(text)) return 'no-food';
  if (/\b(can'?t (pay|make) (rent|my rent)|short on rent|rent is due)\b/i.test(text)) return 'rent-short';
  return undefined;
}

const NEEDS: Record<Situation, NeedCategory[]> = {
  eviction: ['legal', 'housing', 'money'],
  'utility-shutoff': ['utilities', 'money'],
  car: ['transportation', 'money'],
  'no-food': ['food'],
  'rent-short': ['money', 'housing'],
};

const FIRST_STEP: Record<Situation, string> = {
  eviction: 'Do not ignore any court papers. Going to the hearing matters, and free legal help can come with you.',
  'utility-shutoff': 'Call the utility today and ask for a payment plan or more time. I drafted what to say.',
  car: 'Let us get you to class first, then sort out the repair.',
  'no-food': 'Here is food you can get today, and help that keeps food coming.',
  'rent-short': 'Talk to your landlord before the due date if you can. I drafted a short message.',
};

export const DRAFTS: Partial<Record<Situation, (s: Student) => { to: string; body: string }>> = {
  'utility-shutoff': (s) => ({
    to: 'utility company',
    body: `Hello, my name is ${s.chosenName}. I'm a student and I'm working on paying my bill. Can we set up a payment plan or extend the due date while I apply for energy assistance? Thank you.`,
  }),
  'rent-short': (s) => ({
    to: 'landlord',
    body: `Hi, this is ${s.chosenName}. I want to let you know ahead of time that I may be short on rent this month. I'm applying for emergency help now. Could we agree on a date or a split payment? Thank you for working with me.`,
  }),
  eviction: (s) => ({
    to: 'Legal Aid of Western Ohio',
    body: `My name is ${s.chosenName}. I received an eviction notice and I'm a student. I would like help understanding my options before any court date.`,
  }),
};

export function crisisPlan(s: Student, situation: Situation, catalog: Resource[], today: string, vaultDocuments: string[] = []): { message: OutboundMessage; options: PlanOption[]; unmet: NeedCategory[] } {
  const seen = new Set<string>();
  const options: PlanOption[] = [];
  const unmet: NeedCategory[] = [];
  for (const need of NEEDS[situation]) {
    const r = findHelp(s, need, { catalog, today, vaultDocuments });
    if (r.unmet) unmet.push(need);
    for (const o of r.options) if (!seen.has(o.resource.id)) {
      seen.add(o.resource.id);
      options.push(o);
    }
  }
  const brief = s.dial.depth === 'brief';
  const top = options.slice(0, brief ? 2 : 3);
  const lines = [FIRST_STEP[situation]];
  top.forEach((o, i) => {
    const contact = o.resource.phone ? ` Call ${o.resource.phone}.` : o.resource.url ? ` ${o.resource.url}` : '';
    // Brief: names and numbers only; the details are one tap away.
    lines.push(brief ? `${i + 1}. ${o.resource.name}.${contact}` : `${i + 1}. ${o.resource.name}: ${o.resource.description}${contact}`);
  });
  if (top.length === 0) lines.push('I could not find a verified resource for this near you yet. I am noting the gap, and 2-1-1 can help right now.');
  const draft = DRAFTS[situation]?.(s);
  const nextSteps = [
    ...(draft ? [{ label: `See the message to your ${draft.to}`, action: `show-draft:${situation}` }] : []),
    ...top.slice(0, 2).map((o) => ({ label: `Start: ${o.resource.name}`, action: `start-resource:${o.resource.id}` })),
    { label: 'Talk to a person (2-1-1)', action: 'call:211' },
  ];
  return {
    message: { studentId: s.id, author: 'navigator', urgency: 'time-sensitive', text: lines.join('\n'), nextSteps, why: `You told me about a ${situation.replace('-', ' ')}.` },
    options,
    unmet,
  };
}
