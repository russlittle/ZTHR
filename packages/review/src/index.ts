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
  intent: string;
  context?: string;
  repoFiles?: Record<string, string>;
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
      return `Intent:\n${input.intent}\n\nContext:\n${input.context ?? '(none)'}\n\nDiff:\n${input.diff}`;
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
