import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldDenied, NotAllowed, NotFound, VersionConflict, ViewEngine, ViewError } from './index.ts';
import type { Node, Person, TableDef } from './index.ts';

const TASKS: TableDef = { name: 'tasks', fields: [{ name: 'id', type: 'number' }, { name: 'title', type: 'text' }, { name: 'status', type: 'select' }, { name: 'owner', type: 'text' }, { name: 'due', type: 'date' }, { name: 'points', type: 'number' }, { name: 'salary', type: 'number', sensitive: true }] };
const ana: Person = { id: 'ana', canPublish: true };
const ben: Person = { id: 'ben' };
const cy: Person = { id: 'cy' };
const root: Person = { id: 'root', admin: true, canPublish: true };

const rows = [
  { id: 1, title: 'Write spec', status: 'open', owner: 'ana', due: '2026-06-01', points: 3, salary: 100 },
  { id: 2, title: 'Review spec', status: 'open', owner: 'ben', due: '2026-06-02', points: 5, salary: 200 },
  { id: 3, title: 'Ship', status: 'done', owner: 'ana', due: null, points: 8, salary: 300 },
  { id: 4, title: 'Retro', status: 'done', owner: 'cy', due: '2026-05-01', points: 1, salary: 400 },
];

const make = (denied: Record<string, string[]> = { cy: ['salary'], ben: ['salary'] }) => {
  let n = 0;
  return new ViewEngine({ tables: [TASKS], access: { canRead: (who, _t, f) => !(denied[who]?.includes(f)) }, id: () => `v${++n}`, now: () => new Date('2026-06-15T12:00:00Z') });
};
const eq = (path: string, value: unknown): Node => ({ kind: 'cmp', path: [path], op: 'eq', value });

test('a new view is private to its owner and invisible to everyone else', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Mine', filter: eq('owner', 'ana') });
  assert.deepEqual([v.id, v.owner, v.visibility, v.version], ['v1', 'ana', 'private', 1]);
  assert.equal(e.get('v1').name, 'Mine');
  assert.equal(e.see(ana, 'v1').id, 'v1');
  assert.throws(() => e.see(ben, 'v1'), NotFound, 'a stranger cannot tell it exists');
  assert.deepEqual(e.list(ana, 'tasks').map((x) => [x.name, x.role]), [['Mine', 'owner']]);
  assert.deepEqual(e.list(ben, 'tasks'), []);
  assert.throws(() => e.list(ana, 'ghosts'), NotFound);
});

test('views are checked against the table when saved', () => {
  const e = make();
  const bad = (i: Parameters<ViewEngine['create']>[2], re: RegExp) => assert.throws(() => e.create(ana, 'tasks', i), re);
  bad({ name: '' }, /name of 1 to 80/);
  bad({ name: 'x'.repeat(81) }, /1 to 80/);
  bad({ name: 'a<b' }, /angle brackets/);
  bad({ name: 'ok', filter: eq('colour', 'red') }, /no field colour/);
  bad({ name: 'ok', sort: [{ path: ['nope'], dir: 'asc' }] }, /no field nope/);
  bad({ name: 'ok', sort: [{ path: ['owner', 'name'], dir: 'asc' }] }, /own fields/);
  bad({ name: 'ok', groupBy: ['status', 'owner', 'due', 'title'] }, /at most 3/);
  bad({ name: 'ok', groupBy: ['status', 'status'] }, /named twice/);
  bad({ name: 'ok', hidden: TASKS.fields.map((f) => f.name) }, /cannot hide every field/);
  e.create(ana, 'tasks', { name: 'dup' });
  bad({ name: 'dup' }, /already have a view called dup/);
  assert.equal(e.create(ben, 'tasks', { name: 'dup' }).owner, 'ben', 'another person may use the same name');
});

test('there is a cap on how many views a person keeps', () => {
  const e = new ViewEngine({ tables: [TASKS], access: { canRead: () => true }, maxViewsPerOwner: 2 });
  e.create(ana, 'tasks', { name: 'a' }); e.create(ana, 'tasks', { name: 'b' });
  assert.throws(() => e.create(ana, 'tasks', { name: 'c' }), /already have 2 views/);
  assert.equal(e.create(ben, 'tasks', { name: 'c' }).owner, 'ben');
});

test('a view written as a query string in any dialect means the same thing', () => {
  const e = make();
  const a = e.create(ana, 'tasks', e.fromQuery('tasks', 'pg', 'status=eq.open&points=gte.3&order=due.desc'));
  const b = e.create(ana, 'tasks', e.fromQuery('tasks', 'strapi', 'filters[status][$eq]=open&filters[points][$gte]=3&sort=due:desc'));
  const c = e.create(ana, 'tasks', e.fromQuery('tasks', 'directus', 'filter[status][_eq]=open&filter[points][_gte]=3&sort=-due'));
  assert.equal(e.fingerprint(a), e.fingerprint(b));
  assert.equal(e.fingerprint(b), e.fingerprint(c));
  assert.deepEqual((a.filter as unknown as { children: { value: unknown }[] }).children.map((x) => x.value), ['open', 3], 'points was read as a number');
  assert.throws(() => e.fromQuery('tasks', 'bad', 'colour=eq.red'), /cannot be used here/);
  assert.equal(e.fromQuery('tasks', 'cols', 'status=eq.open&select=id,title').hidden!.includes('salary'), true, 'select becomes hidden columns');
});

test('only the owner and editors change a view, and a stale version is refused', () => {
  const e = make();
  e.create(ana, 'tasks', { name: 'Plan' });
  e.share(ana, 'v1', 'ben', 'viewer');
  e.share(ana, 'v1', 'cy', 'editor');
  assert.throws(() => e.update(ben, 'v1', { name: 'Hacked' }, 2), /use this view but not change/);
  const u = e.update(cy, 'v1', { filter: eq('status', 'open'), sort: [{ path: ['due'], dir: 'asc' }] }, 3);
  assert.deepEqual([u.version, u.sort.length, u.name], [4, 1, 'Plan']);
  assert.throws(() => e.update(ana, 'v1', { name: 'Late' }, 3), (x: unknown) => x instanceof VersionConflict && /version 4, not 3/.test((x as Error).message));
  assert.equal(e.update(ana, 'v1', { filter: undefined }, 4).filter, undefined, 'a filter can be removed');
  assert.throws(() => e.update(cy, 'v1', { name: 'x'.repeat(100) }, 5), ViewError);
});

test('only the owner shares, only with people who can read what the view uses, and an editor cannot share on', () => {
  const e = make();
  e.create(ana, 'tasks', { name: 'Pay', filter: { kind: 'cmp', path: ['salary'], op: 'gt', value: 150 } });
  assert.throws(() => e.share(ana, 'v1', 'cy', 'viewer'), (x: unknown) => x instanceof FieldDenied && x.fields[0] === 'salary');
  assert.equal(e.share(ana, 'v1', 'root', 'editor').visibility, 'shared');
  assert.throws(() => e.share(root, 'v1', 'ana', 'viewer'), /only the owner can share/);
  assert.throws(() => e.share(ben, 'v1', 'ana', 'viewer'), NotFound);
  assert.throws(() => e.share(ana, 'v1', 'ana', 'viewer'), /already yours/);
  assert.throws(() => e.update(root, 'v1', { sort: [{ path: ['id'], dir: 'asc' }] }, 1), VersionConflict);
  e.create(ana, 'tasks', { name: 'Plain' });
  e.share(ana, 'v2', 'cy', 'viewer');
  assert.throws(() => e.update(ana, 'v2', { sort: [{ path: ['salary'], dir: 'desc' }] }, 2), FieldDenied, 'a change that would leave a sharer unable to read it is refused');
  assert.equal(e.update(ana, 'v2', { hidden: ['salary'] }, 2).hidden[0], 'salary');
});

test('unsharing the last person makes the view private again, and public views stay public', () => {
  const e = make();
  e.create(ana, 'tasks', { name: 'V' });
  e.share(ana, 'v1', 'ben', 'viewer');
  assert.equal(e.see(ben, 'v1').id, 'v1');
  assert.equal(e.unshare(ana, 'v1', 'ben').visibility, 'private');
  assert.throws(() => e.see(ben, 'v1'), NotFound);
  assert.throws(() => e.unshare(ben, 'v1', 'ben'), NotFound);
  e.publish(ana, 'v1');
  e.share(ana, 'v1', 'ben', 'editor');
  assert.equal(e.unshare(ana, 'v1', 'ben').visibility, 'public');
  assert.equal(e.role('ben', e.get('v1')), 'viewer', 'public gives view-only');
});

test('publishing needs the right to publish, makes the view usable by all, and can be undone', () => {
  const e = make();
  e.create(ben, 'tasks', { name: 'Team' });
  assert.throws(() => e.publish(ben, 'v1'), /right to publish/);
  e.create(ana, 'tasks', { name: 'Open' });
  assert.equal(e.publish(ana, 'v2').visibility, 'public');
  assert.deepEqual(e.list(cy, 'tasks').map((v) => [v.name, v.role]), [['Open', 'viewer']]);
  assert.throws(() => e.update(cy, 'v2', { name: 'Mine now' }, 2), /use this view but not change/);
  assert.equal(e.publish(ana, 'v2', false).visibility, 'private');
  assert.throws(() => e.publish(cy, 'v2'), NotFound);
});

test('compiling fills @me and @today per person, and always ANDs in the row scope', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Due', filter: { kind: 'or', children: [eq('owner', '@me'), { kind: 'cmp', path: ['due'], op: 'lte', value: '@today' }] } });
  e.publish(ana, v.id);
  const scope = eq('status', 'open');
  const forAna = e.compile(ana, e.get(v.id), { scope });
  assert.deepEqual(forAna.filter, { kind: 'and', children: [scope, { kind: 'or', children: [eq('owner', 'ana'), { kind: 'cmp', path: ['due'], op: 'lte', value: '2026-06-15' }] }] });
  const forBen = e.compile(ben, e.get(v.id), { scope, today: '2026-06-01' });
  assert.deepEqual((forBen.filter as unknown as { children: Node[] }).children[1], { kind: 'or', children: [eq('owner', 'ben'), { kind: 'cmp', path: ['due'], op: 'lte', value: '2026-06-01' }] });
  const run = e.run(forAna, rows);
  assert.deepEqual(run.rows.map((r) => r.id), [1, 2], 'the or in the view cannot reach past the scope: done tasks are never returned');
  assert.equal(e.compile(ana, e.get(v.id)).filter?.kind, 'or', 'no scope, no extra and');
});

test('columns a person cannot read are dropped, and hidden columns stay hidden', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Slim', hidden: ['points'] });
  e.publish(ana, v.id);
  assert.deepEqual(e.compile(ana, v).columns, ['id', 'title', 'status', 'owner', 'due', 'salary']);
  assert.deepEqual(e.compile(cy, e.get(v.id)).columns, ['id', 'title', 'status', 'owner', 'due']);
  assert.equal(Object.hasOwn(e.run(e.compile(cy, e.get(v.id)), rows).rows[0]!, 'salary'), false);
});

test('a view that filters, sorts or groups on a field the person cannot read is refused, not run', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Rich', filter: { kind: 'cmp', path: ['salary'], op: 'gt', value: 150 } });
  e.publish(ana, v.id);
  assert.throws(() => e.compile(cy, e.get(v.id)), FieldDenied);
  assert.equal(e.compile(ana, e.get(v.id)).columns.includes('salary'), true);
  const s = e.create(ana, 'tasks', { name: 'BySalary', sort: [{ path: ['salary'], dir: 'asc' }] });
  e.publish(ana, s.id);
  assert.throws(() => e.compile(ben, e.get(s.id)), /cannot read salary/);
  const g = e.create(ana, 'tasks', { name: 'G', groupBy: ['salary'] });
  e.publish(ana, g.id);
  assert.throws(() => e.compile(ben, e.get(g.id)), FieldDenied);
  const plain = e.create(ana, 'tasks', { name: 'Plain' });
  e.publish(ana, plain.id);
  assert.throws(() => e.compile(ben, e.get(plain.id), { extra: { kind: 'cmp', path: ['salary'], op: 'gt', value: 1 } }), FieldDenied, 'an extra filter on a hidden field would leak through the result');
  assert.throws(() => e.compile(ben, e.get('v1').id === 'v1' ? { ...e.get('v1'), visibility: 'private' } : e.get('v1')), NotFound, 'cannot compile what you cannot see');
});

test('run filters, sorts with nulls last, groups, pages and projects', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Board', groupBy: ['status'], sort: [{ path: ['due'], dir: 'asc' }], hidden: ['salary', 'owner'] });
  const out = e.run(e.compile(ana, v), rows);
  assert.equal(out.total, 4);
  assert.deepEqual(out.groups!.map((g) => [g.key, g.count, g.rows.map((r) => r.id)]), [[['done'], 2, [4, 3]], [['open'], 2, [1, 2]]], 'a null due date sorts last within its group');
  assert.deepEqual(Object.keys(out.rows[0]!), ['id', 'title', 'status', 'due', 'points']);
  const desc = e.create(ana, 'tasks', { name: 'Desc', sort: [{ path: ['points'], dir: 'desc' }] });
  assert.deepEqual(e.run(e.compile(ana, desc), rows, { limit: 2, offset: 1 }).rows.map((r) => r.id), [2, 1]);
  assert.deepEqual(e.run(e.compile(ana, desc), rows, { limit: 2 }).rows.map((r) => r.points), [8, 5]);
  assert.equal(e.run(e.compile(ana, desc), rows, { limit: 2 }).total, 4);
});

test('defaults: a person\'s own, then the table\'s public one, then none', () => {
  const e = make();
  const mine = e.create(ana, 'tasks', { name: 'Mine' });
  const team = e.create(root, 'tasks', { name: 'Team' });
  assert.equal(e.resolveDefault(ana, 'tasks'), null);
  assert.throws(() => e.setDefault(ana, 'tasks', mine.id, { forEveryone: true }), /only an admin/);
  assert.throws(() => e.setDefault(root, 'tasks', team.id, { forEveryone: true }), /must be a public view/);
  e.publish(root, team.id);
  e.setDefault(root, 'tasks', team.id, { forEveryone: true });
  assert.equal(e.resolveDefault(cy, 'tasks')!.name, 'Team');
  e.setDefault(ana, 'tasks', mine.id);
  assert.equal(e.resolveDefault(ana, 'tasks')!.name, 'Mine');
  assert.equal(e.resolveDefault(cy, 'tasks')!.name, 'Team');
  e.delete(ana, mine.id);
  assert.equal(e.resolveDefault(ana, 'tasks')!.name, 'Team', 'deleting a default falls back');
  e.publish(root, team.id, false);
  assert.equal(e.resolveDefault(cy, 'tasks'), null, 'a default nobody can see is not used');
  assert.throws(() => e.setDefault(ana, 'tasks', team.id), NotFound);
});

test('duplicate makes a private copy you own; delete is for owners and admins', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Orig', filter: eq('status', 'open'), sort: [{ path: ['id'], dir: 'desc' }] });
  e.share(ana, v.id, 'ben', 'viewer');
  const copy = e.duplicate(ben, v.id, 'Orig (ben)');
  assert.deepEqual([copy.owner, copy.visibility, copy.shares.length, e.fingerprint(copy) === e.fingerprint(v)], ['ben', 'private', 0, true]);
  assert.throws(() => e.delete(ben, v.id), /only the owner can delete/);
  assert.throws(() => e.duplicate(cy, v.id, 'x'), NotFound);
  e.delete(root, v.id);
  assert.throws(() => e.get(v.id), NotFound);
});

test('export and import round trip, and a hostile file is refused', () => {
  const e = make();
  const v = e.create(ana, 'tasks', { name: 'Exported', filter: { kind: 'and', children: [eq('status', 'open'), { kind: 'not', child: eq('owner', 'cy') }] }, sort: [{ path: ['due'], dir: 'desc' }], groupBy: ['status'], hidden: ['salary'] });
  const json = JSON.parse(JSON.stringify(e.exportView(v)));
  const back = e.importView(ben, { ...json, name: 'Imported' });
  assert.equal(e.fingerprint(back), e.fingerprint(v));
  const bad = (j: unknown, re: RegExp | typeof NotFound) => assert.throws(() => e.importView(ben, j), re);
  bad(null, /must be an object/);
  bad({ table: 'tasks' }, /needs a table and a name/);
  bad({ ...json, name: 'a', sort: 'x' }, /sort must be a list/);
  bad({ ...json, name: 'b', hidden: [1] }, /lists of field names/);
  bad({ ...json, name: 'c', filter: { kind: 'cmp', path: ['status'], op: 'sql', value: 1 } }, /not a filter operator/);
  bad({ ...json, name: 'd', filter: { kind: 'cmp', path: ['colour'], op: 'eq', value: 1 } }, /no field colour/);
  bad({ ...json, name: 'e', filter: { kind: 'nope' } }, /malformed/);
  let deep: unknown = { kind: 'cmp', path: ['status'], op: 'eq', value: 1 };
  for (let i = 0; i < 12; i++) deep = { kind: 'not', child: deep };
  bad({ ...json, name: 'f', filter: deep }, /nested too deeply/);
  bad({ ...json, name: 'g', table: 'ghosts' }, NotFound);
});
