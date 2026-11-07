import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { TranscriptCourse } from './academics.js';

/**
 * Degree progress, from programs declared in control/programs. Each program names its areas, the credits each needs
 * and the courses that count, from the state's published transfer pathway. Progress counts only passed courses; a
 * course counts once, in the first area that lists it. Ohio Transfer 36 is the subset of areas marked as part of it.
 */
export const ProgramDef = z.object({
  program: z.string().regex(/^[a-z0-9-]+$/),
  college: z.string(),
  name: z.string(),
  level: z.enum(['associate', 'bachelor']),
  credits: z.number().positive(),
  source: z.string().url(),
  note: z.string().optional(),
  ot36: z.object({ source: z.string().url(), total: z.number() }).optional(),
  areas: z.array(z.object({ area: z.string(), need: z.number().positive(), courses: z.array(z.string()).min(1), note: z.string().optional(), ot36: z.boolean().optional() })),
  admitted_by: z.enum(['factory', 'person']),
});
export type ProgramDef = z.infer<typeof ProgramDef>;

export const PROGRAM_DIR = fileURLToPath(new URL('../../../../control/programs', import.meta.url));
export const PROGRAMS: ProgramDef[] = readdirSync(PROGRAM_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((f) => ProgramDef.parse(parse(readFileSync(join(PROGRAM_DIR, f), 'utf8'))));
export const programById = (id: string | undefined) => PROGRAMS.find((p) => p.program === id);

const PASSED = new Set(['A', 'B', 'C', 'D', 'P', 'TR']);

export interface AreaProgress {
  area: string;
  need: number;
  done: number;
  inProgress: number;
  courses: string[];
  left: string[];
  ot36: boolean;
  note?: string;
}

export interface DegreeProgress {
  program: ProgramDef;
  areas: AreaProgress[];
  earned: number;
  inProgress: number;
  remaining: number;
  ot36: { done: number; need: number; complete: boolean } | undefined;
  /** Terms left at the student's current load, and the term it lands on. */
  termsLeft: number | undefined;
  finish: string | undefined;
}

export function nextTerms(from: string, n: number): string {
  const seq = ['Spring', 'Summer', 'Fall'];
  let [season, y] = from.split(' ') as [string, string];
  let year = Number(y);
  let i = seq.indexOf(season);
  for (let k = 0; k < n; k++) {
    i = (i + 1) % 3;
    if (i === 0) year++;
    if (seq[i] === 'Summer') {
      // Most students skip summer; it is not counted as a full term.
      i = (i + 1) % 3;
    }
  }
  return `${seq[i]} ${year}`;
}

export function degreeProgress(p: ProgramDef, transcript: TranscriptCourse[], currentTerm: string, creditsPerTerm: number): DegreeProgress {
  const used = new Set<string>();
  const passed = transcript.filter((c) => c.grade && PASSED.has(c.grade));
  const current = transcript.filter((c) => !c.grade);
  const areas: AreaProgress[] = p.areas.map((a) => {
    let done = 0;
    let inProg = 0;
    const counted: string[] = [];
    for (const code of a.courses) {
      const pc = passed.find((c) => c.course === code && !used.has(c.course));
      if (pc && done < a.need) {
        done += pc.credits;
        used.add(code);
        counted.push(code);
        continue;
      }
      const cc = current.find((c) => c.course === code && !used.has(c.course));
      if (cc && done + inProg < a.need) {
        inProg += cc.credits;
        used.add(code);
      }
    }
    return { area: a.area, need: a.need, done: Math.min(done, a.need), inProgress: Math.min(inProg, Math.max(0, a.need - done)), courses: counted, left: a.courses.filter((x) => !used.has(x)), ot36: a.ot36 !== false, ...(a.note ? { note: a.note } : {}) };
  });
  const earned = passed.reduce((n, c) => n + c.credits, 0);
  const inProgress = current.reduce((n, c) => n + c.credits, 0);
  const remaining = Math.max(0, p.credits - earned - inProgress);
  const otAreas = areas.filter((a) => a.ot36);
  const otDone = otAreas.reduce((n, a) => n + a.done, 0);
  const termsLeft = creditsPerTerm > 0 ? Math.ceil(remaining / creditsPerTerm) : undefined;
  return {
    program: p,
    areas,
    earned,
    inProgress,
    remaining,
    ot36: p.ot36 ? { done: otDone, need: otAreas.reduce((n, a) => n + a.need, 0), complete: otAreas.every((a) => a.done >= a.need) } : undefined,
    termsLeft,
    finish: termsLeft === undefined ? undefined : termsLeft === 0 ? currentTerm : nextTerms(currentTerm, termsLeft),
  };
}
