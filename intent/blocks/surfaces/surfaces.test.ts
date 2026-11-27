import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Surfaces, check, errorPage, type Surface } from './index.ts';

const s = (id: string, path: string, extra: Partial<Surface> = {}): Surface => ({ id, path, title: id, purpose: `Shows the ${id} for the people who use it.`, audience: ['everyone'], help: 'How to use it.', states: { loading: 'Loading…', empty: { text: 'Nothing here yet.', action: 'Upload a file' }, error: 'We could not load this. Try again.' }, owner: 'files', ...extra });

test('a screen without words for every state, or with a developer error message, is refused', () => {
  assert.deepEqual(check([s('a', '/a'), s('b', '/a', { help: '', states: { loading: '', empty: { text: 'x' }, error: 'NullPointerException' } })]), ['b: /a is also a', 'b: no help text', 'b: every state needs words: loading, empty and error', 'b: the error state reads like a developer message']);
  assert.throws(() => new Surfaces([s('a', '/a', { purpose: 'files' })]), /in a sentence/);
});

test('paths, explain, what’s new once per person, and the first-run checklist', () => {
  const done = new Set<string>();
  const reg = new Surfaces([s('files', '/apps/files'), s('file', '/apps/files/:id'), s('admin', '/admin', { audience: ['admin'] })], {
    news: [{ id: 'n1', date: '2026-11-01', title: 'Trash', body: '', surfaces: ['files'] }, { id: 'n2', date: '2026-11-20', title: 'Shortcuts', body: '' }, { id: 'n3', date: '2026-11-21', title: 'Audit', body: '', audience: ['admin'] }],
    steps: [{ id: 'upload', title: 'Upload a file', surface: 'files', done: (w) => done.has(`${w}:upload`) }],
  });
  assert.equal(reg.forPath('/apps/files/42')!.id, 'file');
  assert.equal(reg.forPath('/nope'), undefined);
  assert.equal(reg.explain('admin', ['member'])!.forYou, false);
  assert.deepEqual(reg.whatsNew('ana', ['member'], 'files').map((n) => n.id), ['n2', 'n1'], 'general news shows anywhere; screen news only on its screen');
  assert.deepEqual(reg.whatsNew('ana', ['member']).map((n) => n.id), ['n2']);
  assert.deepEqual(reg.whatsNew('ana', ['admin']).map((n) => n.id), ['n3', 'n2']);
  reg.markSeen('ana', ['n2']);
  assert.deepEqual(reg.whatsNew('ana', ['member']), []);
  assert.equal(reg.firstRun('ana').complete, false);
  done.add('ana:upload');
  assert.deepEqual(reg.firstRun('ana'), { steps: [{ id: 'upload', title: 'Upload a file', path: '/apps/files', done: true }], complete: true });
  assert.throws(() => new Surfaces([s('a', '/a')], { steps: [{ id: 'x', title: 'x', surface: 'zz', done: () => true }] }), /unknown surface/);
});

test('error pages say what happened and what to do, never blame the person for our faults, and carry a reference', () => {
  const p = errorPage(500, 'r-7f3a', { statusPage: '/status' });
  assert.equal(p.title, 'Something went wrong on our side');
  assert.match(p.body, /not something you did.*Reference: r-7f3a\./);
  assert.deepEqual(p.actions.map((a) => a.href), ['/status', '/']);
  assert.equal(errorPage(404, 'r').title, 'We cannot find that page');
  assert.equal(errorPage(418, 'r').title, 'That request did not make sense');
});
