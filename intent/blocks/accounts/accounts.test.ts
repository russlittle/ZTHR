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
