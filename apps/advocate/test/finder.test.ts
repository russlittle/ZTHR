// Verifies docs/flows/resource-finder.md
import { describe, expect, it } from 'vitest';
import { HAND_CATALOG as DAYTON_CATALOG } from '../src/catalog/dayton.js';
import { admit } from '../src/guide/admission.js';
import * as F from '../src/finder/finder.js';

/**
 * The resource finder's adapters, on records shaped exactly as each system of record returned them for the Dayton
 * area (recorded from runs of the probe and the finder). Every adapter keeps only what serves the area, claims nothing
 * the record does not say, and writes entries the guide's admission gates accept.
 */
const REL = [
  'OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART',
  '1|45402|ZCTA5 45402|1|0|G6350|B5|S|1|39113|Montgomery County|1|0|G4020|H1|A|9000000|0',
  '1|45432|ZCTA5 45432|1|0|G6350|B5|S|1|39113|Montgomery County|1|0|G4020|H1|A|5000000|0',
  '1|45432|ZCTA5 45432|1|0|G6350|B5|S|1|39057|Greene County|1|0|G4020|H1|A|7000000|0',
  '1|45385|ZCTA5 45385|1|0|G6350|B5|S|1|39057|Greene County|1|0|G4020|H1|A|90000000|0',
  '1|45005|ZCTA5 45005|1|0|G6350|B5|S|1|39165|Warren County|1|0|G4020|H1|A|90000000|0',
].join('\n');
const area: F.Area = { state: 'OH', counties: [{ name: 'Montgomery', fips: '39113' }, { name: 'Greene', fips: '39057' }], zipCounty: F.zipCountyFrom(REL, ['39113', '39057']), center: { lat: 39.7589, lng: -84.1916 }, today: '2026-11-14' };
const passes = (entries: { id: string }[]) => {
  const owners = new Set(entries.map((e) => e.id));
  return entries.map((e) => ({ id: e.id, failed: admit(e as never, [...DAYTON_CATALOG, ...(entries as never[])], owners).filter((c) => !c.ok).map((c) => c.name) })).filter((x) => x.failed.length);
};

describe('the area: ZIP codes to counties, from the Census relationship file', () => {
  it('keeps only the area\'s counties, and a ZIP split across counties goes to the one holding most of its land', () => {
    expect([...area.zipCounty]).toEqual([['45402', 'Montgomery'], ['45432', 'Greene'], ['45385', 'Greene']]);
    expect(F.countyOf(area, '45402-1234')).toBe('Montgomery');
    expect(F.countyOf(area, '45005')).toBeUndefined();
  });
});

describe('SAMHSA FindTreatment', () => {
  const row = {
    name1: 'New Season of Ohio, L.P.',
    name2: 'New Season Dayton Treatment Center',
    street1: '3954 Linden Avenue',
    street2: null,
    city: 'Dayton',
    state: 'OH',
    zip: '45432-3004',
    phone: '(937) 212-4950',
    intake1: null,
    website: null,
    type_facility: 'SA',
    services: [{ f1: 'Type of Care', f2: 'TC', f3: 'Substance use treatment; Detoxification' }, { f1: 'Payment/Insurance/Funding Accepted', f2: 'PAY', f3: 'Medicaid; Sliding fee scale' }],
  };
  const far = { ...row, name2: 'Lebanon Clinic', zip: '45005' };
  const f = F.fromFindTreatment([row, far], area);
  it('keeps what is in the area, with the county from its ZIP, and says why the rest was left out', () => {
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ id: 'ft-new-season-dayton-treatment-center-45432', name: 'New Season Dayton Treatment Center', serves: { counties: ['Greene'] }, phone: '937-212-4950', categories: ['mental-health'], cost: 'sliding-scale', provider: { kind: 'health', level: 'local' } });
    expect(f.entries[0]!.description).toBe('Treatment for substance use. It charges less if you earn less.');
    expect(f.skipped).toEqual([{ source: F.FINDTREATMENT_PAGE, name: 'Lebanon Clinic', why: 'outside the area' }]);
  });
  it('claims no sliding fee, hours or website the record does not give', () => {
    const plain = F.fromFindTreatment([{ ...row, services: [] }], area).entries[0]!;
    expect('cost' in plain).toBe(false);
    expect('hours' in plain).toBe(false);
    expect('url' in plain).toBe(false);
    expect(plain.description).toBe('Treatment for substance use.');
  });
  it('passes the admission gates', () => expect(passes(f.entries)).toEqual([]));
});

describe('HRSA health center sites', () => {
  const site = (over: Record<string, string>) => ({
    'Health Center Type': 'Federally Qualified Health Center (FQHC)',
    'Site Name': 'Five Rivers Health Centers - Corwin Nixon',
    'Site Address': '2261 Philadelphia Dr',
    'Site City': 'Dayton',
    'Site State Abbreviation': 'OH',
    'Site Postal Code': '45402-1111',
    'Site Telephone Number': '937-734-6841',
    'Site Web Address': 'www.example-health.org',
    'Health Center Service Delivery Site Location Setting Description': 'All Other Clinic Types',
    'Site Status Description': 'Active',
    'Health Center Name': 'FIVE RIVERS HEALTH CENTERS',
    ...over,
  });
  const f = F.fromHrsa([site({}), site({ 'Site Name': 'Normandy Elementary', 'Health Center Service Delivery Site Location Setting Description': 'School' }), site({ 'Site Name': 'Old Site', 'Site Status Description': 'Inactive' }), site({ 'Site Name': 'Lebanon', 'Site Postal Code': '45005' }), site({ 'Site State Abbreviation': 'IN' })], area);
  it('keeps active, public sites in the area, and leaves out school-only and inactive sites, saying why', () => {
    expect(f.entries.map((e) => e.name)).toEqual(['Five Rivers Health Centers - Corwin Nixon']);
    expect(f.entries[0]).toMatchObject({ organization: 'Five Rivers Health Centers', cost: 'sliding-scale', url: 'https://www.example-health.org', serves: { counties: ['Montgomery'] } });
    expect(f.skipped.map((s) => s.why)).toEqual(["a school-based site, for that school's students", 'status Inactive']);
  });
  it('passes the admission gates', () => expect(passes(f.entries)).toEqual([]));
});

describe('HUD housing counseling and public housing authorities', () => {
  const agency = { agcid: '90528', nme: 'NID-HCA DAYTON', adr1: '4403 N Main St, 1st FL', adr2: null, city: 'DAYTON', statecd: 'OH', zipcd: '45402-5040', phone1: '937-567-0990', weburl: 'https://www.nidhousing.com', languages: 'ENG,SPA' };
  it('keeps each agency once, in the area, with its languages', () => {
    const f = F.fromHudCounseling([agency, agency, { ...agency, agcid: '1', zipcd: '45005' }], area);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ name: 'Nid-Hca Dayton', categories: ['housing', 'money'], provider: { kind: 'nonprofit' }, whatToExpect: 'Counseling is offered in English and other languages too (SPA).' });
    expect(passes(f.entries)).toEqual([]);
  });
  it('a public housing authority, with the name corrected where the federal record misspells it', () => {
    const f = F.fromHudPha([{ attributes: { FORMAL_PARTICIPANT_NAME: 'Greene Metropolitian Housing Authority', HA_PHN_NUM: '9373762908', STD_ADDR: '538 N Detroit St', STD_CITY: 'XENIA', STD_ZIP5: '45385' } }, { attributes: { FORMAL_PARTICIPANT_NAME: 'Elsewhere', STD_ZIP5: '45005' } }], area);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ name: 'Greene Metropolitan Housing Authority', phone: '937-376-2908', provider: { kind: 'government', level: 'county' }, serves: { counties: ['Greene'] } });
    expect(passes(f.entries)).toEqual([]);
  });
});

describe('the IRS list gives leads, never entries', () => {
  const rows = [
    { EIN: '1', NAME: 'GREENE COUNTY FOOD PANTRY', STREET: '1 MAIN ST', CITY: 'XENIA', STATE: 'OH', ZIP: '45385-0000', NTEE_CD: 'K31' },
    { EIN: '2', NAME: 'DAYTON GOLF CLUB', STREET: '2 MAIN ST', CITY: 'DAYTON', STATE: 'OH', ZIP: '45402', NTEE_CD: 'N50' },
    { EIN: '3', NAME: 'ART MUSEUM FRIENDS', STREET: '3 MAIN ST', CITY: 'DAYTON', STATE: 'OH', ZIP: '45402', NTEE_CD: 'A51' },
    { EIN: '4', NAME: 'SAFE HOME', STREET: '4 MAIN ST', CITY: 'DAYTON', STATE: 'OH', ZIP: '45402', NTEE_CD: 'I71' },
    { EIN: '5', NAME: 'LEGAL HELP', STREET: '5 MAIN ST', CITY: 'DAYTON', STATE: 'OH', ZIP: '45402', NTEE_CD: 'I80' },
    { EIN: '6', NAME: 'FAR PANTRY', STREET: '6 MAIN ST', CITY: 'LEBANON', STATE: 'OH', ZIP: '45005', NTEE_CD: 'K31' },
  ];
  const leads = F.leadsFromIrs(rows, area);
  it('maps the kind of work to a barrier, and leaves out work that is not about a barrier and places outside the area', () => {
    expect(leads.map((l) => [l.name, l.barrier, l.county])).toEqual([
      ['Greene County Food Pantry', 'food', 'Greene'],
      ['Legal Help', 'legal', 'Montgomery'],
      ['Safe Home', 'safety', 'Montgomery'],
      ['Dayton Golf Club', 'wellbeing', 'Montgomery'],
    ]);
  });
});

describe('the finder\'s plumbing', () => {
  it('one place listed by two sources is kept once, and two places with the same name get distinct ids', () => {
    const e = (id: string, phone: string, address: string) => ({ ...DAYTON_CATALOG[0]!, id, name: id, phone, location: { address, city: 'Dayton' } });
    const skipped: F.Found['skipped'] = [];
    const out = F.dedupe([e('a', '937-555-0100', '12 Main St'), e('b', '(937) 555-0100', '12 Main Street, Suite 2'), e('a', '937-555-0199', '99 Elm St')], skipped);
    expect(out.map((x) => x.id)).toEqual(['a', 'a-2']);
    expect(skipped).toEqual([{ source: DAYTON_CATALOG[0]!.source.url, name: 'b', why: 'the same place as a' }]);
  });
  it('phone numbers are only kept when they are ten digits', () => {
    expect(F.phoneOf('(937) 212-4950')).toBe('937-212-4950');
    expect(F.phoneOf('1-937-212-4950')).toBe('937-212-4950');
    expect(F.phoneOf('212-4950')).toBeUndefined();
  });
  it('reads quoted CSV fields with commas and quotes inside', () => {
    expect(F.parseCsv('a,b,c\r\n"1, 2","say ""hi""",3\n')).toEqual([{ a: '1, 2', b: 'say "hi"', c: '3' }]);
  });
});

describe('several sites of one organization', () => {
  it('are each kept, named by town, and pass the duplicate check', () => {
    const site = (city: string, zip: string, street: string) => ({ name1: 'TCN Behavioral Health Services, Inc.', name2: null, street1: street, city, state: 'OH', zip, phone: '937-376-8700', type_facility: 'MH', services: [] });
    const f = F.fromFindTreatment([site('Xenia', '45385', '452 W Market St'), site('Dayton', '45402', '1 Main St'), site('Dayton', '45402', '9 Elm St')], area);
    const named = F.nameSites(F.dedupe(f.entries, []));
    expect(named.map((e) => e.name)).toEqual(['TCN Behavioral Health Services, Inc. (Xenia)', 'TCN Behavioral Health Services, Inc. (Dayton, 1 Main St)', 'TCN Behavioral Health Services, Inc. (Dayton, 9 Elm St)']);
    expect(passes(named)).toEqual([]);
  });
  it('a "DBA" prefix is dropped from the name', () => {
    expect(F.fromFindTreatment([{ name1: 'DBA Full Circle Recovery Services', state: 'OH', zip: '45402', phone: '937-555-0100', services: [] }], area).entries[0]!.name).toBe('Full Circle Recovery Services');
  });
});

describe('HUD-assisted apartments and public libraries', () => {
  it('apartments where rent is based on income, with who they are for, and none without a phone', () => {
    const p = (over: Record<string, unknown>) => ({ attributes: { PROPERTY_NAME_TEXT: 'HILL MANOR, II', STD_ADDR: '4132 WINTERTIME DRIVE', STD_CITY: 'DAYTON', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '(937)555-0123', CLIENT_GROUP_NAME: 'Elderly', TOTAL_ASSISTED_UNIT_COUNT: 48, ...over } });
    const f = F.fromHudMultifamily([p({}), p({ PROPERTY_NAME_TEXT: 'NO PHONE PLACE', PROPERTY_ON_SITE_PHONE_NUMBER: '' }), p({ STD_ZIP5: '45005' }), p({ PROPERTY_NAME_TEXT: 'FAMILY HOMES', CLIENT_GROUP_NAME: 'Family' })], area);
    expect(f.entries.map((e) => [e.name, e.eligibility.text])).toEqual([['Hill Manor II', 'For older adults, based on income.'], ['Family Homes', 'Based on income and household size.']]);
    expect(f.entries[0]!.description).toBe('Apartments where HUD helps pay the rent, so what you pay is based on your income (48 such units).');
    expect(f.skipped).toEqual([{ source: F.HUD_MF_PAGE, name: 'No Phone Place', why: 'no phone number in the record' }]);
    expect(passes(f.entries)).toEqual([]);
  });
  it('library branches, with average weekly hours, and no bookmobiles', () => {
    const r = (over: Record<string, string>) => ({ STABR: 'OH', LIBNAME: 'XENIA COMMUNITY LIBRARY', STATNAME: 'GREENE COUNTY PUBLIC LIBRARY', ADDRESS: '76 E MARKET ST', CITY: 'XENIA', ZIP: '45385', PHONE: '9373764952', C_OUT_TY: 'BR', HOURS: '3120', WKS_OPEN: '52', ...over });
    const f = F.fromLibraries([r({}), r({ LIBNAME: 'BOOKMOBILE', C_OUT_TY: 'BS' }), r({ STABR: 'IN' })], area);
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ name: 'Xenia Community Library', organization: 'Greene County Public Library', phone: '937-376-4952', cost: 'free', whatToExpect: "Open about 60 hours a week. Check the library's site for today's hours." });
    expect(f.skipped.map((s) => s.why)).toEqual(['a bookmobile, with no fixed place']);
    expect(passes(f.entries)).toEqual([]);
  });
});

describe('one place, or two', () => {
  const at = (phone: string, address?: string, name = 'X') => ({ phone, name, ...(address ? { location: { address, city: 'Dayton' } } : {}) });
  it('the same phone and street number is one place; a shared main number at two addresses is two', () => {
    expect(F.samePlace(at('937-463-2665', '215 E Third St'), at('(937) 463-2665', '215 East Third Street'))).toBe(true);
    expect(F.samePlace(at('937-463-2665', '215 E Third St'), at('937-463-2665', '2260 S Smithville Rd'))).toBe(false);
    expect(F.samePlace(at('937-463-2665', undefined, 'Main Library'), at('937-463-2665', undefined, 'main library'))).toBe(true);
    expect(F.samePlace(at(''), at(''))).toBe(false);
  });
  it('names lose the stray spaces federal records carry', () => {
    const f = F.fromHudMultifamily([{ attributes: { PROPERTY_NAME_TEXT: 'COVENANT  MANOR   ', STD_ADDR: '1 MAIN', STD_CITY: 'DAYTON', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9378544596', CLIENT_GROUP_NAME: 'Elderly' } }], area);
    expect(f.entries[0]!.name).toBe('Covenant Manor');
  });
});

describe('a student\'s name inside a place name is not a leak, and a real leak is still caught', () => {
  it('the walk checks scrub only the guide\'s own place names', async () => {
    const { invariants } = await import('./harness/world.js');
    const { makeAdvocate, maria } = await import('./helpers.js');
    const a = makeAdvocate();
    const w = { a, sid: maria(a).id } as never;
    const check = invariants(['Alex'], []);
    const step = (text: string) => ({ action: 'say:x', outcome: { via: 'text', replies: [{ text, nextSteps: [{ label: 'Back', action: 'back' }], urgency: 'routine' }] } }) as never;
    const place = 'Community Health Centers of Greater Dayton - Alex Central Health Center';
    expect(check(w, step(`Try ${place}. Call them first.`)).filter((p: string) => /another student/.test(p))).toEqual([]);
    expect(check(w, step('Alex said you should call them first.')).filter((p: string) => /another student/.test(p))).toEqual(["another student's name appeared: Alex"]);
  });
});
