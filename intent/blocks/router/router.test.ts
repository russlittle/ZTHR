import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOGUE, LEVELS, POLICY, Router, cost, failuresOf, measure, models, spentOn, staleness, statOf, wilson, type Choice, type PriceTable, type Result, type Stop } from './index.ts';

const TABLE = JSON.parse(readFileSync(new URL('../../factory/prices.json', import.meta.url), 'utf8')) as PriceTable;
const NOW = new Date('2026-11-27T12:00:00Z');
const never = () => 0.99; // never explores
const always = () => 0; // always explores when it may

const r = (model: string, kind: string, pass: boolean | null, extra: Partial<Result> = {}): Result => ({ at: '2026-11-27T01:00:00Z', model, kind, pass, inputTokens: 1000, outputTokens: 100, costUsd: 0.001, ...extra });
const times = (n: number, f: () => Result) => Array.from({ length: n }, f);
const router = (results: Result[] = [], random = never, policy = {}) => new Router(TABLE, results, { now: NOW, random, policy });
const chosen = (c: Choice | Stop): Choice => {
  assert.equal(c.stop, false, c.stop ? `${c.reason}: ${c.detail}` : '');
  return c as Choice;
};
const stopped = (c: Choice | Stop): Stop => {
  assert.equal(c.stop, true, c.stop ? '' : `chose ${c.model.id}`);
  return c as Stop;
};

test('the price table is no more than 30 days old, every row is sourced, and no promotional rate has lapsed', () => {
  assert.deepEqual(staleness(TABLE, new Date()), [], 'intent/factory/prices.json needs re-reading from the sources it names');
  assert.deepEqual(staleness(TABLE, NOW), []);
  assert.deepEqual(staleness(TABLE, new Date('2026-12-27T00:00:00Z')), [], 'exactly 30 days is still fresh');
  const old = staleness(TABLE, new Date('2026-12-28T00:00:01Z'));
  assert.ok(old.includes('price table checked 2026-11-27, more than 30 days ago'), old.join('\n'));
  assert.ok(old.includes('claude-haiku-5-5: price checked 2026-11-27, more than 30 days ago'));
  const lapsed = staleness({ ...TABLE, checked: '2027-01-02', models: TABLE.models.map((m) => ({ ...m, checked: '2027-01-02' })) }, new Date('2027-01-02T00:00:00Z'));
  assert.deepEqual(lapsed, ['gemini-3.8-flash: rate valid until 2026-12-31, now past']);
  assert.deepEqual(staleness({ ...TABLE, models: [{ id: 'x', input: -1, output: 1, source: 'nowhere', checked: '2026-11-27' }] }, NOW), ['x: negative or missing rate', 'x: no source']);
});

test('every catalogue model has a price, the price ids match, and a missing price is refused', () => {
  const ms = models(TABLE);
  assert.equal(ms.length, CATALOGUE.length);
  for (const m of ms) assert.equal(m.price.id, m.id);
  assert.throws(() => models({ ...TABLE, models: TABLE.models.filter((m) => m.id !== 'gpt-oss-120b') }), /no price for gpt-oss-120b/);
  assert.deepEqual([...new Set(ms.map((m) => m.family))].sort(), ['alibaba', 'anthropic', 'deepseek', 'google', 'openai']);
  for (const m of ms) assert.equal(m.runner, m.family === 'anthropic' ? 'claude-code' : 'openai-compatible');
  assert.deepEqual(LEVELS, ['worker', 'escalation', 'judgment']);
});

test('cost from token counts: per million, regional premium, batch, cache multiples', () => {
  const R = router();
  assert.equal(R.cost('gpt-oss-120b', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.45);
  assert.equal(R.cost('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 2_000 }), 0.08);
  assert.equal(R.cost('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 2_000 }, { batch: true }), 0.05);
  assert.equal(R.cost('claude-sonnet-5-5', { inputTokens: 10_000, outputTokens: 2_000 }, { location: 'us-east5' }), 0.044, 'regional endpoints about 10% higher');
  assert.equal(R.cost('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), 0.2, 'cache reads at a tenth of input');
  assert.equal(R.cost('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }), 2.5, 'cache writes at 1.25x input');
  assert.equal(R.cost('deepseek-ai/deepseek-v4.1-flash-maas', { inputTokens: 1_000_000, outputTokens: 0 }), 0.3, 'found by the id sent to Vertex too');
  assert.equal(R.cost('gpt-oss-120b', { inputTokens: 0, outputTokens: 0 }), 0);
  assert.throws(() => R.cost('gpt-oss-120b', { inputTokens: -1, outputTokens: 0 }), /zero or more/);
  assert.throws(() => R.cost('gpt-oss-120b', { inputTokens: Number.NaN, outputTokens: 0 }), /zero or more/);
  assert.throws(() => R.cost('gpt-5', { inputTokens: 1, outputTokens: 1 }), /unknown model gpt-5/);
});

test('the long-context tier bills the whole request at the long rates once its input is over the threshold', () => {
  const R = router();
  assert.equal(R.cost('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 1_000 }), 0.0105, 'at the threshold: standard rates');
  assert.equal(R.cost('claude-haiku-5-5', { inputTokens: 100_001, outputTokens: 1_000 }), 0.0525005, 'over it: every token at 0.50 / 2.50');
  assert.equal(R.cost('claude-haiku-5-5', { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 50_000 }), 0.0325, 'cached input counts toward the threshold');
  assert.equal(R.cost('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 0 }, { batch: true }), 0.1, 'the long tier wins over batch');
  assert.equal(R.cost('gpt-oss-120b', { inputTokens: 120_000, outputTokens: 0 }), 0.0108, 'no tier: no jump');
  // Routing: a request over the threshold makes Haiku dearer than DeepSeek; a long task made of short requests does not.
  const long = { inputTokens: 120_000, outputTokens: 2_000, largestRequest: 120_000 };
  const H = R.model('claude-haiku-5-5');
  assert.equal(R.estCost(H, long), 0.065);
  assert.equal(R.estCost(H, { ...long, largestRequest: 100_000 }), 0.013);
  assert.equal(R.estCost(H, { inputTokens: 120_000, outputTokens: 2_000 }), 0.065, 'with no largest request given, the whole input is one request');
  const noGpt = { excludeFamilies: ['openai'] };
  assert.equal(chosen(R.choose('kill-mutant', long, 10, noGpt)).model.id, 'deepseek-v4.1-flash');
  assert.equal(chosen(R.choose('kill-mutant', { ...long, largestRequest: 50_000 }, 10, noGpt)).model.id, 'claude-haiku-5-5');
});

test('Wilson bounds: nothing known with no attempts; five of five is trusted at 0.5, four of five is not', () => {
  assert.deepEqual(wilson(0, 0), { lower: 0, upper: 1 });
  const five = wilson(5, 5);
  assert.ok(Math.abs(five.lower - 0.5655) < 1e-4, `${five.lower}`);
  assert.equal(five.upper, 1);
  const four = wilson(4, 5);
  assert.ok(Math.abs(four.lower - 0.3755) < 1e-4, `${four.lower}`);
  assert.ok(Math.abs(four.upper - 0.9638) < 1e-4, `${four.upper}`);
  const none = wilson(0, 5);
  assert.equal(none.lower, 0);
  assert.ok(Math.abs(none.upper - 0.4345) < 1e-4, `${none.upper}`);
  assert.ok(wilson(50, 100).lower > wilson(5, 10).lower, 'more attempts, tighter bound');
  assert.ok(wilson(5, 5, 1).lower > five.lower, 'a smaller z is less cautious');
  assert.throws(() => wilson(6, 5), /out of range/);
  assert.throws(() => wilson(-1, 5), /out of range/);
});

test('measured performance per model per kind; neutral attempts cost money but are not scored', () => {
  const s = measure([r('a', 'kill-mutant', true), r('a', 'kill-mutant', false), r('a', 'kill-mutant', null, { costUsd: 0.5 }), r('a', 'fix-bug', true), r('b', 'kill-mutant', true)]);
  assert.deepEqual(statOf(s, 'a', 'kill-mutant'), { attempts: 2, passes: 1, inputTokens: 3000, outputTokens: 300, costUsd: 0.502 });
  assert.deepEqual(statOf(s, 'a', 'fix-bug'), { attempts: 1, passes: 1, inputTokens: 1000, outputTokens: 100, costUsd: 0.001 });
  assert.deepEqual(statOf(s, 'c', 'kill-mutant'), { attempts: 0, passes: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  assert.equal(spentOn([r('a', 'k', true, { costUsd: 0.25 }), r('a', 'k', true, { costUsd: 0.5, at: '2026-11-26T23:59:59Z' }), r('a', 'k', null, { costUsd: 0.125 })], '2026-11-27'), 0.375);
  assert.equal(failuresOf([r('a', 'k', false, { task: 't' }), r('a', 'k', null, { task: 't' }), r('a', 'k', true, { task: 't' }), r('a', 'k', false, { task: 'u' })], 't'), 1);
});

test('with nothing measured, the cheapest model is tried first, then the least tried, never a retired one', () => {
  const c = chosen(router().choose('kill-mutant', 10_000, 5));
  assert.equal(c.model.id, 'gpt-oss-120b');
  assert.equal(c.why, 'not-yet-proven');
  assert.equal(c.level, 'worker');
  assert.equal(c.estCostUsd, 0.001305);
  const tried = chosen(router([r('gpt-oss-120b', 'kill-mutant', true)]).choose('kill-mutant', 10_000, 5));
  assert.equal(tried.model.id, 'claude-haiku-5-5', 'a model with one try is not trusted; the next untried one goes');
  const all = ['gpt-oss-120b', 'claude-haiku-5-5', 'deepseek-v4.1-flash', 'gemini-3.5-flash-lite'].map((m) => r(m, 'kill-mutant', true));
  assert.equal(chosen(router(all).choose('kill-mutant', 10_000, 5)).model.id, 'gpt-oss-120b', 'equally tried: cheapest');
  for (let i = 0; i < 50; i++) assert.notEqual(chosen(router([], Math.random).choose('kill-mutant', 10_000, 5)).model.id, 'qwen3-coder-480b-a35b-instruct');
});

test('the cheapest trusted model wins; a few lucky tries do not make a model trusted', () => {
  const results = [...times(10, () => r('deepseek-v4.1-flash', 'kill-mutant', true)), ...times(4, () => r('gpt-oss-120b', 'kill-mutant', true)), ...times(5, () => r('claude-haiku-5-5', 'kill-mutant', true)), r('claude-haiku-5-5', 'kill-mutant', false), ...times(5, () => r('gemini-3.5-flash-lite', 'kill-mutant', true))];
  const R = router(results);
  assert.equal(R.standing(R.model('gpt-oss-120b'), 'kill-mutant').standing, 'exploring', 'four of four: too few attempts');
  assert.equal(R.standing(R.model('claude-haiku-5-5'), 'kill-mutant').standing, 'exploring', 'five of six: lower bound under the bar');
  assert.equal(R.standing(R.model('deepseek-v4.1-flash'), 'kill-mutant').standing, 'trusted');
  const c = chosen(R.choose('kill-mutant', 10_000, 5));
  assert.equal(c.model.id, 'deepseek-v4.1-flash');
  assert.equal(c.why, 'trusted');
  assert.equal(c.stat.attempts, 10);
  assert.ok(c.lower >= POLICY.bar);
  const lucky = router([...results, r('gpt-oss-120b', 'kill-mutant', true)]);
  assert.equal(chosen(lucky.choose('kill-mutant', 10_000, 5)).model.id, 'gpt-oss-120b', 'five of five: now trusted and cheapest');
  assert.equal(chosen(R.choose('fix-bug', 10_000, 5)).why, 'not-yet-proven', 'trust is per task kind');
});

test('exploration: a cheaper unproven model is tried at the set rate, a dearer one never', () => {
  const trustedHaiku = times(8, () => r('claude-haiku-5-5', 'kill-mutant', true));
  const explored = chosen(router(trustedHaiku, always).choose('kill-mutant', 10_000, 5));
  assert.equal(explored.model.id, 'gpt-oss-120b');
  assert.equal(explored.why, 'explore');
  assert.equal(chosen(router(trustedHaiku, never).choose('kill-mutant', 10_000, 5)).model.id, 'claude-haiku-5-5');
  assert.equal(chosen(router(trustedHaiku, () => 0.0999).choose('kill-mutant', 10_000, 5)).why, 'explore', 'just under the rate');
  assert.equal(chosen(router(trustedHaiku, () => 0.1).choose('kill-mutant', 10_000, 5)).why, 'trusted', 'at the rate: no');
  const trustedGpt = times(8, () => r('gpt-oss-120b', 'kill-mutant', true));
  assert.equal(chosen(router(trustedGpt, always).choose('kill-mutant', 10_000, 5)).why, 'trusted', 'nothing cheaper to explore');
  let picks = 0;
  let seed = 7;
  const lcg = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) if (chosen(router(trustedHaiku, lcg).choose('kill-mutant', 10_000, 5)).why === 'explore') picks++;
  assert.ok(picks > 140 && picks < 260, `explored ${picks} of 2000 at a 10% rate`);
  assert.equal(chosen(router(trustedHaiku, always, { explore: 0 }).choose('kill-mutant', 10_000, 5)).why, 'trusted', 'rate zero: never');
});

test('a model ruled out is not chosen; a level with every model ruled out hands the task up', () => {
  const bad = (m: string) => times(6, () => r(m, 'kill-mutant', false));
  const R = router(bad('gpt-oss-120b'));
  assert.equal(R.standing(R.model('gpt-oss-120b'), 'kill-mutant').standing, 'ruled-out');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5)).model.id, 'claude-haiku-5-5');
  const allBad = router(['gpt-oss-120b', 'claude-haiku-5-5', 'deepseek-v4.1-flash', 'gemini-3.5-flash-lite'].flatMap(bad));
  const up = chosen(allBad.choose('kill-mutant', 10_000, 5));
  assert.equal(up.level, 'escalation');
  assert.equal(up.model.id, 'gemini-3.8-flash');
});

test('escalation after failures: worker, then escalation, then judgment, then parked for a person', () => {
  const R = router();
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 1 })).level, 'worker');
  const esc = chosen(R.choose('kill-mutant', 10_000, 5, { failures: 2 }));
  assert.equal(esc.level, 'escalation');
  assert.equal(esc.model.id, 'gemini-3.8-flash');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 3, excludeFamilies: ['google'] })).model.id, 'claude-sonnet-5-5');
  const judge = chosen(R.choose('kill-mutant', 10_000, 5, { failures: 4 }));
  assert.equal(judge.level, 'judgment');
  assert.equal(judge.model.id, 'claude-opus-5-5');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 5 })).level, 'judgment');
  const parked = stopped(R.choose('kill-mutant', 10_000, 5, { failures: 6 }));
  assert.equal(parked.reason, 'parked');
  assert.match(parked.detail, /6 failures/);
  assert.equal(chosen(router([], never, { failuresPerLevel: 1 }).choose('kill-mutant', 10_000, 5, { failures: 1 })).level, 'escalation');
  assert.equal(stopped(R.choose('kill-mutant', 10_000, 5, { failures: 4, excludeFamilies: ['anthropic'] })).reason, 'no-model', 'judgment is Claude only');
});

test('the daily budget stops dispatch when spent, and a task that would overrun it is not started', () => {
  const R = router();
  assert.equal(stopped(R.choose('kill-mutant', 10_000, 0)).reason, 'budget');
  assert.equal(stopped(R.choose('kill-mutant', 10_000, -1)).reason, 'budget');
  const tight = stopped(R.choose('kill-mutant', 10_000, 0.001));
  assert.equal(tight.reason, 'budget');
  assert.match(tight.detail, /no model fits/);
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 0.001305)).model.id, 'gpt-oss-120b', 'exactly enough');
  assert.equal(stopped(R.choose('kill-mutant', 10_000, 0.0015, { excludeFamilies: ['openai'] })).reason, 'budget', 'Haiku needs 0.0016');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 0.0016, { excludeFamilies: ['openai'] })).model.id, 'claude-haiku-5-5');
  assert.equal(stopped(R.choose('kill-mutant', 10_000, 0.03, { failures: 4 })).reason, 'budget', 'judgment costs more than is left');
  const spent = [r('a', 'k', true, { costUsd: 3.25 }), r('a', 'k', null, { costUsd: 0.5 }), r('a', 'k', true, { costUsd: 9, at: '2026-11-26T10:00:00Z' })];
  assert.equal(R.budgetLeft(5, spent), 1.25, "only today's spending counts");
  assert.equal(R.budgetLeft(3, spent), -0.75);
});

test('a task the model cannot hold, or a runner the dispatcher lacks, is not routed there', () => {
  const R = router();
  const big = { inputTokens: 150_000, outputTokens: 1000, largestRequest: 150_000 };
  assert.equal(chosen(R.choose('kill-mutant', big, 5)).model.id, 'deepseek-v4.1-flash', 'gpt-oss holds 131,072; Haiku is in its long tier');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { runners: ['claude-code'] })).model.id, 'claude-haiku-5-5');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { runners: ['openai-compatible'], failures: 2 })).model.id, 'gemini-3.8-flash');
  assert.equal(stopped(R.choose('kill-mutant', { inputTokens: 2_000_000, outputTokens: 0 }, 50)).reason, 'no-model');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { level: 'judgment' })).model.id, 'claude-opus-5-5');
});

test("a judge never comes from the claimant's family", () => {
  const R = router();
  for (const family of ['openai', 'anthropic', 'deepseek', 'google', 'alibaba', 'OpenAI']) {
    const j = chosen(R.chooseJudge(family));
    assert.notEqual(j.model.family, family.toLowerCase(), family);
  }
  assert.equal(chosen(R.chooseJudge('anthropic')).model.id, 'gpt-oss-120b');
  assert.equal(chosen(R.chooseJudge('openai')).model.id, 'claude-haiku-5-5');
  const trusted = router([...times(6, () => r('gemini-3.8-flash', 'judge', true)), ...times(6, () => r('gpt-oss-120b', 'judge', false))]);
  assert.equal(chosen(trusted.chooseJudge('anthropic')).model.id, 'gemini-3.8-flash', 'gpt-oss ruled out as a judge; the trusted judge goes');
  assert.equal(chosen(trusted.chooseJudge('google')).model.id, 'claude-haiku-5-5', 'the trusted judge is Google: a Google claim gets the cheapest other judge');
  const exploring = router(times(6, () => r('gemini-3.8-flash', 'judge', true)), always);
  assert.equal(chosen(exploring.chooseJudge('openai')).model.id, 'claude-haiku-5-5', 'at the exploration rate a cheaper unproven judge is tried');
  assert.throws(() => R.chooseJudge(' '), /claimant family is required/);
  assert.equal(stopped(R.chooseJudge('openai', 20_000, 0)).reason, 'budget');
});

test('a review panel takes one model per seat, from distinct families, cheapest first', () => {
  const R = router();
  const p = R.panel('review', 30_000, [
    { role: 'context-aided', families: ['anthropic'] },
    { role: 'unaided', families: ['google'] },
    { role: 'independent', families: ['openai', 'deepseek', 'alibaba'] },
  ]);
  assert.deepEqual(p.map((s) => [s.role, s.choice.stop ? s.choice.reason : s.choice.model.id]), [['context-aided', 'claude-haiku-5-5'], ['unaided', 'gemini-3.5-flash-lite'], ['independent', 'gpt-oss-120b']]);
  const clash = R.panel('review', 30_000, [{ role: 'a', families: ['openai', 'deepseek'] }, { role: 'b', families: ['openai'] }]);
  assert.equal(clash[1]!.choice.stop, true, 'the second seat may not reuse the first seat family');
});

test('pass rates for the morning report', () => {
  const R = router([...times(5, () => r('gpt-oss-120b', 'kill-mutant', true)), r('claude-haiku-5-5', 'fix-bug', false), r('retired-x', 'kill-mutant', true)]);
  assert.deepEqual(R.rates(), [
    { model: 'claude-haiku-5-5', kind: 'fix-bug', attempts: 1, passes: 0, lower: 0, costUsd: 0.001, standing: 'exploring' },
    { model: 'gpt-oss-120b', kind: 'kill-mutant', attempts: 5, passes: 5, lower: 0.566, costUsd: 0.005, standing: 'trusted' },
    { model: 'retired-x', kind: 'kill-mutant', attempts: 1, passes: 1, lower: 0.207, costUsd: 0.001, standing: 'exploring' },
  ]);
  assert.equal(R.levelFor(0), 'worker');
  assert.equal(R.levelFor(6), undefined);
});

test('a model that failed this task is passed over while its level has another, and given it again only if not', () => {
  const R = router();
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 1, avoid: ['gpt-oss-120b'] })).model.id, 'claude-haiku-5-5');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 3, avoid: ['gemini-3.8-flash'] })).model.id, 'claude-sonnet-5-5');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { failures: 5, avoid: ['claude-opus-5-5'] })).model.id, 'claude-opus-5-5', 'judgment has only Opus');
  assert.equal(chosen(R.choose('kill-mutant', 10_000, 5, { avoid: ['nothing-like-it'] })).model.id, 'gpt-oss-120b');
});
