/** Bounded (worker) jobs for csv.test.ts: properties that must also finish, not just hold. */
import { parseCsv } from '../../blocks/tabular/index.ts';
import { runCases, type Rand } from './harness.ts';

const JUNK = ['"', '""', ',', ';', '\r', '\n', '\r\n', 'a', ' ', '﻿', '\0', '😀', '\ud800', 'é', '\t'];

export const junk = (r: Rand): { text: string; sep: string } => ({ text: r.bool(0.5) ? r.str(0, 400, JUNK) : r.text(0, 400), sep: r.pick([',', ',', ';', '\t', '"', '\n', 'a']) });

export function parseJunk(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('parseCsv on junk returns rows of strings or throws Error', seed, cases, only, report, junk, ({ text, sep }) => {
    let rows: string[][];
    try {
      rows = parseCsv(text, sep);
    } catch (e) {
      if (!(e instanceof Error)) throw new Error(`threw a non-Error: ${String(e)}`);
      return;
    }
    if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row) && row.every((c) => typeof c === 'string'))) throw new Error('did not return string[][]');
    const chars = rows.reduce((n, row) => n + row.reduce((m, c) => m + c.length, 0), 0);
    if (chars > text.length) throw new Error(`returned ${chars} characters of cells from ${text.length} characters of input`);
  });
}
