import { checkRatchet, verifyFloorChange, type ResetEntry } from '@zthr/gates';

/**
 * Mutation testing as a standing loop (docs/testing/mutation.md). Each module in scope has its own floor, so one
 * module's gain cannot hide another's loss. A floor tightens on its own to the whole percent a nightly run measured;
 * it loosens only through a reset in the ledger, made by a listed person with a reason. What survived is written as
 * the next work: each surviving mutant, with the line it changed.
 */
export interface Mutant {
  status: string;
  mutatorName: string;
  replacement?: string;
  location: { start: { line: number } };
}
export interface Report {
  files: Record<string, { source?: string; mutants: Mutant[] }>;
}
export interface FileScore {
  file: string;
  score: number;
  killed: number;
  valid: number;
}
export interface Survivor {
  file: string;
  line: number;
  mutator: string;
  replacement: string;
  code: string;
}
export type Floors = Record<string, number>;

const CAUGHT = new Set(['Killed', 'Timeout']);
const NOT_COUNTED = new Set(['CompileError', 'RuntimeError', 'Ignored']);

export function scores(report: Report): FileScore[] {
  return Object.entries(report.files)
    .map(([file, f]) => {
      const valid = f.mutants.filter((m) => !NOT_COUNTED.has(m.status)).length;
      const killed = f.mutants.filter((m) => CAUGHT.has(m.status)).length;
      return { file, killed, valid, score: valid ? (killed / valid) * 100 : 100 };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function survivors(report: Report): Survivor[] {
  return Object.entries(report.files)
    .flatMap(([file, f]) => {
      const lines = (f.source ?? '').split('\n');
      return f.mutants
        .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
        .map((m) => ({ file, line: m.location.start.line, mutator: m.mutatorName, replacement: (m.replacement ?? '').slice(0, 120), code: (lines[m.location.start.line - 1] ?? '').trim().slice(0, 160) }));
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export interface FloorResult {
  file: string;
  score: number;
  floor: number;
  next: number;
  ok: boolean;
  detail: string;
}

/**
 * Each file against its floor. The floor held is the higher of the repository's and the last nightly run's, unless
 * the ledger has a person's reset from the one to the other. A file with no floor yet starts at what it measures.
 */
export function judge(measured: FileScore[], repo: Floors, last: Floors, ledger: ResetEntry[], people: string[]): FloorResult[] {
  return measured.map(({ file, score }) => {
    const id = `mutation:${file}`;
    const prior = last[file];
    const stated = repo[file];
    let floor: number;
    let note = '';
    if (prior !== undefined && stated !== undefined && stated < prior) {
      const v = verifyFloorChange({ id, metric: '', direction: 'up', floor: prior }, { id, metric: '', direction: 'up', floor: stated }, ledger, people);
      floor = v.status === 'pass' ? stated : prior;
      note = v.status === 'pass' ? `; ${v.reason}` : `; the floor stays at ${prior}: ${v.reason}`;
    } else floor = Math.max(stated ?? -Infinity, prior ?? -Infinity);
    if (!Number.isFinite(floor)) floor = Math.floor(score);
    const r = checkRatchet({ id, metric: `mutation score of ${file}`, direction: 'up', floor }, Math.floor(score * 10) / 10);
    const next = r.verdict.status === 'pass' ? Math.max(floor, Math.floor(score)) : floor;
    return { file, score, floor, next, ok: r.verdict.status === 'pass', detail: `${score.toFixed(1)}% against ${floor}%${note}` };
  });
}

export const nextFloors = (results: FloorResult[]): Floors => Object.fromEntries(results.map((r) => [r.file, r.next]));
