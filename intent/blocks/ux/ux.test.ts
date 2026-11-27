import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Progress, comfortCss, magicPaste, meOrDown, openView, preview, shareView, smartDefault, snoozeUntil, why } from './index.ts';

const NY = 'America/New_York';
const iso = (d: Date) => d.toISOString().slice(0, 16);

test('snooze lands where people mean, in their own zone', () => {
  const thu2pm = new Date('2026-11-26T19:00:00Z');
  assert.equal(iso(snoozeUntil('tomorrow morning', thu2pm, NY)), '2026-11-27T14:00');
  assert.equal(iso(snoozeUntil('later today', thu2pm, NY)), '2026-11-26T22:00');
  assert.equal(iso(snoozeUntil('tonight', thu2pm, NY)), '2026-11-27T00:00');
  assert.equal(iso(snoozeUntil('this weekend', thu2pm, NY)), '2026-11-28T14:00');
  assert.equal(iso(snoozeUntil('next week', thu2pm, NY)), '2026-11-30T14:00');
  assert.equal(iso(snoozeUntil('next week', new Date('2026-11-30T15:00:00Z'), NY)), '2026-12-07T14:00', 'on a Monday, next week is the following Monday');
});

test('bulk edits are previewed exactly, with unchanged and refused records apart', () => {
  const files = [{ id: 'a', tag: 'draft', owner: 'ana' }, { id: 'b', tag: 'final', owner: 'ana' }, { id: 'c', tag: 'draft', owner: 'ben' }];
  const p = preview(files, () => ({ tag: 'final' }), (f) => f.owner === 'ana');
  assert.deepEqual(p, { changes: [{ id: 'a', field: 'tag', from: 'draft', to: 'final' }], unchanged: ['b'], refused: ['c'] });
});

test('shared views are tamper-evident; defaults are learned only from a clear habit', () => {
  const t = shareView({ folder: '/Plans', sort: 'modified', cols: ['name', 'size'] }, 's');
  assert.deepEqual(openView(t, 's'), { folder: '/Plans', sort: 'modified', cols: ['name', 'size'] });
  assert.equal(openView(t.replace(/^./, 'x'), 's'), undefined);
  assert.equal(openView(t, 'other'), undefined);
  assert.equal(smartDefault(['pdf', 'pdf', 'docx', 'pdf']), 'pdf');
  assert.equal(smartDefault(['pdf', 'docx']), undefined, 'not enough to go on');
});

test('magic paste recognises tables, address lists and links', () => {
  const table = magicPaste('Name\tEmail\nAna\tana@x.org\nBen\tben@x.org');
  assert.equal(table.kind, 'table');
  assert.equal(table.kind === 'table' && table.rows.length, 3);
  const emails = magicPaste('Ana <ana@x.org>, BEN@x.org; ben@x.org cy@x');
  assert.deepEqual(emails, { kind: 'emails', emails: ['ana@x.org', 'ben@x.org'], rejected: ['Ana', 'cy@x'] });
  assert.deepEqual(magicPaste('  https://files.example.org/s/abc  '), { kind: 'url', url: 'https://files.example.org/s/abc' });
  assert.equal(magicPaste('just a note, nothing more').kind, 'text');
});

test('progress waits for enough to go on, then gives a steady time left', () => {
  const p = new Progress(1000, 0);
  assert.equal(p.update(5, 1000).text, '0%, working out the time left');
  p.update(100, 4000);
  const r = p.update(200, 8000);
  assert.equal(r.percent, 20);
  assert.ok(r.leftSeconds! > 20 && r.leftSeconds! < 40, String(r.leftSeconds));
  assert.equal(r.text, '20%, about 30 seconds left');
  assert.equal(p.update(1000, 9000).text, 'Done');
});

test('reading comfort, why am I seeing this, and is it me or is it down', () => {
  const css = comfortCss({ size: 'larger', spacing: 'relaxed', font: 'readable', motion: 'reduced', contrast: 'default' });
  assert.match(css, /--text-scale:1\.25;--line-height:1\.8/);
  assert.match(css, /animation-duration:0\.01ms/);
  assert.equal(why([{ kind: 'shared', by: 'Ana' }, { kind: 'role', role: 'editor' }, { kind: 'flag', flag: 'new uploads', because: '10% rollout' }]), 'You are seeing this because Ana shared it with you, you are an editor and you are in the early group for new uploads (10% rollout).');
  assert.equal(why([]), 'Everyone sees this.');
  assert.equal(meOrDown({ service: 'ok', internet: false }).who, 'you');
  assert.match(meOrDown({ service: 'down', internet: true, incident: 'uploads failing' }).say, /^It is us, not you: uploads failing/);
  assert.equal(meOrDown({ service: 'unreachable', internet: true }).who, 'you');
  assert.equal(meOrDown({ service: 'ok', internet: true }).who, 'nobody');
});
