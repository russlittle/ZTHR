import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Explorer, html, sections, summarise, view, type Feature, type Sources } from './index.ts';
import type { Surface } from '../surfaces/index.ts';
import { review, expiry } from '../upkeep/index.ts';
import { Incidents } from '../slo/index.ts';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const H = 3_600_000;
const surface = (id: string, path: string): Surface => ({ id, path, title: `The ${id} screen`, purpose: `Shows the ${id} for the people who use it.`, audience: ['admin'], help: 'How to use it.', states: { loading: 'Loading…', empty: { text: 'Nothing here yet.' }, error: 'We could not load this. Try again.' }, owner: 'ops' });

function sources(): Sources {
  const inc = new Incidents(() => new Date(NOW - 2 * H));
  inc.open('Uploads failing', 1);
  const old = inc.open('Slow search', 2);
  inc.update(old.id, 'resolved', 'fixed');
  inc.open('Typo on status page', 3);
  inc.update(3, 'resolved', 'fixed');
  return {
    now: NOW,
    surfaces: [surface('files', '/files')],
    flags: [
      { key: 'new-editor', description: '', owner: 'docs team', on: true, rules: [{ percent: 10 }], removeBy: '2027-01-01' },
      { key: 'old-banner', description: '', owner: 'web team', on: false, removeBy: '2026-10-01' },
      { key: 'kill-me', description: '', owner: 'web team', on: true, killed: true, removeBy: '2027-01-01' },
    ],
    jobs: [
      { id: 'job-1', kind: 'email', payload: null, state: 'dead', attempts: 5, maxAttempts: 5, runAt: NOW - H, lastError: 'mail server refused', created: NOW - 2 * H },
      { id: 'job-2', kind: 'thumbnail', payload: null, state: 'waiting', attempts: 0, maxAttempts: 5, runAt: NOW - H, created: NOW - H },
      { id: 'job-3', kind: 'index', payload: null, state: 'done', attempts: 1, maxAttempts: 5, runAt: NOW - H, created: NOW - H },
    ],
    housekeeping: {
      chores: [
        { job: { name: 'session-sweep', everyMin: 60, graceMin: 10, maxMin: 5 }, title: 'Sweep expired sessions', kind: 'sweep', did: 'removed 41 expired sessions' },
        { job: { name: 'key-rotation', everyMin: 1440, graceMin: 60, maxMin: 10 }, title: 'Rotate signing keys', kind: 'rotation' },
        { job: { name: 'orphan-sweep', everyMin: 60, graceMin: 10, maxMin: 5 }, title: 'Sweep orphaned uploads', kind: 'sweep' },
      ],
      checkIns: [
        { job: 'session-sweep', run: 'r1', at: NOW - 30 * 60_000, kind: 'start' },
        { job: 'session-sweep', run: 'r1', at: NOW - 29 * 60_000, kind: 'end', ok: true },
        { job: 'key-rotation', run: 'r1', at: NOW - 3 * 24 * H, kind: 'start' },
        { job: 'key-rotation', run: 'r1', at: NOW - 3 * 24 * H + 60_000, kind: 'end', ok: true },
      ],
    },
    dependencies: review([{ name: 'left-pad', version: '1.0.0', latest: '1.0.0' }, { name: 'xmldom', version: '0.7.0', latest: '0.9.0' }], [{ package: 'xmldom', id: 'GHSA-1', severity: 'critical', fixedIn: '0.8.4' }], { today: '2026-11-27' }),
    expiries: expiry([{ what: 'api.example.org certificate', kind: 'certificate', expires: '2026-12-04', owner: 'Ops' }, { what: 'example.org domain', kind: 'domain', expires: '2027-08-01', owner: 'Ops' }], '2026-11-27'),
    drills: { list: [{ backup: 'b-20261120T0000', ran: '2026-11-20T01:00:00.000Z', ms: 240_000, targetMs: 600_000, ok: true, collections: [], problems: [] }], everyDays: 7 },
    objectives: [{ objective: { name: 'Requests succeed', target: 0.999, windowDays: 30 }, window: { good: 99_990, total: 100_000 } }],
    incidents: inc.list,
    readiness: { status: 'degraded', checks: [{ name: 'database', ok: true, ms: 3 }, { name: 'search', ok: false, ms: 2000, error: 'no answer within 2000 ms' }] },
  };
}

const all = () => true;

test('each registry becomes a section of items with a status, a reason, a path and a permission', () => {
  const s = sections(sources());
  assert.deepEqual(s.map((x) => [x.id, x.status]), [['service', 'attention'], ['incidents', 'action'], ['housekeeping', 'action'], ['jobs', 'action'], ['backups', 'ok'], ['upkeep', 'action'], ['expiries', 'attention'], ['flags', 'attention'], ['screens', 'ok']]);
  const by = (id: string) => s.flatMap((x) => x.items).find((i) => i.id === id)!;
  assert.deepEqual(by('service:readiness'), { id: 'service:readiness', title: 'Readiness', status: 'attention', reason: 'search is not answering (no answer within 2000 ms).', path: '/admin/service', permission: 'admin:service' });
  assert.equal(by('service:slo-Requests succeed').reason, '90% of the error budget is left.');
  assert.equal(by('service:slo-Requests succeed').path, '/admin/service/objectives/Requests%20succeed');
  assert.deepEqual(s[1]!.items.map((i) => [i.title, i.status, i.reason]), [['Uploads failing', 'action', 'Severity 1, investigating since 2026-11-27 10:00.'], ['Slow search', 'attention', 'Resolved, and still owes a postmortem.']], 'a resolved severity 3 needs nothing');
  assert.deepEqual(by('jobs:email'), { id: 'jobs:email', title: 'email', status: 'action', reason: '1 job gave up; the last error was "mail server refused". Fix the cause, then replay.', path: '/admin/jobs/email', permission: 'admin:jobs' });
  assert.equal(by('jobs:thumbnail').reason, '1 job waiting more than 15 minutes past due.');
  assert.equal(by('jobs:index').status, 'ok');
  assert.equal(by('backups:drill').reason, 'Restored b-20261120T0000 7 days ago in 240000 ms, every collection matched.');
  assert.equal(by('upkeep:xmldom').reason, 'Update now: GHSA-1 (critical) is fixed in 0.8.4.');
  assert.equal(by('expiries:api.example.org certificate').reason, '7 days left. Ops renews it.');
  assert.deepEqual([by('flags:new-editor').status, by('flags:old-banner').reason, by('flags:kill-me').reason], ['ok', 'Off. It was due out of the code by 2026-10-01. web team owns it.', 'Switched off for everyone. Due out of the code by 2027-01-01. web team owns it.']);
});

test('the housekeeping console says when each chore last ran, what it did, what is due, and which silently stopped', () => {
  const hk = sections(sources()).find((x) => x.id === 'housekeeping')!;
  assert.deepEqual(hk.items.map((i) => [i.title, i.status, i.reason]), [
    ['Rotate signing keys', 'action', 'Last ran 2026-11-24 12:00. Next due 2026-11-25 12:00. Missed: last started 4320 minutes ago; due every 1440.'],
    ['Sweep orphaned uploads', 'action', 'It has never run. Never ran: no run has checked in.'],
    ['Sweep expired sessions', 'ok', 'Last ran 2026-11-27 11:30 and removed 41 expired sessions. Next due 2026-11-27 12:30.'],
  ]);
});

test('a person sees only what their permissions allow, and the summary counts only that', () => {
  const v = view(sources(), (p) => p === 'admin:flags' || p === 'admin:backups');
  assert.deepEqual(v.sections.map((s) => s.id), ['backups', 'flags']);
  assert.deepEqual(v.counts, { ok: 2, attention: 2, action: 0 });
  assert.equal(v.summary, '2 need attention, 2 are fine.');
  const full = view(sources(), all);
  assert.equal(full.summary, '5 need action, 6 need attention, 8 are fine.');
  assert.equal(view(sources(), () => false).summary, 'There is nothing here for you to look after.');
  assert.equal(summarise({ ok: 3, attention: 0, action: 0 }), 'Everything is fine: 3 items checked.');
  assert.equal(summarise({ ok: 0, attention: 1, action: 1 }), '1 needs action, 1 needs attention.');
  const moved = view(sources(), (p) => p === 'ops', { base: '/ops/', permissions: { jobs: 'ops' } });
  assert.deepEqual(moved.sections.flatMap((s) => s.items.map((i) => i.path)), ['/ops/jobs/email', '/ops/jobs/thumbnail', '/ops/jobs/index']);
});

test('backups never restored, a failed drill, or a stale drill are flagged; a spent error budget needs action', () => {
  const b = (drills: Sources['drills']) => sections({ now: NOW, ...(drills ? { drills } : {}) })[0]!.items[0]!;
  assert.deepEqual([b({ list: [], everyDays: 7 }).status, b({ list: [], everyDays: 7 }).reason], ['action', 'No backup has ever been restored. A backup is only proved by restoring it.']);
  assert.equal(b({ list: [{ backup: 'b1', ran: '2026-11-27T00:00:00Z', ms: 9, targetMs: 5, ok: false, collections: [], problems: ['the restore took 9 ms, over the 5 ms target'] }], everyDays: 7 }).reason, 'The last restore drill failed: the restore took 9 ms, over the 5 ms target.');
  const stale = b({ list: [{ backup: 'b1', ran: '2026-11-01T00:00:00Z', ms: 9, targetMs: 50, ok: true, collections: [], problems: [] }], everyDays: 7 });
  assert.deepEqual([stale.status, stale.reason], ['attention', 'Restored b1 26 days ago in 9 ms, every collection matched. Drills are due every 7 days.']);
  const spent = sections({ now: NOW, objectives: [{ objective: { name: 'Up', target: 0.99, windowDays: 30 }, window: { good: 980, total: 1000 } }] })[0]!.items[0]!;
  assert.deepEqual([spent.status, spent.reason], ['action', 'The error budget is spent: 20 failures against 10 allowed.']);
  const paging = sections({ now: NOW, objectives: [{ objective: { name: 'Up', target: 0.99, windowDays: 30 }, window: { good: 999, total: 1000 }, windows: { '1h': { good: 50, total: 100 }, '5m': { good: 5, total: 10 } } }] })[0]!.items[0]!;
  assert.deepEqual([paging.status, paging.reason], ['action', 'Up burning 50.0x over 1h and 50.0x over 5m (limit 14.4x).']);
  assert.deepEqual(sections({ now: NOW }), [], 'no registries, no sections');
});

test('rendering escapes every value and says status in words', () => {
  const v = view({ now: NOW, flags: [{ key: '<script>x</script>', description: '', owner: 'a & b', on: true, removeBy: '2027-01-01' }] }, all);
  const out = html(v);
  assert.ok(!out.includes('<script>'));
  assert.match(out, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(out, /a &amp; b owns it/);
  assert.match(out, /<strong>Fine<\/strong>/);
});

const features: Feature[] = [
  {
    id: 'share', name: 'Share a folder', what: 'People share a folder with a link or by name.', parts: ['grants', 'audit'], data: ['grants'], surfaces: ['files', 'ghost'], flags: ['new-editor', 'nope'],
    journeys: [{ id: 'j-share', persona: 'owner', goal: 'Share a folder with a colleague', status: 'pass' }, { id: 'j-revoke', persona: 'owner', goal: 'Take back a share and see it hold at once', status: 'pass' }],
    evidence: [{ id: 'e1', kind: 'test', href: '/evidence/share.json', at: '2026-11-20T00:00:00Z', proves: ['j-share'], passed: true }, { id: 'e2', kind: 'screenshot', href: '/evidence/x.png', at: '2026-11-21T00:00:00Z', proves: ['j-other'] }],
    permissions: [{ role: 'owner', may: ['share', 'revoke'] }], history: [{ at: '2026-10-01', what: 'Links can expire' }, { at: '2026-11-01', what: 'Passwords on links' }], audit: '/admin/audit?feature=share',
  },
  { id: 'upload', name: 'Upload files', what: 'Large files upload in parts and resume.', journeys: [{ id: 'j-up', persona: 'member', goal: 'Upload a 2 GB video', status: 'fail' }], evidence: [{ id: 'e3', kind: 'run', href: '/evidence/run-9', at: '2026-11-22T00:00:00Z', proves: ['j-up'], passed: false }] },
  { id: 'trash', name: 'Trash', what: 'Deleted things wait thirty days before they go.' },
];

test('the feature explorer joins each feature to its screens, flags, journeys and evidence, and names what points at nothing', () => {
  const ex = new Explorer(features, { surfaces: [surface('files', '/files')], flags: sources().flags! });
  const f = ex.open('share')!;
  assert.deepEqual(f.surfaces, [{ id: 'files', title: 'The files screen', path: '/files' }]);
  assert.deepEqual(f.flags, [{ key: 'new-editor', state: 'on for some people' }, { key: 'nope', state: 'missing' }]);
  assert.deepEqual(f.journeys.map((j) => [j.id, j.evidence.map((e) => e.id)]), [['j-share', ['e1']], ['j-revoke', []]]);
  assert.deepEqual(f.problems, ['It names a screen, ghost, that is not registered.', 'It names a flag, nope, that does not exist.', 'Evidence e2 proves a journey, j-other, the feature does not have.', 'Journey j-revoke has no evidence.']);
  assert.equal(f.status, 'attention');
  assert.deepEqual(f.history.map((h) => h.at), ['2026-11-01', '2026-10-01'], 'newest change first');
  assert.equal(f.path, '/admin/features/share');
  assert.equal(f.audit, '/admin/audit?feature=share');
  assert.deepEqual(ex.open('upload')!.problems, ['Journey j-up is failing.']);
  assert.equal(ex.open('upload')!.status, 'action');
  assert.deepEqual(ex.open('trash')!.problems, ['No journey proves this feature.']);
  assert.equal(ex.open('nothing'), undefined);
  assert.deepEqual(ex.list().map((x) => [x.name, x.status, x.journeys, x.evidence]), [['Share a folder', 'attention', 2, 2], ['Trash', 'action', 0, 0], ['Upload files', 'action', 1, 1]]);
  assert.throws(() => new Explorer([features[2]!, features[2]!]), /two features are called trash/);
});

test('the feature explorer finds features by name first, then by what they do, their parts and their journeys', () => {
  const ex = new Explorer(features, { surfaces: [surface('files', '/files')] });
  assert.deepEqual(ex.search('upl').map((r) => r.id), ['upload']);
  assert.deepEqual(ex.search('trash').map((r) => [r.id, r.matched]), [['trash', 'Trash']]);
  assert.deepEqual(ex.search('colleague').map((r) => [r.id, r.matched]), [['share', 'Share a folder with a colleague']], 'a journey goal is searched');
  assert.deepEqual(ex.search('grants').map((r) => [r.id, r.matched]), [['share', 'grants']], 'a part is searched');
  assert.deepEqual(ex.search('thirty days').map((r) => r.id), ['trash']);
  assert.deepEqual(ex.search('   '), []);
  assert.deepEqual(ex.search('zzzz'), []);
  assert.deepEqual(ex.search('share').map((r) => r.id), ['share'], 'letters scattered through another feature’s sentences do not match');
});
