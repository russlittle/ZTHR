import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HookError, Hooks } from './index.ts';
import type { Warning } from './index.ts';

// ------------------------------------------------------------ order and arguments

test('listeners run lowest priority first, and ties run in the order they were added', () => {
  const h = new Hooks();
  const seen: string[] = [];
  h.addAction('boot', () => seen.push('ten-a'));
  h.addAction('boot', () => seen.push('five'), { priority: 5 });
  h.addAction('boot', () => seen.push('ten-b'));
  h.addAction('boot', () => seen.push('minus'), { priority: -3 });
  h.addAction('boot', () => seen.push('twenty'), { priority: 20 });
  assert.equal(h.doAction('boot'), 5);
  assert.deepEqual(seen, ['minus', 'five', 'ten-a', 'ten-b', 'twenty']);
  assert.deepEqual(h.listeners('boot').map((l) => l.priority), [-3, 5, 10, 10, 20]);
});

test('a filter passes the value along the chain, and a listener gets only as many arguments as it asked for', () => {
  const h = new Hooks();
  const args: unknown[][] = [];
  h.addFilter('title', (t: string, ...rest: unknown[]) => (args.push([t, ...rest]), `${t}!`));
  h.addFilter('title', (t: string, post: { id: number }, flag: boolean) => (args.push([t, post, flag]), `${t}?`), { args: 3, priority: 11 });
  assert.equal(h.applyFilters('title', 'Hi', { id: 7 }, true), 'Hi!?');
  assert.deepEqual(args, [['Hi'], ['Hi!', { id: 7 }, true]]);
  assert.equal(h.applyFilters('nobody-listens', 42), 42);
});

test('an action gives each listener its own arguments, trimmed to what it takes', () => {
  const h = new Hooks();
  const got: unknown[][] = [];
  h.addAction('saved', (...a: unknown[]) => got.push(a));
  h.addAction('saved', (...a: unknown[]) => got.push(a), { args: 2 });
  h.addAction('saved', (...a: unknown[]) => got.push(a), { args: 0 });
  h.doAction('saved', 'a', 'b', 'c');
  assert.deepEqual(got, [['a'], ['a', 'b'], []]);
});

// ------------------------------------------------------------ removal and lookup

test('listeners are removed by id, by function, or by priority, and has() finds them', () => {
  const h = new Hooks();
  const f = () => 1;
  const g = () => 2;
  const idF = h.addFilter('x', f, { priority: 5 });
  h.addFilter('x', f, { priority: 9 });
  h.addFilter('x', g);
  assert.equal(h.has('x'), 5);
  assert.equal(h.has('x', g), 10);
  assert.equal(h.has('x', idF), 5);
  assert.equal(h.has('x', () => 0), false);
  assert.equal(h.has('nothing'), false);
  assert.equal(h.remove('x', f, 9), 1, 'only the one at priority 9');
  assert.equal(h.has('x', f), 5);
  assert.equal(h.remove('x', idF), 1);
  assert.equal(h.has('x', f), false);
  assert.equal(h.remove('x', f), 0);
  assert.equal(h.removeAll('x', 99), 0);
  assert.equal(h.removeAll('x'), 1);
  assert.equal(h.has('x'), false);
  assert.equal(h.remove('never-used', f), 0);
});

test('everything one owner added can be removed at once, as when a plugin is unloaded', () => {
  const h = new Hooks();
  h.addAction('a', () => 1, { owner: 'seo' });
  h.addFilter('b', (v: number) => v, { owner: 'seo' });
  h.addFilter('b', (v: number) => v, { owner: 'cache' });
  assert.equal(h.removeByOwner('seo'), 2);
  assert.deepEqual(h.listeners('b').map((l) => l.owner), ['cache']);
  assert.equal(h.removeByOwner('seo'), 0);
  assert.equal(h.has('a'), false);
});

// ------------------------------------------------------------ changes while running

test('a listener added during a run joins it if it sorts later, and not if it sorts earlier', () => {
  const h = new Hooks();
  const seen: string[] = [];
  h.addAction('go', () => {
    seen.push('first');
    h.addAction('go', () => seen.push('later'), { priority: 15 });
    h.addAction('go', () => seen.push('earlier'), { priority: 5 });
    h.addAction('go', () => seen.push('same priority, added after'), { priority: 10 });
  });
  h.doAction('go');
  assert.deepEqual(seen, ['first', 'same priority, added after', 'later']);
  seen.length = 0;
  h.doAction('go');
  assert.deepEqual(seen.slice(0, 3), ['earlier', 'first', 'same priority, added after'], 'next time every one runs in order');
});

test('a listener removed before its turn does not run, and one may remove itself', () => {
  const h = new Hooks();
  const seen: string[] = [];
  let idB = '';
  h.addAction('go', () => (seen.push('a'), h.remove('go', idB)), { priority: 1 });
  idB = h.addAction('go', () => seen.push('b'), { priority: 2 });
  h.addAction('go', function self() { seen.push('c'); h.remove('go', self); }, { priority: 3 });
  h.doAction('go');
  assert.deepEqual(seen, ['a', 'c']);
  seen.length = 0;
  h.doAction('go');
  assert.deepEqual(seen, ['a']);
});

test('a once listener runs once and is gone', () => {
  const h = new Hooks();
  let n = 0;
  h.addAction('go', () => n++, { once: true });
  h.doAction('go');
  h.doAction('go');
  assert.equal(n, 1);
  assert.equal(h.has('go'), false);
  assert.equal(h.didRun('go'), 2);
});

// ------------------------------------------------------------ nesting and failures

test('hooks may run inside hooks, the stack is visible, and endless recursion is stopped with the path', () => {
  const h = new Hooks({ maxDepth: 5 });
  const inside: (string | undefined)[] = [];
  h.addAction('outer', () => {
    inside.push(h.current());
    h.doAction('inner');
  });
  h.addAction('inner', () => inside.push(h.current(), String(h.doing('outer'))));
  h.doAction('outer');
  assert.deepEqual(inside, ['outer', 'inner', 'true']);
  assert.equal(h.current(), undefined);
  assert.equal(h.doing('outer'), false);
  h.addAction('loop', () => h.doAction('loop'), { label: 'looper' });
  assert.equal(h.doAction('loop'), 1, 'the outer listener ran; the deepest refusal was recorded, not thrown');
  assert.match(h.warnings().at(-1)?.message ?? '', /nested more than 5 deep \(loop > loop > loop > loop > loop\)/);
  assert.equal(h.current(), undefined, 'the stack is clean after a failure');
  const strict = new Hooks({ maxDepth: 3, onError: 'throw' });
  strict.addAction('loop', () => strict.doAction('loop'));
  assert.throws(() => strict.doAction('loop'), /nested more than 3 deep/);
  assert.equal(strict.current(), undefined);
});

test('a failing listener is recorded and skipped by default, and a filter keeps the value it had', () => {
  const warnings: Warning[] = [];
  const h = new Hooks({ onWarning: (w) => warnings.push(w) });
  const seen: string[] = [];
  h.addAction('go', function bad() { throw new Error('boom'); }, { priority: 1 });
  h.addAction('go', () => seen.push('still ran'), { priority: 2 });
  assert.equal(h.doAction('go'), 1);
  assert.deepEqual(seen, ['still ran']);
  assert.deepEqual(warnings.map((w) => [w.kind, w.hook, w.listener, w.message]), [['listener-failed', 'go', 'bad', 'boom']]);
  h.addFilter('f', (v: number) => v + 1, { priority: 1 });
  h.addFilter('f', (): number => { throw new Error('nope'); }, { priority: 2 });
  h.addFilter('f', (v: number) => v * 10, { priority: 3 });
  assert.equal(h.applyFilters('f', 1), 20, 'the failing filter is skipped, the value goes on');
  assert.equal(h.warnings().length, 2);
});

test('with onError throw the caller sees the failure and later listeners do not run', () => {
  const h = new Hooks({ onError: 'throw' });
  const seen: string[] = [];
  h.addAction('go', () => { throw new Error('boom'); }, { priority: 1 });
  h.addAction('go', () => seen.push('x'), { priority: 2 });
  assert.throws(() => h.doAction('go'), /boom/);
  assert.deepEqual(seen, []);
  assert.equal(h.current(), undefined);
});

test('a filter that forgets to return the value is noticed once', () => {
  const h = new Hooks();
  h.addFilter('f', function forgetful(_v: string) { /* no return */ });
  assert.equal(h.applyFilters('f', 'text'), undefined);
  h.applyFilters('f', 'text');
  assert.deepEqual(h.warnings().map((w) => [w.kind, w.listener]), [['returned-undefined', 'forgetful']]);
  assert.match(h.warnings()[0]!.message, /must return the value/);
});

// ------------------------------------------------------------ catalogue

const doc = { name: 'save_post', kind: 'action' as const, since: '1.0', description: 'After a post is saved.', args: [{ name: 'post', type: 'Post', description: 'The saved post' }, { name: 'update', type: 'boolean' }] };

test('declaring a hook checks the declaration', () => {
  const h = new Hooks();
  h.declare(doc);
  assert.throws(() => h.declare(doc), /declared twice/);
  assert.throws(() => h.declare({ ...doc, name: 'Bad Name' }), /not a usable hook name/);
  assert.throws(() => h.declare({ ...doc, name: 'x', description: '  ' }), /needs a description/);
  assert.throws(() => h.declare({ ...doc, name: 'f', kind: 'filter', args: [] }), /must declare the value/);
  assert.throws(() => h.declare({ ...doc, name: 'dup', args: [{ name: 'a', type: 't' }, { name: 'a', type: 't' }] }), /two arguments called a/);
  assert.throws(() => h.declare({ ...doc, name: 'self', deprecated: { since: '2', replacement: 'self' } }), /cannot replace itself/);
  assert.throws(() => h.declare({ ...doc, name: 'bad_{}' }), /not a usable hook name/);
});

test('in strict mode only declared hooks take listeners, typos get a suggestion, and kinds and argument counts are checked', () => {
  const h = new Hooks({ strict: true });
  h.declare(doc);
  h.declare({ name: 'the_title', kind: 'filter', since: '1.0', description: 'Filters a title.', args: [{ name: 'title', type: 'string' }, { name: 'post', type: 'Post' }], returns: 'The title.' });
  assert.throws(() => h.addAction('save_pots', () => 1), /no hook "save_pots"; did you mean "save_post"\?/);
  assert.throws(() => h.addAction('completely_other', () => 1), (e: unknown) => e instanceof HookError && e.message === 'there is no hook "completely_other"');
  assert.throws(() => h.addFilter('save_post', (v: unknown) => v), /save_post is a action, not a filter/);
  assert.throws(() => h.addAction('the_title', () => 1), /the_title is a filter, not a action/);
  assert.throws(() => h.addAction('save_post', () => 1, { args: 3 }), /passes 2 argument\(s\); the listener asks for 3/);
  assert.throws(() => h.doAction('save_pots'), /no hook/);
  assert.throws(() => h.applyFilters('save_post', 1), /is a action, not a filter/);
  h.addAction('save_post', () => 1, { args: 2 });
  assert.equal(h.doAction('save_post', { id: 1 }, true), 1);
});

test('a hook can be declared by pattern and covers every name that fits', () => {
  const h = new Hooks({ strict: true });
  h.declare({ name: 'save_post_{type}', kind: 'action', since: '1.0', description: 'After a post of one type is saved.', args: [{ name: 'post', type: 'Post' }] });
  const seen: string[] = [];
  h.addAction('save_post_page', () => seen.push('page'));
  h.addAction('save_post_product', () => seen.push('product'));
  assert.throws(() => h.addAction('save_post_', () => 1), /no hook/);
  assert.throws(() => h.addAction('save_post', () => 1), /no hook/);
  h.doAction('save_post_page');
  assert.deepEqual(seen, ['page']);
  assert.equal(h.docFor('save_post_anything')?.name, 'save_post_{type}');
  assert.equal(h.catalogue()[0]?.listeners, 2);
});

test('names are checked even when not strict, and a hook named like an object property is just a hook', () => {
  const h = new Hooks();
  for (const bad of ['', 'Upper', '__proto__', 'has space', '1abc', 'a'.repeat(101)]) assert.throws(() => h.addAction(bad, () => 1), HookError, bad);
  assert.throws(() => h.addAction('ok', 'not a function' as never), /must be a function/);
  assert.throws(() => h.addAction('ok', () => 1, { priority: 1.5 }), /whole number/);
  assert.throws(() => h.addAction('ok', () => 1, { priority: 2_000_000 }), /whole number/);
  assert.throws(() => h.addAction('ok', () => 1, { args: 21 }), /0 to 20/);
  assert.throws(() => h.doAction('Upper'), HookError);
  let n = 0;
  h.addAction('constructor', () => n++);
  h.addAction('hasownproperty', () => n++);
  assert.equal(h.doAction('constructor'), 1);
  assert.equal(h.doAction('hasownproperty'), 1);
  assert.throws(() => h.addAction('toString', () => n++), /not a usable/, 'upper-case is refused, so the real property name is unreachable');
});

// ------------------------------------------------------------ deprecation

test('a deprecated hook still works, and says so once per listener, with what to use instead', () => {
  const h = new Hooks();
  h.declare({ name: 'old_title', kind: 'filter', since: '1.0', description: 'Old.', args: [{ name: 'title', type: 'string' }], deprecated: { since: '2.0', replacement: 'new_title', message: 'It will be removed in 4.0.' } });
  h.declare({ name: 'new_title', kind: 'filter', since: '2.0', description: 'New.', args: [{ name: 'title', type: 'string' }] });
  h.addFilter('old_title', function legacy(t: string) { return `${t} (old)`; });
  h.addFilter('old_title', function legacy(t: string) { return t; }, { priority: 20 });
  const w = h.warnings().filter((x) => x.kind === 'deprecated-hook');
  assert.equal(w.length, 1, 'the same label on the same hook warns once');
  assert.equal(w[0]!.message, 'old_title is deprecated since 2.0; use new_title: It will be removed in 4.0.');
  assert.equal(h.applyFilters('old_title', 'T'), 'T (old)');
  assert.equal(h.warnings().filter((x) => x.kind === 'deprecated-hook').length, 1, 'running it does not repeat the warning');
});

test('running the replacement also runs listeners of the deprecated hook first, so old plugins keep working', () => {
  const h = new Hooks();
  h.declare({ name: 'old_title', kind: 'filter', since: '1.0', description: 'Old.', args: [{ name: 'title', type: 'string' }], deprecated: { since: '2.0', replacement: 'new_title' } });
  h.declare({ name: 'new_title', kind: 'filter', since: '2.0', description: 'New.', args: [{ name: 'title', type: 'string' }] });
  h.addFilter('old_title', (t: string) => `${t}+old`);
  h.addFilter('new_title', (t: string) => `${t}+new`);
  assert.equal(h.applyFilters('new_title', 'T'), 'T+old+new');
  h.removeAll('old_title');
  assert.equal(h.applyFilters('new_title', 'T'), 'T+new');
  assert.equal(h.didRun('old_title'), 1);
});

// ------------------------------------------------------------ documentation

test('the catalogue lists every hook with its listener count and prints as Markdown', () => {
  const h = new Hooks();
  h.declare(doc);
  h.declare({ name: 'the_title', kind: 'filter', since: '1.2', description: 'Filters a title.', args: [{ name: 'title', type: 'string | null' }], returns: 'The title to show.', deprecated: { since: '3.0', replacement: 'display_title' } });
  h.addAction('save_post', () => 1);
  h.doAction('save_post');
  const c = h.catalogue();
  assert.deepEqual(c.map((x) => [x.name, x.listeners, x.ran]), [['save_post', 1, 1], ['the_title', 0, 0]]);
  assert.equal(
    h.toMarkdown(),
    [
      '# Hooks', '',
      '## `save_post`', '', 'Action, since 1.0.', '', 'After a post is saved.', '',
      '| Argument | Type | Description |', '| --- | --- | --- |', '| `post` | `Post` | The saved post |', '| `update` | `boolean` |  |', '',
      '## `the_title`', '', 'Filter, since 1.2. **Deprecated since 3.0.** Use `display_title`.', '', 'Filters a title.', '',
      '| Argument | Type | Description |', '| --- | --- | --- |', '| `title` | `string \\| null` |  |', '',
      'Returns: The title to show.', '',
    ].join('\n'),
  );
});

// ------------------------------------------------------------ async

test('async listeners run one after another in the same order, and a failure is isolated', async () => {
  const h = new Hooks();
  const seen: string[] = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  h.addAction('go', async () => { await wait(15); seen.push('slow first'); }, { priority: 1 });
  h.addAction('go', async () => { seen.push('fast second'); }, { priority: 2 });
  h.addAction('go', async () => { throw new Error('async boom'); }, { priority: 3 });
  assert.equal(await h.doActionAsync('go'), 2);
  assert.deepEqual(seen, ['slow first', 'fast second']);
  assert.match(h.warnings().at(-1)?.message ?? '', /async boom/);
  h.addFilter('f', async (v: number) => { await wait(5); return v + 1; }, { priority: 1 });
  h.addFilter('f', (v: number) => v * 2, { priority: 2 });
  assert.equal(await h.applyFiltersAsync('f', 1), 4);
  assert.equal(h.current(), undefined);
});
