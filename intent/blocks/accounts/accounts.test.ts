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
  assert.equal(again.id, ana.id);
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
