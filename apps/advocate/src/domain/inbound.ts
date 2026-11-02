/**
 * Classifies forwarded email and texts. Inbound content is data, never
 * instructions: nothing in it can trigger an outbound action, only an offer to
 * the student.
 */
export type InboundKind =
  | 'aid-verification'
  | 'aid-disbursement'
  | 'utility-shutoff'
  | 'eviction-notice'
  | 'rent-late'
  | 'class-canceled'
  | 'room-change'
  | 'registration'
  | 'grade-alert'
  | 'benefit-recertification'
  | 'other';

export interface InboundItem {
  kind: InboundKind;
  from?: string;
  subject?: string;
  dates: string[];
  amount?: number;
}

const RULES: [InboundKind, RegExp][] = [
  ['eviction-notice', /\b(eviction|notice to (leave|vacate)|3[- ]day notice|forcible entry)\b/i],
  ['utility-shutoff', /\b(disconnect(ed|ion)?|shut[- ]?off|service (will be )?terminated|final notice)\b/i],
  ['rent-late', /\b(rent is (past due|late)|late fee|past[- ]due rent)\b/i],
  ['aid-verification', /\b(verification|selected for verification|additional documents|missing documents?)\b.*\b(aid|fafsa|financial)\b|\b(fafsa|financial aid)\b.*\bverification\b/i],
  ['aid-disbursement', /\b(disburse(ment|d)?|refund)\b.*\b(aid|pell|loan)\b/i],
  ['benefit-recertification', /\b(recertif(y|ication)|renewal (packet|form)|interview (is )?scheduled)\b/i],
  ['class-canceled', /\bclass (is )?(canceled|cancelled)\b|\bno class\b/i],
  ['room-change', /\b(room change|moved to (room|building)|new (room|location))\b/i],
  ['registration', /\bregistration (opens|begins|deadline)\b/i],
  ['grade-alert', /\b(early alert|academic alert|progress report|at risk of failing)\b/i],
];

export function classifyInbound(text: string, meta: { from?: string; subject?: string } = {}): InboundItem {
  const all = `${meta.subject ?? ''}\n${text}`;
  const kind = RULES.find(([, re]) => re.test(all))?.[0] ?? 'other';
  const dates = [...all.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)].map((m) => {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
  });
  const amt = all.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  return { kind, from: meta.from, subject: meta.subject, dates, amount: amt ? Number(amt[1]!.replace(/,/g, '')) : undefined };
}
