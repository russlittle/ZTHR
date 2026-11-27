/**
 * Roles and permissions: declared once, enforced by one evaluator, and explained by the same evaluator. A role
 * grants actions on kinds of record; a rule narrows which records (their own, their team's, in their
 * organisation); a denial wins over any grant. "Why can, or can't, this person do this?" is answered by the code
 * that decides it, naming the role, the rule and the record field that settled it, so the answer can never drift
 * from the behaviour. The same rules filter lists, so a person never sees a row they could not open.
 */

export interface Subject {
  readonly id: string;
  readonly roles: readonly string[];
  /** Attributes rules compare with (team, organisation, region). */
  readonly attrs?: Readonly<Record<string, string | readonly string[]>>;
}

export type Rec = Readonly<Record<string, unknown>>;

/** A condition on the record, in terms of the subject: "owner = me", "team in my teams". */
export type Condition = { readonly field: string; readonly equalsSubject: 'id' | string } | { readonly field: string; readonly in: readonly unknown[] } | { readonly any: true };

export interface Grant {
  readonly role: string;
  readonly actions: readonly string[];
  readonly kind: string;
  /** Every condition must hold; none means every record of the kind. */
  readonly when?: readonly Condition[];
  /** A grant that refuses instead of allowing; refusals win. */
  readonly deny?: boolean;
  readonly note?: string;
}

export interface Policy {
  readonly roles: Readonly<Record<string, { readonly label: string; readonly inherits?: readonly string[] }>>;
  readonly grants: readonly Grant[];
}

export interface Decision {
  readonly allowed: boolean;
  /** In words a person reads: what decided it. */
  readonly because: string;
  readonly grant?: Grant;
}

/** Every role a subject holds, including those its roles inherit. */
export function rolesOf(p: Policy, s: Subject): Set<string> {
  const out = new Set<string>();
  const add = (r: string) => {
    if (out.has(r) || !p.roles[r]) return;
    out.add(r);
    for (const i of p.roles[r]!.inherits ?? []) add(i);
  };
  s.roles.forEach(add);
  return out;
}

function holds(c: Condition, s: Subject, r: Rec): { ok: boolean; why: string } {
  if ('any' in c) return { ok: true, why: 'any record' };
  const v = r[c.field];
  if ('equalsSubject' in c) {
    const want = c.equalsSubject === 'id' ? s.id : s.attrs?.[c.equalsSubject];
    const ok = Array.isArray(want) ? want.includes(v as string) : v === want;
    return { ok, why: `${c.field} ${ok ? 'is' : 'is not'} ${c.equalsSubject === 'id' ? 'theirs' : `their ${c.equalsSubject}`}` };
  }
  const ok = c.in.includes(v);
  return { ok, why: `${c.field} is ${ok ? '' : 'not '}one of ${c.in.join(', ')}` };
}

/** Whether a subject may do an action on a record of a kind, and why. */
export function decide(p: Policy, s: Subject, action: string, kind: string, r: Rec = {}): Decision {
  const roles = rolesOf(p, s);
  const relevant = p.grants.filter((g) => g.kind === kind && g.actions.includes(action) && roles.has(g.role));
  const evaluate = (g: Grant) => {
    const results = (g.when ?? []).map((c) => holds(c, s, r));
    return { ok: results.every((x) => x.ok), why: results.map((x) => x.why).join(' and ') };
  };
  for (const g of relevant.filter((g) => g.deny)) {
    const e = evaluate(g);
    if (e.ok) return { allowed: false, because: `the ${p.roles[g.role]!.label} role is refused ${action} on ${kind}${e.why ? ` where ${e.why}` : ''}${g.note ? ` (${g.note})` : ''}`, grant: g };
  }
  const tried: string[] = [];
  for (const g of relevant.filter((g) => !g.deny)) {
    const e = evaluate(g);
    if (e.ok) return { allowed: true, because: `the ${p.roles[g.role]!.label} role allows ${action} on ${kind}${e.why ? ` because ${e.why}` : ''}`, grant: g };
    tried.push(`the ${p.roles[g.role]!.label} role would, but ${e.why}`);
  }
  if (tried.length) return { allowed: false, because: tried.join('; ') };
  const any = p.grants.filter((g) => g.kind === kind && g.actions.includes(action) && !g.deny).map((g) => p.roles[g.role]?.label ?? g.role);
  return { allowed: false, because: any.length ? `none of their roles allows ${action} on ${kind}; ${[...new Set(any)].join(' or ')} would` : `no role allows ${action} on ${kind}` };
}

export class Forbidden extends Error {
  readonly decision: Decision;
  constructor(d: Decision) {
    super(d.because);
    this.decision = d;
  }
}

export function require(p: Policy, s: Subject, action: string, kind: string, r: Rec = {}): void {
  const d = decide(p, s, action, kind, r);
  if (!d.allowed) throw new Forbidden(d);
}

/** The rows a subject may take an action on: the same rules, applied to a list. */
export const filter = <T extends Rec>(p: Policy, s: Subject, action: string, kind: string, rows: readonly T[]) => rows.filter((r) => decide(p, s, action, kind, r).allowed);

/** Every action each role has on each kind, for the permissions page and the generated docs. */
export function matrix(p: Policy): { role: string; kind: string; action: string; scope: string; deny: boolean }[] {
  return p.grants.map((g) => ({ role: p.roles[g.role]?.label ?? g.role, kind: g.kind, action: g.actions.join(', '), scope: (g.when ?? []).map((c) => ('any' in c ? 'any' : 'equalsSubject' in c ? `${c.field} = their ${c.equalsSubject}` : `${c.field} in ${c.in.join('/')}`)).join(' and ') || 'all', deny: !!g.deny }));
}

/** Problems in a policy: grants naming roles that do not exist, inheritance cycles. */
export function check(p: Policy): string[] {
  const out: string[] = [];
  for (const g of p.grants) if (!p.roles[g.role]) out.push(`a grant names the role "${g.role}", which is not declared`);
  for (const r of Object.keys(p.roles)) {
    const seen = new Set<string>();
    const walk = (x: string): boolean => {
      if (x === r) return true;
      if (seen.has(x)) return false;
      seen.add(x);
      return (p.roles[x]?.inherits ?? []).some(walk);
    };
    if ((p.roles[r]!.inherits ?? []).some((i) => walk(i))) out.push(`the role "${r}" inherits itself`);
  }
  return out;
}
