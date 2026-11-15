/**
 * The dependencies check (docs/security.md). Every production dependency is audited on every build. A high or
 * critical advisory passes only while it is registered in control/register.yaml with the packages it covers, an
 * owner, a reason and an unexpired date; anything else fails the build by name. Lower advisories are recorded. The
 * build also writes a CycloneDX software bill of materials for the application image.
 *
 *   npx tsx tools/deps.ts [audit.json]     (default: runs npm audit --omit=dev)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CONTROL, OUT } from './lib.js';

export interface Advisory {
  pkg: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  via: string[];
  fix: string;
}
export interface Entry {
  id: string;
  gate?: string;
  packages?: string[];
  expires?: string;
  owner?: string;
  reason?: string;
}

export function advisories(audit: { vulnerabilities?: Record<string, { severity: Advisory['severity']; via: (string | { title?: string; url?: string })[]; fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean } }> }): Advisory[] {
  return Object.entries(audit.vulnerabilities ?? {})
    .map(([pkg, v]) => ({
      pkg,
      severity: v.severity,
      via: v.via.map((x) => (typeof x === 'string' ? x : (x.title ?? x.url ?? 'advisory'))),
      fix: v.fixAvailable === false ? 'no fix yet' : v.fixAvailable === true ? 'fix available' : `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ', a breaking upgrade' : ''}`,
    }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** Each high or critical advisory with no registered, unexpired entry covering its package. */
export function unregistered(found: Advisory[], register: Entry[], today: string): string[] {
  return found
    .filter((a) => a.severity === 'high' || a.severity === 'critical')
    .flatMap((a) => {
      const e = register.find((r) => r.gate === 'dependencies' && (r.packages ?? []).includes(a.pkg));
      if (!e) return [`${a.pkg} (${a.severity}): ${a.via.join('; ')}; ${a.fix}; not registered`];
      if (!e.owner || !e.reason || !e.expires) return [`${a.pkg} (${a.severity}): registered as ${e.id} without an owner, a reason and an expiry`];
      if (e.expires < today) return [`${a.pkg} (${a.severity}): registered as ${e.id}, which expired on ${e.expires}`];
      return [];
    });
}

/** A CycloneDX 1.5 bill of materials: every production package in the lockfile, with its version and package URL. */
export function sbom(lock: { name?: string; version?: string; packages: Record<string, { version?: string; dev?: boolean; license?: string; link?: boolean }> }, at: string) {
  const components = Object.entries(lock.packages)
    .filter(([path, p]) => path.startsWith('node_modules/') && !p.dev && !p.link && p.version)
    .map(([path, p]) => {
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      return { type: 'library', name, version: p.version!, purl: `pkg:npm/${name.replace('@', '%40')}@${p.version}`, ...(p.license ? { licenses: [{ license: { id: p.license } }] } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const unique = components.filter((c, i) => i === 0 || c.purl !== components[i - 1]!.purl);
  return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { timestamp: at, component: { type: 'application', name: lock.name ?? 'app', version: lock.version ?? '0.0.0' } }, components: unique };
}

if (process.argv[1]?.endsWith('deps.ts')) {
  const raw = process.argv[2]
    ? readFileSync(process.argv[2], 'utf8')
    : (() => {
        try {
          return execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
        } catch (e) {
          // npm audit exits non-zero when it finds anything; its report is still on stdout.
          return (e as { stdout?: string }).stdout ?? '';
        }
      })();
  const found = advisories(JSON.parse(raw));
  const register = (parse(readFileSync(join(CONTROL, 'register.yaml'), 'utf8')) as { findings: Entry[] }).findings;
  const bad = unregistered(found, register, new Date().toISOString().slice(0, 10));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'dependencies.json'), JSON.stringify({ at: new Date().toISOString(), advisories: found, unregistered: bad }, null, 1));
  const bom = sbom(JSON.parse(readFileSync(join(CONTROL, '..', 'package-lock.json'), 'utf8')), new Date().toISOString());
  writeFileSync(join(OUT, 'sbom.cdx.json'), JSON.stringify(bom, null, 1));
  console.log(`Bill of materials: ${bom.components.length} production packages, evidence-out/sbom.cdx.json`);
  for (const a of found) console.log(`${a.severity.padEnd(9)} ${a.pkg}: ${a.via.join('; ')} (${a.fix})`);
  console.log(found.length ? `${found.length} production advisories; ${bad.length} not registered` : 'No production advisories.');
  for (const b of bad) console.log(`UNREGISTERED ${b}`);
  if (bad.length) process.exit(1);
}
