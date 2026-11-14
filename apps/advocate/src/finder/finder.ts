import type { Resource } from '../catalog/types.js';
import type { NeedCategory } from '../domain/types.js';

/**
 * The resource finder (docs/flows/resource-finder.md): point it at an area and it reads the public systems of record
 * that list help there, keeps what serves the area, and writes each record as a guide entry, with the system's own
 * query as its source. Each adapter here is a pure function from a source's records to entries; fetching is the
 * caller's (tools/find-resources.ts), so every adapter is tested on recorded rows.
 *
 * What a system of record does not say, an entry does not claim: no hours unless published, no eligibility beyond
 * "ask", no cost unless the program's own rules fix it (a federally funded health center must offer a sliding fee).
 */

export interface Area {
  /** Two-letter state. */
  state: string;
  /** County names as the student says them ("Montgomery"), each with its five-digit FIPS code. */
  counties: { name: string; fips: string }[];
  /** ZIP code to county name, from the Census ZIP-to-county relationship file (largest land share wins). */
  zipCounty: Map<string, string>;
  /** A point near the middle, for sources searched by distance. */
  center: { lat: number; lng: number };
  /** The day the sources were read. */
  today: string;
}

export interface Found {
  entries: Resource[];
  /** Records left out, each with why: outside the area, inactive, a school-only site, a duplicate. */
  skipped: { source: string; name: string; why: string }[];
}

/** A lead: an organization a registry says exists, with the kind of work it does, and nothing yet checked. */
export interface Lead {
  ein: string;
  name: string;
  address: string;
  city: string;
  zip: string;
  county: string;
  ntee: string;
  barrier?: NeedCategory;
  source: string;
}

export const FRESH_DAYS = 30;
const zip5 = (z: unknown) => String(z ?? '').replace(/\D/g, '').slice(0, 5);
const digits = (p: unknown) => String(p ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
export const phoneOf = (p: unknown): string | undefined => {
  const d = digits(p);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : undefined;
};
const slug = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const undba = (s: string) => s.replace(/^\s*dba\s+/i, '');
const title = (raw: string) => { const s = raw.replace(/\s+/g, ' ').trim(); return (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|And|For|The|In|At)\b/g, (m) => m.toLowerCase()).replace(/^./, (m) => m.toUpperCase()).replace(/\b(Ii|Iii|Iv|Vi|Vii)\b/g, (m) => m.toUpperCase())); };
const url = (u: unknown) => {
  const s = String(u ?? '').trim();
  if (!s || /in progress|n\/a|none/i.test(s)) return undefined;
  return /^https?:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+/.test(s) ? `https://${s}` : undefined;
};

/** The county a ZIP belongs to in this area, or undefined when it is outside. */
export const countyOf = (area: Area, zip: unknown) => area.zipCounty.get(zip5(zip));

/** Build the ZIP-to-county map from the Census 2020 ZCTA-to-county relationship file (pipe-separated). */
export function zipCountyFrom(relationship: string, fips: string[]): Map<string, string> {
  const lines = relationship.replace(/^﻿/, '').split(/\r?\n/);
  const head = lines[0]!.split('|');
  const col = (n: string) => head.indexOf(n);
  const [z, c, name, land] = [col('GEOID_ZCTA5_20'), col('GEOID_COUNTY_20'), col('NAMELSAD_COUNTY_20'), col('AREALAND_PART')];
  const best = new Map<string, { county: string; land: number }>();
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    const zip = f[z];
    if (!zip) continue;
    const share = Number(f[land] ?? 0);
    const prev = best.get(zip);
    if (!prev || share > prev.land) best.set(zip, { county: `${f[c]}|${(f[name] ?? '').replace(/ County$/, '')}`, land: share });
  }
  const out = new Map<string, string>();
  for (const [zip, { county }] of best) {
    const [code, nm] = county.split('|');
    if (fips.includes(code!)) out.set(zip, nm!);
  }
  return out;
}

/**
 * One organization often runs several sites under one name and one phone number. Each site keeps its own entry,
 * named with its town so a student can tell them apart (and the guide's duplicate check sees distinct places).
 */
export function nameSites(entries: Resource[]): Resource[] {
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.name.toLowerCase(), (count.get(e.name.toLowerCase()) ?? 0) + 1);
  const byTown = entries.map((e) => ((count.get(e.name.toLowerCase()) ?? 0) > 1 && e.location?.city ? { ...e, name: `${e.name} (${e.location.city})` } : e));
  // Two sites in the same town: the street tells them apart.
  const again = new Map<string, number>();
  for (const e of byTown) again.set(e.name.toLowerCase(), (again.get(e.name.toLowerCase()) ?? 0) + 1);
  return byTown.map((e) => ((again.get(e.name.toLowerCase()) ?? 0) > 1 && e.location?.address ? { ...e, name: e.name.replace(/\)$/, `, ${e.location.address.split(',')[0]})`) } : e));
}

/** The same phone and the same street number: one place. A shared main number alone (a library system) is not. */
export const samePlace = (a: Pick<Resource, 'phone' | 'location' | 'name'>, b: Pick<Resource, 'phone' | 'location' | 'name'>) => {
  const p = digits(a.phone);
  if (!p || p !== digits(b.phone)) return false;
  const num = (x: typeof a) => x.location?.address.match(/^\d+/)?.[0];
  return num(a) && num(b) ? num(a) === num(b) : a.name.toLowerCase() === b.name.toLowerCase();
};

/** Same phone and same street number means the same place, listed twice; the first listing is kept. */
export function dedupe(entries: Resource[], skipped: Found['skipped']): Resource[] {
  const seen = new Map<string, string>();
  const out: Resource[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    const key = `${digits(e.phone)}|${(e.location?.address ?? '').match(/^\d+/)?.[0] ?? e.name.toLowerCase()}`;
    if (seen.has(key)) {
      skipped.push({ source: e.source.url, name: e.name, why: `the same place as ${seen.get(key)}` });
      continue;
    }
    seen.set(key, e.name);
    let id = e.id;
    for (let n = 2; ids.has(id); n++) id = `${e.id}-${n}`;
    ids.add(id);
    out.push({ ...e, id });
  }
  return out;
}

// ---------------------------------------------------------------- SAMHSA FindTreatment

export const FINDTREATMENT = (area: Area, page = 1) =>
  `https://findtreatment.gov/locator/exportsAsJson/v2?sAddr=${area.center.lat},${area.center.lng}&limitType=2&limitValue=64374&pageSize=2000&page=${page}&sort=0`;
export const FINDTREATMENT_PAGE = 'https://findtreatment.gov/';

interface FtRow {
  name1?: string;
  name2?: string | null;
  street1?: string;
  street2?: string | null;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  intake1?: string | null;
  website?: string | null;
  type_facility?: string;
  services?: { f1?: string; f2?: string; f3?: string }[];
}

export function fromFindTreatment(rows: FtRow[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  for (const r of rows) {
    const name = title(undba(String(r.name2 || r.name1 || '').trim()));
    const county = r.state === area.state ? countyOf(area, r.zip) : undefined;
    if (!county) {
      skipped.push({ source: FINDTREATMENT_PAGE, name, why: 'outside the area' });
      continue;
    }
    const phone = phoneOf(r.intake1) ?? phoneOf(r.phone);
    const svc = (label: RegExp) => (r.services ?? []).filter((s) => label.test(s.f1 ?? '')).map((s) => s.f3 ?? '').join('; ');
    const care = svc(/type of care/i);
    const pay = svc(/payment|insurance|funding/i);
    const mh = /mental health/i.test(care) || r.type_facility === 'MH';
    const sa = /substance use|detox|opioid|buprenorphine|methadone/i.test(care) || /SA|BUPREN|OTP/.test(r.type_facility ?? '');
    const what = mh && sa ? 'mental health and substance use' : mh ? 'mental health' : 'substance use';
    entries.push({
      id: `ft-${slug(name)}-${zip5(r.zip)}`,
      name,
      organization: title(undba(String(r.name1 || name))),
      categories: ['mental-health'],
      description: `Treatment for ${what}.${/sliding fee/i.test(pay) ? ' It charges less if you earn less.' : ''}`,
      serves: { counties: [county] },
      location: { address: [r.street1, r.street2].filter(Boolean).join(', '), city: title(String(r.city ?? '')), zip: zip5(r.zip) },
      ...(phone ? { phone } : {}),
      ...(url(r.website) ? { url: url(r.website) } : {}),
      eligibility: { text: 'Call to ask who they serve.' },
      howToApply: [`Call${phone ? ` ${phone}` : ''} to ask for a first visit.`, 'Ask if they take your insurance or charge less if you earn less.'],
      documents: [],
      prefill: [],
      ...(/sliding fee/i.test(pay) ? { cost: 'sliding-scale' as const } : {}),
      source: { url: FINDTREATMENT_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: FRESH_DAYS,
      provider: { kind: 'health', level: 'local' },
      tags: ['found:findtreatment'],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- HRSA health center sites

export const HRSA = 'https://data.hrsa.gov/DataDownload/DD_Files/Health_Center_Service_Delivery_and_LookAlike_Sites.csv';
export const HRSA_PAGE = 'https://findahealthcenter.hrsa.gov/';

/** Rows keyed by the CSV's own column names. */
export function fromHrsa(rows: Record<string, string>[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  for (const r of rows) {
    const name = title((r['Site Name'] ?? '').trim());
    if (r['Site State Abbreviation'] !== area.state) continue;
    const county = countyOf(area, r['Site Postal Code']);
    if (!county) continue;
    if (!/^\s*active\s*$/i.test(r['Site Status Description'] ?? '')) {
      skipped.push({ source: HRSA_PAGE, name, why: `status ${r['Site Status Description'] || 'unknown'}` });
      continue;
    }
    const setting = r['Health Center Service Delivery Site Location Setting Description'] ?? '';
    if (/school/i.test(setting)) {
      skipped.push({ source: HRSA_PAGE, name, why: 'a school-based site, for that school\'s students' });
      continue;
    }
    const phone = phoneOf(r['Site Telephone Number']);
    const org = title((r['Health Center Name'] ?? r['Health Center Organization Name'] ?? name).trim());
    const look = /look-?alike/i.test(r['Health Center Type'] ?? '');
    entries.push({
      id: `hrsa-${slug(name)}-${zip5(r['Site Postal Code'])}`,
      name,
      organization: org,
      categories: ['health'],
      description: `A community health center${look ? '' : ' funded by the federal government'}. It sees you with or without insurance, and charges less if you earn less.`,
      serves: { counties: [county] },
      location: { address: (r['Site Address'] ?? '').trim(), city: title((r['Site City'] ?? '').trim()), zip: zip5(r['Site Postal Code']) },
      ...(phone ? { phone } : {}),
      ...(url(r['Site Web Address']) ? { url: url(r['Site Web Address']) } : {}),
      eligibility: { text: 'Anyone, with or without insurance.' },
      howToApply: [`Call${phone ? ` ${phone}` : ''} to make a visit.`, 'Ask about the sliding fee if money is tight.'],
      documents: [],
      prefill: [],
      cost: 'sliding-scale',
      whatToExpect: 'Health centers ask your income to set your fee. Bring proof of income if you have it.',
      source: { url: HRSA_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: FRESH_DAYS,
      provider: { kind: 'health', level: 'local' },
      tags: ['found:hrsa'],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- HUD housing counseling agencies

/** HUD's API searches by city; the finder asks for every city it has seen in the area. */
export const HUD_COUNSELING_CITY = (state: string, city: string) => `https://data.hud.gov/Housing_Counselor/search?AgencyName=&City=${encodeURIComponent(city)}&State=${state}`;
export const HUD_COUNSELING_PAGE = 'https://apps.hud.gov/offices/hsg/sfh/hcc/hcs.cfm';

interface HudRow {
  agcid?: string;
  nme?: string;
  adr1?: string;
  adr2?: string | null;
  city?: string;
  statecd?: string;
  zipcd?: string;
  phone1?: string;
  weburl?: string | null;
  languages?: string;
}

export function fromHudCounseling(rows: HudRow[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(String(r.agcid))) continue;
    seen.add(String(r.agcid));
    const name = title(String(r.nme ?? '').trim());
    const county = r.statecd === area.state ? countyOf(area, r.zipcd) : undefined;
    if (!county) {
      skipped.push({ source: HUD_COUNSELING_PAGE, name, why: 'outside the area' });
      continue;
    }
    const phone = phoneOf(r.phone1);
    const government = /\b(county|city of|authority|department)\b/i.test(name);
    const langs = String(r.languages ?? '').split(',').map((l) => l.trim()).filter((l) => l && l !== 'ENG');
    entries.push({
      id: `hud-${slug(name)}-${zip5(r.zipcd)}`,
      name,
      organization: name,
      categories: ['housing', 'money'],
      description: 'A housing counselor, checked by HUD, can help with rent, a home loan, credit, or buying a home.',
      serves: { counties: [county] },
      location: { address: [r.adr1, r.adr2].filter(Boolean).join(', '), city: title(String(r.city ?? '')), zip: zip5(r.zipcd) },
      ...(phone ? { phone } : {}),
      ...(url(r.weburl) ? { url: url(r.weburl) } : {}),
      eligibility: { text: 'Call to ask who they serve.' },
      howToApply: [`Call${phone ? ` ${phone}` : ''} and say what you need help with.`],
      documents: [],
      prefill: [],
      ...(langs.length ? { whatToExpect: `Counseling is offered in English and other languages too (${langs.join(', ')}).` } : {}),
      source: { url: HUD_COUNSELING_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: FRESH_DAYS,
      provider: { kind: government ? 'government' : 'nonprofit', level: 'local' },
      tags: ['found:hud-counseling'],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- HUD public housing authorities

export const HUD_PHA = (state: string) =>
  `https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Authorities/FeatureServer/0/query?where=STD_ST%3D%27${state}%27&outFields=*&f=json&resultRecordCount=2000`;
export const HUD_PHA_PAGE = 'https://www.hud.gov/program_offices/public_indian_housing/pha/contacts';

export function fromHudPha(features: { attributes: Record<string, unknown> }[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  for (const { attributes: a } of features) {
    const county = countyOf(area, a.STD_ZIP5);
    if (!county) continue;
    const name = title(String(a.FORMAL_PARTICIPANT_NAME ?? '').replace(/Metropolitian/g, 'Metropolitan').trim());
    const phone = phoneOf(a.HA_PHN_NUM);
    entries.push({
      id: `pha-${slug(name)}`,
      name,
      organization: name,
      categories: ['housing'],
      description: 'The public housing authority: public housing, and Housing Choice Vouchers (Section 8) that help pay rent.',
      serves: { counties: [county] },
      location: { address: String(a.STD_ADDR ?? '').trim(), city: title(String(a.STD_CITY ?? '')), zip: zip5(a.STD_ZIP5) },
      ...(phone ? { phone } : {}),
      eligibility: { text: 'Based on income and household size.' },
      howToApply: [`Call${phone ? ` ${phone}` : ''} to ask if the waiting list is open.`, 'Ask how to get on the list, and what to bring.'],
      documents: [],
      prefill: [],
      whatToExpect: 'Waiting lists can be long, and they open and close. Ask when this one will open if it is closed.',
      source: { url: HUD_PHA_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: FRESH_DAYS,
      provider: { kind: 'government', level: 'county' },
      tags: ['found:hud-pha'],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- HUD multifamily assisted housing

export const HUD_MF = (state: string, offset = 0) =>
  `https://services.arcgis.com/VTyQ9soqVukalItT/ArcGIS/rest/services/MULTIFAMILY_PROPERTIES_ASSISTED/FeatureServer/0/query?where=STD_ST%3D%27${state}%27&outFields=PROPERTY_ID,PROPERTY_NAME_TEXT,STD_ADDR,STD_CITY,STD_ZIP5,PROPERTY_ON_SITE_PHONE_NUMBER,CLIENT_GROUP_NAME,TOTAL_ASSISTED_UNIT_COUNT&f=json&resultOffset=${offset}&resultRecordCount=2000`;
export const HUD_MF_PAGE = 'https://resources.hud.gov/';

/** Apartments where HUD helps pay the rent, so rent is based on income. Each has its own application and wait list. */
export function fromHudMultifamily(features: { attributes: Record<string, unknown> }[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  for (const { attributes: a } of features) {
    const county = countyOf(area, a.STD_ZIP5);
    if (!county) continue;
    const name = title(String(a.PROPERTY_NAME_TEXT ?? '').replace(/,\s*(II|III|IV)$/i, ' $1').trim());
    const phone = phoneOf(a.PROPERTY_ON_SITE_PHONE_NUMBER);
    if (!phone) {
      skipped.push({ source: HUD_MF_PAGE, name, why: 'no phone number in the record' });
      continue;
    }
    const group = String(a.CLIENT_GROUP_NAME ?? '');
    const elderly = /elderly/i.test(group) && !/family/i.test(group);
    const disabled = /disab/i.test(group) && !/family|elderly/i.test(group);
    const units = Number(a.TOTAL_ASSISTED_UNIT_COUNT ?? 0);
    entries.push({
      id: `hudmf-${slug(name)}-${zip5(a.STD_ZIP5)}`,
      name,
      organization: name,
      categories: ['housing'],
      description: `Apartments where HUD helps pay the rent, so what you pay is based on your income${units ? ` (${units} such units)` : ''}.`,
      serves: { counties: [county] },
      location: { address: title(String(a.STD_ADDR ?? '').trim()), city: title(String(a.STD_CITY ?? '')), zip: zip5(a.STD_ZIP5) },
      phone,
      eligibility: { text: elderly ? 'For older adults, based on income.' : disabled ? 'For people with disabilities, based on income.' : 'Based on income and household size.' },
      howToApply: [`Call ${phone} to ask if the wait list is open.`, 'Ask how to apply, and what to bring.'],
      documents: [],
      prefill: [],
      whatToExpect: 'Each building has its own wait list. Putting your name on several can help.',
      source: { url: HUD_MF_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: FRESH_DAYS,
      provider: { kind: 'government', level: 'federal' },
      tags: ['found:hud-multifamily', ...(elderly ? ['older-adults'] : []), ...(disabled ? ['disability'] : [])],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- Public libraries (IMLS Public Libraries Survey)

export const IMLS_PLS = 'https://www.imls.gov/sites/default/files/2026-06/pls_fy2024_csv.zip';
export const IMLS_PAGE = 'https://www.imls.gov/research-evaluation/surveys/public-libraries-survey-pls';

/** Library branches: free computers, internet and a quiet place to study, often with Wi-Fi hotspots to borrow. */
export function fromLibraries(rows: Record<string, string>[], area: Area): Found {
  const skipped: Found['skipped'] = [];
  const entries: Resource[] = [];
  for (const r of rows) {
    if (r.STABR !== area.state) continue;
    const county = countyOf(area, r.ZIP);
    if (!county) continue;
    const name = title((r.LIBNAME ?? '').trim());
    if (/BS|BM/.test(r.C_OUT_TY ?? '')) {
      skipped.push({ source: IMLS_PAGE, name, why: 'a bookmobile, with no fixed place' });
      continue;
    }
    const phone = phoneOf(r.PHONE);
    const hours = Number(r.HOURS ?? 0);
    const weeks = Number(r.WKS_OPEN ?? 0);
    entries.push({
      id: `lib-${slug(name)}-${zip5(r.ZIP)}`,
      name,
      organization: title((r.STATNAME ?? name).trim()) || name,
      categories: ['phone-internet', 'academic'],
      description: 'A public library. Use the computers, Wi-Fi and printers for free, and study there.',
      serves: { counties: [county] },
      location: { address: title((r.ADDRESS ?? '').trim()), city: title((r.CITY ?? '').trim()), zip: zip5(r.ZIP) },
      ...(phone ? { phone } : {}),
      eligibility: { text: 'Anyone can come in.' },
      howToApply: ['Go in during open hours.', 'Ask for a library card to borrow things and use the computers longer.'],
      documents: [],
      prefill: [],
      cost: 'free',
      ...(hours > 0 && weeks > 0 ? { whatToExpect: `Open about ${Math.round(hours / weeks)} hours a week. Check the library's site for today's hours.` } : {}),
      source: { url: IMLS_PAGE, license: 'public-information' },
      verifiedOn: area.today,
      freshnessDays: 90,
      provider: { kind: 'government', level: 'local' },
      tags: ['found:imls'],
    });
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------- IRS exempt organizations (leads only)

export const IRS_EO = (state: string) => `https://www.irs.gov/pub/irs-soi/eo_${state.toLowerCase()}.csv`;

/** NTEE major groups that do the work of a barrier in the taxonomy. Everything else is not a lead for the guide. */
const NTEE_BARRIER: [RegExp, NeedCategory][] = [
  [/^K/, 'food'],
  [/^L/, 'housing'],
  [/^F/, 'mental-health'],
  [/^E/, 'health'],
  [/^I7|^P43/, 'safety'],
  [/^I8|^R6/, 'legal'],
  [/^J/, 'career'],
  [/^P3|^P33/, 'childcare'],
  [/^P8|^P81/, 'caregiving'],
  [/^P/, 'money'],
  [/^O/, 'belonging'],
  [/^N/, 'wellbeing'],
  [/^B6|^B82|^B9/, 'academic'],
];

export function leadsFromIrs(rows: Record<string, string>[], area: Area): Lead[] {
  const out: Lead[] = [];
  for (const r of rows) {
    const county = countyOf(area, r.ZIP);
    if (!county || r.STATE !== area.state) continue;
    const ntee = (r.NTEE_CD ?? '').trim().toUpperCase();
    const barrier = NTEE_BARRIER.find(([re]) => re.test(ntee))?.[1];
    if (!barrier) continue;
    out.push({ ein: r.EIN!, name: title((r.NAME ?? '').trim()), address: title((r.STREET ?? '').trim()), city: title((r.CITY ?? '').trim()), zip: zip5(r.ZIP), county, ntee, barrier, source: IRS_EO(area.state) });
  }
  return out.sort((a, b) => a.barrier!.localeCompare(b.barrier!) || a.name.localeCompare(b.name));
}

/** A minimal CSV reader: quoted fields, commas and doubled quotes inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

/** One source as a run read it: enough to tell, on the next run, whether the system of record changed under us. */
export interface SourceRead { name: string; status: number; records: number; kept: number }

/**
 * A system of record that changes shape usually does not fail; it answers 200 with nothing in it, or with a field
 * renamed so every record is left out. The finder compares each source with its last run and names what moved, so a
 * quiet loss is a failed run, not a smaller guide.
 */
export function drift(before: SourceRead[], now: SourceRead[]): string[] {
  const out: string[] = [];
  for (const b of before) {
    const n = now.find((s) => s.name === b.name);
    if (!n) { out.push(`${b.name}: not read this run`); continue; }
    if (n.status < 200 || n.status >= 300) out.push(`${b.name}: answered ${n.status || 'nothing'}`);
    else if (b.records > 0 && n.records === 0) out.push(`${b.name}: answered with no records (last run ${b.records})`);
    else if (n.records < b.records / 2) out.push(`${b.name}: ${n.records} records, under half of last run's ${b.records}`);
    else if (b.kept > 0 && n.kept === 0 && n.records > 0) out.push(`${b.name}: ${n.records} records read and none kept; a field may have been renamed`);
    else if (b.kept >= 10 && n.kept < b.kept / 2) out.push(`${b.name}: ${n.kept} kept, under half of last run's ${b.kept}`);
  }
  return out;
}
