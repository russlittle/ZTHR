/**
 * Workflows as declared state machines. Each transition names who may take it and what must be true first; an
 * approval step needs a number of distinct approvers (never the person who asked), and a rejection says why. Steps
 * can carry a deadline that escalates when missed. The definition is checked when it is loaded: every state is
 * reachable, every non-final state has a way out, so a record can never be stranded.
 */

export interface Transition {
  readonly from: string;
  readonly to: string;
  readonly action: string;
  readonly roles: readonly string[];
  /** Returns a reason it cannot happen yet, or undefined. */
  readonly guard?: (record: Readonly<Record<string, unknown>>) => string | undefined;
}

export interface Approval {
  readonly state: string;
  readonly approvers: number;
  readonly roles: readonly string[];
  readonly onApproved: string;
  readonly onRejected: string;
  /** Hours before it escalates. */
  readonly dueHours?: number;
}

export interface Definition {
  readonly name: string;
  readonly start: string;
  readonly final: readonly string[];
  readonly transitions: readonly Transition[];
  readonly approvals?: readonly Approval[];
}

export function check(d: Definition): string[] {
  const out: string[] = [];
  const states = new Set([d.start, ...d.final, ...d.transitions.flatMap((t) => [t.from, t.to]), ...(d.approvals ?? []).flatMap((a) => [a.state, a.onApproved, a.onRejected])]);
  const next = (s: string) => [...d.transitions.filter((t) => t.from === s).map((t) => t.to), ...(d.approvals ?? []).filter((a) => a.state === s).flatMap((a) => [a.onApproved, a.onRejected])];
  const seen = new Set([d.start]);
  const todo = [d.start];
  while (todo.length) for (const n of next(todo.pop()!)) if (!seen.has(n)) seen.add(n), todo.push(n);
  for (const s of [...states].sort()) {
    if (!seen.has(s)) out.push(`${s} cannot be reached from ${d.start}`);
    if (!d.final.includes(s) && next(s).length === 0) out.push(`${s} has no way out and is not final`);
  }
  return out;
}

export interface Instance {
  readonly id: string;
  state: string;
  readonly by: string;
  readonly data: Record<string, unknown>;
  approvals: { who: string; ok: boolean; why?: string; at: string }[];
  readonly trail: { from: string; to: string; action: string; who: string; at: string; why?: string }[];
  enteredAt: number;
  escalated?: boolean;
}

export class Refused extends Error {}

export class Workflow {
  readonly d: Definition;
  private readonly now: () => number;
  constructor(d: Definition, now: () => number = Date.now) {
    const p = check(d);
    if (p.length) throw new Error(`${d.name}: ${p.join('; ')}`);
    this.d = d;
    this.now = now;
  }

  start(id: string, by: string, data: Record<string, unknown> = {}): Instance {
    return { id, state: this.d.start, by, data, approvals: [], trail: [], enteredAt: this.now() };
  }

  private move(i: Instance, to: string, action: string, who: string, why?: string): void {
    i.trail.push({ from: i.state, to, action, who, at: new Date(this.now()).toISOString(), ...(why ? { why } : {}) });
    i.state = to;
    i.approvals = [];
    i.enteredAt = this.now();
    delete i.escalated;
  }

  /** The actions this person can take now, with why each other one is not available. */
  actions(i: Instance, roles: readonly string[]): { action: string; ok: boolean; why?: string }[] {
    return this.d.transitions.filter((t) => t.from === i.state).map((t) => {
      if (!t.roles.some((r) => roles.includes(r))) return { action: t.action, ok: false, why: 'your role cannot do this' };
      const g = t.guard?.(i.data);
      return g ? { action: t.action, ok: false, why: g } : { action: t.action, ok: true };
    });
  }

  act(i: Instance, action: string, who: string, roles: readonly string[]): void {
    const t = this.d.transitions.find((x) => x.from === i.state && x.action === action);
    if (!t) throw new Refused(`${action} is not possible from ${i.state}`);
    if (!t.roles.some((r) => roles.includes(r))) throw new Refused('your role cannot do this');
    const g = t.guard?.(i.data);
    if (g) throw new Refused(g);
    this.move(i, t.to, action, who);
  }

  decide(i: Instance, who: string, roles: readonly string[], ok: boolean, why?: string): void {
    const a = this.d.approvals?.find((x) => x.state === i.state);
    if (!a) throw new Refused(`${i.state} is not waiting for approval`);
    if (who === i.by) throw new Refused('the person who asked cannot approve it');
    if (!a.roles.some((r) => roles.includes(r))) throw new Refused('your role cannot approve this');
    if (i.approvals.some((x) => x.who === who)) throw new Refused('you have already decided');
    if (!ok && !why?.trim()) throw new Refused('say why it is rejected');
    i.approvals.push({ who, ok, ...(why ? { why } : {}), at: new Date(this.now()).toISOString() });
    if (!ok) this.move(i, a.onRejected, 'reject', who, why);
    else if (i.approvals.filter((x) => x.ok).length >= a.approvers) this.move(i, a.onApproved, 'approve', who);
  }

  /** Instances past their step's deadline that have not been escalated yet; marks them. */
  overdue(list: Instance[]): Instance[] {
    const out: Instance[] = [];
    for (const i of list) {
      const a = this.d.approvals?.find((x) => x.state === i.state);
      if (a?.dueHours && !i.escalated && this.now() - i.enteredAt > a.dueHours * 3_600_000) {
        i.escalated = true;
        out.push(i);
      }
    }
    return out;
  }
}
