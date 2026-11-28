import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Accounts, Refused } from './index.ts';

const setup = () => {
  let t = 0;
  const sent: { to: string; purpose: string; link: string }[] = [];
  const log: string[] = [];
  const announced: string[] = [];
  const revoked: string[] = [];
  const a = new Accounts(
    {
      send: async (to, purpose, link) => void sent.push({ to, purpose, link }),
      hash: async (pw) => `h:${pw}`,
      check: async (pw, h) => h === `h:${pw}`,
      record: async (actor, action, target) => void log.push(`${actor} ${action} ${target}`),
      announce: async (e) => void announced.push(e.kind),
      revokeAll: async (id) => void revoked.push(id),
    },
    { now: () => t, baseUrl: 'https://app.example.org/' },
  );
  const tokenOf = (i: number) => sent[i]!.link.split('/').pop()!;
  return { a, sent, log, announced, revoked, tokenOf, tick: (ms: number) => (t += ms) };
};

test('sign-up sends a confirmation; a second sign-up with the same email reveals nothing', async () => {
  const { a, sent, tokenOf } = setup();
  const ana = await a.signUp(' Ana@Example.org ', 'Ana', 'pw-ana-12345');
  assert.equal(ana.email, 'ana@example.org');
  assert.equal(sent[0]!.purpose, 'confirm');
  assert.equal(sent[0]!.link.startsWith('https://app.example.org/confirm/'), true);
  await a.confirm(tokenOf(0));
  assert.equal(ana.emailConfirmed, true);
  await assert.rejects(a.confirm(tokenOf(0)), /not valid/, 'a link works once');
  const again = await a.signUp('ana@example.org', 'Someone', 'other-pw-123');
  assert.notEqual(again.id, ana.id, 'the existing account is not handed to whoever typed its address');
  assert.equal(a.accounts.size, 1);
  assert.equal((await a.signIn('ANA@example.org', 'pw-ana-12345')).id, ana.id);
  await assert.rejects(a.signIn('ana@example.org', 'wrong'), Refused);
});

test('a reset link works once, before it expires, and the request never says whether the email exists', async () => {
  const { a, sent, tokenOf, tick } = setup();
  await a.signUp('ana@example.org', 'Ana', 'old-password-1');
  await a.requestReset('nobody@example.org');
  assert.equal(sent.length, 1, 'nothing sent for an unknown email, and nothing different returned');
  await a.requestReset('ana@example.org');
  tick(3_600_001);
  await assert.rejects(a.reset(tokenOf(1), 'new-password-1'), /expired/);
  await a.requestReset('ana@example.org');
  await a.reset(tokenOf(2), 'new-password-1');
  assert.ok(await a.signIn('ana@example.org', 'new-password-1'));
});

test('invitations bring people into an organisation with a role; they switch between orgs and roles', async () => {
  const { a, sent, tokenOf } = setup();
  const owner = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North campus', owner.id);
  const org2 = a.createOrg('South campus', owner.id);
  await a.invite(owner.id, org.id, 'ben@example.org', 'advisor');
  const ben = await a.accept(tokenOf(1), { name: 'Ben', password: 'ben-pass-123' });
  assert.equal(ben.state, 'active');
  assert.deepEqual(a.rolesIn(ben.id, org.id), ['advisor']);
  await assert.rejects(a.invite(ben.id, org.id, 'cy@example.org', 'admin'), /only an owner or admin/);
  await a.invite(owner.id, org2.id, 'ben@example.org', 'lead');
  await a.accept(tokenOf(sent.length - 1));
  assert.deepEqual(a.choices(ben.id).map((c) => `${c.name}:${c.role}`), ['North campus:advisor', 'South campus:lead']);
  a.switchTo(ben.id, org2.id, 'lead');
  assert.deepEqual(ben.current, { org: org2.id, role: 'lead' });
  assert.throws(() => a.switchTo(ben.id, org.id, 'owner'), /do not hold that role/);
});

test('the lifecycle: deactivate and reactivate; offboarding removes every membership and grant for good', async () => {
  const { a, revoked, log } = setup();
  const owner = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const ben = await a.signUp('ben@example.org', 'Ben', 'ben-pass-123');
  const org = a.createOrg('North', owner.id);
  a.memberships.push({ org: org.id, account: ben.id, roles: ['advisor'], since: 0 });
  a.deactivate(owner.id, ben.id);
  await assert.rejects(a.signIn('ben@example.org', 'ben-pass-123'), /not active/);
  a.reactivate(owner.id, ben.id);
  await a.offboard(owner.id, ben.id);
  assert.equal(a.rolesIn(ben.id, org.id).length, 0);
  assert.deepEqual(revoked, [ben.id]);
  await assert.rejects(a.signIn('ben@example.org', 'ben-pass-123'), Refused);
  assert.ok(log.includes(`${owner.id} offboard ${ben.id}`));
});

test('acting as someone and break-glass are time-boxed, need a reason, and are recorded, announced and reviewed', async () => {
  const { a, announced, log, tick } = setup();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  await assert.rejects(a.elevate('act-as', adm.id, { as: ana.id, reason: 'help', minutes: 30 }), /in a sentence/);
  await assert.rejects(a.elevate('act-as', adm.id, { as: ana.id, reason: 'reproducing ticket 412 about uploads', minutes: 120 }), /at most 1 hour/);
  const e = await a.elevate('act-as', adm.id, { as: ana.id, reason: 'reproducing ticket 412 about uploads', minutes: 30 });
  assert.equal(a.active(adm.id)?.id, e.id);
  tick(30 * 60_000);
  assert.equal(a.active(adm.id), undefined, 'it ends on its own');
  await a.elevate('break-glass', adm.id, { reason: 'production outage, restoring the student table', minutes: 60 });
  assert.deepEqual(announced, ['act-as', 'break-glass']);
  assert.ok(log.some((l) => l.startsWith(`${adm.id} break-glass`)));
  assert.equal(a.toReview().length, 1, 'the ended one waits for review');
});

test('a password reset spends every other reset link for that account', async () => {
  const { a, tokenOf } = setup();
  await a.signUp('ana@example.org', 'Ana', 'old-password-1');
  await a.requestReset('ana@example.org');
  await a.requestReset('ana@example.org');
  await a.reset(tokenOf(2), 'new-password-1');
  await assert.rejects(a.reset(tokenOf(1), 'attacker-pass-1'), /not valid/, 'an older link left in a mailbox does not reset it again');
});

test('an admin cannot make anyone an owner, themselves included', async () => {
  const { a, sent, tokenOf } = setup();
  const owner = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', owner.id);
  await a.invite(owner.id, org.id, 'adm@example.org', 'admin');
  const adm = await a.accept(tokenOf(1), { password: 'admin-pass-1' });
  await assert.rejects(a.invite(adm.id, org.id, 'adm@example.org', 'owner'), /only an owner/);
  assert.equal(sent.length, 2);
  await a.invite(owner.id, org.id, 'co@example.org', 'owner');
});

test('an elevation needs a real length of time, and ends when its holder is deactivated or offboarded', async () => {
  const { a } = setup();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const reason = 'production outage, restoring the student table';
  await assert.rejects(a.elevate('break-glass', adm.id, { reason, minutes: Number.NaN }), Refused);
  await a.elevate('break-glass', adm.id, { reason, minutes: 60 });
  a.deactivate(adm.id, adm.id);
  assert.equal(a.active(adm.id), undefined);
  a.reactivate(adm.id, adm.id);
  await a.elevate('break-glass', adm.id, { reason, minutes: 60 });
  await a.offboard(adm.id, adm.id);
  assert.equal(a.active(adm.id), undefined);
  assert.equal(a.toReview().length, 2, 'both wait for review');
});

test('a sign-up with an address that has an account looks like any sign-up, and tells the owner instead', async () => {
  const { a, sent } = setup();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  const fresh = await a.signUp('ben@example.org', 'Ben', 'pw-ben-12345');
  const again = await a.signUp('ANA@example.org', 'Mallory', 'other-pw-123');
  assert.deepEqual(Object.keys(again).sort(), Object.keys(fresh).sort(), 'the same shape as a new sign-up');
  assert.equal(again.passwordHash, 'h:other-pw-123', 'only the hash of what the caller typed');
  assert.notEqual(again.id, ana.id);
  assert.equal(again.emailConfirmed, false);
  assert.equal(again.name, 'Mallory', 'nothing of the real account shows through');
  assert.equal(a.accounts.size, 2, 'nothing new is kept');
  assert.deepEqual(sent.at(-1), { to: 'ana@example.org', purpose: 'signup-attempt', link: 'https://app.example.org/signin' });
  assert.equal((await a.signIn('ana@example.org', 'pw-ana-12345')).id, ana.id, 'the real account is untouched');
});

test('signing in with an unknown address costs a password check like a known one', async () => {
  let checks = 0;
  const a = new Accounts(
    { send: async () => undefined, hash: async (pw) => `h:${pw}`, check: async (pw, h) => (checks++, h === `h:${pw}`) },
    { baseUrl: 'https://app.example.org' },
  );
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await assert.rejects(a.signIn('ana@example.org', 'wrong'), /do not sign in/);
  assert.equal(checks, 1);
  await assert.rejects(a.signIn('nobody@example.org', 'wrong'), /do not sign in/);
  assert.equal(checks, 2, 'a dummy hash is checked for an unknown address');
  await assert.rejects(a.signIn('nobody@example.org', 'h:'), /do not sign in/, 'and the dummy never signs anyone in');
});

test('links that expire unused are swept, not kept until someone uses them', async () => {
  const { a, tick } = setup();
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await a.requestReset('ana@example.org');
  await a.requestReset('ana@example.org');
  assert.equal(a.sweep(), 0, 'nothing has expired yet');
  tick(3_600_001);
  assert.equal(a.sweep(), 2, 'the two reset links');
  tick(7 * 86_400_000);
  await a.requestReset('ana@example.org');
  assert.equal(a.sweep(), 0, 'making a link swept the expired confirmation on its own');
});

// ---------------------------------------------------------------------------------------------------------------
// Detail: exact records, identifiers, limits and boundaries, and who is and is not affected by each change.
// ---------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;
const REASON = 'production outage, restoring the student table';

/** Like `setup`, but the audit log keeps each entry's detail and the clock can be set as well as moved. */
const rig = () => {
  let t = 0;
  const sent: { to: string; purpose: string; link: string }[] = [];
  const log: { actor: string; action: string; target: string; detail?: Record<string, unknown> }[] = [];
  const announced: { id: string; kind: string; by: string; as?: string }[] = [];
  const a = new Accounts(
    {
      send: async (to, purpose, link) => void sent.push({ to, purpose, link }),
      hash: async (pw) => `h:${pw}`,
      check: async (pw, h) => h === `h:${pw}`,
      record: async (actor, action, target, detail) => void log.push({ actor, action, target, ...(detail ? { detail } : {}) }),
      announce: async (e) => void announced.push({ id: e.id, kind: e.kind, by: e.by, ...(e.as ? { as: e.as } : {}) }),
    },
    { now: () => t, baseUrl: 'https://app.example.org' },
  );
  const tokenOf = (i: number) => sent[i]!.link.split('/').pop()!;
  return { a, sent, log, announced, tokenOf, tick: (ms: number) => (t += ms), at: (ms: number) => void (t = ms) };
};

test('a link that is not one we made is never valid, and a link made for one purpose is not valid for another', async () => {
  const { a, sent, tokenOf } = rig();
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await a.requestReset('ana@example.org');
  await assert.rejects(a.confirm('not-a-token'), /not valid/);
  await assert.rejects(a.reset(tokenOf(0), 'x-new-password'), /not valid/, 'a confirmation link cannot reset a password');
  await assert.rejects(a.confirm(tokenOf(1)), /not valid/, 'a reset link cannot confirm an address');
  assert.equal(sent.length, 2);
  assert.equal((await a.confirm(tokenOf(0))).emailConfirmed, true, 'and the confirmation link still works for its own purpose after being tried elsewhere');
});

test('identifiers are numbered in order with their kind in front', async () => {
  const { a } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  const org = a.createOrg('North', ana.id);
  const ben = await a.invite(ana.id, org.id, 'ben@example.org', 'advisor');
  const e = await a.elevate('break-glass', ana.id, { reason: REASON, minutes: 10 });
  assert.deepEqual([ana.id, org.id, ben.id, e.id], ['acct_1', 'org_2', 'acct_3', 'elev_4']);
});

test('a new account starts empty: no memberships, no elevations', () => {
  const { a } = rig();
  assert.deepEqual(a.memberships, []);
  assert.deepEqual(a.elevations, []);
  assert.deepEqual([...a.accounts.keys(), ...a.orgs.keys()], []);
});

test('sign-up: the name is trimmed, the account starts unconfirmed and active, and the sign-up is recorded', async () => {
  const { a, log, sent } = rig();
  const ana = await a.signUp('ana@example.org', '  Ana Okafor  ', 'pw-ana-12345');
  assert.deepEqual({ ...ana }, { id: 'acct_1', email: 'ana@example.org', name: 'Ana Okafor', state: 'active', emailConfirmed: false, passwordHash: 'h:pw-ana-12345', created: 0 });
  assert.deepEqual(log, [{ actor: 'acct_1', action: 'sign-up', target: 'acct_1' }]);
  assert.equal(sent[0]!.to, 'ana@example.org');
});

test('a repeated sign-up is recorded as an attempt against the real account, with no actor', async () => {
  const { a, log } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  const again = await a.signUp('ana@example.org', 'Mallory', 'x-other-12345');
  assert.equal(again.emailConfirmed, false);
  assert.deepEqual(log.at(-1), { actor: '*', action: 'sign-up-attempt', target: ana.id });
});

test('a confirmation link lasts seven days, exactly', async () => {
  const { a, tokenOf, tick } = rig();
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  tick(7 * DAY);
  assert.equal((await a.confirm(tokenOf(0))).emailConfirmed, true, 'still valid at the last moment');
  await a.signUp('ben@example.org', 'Ben', 'pw-ben-12345');
  tick(7 * DAY + 1);
  await assert.rejects(a.confirm(tokenOf(1)), /expired/);
});

test('a reset link lasts one hour, exactly, and an expired one is not kept', async () => {
  const { a, tokenOf, tick } = rig();
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await a.requestReset('ana@example.org');
  tick(HOUR);
  assert.equal(a.sweep(), 0, 'a link is not swept at the moment it expires');
  assert.equal((await a.reset(tokenOf(1), 'brand-new-pw-1')).passwordHash, 'h:brand-new-pw-1');
});

test('an invitation lasts fourteen days, exactly', async () => {
  const { a, tokenOf, tick } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  await a.invite(own.id, org.id, 'cy@example.org', 'advisor');
  tick(14 * DAY);
  assert.equal((await a.accept(tokenOf(1), { password: 'ben-pass-123' })).state, 'active');
  tick(1);
  await assert.rejects(a.accept(tokenOf(2), { password: 'cy-pass-1234' }), /expired/);
});

test('expired links are swept as new ones are made, but not more than once a minute', async () => {
  // A link expired and still held, a sweep less than a minute ago: making a link does not sweep again.
  const quick = rig();
  await quick.a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await quick.a.requestReset('ana@example.org');
  quick.at(HOUR - 1000);
  assert.equal(quick.a.sweep(), 0);
  quick.tick(2000);
  await quick.a.requestReset('ana@example.org');
  assert.equal(quick.a.sweep(), 1, 'the first reset link had expired, but the last sweep was only two seconds ago');
  // A minute to the millisecond is enough to sweep.
  const exact = rig();
  await exact.a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await exact.a.requestReset('ana@example.org');
  exact.at(HOUR - 1000 + 1);
  assert.equal(exact.a.sweep(), 0);
  exact.tick(60_000);
  await exact.a.requestReset('ana@example.org');
  assert.equal(exact.a.sweep(), 0, 'sixty seconds after the last sweep, making a link swept the expired one');
  // The very first link already counts as swept-never: an old link is cleared without anyone calling sweep.
  const first = rig();
  await first.a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  first.tick(8 * DAY);
  await first.a.requestReset('ana@example.org');
  assert.equal(first.a.sweep(), 0, 'the unused confirmation link went when the reset link was made');
});

test('sign-in refuses an account that has no password yet in the same words as a wrong password', async () => {
  const { a } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  await assert.rejects(a.signIn('ben@example.org', ''), (e: unknown) => e instanceof Refused && e.message === 'that email and password do not sign in');
  await assert.rejects(a.signIn('nobody@example.org', 'x'), (e: unknown) => e instanceof Refused && e.message === 'that email and password do not sign in');
});

test('sign-in tells an invited account to accept, and any other non-active account that it is not active', async () => {
  const { a } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  ana.state = 'invited';
  await assert.rejects(a.signIn('ana@example.org', 'pw-ana-12345'), (e: unknown) => e instanceof Refused && e.message === 'accept your invitation first');
  ana.state = 'deactivated';
  await assert.rejects(a.signIn('ana@example.org', 'pw-ana-12345'), (e: unknown) => e instanceof Refused && e.message === 'this account is not active');
  ana.state = 'offboarded';
  await assert.rejects(a.signIn('ana@example.org', 'pw-ana-12345'), (e: unknown) => e instanceof Refused && e.message === 'this account is not active');
});

test('a reset link is only sent for an active account', async () => {
  const { a, sent } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  a.deactivate(ana.id, ana.id);
  await a.requestReset('ana@example.org');
  assert.equal(sent.length, 1, 'only the confirmation');
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  const before = sent.length;
  await a.requestReset('ben@example.org');
  assert.equal(sent.length, before, 'an invited account has nothing to reset yet');
});

test('resetting one account spends only that account\'s other reset links, and leaves other kinds of link and other people alone', async () => {
  const { a, tokenOf } = rig();
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345'); // 0: ana confirm
  await a.signUp('ben@example.org', 'Ben', 'pw-ben-12345'); // 1: ben confirm
  await a.requestReset('ana@example.org'); // 2
  await a.requestReset('ben@example.org'); // 3
  const done = await a.reset(tokenOf(2), 'new-pass-12345');
  assert.equal(done.emailConfirmed, true, 'a reset link proves control of the address');
  assert.equal((await a.confirm(tokenOf(0))).emailConfirmed, true, 'her own confirmation link is not a reset link');
  assert.equal((await a.reset(tokenOf(3), 'ben-new-pass-1')).passwordHash, 'h:ben-new-pass-1', 'and his reset link still works');
});

test('a password reset is recorded', async () => {
  const { a, log, tokenOf } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await a.requestReset('ana@example.org');
  await a.reset(tokenOf(1), 'new-pass-12345');
  assert.deepEqual(log.at(-1), { actor: ana.id, action: 'password-reset', target: ana.id });
});

test('creating an organisation makes the creator its owner and sets their current role once', async () => {
  const { a } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  const north = a.createOrg('North', ana.id);
  assert.deepEqual(ana.current, { org: north.id, role: 'owner' });
  assert.deepEqual(a.memberships, [{ org: north.id, account: ana.id, roles: ['owner'], since: 0 }]);
  a.createOrg('South', ana.id);
  assert.deepEqual(ana.current, { org: north.id, role: 'owner' }, 'a second organisation does not move them');
  const ghost = a.createOrg('Elsewhere', 'acct_unknown');
  assert.equal(a.rolesIn('acct_unknown', ghost.id)[0], 'owner', 'the membership is made even for an id with no account here');
});

test('who may invite: owners and admins, and a person with several roles needs only one of them', async () => {
  const { a, tokenOf, sent } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'adm@example.org', 'admin');
  const adm = await a.accept(tokenOf(1), { password: 'admin-pass-1' });
  await a.invite(own.id, org.id, 'adm@example.org', 'advisor');
  await a.accept(tokenOf(sent.length - 1));
  assert.deepEqual(a.rolesIn(adm.id, org.id), ['admin', 'advisor']);
  const cy = await a.invite(adm.id, org.id, 'cy@example.org', 'advisor');
  assert.equal(cy.state, 'invited');
  const stranger = await a.signUp('str@example.org', 'Stranger', 'strange-pass-1');
  await assert.rejects(a.invite(stranger.id, org.id, 'x@example.org', 'advisor'), /only an owner or admin invites people/);
  await assert.rejects(a.invite(adm.id, org.id, 'y@example.org', 'owner'), /only an owner makes someone an owner/);
});

test('an invited person is a new account with no name, no password and an unconfirmed address, and the invitation is recorded', async () => {
  const { a, log } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  const ben = await a.invite(own.id, org.id, ' BEN@example.org ', 'advisor');
  assert.deepEqual({ ...ben }, { id: 'acct_3', email: 'ben@example.org', name: '', state: 'invited', emailConfirmed: false, created: 0 });
  assert.deepEqual(log.at(-1), { actor: own.id, action: 'invite', target: ben.id, detail: { org: org.id, role: 'advisor' } });
  const again = await a.invite(own.id, org.id, 'ben@example.org', 'lead');
  assert.equal(again, ben, 'inviting an address that already has an account reuses it');
});

test('accepting: an invitee must choose a password, takes the name given or else their address, and becomes active and confirmed', async () => {
  const { a, tokenOf } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  await assert.rejects(a.accept(tokenOf(1), { name: 'Ben' }), /choose a password to accept/);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  const ben = await a.accept(tokenOf(2), { name: '  Ben Ito  ', password: 'ben-pass-123' });
  assert.deepEqual([ben.name, ben.state, ben.emailConfirmed, ben.passwordHash], ['Ben Ito', 'active', true, 'h:ben-pass-123']);
  await a.invite(own.id, org.id, 'cy@example.org', 'advisor');
  assert.equal((await a.accept(tokenOf(3), { password: 'cy-pass-1234' })).name, 'cy@example.org', 'no name given');
  await a.invite(own.id, org.id, 'di@example.org', 'advisor');
  assert.equal((await a.accept(tokenOf(4), { name: '   ', password: 'di-pass-1234' })).name, 'di@example.org', 'a blank name is no name');
});

test('accepting an invitation into an organisation the person already belongs to adds the role once, in one membership', async () => {
  const { a, tokenOf, sent } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  const south = a.createOrg('South', own.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  const ben = await a.accept(tokenOf(1), { password: 'ben-pass-123' });
  assert.deepEqual(ben.current, { org: org.id, role: 'advisor' });
  await a.invite(own.id, org.id, 'ben@example.org', 'lead');
  await a.accept(tokenOf(sent.length - 1));
  await a.invite(own.id, org.id, 'ben@example.org', 'lead');
  await a.accept(tokenOf(sent.length - 1));
  assert.deepEqual(a.memberships.filter((m) => m.account === ben.id).map((m) => [m.org, m.roles]), [[org.id, ['advisor', 'lead']]]);
  await a.invite(own.id, south.id, 'ben@example.org', 'viewer');
  await a.accept(tokenOf(sent.length - 1));
  assert.deepEqual(ben.current, { org: org.id, role: 'advisor' }, 'joining another organisation does not change the one in use');
  assert.equal(a.memberships.filter((m) => m.account === ben.id).length, 2);
});

test('accepting an invitation sent to an account that was closed is refused', async () => {
  const { a, tokenOf } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  const ben = await a.signUp('ben@example.org', 'Ben', 'ben-pass-123');
  await a.offboard(own.id, ben.id);
  await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  await assert.rejects(a.accept(tokenOf(2), { password: 'ben-pass-123' }), (e: unknown) => e instanceof Refused && e.message === 'this account was closed');
  assert.deepEqual(a.rolesIn(ben.id, org.id), []);
  assert.equal(ben.state, 'offboarded');
});

test('the top-bar choices name each organisation, or fall back to its id when it is not known', () => {
  const { a } = rig();
  a.memberships.push({ org: 'org_gone', account: 'acct_9', roles: ['advisor', 'lead'], since: 0 });
  assert.deepEqual(a.choices('acct_9'), [{ org: 'org_gone', name: 'org_gone', role: 'advisor' }, { org: 'org_gone', name: 'org_gone', role: 'lead' }]);
  assert.deepEqual(a.choices('acct_nobody'), []);
});

test('deactivate and reactivate: only from the right state, with the new state and a record', async () => {
  const { a, log } = rig();
  const ana = await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  const ben = await a.signUp('ben@example.org', 'Ben', 'pw-ben-12345');
  assert.throws(() => a.deactivate(ana.id, 'acct_nobody'), /only an active account can be deactivated/);
  assert.throws(() => a.reactivate(ana.id, ana.id), /only a deactivated account can be reactivated/, 'active accounts are not reactivated');
  assert.throws(() => a.reactivate(ana.id, 'acct_nobody'), /only a deactivated account can be reactivated/);
  a.deactivate(ana.id, ben.id);
  assert.equal(ben.state, 'deactivated');
  assert.throws(() => a.deactivate(ana.id, ben.id), /only an active account can be deactivated/, 'twice is refused');
  a.reactivate(ana.id, ben.id);
  assert.equal(ben.state, 'active');
  assert.equal((await a.signIn('ben@example.org', 'pw-ben-12345')).id, ben.id);
  ben.state = 'invited';
  assert.throws(() => a.deactivate(ana.id, ben.id), /only an active account/);
  assert.throws(() => a.reactivate(ana.id, ben.id), /only a deactivated account/);
  assert.deepEqual(log.filter((l) => l.action === 'deactivate' || l.action === 'reactivate'), [
    { actor: ana.id, action: 'deactivate', target: ben.id },
    { actor: ana.id, action: 'reactivate', target: ben.id },
  ]);
});

test('offboarding: an unknown account is refused, and only that person\'s memberships, links and passwords go', async () => {
  const { a, tokenOf } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const ben = await a.signUp('ben@example.org', 'Ben', 'ben-pass-123');
  const org = a.createOrg('North', own.id);
  a.createOrg('South', ben.id);
  a.memberships.push({ org: org.id, account: ben.id, roles: ['advisor'], since: 0 });
  await a.requestReset('ben@example.org');
  await a.requestReset('own@example.org');
  await assert.rejects(a.offboard(own.id, 'acct_nobody'), /no such account/);
  const keptElsewhere = a.memberships.filter((m) => m.account !== ben.id).length;
  await a.offboard(own.id, ben.id);
  assert.equal(ben.state, 'offboarded');
  assert.equal(ben.passwordHash, undefined);
  assert.equal(ben.current, undefined);
  assert.equal(a.memberships.some((m) => m.account === ben.id), false);
  assert.equal(a.memberships.length, keptElsewhere, 'nobody else lost anything');
  await assert.rejects(a.reset(tokenOf(2), 'x-new-password'), /not valid/, 'his reset link is gone');
  assert.equal((await a.reset(tokenOf(3), 'owner-new-pass-1')).passwordHash, 'h:owner-new-pass-1', 'the owner\'s reset link is not');
});

test('offboarding removes the first membership in the list too', async () => {
  const { a } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const org = a.createOrg('North', own.id);
  assert.equal(a.memberships[0]!.account, own.id);
  await a.offboard(own.id, own.id);
  assert.deepEqual(a.rolesIn(own.id, org.id), []);
  assert.deepEqual(a.memberships, []);
});

test('everything works without the optional hooks (record, announce, revoke)', async () => {
  const a = new Accounts({ send: async () => undefined, hash: async (pw) => `h:${pw}`, check: async (pw, h) => h === `h:${pw}` }, { baseUrl: 'https://app.example.org' });
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  await a.signUp('own@example.org', 'Again', 'owner-pass-2');
  await a.requestReset('own@example.org');
  const org = a.createOrg('North', own.id);
  const ben = await a.invite(own.id, org.id, 'ben@example.org', 'advisor');
  a.deactivate(own.id, own.id);
  a.reactivate(own.id, own.id);
  await a.elevate('act-as', own.id, { as: ben.id, reason: REASON, minutes: 5 });
  await a.offboard(own.id, ben.id);
  assert.equal(ben.state, 'offboarded');
});

test('the audit log has one entry for each change worth recording, with the detail an auditor needs', async () => {
  const { a, log, tokenOf, tick } = rig();
  const own = await a.signUp('own@example.org', 'Owner', 'owner-pass-1');
  const ben = await a.signUp('ben@example.org', 'Ben', 'ben-pass-123');
  const org = a.createOrg('North', own.id);
  await a.invite(own.id, org.id, 'cy@example.org', 'advisor');
  a.deactivate(own.id, ben.id);
  a.reactivate(own.id, ben.id);
  const act = await a.elevate('act-as', own.id, { as: ben.id, reason: `  ${REASON}  `, minutes: 20 });
  const bg = await a.elevate('break-glass', own.id, { reason: REASON, minutes: 5 });
  await a.offboard(own.id, ben.id);
  tick(0);
  assert.deepEqual(log, [
    { actor: 'acct_1', action: 'sign-up', target: 'acct_1' },
    { actor: 'acct_2', action: 'sign-up', target: 'acct_2' },
    { actor: 'acct_1', action: 'invite', target: 'acct_4', detail: { org: 'org_3', role: 'advisor' } },
    { actor: 'acct_1', action: 'deactivate', target: 'acct_2' },
    { actor: 'acct_1', action: 'reactivate', target: 'acct_2' },
    { actor: 'acct_1', action: 'act-as', target: 'acct_2', detail: { reason: REASON, until: 20 * 60_000 } },
    { actor: 'acct_1', action: 'break-glass', target: '*', detail: { reason: REASON, until: 5 * 60_000 } },
    { actor: 'acct_1', action: 'offboard', target: 'acct_2' },
  ]);
  assert.equal(tokenOf(0).length > 20, true);
  assert.deepEqual([act.id, bg.id], ['elev_5', 'elev_6']);
});

test('an elevation needs a real reason: fifteen characters once trimmed, no fewer', async () => {
  const { a } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  await assert.rejects(a.elevate('break-glass', adm.id, { reason: '12345678901234', minutes: 5 }), /write the reason in a sentence/);
  await assert.rejects(a.elevate('break-glass', adm.id, { reason: `   ${'x'.repeat(10)}   `, minutes: 5 }), /write the reason in a sentence/);
  const e = await a.elevate('break-glass', adm.id, { reason: '  123456789012345  ', minutes: 5 });
  assert.equal(e.reason, '123456789012345', 'kept without the spaces around it');
});

test('an elevation lasts from one minute up to one hour (acting as) or four hours (break-glass), no more, no less', async () => {
  const { a } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  const act = (minutes: number) => a.elevate('act-as', adm.id, { as: ana.id, reason: REASON, minutes });
  const glass = (minutes: number) => a.elevate('break-glass', adm.id, { reason: REASON, minutes });
  for (const m of [0, -5, 0.5, Number.POSITIVE_INFINITY, 61, 240]) await assert.rejects(act(m), (e: unknown) => e instanceof Refused && e.message === 'act-as lasts at most 1 hour', `act-as ${m}`);
  for (const m of [0, -5, 0.5, Number.NaN, 241, 1000]) await assert.rejects(glass(m), (e: unknown) => e instanceof Refused && e.message === 'break-glass lasts at most 4 hours', `break-glass ${m}`);
  assert.equal((await act(1)).until, 60_000);
  assert.equal((await act(60)).until, 60 * 60_000);
  assert.equal((await glass(1)).until, 60_000);
  assert.equal((await glass(61)).until, 61 * 60_000);
  assert.equal((await glass(240)).until, 240 * 60_000);
});

test('acting as someone needs a named, existing person who is not yourself; break-glass needs no one', async () => {
  const { a } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  const named = (e: unknown) => e instanceof Refused && e.message === 'name the person to act as';
  await assert.rejects(a.elevate('act-as', adm.id, { reason: REASON, minutes: 5 }), named);
  await assert.rejects(a.elevate('act-as', adm.id, { as: '', reason: REASON, minutes: 5 }), named);
  await assert.rejects(a.elevate('act-as', adm.id, { as: 'acct_nobody', reason: REASON, minutes: 5 }), named);
  await assert.rejects(a.elevate('act-as', adm.id, { as: adm.id, reason: REASON, minutes: 5 }), (e: unknown) => e instanceof Refused && e.message === 'you cannot act as yourself');
  const act = await a.elevate('act-as', adm.id, { as: ana.id, reason: REASON, minutes: 5 });
  assert.deepEqual([act.kind, act.by, act.as, act.from, act.until, act.ended], ['act-as', adm.id, ana.id, 0, 5 * 60_000, undefined]);
  const glass = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 5 });
  assert.equal('as' in glass, false, 'no one is acted as');
  await assert.rejects(a.elevate('break-glass', adm.id, { as: adm.id, reason: REASON, minutes: 5 }), /cannot act as yourself/);
  assert.equal((await a.elevate('break-glass', adm.id, { as: 'acct_nobody', reason: REASON, minutes: 5 })).as, 'acct_nobody', 'break-glass names no one to act as, and one named is only recorded');
});

test('an elevation is announced when it starts', async () => {
  const { a, announced } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  const e = await a.elevate('act-as', adm.id, { as: ana.id, reason: REASON, minutes: 5 });
  assert.deepEqual(announced, [{ id: e.id, kind: 'act-as', by: adm.id, as: ana.id }]);
});

test('only the holder\'s own elevation is in force for them; an expired or ended one is not', async () => {
  const { a, tick } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  const e = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 10 });
  assert.equal(a.active(ana.id), undefined, 'someone else is not elevated');
  assert.equal(a.active(adm.id), e);
  tick(10 * 60_000 - 1);
  assert.equal(a.active(adm.id), e, 'one millisecond left');
  tick(1);
  assert.equal(a.active(adm.id), undefined, 'at its end time it is over');
});

test('ending an elevation: now, once, only that one', async () => {
  const { a, tick } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const first = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 30 });
  const second = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 30 });
  tick(1000);
  a.end(first.id);
  assert.deepEqual([first.ended, second.ended], [1000, undefined]);
  tick(1000);
  a.end(first.id);
  assert.equal(first.ended, 1000, 'ending it again does not move the time');
  a.end('elev_nobody');
  assert.equal(second.ended, undefined);
  assert.equal(a.active(adm.id), second);
});

test('deactivating or offboarding a person ends what they hold and what is acted as them, and nobody else\'s', async () => {
  const { a, tick } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  const ana = await a.signUp('ana@example.org', 'Ana', 'ana-pass-123');
  const ben = await a.signUp('ben@example.org', 'Ben', 'ben-pass-123');
  const byAna = await a.elevate('break-glass', ana.id, { reason: REASON, minutes: 30 });
  const asAna = await a.elevate('act-as', adm.id, { as: ana.id, reason: REASON, minutes: 30 });
  const unrelated = await a.elevate('act-as', adm.id, { as: ben.id, reason: REASON, minutes: 30 });
  const byBen = await a.elevate('break-glass', ben.id, { reason: REASON, minutes: 30 });
  const lapsed = await a.elevate('break-glass', ana.id, { reason: REASON, minutes: 1 });
  const early = await a.elevate('break-glass', ana.id, { reason: REASON, minutes: 30 });
  a.end(early.id);
  tick(60_000);
  const atLapse = await a.elevate('break-glass', ana.id, { reason: REASON, minutes: 1 });
  tick(60_000);
  assert.equal(atLapse.until, 120_000);
  a.deactivate(adm.id, ana.id);
  assert.deepEqual([byAna.ended, asAna.ended], [120_000, 120_000]);
  assert.deepEqual([unrelated.ended, byBen.ended], [undefined, undefined]);
  assert.equal(lapsed.ended, undefined, 'one that ran out by itself is not marked ended');
  assert.equal(atLapse.ended, undefined, 'nor one that runs out at this very moment');
  assert.equal(early.ended, 0, 'one already ended keeps its time');
  await a.offboard(adm.id, ben.id);
  assert.deepEqual([unrelated.ended, byBen.ended], [120_000, 120_000]);
});

test('elevations waiting for review are those that have ended or run out, oldest first', async () => {
  const { a, tick, at } = rig();
  const adm = await a.signUp('adm@example.org', 'Admin', 'admin-pass-1');
  at(5000);
  const later = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 1 });
  at(1000);
  const earlier = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 1 });
  at(2000);
  const open = await a.elevate('break-glass', adm.id, { reason: REASON, minutes: 30 });
  assert.deepEqual(a.toReview(), [], 'all still running');
  at(5000 + 60_000);
  assert.deepEqual(a.toReview().map((e) => e.id), [earlier.id, later.id], 'oldest first, and the one still running is not listed');
  assert.equal(a.elevations[0], later, 'listing does not reorder the record');
  tick(1);
  a.end(open.id);
  assert.deepEqual(a.toReview().map((e) => e.id), [earlier.id, open.id, later.id]);
});

test('a password can be reset without the optional audit hook', async () => {
  const links: string[] = [];
  const a = new Accounts({ send: async (_to, _purpose, link) => void links.push(link), hash: async (pw) => `h:${pw}`, check: async (pw, h) => h === `h:${pw}` }, { baseUrl: 'https://app.example.org' });
  await a.signUp('ana@example.org', 'Ana', 'pw-ana-12345');
  await a.requestReset('ana@example.org');
  const done = await a.reset(links[1]!.split('/').pop()!, 'new-pass-12345');
  assert.equal(done.passwordHash, 'h:new-pass-12345');
});
