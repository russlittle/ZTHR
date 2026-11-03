// Verifies docs/data-model.md
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTIONS, COLLECTION_NAMES } from '../src/domain/schema.js';
import { exploreAdvocate } from './harness/world.js';
import { Advocate } from '../src/agents/advocate.js';
import { PERSONAS, PERSONA_NAMES } from '../src/server/demo.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const files = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
const written = new Set(files(SRC).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/store\.put(?:<[^>]*>)?\('([a-z_]+)'/g)].map((m) => m[1]!)));

describe('the declared data model matches the code', () => {
  for (const c of written) it(`code writes "${c}", which is declared`, () => expect(COLLECTION_NAMES).toContain(c));
  for (const c of COLLECTION_NAMES) it(`declared "${c}" is written somewhere`, () => expect([...written]).toContain(c));
  it('collection names are unique', () => expect(new Set(COLLECTION_NAMES).size).toBe(COLLECTION_NAMES.length));
  for (const c of COLLECTIONS) for (const [to] of c.relations ?? []) it(`${c.name} relates to a declared collection: ${to}`, () => expect(COLLECTION_NAMES).toContain(to));
});

/** After real use, every stored document has only declared fields, and every required field. */
function checkDocs(a: Advocate, sid: string): string[] {
  const problems: string[] = [];
  for (const [coll, docs] of Object.entries(a.store.exportStudent(sid))) {
    const def = COLLECTIONS.find((c) => c.name === coll);
    if (!def) {
      problems.push(`undeclared collection ${coll}`);
      continue;
    }
    for (const d of docs as Record<string, unknown>[]) {
      for (const k of Object.keys(d)) if (!def.fields.some((f) => f.name === k)) problems.push(`${coll}.${k} is not declared`);
      for (const f of def.fields) if (!f.optional && !(f.name in d)) problems.push(`${coll}.${f.name} is required but missing`);
    }
  }
  return problems;
}

describe('stored documents match their declarations', () => {
  for (const name of PERSONA_NAMES) {
    it(`${name}, as seeded`, () => {
      const a = new Advocate({ today: () => '2026-11-02' });
      const s = PERSONAS[name]!(a);
      expect(checkDocs(a, s.id)).toEqual([]);
    });
  }
  it('after a full walk of every button for Maria, every document still matches', () => {
    const r = exploreAdvocate({ only: ['Maria'], withTyping: false, maxNodes: 400 });
    expect(r.violations).toEqual([]);
    // The walk's worlds are gone; replay a busy session instead and check it.
    const a = new Advocate({ today: () => '2026-11-02' });
    const s = PERSONAS.Maria!(a);
    for (const act of r.actionsSeen.filter((x) => !x.startsWith('say:') && x !== 'delete-account')) a.perform(s.id, act.replace('dl_*', a.deadlines(s.id)[0]!.id));
    a.issueApiToken(s.id, 'test', ['read']);
    a.addWebhook(s.id, 'https://hooks.example.com/x', ['*']);
    expect(checkDocs(a, s.id)).toEqual([]);
  }, 120_000);
});
