/**
 * Safety router. Deterministic, runs before any model sees a message, and can
 * only add a route, never remove one. Patterns err toward routing: a false
 * positive costs a kind message; a false negative can cost a life.
 */
export type CrisisCategory = 'self-harm' | 'danger-from-others' | 'medical-emergency' | 'abuse';

export interface SafetyResult {
  crisis: boolean;
  categories: CrisisCategory[];
}

const PATTERNS: Record<CrisisCategory, RegExp[]> = {
  'self-harm': [
    /\b(kill|hurt|harm|cut)(ing)?\s+my\s*self\b/i,
    /\bkms\b/i,
    /\bsuicid(e|al)\b/i,
    /\bend(ing)?\s+(my|it)\s+(life|all)\b/i,
    /\b(want|wanna|going)\s+to\s+die\b/i,
    /\bwanna\s+die\b/i,
    /\bdon'?t\s+want\s+to\s+(be\s+alive|live|wake\s+up)\b/i,
    /\bno\s+reason\s+to\s+live\b/i,
    /\bbetter\s+off\s+(dead|without\s+me)\b/i,
    /\boverdos(e|ed|ing)\b/i,
    /\btoo\s+many\s+(pills|tablets)\b/i,
    /\bunaliv(e|ing)\b/i,
    /\b(disappear|vanish)\s+(forever|for\s+good)\b/i,
    /\b(no\s?one|nobody)\s+would\s+(care|notice|miss\s+me)\b.*\b(gone|dead|died|disappeared)\b/i,
    /\b(plan|planning)\s+to\s+(end\s+my\s+life|kill\s+myself)\b/i,
    // Spanish: the same words students use, routed the same way.
    /\b(me\s+quiero\s+matar|quiero\s+morir(me)?|matarme|suicid(arme|io)|quitarme\s+la\s+vida|no\s+quiero\s+vivir)\b/i,
  ],
  'danger-from-others': [
    /\b(he|she|they|someone)\s+(is\s+)?(threaten(ing|ed)?|going\s+to\s+(hurt|kill))\s+(me|to)\b/i,
    /\b(he|she|they)('s|'re|\s+is|\s+are)\s+(threaten(ing|ed)?\s+to\s+(kill|hurt)|going\s+to\s+(kill|hurt))\s+me\b/i,
    /\bme\s+quiere\s+matar\b/i,
    /\bnot\s+safe\s+(at\s+home|here|right\s+now)\b/i,
    /\b(afraid|scared)\s+(he|she|they)('ll|\s+will)\s+(hurt|kill)\b/i,
    /\bsomeone\s+is\s+following\s+me\b/i,
  ],
  'medical-emergency': [/\b(can'?t|cannot)\s+breathe\b/i, /\bchest\s+pain\b/i, /\bseizure\b/i, /\bunconscious\b/i],
  abuse: [
    /\b(me\s+pega|me\s+golpea|me\s+maltrata)\b/i,/\b(he|she|they|my\s+(partner|boyfriend|girlfriend|husband|wife))\s+(hit|hits|beat|beats|choked|chokes|hurt|hurts)\s+me\b/i, /\babus(e|ing|ive)\b.*\b(me|my)\b/i],
};

export function screen(message: string): SafetyResult {
  const categories = (Object.keys(PATTERNS) as CrisisCategory[]).filter((c) => PATTERNS[c].some((p) => p.test(message)));
  return { crisis: categories.length > 0, categories };
}

/** Fixed text, never generated. */
export function crisisReply(categories: CrisisCategory[]): string {
  const lines = [
    "I'm really glad you told me. You deserve support right now.",
    'You can call or text 988 any time to reach the Suicide & Crisis Lifeline, free and confidential.',
  ];
  if (categories.includes('danger-from-others') || categories.includes('medical-emergency') || categories.includes('abuse')) {
    lines.push('If you are in immediate danger, call 911.');
  }
  if (categories.includes('abuse')) {
    lines.push('The National Domestic Violence Hotline is 1-800-799-7233, or text START to 88788.');
  }
  lines.push("I'm here too. Would it help if I stayed with you while you reach out?");
  return lines.join(' ');
}

/** A model may add a route the patterns missed; it can never remove one. */
export function mergeSecondCheck(first: SafetyResult, modelSaysCrisis: boolean | undefined): SafetyResult {
  if (first.crisis) return first;
  if (modelSaysCrisis) return { crisis: true, categories: ['self-harm'] };
  return first;
}
