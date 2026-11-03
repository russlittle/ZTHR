// Verifies docs/flows/any-college.md
import { describe, expect, it } from 'vitest';
import { Advocate } from '../src/agents/advocate.js';
import { COLLEGES, CollegeDef, collegeFromText, loadColleges } from '../src/domain/colleges.js';
import { COLLEGE_COUNTY } from '../src/domain/navigator.js';
import { COLLEGE_SITES } from '../src/domain/college.js';
import { CAREER_CENTERS, careerText } from '../src/domain/careers.js';
import { loadScouts } from '../src/builder/scouts.js';
import { proposeCollege } from '../src/builder/builder.js';
import { fileURLToPath } from 'node:url';

const CONTROL = fileURLToPath(new URL('../../../control', import.meta.url));

describe('any college, declared once (Phase 4)', () => {
  it('every college file parses, and every derived table comes from them', () => {
    const files = loadColleges();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const c of files) {
      expect(CollegeDef.safeParse(c).success).toBe(true);
      expect(COLLEGE_COUNTY[c.college]).toBe(c.county);
      expect(COLLEGE_SITES[c.college]).toBe(c.website);
      expect(CAREER_CENTERS[c.college]).toEqual(c.career);
    }
  });
  it('every college county has a scout, so no county is silently unserved', () => {
    const counties = new Set(loadScouts(`${CONTROL}/scouts`).map((s) => s.geography.county).filter(Boolean));
    for (const c of COLLEGES) expect(counties.has(c.county), c.county).toBe(true);
  });
  it('reads the college a student names, longest words first', () => {
    expect(collegeFromText('I go to Wright State, 45435')).toBe('wright-state');
    expect(collegeFromText('wright 45435')).toBe('wright-state');
    expect(collegeFromText('Clark State 45505')).toBe('clark-state');
    expect(collegeFromText('sinclair 45402')).toBe('sinclair');
    expect(collegeFromText('I go to Ohio State')).toBeUndefined();
  });
  it('a student who texts in from the new college is set up there, in the right county', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    a.textIn('+19375550999', 'hi');
    a.textIn('+19375550999', 'Clark State 45505');
    const s = a.findByPhone('+19375550999')!;
    expect(s.enrollment.college).toBe('clark-state');
    expect(s.county).toBe('Clark');
  });
  it('the new college\'s career office is named from its file', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    const s = a.createStudent({ chosenName: 'Rae', zip: '45505', enrollment: { college: 'clark-state' } });
    expect(careerText(a.student(s.id))).toContain('Clark State Career Services');
  });
  it('help for a county with no verified resources yet says so plainly and counts the gap', () => {
    const a = new Advocate({ today: () => '2026-11-03' });
    const s = a.createStudent({ chosenName: 'Rae', zip: '45505', enrollment: { college: 'clark-state' } });
    const before = a.evidence.events('unmet_need').length;
    const r = a.findHelp(s.id, 'housing');
    for (const o of r.options) expect(o.resource.serves.national || o.resource.serves.counties?.includes('Clark') || o.resource.serves.colleges?.includes('clark-state')).toBeTruthy();
    if (!r.options.length) expect(a.evidence.events('unmet_need').length).toBeGreaterThan(before);
  });
  it('the builder does not draft a second scout for a county that has one', () => {
    expect(proposeCollege({ college: 'x', name: 'X', county: 'Clark' }, loadScouts(`${CONTROL}/scouts`), '2026-11-03')).toEqual([]);
    expect(proposeCollege({ college: 'x', name: 'X', county: 'Miami' }, loadScouts(`${CONTROL}/scouts`), '2026-11-03')[0]).toMatchObject({ status: 'certified', declaration: { geography: { county: 'Miami' } } });
  });
});
