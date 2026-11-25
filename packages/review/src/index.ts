import type { ModelClient } from '@zthr/models';
import { ModelUnavailable } from '@zthr/models';
import { type Verdict, combine, fail, pass, unknown } from '@zthr/gates';

/**
 * Multi-family review (Pattern 21) with roles defined by what they are denied
 * (Pattern 20). Before commit: a context-aided seat, an unaided seat that sees
 * only the diff, and an independent code check. After merge: an in-place seat.
 * A seat whose provider is unavailable returns unknown, which never admits.
 */
export type SeatRole = 'context-aided' | 'unaided' | 'independent' | 'in-place';

export interface Seat {
  role: SeatRole;
  family: string;
  model: string;
  client: ModelClient;
}

export interface ReviewInput {
  diff: string;
  /** What the change must preserve: the locked datum, never the author's account of the change. */
  intent: string;
  /** The author's description of the change: a claim for the context-aided seat to test, never evidence. */
  claim?: string;
  context?: string;
  repoFiles?: Record<string, string>;
  /** Parts of the change the seats were not shown. Any entry makes every seat unknown (Pattern 9). */
  omitted?: string[];
}

export interface Finding {
  seat: SeatRole;
  family: string;
  severity: 'blocker' | 'major' | 'minor';
  summary: string;
}

const SYSTEM =
  'You are a code reviewer in a zero-trust panel. Report only real defects: incorrect behavior, security or privacy flaws, broken requirements. ' +
  'Answer with JSON: {"verdict":"pass"|"fail","findings":[{"severity":"blocker"|"major"|"minor","summary":"..."}]}.';

/** What each role is allowed to see. Denials are enforced here, not by instruction. */
export function promptFor(role: SeatRole, input: ReviewInput): string {
  switch (role) {
    case 'context-aided':
      return `Intent:\n${input.intent}\n\nContext:\n${input.context ?? '(none)'}\n\n${input.claim === undefined ? '' : `The author's description of the change, a claim to test, not evidence:\n${input.claim}\n\n`}Diff:\n${input.diff}`;
    case 'unaided':
      return `Diff:\n${input.diff}`;
    case 'independent':
      return `Intent:\n${input.intent}\n\nResulting files:\n${Object.entries(input.repoFiles ?? {})
        .map(([p, c]) => `--- ${p}\n${c}`)
        .join('\n')}`;
    case 'in-place':
      return `Intent:\n${input.intent}\n\nMerged files:\n${Object.entries(input.repoFiles ?? {})
        .map(([p, c]) => `--- ${p}\n${c}`)
        .join('\n')}`;
  }
}

export function parseReview(text: string): { verdict: 'pass' | 'fail'; findings: { severity: Finding['severity']; summary: string }[] } | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { verdict?: string; findings?: { severity?: string; summary?: string }[] };
    if (j.verdict !== 'pass' && j.verdict !== 'fail') return undefined;
    return {
      verdict: j.verdict,
      findings: (j.findings ?? []).map((f) => ({
        severity: f.severity === 'blocker' || f.severity === 'major' ? f.severity : 'minor',
        summary: String(f.summary ?? ''),
      })),
    };
  } catch {
    return undefined;
  }
}

export async function reviewSeat(seat: Seat, input: ReviewInput): Promise<{ verdict: Verdict; findings: Finding[] }> {
  const gate = `review:${seat.role}:${seat.family}`;
  // A reviewer that saw part of a change has approved nothing about the rest.
  if (input.omitted?.length) return { verdict: unknown(gate, `saw only part of the change; not shown: ${input.omitted.join('; ')}`), findings: [] };
  try {
    const r = await seat.client.complete({
      model: seat.model,
      purpose: `review:${seat.role}`,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: promptFor(seat.role, input) },
      ],
    });
    const parsed = parseReview(r.text);
    if (!parsed) return { verdict: unknown(gate, 'review output could not be parsed'), findings: [] };
    const findings = parsed.findings.map((f) => ({ ...f, seat: seat.role, family: seat.family }));
    const blocking = findings.filter((f) => f.severity !== 'minor');
    if (parsed.verdict === 'fail' || blocking.length > 0) return { verdict: fail(gate, blocking.map((f) => f.summary).join('; ') || 'reviewer failed the change'), findings };
    return { verdict: pass(gate, 'no blocking findings'), findings };
  } catch (e) {
    const reason = e instanceof ModelUnavailable ? `provider unavailable: ${e.message}` : `review error: ${(e as Error).message}`;
    return { verdict: unknown(gate, reason), findings: [] };
  }
}

/** The panel requires at least three distinct families before commit. */
export async function reviewPanel(seats: Seat[], input: ReviewInput): Promise<{ verdict: Verdict; findings: Finding[] }> {
  const pre = seats.filter((s) => s.role !== 'in-place');
  const families = new Set(pre.map((s) => s.family));
  if (families.size < 3) return { verdict: fail('review-panel', `only ${families.size} model families before commit; three are required`), findings: [] };
  const results = await Promise.all(pre.map((s) => reviewSeat(s, input)));
  return { verdict: combine('review-panel', results.map((r) => r.verdict)), findings: results.flatMap((r) => r.findings) };
}

/** The locked journeys as the intent every seat reviews against: each goal, and what must never happen. */
export function datumIntent(cards: { id: string; goal: string; forbidden?: string[] }[]): string {
  return cards
    .map((c) => `${c.id}: ${c.goal}${c.forbidden?.length ? `\n  Never: ${c.forbidden.join('; ')}` : ''}`)
    .join('\n');
}

export interface Limits {
  diffChars: number;
  fileChars: number;
  files: number;
}

/**
 * Fit a change to what a seat can be shown, saying exactly what was left out. Nothing is cut silently: anything
 * omitted is named, and an omission makes every seat unknown, so a change too large to review must be split.
 */
export function boundInput(diff: string, files: Record<string, string>, limits: Limits): { diff: string; repoFiles: Record<string, string>; omitted: string[] } {
  const omitted: string[] = [];
  if (diff.length > limits.diffChars) omitted.push(`the diff past ${limits.diffChars} of ${diff.length} characters`);
  const names = Object.keys(files);
  if (names.length > limits.files) omitted.push(`${names.length - limits.files} of ${names.length} changed files`);
  const repoFiles: Record<string, string> = {};
  for (const n of names.slice(0, limits.files)) {
    const c = files[n]!;
    if (c.length > limits.fileChars) omitted.push(`${n} past ${limits.fileChars} of ${c.length} characters`);
    repoFiles[n] = c.slice(0, limits.fileChars);
  }
  return { diff: diff.slice(0, limits.diffChars), repoFiles, omitted };
}
