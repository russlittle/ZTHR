// Verifies docs/security.md
import { describe, expect, it } from 'vitest';
import { advisories, sbom, unregistered, type Entry } from '../deps.js';

const audit = {
  vulnerabilities: {
    zod: { severity: 'high' as const, via: [{ title: 'Zod can exhaust memory' }], fixAvailable: { name: 'zod', version: '4.6.7', isSemVerMajor: true } },
    'zod-to-json-schema': { severity: 'high' as const, via: ['zod'], fixAvailable: true },
    hono: { severity: 'moderate' as const, via: [{ url: 'https://github.com/advisories/x' }], fixAvailable: false },
    left: { severity: 'critical' as const, via: [{ title: 'Remote code' }], fixAvailable: { name: 'left', version: '2.0.1', isSemVerMajor: false } },
  },
};
const reg = (over: Partial<Entry> = {}): Entry => ({ id: 'zod-major-upgrade', gate: 'dependencies', packages: ['zod', 'zod-to-json-schema'], owner: 'claude-agent', reason: 'bounded', expires: '2026-12-15', ...over });

describe('dependencies: every production advisory audited, every serious one registered', () => {
  it('reads each advisory with its cause and its fix', () => {
    expect(advisories(audit)).toEqual([
      { pkg: 'hono', severity: 'moderate', via: ['https://github.com/advisories/x'], fix: 'no fix yet' },
      { pkg: 'left', severity: 'critical', via: ['Remote code'], fix: 'left@2.0.1' },
      { pkg: 'zod', severity: 'high', via: ['Zod can exhaust memory'], fix: 'zod@4.6.7, a breaking upgrade' },
      { pkg: 'zod-to-json-schema', severity: 'high', via: ['zod'], fix: 'fix available' },
    ]);
    expect(advisories({})).toEqual([]);
  });
  it('a high or critical advisory passes only while registered, owned, reasoned and unexpired', () => {
    const found = advisories(audit);
    expect(unregistered(found, [reg()], '2026-11-15')).toEqual(['left (critical): Remote code; left@2.0.1; not registered']);
    expect(unregistered(found, [reg(), reg({ id: 'l', packages: ['left'] })], '2026-11-15')).toEqual([]);
    expect(unregistered(found, [reg(), reg({ id: 'l', packages: ['left'] })], '2026-12-16')[0]).toBe('left (critical): registered as l, which expired on 2026-12-15');
    expect(unregistered(found, [reg(), reg({ id: 'l', packages: ['left'], owner: undefined })], '2026-11-15')).toEqual(['left (critical): registered as l without an owner, a reason and an expiry']);
    expect(unregistered(found, [reg({ gate: 'ui-walk' })], '2026-11-15')).toHaveLength(3);
    expect(unregistered(found, [reg(), reg({ id: 'l', packages: ['left'] })], '2026-12-15')).toEqual([]);
  });
  it('the bill of materials lists every production package once, with its package URL, and no development package', () => {
    const lock = { name: 'zthr', version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/zod': { version: '3.25.0', license: 'MIT' }, 'node_modules/@hono/node-server': { version: '2.1.8' }, 'node_modules/a/node_modules/zod': { version: '3.25.0' }, 'node_modules/vitest': { version: '3.2.0', dev: true }, 'node_modules/@zthr/ui': { link: true, version: '0.0.0' } } };
    const b = sbom(lock, '2026-11-15T00:00:00Z');
    expect(b).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { timestamp: '2026-11-15T00:00:00Z', component: { name: 'zthr', version: '0.1.0' } } });
    expect(b.components).toEqual([
      { type: 'library', name: '@hono/node-server', version: '2.1.8', purl: 'pkg:npm/%40hono/node-server@2.1.8' },
      { type: 'library', name: 'zod', version: '3.25.0', purl: 'pkg:npm/zod@3.25.0', licenses: [{ license: { id: 'MIT' } }] },
    ]);
  });
});
