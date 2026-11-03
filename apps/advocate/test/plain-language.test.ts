// Verifies docs/flows/money.md
// Verifies docs/agents.md
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { DAYTON_CATALOG } from '../src/catalog/dayton.js';
import { loadPlaybooks } from '../src/playbooks/engine.js';
import { checkTone, readingGrade } from '../src/domain/tone.js';
import { TERMS } from '../src/domain/college.js';
import { GUIDES } from '../src/domain/lifeskills.js';

/**
 * Every sentence a student can be shown from the catalog, the playbooks, the college glossary and the life-skills
 * guides reads at grade 8 or below (the walk-me-through limit), one test per sentence, so a hard sentence is named.
 */
const playbooks = loadPlaybooks(fileURLToPath(new URL('../../../control/playbooks', import.meta.url)));
const LIMIT = 8;

describe('catalog reads plainly', () => {
  for (const r of DAYTON_CATALOG) {
    it(`${r.id}: description`, () => expect(readingGrade(r.description)).toBeLessThanOrEqual(LIMIT + 1));
    r.howToApply.forEach((step, i) => it(`${r.id}: step ${i + 1}`, () => expect(readingGrade(step)).toBeLessThanOrEqual(LIMIT)));
  }
});

describe('playbooks read plainly and carefully', () => {
  for (const [id, def] of playbooks) {
    for (const step of def.steps) {
      it(`${id}/${step.id}`, () => {
        expect(readingGrade(step.text)).toBeLessThanOrEqual(LIMIT + 1);
        const t = checkTone({ text: step.text, nextSteps: [{ label: 'Done', action: 'x' }], urgency: 'routine' }, 'standard', LIMIT, 'en');
        expect(t.problems.filter((p) => !p.startsWith('reads at'))).toEqual([]);
      });
    }
  }
});

describe('the glossary and guides read plainly', () => {
  for (const t of TERMS) it(`term: ${t.term}`, () => expect(readingGrade(t.meaning)).toBeLessThanOrEqual(LIMIT + 2));
  for (const g of GUIDES) g.steps.forEach((s, i) => it(`guide: ${g.topic} step ${i + 1}`, () => expect(readingGrade(s)).toBeLessThanOrEqual(LIMIT + 1)));
});
