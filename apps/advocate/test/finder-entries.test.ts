// Verifies docs/flows/resource-finder.md
// Each system's record, shaped as that system returns it, against the whole entry a student would see, worked by hand
// from the record and the rules in the doc: what each field says, and that nothing else is said. Then each helper
// at its edges.
import { beforeEach, describe, expect, it } from 'vitest';
import * as F from '../src/finder/finder.js';

const REL = [
  'OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART',
  '1|45402|ZCTA5 45402|1|0|G6350|B5|S|1|39113|Montgomery County|1|0|G4020|H1|A|9000000|0',
  '1|45432|ZCTA5 45432|1|0|G6350|B5|S|1|39113|Montgomery County|1|0|G4020|H1|A|5000000|0',
  '1|45432|ZCTA5 45432|1|0|G6350|B5|S|1|39057|Greene County|1|0|G4020|H1|A|7000000|0',
  '1|45385|ZCTA5 45385|1|0|G6350|B5|S|1|39057|Greene County|1|0|G4020|H1|A|90000000|0',
  '1|45005|ZCTA5 45005|1|0|G6350|B5|S|1|39165|Warren County|1|0|G4020|H1|A|90000000|0',
].join('\n');
// Built before each test, where a mutant is switched on, never while tests are being collected.
let area: F.Area;
beforeEach(() => {
  area = { state: 'OH', counties: [{ name: 'Montgomery', fips: '39113' }, { name: 'Greene', fips: '39057' }], zipCounty: F.zipCountyFrom(REL, ['39113', '39057']), center: { lat: 39.7589, lng: -84.1916 }, today: '2026-11-14' };
});
const common = { documents: [], prefill: [], verifiedOn: '2026-11-14', freshnessDays: 30 };

describe('each system of record, as the whole entry a student sees', () => {
  it('FindTreatment: the intake line over the main one, both kinds of care, a sliding fee because the record lists one', () => {
    const f = F.fromFindTreatment([{ name1: 'New Season of Ohio, L.P.', name2: 'New Season Dayton Treatment Center', street1: '3954 Linden Avenue', street2: 'Suite 2', city: 'DAYTON', state: 'OH', zip: '45402-3004', phone: '(937) 212-4950', intake1: '1 (937) 212-4951', website: 'newseason.example.org', type_facility: 'MH', services: [{ f1: 'Type of Care', f2: 'TC', f3: 'Mental health treatment; Substance use treatment' }, { f1: 'Payment/Insurance/Funding Accepted', f2: 'PAY', f3: 'Medicaid; Sliding fee scale' }] } as never], area);
    expect(f).toEqual({ skipped: [], entries: [{
      ...common, id: 'ft-new-season-dayton-treatment-center-45402', name: 'New Season Dayton Treatment Center', organization: 'New Season of Ohio, L.P.', categories: ['mental-health'],
      description: 'Treatment for mental health and substance use. It charges less if you earn less.', serves: { counties: ['Montgomery'] },
      location: { address: '3954 Linden Avenue, Suite 2', city: 'Dayton', zip: '45402' }, phone: '937-212-4951', url: 'https://newseason.example.org',
      eligibility: { text: 'Call to ask who they serve.' }, howToApply: ['Call 937-212-4951 to ask for a first visit.', 'Ask if they take your insurance or charge less if you earn less.'],
      cost: 'sliding-scale', source: { url: 'https://findtreatment.gov/', license: 'public-information' }, provider: { kind: 'health', level: 'local' }, tags: ['found:findtreatment'],
    }] });
  });

  it('FindTreatment: mental health alone, substance use alone, and the main line when there is no intake line', () => {
    const one = (over: Record<string, unknown>) => F.fromFindTreatment([{ name1: 'Org', name2: 'Clinic', street1: '1 Main St', city: 'Dayton', state: 'OH', zip: '45402', phone: '937-555-0100', type_facility: '', services: [], ...over } as never], area).entries[0]!;
    expect(one({ type_facility: 'MH' }).description).toBe('Treatment for mental health.');
    expect(one({ services: [{ f1: 'Type of Care', f3: 'Mental health treatment' }] }).description).toBe('Treatment for mental health.');
    expect(one({ type_facility: 'SA' }).description).toBe('Treatment for substance use.');
    expect(one({ type_facility: 'BUPREN' }).description).toBe('Treatment for substance use.');
    expect(one({ services: [{ f1: 'Type of Care', f3: 'Opioid treatment program' }] }).description).toBe('Treatment for substance use.');
    expect(one({ services: [{ f1: 'Pharmacotherapies', f3: 'Mental health treatment' }] }).description).toBe('Treatment for substance use.');
    expect(one({}).phone).toBe('937-555-0100');
    expect(one({}).howToApply[0]).toBe('Call 937-555-0100 to ask for a first visit.');
    expect(one({ phone: '', intake1: '' }).howToApply[0]).toBe('Call to ask for a first visit.');
    expect('phone' in one({ phone: '', intake1: '' })).toBe(false);
    expect('url' in one({ website: 'In progress' })).toBe(false);
    expect(one({ name2: '' }).name).toBe('Org');
    expect(one({ name2: '', name1: 'DBA Hope House' }).organization).toBe('Hope House');
    expect(one({ state: 'IN' })).toBeUndefined();
    expect(one({ street2: '', city: 'DAYTON' }).location).toEqual({ address: '1 Main St', city: 'Dayton', zip: '45402' });
  });

  it('HRSA: a look-alike is not called federally funded; its sliding fee and with-or-without-insurance hold', () => {
    const site = (over: Record<string, string>) => F.fromHrsa([{ 'Site Name': 'Five Rivers Health Centers - Corwin Nixon', 'Site Address': ' 2261 Philadelphia Dr ', 'Site City': 'DAYTON', 'Site State Abbreviation': 'OH', 'Site Postal Code': '45402-1111', 'Site Telephone Number': '937-734-6841', 'Site Web Address': 'www.example-health.org', 'Health Center Service Delivery Site Location Setting Description': 'All Other Clinic Types', 'Site Status Description': 'Active', 'Health Center Name': 'FIVE RIVERS HEALTH CENTERS', 'Health Center Type': 'Look-Alike', ...over }], area);
    expect(site({})).toEqual({ skipped: [], entries: [{
      ...common, id: 'hrsa-five-rivers-health-centers-corwin-nixon-45402', name: 'Five Rivers Health Centers - Corwin Nixon', organization: 'Five Rivers Health Centers', categories: ['health'],
      description: 'A community health center. It sees you with or without insurance, and charges less if you earn less.', serves: { counties: ['Montgomery'] },
      location: { address: '2261 Philadelphia Dr', city: 'Dayton', zip: '45402' }, phone: '937-734-6841', url: 'https://www.example-health.org',
      eligibility: { text: 'Anyone, with or without insurance.' }, howToApply: ['Call 937-734-6841 to make a visit.', 'Ask about the sliding fee if money is tight.'],
      cost: 'sliding-scale', whatToExpect: 'Health centers ask your income to set your fee. Bring proof of income if you have it.',
      source: { url: 'https://findahealthcenter.hrsa.gov/', license: 'public-information' }, provider: { kind: 'health', level: 'local' }, tags: ['found:hrsa'],
    }] });
    expect(site({ 'Health Center Type': 'Federally Qualified Health Center' }).entries[0]!.description).toBe('A community health center funded by the federal government. It sees you with or without insurance, and charges less if you earn less.');
    expect(site({ 'Site Status Description': '' }).skipped).toEqual([{ source: F.HRSA_PAGE, name: 'Five Rivers Health Centers - Corwin Nixon', why: 'status unknown' }]);
    expect(site({ 'Site Status Description': ' Active ' }).entries).toHaveLength(1);
    expect(site({ 'Site Status Description': 'Active Pending' }).entries).toHaveLength(0);
    expect(site({ 'Site Telephone Number': '' }).entries[0]!.howToApply[0]).toBe('Call to make a visit.');
    expect(site({ 'Health Center Name': '' }).entries[0]!.organization).toBe('Five Rivers Health Centers - Corwin Nixon');
  });

  it('HUD counselors: the languages in words, a government agency named as one', () => {
    const one = (over: Record<string, unknown>) => F.fromHudCounseling([{ nme: 'HOMEOWNERSHIP CENTER OF GREATER DAYTON', adr1: '1 Main St', adr2: 'Floor 2', city: 'DAYTON', statecd: 'OH', zipcd: '45402', phone1: '937-555-0101', weburl: 'http://hcd.example.org', languages: 'ENG, SPA ,FRE', ...over } as never], area);
    expect(one({})).toEqual({ skipped: [], entries: [{
      ...common, id: 'hud-homeownership-center-of-greater-dayton-45402', name: 'Homeownership Center of Greater Dayton', organization: 'Homeownership Center of Greater Dayton', categories: ['housing', 'money'],
      description: 'A housing counselor, checked by HUD, can help with rent, a home loan, credit, or buying a home.', serves: { counties: ['Montgomery'] },
      location: { address: '1 Main St, Floor 2', city: 'Dayton', zip: '45402' }, phone: '937-555-0101', url: 'http://hcd.example.org',
      eligibility: { text: 'Call to ask who they serve.' }, howToApply: ['Call 937-555-0101 and say what you need help with.'],
      whatToExpect: 'Counseling is also offered in Spanish and French.',
      source: { url: 'https://apps.hud.gov/offices/hsg/sfh/hcc/hcs.cfm', license: 'public-information' }, provider: { kind: 'nonprofit', level: 'local' }, tags: ['found:hud-counseling'],
    }] });
    expect('whatToExpect' in one({ languages: 'ENG' }).entries[0]!).toBe(false);
    expect(one({ nme: 'MONTGOMERY COUNTY DEPARTMENT OF HOUSING' }).entries[0]!.provider).toEqual({ kind: 'government', level: 'local' });
    expect(one({ phone1: '' }).entries[0]!.howToApply).toEqual(['Call and say what you need help with.']);
    expect(one({ statecd: 'KY' })).toEqual({ entries: [], skipped: [{ source: F.HUD_COUNSELING_PAGE, name: 'Homeownership Center of Greater Dayton', why: 'outside the area' }] });
  });

  it('a language code becomes its name, and an unknown one is "other languages"', () => {
    expect(F.languages('SPA')).toBe('Spanish');
    expect(F.languages('ENG,SPA,FRE,VIE')).toBe('Spanish, French and Vietnamese');
    expect(F.languages('spa, XYZ')).toBe('Spanish and other languages');
    expect(F.languages('XYZ')).toBe('other languages');
    expect(F.languages('SPA,SPA')).toBe('Spanish');
    expect(F.languages('ENG')).toBeUndefined();
    expect(F.languages(undefined)).toBeUndefined();
  });

  it('a housing authority: public housing and vouchers, a wait list that opens and closes', () => {
    const f = F.fromHudPha([{ attributes: { FORMAL_PARTICIPANT_NAME: 'Greene Metropolitian Housing Authority', HA_PHN_NUM: '9373762908', STD_ADDR: '538 N Detroit St', STD_CITY: 'XENIA', STD_ZIP5: '45385' } }], area);
    expect(f).toEqual({ skipped: [], entries: [{
      ...common, id: 'pha-greene-metropolitan-housing-authority', name: 'Greene Metropolitan Housing Authority', organization: 'Greene Metropolitan Housing Authority', categories: ['housing'],
      description: 'The public housing authority: public housing, and Housing Choice Vouchers (Section 8) that help pay rent.', serves: { counties: ['Greene'] },
      location: { address: '538 N Detroit St', city: 'Xenia', zip: '45385' }, phone: '937-376-2908',
      eligibility: { text: 'Based on income and household size.' }, howToApply: ['Call 937-376-2908 to ask if the waiting list is open.', 'Ask how to get on the list, and what to bring.'],
      whatToExpect: 'Waiting lists can be long, and they open and close. Ask when this one will open if it is closed.',
      source: { url: 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts', license: 'public-information' }, provider: { kind: 'government', level: 'county' }, tags: ['found:hud-pha'],
    }] });
  });

  it('HUD-assisted apartments: run by their owner, with who they are for and how many units', () => {
    const one = (over: Record<string, unknown>) => F.fromHudMultifamily([{ attributes: { PROPERTY_NAME_TEXT: 'RIVER APTS, III', STD_ADDR: '4132 WINTERTIME DRIVE', STD_CITY: 'DAYTON', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '(937)555-0123', CLIENT_GROUP_NAME: 'Disabled', TOTAL_ASSISTED_UNIT_COUNT: 0, ...over } }], area).entries[0]!;
    expect(one({})).toEqual({
      ...common, id: 'hudmf-river-apts-iii-45402', name: 'River Apts III', organization: 'River Apts III', categories: ['housing'],
      description: 'Apartments where HUD helps pay the rent, so what you pay is based on your income.', serves: { counties: ['Montgomery'] },
      location: { address: '4132 Wintertime Drive', city: 'Dayton', zip: '45402' }, phone: '937-555-0123',
      eligibility: { text: 'For people with disabilities, based on income.' }, howToApply: ['Call 937-555-0123 to ask if the wait list is open.', 'Ask how to apply, and what to bring.'],
      whatToExpect: 'Each building has its own wait list. Putting your name on several can help.',
      source: { url: 'https://resources.hud.gov/', license: 'public-information' }, provider: { kind: 'property', level: 'local' }, tags: ['found:hud-multifamily', 'disability'],
    });
    expect(one({ CLIENT_GROUP_NAME: 'Elderly' }).tags).toEqual(['found:hud-multifamily', 'older-adults']);
    for (const g of ['Elderly/Family', 'Family', 'Elderly and Disabled', 'Disabled Family', '']) {
      const e = one({ CLIENT_GROUP_NAME: g });
      expect([e.eligibility.text, e.tags], g).toEqual([g === 'Elderly and Disabled' ? 'For older adults, based on income.' : 'Based on income and household size.', g === 'Elderly and Disabled' ? ['found:hud-multifamily', 'older-adults'] : ['found:hud-multifamily']]);
    }
    expect(one({ PROPERTY_NAME_TEXT: 'OAK HILL, IV' }).name).toBe('Oak Hill IV');
    expect(one({ PROPERTY_NAME_TEXT: 'OAK HILL, LLC' }).name).toBe('Oak Hill, Llc');
    expect(one({ TOTAL_ASSISTED_UNIT_COUNT: 1 }).description).toBe('Apartments where HUD helps pay the rent, so what you pay is based on your income (1 such units).');
  });

  it('a library branch: no hours claimed unless the survey gives both hours and weeks', () => {
    const one = (over: Record<string, string>) => F.fromLibraries([{ STABR: 'OH', LIBNAME: 'XENIA COMMUNITY LIBRARY', STATNAME: 'GREENE COUNTY PUBLIC LIBRARY', ADDRESS: '76 E MARKET ST', CITY: 'XENIA', ZIP: '45385', PHONE: '9373764952', C_OUT_TY: 'BR', HOURS: '0', WKS_OPEN: '52', ...over }], area).entries[0]!;
    expect(one({})).toEqual({
      ...common, freshnessDays: 90, id: 'lib-xenia-community-library-45385', name: 'Xenia Community Library', organization: 'Greene County Public Library', categories: ['phone-internet', 'academic'],
      description: 'A public library. Use the computers, Wi-Fi and printers for free, and study there.', serves: { counties: ['Greene'] },
      location: { address: '76 E Market St', city: 'Xenia', zip: '45385' }, phone: '937-376-4952',
      eligibility: { text: 'Anyone can come in.' }, howToApply: ['Go in during open hours.', 'Ask for a library card to borrow things and use the computers longer.'],
      cost: 'free', source: { url: 'https://www.imls.gov/research-evaluation/surveys/public-libraries-survey-pls', license: 'public-information' }, provider: { kind: 'government', level: 'local' }, tags: ['found:imls'],
    });
    expect(one({ HOURS: '2600', WKS_OPEN: '52' }).whatToExpect).toBe("Open about 50 hours a week. Check the library's site for today's hours.");
    expect('whatToExpect' in one({ HOURS: '2600', WKS_OPEN: '0' })).toBe(false);
    expect('whatToExpect' in one({ HOURS: '-1', WKS_OPEN: '52' })).toBe(false);
    expect(one({ C_OUT_TY: 'BM' })).toBeUndefined();
    expect(one({ C_OUT_TY: 'CE' }).name).toBe('Xenia Community Library');
    expect(one({ STATNAME: '' }).organization).toBe('Xenia Community Library');
  });
});

describe('the helpers at their edges', () => {
  it('ZIP codes and phone numbers', () => {
    expect([F.zip5('45402-1234'), F.zip5(45402), F.zip5(null), F.zip5('4540')]).toEqual(['45402', '45402', '', '4540']);
    expect([F.phoneOf('1-937-555-0100'), F.phoneOf('(937) 555-0100'), F.phoneOf('937.555.0100 ext 2'), F.phoneOf('11-937-555-010'), F.phoneOf('937-155-0100'), F.phoneOf('037-555-0100'), F.phoneOf('211'), F.phoneOf(null)]).toEqual(['937-555-0100', '937-555-0100', undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(F.digits('2-937-555-0100')).toBe('29375550100');
    expect(F.digits('1937555010')).toBe('1937555010');
  });
  it('ids, names and links', () => {
    expect(F.slug('  Habitat & Homes: St. Mary\'s #2  ')).toBe('habitat-and-homes-st-mary-s-2');
    expect(F.slug('x'.repeat(60))).toHaveLength(48);
    expect(F.undba('  dba Hope House')).toBe('Hope House');
    expect(F.undba('Adba House')).toBe('Adba House');
    expect(F.title('  ST.  VINCENT DE PAUL OF THE  CITY  ')).toBe('St. Vincent De Paul of the City');
    expect(F.title('Food Bank of the Miami Valley')).toBe('Food Bank of the Miami Valley');
    expect(F.title('AND THEN ROAD VII')).toBe('And Then Road VII');
    expect([F.url(' https://a.org '), F.url('HTTP://a.org'), F.url('a.org/help'), F.url('sub.a.org'), F.url('localhost'), F.url('N/A'), F.url('none'), F.url(''), F.url('Website in progress')]).toEqual(['https://a.org', 'HTTP://a.org', 'https://a.org/help', 'https://sub.a.org', undefined, undefined, undefined, undefined, undefined]);
  });
  it('one place or two', () => {
    const at = (name: string, phone: string | undefined, address?: string) => ({ name, phone, ...(address !== undefined ? { location: { address, city: 'Dayton', zip: '45402' } } : {}) });
    expect(F.samePlace(at('A', '937-555-0100', '1 Main St'), at('B', '(937) 555-0100', '1 Elm St'))).toBe(true);
    expect(F.samePlace(at('A', '937-555-0100', '1 Main St'), at('A', '937-555-0100', '2 Main St'))).toBe(false);
    expect(F.samePlace(at('A', '937-555-0100'), at('a', '937-555-0100'))).toBe(true);
    expect(F.samePlace(at('A', '937-555-0100'), at('B', '937-555-0100'))).toBe(false);
    expect(F.samePlace(at('A', '937-555-0100', 'Main St'), at('A', '937-555-0100', '1 Main St'))).toBe(true);
    expect(F.samePlace(at('A', undefined, '1 Main St'), at('A', undefined, '1 Main St'))).toBe(false);
    expect(F.samePlace(at('A', '937-555-0100', '1 Main St'), at('A', '937-555-0101', '1 Main St'))).toBe(false);
  });
  it('dedupe keeps the first listing, says why, and gives a repeated id a number', () => {
    const e = (id: string, name: string, phone: string, address: string) => ({ id, name, phone, location: { address, city: 'Dayton', zip: '45402' }, source: { url: 'https://s.gov' } }) as never;
    const skipped: F.Found['skipped'] = [];
    const out = F.dedupe([e('x', 'First', '937-555-0100', '1 Main St'), e('y', 'Second', '937-555-0100', '1 Main St, Suite 2'), e('x', 'Third', '937-555-0199', '9 Elm St'), e('x', 'Fourth', '937-555-0177', '7 Oak St'), e('z', 'No number', '937-555-0100', 'Main St')], skipped);
    expect(out.map((o: { id: string; name: string }) => `${o.id} ${o.name}`)).toEqual(['x First', 'x-2 Third', 'x-3 Fourth', 'z No number']);
    expect(skipped).toEqual([{ source: 'https://s.gov', name: 'Second', why: 'the same place as First' }]);
  });
  it('sites of one name: by town, then by street within a town', () => {
    const e = (name: string, city: string, address: string) => ({ name, location: { address, city, zip: '45402' } }) as never;
    expect(F.nameSites([e('TCN', 'Xenia', '452 W Market St'), e('TCN', 'Dayton', '1 Main St, Suite 4'), e('tcn', 'Dayton', '9 Elm St'), e('Other', 'Dayton', '1 Main St')]).map((x: { name: string }) => x.name)).toEqual(['TCN (Xenia)', 'TCN (Dayton, 1 Main St)', 'tcn (Dayton, 9 Elm St)', 'Other']);
  });
  it('CSV: a BOM, blank and one-cell lines, a final line with no newline, and quotes', () => {
    expect(F.parseCsv('﻿a,b\r\n1,2\r\n\r\nonly\n"x\r\ny",""\n3,4')).toEqual([{ a: '1', b: '2' }, { a: 'x\r\ny', b: '' }, { a: '3', b: '4' }]);
    expect(F.parseCsv('a,b\n1')).toEqual([]);
    expect(F.parseCsv('a,b\n1,2,3\n,')).toEqual([{ a: '1', b: '2' }, { a: '', b: '' }]);
    expect(F.parseCsv('')).toEqual([]);
  });
  it('drift at its edges: a 2xx answer is fine, exactly half is not under half, ten kept is the line', () => {
    const b = { name: 'S', status: 200, records: 100, kept: 10 };
    expect(F.drift([b], [{ ...b, status: 299 }])).toEqual([]);
    expect(F.drift([b], [{ ...b, status: 199 }])).toEqual(['S: answered 199']);
    expect(F.drift([b], [{ ...b, status: 300 }])).toEqual(['S: answered 300']);
    expect(F.drift([b], [{ ...b, status: 0 }])).toEqual(['S: answered nothing']);
    expect(F.drift([b], [{ ...b, records: 50, kept: 10 }])).toEqual([]);
    expect(F.drift([b], [{ ...b, records: 49 }])).toEqual(["S: 49 records, under half of last run's 100"]);
    expect(F.drift([b], [{ ...b, kept: 5 }])).toEqual([]);
    expect(F.drift([b], [{ ...b, kept: 4 }])).toEqual(["S: 4 kept, under half of last run's 10"]);
    expect(F.drift([{ ...b, kept: 9 }], [{ ...b, kept: 1 }])).toEqual([]);
    expect(F.drift([{ ...b, records: 0, kept: 0 }], [{ ...b, records: 0, kept: 0 }])).toEqual([]);
    expect(F.drift([{ ...b, kept: 0 }], [{ ...b, kept: 0 }])).toEqual([]);
  });
  it('a ZIP split exactly in half stays with the county read first', () => {
    const head = 'OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART';
    const rel = [head, '1|45999|Z|1|0|G|B|S|1|39113|Montgomery County|1|0|G|H|A|500|0', '1|45999|Z|1|0|G|B|S|1|39057|Greene County|1|0|G|H|A|500|0'].join('\n');
    expect([...F.zipCountyFrom(rel, ['39113', '39057'])]).toEqual([['45999', 'Montgomery']]);
  });
});

describe('what the finder asks each system, exactly', () => {
  it('the requests a live run read: 40 miles around the center, a whole state, a city, the IRS state file', () => {
    expect(F.FINDTREATMENT(area)).toBe('https://findtreatment.gov/locator/exportsAsJson/v2?sAddr=39.7589,-84.1916&limitType=2&limitValue=64374&pageSize=2000&page=1&sort=0');
    expect(F.FINDTREATMENT(area, 3)).toContain('&page=3&');
    expect(64374 / 1609.344).toBeCloseTo(40, 2);
    expect(F.HUD_COUNSELING_CITY('OH', 'Yellow Springs')).toBe('https://data.hud.gov/Housing_Counselor/search?AgencyName=&City=Yellow%20Springs&State=OH');
    expect(F.HUD_PHA('OH')).toBe('https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Authorities/FeatureServer/0/query?where=STD_ST%3D%27OH%27&outFields=*&f=json&resultRecordCount=2000');
    expect(F.HUD_MF('OH')).toBe('https://services.arcgis.com/VTyQ9soqVukalItT/ArcGIS/rest/services/MULTIFAMILY_PROPERTIES_ASSISTED/FeatureServer/0/query?where=STD_ST%3D%27OH%27&outFields=PROPERTY_ID,PROPERTY_NAME_TEXT,STD_ADDR,STD_CITY,STD_ZIP5,PROPERTY_ON_SITE_PHONE_NUMBER,CLIENT_GROUP_NAME,TOTAL_ASSISTED_UNIT_COUNT&f=json&resultOffset=0&resultRecordCount=2000');
    expect(F.HUD_MF('OH', 2000)).toContain('&resultOffset=2000&');
    expect(F.IRS_EO('OH')).toBe('https://www.irs.gov/pub/irs-soi/eo_oh.csv');
  });
});

describe('a record missing a field: the entry says nothing in its place', () => {
  it('names, addresses and towns read as empty, never as something made up, and spaces around them are dropped', () => {
    const ft = F.fromFindTreatment([{ state: 'OH', zip: '45402', phone: '937-555-0100', services: [] } as never], area).entries[0]!;
    expect([ft.name, ft.organization, ft.location]).toEqual(['', '', { address: '', city: '', zip: '45402' }]);
    expect(F.fromFindTreatment([{ name2: '  Hope  ', state: 'OH', zip: '45402', services: [] } as never], area).entries[0]!.name).toBe('Hope');
    const hrsa = F.fromHrsa([{ 'Site State Abbreviation': 'OH', 'Site Postal Code': '45402', 'Site Status Description': 'Active' }], area).entries[0]!;
    expect([hrsa.name, hrsa.organization, hrsa.location, 'url' in hrsa]).toEqual(['', '', { address: '', city: '', zip: '45402' }, false]);
    expect(F.fromHrsa([{ 'Site Name': '  Clinic  ', 'Site City': ' XENIA ', 'Site State Abbreviation': 'OH', 'Site Postal Code': '45385', 'Site Status Description': 'Active' }], area).entries[0]!.location!.city).toBe('Xenia');
    expect(F.fromHrsa([{ 'Site Name': '  Clinic  ', 'Site State Abbreviation': 'OH', 'Site Postal Code': '45385', 'Site Status Description': 'Active' }], area).entries[0]!.name).toBe('Clinic');
    expect(F.fromHrsa([{ 'Site Name': 'Clinic', 'Site State Abbreviation': 'OH', 'Site Postal Code': '45385', 'Site Status Description': 'Active', 'Health Center Organization Name': ' CITY HEALTH ' }], area).entries[0]!.organization).toBe('City Health');
    expect(F.fromHrsa([{ 'Site State Abbreviation': 'OH', 'Site Postal Code': '45385' }], area).skipped).toEqual([{ source: F.HRSA_PAGE, name: '', why: 'status unknown' }]);
    const hud = F.fromHudCounseling([{ statecd: 'OH', zipcd: '45402' } as never], area).entries[0]!;
    expect([hud.name, hud.location]).toEqual(['', { address: '', city: '', zip: '45402' }]);
    expect(F.fromHudCounseling([{ nme: '  HOPE  ', city: ' DAYTON ', statecd: 'OH', zipcd: '45402' } as never], area).entries[0]!.name).toBe('Hope');
    const pha = F.fromHudPha([{ attributes: { STD_ZIP5: '45385' } }], area).entries[0]!;
    expect([pha.name, pha.location, pha.howToApply[0]]).toEqual(['', { address: '', city: '', zip: '45385' }, 'Call to ask if the waiting list is open.']);
    expect(F.fromHudPha([{ attributes: { FORMAL_PARTICIPANT_NAME: '  XENIA HA ', STD_ADDR: ' 1 Main St ', STD_ZIP5: '45385' } }], area).entries[0]!).toMatchObject({ name: 'Xenia Ha', location: { address: '1 Main St' } });
    const mf = F.fromHudMultifamily([{ attributes: { STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9375550123' } }], area).entries[0]!;
    expect([mf.name, mf.location, mf.eligibility.text]).toEqual(['', { address: '', city: '', zip: '45402' }, 'Based on income and household size.']);
    expect(F.fromHudMultifamily([{ attributes: { PROPERTY_NAME_TEXT: '  OAK , II ', STD_ADDR: ' 1 MAIN ', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9375550123' } }], area).entries[0]!).toMatchObject({ name: 'Oak II', location: { address: '1 Main' } });
    const lib = F.fromLibraries([{ STABR: 'OH', ZIP: '45385' }], area).entries[0]!;
    expect([lib.name, lib.organization, lib.location]).toEqual(['', '', { address: '', city: '', zip: '45385' }]);
    expect(F.fromLibraries([{ STABR: 'OH', ZIP: '45385', LIBNAME: ' XENIA ', STATNAME: ' GREENE  LIBRARY ', ADDRESS: ' 1 MAIN ', CITY: ' XENIA ' }], area).entries[0]!).toMatchObject({ name: 'Xenia', organization: 'Greene Library', location: { address: '1 Main', city: 'Xenia' } });
  });

  it('a library or a lead outside the area is left out; a lead with no NTEE code is not a lead', () => {
    expect(F.fromLibraries([{ STABR: 'OH', ZIP: '45005', LIBNAME: 'LEBANON' }], area)).toEqual({ entries: [], skipped: [] });
    expect(F.fromLibraries([{ STABR: 'OH', ZIP: '45385', LIBNAME: 'X', C_OUT_TY: 'BM' }], area).skipped).toHaveLength(1);
    const lead = { EIN: '1', NAME: ' HOPE PANTRY ', STREET: ' 1 MAIN ', CITY: ' DAYTON ', STATE: 'OH', ZIP: '45402', NTEE_CD: ' k31 ' };
    expect(F.leadsFromIrs([lead], area)).toEqual([{ ein: '1', name: 'Hope Pantry', address: '1 Main', city: 'Dayton', zip: '45402', county: 'Montgomery', ntee: 'K31', barrier: 'food', source: 'https://www.irs.gov/pub/irs-soi/eo_oh.csv' }]);
    expect(F.leadsFromIrs([{ ...lead, NTEE_CD: '' }, { ...lead, NAME: undefined as never, STREET: undefined as never, CITY: undefined as never, NTEE_CD: 'K31' }], area).map((l) => [l.name, l.address, l.city])).toEqual([['', '', '']]);
  });
});

describe('one place or two, at the edges', () => {
  it('a street number is the leading digits only, and an entry with no place is named and kept as it is', () => {
    const e = (id: string, phone: string, address?: string) => ({ id, name: 'Same', phone, ...(address !== undefined ? { location: { address, city: 'Dayton', zip: '45402' } } : {}), source: { url: 'https://s.gov' } }) as never;
    const skipped: F.Found['skipped'] = [];
    expect(F.dedupe([e('a', '937-555-0100', '1200 Main St'), e('b', '937-555-0100', '12 Main St'), e('c', '937-555-0100', 'Main St 12')], skipped).map((x: { id: string }) => x.id)).toEqual(['a', 'b', 'c']);
    expect(F.dedupe([e('a', '937-555-0100'), e('b', '937-555-0100')], []).map((x: { id: string }) => x.id)).toEqual(['a']);
    // With no street number, names are compared in lower case, letter for letter: "SAME" and "Same" are one place, but
    // "STRASSE" and "Straße", which meet only in capitals, are two.
    const named = (id: string, name: string) => ({ id, name, phone: '937-555-0100', source: { url: 'https://s.gov' } }) as never;
    expect(F.dedupe([named('a', 'Same'), named('b', 'SAME')], []).map((x: { id: string }) => x.id)).toEqual(['a']);
    expect(F.dedupe([named('a', 'STRASSE'), named('b', 'Straße')], []).map((x: { id: string }) => x.id)).toEqual(['a', 'b']);
    expect(F.samePlace({ name: 'X', phone: '937-555-0100', location: { address: '1200 Main', city: 'D', zip: '1' } }, { name: 'X', phone: '937-555-0100', location: { address: '12 Main', city: 'D', zip: '1' } })).toBe(false);
    expect(F.nameSites([{ name: 'Same' } as never, { name: 'Same' } as never]).map((x: { name: string }) => x.name)).toEqual(['Same', 'Same']);
    expect(F.nameSites([{ name: 'Same', location: { address: '', city: 'Dayton', zip: '1' } } as never, { name: 'Same', location: { address: '', city: 'Dayton', zip: '1' } } as never]).map((x: { name: string }) => x.name)).toEqual(['Same (Dayton)', 'Same (Dayton)']);
  });

  it('kinds of treatment: each word a record uses for substance use', () => {
    const care = (type_facility: string, f3 = '') => F.fromFindTreatment([{ name2: 'C', state: 'OH', zip: '45402', type_facility, services: [{ f1: 'Type of Care', f3 }] } as never], area).entries[0]!.description;
    for (const [t, f3] of [['OTP', ''], ['', 'Detoxification'], ['', 'Methadone maintenance'], ['', 'Buprenorphine'], ['', 'Opioid treatment']]) expect(care(t!, f3), `${t}${f3}`).toBe('Treatment for substance use.');
    expect(care('MH', 'Outpatient')).toBe('Treatment for mental health.');
    expect(care('MH', 'Outpatient; Detoxification')).toBe('Treatment for mental health and substance use.');
  });
});

describe('CSV and the census file, at their edges', () => {
  it('a bare carriage return ends a line; one inside quotes does not', () => {
    expect(F.parseCsv('a,b\r1,2\r3,4')).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    expect(F.parseCsv('a,b\n1,\n')).toEqual([{ a: '1', b: '' }]);
    expect(F.parseCsv('a,b\n"1\r",2\n')).toEqual([{ a: '1\r', b: '2' }]);
    expect(F.parseCsv('﻿"a",b\n1,2')).toEqual([{ a: '1', b: '2' }]);
  });
  it('the census file read with a BOM and Windows line endings, skipping lines with no ZIP and counties not asked for', () => {
    const head = '﻿OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART';
    const rel = [head, '1|45402|Z|1|0|G|B|S|1|39113|Montgomery County|1|0|G|H|A|100|0', '1||Z|1|0|G|B|S|1|39113|Montgomery County|1|0|G|H|A|100|0', '1|45005|Z|1|0|G|B|S|1|39165|Warren County|1|0|G|H|A|100|0', '1|45999|Z|1|0|G|B|S|1|39113|Montgomery County|1|0|G|H|A||0', ''].join('\r\n');
    expect([...F.zipCountyFrom(rel, ['39113'])]).toEqual([['45402', 'Montgomery'], ['45999', 'Montgomery']]);
  });
});

describe('pass 4: the survivors that were not equivalent', () => {
  it('a leading 1 is dropped only from exactly eleven digits', () => {
    expect(F.digits('21-937-555-0100')).toBe('219375550100');
    expect(F.digits('1-937-555-0100-1')).toBe('193755501001');
    expect(F.digits(undefined)).toBe('');
  });
  it('a link is a host and a path with no spaces', () => {
    expect([F.url('see a.org'), F.url('a.org now'), F.url('https://a.org now'), F.url('a.'), F.url('www.none.org'), F.url(' a.org/x?y=1 ')]).toEqual([undefined, undefined, undefined, undefined, 'https://www.none.org', 'https://a.org/x?y=1']);
  });
  it('a name that starts with DBA and two spaces, and a site name with its own parentheses', () => {
    expect(F.title(F.undba('DBA  HOPE HOUSE'))).toBe('Hope House');
    const e = (name: string, address: string) => ({ name, location: { address, city: 'Dayton', zip: '45402' } }) as never;
    expect(F.nameSites([e('Hope (East)', '1 Main St'), e('Hope (East)', '9 Elm St')]).map((x: { name: string }) => x.name)).toEqual(['Hope (East) (Dayton, 1 Main St)', 'Hope (East) (Dayton, 9 Elm St)']);
  });
  it('an address that does not start with its number is compared by name', () => {
    const at = (name: string, address: string) => ({ name, phone: '937-555-0100', location: { address, city: 'Dayton', zip: '45402' } });
    expect(F.samePlace(at('A', 'Suite 5, 100 Main St'), at('B', 'Suite 5, 200 Main St'))).toBe(false);
    expect(F.samePlace(at('A', 'Suite 5, 100 Main St'), at('a', 'Suite 9, 200 Main St'))).toBe(true);
  });
  it('apartment numerals only at the end, with any spaces around the comma', () => {
    const name = (n: string) => F.fromHudMultifamily([{ attributes: { PROPERTY_NAME_TEXT: n, STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9375550123' } }], area).entries[0]!.name;
    expect(name('OAK ,  II')).toBe('Oak II');
    expect(name('OAK, II ANNEX')).toBe('Oak, II Annex');
  });
  it('an IRS lead in the state but outside the area, or in the area under another state, is not a lead', () => {
    const lead = { EIN: '1', NAME: 'HOPE PANTRY', STATE: 'OH', ZIP: '45402', NTEE_CD: 'K31' };
    expect(F.leadsFromIrs([{ ...lead, ZIP: '45005' }, { ...lead, STATE: 'KY' }], area)).toEqual([]);
    // A record with no NTEE code at all is in no major group, so it is not a lead.
    const { NTEE_CD: _code, ...uncoded } = lead;
    expect(F.leadsFromIrs([uncoded], area)).toEqual([]);
  });
  it('a FindTreatment service with no label or text is read as empty', () => {
    const e = F.fromFindTreatment([{ name2: 'C', state: 'OH', zip: '45402', type_facility: 'MH', services: [{}, { f1: 'Payment/Insurance/Funding Accepted' }] } as never], area).entries[0]!;
    expect([e.description, 'cost' in e]).toEqual(['Treatment for mental health.', false]);
  });
  it('a FindTreatment record with no services at all is judged by its facility type alone', () => {
    const e = (type_facility?: string) => F.fromFindTreatment([{ name2: 'C', state: 'OH', zip: '45402', ...(type_facility ? { type_facility } : {}) } as never], area).entries[0]!;
    expect([e('MH').description, 'cost' in e('MH')]).toEqual(['Treatment for mental health.', false]);
    expect(e('SA').description).toBe('Treatment for substance use.');
    expect(e().description).toBe('Treatment for substance use.');
  });
  it('a FindTreatment service counts only under its own label, and any one of them is enough', () => {
    const e = (services: { f1?: string; f3?: string }[]) => F.fromFindTreatment([{ name2: 'C', state: 'OH', zip: '45402', type_facility: 'X', services } as never], area).entries[0]!;
    // Care named under the payment label is not care; a sliding fee named under the care label is not a fee.
    expect(e([{ f1: 'Payment/Insurance/Funding Accepted', f3: 'Mental health treatment' }]).description).toBe('Treatment for substance use.');
    expect('cost' in e([{ f1: 'Type of Care', f3: 'Sliding fee scale' }])).toBe(false);
    // One care service of several is enough, and so is one payment service of several.
    const both = e([
      { f1: 'Type of Care', f3: 'Outpatient' },
      { f1: 'Type of Care', f3: 'Mental health treatment' },
      { f1: 'Type of Care', f3: 'Detox' },
      { f1: 'Payment/Insurance/Funding Accepted', f3: 'Medicaid' },
      { f1: 'Payment/Insurance/Funding Accepted', f3: 'Sliding fee scale' },
    ]);
    expect([both.description, both.cost]).toEqual(['Treatment for mental health and substance use. It charges less if you earn less.', 'sliding-scale']);
  });
});

describe('a second name that is part of an address', () => {
  it('a suite, floor, building, room or unit in name2 is never the name; name1 is', () => {
    const one = (name2: string) => F.fromFindTreatment([{ name1: 'Miami Valley Recovery LLC', name2, state: 'OH', zip: '45402', services: [] } as never], area).entries[0]!.name;
    for (const n2 of ['Suite NWB 40', 'Ste 200', 'Floor 3', 'Fl 2', 'Building B', 'Bldg 4', 'Room 12', 'Rm 5', 'Unit 9', '#300']) expect(one(n2), n2).toBe('Miami Valley Recovery LLC');
    expect(one('Hope Center')).toBe('Hope Center');
    expect(one('Stepping Stones')).toBe('Stepping Stones');
    expect(one('Unity Recovery')).toBe('Unity Recovery');
  });
});

describe('names a student can recognize', () => {
  it('a town or an office in name2 is not a name: the organization leads, with an office kept beside it', () => {
    const n = (name2: string, name1 = 'Armada Recovery', city = 'Dayton') => F.facilityName({ name1, name2, city });
    expect(n('Dayton')).toBe('Armada Recovery');
    expect(n('DAYTON')).toBe('Armada Recovery');
    expect(n('Dayton Regional Office', 'National Youth Advocate Program Inc')).toBe('National Youth Advocate Program Inc (Dayton Regional Office)');
    expect(n('Main Office', 'Hope Center')).toBe('Hope Center (Main Office)');
    expect(n('Fairborn', 'DeCoach Rehabilitation Centre', 'Fairborn')).toBe('DeCoach Rehabilitation Centre');
    expect(n('New Season Dayton Treatment Center', 'New Season of Ohio, L.P.')).toBe('New Season Dayton Treatment Center');
    expect(n('Suite 200')).toBe('Armada Recovery');
    expect(n('', 'DBA Hope House')).toBe('Hope House');
    expect(n('Box Office Recovery')).toBe('Box Office Recovery');
    expect(n('Kenwood', 'Mindfully')).toBe('Mindfully (Kenwood)');
    expect(n('Dayton AOD', 'Mahajan Therapeutics')).toBe('Mahajan Therapeutics (Dayton AOD)');
    expect(n('Dayton MH', 'Mahajan Therapeutics')).toBe('Mahajan Therapeutics (Dayton MH)');
    expect(n('Dayton Treatment Services', 'Pinnacle Treatment Centers OH-V, LLC')).toBe('Dayton Treatment Services');
    expect(n('Kenwood', '')).toBe('Kenwood');
  });
  it('a HUD property whose registered name uses an outdated term for disability is held for a person, not shown', () => {
    const f = F.fromHudMultifamily([{ attributes: { PROPERTY_NAME_TEXT: 'SECOND MENTAL RETARDATION HSE', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9375550123', CLIENT_GROUP_NAME: 'Disabled' } }, { attributes: { PROPERTY_NAME_TEXT: 'OAK HOMES', STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: '9375550124' } }], area);
    expect(f.entries.map((e) => e.name)).toEqual(['Oak Homes']);
    expect(f.skipped).toEqual([{ source: F.HUD_MF_PAGE, name: 'Second Mental Retardation Hse', why: 'its registered name uses an outdated term for disability; a person decides how to list it' }]);
  });
  it('two programs of one organization at one address are told apart by their own phone numbers', () => {
    const e = (phone: string) => ({ name: 'DeCoach Rehabilitation Centre', phone, location: { address: '36 North Detroit Street, Suite 105', city: 'Xenia', zip: '45385' } }) as never;
    expect(F.nameSites([e('937-712-7628'), e('513-448-1117')]).map((x: { name: string }) => x.name)).toEqual(['DeCoach Rehabilitation Centre (Xenia, 36 North Detroit Street, 937-712-7628)', 'DeCoach Rehabilitation Centre (Xenia, 36 North Detroit Street, 513-448-1117)']);
  });
});

describe('pass 5: each rule a mutation run showed unstated', () => {
  it('a link must start with its scheme; text before it is not a link', () => {
    expect([F.url('see https://a.org'), F.url('https://a.org/x')]).toEqual([undefined, 'https://a.org/x']);
  });

  it('the census file: the first line is the header, never a ZIP; only a trailing " County" is dropped; a line cut short names no county', () => {
    expect([...F.zipCountyFrom(REL, ['GEOID_COUNTY_20'])]).toEqual([]);
    const head = REL.split('\n')[0]!;
    const rel = [head, '1|45402|Z|1|0|G|B|S|1|39113|Lake County Shores County|1|0|G|H|A|100|0', '1|45403|Z|1|0|G|B|S|1|39057'].join('\n');
    expect([...F.zipCountyFrom(rel, ['39113', '39057'])]).toEqual([['45402', 'Lake County Shores'], ['45403', '']]);
  });

  it('two programs at one address whose name already has parentheses: the phone goes in the last ones', () => {
    const e = (phone: string) => ({ name: 'Hope (East)', phone, location: { address: '1 Main St', city: 'Dayton', zip: '45402' } }) as never;
    expect(F.nameSites([e('937-555-0100'), e('937-555-0199')]).map((x: { name: string }) => x.name)).toEqual(['Hope (East) (Dayton, 1 Main St, 937-555-0100)', 'Hope (East) (Dayton, 1 Main St, 937-555-0199)']);
  });

  it('names: spaces around name1, name2 and the town are dropped before they are judged', () => {
    const n = (name2: string, name1: string, city?: string) => F.facilityName({ name1, name2, city });
    expect(n('  Kenwood  ', 'Mindfully', 'Dayton')).toBe('Mindfully (Kenwood)');
    expect(n('Suite 2', '   ', 'Dayton')).toBe('Suite 2');
    expect(n('Kenwood', 'Mindfully', ' Kenwood ')).toBe('Mindfully');
    expect(n('Kenwood', 'Mindfully')).toBe('Mindfully (Kenwood)');
    // A short code says which program only at the end of the name.
    expect(n('Dayton AOD Center', 'Mahajan Therapeutics', 'Dayton')).toBe('Dayton AOD Center');
  });

  it('a facility typed as substance use with mental health care listed offers both', () => {
    const e = F.fromFindTreatment([{ name2: 'C', state: 'OH', zip: '45402', type_facility: 'SA', services: [{ f1: 'Type of Care', f3: 'Mental health treatment' }] } as never], area).entries[0]!;
    expect(e.description).toBe('Treatment for mental health and substance use.');
  });

  it('HRSA: a "Lookalike" written as one word is still a look-alike, not called federally funded', () => {
    const e = F.fromHrsa([{ 'Site Name': 'Clinic', 'Health Center Type': 'Health Center Program Lookalike', 'Site State Abbreviation': 'OH', 'Site Postal Code': '45385', 'Site Status Description': 'Active' }], area).entries[0]!;
    expect(e.description).toBe('A community health center. It sees you with or without insurance, and charges less if you earn less.');
  });

  it('CSV: a row shorter than the header reads its missing cells as empty', () => {
    expect(F.parseCsv('a,b,c\n1,2\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});

describe('pass 6: the finder\'s word lists and patterns, each as the module loads', () => {
  it('a suite, floor or building names an address line only at the start of name2', () => {
    const n = (name2: string) => F.facilityName({ name1: 'Armada Recovery', name2, city: 'Dayton' });
    expect(n('Hope Building Center')).toBe('Hope Building Center');
    expect(n('Building 4')).toBe('Armada Recovery');
  });

  it('an office: up to three words, then an optional kind of office, then "Office"', () => {
    const n = (name2: string) => F.facilityName({ name1: 'Hope Center', name2, city: 'Dayton' });
    // Two words before "Office", with no kind of office named.
    expect(n('Dayton North Office')).toBe('Hope Center (Dayton North Office)');
    // Three words, then a kind of office, then a space before "Office".
    expect(n('Greene County Xenia Regional Office')).toBe('Hope Center (Greene County Xenia Regional Office)');
    // Four words before "Office" is a name of its own.
    expect(n('Miami Valley Child Development Office')).toBe('Miami Valley Child Development Office');
  });

  it('HUD\'s language codes, each in words', () => {
    const expected: [string, string][] = [
      ['ARA', 'Arabic'], ['ASL', 'American Sign Language'], ['CHI', 'Chinese'], ['CRE', 'Haitian Creole'], ['FAR', 'Farsi'], ['FRE', 'French'],
      ['GER', 'German'], ['HIN', 'Hindi'], ['HMO', 'Hmong'], ['ITA', 'Italian'], ['JPN', 'Japanese'], ['KHM', 'Khmer'], ['KOR', 'Korean'],
      ['NEP', 'Nepali'], ['POL', 'Polish'], ['POR', 'Portuguese'], ['RUS', 'Russian'], ['SOM', 'Somali'], ['SPA', 'Spanish'], ['SWA', 'Swahili'],
      ['TGL', 'Tagalog'], ['UKR', 'Ukrainian'], ['URD', 'Urdu'], ['VIE', 'Vietnamese'],
    ];
    expect(expected.map(([code]) => [code, F.languages(code)])).toEqual(expected);
  });

  it('"feeble-minded", "feeble minded" and "feebleminded" are each an outdated term, held for a person', () => {
    const p = (name: string, phone: string) => ({ attributes: { PROPERTY_NAME_TEXT: name, STD_ZIP5: '45402', PROPERTY_ON_SITE_PHONE_NUMBER: phone } });
    const f = F.fromHudMultifamily([p('FEEBLE-MINDED HOME', '9375550101'), p('FEEBLE MINDED HOME', '9375550102'), p('FEEBLEMINDED HOME', '9375550103'), p('OAK HOMES', '9375550104')], area);
    expect(f.entries.map((e) => e.name)).toEqual(['Oak Homes']);
    const why = 'its registered name uses an outdated term for disability; a person decides how to list it';
    expect(f.skipped).toEqual([
      { source: F.HUD_MF_PAGE, name: 'Feeble-Minded Home', why },
      { source: F.HUD_MF_PAGE, name: 'Feeble Minded Home', why },
      { source: F.HUD_MF_PAGE, name: 'Feebleminded Home', why },
    ]);
  });

  it('the HRSA sites file and the IMLS survey file are read from where each publishes them', () => {
    expect(F.HRSA).toBe('https://data.hrsa.gov/DataDownload/DD_Files/Health_Center_Service_Delivery_and_LookAlike_Sites.csv');
    expect(F.IMLS_PLS).toBe('https://www.imls.gov/sites/default/files/2026-06/pls_fy2024_csv.zip');
  });

  it('the IRS list: each NTEE major group that does a barrier\'s work, read only from the start of the code', () => {
    const codes: [string, string | undefined][] = [
      ['K31', 'food'], ['L41', 'housing'], ['F30', 'mental-health'], ['E32', 'health'], ['I70', 'safety'], ['P43', 'safety'],
      ['I80', 'legal'], ['R60', 'legal'], ['J30', 'career'], ['P30', 'childcare'], ['P33', 'childcare'], ['P80', 'caregiving'],
      ['P81', 'caregiving'], ['P20', 'money'], ['O50', 'belonging'], ['N50', 'wellbeing'], ['B60', 'academic'], ['B82', 'academic'],
      ['B90', 'academic'], ['B50', undefined],
      // A group's letters after the start of the code say nothing.
      ['A3K', undefined], ['A3L', undefined], ['A3J', undefined], ['A3P', undefined], ['A3O', undefined], ['A3I7', undefined],
      ['A3P43', undefined], ['A3I8', undefined], ['A3R6', undefined], ['A3P3', undefined], ['A3P33', undefined], ['A3P8', undefined],
      ['A3P81', undefined], ['A3B6', undefined], ['A3B82', undefined], ['A3B9', undefined],
    ];
    const rows = codes.map(([ntee], i) => ({ EIN: String(i), NAME: `ORG ${ntee}`, STREET: '1 MAIN ST', CITY: 'DAYTON', STATE: 'OH', ZIP: '45402', NTEE_CD: ntee }));
    const leads = F.leadsFromIrs(rows, area);
    const barrierOf = new Map(leads.map((l) => [l.ntee, l.barrier]));
    expect(codes.map(([ntee]) => [ntee, barrierOf.get(ntee)])).toEqual(codes);
    expect(leads).toHaveLength(19);
  });
});
