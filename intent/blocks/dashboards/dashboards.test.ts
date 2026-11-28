import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ViewEngine } from '../view-engine/index.ts';
import type { Node, Person, TableDef } from '../view-engine/index.ts';
import { BadLayout, DashboardError, Dashboards, NotAllowed, NotFound, VersionConflict, bucketStart, compact, interpolateNode, interpolateText, parseInterval, place, resolveRange, timeExpr, validateLayout } from './index.ts';
import type { Fetch, Panel, Resolved } from './index.ts';

const NY = 'America/New_York';
const NOW = new Date('2026-06-15T12:00:00Z');
const EVENTS: TableDef = { name: 'events', fields: [{ name: 'id', type: 'number' }, { name: 'ts', type: 'date' }, { name: 'region', type: 'select' }, { name: 'amount', type: 'number' }, { name: 'user', type: 'text' }, { name: 'secret', type: 'text', sensitive: true }] };
const rows = [
  { id: 1, ts: '2026-06-12T10:00:00Z', region: 'eu', amount: 10, user: 'ana', secret: 's1' },
  { id: 2, ts: '2026-06-13T03:00:00Z', region: 'eu', amount: 20, user: 'ben', secret: 's2' },
  { id: 3, ts: '2026-06-13T15:00:00Z', region: 'us', amount: 30, user: 'cy', secret: 's3' },
  { id: 4, ts: '2026-06-14T23:30:00Z', region: 'us', amount: 40, user: 'ana', secret: 's4' },
  { id: 5, ts: '2026-06-15T01:00:00Z', region: 'eu', amount: 50, user: 'ben', secret: 's5' },
  { id: 6, ts: '2026-06-10T00:00:00Z', region: 'eu', amount: 100, user: 'cy', secret: 's6' },
];
const ana: Person = { id: 'ana' };
const ben: Person = { id: 'ben' };
const cy: Person = { id: 'cy' };
const root: Person = { id: 'root', admin: true };

const make = () => {
  let n = 0;
  const engine = new ViewEngine({ tables: [EVENTS], access: { canRead: (who, _t, f) => !(who === 'cy' && f === 'secret') && !(who.startsWith('link:') && f === 'secret') } });
  const dash = new Dashboards({ engine, now: () => NOW, id: () => `d${++n}`, scopeFor: (who, table) => (who.id === 'ben' && table === 'events' ? ({ kind: 'cmp', path: ['region'], op: 'eq', value: 'eu' } as Node) : undefined) });
  const seen: unknown[] = [];
  const fetch: Fetch = (_t, c) => { seen.push(c); return rows; };
  return { dash, engine, fetch, seen };
};

const panel = (id: number, o: Partial<Panel> & { grid?: Panel['grid'] } = {}): Panel => ({ id, title: `P${id}`, type: 'stat', grid: { x: 0, y: (id - 1) * 4, w: 12, h: 4 }, query: { table: 'events', measure: { agg: 'count' }, timeField: 'ts' }, ...o });
const R = (name: string, values: string[], all = false): Resolved => ({ name, values, all, options: values });

test('time expressions: relative offsets, rounding in the time zone, and ISO times', () => {
  assert.equal(timeExpr('now', NOW, NY).toISOString(), '2026-06-15T12:00:00.000Z');
  assert.equal(timeExpr('now-6h', NOW, NY).toISOString(), '2026-06-15T06:00:00.000Z');
  assert.equal(timeExpr('now+1d', NOW, 'UTC').toISOString(), '2026-06-16T12:00:00.000Z');
  assert.equal(timeExpr('now/d', NOW, NY).toISOString(), '2026-06-15T04:00:00.000Z', 'start of the day in New York is 04:00Z in June');
  assert.equal(timeExpr('now-1d/d', NOW, NY).toISOString(), '2026-06-14T04:00:00.000Z');
  assert.equal(timeExpr('now/d', NOW, NY, true).toISOString(), '2026-06-16T03:59:59.999Z', 'the end of the day is the last millisecond');
  assert.equal(timeExpr('now/w', NOW, 'UTC').toISOString(), '2026-06-15T00:00:00.000Z', '15 June 2026 is a Monday');
  assert.equal(timeExpr('now-1d/w', NOW, 'UTC').toISOString(), '2026-06-08T00:00:00.000Z');
  assert.equal(timeExpr('now/M', NOW, 'UTC').toISOString(), '2026-06-01T00:00:00.000Z');
  assert.equal(timeExpr('now/y', NOW, 'UTC').toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(timeExpr('now-2M', NOW, 'UTC').toISOString().slice(0, 10), '2026-04-15');
  assert.equal(timeExpr('2026-01-02T03:04:05Z', NOW, NY).toISOString(), '2026-01-02T03:04:05.000Z');
  for (const bad of ['yesterday', 'now-6x', 'now--1h', 'now-h', '2026-01-02', 'now/q']) assert.throws(() => timeExpr(bad, NOW, 'UTC'), DashboardError, bad);
  assert.throws(() => timeExpr('2026-13-45T99:00:00Z', NOW, 'UTC'), /not a time/);
});

test('a range must run forward and not span more than ten years', () => {
  const r = resolveRange({ from: 'now-7d/d', to: 'now/d' }, NOW, 'UTC');
  assert.deepEqual([r.from.toISOString(), r.to.toISOString()], ['2026-06-08T00:00:00.000Z', '2026-06-15T23:59:59.999Z']);
  assert.throws(() => resolveRange({ from: 'now', to: 'now-1h' }, NOW, 'UTC'), /end after it starts/);
  assert.throws(() => resolveRange({ from: '2000-01-01T00:00:00Z', to: 'now' }, NOW, 'UTC'), /ten years/);
});

test('text variables read as their value, as a list, or as All', () => {
  const v = { region: R('region', ['eu', 'us']), team: R('team', ['a'], false), env: R('env', ['x', 'y'], true) };
  assert.equal(interpolateText('Sales in $region', v), 'Sales in eu,us');
  assert.equal(interpolateText('${region:pipe} / ${region:text} / ${team}', v), 'eu|us / eu + us / a');
  assert.equal(interpolateText('$env and $unknown', v), 'All and $unknown');
});

test('variables go into a filter as values: multi-select turns equals into in, All removes the comparison, unknown is refused', () => {
  const eq = (f: string, value: unknown, op = 'eq'): Node => ({ kind: 'cmp', path: [f], op, value }) as Node;
  assert.deepEqual(interpolateNode(eq('region', '$region'), { region: R('region', ['eu']) }), eq('region', 'eu'));
  assert.deepEqual(interpolateNode(eq('region', '${region}'), { region: R('region', ['eu', 'us']) }), eq('region', ['eu', 'us'], 'in'));
  assert.deepEqual(interpolateNode(eq('region', '$region', 'ne'), { region: R('region', ['eu', 'us']) }), eq('region', ['eu', 'us'], 'nin'));
  assert.deepEqual(interpolateNode(eq('region', ['$region', 'asia'], 'in'), { region: R('region', ['eu', 'us']) }), eq('region', ['eu', 'us', 'asia'], 'in'));
  assert.equal(interpolateNode(eq('region', '$region'), { region: R('region', ['eu', 'us'], true) }), undefined);
  assert.deepEqual(interpolateNode({ kind: 'and', children: [eq('region', '$region'), eq('user', 'ana')] }, { region: R('region', [], true) }), eq('user', 'ana'), 'the rest of the filter survives');
  assert.throws(() => interpolateNode(eq('region', '$nope'), {}), /not a variable/);
  assert.throws(() => interpolateNode(eq('amount', '$many', 'gt'), { many: R('many', ['1', '2']) }), /several values/);
  assert.deepEqual(interpolateNode(eq('user', 'a$b'), {}), eq('user', 'a$b'), 'a dollar sign inside a value is just text');
});

test('layout: inside the grid, no overlaps, unique ids; panels compact upward; new ones find a free spot', () => {
  const p = (id: number, x: number, y: number, w: number, h: number): Panel => ({ id, title: 't', type: 'text', grid: { x, y, w, h } });
  validateLayout([p(1, 0, 0, 12, 4), p(2, 12, 0, 12, 4), p(3, 0, 4, 24, 2)]);
  const bad = (ps: Panel[], re: RegExp) => assert.throws(() => validateLayout(ps), (e: unknown) => e instanceof BadLayout && re.test((e as Error).message));
  bad([p(1, 0, 0, 12, 4), p(2, 11, 3, 12, 4)], /1 and 2 overlap/);
  bad([p(1, 20, 0, 6, 2)], /past the 24-column grid/);
  bad([p(1, 0, 0, 2, 2), p(1, 5, 0, 2, 2)], /used twice/);
  bad([p(0, 0, 0, 2, 2)], /ids are whole numbers from 1/);
  bad([p(1, -1, 0, 2, 2)], /cannot be negative/);
  bad([p(1, 0, 0, 0, 2)], /width is 1 to 24/);
  bad([p(1, 0.5, 0, 2, 2)], /whole numbers/);
  const c = compact([p(1, 0, 0, 12, 4), p(2, 12, 9, 12, 4), p(3, 0, 20, 24, 2), p(4, 0, 8, 6, 2)]);
  assert.deepEqual(Object.fromEntries(c.map((x) => [x.id, [x.grid.x, x.grid.y]])), { 1: [0, 0], 2: [12, 0], 4: [0, 4], 3: [0, 6] });
  assert.deepEqual(place([p(1, 0, 0, 12, 4)], { w: 12, h: 4 }), { x: 12, y: 0, w: 12, h: 4 });
  assert.deepEqual(place([p(1, 0, 0, 24, 4)], { w: 6, h: 3 }), { x: 0, y: 4, w: 6, h: 3 });
  assert.throws(() => place([], { w: 30, h: 1 }), BadLayout);
});

test('a dashboard is checked when saved: title, uid, zone, refresh, variables, panels and their queries', () => {
  const { dash } = make();
  const bad = (i: Parameters<Dashboards['create']>[1], re: RegExp) => assert.throws(() => dash.create(ana, i), re);
  bad({ title: '' }, /title of 1 to 120/);
  bad({ title: 'x', uid: 'has space' }, /uid is 1 to 40/);
  bad({ title: 'x', timezone: 'Mars/Base' }, /not a time zone/);
  bad({ title: 'x', time: { from: 'now', to: 'now-1h' } }, /end after it starts/);
  bad({ title: 'x', refresh: '1s' }, /faster than every 5 seconds/);
  bad({ title: 'x', refresh: 'often' }, /refresh looks like/);
  bad({ title: 'x', variables: [{ name: 'a b', kind: 'constant', value: '1' }] }, /variable name/);
  bad({ title: 'x', variables: [{ name: 'a', kind: 'constant', value: '1' }, { name: 'a', kind: 'constant', value: '2' }] }, /defined twice/);
  bad({ title: 'x', variables: [{ name: 'a', kind: 'custom', options: [] }] }, /1 to 200 options/);
  bad({ title: 'x', variables: [{ name: 'a', kind: 'interval', options: ['fast'] }] }, /not an interval/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'events', measure: { agg: 'sum' } } })] }, /sum needs a field/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'events', measure: { agg: 'sum', field: 'user' } } })] }, /needs a number field/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'events', measure: { agg: 'count' }, groupBy: 'colour' } })] }, /no field colour/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'ghosts', measure: { agg: 'count' } } })] }, /no table ghosts/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'events', measure: { agg: 'count' }, interval: '1h' } })] }, /interval needs a timeField/);
  bad({ title: 'x', panels: [panel(1, { type: 'timeseries', query: { table: 'events', measure: { agg: 'count' } } })] }, /needs a timeField/);
  bad({ title: 'x', panels: [panel(1, { query: { table: 'events', measure: { agg: 'count' }, filter: { kind: 'cmp', path: ['region'], op: 'eq', value: '$missing' } } })] }, /not a variable of this dashboard/);
  bad({ title: 'x', panels: [{ id: 1, title: 'T', type: 'text', grid: { x: 0, y: 0, w: 2, h: 2 }, query: { table: 'events', measure: { agg: 'count' } } }] }, /text panel has no query/);
  bad({ title: 'x', panels: Array.from({ length: 61 }, (_, i) => ({ id: i + 1, title: 't', type: 'text' as const, grid: { x: 0, y: i * 2, w: 2, h: 2 } })) }, /at most 60 panels/);
  const ok = dash.create(ana, { title: ' Sales ', uid: 'sales', timezone: NY, refresh: '30s', tags: ['sales'] });
  assert.deepEqual([ok.uid, ok.title, ok.time, ok.version], ['sales', 'Sales', { from: 'now-6h', to: 'now' }, 1]);
  assert.throws(() => dash.create(ana, { title: 'again', uid: 'sales' }), /already exists/);
});

test('sharing: viewers see, editors change, only the owner shares or deletes, versions guard edits', () => {
  const { dash } = make();
  dash.create(ana, { title: 'Ops', uid: 'ops', tags: ['ops'] });
  assert.throws(() => dash.see(ben, 'ops'), NotFound);
  assert.deepEqual(dash.list(ben), []);
  dash.share(ana, 'ops', 'ben', 'viewer');
  dash.share(ana, 'ops', 'cy', 'editor');
  assert.deepEqual(dash.list(ben).map((d) => d.uid), ['ops']);
  assert.throws(() => dash.update(ben, 'ops', { title: 'Mine' }, 3), NotAllowed);
  assert.equal(dash.update(cy, 'ops', { title: 'Operations' }, 3).version, 4);
  assert.throws(() => dash.update(ana, 'ops', { title: 'Late' }, 3), VersionConflict);
  assert.throws(() => dash.share(cy, 'ops', 'ben', 'editor'), /only the owner/);
  assert.throws(() => dash.delete(cy, 'ops'), /only the owner/);
  assert.throws(() => dash.share(ana, 'ops', 'ana', 'viewer'), /owner already has/);
  assert.equal(dash.unshare(ana, 'ops', 'ben').shares.length, 1);
  assert.throws(() => dash.see(ben, 'ops'), NotFound);
  assert.deepEqual(dash.list(root, { tag: 'ops' }).map((d) => d.uid), ['ops'], 'an admin sees everything');
  assert.deepEqual(dash.list(ana, { text: 'oper' }).length, 1);
  dash.delete(ana, 'ops');
  assert.throws(() => dash.get('ops'), NotFound);
});

test('variable picks must be among the options, "All" needs includeAll, and query variables list only what the person may see', async () => {
  const { dash, fetch } = make();
  const d = dash.create(ana, { title: 'V', uid: 'v', variables: [
    { name: 'region', kind: 'query', table: 'events', field: 'region', multi: true, includeAll: true },
    { name: 'step', kind: 'interval', options: ['1h', '1d'], current: ['1d'] },
    { name: 'who', kind: 'textbox', default: 'ana' },
    { name: 'env', kind: 'constant', value: 'prod' },
    { name: 'pick', kind: 'custom', options: ['a', 'b'] },
  ] });
  const v = await dash.resolveVariables(ana, d, {}, fetch);
  assert.deepEqual(v.region, { name: 'region', values: ['eu', 'us'], all: true, options: ['eu', 'us'] });
  assert.deepEqual([v.step!.values, v.who!.values, v.env!.values, v.pick!.values], [['1d'], ['ana'], ['prod'], ['a']]);
  const benV = await dash.resolveVariables(ben, d, { region: ['eu'] }, fetch);
  assert.deepEqual(benV.region!.options, ['eu'], 'ben\'s row scope limits the options he is offered');
  await assert.rejects(() => dash.resolveVariables(ana, d, { pick: ['c'] }, fetch), /not one of the choices for pick/);
  await assert.rejects(() => dash.resolveVariables(ana, d, { pick: ['a', 'b'] }, fetch), /takes one value/);
  await assert.rejects(() => dash.resolveVariables(ana, d, { region: ['asia'] }, fetch), /not one of the choices/);
  await assert.rejects(() => dash.resolveVariables(ana, d, { pick: ['$__all'] }, fetch), /no All option/);
  await assert.rejects(() => dash.resolveVariables(ana, d, { who: ['a\u0000b'] }, fetch), /no control characters/);
  await assert.rejects(() => dash.resolveVariables(ana, d, { who: ['x'.repeat(201)] }, fetch), /up to 200 characters/);
  assert.equal((await dash.resolveVariables(ana, d, { region: ['eu', 'us'] }, fetch)).region!.all, false);
});

test('a stat panel sums only what the person\'s row scope allows, over the time range', async () => {
  const { dash, fetch, seen } = make();
  const d = dash.create(ana, { title: 'T', uid: 't', time: { from: 'now-3d', to: 'now' }, panels: [panel(1, { query: { table: 'events', measure: { agg: 'sum', field: 'amount' }, timeField: 'ts' } })] });
  assert.equal((await dash.runPanel(ana, d, 1, { vars: {}, fetch })).value, 140, 'rows 2 to 5 fall in the last three days');
  const benD = dash.share(ana, 't', 'ben', 'viewer');
  assert.equal((await dash.runPanel(ben, benD, 1, { vars: {}, fetch })).value, 70, 'ben sees only eu rows');
  assert.equal((seen.at(-1) as { filter: Node }).filter.kind, 'cmp', 'the scope reached the data layer');
  assert.equal((await dash.runPanel(ana, d, 1, { vars: {}, fetch, range: { from: 'now-30d', to: 'now' } })).value, 250);
  await assert.rejects(() => dash.runPanel(cy, d, 1, { vars: {}, fetch }), NotFound);
  await assert.rejects(() => dash.runPanel(ana, d, 9, { vars: {}, fetch }), /no panel 9/);
});

test('a time series buckets by day in the dashboard\'s own time zone', async () => {
  const { dash, fetch } = make();
  const q = { table: 'events', measure: { agg: 'sum' as const, field: 'amount' }, timeField: 'ts', interval: '1d' };
  const ny = dash.create(ana, { title: 'NY', uid: 'ny', timezone: NY, time: { from: 'now-3d', to: 'now' }, panels: [panel(1, { type: 'timeseries', query: q })] });
  const utc = dash.create(ana, { title: 'UTC', uid: 'utc', timezone: 'UTC', time: { from: 'now-3d', to: 'now' }, panels: [panel(1, { type: 'timeseries', query: q })] });
  const day = (t: number) => new Date(t).toISOString().slice(0, 13);
  const a = await dash.runPanel(ana, ny, 1, { vars: {}, fetch });
  assert.deepEqual(a.series![0]!.points.map(([t, v]) => [day(t), v]), [['2026-06-12T04', 20], ['2026-06-13T04', 30], ['2026-06-14T04', 90]]);
  const b = await dash.runPanel(ana, utc, 1, { vars: {}, fetch });
  assert.deepEqual(b.series![0]!.points.map(([t, v]) => [day(t), v]), [['2026-06-13T00', 50], ['2026-06-14T00', 40], ['2026-06-15T00', 50]]);
});

test('group-by makes one series per value, capped, and variables filter the panel', async () => {
  const { dash, fetch } = make();
  const d = dash.create(ana, { title: 'G', uid: 'g', time: { from: 'now-3d', to: 'now' }, variables: [{ name: 'region', kind: 'custom', options: ['eu', 'us'], multi: true, includeAll: true }], panels: [
    panel(1, { type: 'bar', title: 'By user in $region', query: { table: 'events', measure: { agg: 'count' }, groupBy: 'user', timeField: 'ts', filter: { kind: 'cmp', path: ['region'], op: 'eq', value: '$region' } } }),
  ] });
  const all = await dash.runPanel(ana, d, 1, { vars: await dash.resolveVariables(ana, d, { region: ['$__all'] }, fetch), fetch });
  assert.equal(all.title, 'By user in All');
  assert.deepEqual(all.series!.map((s) => [s.name, s.points.reduce((a, [, v]) => a + (v ?? 0), 0)]), [['ana', 1], ['ben', 2], ['cy', 1]]);
  const eu = await dash.runPanel(ana, d, 1, { vars: await dash.resolveVariables(ana, d, { region: ['eu'] }, fetch), fetch });
  assert.deepEqual(eu.series!.map((s) => [s.name, s.points.reduce((a, [, v]) => a + (v ?? 0), 0)]), [['ben', 2]]);
  const capped = new Dashboards({ engine: make().engine, now: () => NOW, maxSeries: 2 });
  const d2 = capped.create(ana, { title: 'C', uid: 'c', time: { from: 'now-3d', to: 'now' }, panels: [panel(1, { query: { table: 'events', measure: { agg: 'count' }, groupBy: 'user', timeField: 'ts' }, type: 'bar' })] });
  const r = await capped.runPanel(ana, d2, 1, { vars: {}, fetch });
  assert.deepEqual([r.series!.length, r.truncated], [2, true]);
});

test('a dashboard shared with someone never shares fields they cannot read', async () => {
  const { dash, fetch } = make();
  const d = dash.create(ana, { title: 'Sec', uid: 'sec', time: { from: 'now-30d', to: 'now' }, panels: [
    panel(1, { type: 'table', query: { table: 'events', measure: { agg: 'count' } } }),
    panel(2, { query: { table: 'events', measure: { agg: 'count' }, filter: { kind: 'cmp', path: ['secret'], op: 'eq', value: 's3' } } }),
    panel(3, { query: { table: 'events', measure: { agg: 'count' }, groupBy: 'secret' }, type: 'bar' }),
  ] });
  dash.share(ana, 'sec', 'cy', 'viewer');
  const asAna = await dash.runPanel(ana, d, 1, { vars: {}, fetch });
  assert.equal(Object.hasOwn(asAna.rows![0]!, 'secret'), true);
  const asCy = await dash.runPanel(cy, dash.get('sec'), 1, { vars: {}, fetch });
  assert.deepEqual(Object.keys(asCy.rows![0]!), ['id', 'ts', 'region', 'amount', 'user'], 'the table panel drops the column');
  await assert.rejects(() => dash.runPanel(cy, dash.get('sec'), 2, { vars: {}, fetch }), /cannot read secret/);
  await assert.rejects(() => dash.runPanel(cy, dash.get('sec'), 3, { vars: {}, fetch }), /cannot read secret/);
});

test('table panels are capped and text panels interpolate variables', async () => {
  const { dash, fetch } = make();
  const small = new Dashboards({ engine: make().engine, now: () => NOW, maxRows: 2 });
  const d = small.create(ana, { title: 'R', uid: 'r', time: { from: 'now-30d', to: 'now' }, variables: [{ name: 'env', kind: 'constant', value: 'prod' }], panels: [panel(1, { type: 'table', query: { table: 'events', measure: { agg: 'count' } } }), { id: 2, title: 'Note', type: 'text', text: 'Running in $env', grid: { x: 12, y: 0, w: 12, h: 4 } }] });
  const t = await small.runPanel(ana, d, 1, { vars: {}, fetch });
  assert.deepEqual([t.rows!.length, t.truncated], [2, true]);
  assert.equal((await small.runPanel(ana, d, 2, { vars: await small.resolveVariables(ana, d, {}, fetch), fetch })).text, 'Running in prod');
  void dash;
});

test('public links: random, kept as hashes, time-limited, revocable, and only the dashboard they were made for', async () => {
  const { dash, fetch } = make();
  let now = NOW;
  const d = new Dashboards({ engine: make().engine, now: () => now });
  d.create(ana, { title: 'Pub', uid: 'pub', time: { from: 'now-30d', to: 'now' }, panels: [panel(1, { type: 'table', query: { table: 'events', measure: { agg: 'count' } } })] });
  d.create(ana, { title: 'Other', uid: 'other', panels: [panel(1, { query: { table: 'events', measure: { agg: 'count' } } })] });
  assert.throws(() => d.createLink(ben, 'pub', 1000), NotFound);
  assert.throws(() => d.createLink(ana, 'pub', 100 * 86_400_000), /up to 90 days/);
  const { token, expires } = d.createLink(ana, 'pub', 3_600_000);
  assert.ok(token.length >= 32);
  assert.equal(expires, NOW.getTime() + 3_600_000);
  const v = d.viewByLink(token)!;
  assert.equal(v.dashboard.uid, 'pub');
  assert.match(v.person.id, /^link:[0-9a-f]{12}$/);
  assert.equal(Object.hasOwn((await d.runPanel(v.person, v.dashboard, 1, { vars: {}, fetch })).rows![0]!, 'secret'), false, 'link viewers are subject to field access like anyone');
  await assert.rejects(() => d.runPanel(v.person, d.get('other'), 1, { vars: {}, fetch }), NotFound, 'a link opens only its own dashboard');
  await assert.rejects(() => d.runPanel({ id: 'link:forged' }, d.get('pub'), 1, { vars: {}, fetch }), NotFound, 'an invented link person is no one');
  assert.equal(d.viewByLink(token + 'x'), null);
  now = new Date(NOW.getTime() + 3_600_001);
  assert.equal(d.viewByLink(token), null, 'expired');
  now = NOW;
  const t2 = d.createLink(ana, 'pub', 1000).token;
  assert.equal(d.revokeLink(ana, 'pub'), 2);
  assert.equal(d.viewByLink(t2), null);
  void dash;
});

const file = (uid: string, extra: Record<string, unknown> = {}) => JSON.stringify({ dashboard: { uid, title: `Dash ${uid}`, tags: ['prov'], panels: [{ id: 1, title: 'N', type: 'text', text: 'hi', grid: { x: 0, y: 0, w: 6, h: 2 } }], ...extra } });

test('provisioning creates from files, does nothing the second time, and updates when a file changes', () => {
  const { dash } = make();
  const first = dash.provision([{ path: 'ops/a.json', content: file('a') }, { path: 'ops/b.json', content: JSON.stringify([{ dashboard: { uid: 'b1', title: 'B1' } }, { uid: 'b2', title: 'B2' }]) }]);
  assert.deepEqual([first.created, first.errors], [['a', 'b1', 'b2'], []]);
  assert.deepEqual(dash.provision([{ path: 'ops/a.json', content: file('a') }, { path: 'ops/b.json', content: JSON.stringify([{ dashboard: { uid: 'b1', title: 'B1' } }, { uid: 'b2', title: 'B2' }]) }]).unchanged, ['a', 'b1', 'b2']);
  assert.equal(dash.get('a').version, 1);
  const again = dash.provision([{ path: 'ops/a.json', content: file('a', { title: 'Renamed' }) }]);
  assert.deepEqual([again.updated, dash.get('a').title, dash.get('a').version], [['a'], 'Renamed', 2]);
  assert.deepEqual(dash.get('a').provisioned!.allowUiUpdates, false);
});

test('provisioned dashboards cannot be edited by hand unless the file says so, and orphans are kept or removed as asked', () => {
  const { dash } = make();
  dash.provision([{ path: 'a.json', content: file('a') }, { path: 'c.json', content: JSON.stringify({ allowUiUpdates: true, dashboard: { uid: 'c', title: 'Editable' } }) }]);
  assert.throws(() => dash.update(root, 'a', { title: 'Hand' }, 1), /provisioned from a\.json/);
  assert.throws(() => dash.delete(root, 'a'), /remove the file instead/);
  assert.equal(dash.update(root, 'c', { title: 'Hand' }, 1).title, 'Hand');
  const keep = dash.provision([{ path: 'c.json', content: JSON.stringify({ allowUiUpdates: true, dashboard: { uid: 'c', title: 'Editable' } }) }]);
  assert.deepEqual([keep.deleted, dash.get('a').uid], [[], 'a'], 'by default a removed file keeps its dashboard');
  const del = dash.provision([{ path: 'c.json', content: JSON.stringify({ allowUiUpdates: true, dashboard: { uid: 'c', title: 'Editable' } }) }], { orphans: 'delete' });
  assert.deepEqual(del.deleted, ['a']);
  assert.throws(() => dash.get('a'), NotFound);
});

test('hostile or broken provisioning files are reported and change nothing', () => {
  const { dash } = make();
  dash.create(ana, { title: 'Hand made', uid: 'mine' });
  const r = dash.provision([
    { path: '../outside.json', content: file('x1') },
    { path: '/etc/x.json', content: file('x2') },
    { path: 'bad.json', content: '{nope' },
    { path: 'nouid.json', content: JSON.stringify({ dashboard: { title: 'No uid' } }) },
    { path: 'clash.json', content: file('mine') },
    { path: 'big.json', content: file('big') },
    { path: 'layout.json', content: file('lay', { panels: [{ id: 1, title: 'a', type: 'text', grid: { x: 0, y: 0, w: 30, h: 2 } }] }) },
    { path: 'proto.json', content: '{"dashboard":{"uid":"p","title":"P","__proto__":{"polluted":true}}}' },
  ], { maxFileBytes: 700 });
  assert.deepEqual(r.errors.map((e) => [e.file, e.message]), [
    ['../outside.json', 'the file path is not inside the provisioning folder'],
    ['/etc/x.json', 'the file path is not inside the provisioning folder'],
    ['bad.json', 'the file is not valid JSON'],
    ['nouid.json', 'each dashboard needs a uid and a title'],
    ['clash.json', 'mine already exists and was not provisioned from a file'],
    ['layout.json', 'panel 1: it reaches column 30, past the 24-column grid'],
  ]);
  assert.equal(r.created.includes('p'), true, 'a __proto__ key is dropped, the dashboard itself is fine');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(dash.get('mine').provisioned, undefined);
});

test('export gives a stable file that provisions back to the same dashboard', () => {
  const { dash } = make();
  const d = dash.create(ana, { title: 'Round', uid: 'round', timezone: NY, tags: ['x'], panels: [panel(2, { grid: { x: 12, y: 0, w: 12, h: 4 } }), panel(1, { grid: { x: 0, y: 0, w: 12, h: 4 } })] });
  const text = dash.export(d);
  assert.deepEqual(JSON.parse(text).panels.map((p: Panel) => p.id), [1, 2]);
  const other = make().dash;
  assert.deepEqual(other.provision([{ path: 'round.json', content: text }]).created, ['round']);
  assert.equal(other.export(other.get('round')), text);
  assert.deepEqual(parseInterval('15m'), { n: 15, unit: 'm' });
  assert.throws(() => parseInterval('0h'), /not an interval/);
  assert.equal(bucketStart(Date.UTC(2026, 5, 14, 23, 30), { n: 1, unit: 'w' }, 'UTC'), Date.UTC(2026, 5, 8), 'a Sunday belongs to the week that began on the Monday before');
  assert.equal(bucketStart(Date.UTC(2026, 5, 14, 10, 20), { n: 15, unit: 'm' }, 'UTC'), Date.UTC(2026, 5, 14, 10, 15));
});
