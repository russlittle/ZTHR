/**
 * Parsers for every structured specification form. None calls a model: a structured form says what it means
 * by its shape, so reading it is a matter of rules. Each returns the same Parsed shape, so everything later in
 * the pipeline reads one model whatever the source was.
 */
import type { Clarification, Example, Parsed, Requirement } from '../model.ts';
import { clause, fences, heading, listItem, markers, outsideFences, plain, scenarioLine } from './text.ts';

/** Statement text without its clarification markers, which are questions of their own. */
const statement = (s: string): string => plain(s.replace(/\[NEEDS CLARIFICATION:[^\]]*\]/gi, ''));

const slug = (s: string): string =>
  plain(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'item';

/** Markers anywhere outside code, each a clarification with its own line. */
function clarificationsIn(path: string, lines: readonly string[]): Clarification[] {
  const out: Clarification[] = [];
  outsideFences(lines).forEach((line, i) => {
    for (const text of markers(line)) out.push({ id: `Q${out.length + 1}`, text, origin: { path, line: i + 1 } });
  });
  return out;
}

function firstHeading(lines: readonly string[], fallback: string): string {
  for (const l of outsideFences(lines)) {
    const h = heading(l);
    if (h && h.level === 1) return h.text.replace(/^Feature Specification:\s*/i, '');
  }
  return fallback;
}

/** Gherkin fenced inside any markdown form is read as Gherkin, with true line numbers. */
function fencedGherkin(path: string, lines: readonly string[]): Example[] {
  const out: Example[] = [];
  for (const f of fences(lines)) {
    if (f.lang !== 'gherkin' && f.lang !== 'feature') continue;
    const inner = gherkin(path, f.body, f.start - 1);
    out.push(...inner.examples);
  }
  return out;
}

// ---------------------------------------------------------------- Spec Kit

/** Spec Kit: user stories with numbered acceptance scenarios, and FR-numbered requirements. */
export function speckit(path: string, text: string): Parsed {
  const lines = text.split('\n');
  const body = outsideFences(lines);
  const requirements: Requirement[] = [];
  const examples: Example[] = [];
  const context: string[] = [];
  let story: { id: string; n: number } | null = null;
  let section = '';
  body.forEach((line, i) => {
    const origin = { path, line: i + 1 };
    const h = heading(line);
    if (h) {
      section = h.text.toLowerCase();
      const s = /^User Story\s+(\w+)/i.exec(h.text);
      story = s ? { id: `US${s[1]}`, n: 0 } : h.level <= 2 ? null : story;
      return;
    }
    const fr = /^\s*[-*]\s+\*\*((?:FR|NFR|SC)-\d+[a-z]?)\*\*:?\s*(.+)$/.exec(line);
    if (fr) {
      requirements.push({ id: fr[1] ?? '', text: statement(fr[2] ?? ''), origin });
      return;
    }
    const sc = scenarioLine(line);
    if (sc && story) {
      story.n += 1;
      examples.push({ id: `${story.id}.${story.n}`, of: story.id, ...sc, origin });
      return;
    }
    if (sc) {
      examples.push({ id: `EX${examples.length + 1}`, of: null, ...sc, origin });
      return;
    }
    const item = listItem(line);
    if (item && (section.includes('assumption') || section.includes('edge case'))) context.push(plain(item));
  });
  return { title: firstHeading(lines, path), requirements, examples: [...examples, ...fencedGherkin(path, lines)], clarifications: clarificationsIn(path, lines), context };
}

// ---------------------------------------------------------------- Kiro (EARS)

const EARS: { re: RegExp; parts: (m: RegExpExecArray) => { given: string; when: string; then: string } }[] = [
  // WHILE <state>, WHEN <trigger> THEN the system SHALL <response>
  { re: /^while\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(?:the\s+)?(?:\w+\s+)?shall\s+(.+)$/i, parts: (m) => ({ given: clause(m[1] ?? ''), when: clause(m[2] ?? ''), then: clause(m[3] ?? '') }) },
  // WHEN <trigger> THEN the system SHALL <response>
  { re: /^when\s+(.+?),?\s+then\s+(?:the\s+)?(?:\w+\s+)?shall\s+(.+)$/i, parts: (m) => ({ given: '', when: clause(m[1] ?? ''), then: clause(m[2] ?? '') }) },
  // IF <condition> THEN the system SHALL <response>
  { re: /^if\s+(.+?),?\s+then\s+(?:the\s+)?(?:\w+\s+)?shall\s+(.+)$/i, parts: (m) => ({ given: clause(m[1] ?? ''), when: '', then: clause(m[2] ?? '') }) },
  // WHILE <state>, the system SHALL <response>
  { re: /^while\s+(.+?),\s*(?:the\s+)?(?:\w+\s+)?shall\s+(.+)$/i, parts: (m) => ({ given: clause(m[1] ?? ''), when: '', then: clause(m[2] ?? '') }) },
  // WHERE <feature is included>, the system SHALL <response>
  { re: /^where\s+(.+?),\s*(?:the\s+)?(?:\w+\s+)?shall\s+(.+)$/i, parts: (m) => ({ given: clause(m[1] ?? ''), when: '', then: clause(m[2] ?? '') }) },
];

/** Kiro requirements: numbered requirements, each with EARS acceptance criteria. */
export function kiro(path: string, text: string): Parsed {
  const lines = text.split('\n');
  const requirements: Requirement[] = [];
  const examples: Example[] = [];
  const context: string[] = [];
  let req: { id: string; n: number } | null = null;
  outsideFences(lines).forEach((line, i) => {
    const origin = { path, line: i + 1 };
    const h = heading(line);
    if (h) {
      const r = /^Requirement\s+(\w+)(?::\s*(.*))?/i.exec(h.text);
      if (r) {
        req = { id: `R${r[1]}`, n: 0 };
        requirements.push({ id: req.id, text: plain(r[2] ?? h.text), origin });
      }
      return;
    }
    const story = /^\s*\*\*User Story:?\*\*:?\s*(.+)$/i.exec(line);
    if (story) {
      if (req) {
        const last = requirements[requirements.length - 1];
        if (last && last.id === req.id) requirements[requirements.length - 1] = { ...last, text: plain(story[1] ?? '') };
      } else context.push(plain(story[1] ?? ''));
      return;
    }
    const item = listItem(line);
    if (!item) return;
    const t = statement(item);
    for (const e of EARS) {
      const m = e.re.exec(t);
      if (m) {
        const owner = req as { id: string; n: number } | null;
        const id = owner ? `${owner.id}.${(owner.n += 1)}` : `AC${examples.length + 1}`;
        examples.push({ id, of: owner?.id ?? null, ...e.parts(m), origin });
        return;
      }
    }
    if (/\bshall\b/i.test(t)) {
      const owner = req as { id: string; n: number } | null;
      requirements.push({ id: owner ? `${owner.id}.${(owner.n += 1)}` : `U${requirements.length + 1}`, text: t, origin });
    }
  });
  return { title: firstHeading(lines, path), requirements, examples: [...examples, ...fencedGherkin(path, lines)], clarifications: clarificationsIn(path, lines), context };
}

// ---------------------------------------------------------------- OpenSpec

/** OpenSpec: "### Requirement: name" with "#### Scenario: name" and WHEN/THEN/AND bullets. */
export function openspec(path: string, text: string): Parsed {
  const lines = text.split('\n');
  const requirements: Requirement[] = [];
  const examples: Example[] = [];
  let req: string | null = null;
  let awaiting = false;
  let sc: { id: string; given: string[]; when: string[]; then: string[]; last: 'given' | 'when' | 'then'; origin: { path: string; line: number } } | null = null;
  const close = () => {
    if (sc) examples.push({ id: sc.id, of: req, given: sc.given.join('; '), when: sc.when.join('; '), then: sc.then.join('; '), origin: sc.origin });
    sc = null;
  };
  outsideFences(lines).forEach((line, i) => {
    const origin = { path, line: i + 1 };
    const h = heading(line);
    if (h) {
      const r = /^Requirement:\s*(.+)$/i.exec(h.text);
      const s = /^Scenario:\s*(.+)$/i.exec(h.text);
      if (r) {
        close();
        req = slug(r[1] ?? '');
        requirements.push({ id: req, text: plain(r[1] ?? ''), origin });
        awaiting = true;
      } else if (s) {
        close();
        sc = { id: `${req ?? 'scenario'}/${slug(s[1] ?? '')}`, given: [], when: [], then: [], last: 'given', origin };
      } else if (h.level <= 2) close();
      return;
    }
    const item = listItem(line);
    if (sc && item) {
      const m = /^(GIVEN|WHEN|THEN|AND|BUT)\s+(.+)$/i.exec(plain(item));
      if (m) {
        const k = (m[1] ?? '').toLowerCase();
        const slot = k === 'and' || k === 'but' ? sc.last : (k as 'given' | 'when' | 'then');
        sc[slot].push(clause(m[2] ?? ''));
        sc.last = slot;
      }
      return;
    }
    // The first SHALL or MUST sentence under a requirement heading is its statement.
    const last = requirements[requirements.length - 1];
    if (!sc && awaiting && last && /\b(shall|must)\b/i.test(line)) {
      requirements[requirements.length - 1] = { ...last, text: plain(line) };
      awaiting = false;
    }
  });
  close();
  return { title: firstHeading(lines, path), requirements, examples: [...examples, ...fencedGherkin(path, lines)], clarifications: clarificationsIn(path, lines), context: [] };
}

// ---------------------------------------------------------------- Gherkin

/** Gherkin: each Scenario is an example, and each Scenario Outline row is its own example. */
export function gherkin(path: string, text: string | readonly string[], lineOffset = 0): Parsed {
  const lines = typeof text === 'string' ? text.split('\n') : [...text];
  const examples: Example[] = [];
  const requirements: Requirement[] = [];
  let title = path;
  let rule: string | null = null;
  type Sc = { name: string; outline: boolean; steps: { kind: 'given' | 'when' | 'then'; text: string }[]; origin: { path: string; line: number }; header: string[] | null; rows: { cells: string[]; line: number }[] };
  let sc: Sc | null = null;
  let background: { kind: 'given' | 'when' | 'then'; text: string }[] = [];
  let inBackground = false;
  let last: 'given' | 'when' | 'then' = 'given';
  const fill = (s: string, header: string[], cells: string[]) => header.reduce((acc, h, i) => acc.replaceAll(`<${h}>`, cells[i] ?? ''), s);
  const emit = (s: Sc, steps: { kind: 'given' | 'when' | 'then'; text: string }[], id: string, origin: { path: string; line: number }) => {
    const pick = (k: 'given' | 'when' | 'then') => steps.filter((x) => x.kind === k).map((x) => clause(x.text)).join('; ');
    examples.push({ id, of: rule, given: pick('given'), when: pick('when'), then: pick('then'), origin });
  };
  const close = () => {
    if (!sc) return;
    const steps = [...background, ...sc.steps];
    if (sc.outline && sc.header) {
      for (const [n, row] of sc.rows.entries()) {
        const filled = steps.map((x) => ({ kind: x.kind, text: fill(x.text, sc!.header!, row.cells) }));
        emit(sc, filled, `${slug(sc.name)}#${n + 1}`, { path, line: row.line });
      }
    } else emit(sc, steps, slug(sc.name), sc.origin);
    sc = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const origin = { path, line: lineOffset + i + 1 };
    let m: RegExpExecArray | null;
    if ((m = /^Feature:\s*(.+)$/i.exec(line))) title = plain(m[1] ?? '');
    else if ((m = /^Rule:\s*(.+)$/i.exec(line))) {
      close();
      rule = slug(m[1] ?? '');
      requirements.push({ id: rule, text: plain(m[1] ?? ''), origin });
    } else if (/^Background:/i.test(line)) {
      close();
      inBackground = true;
      background = [];
    } else if ((m = /^Scenario(?: Outline| Template)?:\s*(.+)$/i.exec(line)) || (m = /^Example:\s*(.+)$/i.exec(line))) {
      close();
      inBackground = false;
      sc = { name: m[1] ?? '', outline: /^Scenario (Outline|Template)/i.test(line), steps: [], origin, header: null, rows: [] };
    } else if ((m = /^(Given|When|Then|And|But|\*)\s+(.+)$/.exec(line))) {
      const k = (m[1] ?? '').toLowerCase();
      const kind = k === 'and' || k === 'but' || k === '*' ? last : (k as 'given' | 'when' | 'then');
      last = kind;
      if (inBackground) background.push({ kind, text: m[2] ?? '' });
      else if (sc) sc.steps.push({ kind, text: m[2] ?? '' });
    } else if (/^Examples:/i.test(line)) {
      /* the table follows */
    } else if (line.startsWith('|') && sc?.outline) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!sc.header) sc.header = cells;
      else sc.rows.push({ cells, line: lineOffset + i + 1 });
    }
  });
  close();
  return { title, requirements, examples, clarifications: [], context: [] };
}

// ---------------------------------------------------------------- Plain markdown

/** Plain markdown: every list item is a requirement unless it is a scenario line; nothing is inferred. */
export function markdown(path: string, text: string): Parsed {
  const lines = text.split('\n');
  const requirements: Requirement[] = [];
  const examples: Example[] = [];
  const context: string[] = [];
  outsideFences(lines).forEach((line, i) => {
    const origin = { path, line: i + 1 };
    const sc = scenarioLine(line);
    if (sc) {
      examples.push({ id: `EX${examples.length + 1}`, of: null, ...sc, origin });
      return;
    }
    const item = listItem(line);
    if (item) {
      const t = statement(item);
      if (t) requirements.push({ id: `M${requirements.length + 1}`, text: t, origin });
      return;
    }
    const t = plain(line);
    if (t && !heading(line)) context.push(t);
  });
  return { title: firstHeading(lines, path), requirements, examples: [...examples, ...fencedGherkin(path, lines)], clarifications: clarificationsIn(path, lines), context };
}
