import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Palette, score } from './index.ts';

const make = () => {
  const ran: string[] = [];
  const p = new Palette();
  const add = (id: string, title: string, section: string, extra: object = {}) => p.register({ id, title, section, run: () => void ran.push(id), ...extra });
  add('new-folder', 'New folder', 'Files', { shortcut: 'Shift+N' });
  add('upload', 'Upload files', 'Files', { keywords: ['add', 'import'], shortcut: 'mod+u' });
  add('share', 'Share link', 'Files');
  add('users', 'Manage users', 'Admin', { permission: 'admin' });
  add('trash', 'Open trash', 'Files', { keywords: ['deleted', 'bin', 'recycle'] });
  return { p, ran };
};
const anyone = () => false;
const admin = () => true;

test('fuzzy matching favours word starts and runs', () => {
  assert.ok(score('nf', 'New folder') > score('nf', 'Manage info'));
  assert.equal(score('xyz', 'New folder'), -1);
  assert.ok(score('upl', 'Upload files') > score('upl', 'Duplicate'));
});

test('search: keywords count, forbidden commands never appear, recent ones rise', async () => {
  const { p, ran } = make();
  assert.equal(p.search('bin', anyone)[0]!.command.id, 'trash');
  assert.equal(p.search('import', anyone)[0]!.command.id, 'upload');
  assert.equal(p.search('users', anyone).length, 0);
  assert.equal(p.search('users', admin)[0]!.command.id, 'users');
  await assert.rejects(p.run('users', anyone), /cannot do that/);
  assert.deepEqual(p.search('f', anyone).slice(0, 1).map((r) => r.command.id), ['new-folder']);
  await p.run('upload', anyone);
  assert.equal(p.search('f', anyone)[0]!.command.id, 'upload', 'just used');
  assert.deepEqual(ran, ['upload']);
});

test('shortcuts resolve in any modifier order, conflicts are caught at registration, and the cheat sheet lists them', () => {
  const { p } = make();
  assert.equal(p.forKeys('n+shift', anyone)!.id, 'new-folder');
  assert.throws(() => p.register({ id: 'x', title: 'X', section: 'S', shortcut: 'U+Mod', run: () => {} }), /already Upload files/);
  assert.throws(() => p.register({ id: 'share', title: 'dup', section: 'S', run: () => {} }), /already registered/);
  assert.deepEqual(p.cheatsheet(anyone).map((c) => c.shortcut), ['Shift+N', 'mod+u']);
});
