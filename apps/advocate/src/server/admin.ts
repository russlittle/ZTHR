import { MIN_CELL, outcomes, type Measure } from '../domain/outcomes.js';
import { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import * as ui from '@zthr/ui';
import type { Advocate } from '../agents/advocate.js';
import { isFresh } from '../catalog/types.js';

/**
 * The app admin. It runs the service, never a student's life: it sees the catalog, the moderation queue, what the
 * builder proposes, what the factory admitted, the scouts, and counts from the evidence. It never
 * shows a student's record, messages or sealed facts; the student owns those.
 */
export interface AdminOptions {
  base: string;
  controlDir: string;
}

export function createAdmin(a: Advocate, o: AdminOptions): Hono {
  const app = new Hono({ strict: false });
  const PAGES: [string, string, string][] = [
    ['', 'Overview', 'gauge'],
    ['catalog', 'Catalog', 'book'],
    ['moderation', 'Moderation', 'shield'],
    ['proposals', 'Builder proposals', 'flask'],
    ['admissions', 'Admissions', 'check'],
    ['scouts', 'Scouts', 'route'],
    ['outcomes', 'Outcomes', 'gauge'],
  ];
  const shell = (id: string, title: string, body: string) =>
    ui.consoleShell({ title: `${title} · App admin`, brand: 'App admin', brandHref: `${o.base}/admin/`, base: o.base, theme: 'admin', surface: 'admin', groups: [{ title: 'App admin', items: PAGES.map(([p, l, ic]) => ({ href: `${o.base}/admin/${p}`, label: l, icon: ic, current: p === id })) }], body: `<h1>${ui.esc(title)}</h1>${body}` });
  const day = () => new Date().toISOString().slice(0, 10);
  const control = (sub: string) => join(o.controlDir, sub);
  const yamlDir = (sub: string) => (existsSync(control(sub)) ? readdirSync(control(sub)).filter((f) => f.endsWith('.yaml')).map((f) => ({ file: f, body: readFileSync(join(control(sub), f), 'utf8') })) : []);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  const events = () => a.evidence.db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all() as { kind: string; n: number }[];

  app.get('/', (c) => {
    const ev = events();
    const count = (k: string) => ev.find((e) => e.kind === k)?.n ?? 0;
    const students = (a.store.db.prepare("SELECT COUNT(*) AS n FROM docs WHERE collection = 'students'").get() as { n: number }).n;
    const unmet = a.evidence.db.prepare("SELECT subject AS county, json_extract(data, '$.need') AS need, COUNT(*) AS n FROM events WHERE kind = 'unmet_need' GROUP BY 1, 2 ORDER BY n DESC").all() as { county: string; need: string; n: number }[];
    const stale = a.catalog.filter((r) => !isFresh(r, day())).length;
    return c.html(
      shell(
        '',
        'Overview',
        `<p class="muted">Counts only. This screen never shows a student's record, messages or sealed facts.</p>
${ui.kpis([{ value: students, label: 'students' }, { value: count('message'), label: 'messages delivered or deferred' }, { value: count('tone_fail'), label: 'held by the tone gate' }, { value: count('safety_route'), label: 'routed to safety' }, { value: count('outbound'), label: 'drafts sent by students' }, { value: a.catalog.length, label: 'catalog entries' }, { value: stale, label: 'entries past their freshness' }, { value: a.community.personQueue.length, label: 'posts waiting for a person' }])}
${ui.section('Needs no verified resource could meet', ui.table(['County', 'Need', 'Times'], unmet.map((u) => [u.county, u.need, u.n])))}
${ui.section('Evidence recorded', ui.table(['Kind', 'Count'], ev.map((e) => [e.kind, e.n])))}`,
      ),
    );
  });

  app.get('/catalog', (c) => {
    const rows = a.catalog.map((r) => [`<b>${ui.esc(r.name)}</b><br><span class="small muted">${ui.esc(r.id)}</span>`, ui.esc(r.categories.join(', ')), ui.esc(r.serves.national ? 'everywhere' : [...(r.serves.counties ?? []), ...(r.serves.colleges ?? [])].join(', ')), `${ui.esc(r.verifiedOn)} ${isFresh(r, day()) ? ui.chip('fresh', 'ok') : ui.chip('stale', 'bad')}`, `<a href="${ui.esc(r.source.url)}">source</a>`]);
    return c.html(shell('catalog', 'Catalog', `<p class="muted">Every resource the Advocate can offer, when it was last checked against its source, and whether that is still fresh. Stale entries are never offered to students.</p>${ui.table(['Resource', 'Helps with', 'Serves', 'Checked', ''], rows, { raw: [true, true, true, true, true] })}`));
  });

  app.get('/moderation', (c) => {
    const q = a.community.personQueue;
    return c.html(shell('moderation', 'Moderation', `<p class="muted">Posts the filters held. Nothing here is visible to students until a person releases it. Authors are pseudonyms.</p>${ui.rows(q.map((x) => ({ title: x.postId, sub: x.reason, chip: { text: 'held', tone: 'warn' } })), 'Nothing is waiting.')}`));
  });

  app.get('/proposals', (c) => {
    const dir = control('proposals');
    const list = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id: string; kind: string; title: string; reason: string; status: string; simulated?: boolean; checks: { name: string; ok: boolean }[] }) : [];
    return c.html(shell('proposals', 'Builder proposals', `<p class="muted">The builder agent drafts new scouts, playbooks and retirements from what students needed and could not get. It cannot admit its own work: the factory admits a proposal only when every check passes.</p>${list.map((p) => ui.note({ kind: 'plan', title: p.title, from: `${p.kind}${p.simulated ? ', simulated' : ''}, ${p.status}`, body: p.reason, why: p.checks.map((x) => `${x.ok ? 'passes' : 'fails'}: ${x.name}`).join('; ') })).join('') || ui.rows([], 'No proposals.')}`));
  });

  app.get('/admissions', (c) => {
    const raw = existsSync(control('people.json')) ? (JSON.parse(readFileSync(control('people.json'), 'utf8')) as unknown) : [];
    const list = Array.isArray(raw) ? raw : (raw as { people?: unknown }).people;
    const people = Array.isArray(list) ? list.map(String) : [];
    const changes = existsSync(control('journey-changes.jsonl')) ? readFileSync(control('journey-changes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { at: string; id: string; by: string; reason: string; pendingSignOff?: string; to: string }) : [];
    const playbooks = yamlDir('playbooks').map((p) => ({ id: (parse(p.body) as { playbook: string }).playbook, hash: sha(p.body).slice(0, 12) }));
    return c.html(
      shell(
        'admissions',
        'Admissions',
        `<p class="muted">Agents build; the factory admits a change when every check passes. A listed person (${ui.esc(people.join(', ') || 'none listed')}) signs only destructive changes: loosening or removing a locked card, lowering a ratchet floor, weakening a gate, deleting data.</p>
${ui.section('Journey cards', ui.table(['Card', 'Changed by', 'Why', 'When'], changes.map((x) => [x.id, x.by, x.reason, x.at.slice(0, 10)])))}
${ui.section('Playbooks', ui.table(['Playbook', 'Content hash'], playbooks.map((p) => [p.id, p.hash])))}`,
      ),
    );
  });

  app.get('/outcomes', (c) => {
    const o = outcomes(a, a.localNow().date);
    const show = (m: Measure) => (typeof m.value === 'number' ? (m.denominator !== undefined ? `${m.value}%` : String(m.value)) : m.value === 'suppressed' ? 'fewer than 5' : 'not measured');
    return c.html(
      shell(
        'outcomes',
        'Outcomes',
        `<p class="muted">What changed for students, across everyone. No number is shown for fewer than ${MIN_CELL} students. Persistence and credits need the college's own records and are not estimated.</p>
${ui.kpis(o.measures.filter((m) => typeof m.value === 'number').slice(0, 6).map((m) => ({ value: show(m), label: m.label })))}
${ui.table(['Measure', 'Value', 'Counted', 'How', 'What it cannot tell you'], o.measures.map((m) => [m.label, show(m), m.denominator !== undefined ? `${m.numerator ?? 0} of ${m.denominator}` : String(m.numerator ?? ''), m.how, m.limits]))}`,
      ),
    );
  });

  app.get('/scouts', (c) => {
    const scouts = yamlDir('scouts').map((s) => parse(s.body) as { scout: string; geography: Record<string, string>; needs: string[]; sources: { url: string; kind: string }[]; entries: string[]; freshness_days: number });
    return c.html(shell('scouts', 'Scouts', `<p class="muted">A scout keeps one area's resources fresh: it re-checks its sources on a schedule and retires itself if what it finds stops matching what students need.</p>${ui.table(['Scout', 'Area', 'Needs', 'Entries', 'Re-check every', 'Sources'], scouts.map((s) => [s.scout, Object.values(s.geography).join(', '), s.needs.join(', '), String(s.entries.length), `${s.freshness_days} days`, s.sources.map((x) => `<a href="${ui.esc(x.url)}">${ui.esc(x.kind)}</a>`).join(', ')]), { raw: [false, false, false, false, false, true] })}`));
  });

  return app;
}
