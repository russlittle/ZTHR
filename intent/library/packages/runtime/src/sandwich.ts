/**
 * The deterministic sandwich (Pattern 28): deterministic checks before and
 * after any model step, and a deterministic fallback so no model is ever the
 * floor (Pattern 31: fail closed, keep serving the user).
 */
export interface SandwichSpec<I, O> {
  pre: (input: I) => { ok: true } | { ok: false; reason: string };
  model: (input: I) => Promise<O>;
  post: (output: O, input: I) => { ok: true } | { ok: false; reason: string };
  fallback: (input: I, reason: string) => O;
  attempts?: number;
}

export async function sandwich<I, O>(spec: SandwichSpec<I, O>, input: I): Promise<{ output: O; usedModel: boolean; reason?: string }> {
  const pre = spec.pre(input);
  if (!pre.ok) return { output: spec.fallback(input, pre.reason), usedModel: false, reason: pre.reason };
  let lastReason = 'model not attempted';
  for (let i = 0; i < (spec.attempts ?? 2); i++) {
    try {
      const out = await spec.model(input);
      const post = spec.post(out, input);
      if (post.ok) return { output: out, usedModel: true };
      lastReason = post.reason;
    } catch (e) {
      lastReason = `model error: ${(e as Error).message}`;
    }
  }
  return { output: spec.fallback(input, lastReason), usedModel: false, reason: lastReason };
}

/** Refuse to start misconfigured (Pattern 29): check resolved reality, not intentions. */
export interface StartupCondition {
  name: string;
  check: () => boolean | string;
}

export function refuseToStartUnless(conditions: StartupCondition[]): void {
  const failures: string[] = [];
  for (const c of conditions) {
    const r = c.check();
    if (r !== true) failures.push(`${c.name}: ${typeof r === 'string' ? r : 'failed'}`);
  }
  if (failures.length > 0) throw new Error(`refusing to start:\n  ${failures.join('\n  ')}`);
}
