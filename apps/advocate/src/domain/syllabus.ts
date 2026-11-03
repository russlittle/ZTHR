import type { Deadline } from './types.js';
import { MONTHS, ymd } from './dates.js';

/**
 * Syllabus mapping (PRD CRS-1, CRS-2). Deterministic extraction of dated items
 * and of the course's AI policy. Every extracted date keeps its source line so
 * the student can confirm it in one tap; nothing extracted is trusted until then.
 */
export type AiPolicy = 'allowed' | 'allowed-with-limits' | 'not-allowed' | 'unclear' | 'unstated';

export interface SyllabusResult {
  course: string;
  deadlines: Omit<Deadline, 'id' | 'studentId'>[];
  aiPolicy: AiPolicy;
  aiPolicyLine?: string;
}

const KIND_WORDS: [RegExp, Deadline['kind'], number][] = [
  [/\b(final exam|midterm|exam|test)\b/i, 'exam', 6],
  [/\bquiz\b/i, 'exam', 2],
  [/\b(paper|essay|project|portfolio|report)\b/i, 'assignment', 8],
  [/\b(presentation|lab|homework|assignment|discussion|draft|due)\b/i, 'assignment', 3],
  [/\b(read|reading|chapter)\b/i, 'reading', 2],
];

const MONTH_RE = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i');
const NUMERIC_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

function findDate(line: string, termStart: string): { date: string; matched: string } | undefined {
  const startYear = Number(termStart.slice(0, 4));
  const startMonth = Number(termStart.slice(5, 7));
  const inferYear = (m: number, y?: string) => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : m < startMonth - 1 ? startYear + 1 : startYear);
  const mm = line.match(MONTH_RE);
  if (mm) {
    const month = MONTHS.indexOf(mm[1]!.toLowerCase().slice(0, 3)) + 1;
    const day = Number(mm[2]);
    if (day >= 1 && day <= 31) return { date: ymd(inferYear(month, mm[3]), month, day), matched: mm[0] };
  }
  const nm = line.match(NUMERIC_RE);
  if (nm) {
    const month = Number(nm[1]);
    const day = Number(nm[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { date: ymd(inferYear(month, nm[3]), month, day), matched: nm[0] };
  }
  return undefined;
}

export function classifyAiPolicy(text: string): { policy: AiPolicy; line?: string } {
  const lines = text.split(/\r?\n/).filter((l) => /\b(AI|A\.I\.|ChatGPT|generative|artificial intelligence|large language model|LLM|Copilot|Gemini|Claude)\b/.test(l));
  if (lines.length === 0) return { policy: 'unstated' };
  const joined = lines.join(' ');
  const no = /\b(not (be )?(permitted|allowed)|prohibited|forbidden|may not|must not|cannot|is not acceptable|academic (dishonesty|misconduct)|violation)\b/i.test(joined);
  const limits = /\b(with (prior |instructor )?permission|unless|cite|disclose|acknowledge|only (for|to)|brainstorm|limited|approved)\b/i.test(joined);
  const yes = /\b(allowed|permitted|encouraged|may use|welcome)\b/i.test(joined);
  const policy: AiPolicy = limits ? 'allowed-with-limits' : no ? 'not-allowed' : yes ? 'allowed' : 'unclear';
  return { policy, line: lines[0]!.trim() };
}

export function parseSyllabus(course: string, text: string, termStart: string): SyllabusResult {
  const deadlines: SyllabusResult['deadlines'] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kindHit = KIND_WORDS.find(([re]) => re.test(line));
    if (!kindHit) continue;
    const found = findDate(line, termStart);
    if (!found) continue;
    const title = line
      .replace(found.matched, '')
      .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*[.,]?\s*/i, '')
      .replace(/^(week\s*\d+\s*)?[:\-–—()\s]+/i, '')
      .replace(/\s+[:\-–—]\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 90);
    deadlines.push({
      title: title || line.slice(0, 90),
      due: found.date,
      course,
      kind: kindHit[1],
      effortHours: kindHit[2],
      source: { type: 'syllabus', line },
      confirmed: false,
    });
  }
  const ai = classifyAiPolicy(text);
  return { course, deadlines, aiPolicy: ai.policy, aiPolicyLine: ai.line };
}

export function aiPolicySentence(policy: AiPolicy, course: string): string {
  switch (policy) {
    case 'allowed':
      return `${course} allows AI help.`;
    case 'allowed-with-limits':
      return `${course} allows AI help only in limited ways. Check the syllabus line before using it.`;
    case 'not-allowed':
      return `${course} does not allow AI help, so I'll stick to planning and finding people who can help.`;
    case 'unclear':
      return `${course} mentions AI but the rule isn't clear. Worth asking your instructor before using it.`;
    case 'unstated':
      return `The ${course} syllabus does not say if AI is okay. Ask your instructor first.`;
  }
}
