/**
 * Training modules that any cmi5 learning system can launch and track. A module (an assignable unit) is launched
 * with the cmi5 query parameters; its session sends the defined xAPI statements (launched, initialized, completed,
 * passed, failed, abandoned, waived, terminated) with the cmi5 context, and the rules the specification sets are
 * enforced within each session: initialized first and once, terminated last, passed or failed once and only with
 * a score that agrees with the mastery score, completed once; given the registration's history, passed and completed
 * once per registration and failed never after passed. Every statement that judges or completes carries the moveOn
 * category. Across sessions of one registration the learning record store holds the history; whether the learner
 * may move on follows the unit's moveOn setting over all of it.
 */
import { randomUUID } from 'node:crypto';

export const VERBS = {
  launched: 'http://adlnet.gov/expapi/verbs/launched',
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
  abandoned: 'https://w3id.org/xapi/adl/verbs/abandoned',
  waived: 'https://w3id.org/xapi/adl/verbs/waived',
  terminated: 'http://adlnet.gov/expapi/verbs/terminated',
} as const;

export type Verb = keyof typeof VERBS;

export const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
export const MOVEON_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/moveon';

export interface Unit {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly moveOn: 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';
  /** 0 to 1. */
  readonly masteryScore?: number;
}

export interface Actor {
  readonly objectType: 'Agent';
  readonly account: { readonly homePage: string; readonly name: string };
}

/** The launch URL the learning system opens. */
export function launchUrl(u: Unit, o: { endpoint: string; fetch: string; actor: Actor; registration: string }): string {
  const url = new URL(u.url);
  url.searchParams.set('endpoint', o.endpoint);
  url.searchParams.set('fetch', o.fetch);
  url.searchParams.set('actor', JSON.stringify(o.actor));
  url.searchParams.set('registration', o.registration);
  url.searchParams.set('activityId', u.id);
  return url.href;
}

export interface Statement {
  readonly id: string;
  readonly actor: Actor;
  readonly verb: { readonly id: string; readonly display: { readonly 'en-US': Verb } };
  readonly object: { readonly id: string; readonly objectType: 'Activity' };
  readonly result?: { readonly score?: { readonly scaled: number }; readonly success?: boolean; readonly completion?: boolean; readonly duration?: string };
  readonly context: { readonly registration: string; readonly contextActivities: { readonly category: readonly { id: string }[] }; readonly extensions: Readonly<Record<string, string>> };
  readonly timestamp: string;
}

/** ISO 8601 duration from milliseconds, as xAPI wants. */
export const duration = (ms: number) => `PT${Math.round(ms / 10) / 100}S`;

export class Session {
  readonly statements: Statement[] = [];
  private readonly u: Unit;
  private readonly actor: Actor;
  private readonly registration: string;
  private readonly sessionId = randomUUID();
  private readonly now: () => Date;
  private startedAt?: number;
  private readonly before: readonly Statement[];

  /** `history` is what the learning record store already holds; only this unit's statements in this registration count. */
  constructor(u: Unit, actor: Actor, registration: string, now: () => Date = () => new Date(), history: readonly Statement[] = []) {
    this.u = u;
    this.actor = actor;
    this.registration = registration;
    this.now = now;
    this.before = history.filter((s) => s.context.registration === registration && s.object.id === u.id);
  }

  private earlier(v: Verb) {
    return this.before.some((s) => s.verb.id === VERBS[v]);
  }

  private has(v: Verb) {
    return this.statements.some((s) => s.verb.display['en-US'] === v);
  }

  private send(v: Verb, result?: Statement['result'], moveOn = false): Statement {
    const s: Statement = {
      id: randomUUID(),
      actor: this.actor,
      verb: { id: VERBS[v], display: { 'en-US': v } },
      object: { id: this.u.id, objectType: 'Activity' },
      ...(result ? { result } : {}),
      context: { registration: this.registration, contextActivities: { category: [{ id: CMI5_CATEGORY }, ...(moveOn ? [{ id: MOVEON_CATEGORY }] : [])] }, extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': this.sessionId } },
      timestamp: this.now().toISOString(),
    };
    this.statements.push(s);
    return s;
  }

  private open() {
    if (!this.has('initialized')) throw new Error('send initialized first');
    if (this.has('terminated') || this.has('abandoned')) throw new Error('this session has ended');
  }

  initialized(): Statement {
    if (this.has('initialized')) throw new Error('initialized is sent once per session');
    this.startedAt = this.now().getTime();
    return this.send('initialized');
  }

  completed(): Statement {
    this.open();
    if (this.has('completed')) throw new Error('completed is sent once');
    if (this.earlier('completed')) throw new Error('completed is sent once per registration');
    return this.send('completed', { completion: true, duration: duration(this.now().getTime() - this.startedAt!) }, true);
  }

  judged(scaled: number): Statement {
    this.open();
    if (this.has('passed') || this.has('failed')) throw new Error('passed or failed is sent once');
    if (!(scaled >= 0 && scaled <= 1)) throw new Error('a scaled score is between 0 and 1');
    const pass = this.u.masteryScore === undefined ? true : scaled >= this.u.masteryScore;
    if (this.earlier('passed')) throw new Error(pass ? 'passed is sent once per registration' : 'failed is never sent after passed');
    return this.send(pass ? 'passed' : 'failed', { score: { scaled }, success: pass, duration: duration(this.now().getTime() - this.startedAt!) }, true);
  }

  terminated(): Statement {
    this.open();
    return this.send('terminated', { duration: duration(this.now().getTime() - this.startedAt!) });
  }

  /** What the learning system sends when a session ends without terminated. */
  abandoned(): Statement {
    if (this.has('terminated') || this.has('abandoned')) throw new Error('this session has ended');
    return this.send('abandoned', { duration: duration(this.now().getTime() - (this.startedAt ?? this.now().getTime())) });
  }
}

/** Whether the learner has satisfied the unit, from all their statements across sessions. */
export function satisfied(u: Unit, statements: readonly Statement[]): boolean {
  const did = (v: Verb) => statements.some((s) => s.object.id === u.id && s.verb.display['en-US'] === v);
  const passed = did('passed') || did('waived');
  const completed = did('completed') || did('waived');
  switch (u.moveOn) {
    case 'Passed':
      return passed;
    case 'Completed':
      return completed;
    case 'CompletedAndPassed':
      return passed && completed;
    case 'CompletedOrPassed':
      return passed || completed;
    case 'NotApplicable':
      return true;
  }
}
