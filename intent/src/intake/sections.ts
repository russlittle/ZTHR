/**
 * Sections any markdown form may carry beside its own structure: the end in mind, engineering notes, and
 * variants. Recognised by their headings, never inferred.
 */
import type { Labelled, Note, Variant } from '../model.ts';
import { heading, listItem, outsideFences, plain } from './text.ts';

const END = /^(the )?end in mind$|^purpose$|^goal$|^north star$|^to what end$|^(at the end of the year,? )?(it was )?a good hire( if)?$/i;

/**
 * Lines the person labels themselves are theirs, in the slot they named: no reading needed. The hiring
 * questions are Clayton M. Christensen's jobs-to-be-done questions (Christensen, Hall, Dillon and Duncan,
 * Competing Against Luck, HarperBusiness, 2016), asked of a product as if it were a person hired for the work.
 */
const LABELS: readonly { re: RegExp; slot: Labelled['slot'] | 'end' }[] = [
  { re: /^(?:the )?job (?:(?:i am|i'm|we are|we're) )?hiring (?:this|it) (?:to do|for)\s*[:\-–—]\s*/i, slot: 'problem' },
  { re: /^(?:the problem|what goes wrong(?: today)?)\s*[:\-–—]\s*/i, slot: 'problem' },
  { re: /^(?:(?:i|we) would know it is doing a good job when|doing a good job means|a good job looks like)\s*[:\-–—]\s*/i, slot: 'measures' },
  { re: /^at the end of the year,? (?:it was )?a good hire if\s*[:\-–—]\s*/i, slot: 'end' },
  { re: /^(?:it works when|done when|when it works)\s*[:\-–—]\s*/i, slot: 'outcome' },
  { re: /^(?:it is for|it's for|for whom)\s*[:\-–—]\s*/i, slot: 'people' },
  { re: /^why(?: it matters)?\s*[:\-–—]\s*/i, slot: 'why' },
];
const NOTES = /^(engineering |process |implementation |architecture )?notes$/i;
const VARIANTS = /^variants$/i;

export interface Sections {
  readonly end: string | null;
  readonly notes: Note[];
  readonly variants: Variant[];
  readonly labelled: Labelled[];
}

function note(text: string, origin: { path: string; line: number }): Note {
  const t = plain(text);
  const r = /\b(?:because|since|until|once|while|when|for now,?|so that|so)\s+(.+)$/i.exec(t) ?? /\s[—–-]\s(.+)$/.exec(t);
  return { text: t, reason: r ? plain(r[1] ?? '') : null, stance: /\b(ideal|ideally|eventually|target|long[- ]term)\b/i.test(t) ? 'ideal' : 'practical', origin };
}

function variant(text: string, origin: { path: string; line: number }, n: number): Variant {
  const t = plain(text);
  // Variants are lettered, as a tabulated drawing's are, so they are never mistaken for version numbers.
  const id = /^(?:variant\s+)?([A-Z])\s*[:.)]\s+/.exec(t);
  const body = id ? t.slice(id[0].length) : t;
  const eff = /\((?:applies to|for|effective for|used by)\s+([^)]+)\)\s*$/i.exec(body);
  return { id: id?.[1] ?? String.fromCharCode(64 + n), text: eff ? body.slice(0, eff.index).trim() : body, effectivity: eff ? plain(eff[1] ?? '') : null, origin };
}

/** Whether a line is one the person labelled, so it never needs a reading. */
export function isLabelled(line: string): boolean {
  const body = plain(listItem(line) ?? line);
  return LABELS.some((l) => l.re.test(body) && body.replace(l.re, '').trim() !== '');
}

export function sections(path: string, text: string): Sections {
  const lines = outsideFences(text.split('\n'));
  let where: 'end' | 'notes' | 'variants' | null = null;
  let level = 0;
  let end: string[] = [];
  const notes: Note[] = [];
  const variants: Variant[] = [];
  const labelled: Labelled[] = [];
  lines.forEach((line, i) => {
    const origin = { path, line: i + 1 };
    const h = heading(line);
    if (h) {
      if (END.test(h.text)) [where, level] = ['end', h.level];
      else if (NOTES.test(h.text)) [where, level] = ['notes', h.level];
      else if (VARIANTS.test(h.text)) [where, level] = ['variants', h.level];
      else if (h.level <= level) where = null;
      return;
    }
    const item = listItem(line);
    const body = plain(item ?? line);
    const label = where === null || where === 'end' ? LABELS.find((l) => l.re.test(body)) : undefined;
    if (label) {
      const text = body.replace(label.re, '').trim();
      if (text) {
        if (label.slot === 'end') end.push(text);
        else labelled.push({ slot: label.slot, text, origin });
      }
      return;
    }
    if (where === 'end' && plain(line)) end.push(plain(item ?? line));
    else if (where === 'notes' && item) notes.push(note(item, origin));
    else if (where === 'variants' && item) variants.push(variant(item, origin, variants.length + 1));
  });
  return { end: end.length ? end.join(' ') : null, notes, variants, labelled };
}
