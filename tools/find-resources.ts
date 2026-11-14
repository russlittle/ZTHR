/**
 * The resource finder, run for an area (docs/flows/resource-finder.md). Reads the public systems of record, keeps
 * what serves the area, checks every entry against the guide's admission gates, and writes what it found.
 *
 *   npx tsx tools/find-resources.ts find --state OH --counties Montgomery:39113,Greene:39057 --center 39.7589,-84.1916 --out found
 *   npx tsx tools/find-resources.ts catalog found/found.json dayton
 *
 * `find` needs the network (it runs on GitHub: .github/workflows/find-resources.yml in the site repository).
 * `catalog` turns a run's output into the guide's generated catalog module and its scout, so admitted entries reach
 * students and the feed, and the run's report reaches the docs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAYTON_CATALOG } from '../apps/advocate/src/catalog/dayton.js';
import type { Resource } from '../apps/advocate/src/catalog/types.js';
import { admit } from '../apps/advocate/src/guide/admission.js';
import * as F from '../apps/advocate/src/finder/finder.js';

const UA = 'zthr-resource-finder (+https://zthr.ai/reference/docs/flows/resource-finder.html)';
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};

async function get(url: string, as: 'text' | 'json' = 'text'): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(180_000) });
      if (r.status >= 500) throw new Error(String(r.status));
      return { ok: r.ok, status: r.status, body: r.ok ? (as === 'json' ? await r.json() : await r.text()) : undefined };
    } catch (e) {
      if (attempt === 2) return { ok: false, status: 0, body: String(e) };
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  return { ok: false, status: 0, body: undefined };
}

interface SourceReport {
  name: string;
  url: string;
  status: number;
  records: number;
  kept: number;
  note?: string;
}

async function find(): Promise<void> {
  const state = arg('state', 'OH')!;
  const counties = arg('counties', 'Montgomery:39113,Greene:39057')!.split(',').map((x) => ({ name: x.split(':')[0]!, fips: x.split(':')[1]! }));
  const [lat, lng] = arg('center', '39.7589,-84.1916')!.split(',').map(Number);
  const out = arg('out', 'found')!;
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(out, { recursive: true });
  const sources: SourceReport[] = [];

  const rel = await get('https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt');
  if (!rel.ok) throw new Error(`the Census ZIP-to-county file answered ${rel.status}`);
  const area: F.Area = { state, counties, zipCounty: F.zipCountyFrom(rel.body as string, counties.map((c) => c.fips)), center: { lat: lat!, lng: lng! }, today };
  sources.push({ name: 'Census ZIP-to-county relationship', url: 'https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.2020.html', status: rel.status, records: area.zipCounty.size, kept: area.zipCounty.size, note: 'ZIP codes in the area' });

  const all: Resource[] = [];
  const skipped: F.Found['skipped'] = [];
  const take = (name: string, url: string, status: number, records: number, found: F.Found, note?: string) => {
    all.push(...found.entries);
    skipped.push(...found.skipped);
    sources.push({ name, url, status, records, kept: found.entries.length, ...(note ? { note } : {}) });
  };

  // SAMHSA FindTreatment: every page within 40 miles of the center, then narrowed to the area's ZIP codes.
  const ftRows: unknown[] = [];
  let ftStatus = 0;
  for (let page = 1, pages = 1; page <= pages && page <= 10; page++) {
    const r = await get(F.FINDTREATMENT(area, page), 'json');
    ftStatus = r.status;
    if (!r.ok) break;
    const d = r.body as { totalPages?: number; rows?: unknown[] };
    pages = d.totalPages ?? 1;
    ftRows.push(...(d.rows ?? []));
  }
  take('SAMHSA FindTreatment', F.FINDTREATMENT_PAGE, ftStatus, ftRows.length, F.fromFindTreatment(ftRows as never, area));

  const hrsa = await get(F.HRSA);
  const hrsaRows = hrsa.ok ? F.parseCsv(hrsa.body as string) : [];
  take('HRSA health center sites', F.HRSA_PAGE, hrsa.status, hrsaRows.filter((r) => r['Site State Abbreviation'] === state).length, F.fromHrsa(hrsaRows, area), 'records in the state');

  const pha = await get(F.HUD_PHA(state), 'json');
  const phaRows = pha.ok ? ((pha.body as { features?: { attributes: Record<string, unknown> }[] }).features ?? []) : [];
  take('HUD public housing authorities', F.HUD_PHA_PAGE, pha.status, phaRows.length, F.fromHudPha(phaRows, area), 'records in the state');

  // The IRS list gives the leads, and the area's city names for sources searched by city.
  const eo = await get(F.IRS_EO(state));
  const eoRows = eo.ok ? F.parseCsv(eo.body as string) : [];
  const leads = F.leadsFromIrs(eoRows, area);
  const cities = [...new Set(eoRows.filter((r) => F.countyOf(area, r.ZIP)).map((r) => (r.CITY ?? '').trim().toUpperCase()).filter(Boolean))].sort();
  sources.push({ name: 'IRS exempt organizations', url: F.IRS_EO(state), status: eo.status, records: eoRows.length, kept: 0, note: `${leads.length} leads in the area, not yet checked; ${cities.length} cities` });

  const hud: unknown[] = [];
  let hudStatus = 0;
  for (const city of cities.slice(0, 80)) {
    const r = await get(F.HUD_COUNSELING_CITY(state, city), 'json');
    hudStatus = r.status || hudStatus;
    if (r.ok && Array.isArray(r.body)) hud.push(...r.body);
    await new Promise((res) => setTimeout(res, 300));
  }
  take('HUD housing counseling agencies', F.HUD_COUNSELING_PAGE, hudStatus, hud.length, F.fromHudCounseling(hud as never, area), `searched ${Math.min(cities.length, 80)} cities`);

  // A place the guide already lists by hand keeps its hand entry; then duplicates across sources go.
  const known = new Set(DAYTON_CATALOG.map((r) => (r.phone ?? '').replace(/\D/g, '')).filter((p) => p.length >= 10));
  const fresh = all.filter((e) => {
    const p = (e.phone ?? '').replace(/\D/g, '');
    if (p && known.has(p)) {
      skipped.push({ source: e.source.url, name: e.name, why: 'already in the guide, by hand' });
      return false;
    }
    return true;
  });
  const entries = F.dedupe(fresh, skipped);
  const owners = new Set(entries.map((e) => e.id));
  const checked = entries.map((e) => ({ e, failed: admit(e, [...DAYTON_CATALOG, ...entries], owners).filter((c) => !c.ok) }));
  const admitted = checked.filter((c) => !c.failed.length).map((c) => c.e);
  const held = checked.filter((c) => c.failed.length).map((c) => ({ id: c.e.id, name: c.e.name, failed: c.failed.map((f) => `${f.name}: ${f.detail}`) }));

  const result = { area: { state, counties: counties.map((c) => c.name), center: area.center }, generatedOn: today, sources, admitted, held, skipped, leads };
  writeFileSync(join(out, 'found.json'), JSON.stringify(result, null, 1));
  console.log(`${admitted.length} admitted, ${held.length} held, ${skipped.length} skipped, ${leads.length} leads`);
  for (const s of sources) console.log(`  ${s.name}: ${s.status} ${s.records} records, ${s.kept} kept${s.note ? ` (${s.note})` : ''}`);
  for (const h of held.slice(0, 20)) console.log(`  held ${h.id}: ${h.failed.join('; ')}`);
}

/** From a run's found.json to the generated catalog module and its scout. */
function catalog(file: string, region: string): void {
  const r = JSON.parse(readFileSync(file, 'utf8')) as { area: { state: string; counties: string[] }; generatedOn: string; sources: SourceReport[]; admitted: Resource[]; held: unknown[]; skipped: unknown[]; leads: F.Lead[] };
  const dir = 'apps/advocate/src/catalog/found';
  mkdirSync(dir, { recursive: true });
  const id = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  writeFileSync(
    join(dir, `${region}.ts`),
    `// Generated by tools/find-resources.ts from the run of ${r.generatedOn}. Do not edit: run the finder again.\n` +
      `import type { Resource } from '../types.js';\n\n` +
      `/** ${r.admitted.length} entries found in the public systems of record for ${r.area.counties.join(' and ')} counties, ${r.area.state}, each admitted by the guide's gates. */\n` +
      `export const FOUND_${id(region)}: Resource[] = ${JSON.stringify(r.admitted, null, 1)};\n\n` +
      `/** What the run read, and what it kept from each. */\nexport const FOUND_${id(region)}_RUN = ${JSON.stringify({ generatedOn: r.generatedOn, area: r.area, sources: r.sources, held: r.held.length, skipped: r.skipped.length, leads: r.leads.length }, null, 1)};\n`,
  );
  writeFileSync(join(dir, `${region}-leads.json`), `${JSON.stringify({ generatedOn: r.generatedOn, area: r.area, note: 'Organizations the IRS lists in the area whose kind of work matches a barrier. Not checked; never shown to a student as help.', leads: r.leads }, null, 1)}\n`);
  writeFileSync(
    join('control/scouts', `found-${region}.yaml`),
    `# Generated by tools/find-resources.ts. The finder is the scout for these entries: it re-reads each system of record on every run.\n` +
      `scout: found-${region}\ngeography: { state: ${r.area.state}, region: ${r.area.counties.join(" and ")} }\n` +
      `needs: [${[...new Set(r.admitted.flatMap((e) => e.categories))].sort().join(', ')}]\n` +
      `sources:\n${r.sources.map((s) => `  - { url: "${s.url}", kind: government }`).join('\n')}\n` +
      `entries: [${r.admitted.map((e) => e.id).join(', ')}]\nfreshness_days: ${F.FRESH_DAYS}\ndatum: { precision_min: 0.85 }\nowner: builder\nadmitted_by: factory\n`,
  );
  console.log(`${r.admitted.length} entries written to ${dir}/${region}.ts; ${r.leads.length} leads to ${dir}/${region}-leads.json`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'find') await find();
else if (cmd === 'catalog') catalog(rest[0]!, rest[1] ?? 'dayton');
else {
  console.log('usage: find-resources.ts find --state OH --counties Name:FIPS,... --center lat,lng --out dir | catalog found.json region');
  process.exit(2);
}
