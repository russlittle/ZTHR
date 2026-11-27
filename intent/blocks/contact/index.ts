/**
 * Names, addresses and phone numbers without the usual false assumptions. A name is kept as the person wrote it,
 * with an optional name to address them by and a sort key, never split into first and last by guesswork. An
 * address is formatted the way its country writes it (line order, where the postcode goes, upper-casing) and its
 * postcode checked by that country's pattern. A phone number is normalised to E.164 from what people type, with
 * the country's calling code and national trunk prefix handled.
 */

export interface Name {
  /** Exactly as the person wrote it. */
  readonly full: string;
  /** What to call them ("Ana", "Dr Okafor"); defaults to the full name. */
  readonly callMe?: string;
  /** How it sorts in lists; defaults to the full name. */
  readonly sortAs?: string;
}

/** C0 and C1 controls, DEL, and the bidirectional overrides and isolates that can disguise text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/;

const clean = (s: string, what: string): string => {
  const f = s.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (f.length > 300) throw new Error(`${what} can be at most 300 characters`);
  if (CONTROL.test(f)) throw new Error(`${what} cannot contain control characters or angle brackets`);
  return f;
};

export function name(full: string, o: { callMe?: string; sortAs?: string } = {}): Name {
  const f = clean(full, 'a name');
  if (!f) throw new Error('a name cannot be empty');
  const callMe = o.callMe === undefined ? '' : clean(o.callMe, 'the name to use');
  const sortAs = o.sortAs === undefined ? '' : clean(o.sortAs, 'the sort key');
  return { full: f, ...(callMe ? { callMe } : {}), ...(sortAs ? { sortAs } : {}) };
}

export const greeting = (n: Name) => n.callMe ?? n.full;

export const sortNames = (list: readonly Name[], locale = 'en') => [...list].sort((a, b) => new Intl.Collator(locale, { sensitivity: 'base' }).compare(a.sortAs ?? a.full, b.sortAs ?? b.full));

export interface Address {
  readonly country: string;
  readonly lines: readonly string[];
  readonly city?: string;
  readonly region?: string;
  readonly postcode?: string;
}

interface Format {
  readonly postcode?: RegExp;
  /** Template lines; {lines} expands to the street lines. */
  readonly layout: readonly string[];
  readonly upper?: readonly ('city' | 'region' | 'postcode')[];
  readonly name: string;
}

export const FORMATS: Readonly<Record<string, Format>> = {
  US: { name: 'United States', postcode: /^\d{5}(-\d{4})?$/, layout: ['{lines}', '{city}, {region} {postcode}'], upper: ['region'] },
  CA: { name: 'Canada', postcode: /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i, layout: ['{lines}', '{city} {region} {postcode}'], upper: ['city', 'region', 'postcode'] },
  GB: { name: 'United Kingdom', postcode: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i, layout: ['{lines}', '{city}', '{postcode}'], upper: ['city', 'postcode'] },
  DE: { name: 'Germany', postcode: /^\d{5}$/, layout: ['{lines}', '{postcode} {city}'] },
  FR: { name: 'France', postcode: /^\d{5}$/, layout: ['{lines}', '{postcode} {city}'], upper: ['city'] },
  JP: { name: 'Japan', postcode: /^\d{3}-?\d{4}$/, layout: ['〒{postcode}', '{region}{city}', '{lines}'] },
  IN: { name: 'India', postcode: /^\d{6}$/, layout: ['{lines}', '{city} {postcode}', '{region}'] },
  AU: { name: 'Australia', postcode: /^\d{4}$/, layout: ['{lines}', '{city} {region} {postcode}'], upper: ['city', 'region'] },
  BR: { name: 'Brazil', postcode: /^\d{5}-?\d{3}$/, layout: ['{lines}', '{city} - {region}', '{postcode}'] },
  IE: { name: 'Ireland', postcode: /^[A-Z]\d[\dW] ?[A-Z\d]{4}$/i, layout: ['{lines}', '{city}', '{region}', '{postcode}'], upper: ['postcode'] },
};

const own = <T>(table: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(table, k) ? table[k] : undefined);

export function checkAddress(a: Address): string[] {
  const f = own(FORMATS, a.country);
  const out: string[] = [];
  if (!a.lines.some((l) => l.trim())) out.push('add a street address');
  if (f?.postcode && a.postcode && !f.postcode.test(a.postcode.trim())) out.push(`${a.postcode} is not a ${f.name} postcode`);
  if (f?.postcode && !a.postcode) out.push(`${f.name} addresses need a postcode`);
  return out;
}

/** The address as lines for an envelope, in its country's order; adds the country when sending from elsewhere. */
export function formatAddress(a: Address, from?: string): string[] {
  const f = own(FORMATS, a.country) ?? { name: a.country, layout: ['{lines}', '{city} {region} {postcode}'] };
  const v = (k: 'city' | 'region' | 'postcode') => {
    const s = (a[k] ?? '').trim();
    return f.upper?.includes(k) ? s.toUpperCase() : s;
  };
  const out = f.layout.flatMap((line) => (line === '{lines}' ? a.lines.map((l) => l.trim()).filter(Boolean) : [line.replace(/\{(city|region|postcode)\}/g, (_, k: 'city' | 'region' | 'postcode') => v(k)).replace(/\s+/g, ' ').replace(/^[\s,-]+|[\s,-]+$/g, '').replace(/^〒$/, '')]));
  if (from && from !== a.country) out.push(f.name.toUpperCase());
  return out.filter(Boolean);
}

/** Calling code, national trunk prefix and the length range of national numbers. */
export const PHONE: Readonly<Record<string, { cc: string; trunk?: string; len: readonly [number, number] }>> = {
  US: { cc: '1', trunk: '1', len: [10, 10] },
  CA: { cc: '1', trunk: '1', len: [10, 10] },
  GB: { cc: '44', trunk: '0', len: [9, 10] },
  DE: { cc: '49', trunk: '0', len: [6, 13] },
  FR: { cc: '33', trunk: '0', len: [9, 9] },
  JP: { cc: '81', trunk: '0', len: [9, 10] },
  IN: { cc: '91', trunk: '0', len: [10, 10] },
  AU: { cc: '61', trunk: '0', len: [9, 9] },
  BR: { cc: '55', trunk: '0', len: [10, 11] },
  IE: { cc: '353', trunk: '0', len: [7, 9] },
};

/** E.164 from what was typed, assuming `country` when there is no + or 00 prefix. */
export function phone(typed: string, country: string): string {
  const t = typed.trim();
  const main = t.replace(/\s*(ext|x)\.?\s*\d+$/i, '');
  if (/[a-z]/i.test(main)) throw new Error('a phone number cannot contain letters');
  let digits = main.replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('+')) {
    // "+44 (0)20 ..." shows the national trunk prefix in brackets; it is not dialled after the country code.
    const d = main.replace(/^\s*(\+|00)/, '').replace(/\(\s*0\s*\)/, '').replace(/\D/g, '');
    if (d.length < 8 || d.length > 15 || d.startsWith('0')) throw new Error('that is not a complete international number');
    return `+${d}`;
  }
  const p = own(PHONE, country);
  if (!p) throw new Error(`write the number with its country code (+...) for ${country}`);
  let n = digits.replace(/\D/g, '');
  if (p.trunk && n.startsWith(p.trunk) && n.length > p.len[1]) n = n.slice(p.trunk.length);
  else if (p.trunk && n.startsWith(p.trunk) && n.length - p.trunk.length >= p.len[0]) n = n.slice(p.trunk.length);
  if (n.length < p.len[0] || n.length > p.len[1]) throw new Error(`a ${country} number has ${p.len[0] === p.len[1] ? p.len[0] : `${p.len[0]} to ${p.len[1]}`} digits after the area code prefix`);
  return `+${p.cc}${n}`;
}
