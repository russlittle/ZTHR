import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlertRulesError, Dispatcher, RuleEngine, Silences, fingerprint, matches, parseMatcher } from './index.ts';
import type { Alert, Sample } from './index.ts';

const MIN = 60_000;
const cpu = (host: string, value: number, extra: Record<string, string> = {}): Sample => ({ metric: 'cpu', labels: { host, ...extra }, value });
const hot = { name: 'HighCpu', metric: 'cpu', op: '>' as const, threshold: 90, forMs: 5 * MIN, labels: { severity: 'page' } };

test('matchers: all four operators, anchored patterns, and a missing label is the empty string', () => {
  const l = { env: 'prod', team: 'core' };
  assert.equal(matches([parseMatcher('env="prod"')], l), true);
  assert.equal(matches([parseMatcher('env!="prod"')], l), false);
  assert.equal(matches([parseMatcher('env=~"prod|stage"')], l), true);
  assert.equal(matches([parseMatcher('env=~"pro"')], l), false, 'a pattern is anchored at both ends');
  assert.equal(matches([parseMatcher('team!~"co.*"')], l), false);
  assert.equal(matches([parseMatcher('region=""')], l), true, 'a missing label equals the empty string');
  assert.equal(matches([parseMatcher('region!=""')], l), false);
  assert.equal(matches([], l), true);
  assert.deepEqual(parseMatcher('a=b'), { name: 'a', op: '=', value: 'b' });
});

test('matchers: nonsense, a bad pattern and an oversized pattern are refused with plain messages', () => {
  assert.throws(() => parseMatcher('just words'), /not a matcher/);
  assert.throws(() => parseMatcher('a=~"("'), /not a valid pattern/);
  assert.throws(() => parseMatcher(`a=~"${'x'.repeat(201)}"`), /at most 200 characters/);
  assert.throws(() => parseMatcher('1a="x"'), AlertRulesError);
});

test('a rule is pending until the condition has held for the whole for-duration, then fires', () => {
  const e = new RuleEngine([hot]);
  let a = e.evaluate(0, [cpu('h1', 95)]);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.state, 'pending');
  assert.equal(a[0]!.value, 95);
  assert.deepEqual(a[0]!.labels, { host: 'h1', severity: 'page', alertname: 'HighCpu' });
  a = e.evaluate(4 * MIN, [cpu('h1', 96)]);
  assert.equal(a[0]!.state, 'pending');
  a = e.evaluate(5 * MIN, [cpu('h1', 97)]);
  assert.equal(a[0]!.state, 'firing');
  assert.equal(a[0]!.firedAt, 5 * MIN);
  assert.equal(a[0]!.activeAt, 0);
  assert.equal(a[0]!.value, 97);
});

test('a dip while pending restarts the clock and announces nothing; a dip while firing resolves once', () => {
  const e = new RuleEngine([hot]);
  e.evaluate(0, [cpu('h1', 95)]);
  assert.deepEqual(e.evaluate(2 * MIN, [cpu('h1', 10)]), [], 'a pending alert simply vanishes');
  e.evaluate(3 * MIN, [cpu('h1', 95)]);
  assert.equal(e.evaluate(8 * MIN, [cpu('h1', 95)])[0]!.state, 'firing');
  const r = e.evaluate(9 * MIN, [cpu('h1', 10)]);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.state, 'resolved');
  assert.equal(r[0]!.resolvedAt, 9 * MIN);
  assert.equal(r[0]!.firedAt, 8 * MIN);
  assert.deepEqual(e.evaluate(10 * MIN, [cpu('h1', 10)]), [], 'resolution is reported in one round only');
});

test('keep-firing-for holds a flapping alert up, then lets it resolve', () => {
  const e = new RuleEngine([{ ...hot, forMs: 0, keepFiringForMs: 10 * MIN }]);
  assert.equal(e.evaluate(0, [cpu('h1', 99)])[0]!.state, 'firing');
  assert.equal(e.evaluate(5 * MIN, [cpu('h1', 1)])[0]!.state, 'firing', 'still firing inside the keep window');
  assert.equal(e.evaluate(9 * MIN, [])[0]!.state, 'firing');
  assert.equal(e.evaluate(10 * MIN, [cpu('h1', 1)])[0]!.state, 'resolved');
});

test('a series that disappears counts as not holding; series are tracked independently', () => {
  const e = new RuleEngine([{ ...hot, forMs: 0 }]);
  const both = e.evaluate(0, [cpu('h1', 95), cpu('h2', 95), cpu('h3', 10)]);
  assert.deepEqual(both.map((a) => a.labels.host).sort(), ['h1', 'h2']);
  const next = e.evaluate(MIN, [cpu('h1', 95)]);
  const states = Object.fromEntries(next.map((a) => [a.labels.host, a.state]));
  assert.deepEqual(states, { h1: 'firing', h2: 'resolved' });
  assert.notEqual(both[0]!.fingerprint, both[1]!.fingerprint);
});

test('selectors, other metrics, NaN and thresholds: only what the rule names is judged', () => {
  const e = new RuleEngine([{ name: 'ProdCpu', metric: 'cpu', op: '>=', threshold: 50, selector: ['env="prod"'] }]);
  const a = e.evaluate(0, [cpu('a', 50, { env: 'prod' }), cpu('b', 80, { env: 'dev' }), { metric: 'mem', labels: { env: 'prod' }, value: 99 }, cpu('c', Number.NaN, { env: 'prod' })]);
  assert.deepEqual(a.map((x) => x.labels.host), ['a'], '>= holds at the threshold; NaN never holds');
});

test('rule definitions are checked: duplicate names, a non-finite threshold, a negative duration', () => {
  assert.throws(() => new RuleEngine([hot, hot]), /two rules are named "HighCpu"/);
  assert.throws(() => new RuleEngine([{ ...hot, threshold: Number.POSITIVE_INFINITY }]), /finite threshold/);
  assert.throws(() => new RuleEngine([{ ...hot, forMs: -1 }]), /negative duration/);
});

test('fingerprints ignore key order and differ when a value differs', () => {
  assert.equal(fingerprint({ a: '1', b: '2' }), fingerprint({ b: '2', a: '1' }));
  assert.notEqual(fingerprint({ a: '1' }), fingerprint({ a: '2' }));
  assert.equal(fingerprint({}).length, 16);
});

test('silences: active between their times, expirable, and never able to match everything', () => {
  const s = new Silences();
  const sil = s.create({ matchers: ['host="h1"'], startsAt: 100, endsAt: 200, createdBy: 'ana', comment: 'planned reboot' });
  assert.equal(s.state(sil.id, 99), 'pending');
  assert.equal(s.state(sil.id, 100), 'active');
  assert.equal(s.state(sil.id, 200), 'expired');
  assert.deepEqual(s.silencing({ host: 'h1' }, 150), [sil.id]);
  assert.deepEqual(s.silencing({ host: 'h2' }, 150), []);
  s.expire(sil.id, 120);
  assert.deepEqual(s.silencing({ host: 'h1' }, 150), []);
  assert.throws(() => s.create({ matchers: [], startsAt: 0, endsAt: 1, createdBy: 'a', comment: 'c' }), /at least one matcher/);
  assert.throws(() => s.create({ matchers: ['team=""', 'x!="y"'], startsAt: 0, endsAt: 1, createdBy: 'a', comment: 'c' }), /silence everything/);
  assert.throws(() => s.create({ matchers: ['a="b"'], startsAt: 5, endsAt: 5, createdBy: 'a', comment: 'c' }), /end after it starts/);
  assert.throws(() => s.create({ matchers: ['a="b"'], startsAt: 0, endsAt: 5, createdBy: 'a', comment: ' ' }), /who made it and why/);
  assert.throws(() => s.state('nope', 0), /no silence nope/);
});

const firing = (labels: Record<string, string>, firedAt = 0): Alert => {
  const l = { alertname: 'HighCpu', ...labels };
  return { rule: l.alertname, labels: l, annotations: {}, fingerprint: fingerprint(l), state: 'firing', value: 1, activeAt: firedAt, firedAt };
};
const tree = {
  receiver: 'default',
  groupBy: ['alertname', 'cluster'],
  groupWaitMs: 0,
  groupIntervalMs: 5 * MIN,
  repeatIntervalMs: 60 * MIN,
  routes: [
    { receiver: 'pager', match: ['severity="page"'], groupWaitMs: 0, routes: [{ receiver: 'db-pager', match: ['team="db"'] }] },
    { receiver: 'audit', match: ['env=~"prod.*"'], continue: true },
    { receiver: 'chat', match: ['severity="warn"'] },
  ],
};

test('routing: a matching child replaces its parent, the deepest wins, continue also tries the next sibling', () => {
  const d = new Dispatcher({ route: tree });
  const recv = (l: Record<string, string>) => d.process(10 * MIN, [firing(l)]).map((n) => n.receiver).sort();
  assert.deepEqual(recv({ severity: 'page', team: 'db', cluster: 'a' }), ['db-pager']);
  assert.deepEqual(new Dispatcher({ route: tree }).process(10 * MIN, [firing({ severity: 'page', cluster: 'b' })]).map((n) => n.receiver), ['pager']);
  assert.deepEqual(new Dispatcher({ route: tree }).process(10 * MIN, [firing({ env: 'prod-eu', severity: 'warn' })]).map((n) => n.receiver).sort(), ['audit', 'chat'], 'continue lets the next sibling match');
  assert.deepEqual(new Dispatcher({ route: tree }).process(10 * MIN, [firing({ severity: 'info' })]).map((n) => n.receiver), ['default']);
});

test('grouping: related alerts wait group-wait and leave as one message; group-by separates the rest', () => {
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['alertname', 'cluster'], groupWaitMs: 30_000 } });
  const a = [firing({ cluster: 'eu', host: 'h1' }), firing({ cluster: 'eu', host: 'h2' }), firing({ cluster: 'us', host: 'h3' })];
  assert.deepEqual(d.process(0, a), [], 'nothing leaves before group-wait');
  assert.deepEqual(d.process(29_000, a), []);
  const n = d.process(30_000, a);
  assert.equal(n.length, 2);
  const eu = n.find((x) => x.groupLabels.cluster === 'eu')!;
  assert.equal(eu.firing.length, 2);
  assert.equal(eu.reason, 'first');
  assert.deepEqual(eu.groupLabels, { alertname: 'HighCpu', cluster: 'eu' });
  assert.equal(n.find((x) => x.groupLabels.cluster === 'us')!.firing.length, 1);
});

test("grouping by '...' makes every alert its own group", () => {
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['...'], groupWaitMs: 0 } });
  assert.equal(d.process(0, [firing({ host: 'a' }), firing({ host: 'b' })]).length, 2);
});

test('timing: a changed set waits group-interval, an unchanged one repeats only after repeat-interval, once', () => {
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['alertname'], groupWaitMs: 0, groupIntervalMs: 5 * MIN, repeatIntervalMs: 60 * MIN } });
  const a1 = firing({ host: 'a' });
  const a2 = firing({ host: 'b' });
  assert.equal(d.process(0, [a1]).length, 1);
  assert.deepEqual(d.process(MIN, [a1]), [], 'unchanged: quiet');
  assert.deepEqual(d.process(2 * MIN, [a1, a2]), [], 'a new alert must wait for group-interval');
  const ch = d.process(5 * MIN, [a1, a2]);
  assert.equal(ch.length, 1);
  assert.equal(ch[0]!.reason, 'changed');
  assert.equal(ch[0]!.firing.length, 2);
  assert.deepEqual(d.process(64 * MIN, [a1, a2]), [], 'not yet 60 minutes since the last message');
  const rep = d.process(65 * MIN, [a1, a2]);
  assert.equal(rep[0]!.reason, 'repeat');
  assert.deepEqual(d.process(66 * MIN, [a1, a2]), []);
});

test('resolution: announced once with the alerts that cleared, then the group is forgotten', () => {
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['alertname'], groupWaitMs: 0, groupIntervalMs: 5 * MIN } });
  const a = firing({ host: 'a' });
  d.process(0, [a]);
  assert.deepEqual(d.process(MIN, [{ ...a, state: 'resolved', resolvedAt: MIN }]), [], 'paced by group-interval');
  const n = d.process(5 * MIN, []);
  assert.equal(n.length, 1);
  assert.equal(n[0]!.reason, 'resolved');
  assert.deepEqual(n[0]!.resolved.map((x) => x.labels.host), ['a']);
  assert.equal(n[0]!.firing.length, 0);
  assert.deepEqual(d.process(20 * MIN, []), []);
  assert.equal(d.process(21 * MIN, [firing({ host: 'a' })])[0]!.reason, 'first', 'a returning alert starts a new story');
});

test('silenced alerts send nothing, and one silenced after notifying is announced as cleared', () => {
  const silences = new Silences();
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['alertname'], groupWaitMs: 0, groupIntervalMs: MIN }, silences });
  const a = firing({ host: 'a' });
  const b = firing({ host: 'b' });
  silences.create({ matchers: ['host="a"'], startsAt: 0, endsAt: 100 * MIN, createdBy: 'ana', comment: 'reboot' });
  const n = d.process(0, [a, b]);
  assert.deepEqual(n[0]!.firing.map((x) => x.labels.host), ['b'], 'only the unsilenced alert is sent');
  silences.create({ matchers: ['host="b"'], startsAt: 0, endsAt: 100 * MIN, createdBy: 'ana', comment: 'also' });
  const r = d.process(2 * MIN, [a, b]);
  assert.equal(r[0]!.reason, 'resolved');
  assert.deepEqual(r[0]!.resolved.map((x) => x.labels.host), ['b']);
});

test('inhibition: a firing source mutes targets that agree on the named labels, and says which alert did it', () => {
  const inhibit = [{ source: ['severity="critical"'], target: ['severity="warning"'], equal: ['cluster'] }];
  const d = new Dispatcher({ route: { receiver: 'r', groupBy: ['...'], groupWaitMs: 0 }, inhibit });
  const crit = firing({ severity: 'critical', cluster: 'eu' });
  const warnEu = firing({ severity: 'warning', cluster: 'eu' });
  const warnUs = firing({ severity: 'warning', cluster: 'us' });
  const sent = d.process(0, [crit, warnEu, warnUs]).flatMap((n) => n.firing.map((x) => x.labels.cluster + '/' + x.labels.severity)).sort();
  assert.deepEqual(sent, ['eu/critical', 'us/warning']);
  assert.deepEqual(d.suppression(warnEu, [crit, warnEu], 0).inhibitedBy, [crit.fingerprint]);
  assert.deepEqual(d.suppression(crit, [crit], 0).inhibitedBy, [], 'an alert never inhibits itself');
  const sil = new Silences();
  sil.create({ matchers: ['severity="critical"'], startsAt: 0, endsAt: 10, createdBy: 'a', comment: 'c' });
  const d2 = new Dispatcher({ route: { receiver: 'r' }, inhibit, silences: sil });
  assert.deepEqual(d2.suppression(warnEu, [crit, warnEu], 1).inhibitedBy, [], 'a silenced source does not inhibit');
});

test('dedupe key: stable for the same receiver, group and sets; different when the set differs', () => {
  const o = { route: { receiver: 'r', groupBy: ['alertname'], groupWaitMs: 0 } };
  const k1 = new Dispatcher(o).process(0, [firing({ host: 'a' })])[0]!.dedupeKey;
  const k2 = new Dispatcher(o).process(7, [firing({ host: 'a' })])[0]!.dedupeKey;
  const k3 = new Dispatcher(o).process(0, [firing({ host: 'b' })])[0]!.dedupeKey;
  assert.equal(k1, k2, 'a retried sender computes the same key');
  assert.notEqual(k1, k3);
  assert.match(k1, /^[0-9a-f]{32}$/);
});

test('route trees are checked: a receiver is required and the root takes no matchers', () => {
  assert.throws(() => new Dispatcher({ route: {} }), /needs a receiver/);
  assert.throws(() => new Dispatcher({ route: { receiver: 'r', match: ['a="b"'] } }), /takes no matchers/);
});

test('end to end: rule, for-duration, route and resolution through one pipeline', () => {
  const engine = new RuleEngine([hot]);
  const d = new Dispatcher({ route: { receiver: 'team', groupBy: ['alertname'], groupWaitMs: 0, groupIntervalMs: MIN } });
  const sent: string[] = [];
  const step = (t: number, v: number) => d.process(t, engine.evaluate(t, [cpu('h1', v)])).forEach((n) => sent.push(`${t / MIN}:${n.reason}`));
  step(0, 95);
  step(3 * MIN, 95);
  step(5 * MIN, 95);
  step(6 * MIN, 95);
  step(7 * MIN, 10);
  step(8 * MIN, 10);
  assert.deepEqual(sent, ['5:first', '7:resolved']);
});
