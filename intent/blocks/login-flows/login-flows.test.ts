import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32, checkCode, hotp, unbase32 } from '../sessions/index.ts';
import { BruteForce, FlowRun, LoginFlowError, requiredActionsFor, validateFlow } from './index.ts';
import type { Authenticator, Condition, FlowDeps, Step, SubFlow, UserState } from './index.ts';

const NOW = 1_800_000_000_000;
const SECRET = base32(Uint8Array.from({ length: 20 }, (_, i) => i + 1));
const code = (at = NOW) => hotp(unbase32(SECRET), Math.floor(at / 30_000));
const PASSWORDS: Record<string, string> = { ana: 'correct horse', bo: 'battery staple', cy: 'pw' };
const USERS: Record<string, UserState> = {
  ana: { id: 'ana', roles: ['admin'], configured: ['otp'], emailVerified: true },
  bo: { id: 'bo', roles: [], configured: ['webauthn'], emailVerified: true },
  cy: { id: 'cy', roles: [], configured: [], emailVerified: false, passwordChangedAt: NOW - 100 * 86_400_000, termsAccepted: 1 },
};

const registry = (): Map<string, Authenticator> =>
  new Map<string, Authenticator>([
    ['username', { name: 'username', kind: 'identify' }],
    ['password', { name: 'password', kind: 'credential', verify: (input, ctx) => (ctx.user && typeof input === 'object' && input !== null && (input as { password?: string }).password === PASSWORDS[ctx.username ?? ''] ? { ok: true } : { ok: false, code: 'bad' }) }],
    ['otp', { name: 'otp', kind: 'second-factor', level: 2, configuredFor: (u) => !!u?.configured?.includes('otp'), setupAction: 'CONFIGURE_OTP', verify: (input) => (typeof input === 'string' && checkCode(SECRET, input, NOW) !== null ? { ok: true } : { ok: false }) }],
    ['passkey', { name: 'passkey', kind: 'passwordless', level: 2, configuredFor: (u) => !!u?.configured?.includes('webauthn'), verify: (input, ctx) => (input === `signed-by-${ctx.username}` && ctx.user?.configured?.includes('webauthn') ? { ok: true, user: ctx.username ?? '' } : { ok: false }) }],
    ['cookie', { name: 'cookie', kind: 'session', auto: (ctx) => (ctx.session && ctx.session.level >= ctx.requestedLevel ? { ok: true, user: ctx.session.user, amr: 'cookie' } : null) }],
  ]);

const browser: SubFlow = {
  id: 'browser',
  requirement: 'REQUIRED',
  executions: [
    { id: 'cookie', authenticator: 'cookie', requirement: 'ALTERNATIVE' },
    {
      id: 'forms',
      requirement: 'ALTERNATIVE',
      executions: [
        { id: 'user', authenticator: 'username', requirement: 'REQUIRED' },
        { id: 'pw', authenticator: 'password', requirement: 'REQUIRED' },
        { id: 'otp-if-set-up', requirement: 'CONDITIONAL', conditions: [{ type: 'configured', authenticator: 'otp' }], executions: [{ id: 'otp1', authenticator: 'otp', requirement: 'REQUIRED' }] },
        { id: 'step-up', requirement: 'CONDITIONAL', conditions: [{ type: 'requested-level', atLeast: 2 }], executions: [{ id: 'otp2', authenticator: 'otp', requirement: 'REQUIRED' }] },
      ],
    },
  ],
};

const deps = (over: Partial<FlowDeps> = {}): FlowDeps => ({ registry: registry(), lookupUser: (n) => USERS[n] ?? null, now: () => NOW, ...over });
const run = (flow: SubFlow = browser, init: ConstructorParameters<typeof FlowRun>[2] = {}, d: Partial<FlowDeps> = {}) => new FlowRun(flow, deps(d), init);
const kind = (s: Step) => (s.type === 'challenge' ? `challenge:${s.authenticator}` : s.type === 'required-action' ? `action:${s.action}` : s.type === 'failed' ? `failed:${s.code}` : s.type);

test('a flow with sound steps validates; each kind of mistake is named', () => {
  const reg = registry();
  assert.deepEqual(validateFlow(browser, reg), []);
  const bad = (f: SubFlow, re: RegExp) => assert.ok(validateFlow(f, reg).some((p) => re.test(p)), `${re}: ${validateFlow(f, reg).join(' | ')}`);
  const pw = { id: 'pw', authenticator: 'password', requirement: 'REQUIRED' } as const;
  bad({ id: 'f', requirement: 'REQUIRED', executions: [{ id: 'x', authenticator: 'nope', requirement: 'REQUIRED' }, pw] }, /no authenticator called "nope"/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [] }, /cannot be empty/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [pw, { id: 's', requirement: 'CONDITIONAL', executions: [{ id: 'o', authenticator: 'otp', requirement: 'REQUIRED' }] }] }, /needs at least one condition/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [pw, { id: 's', requirement: 'REQUIRED', conditions: [{ type: 'role', role: 'x' }], executions: [{ id: 'o', authenticator: 'otp', requirement: 'REQUIRED' }] }] }, /only apply to a CONDITIONAL/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [pw, { id: 'a', authenticator: 'passkey', requirement: 'ALTERNATIVE' }] }, /ALTERNATIVE steps next to REQUIRED/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [pw, { ...pw }] }, /used twice/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [{ id: 'u', authenticator: 'username', requirement: 'REQUIRED' }] }, /without checking a credential/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [{ id: 'u', authenticator: 'username', requirement: 'REQUIRED' }, { ...pw, requirement: 'DISABLED' }] }, /without checking a credential/);
  bad({ id: 'f', requirement: 'REQUIRED', executions: [{ ...pw, requirement: 'CONDITIONAL' }] }, /only a sub-flow can be CONDITIONAL/);
  let deep: SubFlow = { id: 'd6', requirement: 'REQUIRED', executions: [pw] };
  for (let i = 5; i >= 1; i--) deep = { id: `d${i}`, requirement: 'REQUIRED', executions: [deep] };
  bad(deep, /more than 5 levels/);
  assert.throws(() => run({ id: 'f', requirement: 'REQUIRED', executions: [] }), /flow is not valid/);
});

test('sign in with a name and password: the steps, the assurance level and how it was proved', () => {
  const r = run();
  assert.equal(kind(r.current()), 'challenge:cookie'.replace('cookie', 'username'), 'the cookie declines, so the form starts with the name');
  assert.equal(kind(r.submit('bo')), 'challenge:password');
  assert.equal(kind(r.submit({ password: 'battery staple' })), 'complete');
  const done = r.current();
  assert.ok(done.type === 'complete');
  assert.deepEqual([done.user?.id, done.level, done.amr], ['bo', 1, ['password']]);
});

test('a wrong password and a name with no account fail with exactly the same answer', () => {
  const wrong = run();
  wrong.submit('bo');
  const w = wrong.submit({ password: 'nope' });
  const ghost = run();
  ghost.submit('nobody-here');
  const g = ghost.submit({ password: 'nope' });
  assert.deepEqual(w, g);
  assert.ok(w.type === 'challenge' && w.error === 'invalid_credentials' && w.authenticator === 'password');
  assert.equal(ghost.ctx.user, null);
  const g2 = run();
  g2.submit('nobody-here');
  assert.equal(kind(g2.current()), 'challenge:password', 'the ghost is asked for a password like anyone else');
});

test('repeated failures lock the name out, for real and unknown names alike, even against the right password', () => {
  const bf = new BruteForce({ maxFailures: 3, baseWaitMs: 60_000 });
  const attempt = (name: string, pw: string) => { const r = run(browser, { ip: '198.51.100.1' }, { bruteForce: bf }); r.submit(name); return r.submit({ password: pw }); };
  for (const name of ['bo', 'ghost']) {
    assert.equal(kind(attempt(name, 'x')), 'challenge:password');
    assert.equal(kind(attempt(name, 'x')), 'challenge:password');
    const locked = attempt(name, 'x');
    assert.deepEqual([locked.type, (locked as { code?: string }).code], ['failed', 'locked'], name);
    assert.equal((locked as { retryAfterMs?: number }).retryAfterMs, 60_000);
  }
  const right = run(browser, {}, { bruteForce: bf });
  right.submit('bo');
  assert.equal(kind(right.current()), 'failed:locked', 'the correct password is not even asked for while locked');
  assert.equal(kind(right.current()), 'failed:locked');
});

test('a second factor is asked for when the person has set one up, and checked against a real TOTP', () => {
  const r = run();
  r.submit('ana');
  assert.equal(kind(r.submit({ password: 'correct horse' })), 'challenge:otp');
  const bad = r.submit('000000');
  assert.ok(bad.type === 'challenge' && bad.error === 'invalid_credentials');
  const done = r.submit(code());
  assert.ok(done.type === 'complete');
  assert.deepEqual([done.level, done.amr], [2, ['password', 'otp']]);
  const noOtp = run();
  noOtp.submit('bo');
  assert.equal(kind(noOtp.submit({ password: 'battery staple' })), 'complete', 'bo has no second factor, so the conditional sub-flow does not run');
});

test('step-up: a session at level 1 that asks for level 2 is asked only for the stronger factor', () => {
  const session = { user: 'ana', level: 1, amr: ['password'] };
  const r = run(browser, { session, requestedLevel: 2 });
  assert.equal(kind(r.current()), 'challenge:otp', 'cookie declines (level too low), name and password are already satisfied by the session');
  const done = r.submit(code());
  assert.ok(done.type === 'complete');
  assert.deepEqual([done.level, done.amr], [2, ['password', 'otp']]);
  const same = run(browser, { session: { user: 'ana', level: 2, amr: ['password', 'otp'] }, requestedLevel: 2 });
  const s = same.current();
  assert.ok(s.type === 'complete', 'a session that is strong enough passes straight through');
  assert.equal(s.user?.id, 'ana');
  const low = run(browser, { session, requestedLevel: 1 });
  assert.equal(kind(low.current()), 'complete', 'asking for level 1 needs nothing more');
});

const choice: SubFlow = {
  id: 'login',
  requirement: 'REQUIRED',
  executions: [
    { id: 'user', authenticator: 'username', requirement: 'REQUIRED' },
    {
      id: 'method',
      requirement: 'REQUIRED',
      executions: [
        { id: 'with-password', requirement: 'ALTERNATIVE', executions: [{ id: 'pw', authenticator: 'password', requirement: 'REQUIRED' }] },
        { id: 'with-passkey', authenticator: 'passkey', requirement: 'ALTERNATIVE' },
      ],
    },
  ],
};

test('alternatives are all offered, the person picks one, and the path taken is the one that must be finished', () => {
  const r = run(choice);
  assert.equal(kind(r.submit('bo')), 'challenge:password');
  const s = r.current();
  assert.ok(s.type === 'challenge');
  assert.deepEqual(s.alternatives.map((a) => a.authenticator), ['password', 'passkey']);
  assert.ok(r.submit('signed-by-bo', 'with-passkey').type === 'complete');
  const done = r.current();
  assert.ok(done.type === 'complete' && done.amr.join() === 'passkey' && done.level === 2);
  const viaPw = run(choice);
  viaPw.submit('ana');
  viaPw.submit({ password: 'wrong' }, 'pw');
  assert.ok(viaPw.submit({ password: 'correct horse' }, 'pw').type === 'complete');
  assert.throws(() => run(choice).submit('x', 'nonsense'), /nothing to submit|not one of the choices/);
  const r2 = run(choice);
  r2.submit('bo');
  assert.throws(() => r2.submit({}, 'otp-nowhere'), /not one of the choices/);
});

test('offering alternatives does not reveal accounts, unless you ask for the friendlier but leakier behaviour', () => {
  const offered = (name: string, d: Partial<FlowDeps> = {}) => { const r = run(choice, {}, d); r.submit(name); const s = r.current(); return s.type === 'challenge' ? s.alternatives.map((a) => a.authenticator) : []; };
  assert.deepEqual(offered('ana'), ['password', 'passkey'], 'ana has no passkey, and still sees the option');
  assert.deepEqual(offered('ghost'), offered('ana'));
  assert.deepEqual(offered('bo'), offered('ghost'));
  assert.deepEqual(offered('ana', { hideUnconfigured: true }), ['password'], 'hidden: only what ana has set up');
  assert.deepEqual(offered('ghost', { hideUnconfigured: true }), ['password', 'passkey'], 'which is exactly how an unknown name differs');
  const r = run(choice);
  r.submit('ana');
  assert.equal(r.submit('signed-by-ana', 'with-passkey').type, 'challenge', 'choosing what she has not set up simply fails');
});

test('required actions come after the flow, one at a time and in order: expired password, email, terms', () => {
  const r = run(browser, {}, { actions: { passwordMaxAgeMs: 90 * 86_400_000, requireVerifiedEmail: true, termsVersion: 2 } });
  r.submit('cy');
  assert.equal(kind(r.submit({ password: 'pw' })), 'action:UPDATE_PASSWORD');
  assert.equal(kind(r.current()), 'action:UPDATE_PASSWORD', 'asking again does not skip it');
  assert.throws(() => r.completeAction('ACCEPT_TERMS'), /not the action asked for now/);
  assert.equal(kind(r.completeAction('UPDATE_PASSWORD')), 'action:VERIFY_EMAIL');
  assert.equal(kind(r.completeAction('VERIFY_EMAIL')), 'action:ACCEPT_TERMS');
  const done = r.completeAction('ACCEPT_TERMS');
  assert.ok(done.type === 'complete' && done.user?.id === 'cy');
  assert.throws(() => r.completeAction('X'), /not the action asked for/);
  const plain = run(browser, {}, { actions: {} });
  plain.submit('bo');
  assert.equal(kind(plain.submit({ password: 'battery staple' })), 'complete', 'no policy, no actions');
});

test('a required second factor the person has not set up queues the set-up action instead of locking them out', () => {
  const flow: SubFlow = { id: 'f', requirement: 'REQUIRED', executions: [{ id: 'u', authenticator: 'username', requirement: 'REQUIRED' }, { id: 'p', authenticator: 'password', requirement: 'REQUIRED' }, { id: 'o', authenticator: 'otp', requirement: 'REQUIRED' }] };
  const r = run(flow);
  r.submit('cy');
  assert.equal(kind(r.submit({ password: 'pw' })), 'action:CONFIGURE_OTP');
  assert.equal(kind(r.completeAction('CONFIGURE_OTP')), 'complete');
  const noSetup = new Map(registry());
  noSetup.set('otp', { ...noSetup.get('otp')!, setupAction: undefined as never });
  const strict = new FlowRun(flow, deps({ registry: noSetup }), {});
  strict.submit('cy');
  assert.equal(kind(strict.submit({ password: 'pw' })), 'failed:no_authenticator');
});

test('conditions: role, attribute, network, configured, negation and your own test', () => {
  const sub = (cond: readonly Condition[]): SubFlow => ({ id: 'f', requirement: 'REQUIRED', executions: [{ id: 'u', authenticator: 'username', requirement: 'REQUIRED' }, { id: 'p', authenticator: 'password', requirement: 'REQUIRED' }, { id: 'c', requirement: 'CONDITIONAL', conditions: cond, executions: [{ id: 'o', authenticator: 'otp', requirement: 'REQUIRED' }] }] });
  const asks = (cond: readonly Condition[], name: string, pw: string, init: ConstructorParameters<typeof FlowRun>[2] = {}) => { const r = run(sub(cond), init, { inCidr: (ip, c) => c === '10.0.0.0/8' && ip.startsWith('10.') }); r.submit(name); return kind(r.submit({ password: pw })) === 'challenge:otp' || kind(r.current()) === 'action:CONFIGURE_OTP'; };
  assert.equal(asks([{ type: 'role', role: 'admin' }], 'ana', 'correct horse'), true);
  assert.equal(asks([{ type: 'role', role: 'admin' }], 'bo', 'battery staple'), false);
  assert.equal(asks([{ type: 'network', cidrs: ['10.0.0.0/8'], negate: true }], 'bo', 'battery staple', { ip: '198.51.100.9' }), true, 'outside the office');
  assert.equal(asks([{ type: 'network', cidrs: ['10.0.0.0/8'], negate: true }], 'bo', 'battery staple', { ip: '10.1.2.3' }), false);
  assert.equal(asks([{ type: 'network', cidrs: ['10.0.0.0/8'] }], 'bo', 'battery staple'), false, 'no address, no match');
  assert.equal(asks([{ type: 'configured', authenticator: 'otp', negate: true }], 'bo', 'battery staple'), true);
  assert.equal(asks([{ type: 'custom', test: (c) => c.username === 'cy' }], 'cy', 'pw'), true);
  assert.equal(asks([{ type: 'role', role: 'admin' }, { type: 'custom', test: () => false }], 'ana', 'correct horse'), false, 'all conditions must hold');
  assert.equal(asks([{ type: 'attribute', name: 'dept', value: 'x' }], 'ana', 'correct horse'), false);
});

test('a run ends after too many wrong answers, and nothing can be submitted afterwards', () => {
  const r = run(browser, {}, { maxAttempts: 3 });
  r.submit('bo');
  r.submit({ password: 'a' });
  r.submit({ password: 'b' });
  const end = r.submit({ password: 'c' });
  assert.deepEqual([end.type, (end as { code?: string }).code], ['failed', 'invalid_credentials']);
  assert.throws(() => r.submit({ password: 'battery staple' }), /nothing to submit/);
  const blank = run(browser, {}, { maxAttempts: 2 });
  assert.ok(blank.submit('   ').type === 'challenge' && blank.current().type === 'challenge');
  blank.submit('');
  assert.equal(kind(blank.current()), 'failed:invalid_credentials');
});

test('one address trying many names is throttled whatever the names', () => {
  const bf = new BruteForce({ maxFailuresPerIp: 4, ipWindowMs: 60_000 });
  for (const n of ['a', 'b', 'c', 'd']) {
    const r = run(browser, { ip: '203.0.113.50' }, { bruteForce: bf });
    r.submit(n);
    r.submit({ password: 'x' });
  }
  const r = run(browser, { ip: '203.0.113.50' }, { bruteForce: bf });
  r.submit('e');
  const s = r.current();
  assert.ok(s.type === 'failed' && s.code === 'throttled' && s.retryAfterMs === 60_000);
  assert.equal(kind(run(browser, { ip: '203.0.113.51' }, { bruteForce: bf }).current()), 'challenge:username', 'other addresses are unaffected');
  const later = new BruteForce({ maxFailuresPerIp: 1, ipWindowMs: 1000 });
  later.recordFailure('x', '1.1.1.1', 0);
  assert.equal(later.check('y', '1.1.1.1', 500).allowed, false);
  assert.equal(later.check('y', '1.1.1.1', 1000).allowed, true, 'the window passes');
});

test('lockouts double with each strike up to a cap; permanent lockout waits for an administrator', () => {
  const bf = new BruteForce({ maxFailures: 2, baseWaitMs: 1000, maxWaitMs: 5000 });
  let t = 0;
  const strike = () => { bf.recordFailure('Ana', undefined, t); return bf.recordFailure('ana ', undefined, t); };
  assert.equal(strike().retryAfterMs, 1000);
  t += 1000;
  assert.equal(bf.check('ana', undefined, t).allowed, true, 'the wait is over');
  assert.equal(strike().retryAfterMs, 2000);
  t += 2000;
  assert.equal(strike().retryAfterMs, 4000);
  t += 4000;
  assert.equal(strike().retryAfterMs, 5000, 'capped');
  const perm = new BruteForce({ maxFailures: 1, baseWaitMs: 10, permanentAfterLockouts: 2 });
  perm.recordFailure('bo', undefined, 0);
  assert.equal(perm.check('bo', undefined, 100).allowed, true);
  const g = perm.recordFailure('bo', undefined, 100);
  assert.deepEqual([g.allowed, g.reason], [false, 'permanent']);
  assert.equal(perm.check('bo', undefined, 10 ** 12).allowed, false, 'time does not unlock it');
  perm.recordSuccess('bo');
  assert.equal(perm.check('bo', undefined, 10 ** 12).allowed, false, 'neither does a correct password');
  perm.unlock('BO');
  assert.equal(perm.check('bo', undefined, 0).allowed, true);
});

test('failures are forgotten after a quiet period, a success clears them, and quick repeats lock at once', () => {
  const bf = new BruteForce({ maxFailures: 3, resetAfterMs: 1000 });
  bf.recordFailure('a', undefined, 0);
  bf.recordFailure('a', undefined, 100);
  bf.recordFailure('a', undefined, 5000);
  assert.equal(bf.check('a', undefined, 5000).allowed, true, 'the first two had expired');
  bf.recordFailure('b', undefined, 0);
  bf.recordFailure('b', undefined, 10);
  bf.recordSuccess('b');
  bf.recordFailure('b', undefined, 20);
  assert.equal(bf.check('b', undefined, 20).allowed, true, 'a success cleared the count');
  const quick = new BruteForce({ maxFailures: 10, quickFailureMs: 1000, baseWaitMs: 500 });
  quick.recordFailure('q', undefined, 0);
  const g = quick.recordFailure('q', undefined, 200);
  assert.deepEqual([g.allowed, g.reason], [false, 'temporary']);
  assert.throws(() => new BruteForce({ maxFailures: 0 }), /at least 1/);
});

test('brute-force memory is bounded: the oldest names are forgotten first', () => {
  const bf = new BruteForce({ maxTracked: 100, maxFailures: 1, baseWaitMs: 10 ** 9 });
  for (let i = 0; i < 1000; i++) bf.recordFailure(`name${i}`, `10.0.${i % 250}.${i % 7}`, i);
  assert.ok(bf.tracked <= 200, `${bf.tracked} tracked`);
  assert.equal(bf.check('name999', undefined, 1000).allowed, false, 'recent lockouts are kept');
  assert.equal(bf.check('name0', undefined, 1000).allowed, true, 'ancient ones fell out');
});

test('required actions from policy: ordering, de-duplication, and nothing when nothing is due', () => {
  const u: UserState = { id: 'u', emailVerified: false, passwordChangedAt: 0, termsAccepted: 0, requiredActions: ['CONFIGURE_OTP', 'CUSTOM_SURVEY', 'UPDATE_PASSWORD'] };
  assert.deepEqual(requiredActionsFor(u, { passwordMaxAgeMs: 1000, requireVerifiedEmail: true, termsVersion: 1 }, 5000), ['UPDATE_PASSWORD', 'VERIFY_EMAIL', 'CONFIGURE_OTP', 'ACCEPT_TERMS', 'CUSTOM_SURVEY']);
  assert.deepEqual(requiredActionsFor({ id: 'v', emailVerified: true, passwordChangedAt: 4500, termsAccepted: 3 }, { passwordMaxAgeMs: 1000, requireVerifiedEmail: true, termsVersion: 2 }, 5000), []);
  assert.deepEqual(requiredActionsFor(u, { order: ['CUSTOM_SURVEY'] }, 0), ['CUSTOM_SURVEY', 'CONFIGURE_OTP', 'UPDATE_PASSWORD']);
  assert.equal(new FlowRun(browser, deps(), {}).ctx.requestedLevel, 1);
  assert.throws(() => new FlowRun(browser, deps(), {}).completeAction('X'), LoginFlowError);
});
