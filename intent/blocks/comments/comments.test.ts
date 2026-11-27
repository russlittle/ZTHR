import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Comments, display } from './index.ts';

const people: Record<string, string> = { ana: 'u1', ben: 'u2', cy: 'u3' };
const names: Record<string, string> = { u1: 'ana', u2: 'ben', u3: 'cy' };
const make = (mentioned: string[] = []) => new Comments({ person: (h) => people[h], canSee: (who, rec) => who !== 'u3' || rec !== 'doc:secret', onMention: (who) => void mentioned.push(who) });

test('threads, replies, mentions only of people who can see the record, and unread counts', () => {
  const told: string[] = [];
  const c = make(told);
  const a = c.post('u1', 'doc:secret', 'Can @ben and @cy look? email me at x@ana.example');
  assert.deepEqual(a.mentions, ['u2'], 'cy cannot see the record, and an email address is not a mention');
  assert.deepEqual(told, ['u2']);
  const r = c.post('u2', 'doc:secret', 'On it', a.id);
  const rr = c.post('u1', 'doc:secret', 'Thanks', r.id);
  assert.equal(rr.parent, a.id, 'a reply to a reply joins the thread');
  assert.throws(() => c.post('u3', 'doc:secret', 'hi'), /cannot see/);
  assert.throws(() => c.post('u1', 'doc:other', 'x', a.id), /same record/);
  assert.equal(c.unread('u2', 'doc:secret'), 2);
  c.markRead('u2', 'doc:secret');
  assert.equal(c.unread('u2', 'doc:secret'), 0);
  assert.equal(c.threads('doc:secret')[0]!.replies.length, 2);
  c.resolve('u1', a.id);
  assert.equal(c.threads('doc:secret').length, 0);
  assert.equal(c.threads('doc:secret', { includeResolved: true }).length, 1);
});

test('edits keep history, deletion leaves a marker, reactions toggle, and display escapes', () => {
  const c = make();
  const a = c.post('u1', 'doc:1', 'first <b>draft</b>');
  assert.throws(() => c.edit('u2', a.id, 'x'), /only the author/);
  c.edit('u1', a.id, 'second, cc @ben');
  assert.equal(a.edits[0]!.text, 'first <b>draft</b>');
  assert.equal(display(a, (w) => `/p/${w}`, (w) => names[w]!), 'second, cc <a href="/p/u2">@ben</a>');
  assert.equal(display(c.post('u2', 'doc:1', '<script>x</script>'), () => '', () => ''), '&#60;script&#62;x&#60;/script&#62;');
  c.react('u2', a.id, '👍');
  c.react('u3', a.id, '👍');
  c.react('u2', a.id, '👍');
  assert.deepEqual(a.reactions, { '👍': ['u3'] });
  c.remove('u2', a.id, true);
  assert.equal(display(a, () => '', () => ''), '<em>removed by a moderator</em>');
  assert.equal(a.edits.length, 0, 'the removed words are gone, history included');
  assert.throws(() => c.post('u1', 'doc:1', '   '), /needs some text/);
});
