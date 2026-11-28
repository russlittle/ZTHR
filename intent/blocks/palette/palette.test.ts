import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Palette, normKeys, score } from './index.ts';

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

test('an empty permission name still has to be granted', async () => {
  const p = new Palette();
  p.register({ id: 'wipe', title: 'Wipe everything', section: 'Admin', permission: '', shortcut: 'mod+shift+w', run: () => {} });
  const none = () => false;
  assert.equal(p.search('wipe', none).length, 0);
  assert.equal(p.forKeys('shift+mod+w', none), undefined);
  assert.deepEqual(p.cheatsheet(none), []);
  await assert.rejects(p.run('wipe', none), /cannot do that/);
});

test('"mod" and Ctrl or Cmd are the same shortcut on the platform, so clashes are caught', () => {
  const run = () => {};
  const both = new Palette();
  both.register({ id: 'save', title: 'Save', section: 'S', shortcut: 'mod+s', run });
  assert.throws(() => both.register({ id: 'a', title: 'A', section: 'S', shortcut: 'Ctrl+S', run }), /already Save/);
  assert.throws(() => both.register({ id: 'b', title: 'B', section: 'S', shortcut: 'Cmd+S', run }), /already Save/);
  assert.equal(both.forKeys('ctrl+s', anyone)!.id, 'save');
  assert.equal(both.forKeys('meta+s', anyone)!.id, 'save');
  const mac = new Palette({ platform: 'mac' });
  mac.register({ id: 'save', title: 'Save', section: 'S', shortcut: 'mod+s', run });
  assert.throws(() => mac.register({ id: 'b', title: 'B', section: 'S', shortcut: '⌘+S', run }), /already Save/);
  mac.register({ id: 'c', title: 'C', section: 'S', shortcut: 'Control+S', run });
  assert.equal(mac.forKeys('cmd+s', anyone)!.id, 'save');
  assert.equal(mac.forKeys('ctrl+s', anyone)!.id, 'c', 'on a Mac, Ctrl is not mod');
  const pc = new Palette({ platform: 'other' });
  pc.register({ id: 'save', title: 'Save', section: 'S', shortcut: 'mod+s', run });
  assert.throws(() => pc.register({ id: 'a', title: 'A', section: 'S', shortcut: 's+control', run }), /already Save/);
  assert.equal(pc.forKeys('cmd+s', anyone), undefined);
  assert.deepEqual(normKeys('Option+Shift+Mod+K'), ['alt+meta+shift+k', 'alt+ctrl+shift+k']);
});

test('"+" can be the key, and a shortcut with no key or an empty part is refused', () => {
  assert.deepEqual(normKeys('Ctrl++'), ['ctrl++']);
  assert.deepEqual(normKeys('shift + +'), ['shift++']);
  assert.deepEqual(normKeys('+'), ['+']);
  assert.deepEqual(normKeys('Mod++', 'mac'), ['meta++']);
  assert.throws(() => normKeys('Ctrl+'), /empty part/);
  assert.throws(() => normKeys('Ctrl+Shift'), /exactly one key/);
  assert.throws(() => normKeys('a+b'), /exactly one key/);
  const p = new Palette();
  p.register({ id: 'zoom', title: 'Zoom in', section: 'View', shortcut: 'Ctrl++', run: () => {} });
  assert.equal(p.forKeys('ctrl + +', anyone)!.id, 'zoom');
  assert.equal(p.forKeys('ctrl', anyone), undefined);
  assert.throws(() => p.register({ id: 'x', title: 'X', section: 'S', shortcut: 'ctrl+', run: () => {} }), /empty part/);
});
