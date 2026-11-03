import { classifyInbound, type InboundKind } from './inbound.js';
import { MONTHS, friendly, sentence } from './dates.js';
import type { NeedCategory } from './types.js';

/**
 * The letter explainer (PRD LNG-2). A student pastes or forwards a letter; the Advocate says who it is from, what
 * it means, what to do and by when, in plain words, and offers to put each date on their calendar.
 *
 * Every fact comes from the letter itself: dates, amounts and phone numbers are extracted, never invented. A model
 * may later rewrite the explanation more warmly, but only inside the sandwich, and only if every fact survives.
 */
export interface LetterDate {
  date: string;
  label: string;
  line: string;
}

export interface Letter {
  kind: InboundKind | 'court' | 'collections' | 'irs' | 'benefits';
  sender?: string;
  dates: LetterDate[];
  amounts: number[];
  phones: string[];
  meaning: string;
  todo: string;
  helpNeed?: NeedCategory;
  urgent: boolean;
}

const SENDERS: [RegExp, string, Letter['kind']?][] = [
  [/\bjob\s+(and|&)\s+family\s+services\b|\bJFS\b|\bODJFS\b/i, 'your county Job and Family Services', 'benefits'],
  [/\b(municipal|common pleas|county)\s+court\b|\bcourt\s+(date|hearing)\b|\bsummons\b/i, 'a court', 'court'],
  [/\b(collection(s)?\s+agency|debt\s+collector|this\s+is\s+an\s+attempt\s+to\s+collect)\b/i, 'a debt collector', 'collections'],
  [/\b(internal\s+revenue\s+service|IRS)\b/i, 'the IRS', 'irs'],
  [/\bsocial\s+security\b/i, 'Social Security', 'benefits'],
  [/\b(AES\s+Ohio|CenterPoint|Dayton\s+Power|Vectren|electric|gas\s+company|water\s+department)\b/i, 'a utility company'],
  [/\b(landlord|property\s+manag(er|ement)|apartments?|leasing\s+office)\b/i, 'your landlord'],
  [/\b(financial\s+aid|student\s+financial|bursar|registrar|college|university)\b/i, 'your college'],
];

const MEANING: Partial<Record<Letter['kind'], [string, string, NeedCategory?]>> = {
  'eviction-notice': ['This is an eviction notice. It does not mean you have to leave today. You have the right to go to a court hearing before anyone can make you leave.', 'Go to every court date, and call Legal Aid now. They help for free.', 'legal'],
  'utility-shutoff': ['This says your service could be shut off if the bill is not paid.', 'Call the company before the date to ask for a payment plan, and apply for HEAP heating help.', 'utilities'],
  'rent-late': ['This says your rent is late and may add a fee.', 'Talk to your landlord before the next due date. I can draft a message.', 'housing'],
  'aid-verification': ['Your college picked your FAFSA to check. This happens to many students and does not mean you did anything wrong.', 'Send the papers they ask for before the date so your aid is not held up.', 'money'],
  'aid-disbursement': ['This is about when your financial aid money is paid out.', 'Check the amount and date, and plan your books and bills around it.'],
  'benefit-recertification': ['Your benefits need to be renewed so they do not stop.', 'Fill out the renewal or go to the interview on the date in the letter.', 'food'],
  'class-canceled': ['A class meeting is canceled.', 'You do not need to go that day.'],
  'room-change': ['A class has moved to a new room.', 'Go to the new room next time.'],
  registration: ['This is about signing up for next term.', 'Register before the date so you get the classes you need.'],
  'grade-alert': ['An instructor is worried about how a class is going. It is a heads-up, not a final grade.', 'Reply to the instructor or go to office hours this week.', 'academic'],
  court: ['This is from a court. Court dates matter a lot, and missing one can make things worse.', 'Go to the court date, and call Legal Aid now. They help for free.', 'legal'],
  collections: ['A company says you owe money. You have the right to ask them to prove the debt.', 'Do not pay or agree to anything yet. Ask for proof in writing, and get free advice first.', 'legal'],
  irs: ['This is from the IRS about your taxes.', 'Read what they ask for and the date. Free tax help (VITA) can explain it.', 'money'],
  benefits: ['This is about your public benefits.', 'Look for the date and what they need, and keep a copy of this letter.', 'food'],
  other: ['I could not tell exactly what this letter is about.', 'Check the dates below, and ask the sender if anything is unclear. I can draft a short question.'],
};

const DATE_LABELS: [RegExp, string][] = [
  [/\b(hearing|court\s+date|appear)\b/i, 'Court date'],
  [/\binterview\b/i, 'Interview'],
  [/\bappointment\b/i, 'Appointment'],
  [/\b(disconnect|shut\s*off|terminat)/i, 'Shut-off date'],
  [/\b(vacate|leave\s+the\s+premises|move\s+out)\b/i, 'Move-out date in the notice'],
  [/\b(due|by|before|no\s+later\s+than|deadline|return)\b/i, 'Due'],
];

function datesIn(text: string, today: string): LetterDate[] {
  const out: LetterDate[] = [];
  const year = Number(today.slice(0, 4));
  for (const raw of text.split(/\n|(?<=[.!?])\s+/)) {
    const line = raw.trim();
    if (!line) continue;
    const found: string[] = [];
    for (const m of line.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) found.push(`${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`);
    for (const m of line.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi)) {
      const mo = MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1;
      let y = m[3] ? Number(m[3]) : year;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
      if (!m[3] && iso < today) y += 1;
      found.push(`${y}-${String(mo).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`);
    }
    for (const d of found) {
      if (Number.isNaN(Date.parse(`${d}T12:00:00Z`))) continue;
      const label = DATE_LABELS.find(([re]) => re.test(line))?.[1] ?? 'Date in the letter';
      if (!out.some((x) => x.date === d && x.label === label)) out.push({ date: d, label, line: line.slice(0, 200) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function explainLetter(text: string, today: string, meta: { from?: string; subject?: string } = {}): Letter {
  const all = `${meta.subject ?? ''}\n${meta.from ?? ''}\n${text}`;
  const inbound = classifyInbound(text, meta);
  const sender = SENDERS.find(([re]) => re.test(all));
  const kind: Letter['kind'] = inbound.kind !== 'other' ? inbound.kind : sender?.[2] ?? 'other';
  const [meaning, todo, helpNeed] = MEANING[kind] ?? MEANING.other!;
  const amounts = [...all.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((n) => n > 0);
  const phones = [...new Set([...all.matchAll(/(\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g)].map((m) => m[0].trim()))];
  const dates = datesIn(all, today).filter((d) => d.date >= today);
  return { kind, sender: sender?.[1], dates, amounts: [...new Set(amounts)], phones, meaning, todo, helpNeed, urgent: ['eviction-notice', 'utility-shutoff', 'court'].includes(kind) };
}

/** The explanation in plain words, made only of what the letter says. */
export function letterText(l: Letter): string {
  const lines = [
    l.sender ? sentence(`This letter is from ${l.sender}`) : 'Here is what this letter says.',
    l.meaning,
    sentence(`What to do: ${l.todo.replace(/\.$/, '')}`),
  ];
  if (l.dates.length) lines.push(`Dates in the letter:\n${l.dates.map((d) => `${d.label}: ${friendly(d.date)}`).join('\n')}`);
  if (l.amounts.length) lines.push(sentence(`Amount in the letter: $${l.amounts.map((a) => a.toFixed(a % 1 ? 2 : 0)).join(', $')}`));
  if (l.phones.length) lines.push(sentence(`Phone number in the letter: ${l.phones.join(', ')}`));
  return lines.join('\n');
}

/**
 * The check a model's rewrite must pass: it keeps every date, amount and phone number from the letter, adds no
 * date, amount or phone number that is not in it, and stays short.
 */
export function factsPreserved(l: Letter, rewritten: string): { ok: true } | { ok: false; reason: string } {
  for (const d of l.dates) if (!rewritten.includes(friendly(d.date))) return { ok: false, reason: `dropped the date ${d.date}` };
  for (const a of l.amounts) if (!rewritten.includes(String(a.toFixed(a % 1 ? 2 : 0)))) return { ok: false, reason: `dropped the amount ${a}` };
  for (const p of l.phones) if (!rewritten.includes(p)) return { ok: false, reason: `dropped the phone ${p}` };
  const extraMoney = [...rewritten.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((n) => !l.amounts.includes(n));
  if (extraMoney.length) return { ok: false, reason: `added an amount not in the letter: ${extraMoney[0]}` };
  const extraPhones = [...rewritten.matchAll(/(\(\d{3}\)\s?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g)].map((m) => m[0].trim()).filter((p) => !l.phones.includes(p) && !['988'].includes(p));
  if (extraPhones.length) return { ok: false, reason: `added a phone number not in the letter: ${extraPhones[0]}` };
  if (rewritten.length > 1400) return { ok: false, reason: 'too long' };
  return { ok: true };
}
