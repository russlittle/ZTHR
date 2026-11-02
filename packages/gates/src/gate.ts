import { type Verdict, fail, unknown, verdict } from './verdict.js';
import { sha256 } from './hash.js';

/**
 * A gate states what it protects (Pattern 2: purpose notes), checks a subject,
 * and carries the planted defects that prove it can fail (Pattern 8).
 */
export interface FalsificationCase<S> {
  name: string;
  /** Build a subject that contains exactly the defect this gate exists to catch. */
  plant: () => S | Promise<S>;
}

export interface Gate<S> {
  id: string;
  protects: string;
  /** Source that defines the gate's behavior; its hash pins every proof. */
  definition: string;
  check: (subject: S) => Verdict | Promise<Verdict>;
  falsification: FalsificationCase<S>[];
}

export interface Proof {
  gate: string;
  gateHash: string;
  cases: { name: string; status: Verdict['status']; reason: string }[];
  provenAt: string;
  valid: boolean;
}

export const gateHash = (g: Pick<Gate<unknown>, 'id' | 'protects' | 'definition'>): string =>
  sha256(`${g.id}\n${g.protects}\n${g.definition}`);

/** Run every planted defect. The gate is proven only if every one is caught (fail). */
export async function proveGate<S>(g: Gate<S>): Promise<Proof> {
  const cases: Proof['cases'] = [];
  for (const c of g.falsification) {
    let v: Verdict;
    try {
      v = await g.check(await c.plant());
    } catch (e) {
      v = unknown(g.id, `check threw on planted defect: ${(e as Error).message}`);
    }
    cases.push({ name: c.name, status: v.status, reason: v.reason });
  }
  const valid = cases.length > 0 && cases.every((c) => c.status === 'fail');
  return { gate: g.id, gateHash: gateHash(g as Gate<unknown>), cases, provenAt: new Date().toISOString(), valid };
}

/**
 * A green from an unproven gate does not count. If the stored proof does not
 * match the gate's current hash, the proof has expired and the verdict is unknown.
 */
export async function runProvenGate<S>(g: Gate<S>, subject: S, proof: Proof | undefined): Promise<Verdict> {
  if (!proof) return unknown(g.id, 'gate has no falsification proof');
  if (proof.gateHash !== gateHash(g as Gate<unknown>)) return unknown(g.id, 'falsification proof expired: gate changed since it was proven');
  if (!proof.valid) return fail(g.id, 'gate failed its own falsification proof', proof);
  try {
    return await g.check(subject);
  } catch (e) {
    return verdict(g.id, 'unknown', `gate check threw: ${(e as Error).message}`);
  }
}
