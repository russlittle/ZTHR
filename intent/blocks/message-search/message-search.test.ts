import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearch, MessageSearchError, parseDay, parseQuery, type Channel, type Message } from './index.ts';

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const DAY = 86_400_000;
const CH: Record<string, Channel & { members: string[]; secret?: boolean; joinedAfter?: Record<string, number> }> = {
  general: { id: 'c1', name: 'general', members: ['u1', 'u2', 'u3'] },
  eng: { id: 'c2', name: 'eng', members: ['u1', 'u2'] },
  leads: { id: 'c3', name: 'leads', members: ['u1'], secret: true },
  late: { id: 'c4', name: 'late', members: ['u1', 'u3'], joinedAfter: { u3: Date.UTC(2026, 10, 20) } },
};
const USERS: Record<string, string> = { alice: 'u1', bob: 'u2', carol: 'u3' };

function make() {
  const byId = new Map(Object.values(CH).map((c) => [c.id, c]));
  const s = new MessageSearch({
    now: () => NOW,
    channelByName: (n) => CH[n],
    userByHandle: (h) => USERS[h],
    canSeeChannel: (v, id) => byId.get(id)!.members.includes(v),
    canRead: (v, id, m) => {
      const c = byId.get(id)!;
      if (!c.members.includes(v)) return false;
      const j = c.joinedAfter?.[v];
      return j === undefined || m.ts >= j;
    },
  });
  return s;
}

let n = 0;
const msg = (channelId: string, authorId: string, text: string, ago: number, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, channelId, authorId, text, ts: NOW - ago * DAY, ...extra });

function corpus() {
  const s = make();
  const m = {
    deploy: msg('c2', 'u2', 'The deploy pipeline failed on staging again', 1),
    deploy2: msg('c2', 'u1', 'Fixed the deploy pipeline, see https://ci.example.com/run/42', 0.5, { reactions: ['tada'] }),
    lunch: msg('c1', 'u3', 'Lunch at noon? The cafe has new sandwiches', 2),
    report: msg('c1', 'u2', 'Quarterly report attached', 10, { files: [{ name: 'Q3-report.pdf', mime: 'application/pdf' }], pinned: true }),
    pic: msg('c1', 'u1', 'Photo of the new office', 12, { files: [{ name: 'office.PNG', mime: 'image/png' }] }),
    secret: msg('c3', 'u1', 'Layoff plan: deploy it quietly after the budget review', 1),
    old: msg('c4', 'u1', 'Welcome to the late channel, deploy notes live here', 30),
    new: msg('c4', 'u1', 'Newer late channel deploy note', 3),
    reply: undefined as unknown as Message,
  };
  m.reply = msg('c2', 'u1', 'Thanks, deploy looks green now', 0.4, { threadRoot: m.deploy.id, edited: true });
  for (const x of Object.values(m)) s.index(x);
  return { s, m };
}

const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id);

test('plain words must all match, stemmed and accent-folded, and rank by relevance with a recency lean', () => {
  const { s, m } = corpus();
  const r = s.search('u1', 'deploy pipeline');
  assert.deepEqual(new Set(ids(r)), new Set([m.deploy.id, m.deploy2.id]));
  assert.equal(r.hits[0]!.id, m.deploy.id, 'the shorter message that is all about it ranks first');
  const twin = make();
  twin.index(msg('c1', 'u1', 'rollout schedule for the quarter', 20, { }));
  const newer = msg('c1', 'u1', 'rollout schedule for the quarter', 1);
  twin.index(newer);
  assert.equal(twin.search('u1', 'rollout schedule').hits[0]!.id, newer.id, 'with equal text the newer message comes first');
  assert.equal(s.search('u1', 'sandwich').hits[0]!.id, m.lunch.id, 'sandwiches stems to sandwich');
  assert.equal(s.search('u1', 'cafés').total, 0);
  assert.deepEqual(ids(s.search('u1', 'deploy zebra')), []);
  assert.match(r.hits[0]!.snippet, /<mark>deploy<\/mark>/);
});

test('phrases, exclusions and prefix words', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u1', '"deploy pipeline failed"')), [m.deploy.id]);
  assert.deepEqual(ids(s.search('u1', '"pipeline deploy"')), []);
  assert.deepEqual(ids(s.search('u1', 'deploy -staging in:#eng')).sort(), [m.deploy2.id, m.reply.id].sort());
  assert.deepEqual(ids(s.search('u1', 'deploy -"deploy pipeline" in:#eng')), [m.reply.id]);
  assert.deepEqual(ids(s.search('u1', 'sand*')), [m.lunch.id]);
  assert.deepEqual(ids(s.search('u1', 'quart* report')), [m.report.id]);
});

test('from:, in:, and several of the same operator as alternatives; from:me; negation', () => {
  const { s, m } = corpus();
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy from:@bob'))), new Set([m.deploy.id]));
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy from:@bob from:@alice in:#eng'))), new Set([m.deploy.id, m.deploy2.id, m.reply.id]));
  assert.deepEqual(new Set(ids(s.search('u2', 'deploy from:me'))), new Set([m.deploy.id]));
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy in:#general in:#eng'))), new Set([m.deploy.id, m.deploy2.id, m.reply.id]));
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy in:#eng -from:@bob'))), new Set([m.deploy2.id, m.reply.id]));
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy -in:#eng -in:#leads'))), new Set([m.old.id, m.new.id]));
});

test('dates: before, after, on, during, today, yesterday and Nd; invalid dates match nothing', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u1', 'report before:2026-11-25')), [m.report.id]);
  assert.deepEqual(ids(s.search('u1', 'report after:2026-11-25')), []);
  assert.deepEqual(ids(s.search('u1', 'office on:2026-11-16')), [m.pic.id]);
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy during:2026-11 after:2026-11-20'))), new Set([m.deploy.id, m.deploy2.id, m.new.id, m.reply.id, m.secret.id]));
  assert.equal(s.search('u1', 'deploy during:2025').total, 0);
  assert.deepEqual(ids(s.search('u1', 'pipeline yesterday')), [], 'a bare word that is not an operator is a text word');
  assert.deepEqual(new Set(ids(s.search('u1', 'pipeline on:yesterday'))), new Set([m.deploy.id]));
  const bad = s.search('u1', 'deploy before:2026-13-45');
  assert.equal(bad.total, 0);
  assert.deepEqual(bad.warnings, ['before:2026-13-45 is not a date']);
  assert.equal(s.search('u1', 'deploy after:2026-11-20 before:2026-11-10').total, 0);
  assert.deepEqual(parseDay('2026-11-28', NOW, 0), { start: Date.UTC(2026, 10, 28), end: Date.UTC(2026, 10, 29) });
  assert.deepEqual(parseDay('2026-11-28', NOW, 120), { start: Date.UTC(2026, 10, 28) - 120 * 60_000, end: Date.UTC(2026, 10, 29) - 120 * 60_000 }, 'a searcher two hours east starts their day earlier in UTC');
  assert.equal(parseDay('2026-02-30', NOW, 0), undefined);
  assert.deepEqual(parseDay('3d', NOW, 0), { start: Date.UTC(2026, 10, 25), end: Date.UTC(2026, 10, 26) });
});

test('has: and is: and file operators', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u1', 'has:link')), [m.deploy2.id]);
  assert.deepEqual(ids(s.search('u1', 'has:file')).sort(), [m.report.id, m.pic.id].sort());
  assert.deepEqual(ids(s.search('u1', 'has:image')), [m.pic.id]);
  assert.deepEqual(ids(s.search('u1', 'has:reaction')), [m.deploy2.id]);
  assert.deepEqual(ids(s.search('u1', 'has:pin')), [m.report.id]);
  assert.deepEqual(ids(s.search('u1', 'is:pinned')), [m.report.id]);
  assert.deepEqual(ids(s.search('u1', 'is:reply')), [m.reply.id]);
  assert.deepEqual(ids(s.search('u1', 'is:edited')), [m.reply.id]);
  assert.deepEqual(new Set(ids(s.search('u1', 'is:thread'))), new Set([m.reply.id, m.deploy.id]));
  assert.deepEqual(ids(s.search('u1', 'filename:Q3')), [m.report.id]);
  assert.deepEqual(ids(s.search('u1', 'ext:png')), [m.pic.id]);
  assert.deepEqual(ids(s.search('u1', 'has:file -has:image')), [m.report.id]);
  assert.deepEqual(ids(s.search('u1', 'report has:file ext:pdf')), [m.report.id]);
  assert.deepEqual(s.search('u1', 'has:banana').warnings, ['has:banana is not one of link, file, image, reaction, pin, thread']);
});

test('permissions trim before anything is counted: a private channel never shows in hits, totals or snippets', () => {
  const { s, m } = corpus();
  const bob = s.search('u2', 'deploy');
  assert.ok(!ids(bob).includes(m.secret.id));
  assert.ok(!ids(bob).includes(m.old.id), 'bob is not in the late channel');
  const alice = s.search('u1', 'deploy');
  assert.ok(ids(alice).includes(m.secret.id));
  assert.equal(alice.total, 6, 'alice sees every message with deploy');
  assert.equal(bob.total, 3, 'bob sees only the three in channels he is in');
  assert.equal(s.search('u2', 'layoff').total, 0);
  assert.equal(s.search('u2', 'layoff plan quietly').hits.length, 0);
});

test('history before a person joined a channel stays hidden from them', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u3', 'deploy in:#late')), [m.new.id]);
  assert.deepEqual(new Set(ids(s.search('u1', 'deploy in:#late'))), new Set([m.new.id, m.old.id]));
});

test('a restriction on a channel or person that does not exist, or that the searcher cannot see, matches nothing the same way', () => {
  const { s } = corpus();
  const missing = s.search('u2', 'deploy in:#nonexistent');
  const hidden = s.search('u2', 'deploy in:#leads');
  assert.deepEqual([missing.total, hidden.total], [0, 0]);
  assert.deepEqual(missing.warnings, ['no channel #nonexistent']);
  assert.deepEqual(hidden.warnings, ['no channel #leads']);
  assert.deepEqual(s.search('u2', 'deploy from:@nobody').warnings, ['no person @nobody']);
  assert.equal(s.search('u2', 'deploy from:@nobody').total, 0);
  assert.equal(s.search('u2', 'deploy -in:#nonexistent').total, s.search('u2', 'deploy').total, 'excluding something that is not there changes nothing');
});

test('sorting by newest and oldest, and keyset paging that is not shifted by new messages', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u1', 'deploy in:#eng', { sort: 'newest' })), [m.reply.id, m.deploy2.id, m.deploy.id]);
  assert.deepEqual(ids(s.search('u1', 'deploy in:#eng', { sort: 'oldest' })), [m.deploy.id, m.deploy2.id, m.reply.id]);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const r = s.search('u1', 'deploy', { limit: 2, sort: 'newest', ...(cursor ? { cursor } : {}) });
    seen.push(...ids(r));
    if (!r.next) break;
    cursor = r.next;
  }
  assert.equal(seen.length, s.search('u1', 'deploy').total);
  assert.equal(new Set(seen).size, seen.length);
  const first = s.search('u1', 'deploy', { limit: 2, sort: 'newest' });
  s.index(msg('c2', 'u2', 'brand new deploy message', 0.01));
  assert.deepEqual(ids(s.search('u1', 'deploy', { limit: 2, sort: 'newest', cursor: first.next! })), seen.slice(2, 4));
  assert.throws(() => s.search('u1', 'deploy', { cursor: 'junk' }), MessageSearchError);
  assert.throws(() => s.search('u1', 'deploy', { sort: 'oldest', cursor: first.next! }), /sort changed/);
});

test('operator-only queries list the newest matches; an empty query lists nothing broader than the permission allows', () => {
  const { s, m } = corpus();
  assert.deepEqual(ids(s.search('u2', 'in:#general')).slice(0, 1), [m.lunch.id]);
  assert.deepEqual(ids(s.search('u3', 'has:file')).sort(), [m.report.id, m.pic.id].sort());
  assert.equal(s.search('u2', '').hits.every((h) => ['c1', 'c2'].includes(h.channelId)), true);
});

test('indexing: updates replace, removal forgets, and edited text is found under its new words', () => {
  const { s, m } = corpus();
  s.index({ ...m.lunch, text: 'Lunch moved to the rooftop terrace' });
  assert.equal(s.search('u1', 'sandwiches').total, 0);
  assert.deepEqual(ids(s.search('u1', 'rooftop')), [m.lunch.id]);
  assert.equal(s.remove(m.lunch.id), true);
  assert.equal(s.remove(m.lunch.id), false);
  assert.equal(s.search('u1', 'rooftop').total, 0);
  const size = s.size;
  s.index(m.pic);
  assert.equal(s.size, size);
});

test('snippets are escaped HTML so message text cannot inject markup', () => {
  const s = make();
  s.index(msg('c1', 'u1', 'Try <img src=x onerror=alert(1)> and the deploy tool & friends', 1));
  const r = s.search('u1', 'deploy');
  assert.ok(!r.hits[0]!.snippet.includes('<img'));
  assert.match(r.hits[0]!.snippet, /&#60;img/);
  assert.match(r.hits[0]!.snippet, /<mark>deploy<\/mark>/);
});

test('hostile queries: over-long or over-wide queries are refused, odd operators become words, empty values warn', () => {
  const { s } = corpus();
  assert.throws(() => s.search('u1', 'a'.repeat(501)), /over 500/);
  assert.throws(() => s.search('u1', Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')), /more than 24 parts/);
  assert.deepEqual(s.search('u1', 'from:').warnings, ['from: needs a value']);
  const q = parseQuery('foo:bar "unterminated', NOW);
  assert.deepEqual(q.terms, ['foo', 'bar']);
  assert.deepEqual(q.phrases, [['unterminat']]);
  assert.equal(parseQuery('-', NOW).terms.length, 0);
  assert.equal(s.search('u1', '"').total, s.search('u1', '').total);
});
