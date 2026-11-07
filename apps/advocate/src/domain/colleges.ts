import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Colleges, declared once each in control/colleges (PRD Phase 4: any college). Everything the Advocate knows about a
 * college comes from its file: its name and the words students use for it, its county (which decides the help
 * near it), its website and its career office. Adding a college is a new file and the scouts for its county,
 * admitted by the factory; no code changes.
 */
export const CollegeDef = z.object({
  college: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  short: z.string(),
  words: z.array(z.string().min(3)).min(1),
  county: z.string(),
  state: z.string().length(2),
  website: z.string().url(),
  career: z.object({ name: z.string(), contact: z.string(), source: z.string().url() }),
  admitted_by: z.enum(['factory', 'person']),
  /** Standing, aid progress, refunds and term dates, each from the college's published policy (Phase 5). */
  academic: z
    .object({
      level: z.enum(['associate', 'bachelor']),
      standing: z.object({ kind: z.enum(['consecutive-term', 'cumulative-after-hours']), goodGpa: z.number(), afterHours: z.number().optional(), ladder: z.array(z.string()).optional(), source: z.string().url() }),
      sap: z.object({
        gpa: z.number(),
        pace: z.number(),
        maxTimeframe: z.number(),
        evaluated: z.string(),
        statuses: z.string(),
        appeal: z.array(z.object({ term: z.string(), opens: z.string(), closes: z.string(), planDue: z.string().optional() })).optional(),
        how: z.string(),
        source: z.string().url(),
      }),
      refund: z.string(),
      refundSource: z.string().url().optional(),
      terms: z.array(
        z.object({
          term: z.string(),
          start: z.string(),
          classesEnd: z.string(),
          end: z.string(),
          endNote: z.string().optional(),
          refund100By: z.string(),
          withdrawBy: z.string(),
          breaks: z.array(z.object({ from: z.string(), to: z.string(), name: z.string() })),
          source: z.string().url(),
          sourceNote: z.string().optional(),
        }),
      ),
      termsNote: z.string().optional(),
    })
    .optional(),
});
export type CollegeDef = z.infer<typeof CollegeDef>;

export const COLLEGE_DIR = fileURLToPath(new URL('../../../../control/colleges', import.meta.url));

export function loadColleges(dir = COLLEGE_DIR): CollegeDef[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => CollegeDef.parse(parse(readFileSync(join(dir, f), 'utf8'))));
}

export const COLLEGES: CollegeDef[] = loadColleges();
export const collegeById = (id: string): CollegeDef | undefined => COLLEGES.find((c) => c.college === id);

/** Which college a student named, longest words first ("wright state" before "wright"). */
export function collegeFromText(text: string): string | undefined {
  const t = text.toLowerCase();
  const words = COLLEGES.flatMap((c) => c.words.map((w) => ({ w: w.toLowerCase(), id: c.college }))).sort((a, b) => b.w.length - a.w.length);
  return words.find(({ w }) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))?.id;
}
