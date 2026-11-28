/**
 * The masks of the first-article inspection: what is allowed to differ between a real Nextcloud and Files (and
 * between two recordings of the same Nextcloud) because it rightly varies, never because it is convenient.
 *
 * Two layers:
 *  - the oracle block's NEXTCLOUD_RULES, plus the keys below, compare values by shape (digits, date, text, empty);
 *  - text masks, applied to a response body before it is parsed, for varying values inside otherwise fixed text:
 *    the server's own address, and the deletion time Nextcloud puts in a trash item's name.
 *
 * Each mask is listed with why it is there; the README in this folder repeats the list for readers.
 */
import { NEXTCLOUD_RULES, type Rules } from '../../intent/blocks/oracle/index.ts';

export const EXTRA_JSON_MASKS: readonly { key: string; why: string }[] = [
  { key: 'lastLogin', why: 'the time of the last sign-in (milliseconds), different on every run' },
  { key: 'firstLoginTimestamp', why: 'the time of the first sign-in' },
  { key: 'lastLoginTimestamp', why: 'the time of the last sign-in' },
  { key: 'free', why: 'free space in bytes: the runner\'s disk, not the protocol' },
  { key: 'total', why: 'free plus used: follows the runner\'s disk' },
  { key: 'relative', why: 'used over total: follows the runner\'s disk' },
  { key: 'storageLocation', why: 'a path on the server\'s own disk' },
  { key: 'name', why: 'theming: the product\'s own name (Nextcloud, Files), a server identity' },
  { key: 'productName', why: 'theming: the product\'s own name, a server identity' },
  { key: 'slogan', why: 'theming: the product\'s own tagline, a server identity' },
  { key: 'color', why: 'theming: the product\'s brand colour, a server identity' },
  { key: 'color-element', why: 'theming: the brand colour as used on elements, a server identity' },
  { key: 'color-element-bright', why: 'theming: the brand colour on a bright background, a server identity' },
  { key: 'color-element-dark', why: 'theming: the brand colour on a dark background, a server identity' },
];

export const EXTRA_PROP_MASKS: readonly { prop: string; why: string }[] = [
  { prop: '{http://nextcloud.org/ns}trashbin-deletion-time', why: 'when the item was deleted' },
];

export const EXTRA_HEADER_MASKS: readonly { header: string; why: string }[] = [];

export const FIRST_ARTICLE_RULES: Rules = {
  maskProps: [...NEXTCLOUD_RULES.maskProps, ...EXTRA_PROP_MASKS.map((m) => m.prop)],
  maskJson: [...NEXTCLOUD_RULES.maskJson, ...EXTRA_JSON_MASKS.map((m) => m.key)],
  maskHeaders: [...NEXTCLOUD_RULES.maskHeaders, ...EXTRA_HEADER_MASKS.map((m) => m.header)],
  headers: NEXTCLOUD_RULES.headers,
};

export const TEXT_MASKS: readonly { name: string; why: string }[] = [
  { name: '{base}', why: 'the server\'s own address (scheme, host and port) wherever it appears in a body: the reference and Files listen on different ports' },
  { name: '.d{time}', why: 'Nextcloud names a trash item name.d<unix seconds of deletion>; the seconds differ on every run' },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text masks applied to one body, for a server at `base`. */
export function maskText(text: string, base: string): string {
  const u = new URL(base);
  const hosts = new Set([u.host, u.hostname === '127.0.0.1' ? `localhost${u.port ? `:${u.port}` : ''}` : u.hostname === 'localhost' ? `127.0.0.1${u.port ? `:${u.port}` : ''}` : u.host]);
  let out = text;
  for (const h of hosts) {
    // Plain and JSON-escaped forms ("http:\/\/host").
    out = out.replace(new RegExp(`https?:(?:\\\\?/){2}${escape(h)}`, 'g'), '{base}');
  }
  // Trash items: "/trash/c.txt.d1732712345" in hrefs and "c.txt.d1732712345" in names.
  out = out.replace(/(\.d)\d{9,11}(?=[<"/\s?#]|$)/g, '$1{time}');
  return out;
}

/** A fetch that applies the text masks to every body before the oracle reads it. */
export function maskedFetch(base: string, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const text = await res.text();
    const masked = maskText(text, base);
    const noBody = res.status === 204 || res.status === 304 || (res.status >= 100 && res.status < 200);
    return new Response(noBody || masked === '' ? null : masked, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}
