/**
 * Intake: any supported file in, one canonical intent model out, without a model. The form is decided by the
 * file's own shape, never guessed by a model, and the same file always gives the same model.
 */
import type { Form, IntentModel, Parsed } from '../model.ts';
import { gherkin, kiro, markdown, openspec, speckit } from './parsers.ts';
import { htmlToMarkdown, isHtml } from './html.ts';
import { isLabelled, sections } from './sections.ts';
import { outsideFences } from './text.ts';

/** Which form a file is in, from its name and its structure. */
export function detectForm(path: string, text: string): Form {
  if (/\.feature$/i.test(path)) return 'gherkin';
  const body = outsideFences(text.split('\n')).join('\n');
  if (/^#{2,4}\s+Requirement:/m.test(body) && /^#{3,5}\s+Scenario:/m.test(body)) return 'openspec';
  if (/^#{2,4}\s+Requirement\s+\d+/m.test(body) && /\bSHALL\b/.test(body)) return 'kiro';
  if (/\*\*(FR|SC)-\d{3}\*\*/.test(body) || /^#{2,3}\s+User Scenarios/m.test(body) || /^#{3}\s+User Story\s+\d+/m.test(body)) return 'speckit';
  if (/^\s*Feature:/m.test(body) && /^\s*Scenario/m.test(body)) return 'gherkin';
  return 'markdown';
}

const PARSERS: Record<Form, (path: string, text: string) => Parsed> = { speckit, kiro, openspec, gherkin, markdown };

export { sha256 } from '../hash.ts';
import { sha256 } from '../hash.ts';

/** One file into the canonical model. */
export function intakeOne(path: string, raw: string): IntentModel {
  // A page is converted to markdown first; line numbers then refer to the converted text, recorded as such.
  const html = isHtml(path, raw);
  const text = html ? htmlToMarkdown(raw) : raw;
  const form = detectForm(html ? path.replace(/\.x?html?$/i, '.md') : path, text);
  const p = PARSERS[form](path, text);
  const x = form === 'gherkin' ? { end: null, notes: [], variants: [], labelled: [] } : sections(path, text);
  // Lines inside the end, notes and variants sections are theirs, not requirements or context.
  const claimed = new Set([...x.notes, ...x.variants, ...x.labelled].map((n) => n.origin.line));
  const inEnd = x.end ? (l: string) => x.end!.includes(l) : () => false;
  return { end: x.end, notes: x.notes, variants: x.variants, labelled: x.labelled, title: p.title, sources: [{ path, form, sha256: sha256(raw), ...(html ? { from: 'html' as const } : {}) }], requirements: p.requirements.filter((r) => !claimed.has(r.origin.line)), examples: p.examples, clarifications: p.clarifications, context: p.context.filter((c) => !inEnd(c) && !isLabelled(c)) };
}

/** Several files into one model, in the order given; identifiers are prefixed by file when more than one. */
export function intake(files: readonly { path: string; text: string }[]): IntentModel {
  const many = files.length > 1;
  const models = files.map((f, i) => {
    const m = intakeOne(f.path, f.text);
    if (!many) return m;
    const pre = (id: string) => `F${i + 1}:${id}`;
    return {
      ...m,
      requirements: m.requirements.map((r) => ({ ...r, id: pre(r.id) })),
      examples: m.examples.map((e) => ({ ...e, id: pre(e.id), of: e.of === null ? null : pre(e.of) })),
      clarifications: m.clarifications.map((c) => ({ ...c, id: pre(c.id) })),
    };
  });
  return {
    end: models.map((m) => m.end).find((e) => e !== null) ?? null,
    notes: models.flatMap((m) => m.notes),
    variants: models.flatMap((m) => m.variants),
    labelled: models.flatMap((m) => m.labelled),
    title: models[0]?.title ?? '',
    sources: models.flatMap((m) => m.sources),
    requirements: models.flatMap((m) => m.requirements),
    examples: models.flatMap((m) => m.examples),
    clarifications: models.flatMap((m) => m.clarifications),
    context: models.flatMap((m) => m.context),
  };
}
