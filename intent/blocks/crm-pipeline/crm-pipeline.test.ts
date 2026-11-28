import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, Assigner, checkPipeline, scoreLead, CrmError, Duplicate, Refused, stageOf } from './index.ts';
import type { PipelineDef, Scoring } from './index.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 10);
const def: PipelineDef = {
  name: 'sales',
  stages: [
    { id: 'new', name: 'New', probability: 0.1, rotAfterDays: 7 },
    { id: 'qualified', name: 'Qualified', probability: 0.3, rotAfterDays: 14 },
    { id: 'proposal', name: 'Proposal', probability: 0.6, requires: ['proposalUrl'], rotAfterDays: 14 },
    { id: 'negotiation', name: 'Negotiation', probability: 0.8, requires: ['proposalUrl', 'budget'] },
    { id: 'won', name: 'Won', probability: 1, kind: 'won' },
    { id: 'lost', name: 'Lost', probability: 0, kind: 'lost' },
  ],
};
const S = ['sales'];
const M = ['manager'];
function mk(): { p: Pipeline; clock: { t: number } } {
  const clock = { t: T0 };
  return { p: new Pipeline(def, { now: () => clock.t }), clock };
}
const deal = (p: Pipeline, amount = 100_00, close = '2026-02-15', owner = 'ana') => p.createDeal({ title: 'Acme', amount, currency: 'USD', owner, expectedClose: close });

test('a sound pipeline has no problems; bad ones are reported', () => {
  assert.deepEqual(checkPipeline(def), []);
  const bad = checkPipeline({ name: 'x', stages: [{ id: 'a', name: 'A', probability: 0.5 }, { id: 'b', name: 'B', probability: 0.2 }, { id: 'w', name: 'W', probability: 0.9, kind: 'won' }, { id: 'a', name: 'dup', probability: 2 }] });
  const t = bad.join('\n');
  for (const s of ['lower probability', 'probability 1', 'exactly one lost', 'share the id', 'probability is 0 to 1']) assert.match(t, new RegExp(s));
  assert.throws(() => new Pipeline({ name: 'x', stages: [] }), CrmError);
});

test('leads keep the name as written, normalise phone, and refuse a repeated email', () => {
  const { p } = mk();
  const l = p.createLead({ name: 'Zoë  Okafor', callMe: 'Zo', email: ' Zoe@Example.COM ', phone: '(415) 555-0132', company: 'Acme' });
  assert.equal(l.name.full, 'Zoë Okafor');
  assert.equal(l.email, 'zoe@example.com');
  assert.equal(l.phone, '+14155550132');
  assert.throws(() => p.createLead({ name: 'Other', email: 'ZOE@example.com' }), (e: unknown) => e instanceof Duplicate && e.existing === l.id);
  assert.throws(() => p.createLead({ name: 'X', email: 'nope' }), CrmError);
  assert.throws(() => p.createLead({ name: 'X', phone: 'abc' }), CrmError);
  assert.throws(() => p.createLead({ name: '' }), CrmError);
});

const scoring: Scoring = {
  rules: [
    { field: 'emailDomain', cmp: 'in', value: ['gmail.com', 'yahoo.com'], points: -10, why: 'free email' },
    { field: 'company', cmp: 'present', points: 15, why: 'has company' },
    { field: 'employees', cmp: 'gte', value: 100, points: 30, why: '100+ employees' },
    { field: 'source', cmp: 'eq', value: 'referral', points: 25 },
    { field: 'title', cmp: 'contains', value: 'director', points: 20, why: 'senior' },
  ],
  perActivity: 5,
  activityCap: 15,
  halfLifeDays: 30,
};

test('scoring explains itself, caps activity points and clamps to 0..100', () => {
  const { p, clock } = mk();
  const l = p.createLead({ name: 'A', email: 'a@acme.com', company: 'Acme', source: 'Referral', attrs: { employees: 250, title: 'Director of Ops' } });
  for (let i = 0; i < 5; i++) p.touchLead(l.id);
  const r = scoreLead(l, scoring, clock.t);
  assert.deepEqual(r.parts.map((x) => x.points), [15, 30, 25, 20, 15]);
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
  const free = p.createLead({ name: 'B', email: 'b@gmail.com' });
  assert.equal(scoreLead(free, scoring, clock.t).score, 0);
});

test('points fade by half every half-life of silence', () => {
  const { p, clock } = mk();
  const l = p.createLead({ name: 'A', company: 'Acme', source: 'referral' });
  assert.equal(scoreLead(l, scoring, clock.t).score, 40);
  assert.equal(scoreLead(l, scoring, clock.t + 30 * DAY).score, 20);
  assert.equal(scoreLead(l, scoring, clock.t + 60 * DAY).score, 10);
  assert.equal(scoreLead(l, scoring, clock.t + 30 * DAY).grade, 'C');
});

const owners = [{ id: 'ana' }, { id: 'bo' }, { id: 'cy', capacity: 1 }, { id: 'dee', away: true }, { id: 'boss' }];

test('assignment: first matching rule, fixed owner, round robin skipping the away', () => {
  const { p } = mk();
  const a = new Assigner([{ when: [{ field: 'country', cmp: 'eq', value: 'DE' }], to: 'boss' }, { to: { pool: ['ana', 'dee', 'bo'], by: 'round-robin' } }], owners, 'boss');
  const mkLead = (n: string, country?: string) => p.createLead({ name: n, ...(country ? { country } : {}) });
  assert.deepEqual(a.assign(mkLead('1', 'DE')), { owner: 'boss', rule: 0 });
  assert.deepEqual(['2', '3', '4', '5'].map((n) => a.assign(mkLead(n)).owner), ['ana', 'bo', 'ana', 'bo']);
});

test('assignment: least loaded, capacity and fallback', () => {
  const { p } = mk();
  const a = new Assigner([{ to: { pool: ['ana', 'bo', 'cy'], by: 'least-loaded' } }], owners, 'boss');
  a.setLoad('ana', 3);
  a.setLoad('bo', 2);
  const l = () => p.createLead({ name: 'x' });
  assert.deepEqual([1, 2, 3, 4].map(() => a.assign(l()).owner), ['cy', 'bo', 'ana', 'bo']);
  const full = new Assigner([{ to: 'cy' }], [{ id: 'cy', capacity: 1 }], undefined);
  full.assign(l());
  assert.throws(() => full.assign(l()), CrmError);
  assert.throws(() => new Assigner([{ to: 'ghost' }], owners), CrmError);
  assert.throws(() => new Assigner([{ to: { pool: [], by: 'round-robin' } }], owners), CrmError);
});

test('convert a lead once, with an owner, carrying the lead link and touching activity', () => {
  const { p } = mk();
  const l = p.createLead({ name: 'A', company: 'Acme' });
  assert.throws(() => p.convertLead(l.id, { amount: 5000, currency: 'USD' }), /owner/);
  p.assignLead(l.id, new Assigner([{ to: 'ana' }], owners));
  const d = p.convertLead(l.id, { amount: 5000, currency: 'USD', expectedClose: '2026-03-01' });
  assert.equal(d.title, 'Acme deal');
  assert.equal(d.leadId, l.id);
  assert.equal(p.lead(l.id).status, 'converted');
  assert.throws(() => p.convertLead(l.id, { amount: 1, currency: 'USD' }), /already converted/);
  p.addActivity(d.id, { kind: 'call', by: 'ana', summary: 'intro' });
  assert.equal(p.lead(l.id).activityCount, 1);
});

test('deal validation: whole cents, currency code, real dates', () => {
  const { p } = mk();
  assert.throws(() => p.createDeal({ title: 'x', amount: 10.5, currency: 'USD', owner: 'a' }), /whole number/);
  assert.throws(() => p.createDeal({ title: 'x', amount: -1, currency: 'USD', owner: 'a' }), CrmError);
  assert.throws(() => p.createDeal({ title: 'x', amount: 1, currency: 'usd', owner: 'a' }), /currency/);
  assert.throws(() => p.createDeal({ title: 'x', amount: 1, currency: 'USD', owner: 'a', expectedClose: '2026-02-30' }), /real date/);
  assert.throws(() => p.createDeal({ title: ' ', amount: 1, currency: 'USD', owner: 'a' }), CrmError);
});

test('stages move forward, back one, and are guarded by required fields', () => {
  const { p } = mk();
  const d = deal(p);
  p.move(d.id, 'qualified', 'ana', S);
  assert.throws(() => p.move(d.id, 'proposal', 'ana', S), /needs: proposalUrl/);
  p.setField(d.id, 'proposalUrl', 'https://example.invalid/p');
  p.move(d.id, 'proposal', 'ana', S);
  assert.throws(() => p.move(d.id, 'negotiation', 'ana', S), /needs: budget/);
  p.move(d.id, 'qualified', 'ana', S);
  assert.equal(stageOf(d), 'qualified');
  assert.throws(() => p.move(d.id, 'new', 'ana', ['intern']), Refused);
  assert.throws(() => p.move(d.id, 'nowhere', 'ana', S), CrmError);
  assert.ok(p.moves(d.id, S).some((m) => m.action === 'to:proposal' && m.ok));
});

test('winning needs an amount; losing needs a reason; reopening is for managers', () => {
  const { p, clock } = mk();
  const z = deal(p, 0);
  assert.throws(() => p.win(z.id, 'ana', S), /amount/);
  const d = deal(p);
  assert.throws(() => p.lose(d.id, 'ana', S, '  '), /why/);
  assert.equal(stageOf(d), 'new');
  clock.t += DAY;
  p.lose(d.id, 'ana', S, 'went with a competitor');
  assert.equal(d.lostReason, 'went with a competitor');
  assert.equal(d.closedAt, clock.t);
  assert.throws(() => p.reopen(d.id, 'ana', S), Refused);
  p.reopen(d.id, 'boss', M);
  assert.equal(stageOf(d), 'new');
  assert.equal(d.lostReason, undefined);
  assert.equal(d.closedAt, undefined);
  p.win(d.id, 'ana', S);
  assert.throws(() => p.update(d.id, { amount: 1 }), /closed/);
});

test('rotting: idle beyond the stage limit, reset by activity and by moving', () => {
  const { p, clock } = mk();
  const a = deal(p);
  const b = deal(p, 200_00, '2026-02-20', 'bo');
  clock.t += 8 * DAY;
  assert.deepEqual(p.rotting().map((r) => [r.deal, r.idleDays, r.limit]), [[a.id, 8, 7], [b.id, 8, 7]]);
  p.addActivity(a.id, { kind: 'call', by: 'ana', summary: 'checked in' });
  p.move(b.id, 'qualified', 'bo', S);
  assert.deepEqual(p.rotting(), []);
  clock.t += 15 * DAY;
  assert.equal(p.rotting().length, 2);
});

test('tasks: need a due time, show as overdue until done', () => {
  const { p, clock } = mk();
  const d = deal(p);
  assert.throws(() => p.addActivity(d.id, { kind: 'task', by: 'a', summary: 'send' }), /due/);
  assert.throws(() => p.addActivity(d.id, { kind: 'note', by: 'a', summary: ' ' }), CrmError);
  const t = p.addActivity(d.id, { kind: 'task', by: 'a', summary: 'send quote', dueAt: clock.t + DAY });
  assert.deepEqual(p.overdueTasks(), []);
  clock.t += 4 * DAY;
  assert.equal(p.overdueTasks()[0]!.lateByDays, 3);
  p.completeTask(d.id, t.id);
  assert.deepEqual(p.overdueTasks(), []);
  assert.throws(() => p.completeTask(d.id, 'nope'), CrmError);
});

test('forecast weights each open deal by its stage probability, rounded once per deal', () => {
  const { p } = mk();
  const a = deal(p, 100_01, '2026-02-10', 'ana');
  const b = deal(p, 50_00, '2026-02-20', 'bo');
  const c = deal(p, 20_00, '2026-03-05', 'ana');
  deal(p, 99_00, '2026-06-01', 'ana');
  p.move(b.id, 'qualified', 'bo', S);
  p.setField(c.id, 'proposalUrl', 'u');
  p.move(c.id, 'qualified', 'ana', S);
  p.move(c.id, 'proposal', 'ana', S);
  const f = p.forecast({ from: '2026-02-01', to: '2026-03-31' });
  assert.equal(f.open, 100_01 + 50_00 + 20_00);
  assert.equal(f.weighted, Math.round(100_01 * 0.1) + Math.round(50_00 * 0.3) + Math.round(20_00 * 0.6));
  assert.equal(f.byMonth['2026-02']!.weighted, Math.round(100_01 * 0.1) + Math.round(50_00 * 0.3));
  assert.equal(f.byOwner['ana']!.open, 100_01 + 20_00);
  assert.deepEqual(f.byStage['qualified'], { count: 1, open: 50_00, weighted: 15_00 });
  void a;
});

test('forecast: commit, best case, won in range, quota attainment, no close date', () => {
  const { p, clock } = mk();
  const w = deal(p, 40_00, '2026-02-01');
  p.win(w.id, 'ana', S);
  clock.t = Date.UTC(2026, 1, 5);
  const w2 = deal(p, 60_00, '2026-02-01');
  p.win(w2.id, 'ana', S);
  const hot = deal(p, 30_00, '2026-02-25');
  p.setField(hot.id, 'proposalUrl', 'u');
  p.setField(hot.id, 'budget', 1);
  p.move(hot.id, 'negotiation', 'ana', S);
  p.createDeal({ title: 'no date', amount: 5_00, currency: 'USD', owner: 'ana' });
  const f = p.forecast({ from: '2026-01-01', to: '2026-02-28', quota: 200_00 });
  assert.equal(f.won, 100_00);
  assert.equal(f.commit, 30_00);
  assert.equal(f.bestCase, 130_00);
  assert.equal(f.attainment, 0.5);
  assert.equal(f.noCloseDate, 1);
  assert.deepEqual([f.byMonth['2026-01']!.won, f.byMonth['2026-02']!.won], [40_00, 60_00]);
});

test('forecast refuses mixed currencies without a rate and converts with one; bad ranges refused', () => {
  const { p } = mk();
  deal(p, 100_00, '2026-02-10');
  p.createDeal({ title: 'eu', amount: 100_00, currency: 'EUR', owner: 'ana', expectedClose: '2026-02-11' });
  assert.throws(() => p.forecast({ from: '2026-02-01', to: '2026-02-28', currency: 'USD' }), /rate/);
  const f = p.forecast({ from: '2026-02-01', to: '2026-02-28', currency: 'USD', rates: { EUR: 1.1 } });
  assert.equal(f.open, 100_00 + 110_00);
  assert.throws(() => p.forecast({ from: '2026-03-01', to: '2026-02-01' }), CrmError);
});
