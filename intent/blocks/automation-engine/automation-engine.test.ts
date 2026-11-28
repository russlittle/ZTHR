import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutomationError, Engine, TemplateError, evaluate, render, renderData } from './index.ts';
import type { Automation } from './index.ts';

const flush = () => new Promise<void>((r) => setImmediate(r));

function rig(start = Date.UTC(2026, 0, 5, 12, 0, 0), offsetMinutes = 0) {
  const states = new Map<string, string>();
  const calls: { service: string; data: Record<string, unknown> }[] = [];
  const events: { type: string; data: unknown }[] = [];
  const clock = { now: start };
  let n = 0;
  const engine = new Engine({
    now: () => clock.now,
    state: (e) => states.get(e),
    call: async (service, data) => {
      calls.push({ service, data: { ...data } });
      return { ok: true, service };
    },
    fire: (type, data) => events.push({ type, data }),
    newId: () => `run${++n}`,
    zoneOffsetMinutes: () => offsetMinutes,
  });
  return { engine, states, calls, events, clock };
}

const lamp: Automation = {
  id: 'a1',
  alias: 'Lamp',
  triggers: [{ platform: 'state', entity: 'binary_sensor.door', to: 'on' }],
  actions: [{ service: 'light.turn_on', data: { entity_id: 'light.hall', brightness: '{{ 100 + 55 }}' } }],
};

// ------------------------------------------------------------ templates

test('templates keep the type of a single expression and make text of a mixed one', () => {
  const vars = { a: { b: [10, 20, { c: 'deep' }] }, n: 4, name: 'Ana' };
  assert.equal(render('{{ a.b[1] }}', vars), 20);
  assert.equal(render('{{ a.b[2].c }}', vars), 'deep');
  assert.equal(render('Hello {{ name | upper }}, {{ n * 2.5 }} left', vars), 'Hello ANA, 10 left');
  assert.equal(render('{{ n > 3 and name == "Ana" }}', vars), true);
  assert.equal(render('plain text', vars), 'plain text');
  assert.equal(render('{{ missing.x.y | default("none") }}', vars), 'none');
  assert.equal(render('[{{ missing }}]', vars), '[]');
  assert.equal(render('{{ 7 // 2 }} {{ 7 % 4 }} {{ 7 / 2 }}', {}), '3 3 3.5');
  assert.equal(render('{{ "a" ~ 1 ~ "b" }}', {}), 'a1b');
  assert.equal(render('{{ 2 in [1, 2] }}', {}), true);
  assert.equal(render('{{ 3 not in [1, 2] }}', {}), true);
  assert.equal(render('{{ ["a", "b"] | join("-") }}', {}), 'a-b');
});

test('templates read states with a few named functions and filters round and convert', () => {
  const env = { state: (e: string) => ({ 'sensor.t': '21.456', 'light.x': 'on' })[e], now: () => 99 };
  assert.equal(render('{{ states("sensor.t") | float | round(1) }}', {}, env), 21.5);
  assert.equal(render('{{ is_state("light.x", "on") }}', {}, env), true);
  assert.equal(render('{{ is_state("light.x", ["off","unavailable"]) }}', {}, env), false);
  assert.equal(render('{{ states("sensor.nope") }}', {}, env), 'unknown');
  assert.equal(render('{{ "abc" | length }}', {}), 3);
  assert.equal(render('{{ "x" | int(7) }}', {}), 7);
  assert.equal(render('{{ max(3, 9, 4) - min(3, 9) }}', {}), 6);
  assert.equal(render('{{ now() }}', {}, env), 99);
  assert.equal(render('{{ "yes" | bool }}', {}), true);
});

test('templates cannot reach the prototype, call unlisted things, or run away', () => {
  const vars = { o: { a: 1 }, arr: [1] };
  assert.equal(evaluate('o.constructor', vars), undefined);
  assert.equal(evaluate('o.__proto__', vars), undefined);
  assert.equal(evaluate('o["constructor"]["constructor"]', vars), undefined);
  assert.equal(evaluate('constructor', vars), undefined);
  assert.equal(evaluate('toString', vars), undefined);
  assert.throws(() => evaluate('o.a.toString()', vars), TemplateError);
  assert.throws(() => evaluate('eval("1")', vars), /no function "eval"/);
  assert.throws(() => evaluate('1 | system', vars), /no filter "system"/);
  assert.throws(() => evaluate('1 / 0'), /division by zero/);
  assert.throws(() => evaluate('1 +'), TemplateError);
  assert.throws(() => evaluate('"open'), /unterminated/);
  assert.throws(() => evaluate('a; b'), TemplateError);
  assert.throws(() => render('{{ 1 }}'.repeat(1000)), /too long/);
  assert.throws(() => evaluate('"a" + 1'), /not a number/);
});

test('renderData renders every string and keeps the shape, and refuses absurd nesting', () => {
  const out = renderData({ a: '{{ 1 + 1 }}', b: ['x{{ 2 }}', 5, { c: '{{ true }}' }] }, {}, {}) as Record<string, unknown>;
  assert.deepEqual(out, { a: 2, b: ['x2', 5, { c: true }] });
  let deep: unknown = 'x';
  for (let i = 0; i < 30; i++) deep = [deep];
  assert.throws(() => renderData(deep, {}, {}), /nested too deeply/);
});

// ------------------------------------------------------------ triggers

test('a state trigger runs the actions with templates filled and leaves a trace', async () => {
  const { engine, calls } = rig();
  engine.add(lamp);
  assert.equal(engine.handleState('binary_sensor.door', 'off', 'off').length, 0, 'no change, no run');
  assert.equal(engine.handleState('binary_sensor.door', 'on', 'off').length, 0, 'wrong direction');
  const runs = engine.handleState('binary_sensor.door', 'off', 'on');
  assert.equal(runs.length, 1);
  const trace = await runs[0]!.done;
  assert.equal(trace.status, 'finished');
  assert.deepEqual(calls, [{ service: 'light.turn_on', data: { entity_id: 'light.hall', brightness: 155 } }]);
  assert.equal(trace.steps[0]?.path, 'action/0');
  assert.equal(trace.trigger.platform, 'state');
  assert.equal(trace.trigger.entity_id, 'binary_sensor.door');
  assert.equal(engine.tracesOf('a1').length, 1);
});

test('a state trigger with a hold fires only if the state stays, and a change cancels it', async () => {
  const { engine, calls, clock } = rig();
  engine.add({ ...lamp, triggers: [{ platform: 'state', entity: 'binary_sensor.door', to: 'on', forSeconds: 60 }] });
  engine.handleState('binary_sensor.door', 'off', 'on');
  assert.equal(engine.nextDue(), clock.now + 60_000);
  clock.now += 59_000;
  assert.equal(engine.tick().length, 0);
  clock.now += 1_000;
  const runs = engine.tick();
  assert.equal(runs.length, 1);
  await runs[0]!.done;
  assert.equal(calls.length, 1);
  assert.equal(engine.nextDue(), undefined);
  engine.handleState('binary_sensor.door', 'on', 'off');
  engine.handleState('binary_sensor.door', 'off', 'on');
  clock.now += 30_000;
  engine.handleState('binary_sensor.door', 'on', 'off');
  clock.now += 60_000;
  assert.equal(engine.tick().length, 0, 'it went off before the minute was up');
  engine.handleState('binary_sensor.door', 'off', 'on');
  engine.handleState('binary_sensor.door', 'on', 'on', { attr: 1 });
  clock.now += 60_000;
  assert.equal(engine.tick().length, 1, 'an attribute-only change does not cancel the hold');
});

test('a numeric trigger fires once on entering the range, and again only after leaving', async () => {
  const { engine, calls } = rig();
  engine.add({ id: 'n', alias: 'Hot', triggers: [{ platform: 'numeric_state', entity: 'sensor.t', above: 30 }], actions: [{ service: 'notify.send', data: { v: '{{ trigger.to_state }}' } }] });
  assert.equal(engine.handleState('sensor.t', '20', '29').length, 0);
  const a = engine.handleState('sensor.t', '29', '31');
  assert.equal(a.length, 1);
  assert.equal(engine.handleState('sensor.t', '31', '35').length, 0, 'still above');
  assert.equal(engine.handleState('sensor.t', '35', 'unavailable').length, 0);
  assert.equal(engine.handleState('sensor.t', 'unavailable', '40').length, 1, 'left the range, then entered again');
  await Promise.all(a.map((r) => r.done));
  assert.equal(calls[0]?.data.v, '31');
});

test('an event trigger matches the event type and every listed data field', async () => {
  const { engine, calls } = rig();
  engine.add({ id: 'e', alias: 'Button', triggers: [{ platform: 'event', eventType: 'button', data: { which: 'left' } }], actions: [{ service: 'scene.turn_on', data: { id: '{{ trigger.event.data.which }}' } }] });
  assert.equal(engine.handleEvent('button', { which: 'right' }).length, 0);
  assert.equal(engine.handleEvent('other', { which: 'left' }).length, 0);
  assert.equal(engine.handleEvent('button', { constructor: 1 }).length, 0);
  await engine.handleEvent('button', { which: 'left', extra: 1 })[0]!.done;
  assert.equal(calls[0]?.data.id, 'left');
});

test('a time trigger fires once a day at local time, and a pattern fires on each slot', async () => {
  const { engine, calls, clock } = rig(Date.UTC(2026, 0, 5, 6, 59, 0), 120);
  engine.add({ id: 't', alias: 'Morning', triggers: [{ platform: 'time', at: '09:00' }], actions: [{ service: 'light.turn_on' }] });
  assert.equal(engine.tick().length, 0, '08:59 local');
  clock.now += 60_000;
  const r = engine.tick();
  assert.equal(r.length, 1);
  await r[0]!.done;
  clock.now += 30_000;
  assert.equal(engine.tick().length, 0, 'not twice in the same day');
  clock.now += 86_400_000;
  const next = engine.tick();
  assert.equal(next.length, 1, 'again the next day');
  await next[0]!.done;
  assert.equal(calls.length, 2);
  const p = rig(0);
  p.engine.add({ id: 'p', alias: 'Pulse', triggers: [{ platform: 'time_pattern', everySeconds: 30 }], actions: [{ service: 'x.y' }] });
  assert.equal(p.engine.tick().length, 0, 'the first tick only learns where it is');
  p.clock.now += 29_000;
  assert.equal(p.engine.tick().length, 0);
  p.clock.now += 1_000;
  assert.equal(p.engine.tick().length, 1);
});

test('a template trigger fires when it turns true, not while it stays true', () => {
  const { engine, states } = rig();
  states.set('sensor.t', '10');
  engine.add({ id: 'tt', alias: 'Warm', triggers: [{ platform: 'template', valueTemplate: 'states("sensor.t") | float > 20' }], actions: [{ service: 'x.y' }] });
  engine.tick();
  states.set('sensor.t', '25');
  assert.equal(engine.handleState('sensor.t', '10', '25').length, 1);
  states.set('sensor.t', '26');
  assert.equal(engine.handleState('sensor.t', '25', '26').length, 0);
  states.set('sensor.t', '5');
  engine.handleState('sensor.t', '26', '5');
  states.set('sensor.t', '30');
  assert.equal(engine.handleState('sensor.t', '5', '30').length, 1);
});

test('a webhook trigger passes the payload to the run', async () => {
  const { engine, calls } = rig();
  engine.add({ id: 'w', alias: 'Hook', triggers: [{ platform: 'webhook', webhookId: 'abc' }], actions: [{ service: 'notify.send', data: { m: '{{ trigger.json.msg }}' } }] });
  assert.equal(engine.handleWebhook('zzz', {}).length, 0);
  await engine.handleWebhook('abc', { msg: 'hi' })[0]!.done;
  assert.equal(calls[0]?.data.m, 'hi');
});

// ------------------------------------------------------------ conditions

test('conditions form a tree, and the trace says which one failed', async () => {
  const { engine, states, calls } = rig(Date.UTC(2026, 0, 5, 23, 30, 0));
  states.set('person.ana', 'home');
  states.set('sensor.lux', '12');
  engine.add({
    ...lamp,
    conditions: [
      { condition: 'or', conditions: [{ condition: 'state', entity: 'person.ana', state: ['home', 'work'] }, { condition: 'state', entity: 'person.bo', state: 'home' }] },
      { condition: 'numeric_state', entity: 'sensor.lux', below: 20 },
      { condition: 'time', after: '22:00', before: '06:00' },
      { condition: 'not', conditions: [{ condition: 'template', valueTemplate: 'is_state("person.ana", "away")' }] },
      { condition: 'trigger', id: '0' },
    ],
  });
  const ok = await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done;
  assert.equal(ok.status, 'finished');
  assert.equal(calls.length, 1);
  states.set('sensor.lux', '40');
  const bad = await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done;
  assert.equal(bad.status, 'condition-failed');
  assert.match(bad.reason ?? '', /condition\/1: sensor.lux is 40, not below 20/);
  assert.equal(calls.length, 1, 'actions did not run');
  assert.equal(bad.steps[0]?.result, false);
});

test('a time window that crosses midnight and a weekday list are honoured', async () => {
  const { engine, clock } = rig(Date.UTC(2026, 0, 5, 3, 0, 0)); // a Monday, 03:00
  engine.add({ ...lamp, conditions: [{ condition: 'time', after: '22:00', before: '06:00', weekday: [1] }] });
  assert.equal((await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done).status, 'finished');
  clock.now = Date.UTC(2026, 0, 5, 12, 0, 0);
  const noon = await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done;
  assert.equal(noon.status, 'condition-failed');
  assert.match(noon.reason ?? '', /outside the time window/);
  clock.now = Date.UTC(2026, 0, 6, 3, 0, 0); // Tuesday
  const tue = await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done;
  assert.equal(tue.status, 'condition-failed');
  assert.match(tue.reason ?? '', /weekday 2/);
});

// ------------------------------------------------------------ modes

const slow = (mode: Automation['mode'], max?: number): Automation => ({
  id: 'm',
  alias: 'Slow',
  ...(mode ? { mode } : {}),
  ...(max !== undefined ? { max } : {}),
  triggers: [{ platform: 'event', eventType: 'go' }],
  actions: [{ service: 'a.start', data: { n: '{{ trigger.event.data.n }}' } }, { delay: 10 }, { service: 'a.end', data: { n: '{{ trigger.event.data.n }}' } }],
});

test('single mode refuses a second run while one is going, and says so in a trace', async () => {
  const { engine, calls, clock } = rig();
  engine.add(slow('single'));
  const first = engine.handleEvent('go', { n: 1 })[0]!;
  await flush();
  const second = engine.handleEvent('go', { n: 2 })[0]!;
  const rejected = await second.done;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'already running');
  clock.now += 10_000;
  engine.tick();
  assert.equal((await first.done).status, 'finished');
  assert.deepEqual(calls.map((c) => `${c.service}${c.data.n}`), ['a.start1', 'a.end1']);
  assert.equal(engine.runningCount('m'), 0);
});

test('restart mode stops the running copy and starts again', async () => {
  const { engine, calls, clock } = rig();
  engine.add(slow('restart'));
  const first = engine.handleEvent('go', { n: 1 })[0]!;
  await flush();
  const second = engine.handleEvent('go', { n: 2 })[0]!;
  assert.equal((await first.done).status, 'aborted');
  await flush();
  clock.now += 10_000;
  engine.tick();
  assert.equal((await second.done).status, 'finished');
  assert.deepEqual(calls.map((c) => `${c.service}${c.data.n}`), ['a.start1', 'a.start2', 'a.end2']);
});

test('queued mode runs one after another in order, and refuses past its limit', async () => {
  const { engine, calls, clock } = rig();
  engine.add(slow('queued', 3));
  const runs = [1, 2, 3, 4].map((n) => engine.handleEvent('go', { n })[0]!);
  const fourth = await runs[3]!.done;
  assert.equal(fourth.status, 'rejected');
  assert.equal(fourth.reason, 'the queue is full');
  await flush();
  assert.deepEqual(calls.map((c) => c.service + c.data.n), ['a.start1']);
  for (let i = 0; i < 3; i++) {
    clock.now += 10_000;
    engine.tick();
    await flush();
    await flush();
  }
  assert.deepEqual((await Promise.all(runs.slice(0, 3).map((r) => r.done))).map((t) => t.status), ['finished', 'finished', 'finished']);
  assert.deepEqual(calls.map((c) => c.service + c.data.n), ['a.start1', 'a.end1', 'a.start2', 'a.end2', 'a.start3', 'a.end3']);
});

test('parallel mode runs together up to its limit', async () => {
  const { engine, calls, clock } = rig();
  engine.add(slow('parallel', 2));
  const a = engine.handleEvent('go', { n: 1 })[0]!;
  const b = engine.handleEvent('go', { n: 2 })[0]!;
  const c = engine.handleEvent('go', { n: 3 })[0]!;
  assert.equal((await c.done).status, 'rejected');
  await flush();
  assert.equal(engine.runningCount('m'), 2);
  assert.equal(calls.filter((x) => x.service === 'a.start').length, 2);
  clock.now += 10_000;
  engine.tick();
  assert.deepEqual((await Promise.all([a.done, b.done])).map((t) => t.status), ['finished', 'finished']);
});

// ------------------------------------------------------------ actions

test('wait_template continues when the state changes, and times out with a clear failure', async () => {
  const { engine, states, calls, clock } = rig();
  const auto: Automation = {
    id: 'wt',
    alias: 'Wait',
    triggers: [{ platform: 'event', eventType: 'go' }],
    actions: [{ waitTemplate: 'is_state("binary_sensor.door", "off")', timeoutSeconds: 30 }, { service: 'light.turn_off' }],
  };
  engine.add(auto);
  states.set('binary_sensor.door', 'on');
  const r1 = engine.handleEvent('go')[0]!;
  await flush();
  assert.equal(calls.length, 0);
  states.set('binary_sensor.door', 'off');
  engine.handleState('binary_sensor.door', 'on', 'off');
  assert.equal((await r1.done).status, 'finished');
  assert.equal(calls.length, 1);
  states.set('binary_sensor.door', 'on');
  const r2 = engine.handleEvent('go')[0]!;
  await flush();
  clock.now += 31_000;
  engine.tick();
  const t2 = await r2.done;
  assert.equal(t2.status, 'error');
  assert.match(t2.reason ?? '', /timed out waiting/);
  engine.add({ ...auto, id: 'wt2', actions: [{ waitTemplate: 'false', timeoutSeconds: 1, continueOnTimeout: true }, { service: 'x.after', data: { done: '{{ wait.completed }}' } }] });
  engine.handleEvent('go');
  await flush();
  clock.now += 2_000;
  engine.tick();
  await flush();
  assert.equal(calls.at(-1)?.service, 'x.after');
  assert.equal(calls.at(-1)?.data.done, false);
});

test('if, choose, variables and response variables steer the run', async () => {
  const { engine, calls, states } = rig();
  states.set('sensor.mode', 'night');
  engine.add({
    id: 'c',
    alias: 'Control',
    variables: { level: '{{ 40 + 2 }}' },
    triggers: [{ platform: 'event', eventType: 'go' }],
    actions: [
      { variables: { double: '{{ level * 2 }}' } },
      { service: 'a.b', data: {}, responseVariable: 'res' },
      { if: [{ condition: 'template', valueTemplate: 'res.ok' }], then: [{ service: 'then.x', data: { d: '{{ double }}' } }], else: [{ service: 'else.x' }] },
      { choose: [{ conditions: [{ condition: 'state', entity: 'sensor.mode', state: 'day' }], sequence: [{ service: 'day.x' }] }, { conditions: [{ condition: 'state', entity: 'sensor.mode', state: 'night' }], sequence: [{ service: 'night.x' }] }], default: [{ service: 'none.x' }] },
    ],
  });
  const t = await engine.handleEvent('go')[0]!.done;
  assert.equal(t.status, 'finished');
  assert.deepEqual(calls.map((c) => c.service), ['a.b', 'then.x', 'night.x']);
  assert.equal(calls[1]?.data.d, 84);
  assert.ok(t.steps.some((s) => s.path === 'action/2/then/0'));
  assert.ok(t.steps.some((s) => s.path === 'action/3/choose/1/sequence/0'));
});

test('repeat by count, for each, while and until, with the loop variable', async () => {
  const { engine, calls } = rig();
  const run = async (actions: Automation['actions']) => {
    calls.length = 0;
    engine.add({ id: 'r', alias: 'Rep', triggers: [{ platform: 'event', eventType: 'go' }], actions });
    return engine.handleEvent('go')[0]!.done;
  };
  await run([{ repeat: { count: 3, sequence: [{ service: 'x.y', data: { i: '{{ repeat.index }}', last: '{{ repeat.last }}' } }] } }]);
  assert.deepEqual(calls.map((c) => [c.data.i, c.data.last]), [[1, false], [2, false], [3, true]]);
  await run([{ repeat: { forEach: ['a', 'b'], sequence: [{ service: 'x.y', data: { item: '{{ repeat.item }}' } }] } }]);
  assert.deepEqual(calls.map((c) => c.data.item), ['a', 'b']);
  await run([{ repeat: { until: [{ condition: 'template', valueTemplate: 'repeat.index >= 2' }], sequence: [{ service: 'x.y' }] } }]);
  assert.equal(calls.length, 2);
  await run([{ repeat: { while: [{ condition: 'template', valueTemplate: 'false' }], sequence: [{ service: 'x.y' }] } }]);
  assert.equal(calls.length, 0);
  await run([{ repeat: { count: 0, sequence: [{ service: 'x.y' }] } }]);
  assert.equal(calls.length, 0);
});

test('an endless repeat and a huge count are stopped', async () => {
  const { engine } = rig();
  engine.add({ id: 'r', alias: 'Rep', triggers: [{ platform: 'event', eventType: 'go' }], actions: [{ repeat: { while: [{ condition: 'template', valueTemplate: 'true' }], sequence: [{ variables: { x: '1' } }] } }] });
  const t = await engine.handleEvent('go')[0]!.done;
  assert.equal(t.status, 'error');
  assert.match(t.reason ?? '', /more than 1000 times/);
  engine.add({ id: 'r2', alias: 'Rep2', triggers: [{ platform: 'event', eventType: 'go2' }], actions: [{ repeat: { count: 5000, sequence: [{ variables: { x: '1' } }] } }] });
  assert.match((await engine.handleEvent('go2')[0]!.done).reason ?? '', /at most 1000/);
});

test('parallel branches run together and stop ends the run with its reason', async () => {
  const { engine, calls, events, clock } = rig();
  engine.add({
    id: 'p',
    alias: 'Par',
    triggers: [{ platform: 'event', eventType: 'go' }],
    actions: [
      { parallel: [[{ delay: 5 }, { service: 'a.late' }], [{ service: 'a.early' }]] },
      { event: 'done', eventData: { n: '{{ 1 + 1 }}' } },
      { stop: 'enough', error: false },
      { service: 'never.x' },
    ],
  });
  const r = engine.handleEvent('go')[0]!;
  await flush();
  assert.deepEqual(calls.map((c) => c.service), ['a.early']);
  clock.now += 5_000;
  engine.tick();
  const t = await r.done;
  assert.equal(t.status, 'stopped');
  assert.equal(t.reason, 'enough');
  assert.deepEqual(calls.map((c) => c.service), ['a.early', 'a.late']);
  assert.deepEqual(events, [{ type: 'done', data: { n: 2 } }]);
});

test('a failing action ends the run in error, unless told to continue, and a failed condition step stops quietly', async () => {
  const states = new Map<string, string>();
  const engine = new Engine({ now: () => 1, state: (e) => states.get(e), call: async (s) => { if (s === 'bad.call') throw new Error('device offline'); return null; }, newId: (() => { let n = 0; return () => `r${++n}`; })() });
  engine.add({ id: 'f', alias: 'Fail', triggers: [{ platform: 'event', eventType: 'go' }], actions: [{ service: 'bad.call' }, { service: 'next.x' }] });
  const t = await engine.handleEvent('go')[0]!.done;
  assert.equal(t.status, 'error');
  assert.match(t.reason ?? '', /action\/0: device offline/);
  assert.equal(t.steps.at(-1)?.error, 'device offline');
  engine.add({ id: 'g', alias: 'Go on', triggers: [{ platform: 'event', eventType: 'go' }], actions: [{ service: 'bad.call', continueOnError: true }, { enabled: false, service: 'skipped.x' }, { condition: { condition: 'state', entity: 'x.y', state: 'on' } }, { service: 'after.x' }] });
  const g = (await Promise.all(engine.handleEvent('go').map((r) => r.done))).find((x) => x.automationId === 'g')!;
  assert.equal(g.status, 'stopped');
  assert.deepEqual(g.steps.map((s) => s.type), ['error', 'skipped', 'condition']);
  const bad = new Engine({ now: () => 1, state: () => undefined, call: async () => null, newId: () => 'x' });
  bad.add({ id: 'h', alias: 'Hostile', triggers: [{ platform: 'event', eventType: 'go' }], actions: [{ service: '{{ evil }}' }] });
  assert.match((await bad.handleEvent('go')[0]!.done).reason ?? '', /not a service name/);
});

test('only the last five traces are kept, and disabling or removing stops new runs', async () => {
  const { engine } = rig();
  engine.add(lamp);
  for (let i = 0; i < 8; i++) {
    await engine.handleState('binary_sensor.door', 'off', 'on')[0]!.done;
  }
  assert.deepEqual(engine.tracesOf('a1').map((t) => t.runId), ['run4', 'run5', 'run6', 'run7', 'run8']);
  engine.setEnabled('a1', false);
  assert.equal(engine.handleState('binary_sensor.door', 'off', 'on').length, 0);
  engine.setEnabled('a1', true);
  engine.remove('a1');
  assert.equal(engine.handleState('binary_sensor.door', 'off', 'on').length, 0);
  assert.throws(() => engine.setEnabled('a1', true), AutomationError);
});

test('removing an automation stops a run that is waiting', async () => {
  const { engine } = rig();
  engine.add(slow('single'));
  const r = engine.handleEvent('go', { n: 1 })[0]!;
  await flush();
  engine.remove('m');
  assert.equal((await r.done).status, 'aborted');
});

test('a manual trigger can skip conditions', async () => {
  const { engine, calls } = rig();
  engine.add({ ...lamp, conditions: [{ condition: 'template', valueTemplate: 'false' }] });
  assert.equal((await engine.trigger('a1').done).status, 'condition-failed');
  assert.equal((await engine.trigger('a1', {}, true).done).status, 'finished');
  assert.equal(calls.length, 1);
  assert.throws(() => engine.trigger('nope'), /no automation/);
});

test('bad definitions are refused when added', () => {
  const { engine } = rig();
  const base = { id: 'x', alias: 'X', actions: [] };
  assert.throws(() => engine.add({ ...base, triggers: [] }), /at least one trigger/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'time', at: '25:00' }] }), /not a time of day/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'time_pattern', everySeconds: 0 }] }), /whole seconds/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'numeric_state', entity: 'a.b' }] }), /above or below/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'template', valueTemplate: '1 +' }] }), TemplateError);
  assert.throws(() => engine.add({ ...base, max: 0, triggers: [{ platform: 'event', eventType: 'a' }] }), /max must be/);
  assert.throws(() => engine.add({ ...base, mode: 'chaos' as 'single', triggers: [{ platform: 'event', eventType: 'a' }] }), /unknown mode/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'event', eventType: 'a' }], actions: [{ delay: 'soon' }] }), /not a duration/);
  assert.throws(() => engine.add({ ...base, triggers: [{ platform: 'event', eventType: 'a' }], actions: [{ repeat: { sequence: [] } }] }), /needs count/);
});
