/**
 * Compliance as part of the intent, not an audit after it.
 *
 * Which frameworks apply is decided on the schematic: the person names them ("it must meet FERPA and SOC 2"), or
 * chooses them on the spec sheet, and the factory suggests the ones the information calls for (health records suggest
 * HIPAA; student records, FERPA; defense work, NIST SP 800-171). Each framework's controls are mapped to evidence the
 * factory already produces on every release: access rules, the audit chain, signed changes, gates, the data pipeline,
 * supply-chain provenance, monitoring. Evidence is collected once and serves every control, in every framework, that
 * needs it. What the factory cannot prove (policies, training, vendors, people) is named as the organization's, with
 * what to supply.
 *
 * The sensitive-data inventory is the same in every app, so the fleet can be read as one: every sensitive field, its
 * class, the frameworks it falls under, who may read it and where it may flow. A gate policy written from it lets a
 * central API gateway allow or refuse by class, the same way for every app.
 *
 * Machine-readable output follows OSCAL, NIST's Open Security Controls Assessment Language, so assessors' tools can read
 * it as it is.
 */
import frameworksData from '../catalog/frameworks.json' with { type: 'json' };
import { sha256 } from './hash.ts';
import type { Prepared } from './pipeline.ts';
import type { Schema } from './schema.ts';

interface Control { id: string; title: string; by: string[] }
interface Framework { id: string; name: string; version: string; authority: string; suggest: { always?: boolean; sensitivity?: string; words?: string; why: string }; controls: Control[] }
interface Evidence { what: string; from: string[]; auto: boolean; every: string }
export const FRAMEWORKS = frameworksData as unknown as { name: string; what: string; evidence: Record<string, Evidence>; frameworks: Framework[] };

export type Coverage = 'factory' | 'configured' | 'shared' | 'platform' | 'organization';
export const COVERAGE_WHAT: Record<Coverage, string> = {
  factory: 'Proved by the factory on every release, with no one to remember',
  configured: 'Written by the factory as configuration and a runbook; a person applies it once and confirms',
  shared: 'The factory proves the technical part; the organization supplies the rest',
  platform: 'Inherited from the cloud provider’s own attestations',
  organization: 'Supplied by the organization: policies, training, people, vendors',
};

const SAY: Record<string, RegExp> = {
  soc2: /\bsoc ?(2|ii)\b/i,
  hipaa: /\bhipaa\b/i,
  ferpa: /\bferpa\b/i,
  pci: /\bpci(?:[ -]dss)?\b/i,
  glba: /\b(glba|gramm[- ]leach|safeguards rule)\b/i,
  'nist-800-171': /\b(800-171|cmmc)\b/i,
  'nist-800-53': /\b(800-53|fedramp)\b/i,
  'section-508': /\b(section 508|wcag)\b/i,
};

export interface Scope {
  readonly inScope: readonly { id: string; why: string }[];
  readonly suggested: readonly { id: string; why: string }[];
}

/** Which frameworks apply: named in the words, chosen on the spec sheet, or suggested by the information it keeps. */
export function scopeOf(p: Prepared, s: Schema): Scope {
  const text = [p.model.title, p.model.end ?? '', ...p.statements.flatMap((x) => [x.text, x.words ?? '']), ...(p.model.information ?? []).map((l) => l.text), ...p.model.notes.map((n) => n.text), ...p.model.context].join('\n');
  const chosen = new Set(p.options.compliance);
  const inScope = FRAMEWORKS.frameworks
    .map((f) => (SAY[f.id]?.test(text) ? { id: f.id, why: 'Named in your words' } : chosen.has(f.id) ? { id: f.id, why: 'Chosen on the spec sheet' } : null))
    .filter((x): x is { id: string; why: string } => !!x);
  const classes = new Set(s.entities.flatMap((e) => e.fields.map((f) => f.sensitivity)));
  const suggested = FRAMEWORKS.frameworks
    .filter((f) => !inScope.some((x) => x.id === f.id))
    .filter((f) => f.suggest.always || (f.suggest.sensitivity && classes.has(f.suggest.sensitivity as never)) || (f.suggest.words && new RegExp(f.suggest.words, 'i').test(text)))
    .map((f) => ({ id: f.id, why: f.suggest.why }));
  return { inScope, suggested };
}

export function coverageOf(c: Control): Coverage {
  const by = c.by;
  const auto = by.filter((b) => FRAMEWORKS.evidence[b]?.auto);
  const org = by.includes('organization');
  const plat = by.includes('platform');
  if (by.every((b) => b === 'organization')) return 'organization';
  if (by.every((b) => b === 'platform')) return 'platform';
  if (org) return 'shared';
  if (auto.length === by.filter((b) => b !== 'platform').length) return 'factory';
  return plat && auto.length ? 'shared' : 'configured';
}

// ---------------------------------------------------------------- the sensitive-data inventory, the same in every app

export const CLASSES = ['contact', 'financial', 'private', 'health'] as const;
const CLASS_FRAMEWORKS: Record<string, readonly string[]> = { health: ['hipaa'], financial: ['glba', 'pci'], private: [], contact: [] };
const MASK: Record<string, string> = {
  contact: 'shown to those who need to reach the person; masked in reports and the query console',
  financial: 'shown to the person and those they allow; masked everywhere else; exported only with its scope',
  private: 'shown only to the person and those they name; never in reports or exports without its scope',
  health: 'shown only to the person and those they allow; never in groups under the small-cell threshold; never exported without its scope; never in production queries',
};

export interface InventoryItem {
  readonly field: string;
  readonly entity: string;
  readonly class: string;
  readonly frameworks: readonly string[];
  readonly retention: string;
  readonly readers: readonly string[];
  readonly flows: readonly string[];
  readonly masking: string;
  readonly from: string;
}

export function inventory(p: Prepared, s: Schema, sc: Scope): InventoryItem[] {
  const inScope = new Set(sc.inScope.map((x) => x.id));
  const roles = s.entities.find((e) => e.key === 'person' || e.pattern === 'person')?.fields.find((f) => f.key === 'role')?.states ?? [];
  const grants = s.entities.some((e) => e.pattern === 'grant');
  const apiOn = p.options.api.reach !== 'off';
  return s.entities.flatMap((e) =>
    e.fields
      .filter((f) => (CLASSES as readonly string[]).includes(f.sensitivity))
      .map((f) => ({
        field: `${e.key}.${f.key}`,
        entity: e.name,
        class: f.sensitivity,
        frameworks: [...new Set([...(CLASS_FRAMEWORKS[f.sensitivity] ?? []).filter((x) => inScope.has(x)), ...(inScope.has('ferpa') && /student/.test(roles.join(' ')) ? ['ferpa'] : []), ...(inScope.has('soc2') ? ['soc2'] : [])])],
        retention: e.retention,
        readers: ['the person it is about', ...(grants ? ['anyone holding an access grant for that person, within its scope'] : []), ...roles.filter((r) => r !== 'student').map((r) => `${r}, by role and row-level rule`)],
        flows: ['screens, through role and row-level rules', ...(apiOn ? [`the API, only with the ${e.key}:read scope and the data:${f.sensitivity} scope`] : []), `the query console, masked unless the caller holds unmask:${f.sensitivity}${f.sensitivity === 'health' ? ', and never in production' : ''}`, `exports, only with export:${f.sensitivity}`, 'events carry ids only, never this value'],
        masking: MASK[f.sensitivity] ?? '',
        from: f.from === 'your words' ? `your words, line ${f.line}` : f.from,
      })),
  );
}

/** Field names that mean a card number, which the factory refuses to keep: a hosted payment page keeps them out entirely. */
export function forbiddenFields(s: Schema): string[] {
  return s.entities.flatMap((e) => e.fields.filter((f) => /^(card_?number|pan|cvv|cvc|card_?code|security_?code)$/.test(f.key) || /card number|security code/.test(f.name)).map((f) => `${e.key}.${f.key}`));
}

/** One gate policy for the whole fleet: data the gateway decides on, and a Rego module that reads it. */
export function gatePolicy(p: Prepared, s: Schema, inv: readonly InventoryItem[]): { data: string; rego: string } {
  const data = {
    schema: 'zthr-gate-policy/1',
    app: p.model.title,
    schemaHash: s.hash,
    fields: Object.fromEntries(inv.map((i) => [i.field, i.class])),
    classes: Object.fromEntries(CLASSES.map((c) => [c, { read: `data:${c}`, export: `export:${c}`, unmask: `unmask:${c}`, production_query: c !== 'health' }])),
    owners: Object.fromEntries(s.entities.map((e) => [e.key, e.fields.find((f) => f.type === 'ref:Person' && /owner|for|to|about|person|student|subject/.test(f.key))?.key ?? (e.pattern === 'person' ? 'id' : null)])),
  };
  const rego = `# The fleet's data gate. Every app's gateway loads its own data.json beside this module and asks:
#   input: { "caller": { "person": id, "scopes": [...] }, "action": "read" | "export" | "query",
#            "environment": "production" | ..., "field": "entity.field", "subject": person id of the record }
# A field with no class is ordinary data and is governed by role and row-level rules alone.
package zthr.gate

import rego.v1

default allow := false

class := data.fields[input.field]

ordinary if not data.fields[input.field]

own if input.caller.person == input.subject

has(scope) if scope in input.caller.scopes

allow if {
\tinput.action == "read"
\tordinary
}

allow if {
\tinput.action == "read"
\town
}

allow if {
\tinput.action == "read"
\thas(data.classes[class].read)
}

allow if {
\tinput.action == "export"
\tordinary
}

allow if {
\tinput.action == "export"
\thas(data.classes[class].export)
}

allow if {
\tinput.action == "query"
\tordinary
}

allow if {
\tinput.action == "query"
\thas(data.classes[class].unmask)
\tquery_environment_allowed
}

query_environment_allowed if input.environment != "production"

query_environment_allowed if data.classes[class].production_query

# Why, in plain words, for the audit chain and the permission explainer.
reason := "ordinary data: role and row-level rules decide" if ordinary

else := "the person's own record" if {
\tinput.action == "read"
\town
}

else := concat("", ["allowed: holds the scope for ", class, " data"]) if allow

else := concat("", ["refused: ", class, " data is never queried in production"]) if {
	input.action == "query"
	has(data.classes[class].unmask)
	not query_environment_allowed
}

else := concat("", ["refused: ", class, " data needs ", needed]) if needed := scope_needed

else := "refused"

scope_needed := data.classes[class].read if input.action == "read"

scope_needed := data.classes[class].export if input.action == "export"

scope_needed := data.classes[class].unmask if input.action == "query"
`;
  return { data: `${JSON.stringify(data, null, 1)}\n`, rego };
}

// ---------------------------------------------------------------- OSCAL

/** A stable UUID (version 5 form) from a name, so the same release always gives the same OSCAL document. */
const uuid = (name: string) => {
  const h = sha256(name);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const controlId = (f: Framework, c: Control) => (f.id === 'nist-800-53' ? c.id.toLowerCase().replace(/\((\d+)\)/g, '.$1') : `${f.id}-${c.id.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '')}`);
const SOURCE: Record<string, string> = {
  'nist-800-53': 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline_profile.json',
  'nist-800-171': 'https://csrc.nist.gov/pubs/sp/800/171/r2/upd1/final',
  soc2: 'https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022',
  hipaa: 'https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C',
  ferpa: 'https://www.ecfr.gov/current/title-34/subtitle-A/part-99',
  pci: 'https://www.pcisecuritystandards.org/document_library/',
  glba: 'https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-314',
  'section-508': 'https://www.w3.org/TR/WCAG22/',
};

export function oscal(p: Prepared, f: Framework, revision: number): unknown {
  const app = p.model.title || 'This app';
  return {
    'component-definition': {
      uuid: uuid(`cd:${app}:${f.id}:${revision}`),
      metadata: {
        title: `${app}: ${f.name} control implementations`,
        'last-modified': '1970-01-01T00:00:00Z',
        version: `revision-${revision}`,
        'oscal-version': '1.2.3',
        remarks: 'Generated from the signed schematic. last-modified is fixed so the same release gives the same bytes; the release record carries when it was issued.',
      },
      components: [
        {
          uuid: uuid(`component:${app}`),
          type: 'software',
          title: app,
          description: p.model.end ?? 'An application built by the ZTHR factory from a signed intent.',
          'control-implementations': [
            {
              uuid: uuid(`ci:${app}:${f.id}`),
              source: SOURCE[f.id] ?? `urn:zthr:catalog:${f.id}`,
              description: `${f.name}, ${f.version}. Each requirement names how it is met and the evidence each release carries.`,
              'implemented-requirements': f.controls.map((c) => ({
                uuid: uuid(`ir:${app}:${f.id}:${c.id}`),
                'control-id': controlId(f, c),
                description: `${c.title}. ${c.by.map((b) => FRAMEWORKS.evidence[b]!.what).join('. ')}.`,
                props: [{ name: 'coverage', ns: 'https://zthr.ai/ns/oscal', value: coverageOf(c) }],
                ...(() => {
                  const links = c.by.flatMap((b) => FRAMEWORKS.evidence[b]!.from.filter((x) => /^[a-z]+\/|\.(json|md|yaml|sql)$/.test(x) && !x.includes(' ')).map((x) => ({ href: x, rel: 'reference' })));
                  return links.length ? { links } : {};
                })(),
              })),
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------- the files

export function complianceFiles(p: Prepared, s: Schema, revision: number): { files: Record<string, string>; problems: string[] } {
  const sc = scopeOf(p, s);
  const inv = inventory(p, s, sc);
  const gate = gatePolicy(p, s, inv);
  const fws = sc.inScope.map((x) => FRAMEWORKS.frameworks.find((f) => f.id === x.id)!);
  const problems = forbiddenFields(s).map((f) => `${f}: a card number is never stored; take payments on a hosted payment page so card data never reaches the app`);
  const cell = (t: string) => t.replace(/\|/g, '\\|');
  const evidenceIndex = Object.entries(FRAMEWORKS.evidence).map(([id, e]) => ({ id, ...e, serves: fws.flatMap((f) => f.controls.filter((c) => c.by.includes(id)).map((c) => `${f.name} ${c.id}`)) })).filter((e) => e.serves.length);
  const count = (f: Framework, cov: Coverage) => f.controls.filter((c) => coverageOf(c) === cov).length;
  const files: Record<string, string> = {
    'compliance/scope.json': `${JSON.stringify({ schema: 'zthr-compliance-scope/1', ...sc }, null, 1)}\n`,
    'compliance/data-inventory.json': `${JSON.stringify({ schema: 'zthr-data-inventory/1', app: p.model.title, revision, schemaHash: s.hash, classes: Object.fromEntries(CLASSES.map((c) => [c, inv.filter((i) => i.class === c).length])), items: inv }, null, 1)}\n`,
    'compliance/gate/data.json': gate.data,
    'compliance/gate/policy.rego': gate.rego,
    'compliance/evidence.json': `${JSON.stringify({ schema: 'zthr-evidence-index/1', evidence: evidenceIndex }, null, 1)}\n`,
    'compliance/README.md': `# Compliance

Decided on the schematic, proved on every release. ${fws.length ? `In scope: ${sc.inScope.map((x) => `**${FRAMEWORKS.frameworks.find((f) => f.id === x.id)!.name}** (${x.why.toLowerCase()})`).join(', ')}.` : 'No framework is in scope yet.'}${sc.suggested.length ? ` Suggested by what it keeps: ${sc.suggested.map((x) => `${FRAMEWORKS.frameworks.find((f) => f.id === x.id)!.name} (${x.why.toLowerCase()})`).join('; ')}.` : ''}

Evidence is collected once and serves every control that needs it, in every framework:

\`\`\`mermaid
flowchart LR
${evidenceIndex.map((e) => `  E_${e.id.replace(/-/g, '_')}["${e.id}"]`).join('\n')}
${fws.map((f) => `  F_${f.id.replace(/-/g, '_')}(["${f.name}"])`).join('\n')}
${evidenceIndex.flatMap((e) => fws.filter((f) => f.controls.some((c) => c.by.includes(e.id))).map((f) => `  E_${e.id.replace(/-/g, '_')} --> F_${f.id.replace(/-/g, '_')}`)).join('\n')}
\`\`\`

| Framework | Controls | Proved by the factory | Configured once | Shared | Platform | Organization |
| --- | --- | --- | --- | --- | --- | --- |
${fws.map((f) => `| ${f.name} | ${f.controls.length} | ${count(f, 'factory')} | ${count(f, 'configured')} | ${count(f, 'shared')} | ${count(f, 'platform')} | ${count(f, 'organization')} |`).join('\n') || '| None in scope | | | | | | |'}

## Sensitive data

${inv.length} sensitive field${inv.length === 1 ? '' : 's'}: ${CLASSES.map((c) => `${inv.filter((i) => i.class === c).length} ${c}`).join(', ')}. Each is listed in \`compliance/data-inventory.json\` with its class, the frameworks it falls under, who may read it and where it may flow, in the same form in every app, so the fleet can be read as one. A central gateway enforces \`compliance/gate/policy.rego\` with each app's \`data.json\`.

## What the organization supplies

${[...new Set(fws.flatMap((f) => f.controls.filter((c) => c.by.includes('organization')).map((c) => `- ${f.name} ${c.id}: ${c.title}`)))].join('\n') || '- Nothing for the frameworks in scope.'}
`,
  };
  for (const f of fws) {
    files[`compliance/${f.id}.md`] = `# ${f.name}

${f.version}. ${f.authority}. Control wording is paraphrased; the official text is the authority.

| Control | Requirement | Coverage | How it is met | Evidence |
| --- | --- | --- | --- | --- |
${f.controls.map((c) => `| ${c.id} | ${cell(c.title)} | ${coverageOf(c)} | ${cell(c.by.map((b) => FRAMEWORKS.evidence[b]!.what).join('. '))} | ${c.by.flatMap((b) => FRAMEWORKS.evidence[b]!.from).map((x) => `\`${cell(x)}\``).join(', ')} |`).join('\n')}

Coverage: ${(Object.keys(COVERAGE_WHAT) as Coverage[]).map((k) => `**${k}**, ${COVERAGE_WHAT[k].toLowerCase()}`).join('; ')}.
`;
    files[`compliance/oscal/${f.id}.component-definition.json`] = `${JSON.stringify(oscal(p, f, revision), null, 1)}\n`;
  }
  return { files, problems };
}
