// Verifies docs/testing/patterns.md
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { EgressRefused, EgressTwin, routedEgress } from '@zthr/egress';
import { EvidenceStore } from '@zthr/evidence';
import { startAll } from '../../campus-services/src/index.js';
import { Advocate } from '../src/agents/advocate.js';
import { propose } from '../src/builder/builder.js';
import { JOBS } from '../src/operator/operator.js';
import { createApp } from '../src/server/app.js';
import { GoogleVerifier, Sessions } from '../src/server/auth.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const roles = parse(readFileSync(`${ROOT}/control/roles.yaml`, 'utf8')) as { roles: { role: string; denied: { what: string; proven_by: string }[] }[] };

describe('roles are defined by what they are denied (Pattern 20)', () => {
  it('every denial names a test file that exists', () => {
    for (const r of roles.roles) for (const d of r.denied) expect(() => readFileSync(`${ROOT}/${d.proven_by}`), `${r.role}: ${d.what}`).not.toThrow();
  });
  it('an agent cannot open a sealed fact it was not granted', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    const s = PERSONAS.Darnell!(a);
    for (const who of ['agent:navigator', 'agent:chief-of-staff', 'operator:class-site', 'playbook:fafsa-2027-28']) {
      for (const fact of ['record']) if (a.sealed.has(s.id, fact)) expect(() => a.sealed.open(s.id, fact, who, 'curious'), who).toThrow();
    }
  });
  it('a playbook cannot be granted a sealed fact it does not declare', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    const s = PERSONAS.Alex!(a);
    a.seal(s.id, 'foster_care_history', 'stated');
    expect(() => a.grantToPlaybook(s.id, 'foster_care_history', 'fafsa-2027-28')).toThrow(/does not declare/);
    expect(() => a.grantToPlaybook(s.id, 'foster_care_history', 'foster-youth-aid')).not.toThrow();
  });
  it('the builder cannot admit its own drafts: a draft that fails a check stays unresolved, and signoff refuses anyone not listed', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    for (let i = 0; i < 3; i++) a.findHelp(a.createStudent({ chosenName: `S${i}`, zip: '45505', enrollment: { college: 'clark-state' } }).id, 'career');
    const [p] = propose(a.evidence, { today: '2026-11-03', existingScouts: [], existingPlaybooks: [] });
    expect(p!.status).toBe('unresolved');
    const r = spawnSync('npx', ['tsx', 'tools/signoff.ts', '--proposal', 'p-7f82777e5d', '--by', 'builder', '--reason', 'I approve my own work, trust me'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a listed person/);
  });
  it('the operator runs only its listed jobs', async () => {
    const a = new Advocate({ today: () => '2026-11-02', now: () => new Date('2026-11-02T17:00:00Z'), egress: routedEgress(startAll()) });
    for (const n of PERSONA_NAMES) PERSONAS[n]!(a);
    a.setCommute('maria', { mode: 'bus', homeStop: 'salem-catalpa' });
    a.connectClassSite('jayden', 'lms-jayden');
    const r = await a.operator.tick();
    for (const j of [...r.ran, ...r.skipped.map((x) => x.job), ...r.failed.map((x) => x.job)]) expect(JOBS.some((k) => j === k || j.startsWith(`${k}:`)), j).toBe(true);
    expect(r.failed).toEqual([]);
  });
});

describe('bounded by structure (Pattern 27)', () => {
  it('the door the operator uses reaches only the campus services; anything else is refused before it leaves', async () => {
    const egress = routedEgress(startAll());
    await expect(egress.send({ purpose: 'campus:x', method: 'GET', url: 'https://evil.example/steal' })).rejects.toBeInstanceOf(EgressRefused);
    expect(egress.log.at(-1)!.status).toBe('refused');
  });
  it('a recording twin on the allow-list refuses off-list hosts the same way', async () => {
    const t = new EgressTwin(['dining.campus.example']);
    await expect(t.send({ purpose: 'x', method: 'GET', url: 'https://lms.campus.example/api/v1/courses' })).rejects.toBeInstanceOf(EgressRefused);
  });
});

describe('authorization by absence (Pattern 30)', () => {
  const auth = (admins: string[]) => {
    const sessions = new Sessions(randomBytes(32));
    return { clientId: 'x.apps.googleusercontent.com', verifier: new GoogleVerifier(new EgressTwin(), 'x.apps.googleusercontent.com'), sessions, adminEmailHashes: admins.map((e) => sessions.emailHash(e)) };
  };
  it('with sign-in on and no admin listed, the admin is not there at all', async () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    PERSONAS.Maria!(a);
    const app = createApp(a, { auth: auth([]) });
    expect((await app.request('/admin/')).status).toBe(404);
    expect((await app.request('/admin/outcomes')).status).toBe(404);
  });
  it('with an admin listed, the admin exists but needs that person signed in', async () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    const app = createApp(a, { auth: auth(['someone@example.org']) });
    const r = await app.request('/admin/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/signin/);
  });
  it('the app admin never shows a student\'s record, messages or sealed facts', async () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    for (const n of PERSONA_NAMES) PERSONAS[n]!(a);
    const app = createApp(a, {});
    for (const page of ['/admin/', '/admin/catalog', '/admin/moderation', '/admin/proposals', '/admin/admissions', '/admin/scouts', '/admin/outcomes']) {
      const html = await (await app.request(page)).text();
      for (const n of PERSONA_NAMES) expect(html.includes(`>${n}<`) || html.includes(` ${n} `), `${page}: ${n}`).toBe(false);
      expect(html).not.toContain('synthetic sealed fact');
    }
  });
});

describe('describe, never write (Pattern 5)', () => {
  it('the builder only describes: drafting proposals writes nothing to the control plane', () => {
    const ev = new EvidenceStore();
    const before = spawnSync('git', ['status', '--porcelain', 'control'], { cwd: ROOT, encoding: 'utf8' }).stdout;
    for (let i = 0; i < 4; i++) ev.append('unmet_need', 'Montgomery', { need: 'books' });
    const drafts = propose(ev, { today: '2026-11-03', existingScouts: [], existingPlaybooks: [] });
    expect(drafts.length).toBeGreaterThan(0);
    expect(spawnSync('git', ['status', '--porcelain', 'control'], { cwd: ROOT, encoding: 'utf8' }).stdout).toBe(before);
  });
});
