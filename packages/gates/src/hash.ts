import { createHash } from 'node:crypto';

/** Stable JSON: object keys sorted, so equal content always hashes equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  // Keys are unique, so the default sort (by UTF-16 code units) orders them with no ties to break.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');
export const contentHash = (value: unknown): string => sha256(stableStringify(value));
