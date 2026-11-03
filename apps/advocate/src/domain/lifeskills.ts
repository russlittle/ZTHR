/**
 * Life skills in plain language (PRD MON-2) and the line where practical help
 * ends and licensed advice begins (PRD MON-3). General guidance only; anything
 * that needs a lawyer, tax preparer or counselor is routed to a free service.
 */
export interface Guide {
  topic: string;
  match: RegExp;
  steps: string[];
  routeTo?: { name: string; contact: string; when: string };
}

export const GUIDES: Guide[] = [
  {
    topic: 'signing a lease',
    match: /\b(lease|rental agreement|sign(ing)? (an|a|the) (apartment|lease))\b/i,
    steps: [
      'Read the whole lease before you sign, and keep a copy.',
      'Check the rent, the due date, late fees, and how long the lease lasts.',
      'Walk through the place and take dated photos of any damage before you move in.',
      'Ask what utilities you pay and about how much they usually cost.',
      'Get every promise in writing, like repairs or a pet allowed.',
    ],
    routeTo: { name: 'Legal Aid of Western Ohio', contact: '888-534-1432', when: 'if the lease has terms you are worried about or the landlord will not fix something' },
  },
  {
    topic: 'setting up utilities',
    match: /\b(set ?up (electric|gas|internet|utilities)|turn on (the )?(power|electric|gas))\b/i,
    steps: [
      'Ask your landlord which companies serve the address.',
      'Call or go online a week before you move in to start service in your name.',
      'Ask whether there is a deposit and whether it can be waived or split.',
      'Ask about budget billing, which spreads costs evenly over the year.',
    ],
  },
  {
    topic: 'opening a bank account',
    match: /\b(bank account|checking account|open (a )?bank)\b/i,
    steps: [
      'Look for an account with no monthly fee and no minimum balance. Credit unions often have these.',
      'Bring a photo ID and your Social Security number or the ID number the bank accepts.',
      'Turn on low-balance alerts so you know before you overdraw.',
      'Ask the bank to turn off overdraft coverage so a purchase is declined instead of costing a fee.',
    ],
  },
  {
    topic: 'building credit',
    match: /\b(credit score|build credit|credit card)\b/i,
    steps: [
      'Pay every bill on time. That matters most.',
      'If you get a card, use a small part of the limit and pay it off each month.',
      'Check your credit reports for free at annualcreditreport.com.',
      'Be careful with offers that promise to fix credit for a fee.',
    ],
  },
  {
    topic: 'filing taxes',
    match: /\b(tax(es)?|w-?2|1098-?t|refund)\b/i,
    steps: [
      'You can get your taxes done for free through the IRS VITA program if your income is under its limit.',
      'Bring your ID, Social Security card or tax ID, every W-2 or 1099, and your 1098-T from college.',
      'Education credits can mean a bigger refund, so mention you are a student.',
    ],
    routeTo: { name: 'IRS Volunteer Income Tax Assistance (VITA)', contact: 'irs.gov/vita', when: 'to have your return prepared for free' },
  },
  {
    topic: 'avoiding fees',
    match: /\b(fees?|overdraft|late charge)\b/i,
    steps: [
      'Set due-date reminders a few days early. I can do this for you.',
      'Ask companies to waive a first late fee. Many will.',
      'Turn off overdraft coverage at your bank.',
    ],
  },
];

export function findGuide(text: string): Guide | undefined {
  return GUIDES.find((g) => g.match.test(text));
}

/** Questions that need a licensed professional. */
export function needsLicensed(text: string): 'legal' | 'tax' | 'medical' | 'investment' | undefined {
  if (/\b(sue|lawsuit|court date|my rights|is it legal|custody)\b/i.test(text)) return 'legal';
  if (/\b(audit|irs (letter|notice)|owe (the )?irs)\b/i.test(text)) return 'tax';
  if (/\b(diagnos|medication|dosage|symptom)/i.test(text)) return 'medical';
  if (/\b(invest|stocks?|crypto|which fund)\b/i.test(text)) return 'investment';
  return undefined;
}
