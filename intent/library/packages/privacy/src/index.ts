import { createHash } from 'node:crypto';

/**
 * The privacy block: traces where a person's data actually goes, and keeps counts from pointing at anyone.
 *
 *  - Canaries: plant a unique, harmless marker in each personal, sensitive and secret field, use the app the way a
 *    person would, then search every place data can land (the store, exports, logs, outgoing requests, screens).
 *    Where a marker turns up is where that field went. The policy says where each class may go; anything else
 *    is a leak, named by field and place.
 *  - Small cells: a count over fewer than a minimum number of people is suppressed, never shown.
 */

export type Sensitivity = 'public' | 'internal' | 'personal' | 'sensitive' | 'secret';

export interface Canary {
  /** "collection.field" or a named fact. */
  field: string;
  cls: Sensitivity;
  /** The marker that is planted; unique enough never to occur by chance. */
  value: string;
  /** Extra places this one field is declared to go, beyond its class (for example, a first name sent with consent). */
  also?: string[];
}

/** A marker for a field: letters only by default, so it survives being put in a name or a sentence. */
export function canary(field: string, cls: Sensitivity, shape: 'word' | 'digits' = 'word', also?: string[]): Canary {
  const h = createHash('sha256').update(`canary|${field}`).digest('hex');
  const value =
    shape === 'digits'
      ? String(parseInt(h.slice(0, 10), 16)).padStart(10, '7').slice(0, 10)
      : `Qz${h
          .slice(0, 8)
          .replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!)}`;
  return { field, cls, value, ...(also ? { also } : {}) };
}

/** Where each class may be found. A sink not listed for a class is a leak for every field of that class. */
export type FlowPolicy = Record<Sensitivity, string[]>;

export interface Finding {
  field: string;
  cls: Sensitivity;
  sink: string;
  allowed: boolean;
}

/** Searches every sink for every canary. Case-insensitive, and also finds the marker URL- or JSON-escaped. */
export function trace(canaries: Canary[], sinks: Record<string, string>, policy: FlowPolicy): Finding[] {
  const out: Finding[] = [];
  for (const c of canaries) {
    const needle = c.value.toLowerCase();
    for (const [sink, text] of Object.entries(sinks)) {
      const hay = text.toLowerCase();
      if (hay.includes(needle) || hay.includes(encodeURIComponent(needle))) out.push({ field: c.field, cls: c.cls, sink, allowed: policy[c.cls].includes(sink) || (c.also ?? []).includes(sink) });
    }
  }
  return out;
}

export const leaks = (fs: Finding[]): Finding[] => fs.filter((f) => !f.allowed);

/** Fields that were planted but never seen anywhere: the trace did not exercise them, so they are unmeasured. */
export function unexercised(canaries: Canary[], fs: Finding[]): string[] {
  const seen = new Set(fs.map((f) => f.field));
  return canaries.filter((c) => !seen.has(c.field)).map((c) => c.field);
}

/** A field-by-sink matrix for drawing: for each field, each sink is "allowed", "leak" or absent. */
export function matrix(canaries: Canary[], fs: Finding[], sinks: string[]): { field: string; cls: Sensitivity; cells: Record<string, 'allowed' | 'leak' | ''> }[] {
  return canaries.map((c) => ({
    field: c.field,
    cls: c.cls,
    cells: Object.fromEntries(sinks.map((s) => {
      const f = fs.find((x) => x.field === c.field && x.sink === s);
      return [s, f ? (f.allowed ? 'allowed' : 'leak') : ''];
    })) as Record<string, 'allowed' | 'leak' | ''>,
  }));
}

// ------------------------------------------------------------------ small cells

export const MIN_CELL = 5;

/** A group is too small to show when it has fewer than the minimum number of people. */
export const tooSmall = (n: number, min = MIN_CELL): boolean => n < min;

/** A rate to one decimal place, as a percentage, or suppressed when the group is too small. */
export function safeRate(numerator: number, denominator: number, min = MIN_CELL): number | 'suppressed' {
  if (tooSmall(denominator, min)) return 'suppressed';
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** A count, or suppressed when it is about too few people. */
export function safeCount(n: number, population: number, min = MIN_CELL): number | 'suppressed' {
  return tooSmall(population, min) ? 'suppressed' : n;
}
