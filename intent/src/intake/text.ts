/** Small text helpers shared by every parser. None of them calls a model. */

/** Markdown emphasis and code marks removed, whitespace collapsed. */
export function plain(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A clause with its trailing comma or full stop removed, so "x," and "x" compare equal. */
export function clause(s: string): string {
  return plain(s).replace(/[\s,;.]+$/, '');
}

const GWT = /^(?:\d+[.)]\s*|[-*+]\s+)?given\s+(.+?)\s*,?\s+when\s+(.+?)\s*,?\s+then\s+(.+)$/i;
const WT = /^(?:\d+[.)]\s*|[-*+]\s+)?when\s+(.+?)\s*,?\s+then\s+(.+)$/i;

/** A one-line acceptance scenario, in any of the common spellings, or null. */
export function scenarioLine(line: string): { given: string; when: string; then: string } | null {
  const text = plain(line);
  const full = GWT.exec(text);
  if (full) return { given: clause(full[1] ?? ''), when: clause(full[2] ?? ''), then: clause(full[3] ?? '') };
  const short = WT.exec(text);
  if (short) return { given: '', when: clause(short[1] ?? ''), then: clause(short[2] ?? '') };
  return null;
}

const MARKER = /\[NEEDS CLARIFICATION:\s*([^\]]+)\]/gi;

/** Every clarification marker on a line, in order. */
export function markers(line: string): string[] {
  return [...line.matchAll(MARKER)].map((m) => plain(m[1] ?? ''));
}

/** A bullet or numbered list item's text, or null when the line is not a list item. */
export function listItem(line: string): string | null {
  const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line);
  return m ? (m[1] ?? null) : null;
}

/** A markdown heading's level and text, or null. */
export function heading(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  return m ? { level: (m[1] ?? '').length, text: plain(m[2] ?? '') } : null;
}

/** Fenced code blocks with their language tag and the line their body starts on (1-based). */
export function fences(lines: readonly string[]): { lang: string; start: number; body: string[] }[] {
  const out: { lang: string; start: number; body: string[] }[] = [];
  let open: { lang: string; start: number; body: string[] } | null = null;
  lines.forEach((line, i) => {
    const m = /^\s*(```|~~~)\s*([\w-]*)/.exec(line);
    if (m) {
      if (open) {
        out.push(open);
        open = null;
      } else open = { lang: (m[2] ?? '').toLowerCase(), start: i + 2, body: [] };
      return;
    }
    if (open) open.body.push(line);
  });
  return out;
}

/** The lines outside fenced code blocks, with fenced lines blanked so line numbers stay true. */
export function outsideFences(lines: readonly string[]): string[] {
  let inside = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inside = !inside;
      return '';
    }
    return inside ? '' : line;
  });
}
