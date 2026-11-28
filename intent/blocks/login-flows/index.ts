/**
 * Sign-in as a declared flow rather than code: a tree of executions (identify, password, one-time code, passkey,
 * cookie, and anything you register), each REQUIRED, ALTERNATIVE, CONDITIONAL or DISABLED, in the way Keycloak and
 * Authentik model it. REQUIRED steps all happen in order; if a level has no REQUIRED step, the person needs one of
 * its ALTERNATIVEs (and chooses when several are possible); a CONDITIONAL sub-flow runs only when all its conditions
 * hold (role, attribute, network, requested level, authenticator set up, or your own test). Step-up: every
 * authenticator may carry a level, an existing session at that level skips it, and a conditional sub-flow on the
 * requested level asks for the stronger factor only when it is wanted. After the flow, required actions (change an
 * expired password, verify email, set up a second factor, accept new terms, or any you queue) are presented one at a
 * time before the flow completes. The engine is a state machine you drive: current() says what to show, submit()
 * takes what the person gave, and nothing in it checks a password itself, your authenticators do. Failures say only
 * "invalid_credentials" whether or not the account exists, and are counted against the typed name either way. Brute
 * force protection is a separate bounded component: temporary lockouts that double with each strike up to a cap,
 * optional permanent lockout until an administrator unlocks, a quick-login-failure check, per-address throttling, a
 * decision that does not reveal whether an account exists, and counters that expire and are capped in memory.
 * validateFlow() finds flows that could sign someone in without checking a credential. Out of scope: the screens,
 * the credential checks themselves (sessions has TOTP and recovery codes), and storing flows or sessions.
 */

export class LoginFlowError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type Requirement = 'REQUIRED' | 'ALTERNATIVE' | 'CONDITIONAL' | 'DISABLED';

export interface UserState {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly attributes?: Readonly<Record<string, string>>;
  readonly emailVerified?: boolean;
  readonly passwordChangedAt?: number;
  readonly requiredActions?: readonly string[];
  /** Authenticators this person has set up, such as "otp" or "webauthn". */
  readonly configured?: readonly string[];
  readonly termsAccepted?: number;
}

export interface ExistingSession {
  readonly user: string;
  readonly level: number;
  readonly amr: readonly string[];
}

export interface FlowContext {
  user: UserState | null;
  /** What the person typed to identify themselves, normalised. */
  username?: string;
  ip?: string;
  client?: string;
  /** The assurance level the application asks for. Default 1. */
  requestedLevel: number;
  session?: ExistingSession;
}

export type VerifyResult = { readonly ok: true; readonly user?: string; readonly amr?: string } | { readonly ok: false; readonly code?: string };

export interface Authenticator {
  readonly name: string;
  /** "identify" names the account; "credential" and "second-factor" prove it; "info" asks for nothing and cannot sign anyone in. */
  readonly kind: 'identify' | 'credential' | 'second-factor' | 'passwordless' | 'session' | 'info';
  /** The assurance this step provides: a session already at this level skips it. Default 1 (2 for second-factor). */
  readonly level?: number;
  /** For authenticators that need set-up: whether this person has done it. Default true. */
  readonly configuredFor?: (user: UserState | null) => boolean;
  /** When a REQUIRED authenticator is not set up, queue this action instead of failing. */
  readonly setupAction?: string;
  /** Satisfied without asking (a valid cookie). Return null to ask. */
  readonly auto?: (ctx: FlowContext) => VerifyResult | null;
  /** Checks what the person submitted. */
  readonly verify?: (input: unknown, ctx: FlowContext) => VerifyResult;
}

export type Condition =
  | { readonly type: 'role'; readonly role: string }
  | { readonly type: 'attribute'; readonly name: string; readonly value: string }
  | { readonly type: 'network'; readonly cidrs: readonly string[]; readonly negate?: boolean }
  | { readonly type: 'requested-level'; readonly atLeast: number }
  | { readonly type: 'session-level-below'; readonly level: number }
  | { readonly type: 'configured'; readonly authenticator: string; readonly negate?: boolean }
  | { readonly type: 'custom'; readonly test: (ctx: FlowContext) => boolean };

export interface Execution {
  readonly id: string;
  readonly authenticator: string;
  readonly requirement: Requirement;
}

export interface SubFlow {
  readonly id: string;
  readonly requirement: Requirement;
  readonly conditions?: readonly Condition[];
  readonly executions: readonly (Execution | SubFlow)[];
}

export const isSubFlow = (n: Execution | SubFlow): n is SubFlow => 'executions' in n;

// ---------------------------------------------------------------------------------------------------------------
// Brute force

export interface BruteForceOptions {
  /** Failures in a row (within the reset window) that cause a lockout. Default 5. */
  readonly maxFailures?: number;
  /** First lockout wait; doubles with each further lockout. Default 60 s. */
  readonly baseWaitMs?: number;
  readonly maxWaitMs?: number;
  /** After this many lockouts the account stays locked until unlocked. 0 = never permanent. Default 0. */
  readonly permanentAfterLockouts?: number;
  /** Failure counts are forgotten after this long without a failure. Default 12 hours. */
  readonly resetAfterMs?: number;
  /** Two failures closer together than this count as a "quick login failure" and lock out at once. 0 = off. Default 0. */
  readonly quickFailureMs?: number;
  /** Failures from one address across any names before it is throttled. Default 50 per window. */
  readonly maxFailuresPerIp?: number;
  readonly ipWindowMs?: number;
  /** Most names and addresses tracked; the least recently failed are dropped. Default 100 000. */
  readonly maxTracked?: number;
}

export interface Gate {
  readonly allowed: boolean;
  readonly reason?: 'temporary' | 'permanent' | 'ip-throttle';
  readonly retryAfterMs?: number;
}

interface Rec {
  failures: number;
  lockouts: number;
  lastFailure: number;
  lockedUntil: number;
  permanent: boolean;
}

/** Counts failed sign-ins per typed name and per address, and says when to refuse. It treats unknown names exactly like known ones. */
export class BruteForce {
  private readonly users = new Map<string, Rec>();
  private readonly ips = new Map<string, { start: number; n: number }>();
  private readonly o: Required<BruteForceOptions>;

  constructor(o: BruteForceOptions = {}) {
    this.o = { maxFailures: o.maxFailures ?? 5, baseWaitMs: o.baseWaitMs ?? 60_000, maxWaitMs: o.maxWaitMs ?? 15 * 60_000, permanentAfterLockouts: o.permanentAfterLockouts ?? 0, resetAfterMs: o.resetAfterMs ?? 12 * 3_600_000, quickFailureMs: o.quickFailureMs ?? 0, maxFailuresPerIp: o.maxFailuresPerIp ?? 50, ipWindowMs: o.ipWindowMs ?? 15 * 60_000, maxTracked: o.maxTracked ?? 100_000 };
    if (this.o.maxFailures < 1) throw new LoginFlowError('maxFailures must be at least 1');
  }

  private static key(name: string): string {
    return name.normalize('NFKC').trim().toLowerCase().slice(0, 320);
  }

  /** Whether an attempt may be made now. Does not count anything. */
  check(name: string, ip: string | undefined, now: number): Gate {
    const r = this.users.get(BruteForce.key(name));
    if (r?.permanent) return { allowed: false, reason: 'permanent' };
    if (r && r.lockedUntil > now) return { allowed: false, reason: 'temporary', retryAfterMs: r.lockedUntil - now };
    if (ip) {
      const w = this.ips.get(ip);
      if (w && now - w.start < this.o.ipWindowMs && w.n >= this.o.maxFailuresPerIp) return { allowed: false, reason: 'ip-throttle', retryAfterMs: this.o.ipWindowMs - (now - w.start) };
    }
    return { allowed: true };
  }

  /** Counts a failed attempt (for a real or an unknown name alike) and returns the state after it. */
  recordFailure(name: string, ip: string | undefined, now: number): Gate {
    const k = BruteForce.key(name);
    let r = this.users.get(k);
    if (r && now - r.lastFailure > this.o.resetAfterMs && !r.permanent && r.lockedUntil <= now) r = undefined;
    const quick = !!r && this.o.quickFailureMs > 0 && now - r.lastFailure < this.o.quickFailureMs;
    r ??= { failures: 0, lockouts: r ? 0 : 0, lastFailure: now, lockedUntil: 0, permanent: false };
    r.failures++;
    r.lastFailure = now;
    if (r.failures >= this.o.maxFailures || quick) {
      r.lockouts++;
      r.failures = 0;
      if (this.o.permanentAfterLockouts > 0 && r.lockouts >= this.o.permanentAfterLockouts) r.permanent = true;
      else r.lockedUntil = now + Math.min(this.o.maxWaitMs, this.o.baseWaitMs * 2 ** (r.lockouts - 1));
    }
    this.users.delete(k);
    this.users.set(k, r);
    if (ip) {
      const w = this.ips.get(ip);
      if (!w || now - w.start >= this.o.ipWindowMs) this.ips.set(ip, { start: now, n: 1 });
      else w.n++;
    }
    for (const m of [this.users, this.ips] as const) while (m.size > this.o.maxTracked) m.delete(m.keys().next().value as string);
    return this.check(name, ip, now);
  }

  /** A successful sign-in clears the name's failures (not its lockout history if it is permanently locked). */
  recordSuccess(name: string): void {
    const k = BruteForce.key(name);
    const r = this.users.get(k);
    if (r && !r.permanent) this.users.delete(k);
  }

  /** An administrator's unlock: clears everything for the name. */
  unlock(name: string): void {
    this.users.delete(BruteForce.key(name));
  }

  get tracked(): number {
    return this.users.size + this.ips.size;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Required actions

export interface ActionPolicy {
  /** Passwords older than this must be changed. */
  readonly passwordMaxAgeMs?: number;
  readonly requireVerifiedEmail?: boolean;
  /** The terms version everyone must have accepted. */
  readonly termsVersion?: number;
  /** Order in which actions are presented; others follow in the order queued. */
  readonly order?: readonly string[];
}

export const DEFAULT_ACTION_ORDER: readonly string[] = ['UPDATE_PASSWORD', 'VERIFY_EMAIL', 'CONFIGURE_OTP', 'CONFIGURE_WEBAUTHN', 'ACCEPT_TERMS'];

/** What a person still has to do after signing in: queued actions plus what the policy demands, without duplicates, in order. */
export function requiredActionsFor(user: UserState, policy: ActionPolicy, now: number): string[] {
  const set = new Set(user.requiredActions ?? []);
  if (policy.passwordMaxAgeMs !== undefined && user.passwordChangedAt !== undefined && now - user.passwordChangedAt > policy.passwordMaxAgeMs) set.add('UPDATE_PASSWORD');
  if (policy.requireVerifiedEmail && user.emailVerified === false) set.add('VERIFY_EMAIL');
  if (policy.termsVersion !== undefined && (user.termsAccepted ?? 0) < policy.termsVersion) set.add('ACCEPT_TERMS');
  const order = policy.order ?? DEFAULT_ACTION_ORDER;
  return [...set].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Validation

/** Problems with a flow definition: unknown authenticators, nothing that proves identity, empty or conditionless sub-flows, duplicates, depth. */
export function validateFlow(flow: SubFlow, registry: ReadonlyMap<string, Authenticator>): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const walk = (f: SubFlow, depth: number): void => {
    if (depth > 5) problems.push(`${f.id}: nested more than 5 levels deep`);
    if (ids.has(f.id)) problems.push(`the id "${f.id}" is used twice`);
    ids.add(f.id);
    if (!f.executions.length) problems.push(`${f.id}: a flow cannot be empty`);
    if (f.requirement === 'CONDITIONAL' && !f.conditions?.length) problems.push(`${f.id}: a CONDITIONAL sub-flow needs at least one condition`);
    if (f.requirement !== 'CONDITIONAL' && f.conditions?.length) problems.push(`${f.id}: conditions only apply to a CONDITIONAL sub-flow`);
    const live = f.executions.filter((e) => e.requirement !== 'DISABLED');
    if (live.some((e) => e.requirement === 'REQUIRED') && live.some((e) => e.requirement === 'ALTERNATIVE')) problems.push(`${f.id}: ALTERNATIVE steps next to REQUIRED ones are never used`);
    for (const e of f.executions) {
      if (isSubFlow(e)) walk(e, depth + 1);
      else {
        if (ids.has(e.id)) problems.push(`the id "${e.id}" is used twice`);
        ids.add(e.id);
        if (!registry.has(e.authenticator)) problems.push(`${e.id}: no authenticator called "${e.authenticator}"`);
        if (e.requirement === 'CONDITIONAL') problems.push(`${e.id}: only a sub-flow can be CONDITIONAL`);
      }
    }
  };
  walk(flow, 1);
  // Can the flow complete with no credential checked? Evaluate with every optional piece off.
  const proves = (n: Execution | SubFlow): boolean => {
    if (n.requirement === 'DISABLED') return false;
    if (isSubFlow(n)) return n.requirement === 'CONDITIONAL' ? false : levelProves(n);
    const k = registry.get(n.authenticator)?.kind;
    return k === 'credential' || k === 'passwordless' || k === 'session' || k === 'second-factor';
  };
  const levelProves = (f: SubFlow): boolean => {
    const live = f.executions.filter((e) => e.requirement !== 'DISABLED');
    const req = live.filter((e) => e.requirement === 'REQUIRED');
    if (req.length) return req.some(proves);
    const alts = live.filter((e) => e.requirement === 'ALTERNATIVE');
    return alts.length > 0 && alts.every(proves);
  };
  if (!levelProves(flow)) problems.push(`${flow.id}: the flow can complete without checking a credential`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The run

export type Step =
  | { readonly type: 'challenge'; readonly execution: string; readonly authenticator: string; readonly alternatives: readonly { readonly execution: string; readonly authenticator: string }[]; readonly error?: 'invalid_credentials' }
  | { readonly type: 'required-action'; readonly action: string }
  | { readonly type: 'complete'; readonly user: UserState | null; readonly level: number; readonly amr: readonly string[] }
  | { readonly type: 'failed'; readonly code: 'invalid_credentials' | 'locked' | 'throttled' | 'no_authenticator' | 'flow_error'; readonly retryAfterMs?: number };

export interface FlowDeps {
  readonly registry: ReadonlyMap<string, Authenticator>;
  /** Finds the account for what the person typed; null when there is none (the flow carries on as if there were). */
  readonly lookupUser: (username: string) => UserState | null;
  readonly now: () => number;
  readonly bruteForce?: BruteForce;
  readonly actions?: ActionPolicy;
  /** Most wrong answers allowed inside one flow run before it ends. Default 10. */
  readonly maxAttempts?: number;
  /**
   * Offer only the alternatives this person has set up. Friendlier, but it shows which authenticators an account has, and
   * so that the account exists. Default false: every alternative is offered and the unset-up one simply fails.
   */
  readonly hideUnconfigured?: boolean;
  /** Network membership for network conditions. */
  readonly inCidr?: (ip: string, cidr: string) => boolean;
}

type Resolution = { readonly kind: 'satisfied' } | { readonly kind: 'pending'; readonly candidates: readonly Execution[] } | { readonly kind: 'failed'; readonly code: 'no_authenticator' };

export class FlowRun {
  readonly ctx: FlowContext;
  private readonly flow: SubFlow;
  private readonly d: FlowDeps;
  private readonly done = new Set<string>();
  private readonly choice = new Map<string, string>();
  private readonly amrList: string[] = [];
  private level = 0;
  private attempts = 0;
  private queued: string[] | null = null;
  private actionsComputed = false;
  private pendingActions: string[] = [];
  private lastError: 'invalid_credentials' | undefined;
  private ended: Step | null = null;

  constructor(flow: SubFlow, deps: FlowDeps, init: { ip?: string; client?: string; requestedLevel?: number; session?: ExistingSession }) {
    const problems = validateFlow(flow, deps.registry);
    if (problems.length) throw new LoginFlowError(`the flow is not valid: ${problems.join('; ')}`);
    this.flow = flow;
    this.d = deps;
    this.ctx = { user: null, requestedLevel: init.requestedLevel ?? 1, ...(init.ip ? { ip: init.ip } : {}), ...(init.client ? { client: init.client } : {}), ...(init.session ? { session: init.session } : {}) };
    if (init.session) {
      this.level = init.session.level;
      this.ctx.user = deps.lookupUser(init.session.user);
      this.ctx.username = init.session.user;
      this.amrList.push(...init.session.amr);
    }
  }

  private cond(c: Condition): boolean {
    const u = this.ctx.user;
    switch (c.type) {
      case 'role':
        return !!u?.roles?.includes(c.role);
      case 'attribute':
        return u?.attributes?.[c.name] === c.value;
      case 'network': {
        const hit = !!this.ctx.ip && !!this.d.inCidr && c.cidrs.some((n) => this.d.inCidr!(this.ctx.ip!, n));
        return c.negate ? !hit : hit;
      }
      case 'requested-level':
        return this.ctx.requestedLevel >= c.atLeast;
      case 'session-level-below':
        return this.level < c.level;
      case 'configured': {
        const has = !!u?.configured?.includes(c.authenticator);
        return c.negate ? !has : has;
      }
      case 'custom':
        return c.test(this.ctx);
    }
  }

  private auth(e: Execution): Authenticator {
    return this.d.registry.get(e.authenticator)!;
  }

  private item(n: Execution | SubFlow): Resolution {
    if (n.requirement === 'DISABLED') return { kind: 'satisfied' };
    if (isSubFlow(n)) {
      if (n.requirement === 'CONDITIONAL' && !(n.conditions ?? []).every((c) => this.cond(c))) return { kind: 'satisfied' };
      return this.level_(n);
    }
    if (this.done.has(n.id)) return { kind: 'satisfied' };
    const a = this.auth(n);
    const lvl = a.level ?? (a.kind === 'second-factor' ? 2 : 1);
    if (a.kind === 'identify' && this.ctx.username !== undefined) return { kind: 'satisfied' };
    if (a.kind !== 'identify' && a.kind !== 'info' && a.kind !== 'session' && this.level >= lvl) return { kind: 'satisfied' };
    if (a.auto) {
      const r = a.auto(this.ctx);
      if (r?.ok) {
        this.accept(n, a, r);
        return { kind: 'satisfied' };
      }
    }
    // A session authenticator never asks the person for anything: when it cannot vouch, it simply steps aside.
    if (a.kind === 'session') return { kind: 'pending', candidates: [] };
    // For a name with no account the answer is always "set up", so nothing offered reveals that it does not exist.
    const real = this.ctx.user === null || !a.configuredFor ? true : a.configuredFor(this.ctx.user);
    if (!real) {
      if (n.requirement === 'REQUIRED') {
        if (a.setupAction) {
          (this.queued ??= []).push(a.setupAction);
          this.done.add(n.id);
          return { kind: 'satisfied' };
        }
        return { kind: 'failed', code: 'no_authenticator' };
      }
      if (this.d.hideUnconfigured) return { kind: 'pending', candidates: [] };
    }
    return { kind: 'pending', candidates: [n] };
  }

  private level_(f: SubFlow): Resolution {
    const live = f.executions.filter((e) => e.requirement !== 'DISABLED');
    const required = live.filter((e) => e.requirement === 'REQUIRED' || e.requirement === 'CONDITIONAL');
    if (required.length) {
      for (const n of required) {
        const r = this.item(n);
        if (r.kind !== 'satisfied') return r.kind === 'pending' && !r.candidates.length ? { kind: 'failed', code: 'no_authenticator' } : r;
      }
      return { kind: 'satisfied' };
    }
    const alts = live.filter((e) => e.requirement === 'ALTERNATIVE');
    if (!alts.length) return { kind: 'satisfied' };
    const chosen = this.choice.get(f.id);
    const pool = chosen ? alts.filter((a) => a.id === chosen) : alts;
    const candidates: Execution[] = [];
    for (const a of pool) {
      const r = this.item(a);
      if (r.kind === 'satisfied') return r;
      if (r.kind === 'pending') candidates.push(...r.candidates);
    }
    return candidates.length ? { kind: 'pending', candidates } : { kind: 'failed', code: 'no_authenticator' };
  }

  private accept(e: Execution, a: Authenticator, r: Extract<VerifyResult, { ok: true }>): void {
    this.done.add(e.id);
    if (r.user !== undefined) {
      this.ctx.username = r.user;
      this.ctx.user = this.d.lookupUser(r.user);
    }
    if (a.kind !== 'identify' && a.kind !== 'info') {
      this.level = Math.max(this.level, a.level ?? (a.kind === 'second-factor' ? 2 : 1));
      this.amrList.push(r.amr ?? a.name);
    }
  }

  /** What to show next. */
  current(): Step {
    if (this.ended) return this.ended;
    if (this.ctx.username !== undefined && this.d.bruteForce) {
      const g = this.d.bruteForce.check(this.ctx.username, this.ctx.ip, this.d.now());
      if (!g.allowed) return (this.ended = { type: 'failed', code: g.reason === 'ip-throttle' ? 'throttled' : 'locked', ...(g.retryAfterMs !== undefined ? { retryAfterMs: g.retryAfterMs } : {}) });
    }
    const r = this.level_(this.flow);
    if (r.kind === 'failed') return (this.ended = { type: 'failed', code: r.code });
    if (r.kind === 'pending') {
      const first = r.candidates[0]!;
      return { type: 'challenge', execution: first.id, authenticator: first.authenticator, alternatives: r.candidates.map((c) => ({ execution: c.id, authenticator: c.authenticator })), ...(this.lastError ? { error: this.lastError } : {}) };
    }
    if (!this.actionsComputed) {
      this.actionsComputed = true;
      const queued = this.queued ?? [];
      this.pendingActions = this.ctx.user ? requiredActionsFor({ ...this.ctx.user, requiredActions: [...(this.ctx.user.requiredActions ?? []), ...queued] }, this.d.actions ?? {}, this.d.now()) : [...queued];
    }
    if (this.pendingActions.length) return { type: 'required-action', action: this.pendingActions[0]! };
    return (this.ended = { type: 'complete', user: this.ctx.user, level: this.level, amr: [...this.amrList] });
  }

  /** Gives the engine what the person submitted for the current challenge (or the alternative they picked). */
  submit(input: unknown, execution?: string): Step {
    const step = this.current();
    if (step.type !== 'challenge') throw new LoginFlowError(`there is nothing to submit: the flow is at "${step.type}"`);
    const pick = execution ?? step.execution;
    if (!step.alternatives.some((a) => a.execution === pick)) throw new LoginFlowError(`"${pick}" is not one of the choices offered now`);
    const e = this.findExecution(this.flow, pick)!;
    const a = this.auth(e);
    this.lastError = undefined;
    const typed = a.kind === 'identify' ? this.typedName(input) : undefined;
    if (a.kind === 'identify' && typed === undefined) {
      this.attempts++;
      if (this.attempts >= (this.d.maxAttempts ?? 10)) return (this.ended = { type: 'failed', code: 'invalid_credentials' });
      this.lastError = 'invalid_credentials';
      return this.current();
    }
    if (!a.verify && a.kind !== 'identify') throw new LoginFlowError(`authenticator "${a.name}" cannot verify input`);
    if (a.kind !== 'identify' && this.ctx.username !== undefined && this.d.bruteForce) {
      const g = this.d.bruteForce.check(this.ctx.username, this.ctx.ip, this.d.now());
      if (!g.allowed) return this.current();
    }
    let result: VerifyResult;
    try {
      result = a.verify ? a.verify(input, this.ctx) : { ok: true, ...(typed !== undefined ? { user: typed } : {}) };
    } catch {
      result = { ok: false, code: 'error' };
    }
    if (result.ok) {
      const resolved = a.kind === 'identify' && typed !== undefined ? { ...result, user: result.user ?? typed } : result;
      this.accept(e, a, resolved);
      // Remember which alternative path was taken, at each level that offered a choice.
      this.rememberChoice(this.flow, pick);
      if (a.kind !== 'identify' && this.ctx.username !== undefined) this.d.bruteForce?.recordSuccess(this.ctx.username);
      return this.current();
    }
    if (a.kind === 'identify') {
      // A name that does not verify is still just a name: carry on, so the next step cannot reveal whether it exists.
      this.accept(e, a, { ok: true, user: typed ?? '' });
      return this.current();
    }
    this.attempts++;
    if (this.ctx.username !== undefined) this.d.bruteForce?.recordFailure(this.ctx.username, this.ctx.ip, this.d.now());
    if (this.attempts >= (this.d.maxAttempts ?? 10)) return (this.ended = { type: 'failed', code: 'invalid_credentials' });
    this.lastError = 'invalid_credentials';
    return this.current();
  }

  private typedName(input: unknown): string | undefined {
    const v = typeof input === 'string' ? input : typeof input === 'object' && input !== null && 'username' in input ? (input as { username: unknown }).username : undefined;
    return typeof v === 'string' && v.trim() ? v.normalize('NFKC').trim().toLowerCase().slice(0, 320) : undefined;
  }

  private findExecution(f: SubFlow, id: string): Execution | undefined {
    for (const n of f.executions) {
      if (isSubFlow(n)) {
        const x = this.findExecution(n, id);
        if (x) return x;
      } else if (n.id === id) return n;
    }
    return undefined;
  }

  /** Marks the path taken: at every level where `id` sits under an ALTERNATIVE, only that alternative is considered from now on. */
  private rememberChoice(f: SubFlow, id: string): boolean {
    let found = false;
    for (const n of f.executions) {
      const here = isSubFlow(n) ? this.rememberChoice(n, id) : n.id === id;
      if (here) {
        found = true;
        if (n.requirement === 'ALTERNATIVE') this.choice.set(f.id, n.id);
      }
    }
    return found;
  }

  /** The person has done the action (changed the password, set up the code, accepted the terms). */
  completeAction(action: string): Step {
    const step = this.current();
    if (step.type !== 'required-action' || step.action !== action) throw new LoginFlowError(`"${action}" is not the action asked for now`);
    this.pendingActions.shift();
    return this.current();
  }
}
