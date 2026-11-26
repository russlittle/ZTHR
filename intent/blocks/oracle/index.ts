/**
 * The differential oracle: the system being replaced is the measuring stick. The same scripted requests go to the
 * reference and to the candidate; each answer is reduced to what a client can depend on (status, the headers that
 * matter, and the body with ordering normalised and the values that are rightly different everywhere, such as
 * etags, ids and dates, masked to their shape); and every difference is reported with where it is.
 *
 * The reference's answers can be recorded once into a corpus, so later runs check the candidate against the
 * recording with no reference running: a twin calibrated to the system as built, not as documented.
 */
import { parseXml, type El } from '../dav/index.ts';

export interface Step {
  readonly name: string;
  readonly method: string;
  /** Relative to the target's base; may use {user} and values captured earlier as {name}. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Values to keep from this answer for later steps: a JSON path ("ocs.data.token") or a header ("header:etag"). */
  readonly capture?: Readonly<Record<string, string>>;
}

export interface Target {
  readonly base: string;
  readonly user: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
}

export interface Rules {
  /** XML properties ("{ns}name") whose values differ rightly between servers: compared by shape, not value. */
  readonly maskProps: readonly string[];
  /** JSON keys whose values are compared by shape. */
  readonly maskJson: readonly string[];
  /** Headers compared by presence and shape only. */
  readonly maskHeaders: readonly string[];
  /** Headers compared by value. */
  readonly headers: readonly string[];
}

export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Difference {
  readonly step: string;
  readonly where: string;
  readonly reference: unknown;
  readonly candidate: unknown;
}

/** The shape of a value: present or empty, and whether digits, a date or text, so two tokens match and "" does not. */
export function shape(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'number';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v !== 'string') return typeof v;
  if (/^-?\d+$/.test(v)) return 'digits';
  if (/GMT$|^\d{4}-\d\d-\d\d/.test(v) && !Number.isNaN(Date.parse(v))) return 'date';
  return 'text';
}

const canonXml = (e: El, rules: Rules): unknown => {
  const k = `{${e.ns}}${e.name}`;
  if (rules.maskProps.includes(k)) return { [k]: `<${shape(e.text.trim())}>` };
  const kids = e.children.map((c) => canonXml(c, rules));
  // Multistatus responses and the properties in a prop come in any order: sort them so order never shows as a change.
  const sortable = (e.ns === 'DAV:' && (e.name === 'multistatus' || e.name === 'prop')) || e.name === 'share-types';
  const ordered = sortable ? [...kids].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : kids;
  return kids.length ? { [k]: ordered } : { [k]: e.text.trim() };
};

const canonJson = (v: unknown, rules: Rules, at = ''): unknown => {
  if (Array.isArray(v)) return v.map((x, i) => canonJson(x, rules, `${at}[${i}]`));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, rules.maskJson.includes(k) ? `<${shape((v as Record<string, unknown>)[k])}>` : canonJson((v as Record<string, unknown>)[k], rules, `${at}.${k}`)]),
    );
  return v;
};

/** An answer reduced to what a client depends on. */
export function normalise(status: number, headers: Headers | Readonly<Record<string, string>>, text: string, rules: Rules): Answer {
  const get = (h: string) => (headers instanceof Headers ? headers.get(h) : (headers as Record<string, string>)[h.toLowerCase()]) ?? undefined;
  const hs: Record<string, string> = {};
  for (const h of rules.headers) {
    const v = get(h);
    if (v !== undefined) hs[h] = h === 'content-type' ? v.split(';')[0]!.trim().toLowerCase() : v;
  }
  for (const h of rules.maskHeaders) {
    const v = get(h);
    if (v !== undefined) hs[h] = `<${shape(v)}>`;
  }
  const type = (get('content-type') ?? '').toLowerCase();
  let body: unknown = text;
  if (!text) body = '';
  else if (type.includes('xml') || text.trimStart().startsWith('<?xml')) {
    try {
      body = canonXml(parseXml(text), rules);
    } catch {
      body = { unparsed: text.length };
    }
  } else if (type.includes('json')) {
    try {
      body = canonJson(JSON.parse(text), rules);
    } catch {
      body = { unparsed: text.length };
    }
  } else if (type.startsWith('text/html')) body = { html: true };
  else body = { bytes: text.length };
  return { status, headers: hs, body };
}

/** Every place two normalised answers differ. */
export function differences(step: string, a: Answer, b: Answer): Difference[] {
  const out: Difference[] = [];
  const walk = (x: unknown, y: unknown, where: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) walk(x[i], y[i], `${where}[${i}]`);
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${where}/${k}`);
      return;
    }
    out.push({ step, where: where || '/', reference: x, candidate: y });
  };
  if (a.status !== b.status) out.push({ step, where: 'status', reference: a.status, candidate: b.status });
  walk(a.headers, b.headers, 'headers');
  walk(a.body, b.body, 'body');
  return out;
}

const pick = (v: unknown, path: string): string | undefined => {
  let cur: unknown = v;
  for (const p of path.split('.')) {
    if (cur && typeof cur === 'object') cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur === undefined || cur === null ? undefined : String(cur);
};

const fill = (s: string, vars: Readonly<Record<string, string>>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/** Runs a script against one target, returning each step's normalised answer. */
export async function play(steps: readonly Step[], t: Target, rules: Rules): Promise<Answer[]> {
  const f = t.fetch ?? fetch;
  const vars: Record<string, string> = { user: t.user };
  const out: Answer[] = [];
  const auth = `Basic ${Buffer.from(`${t.user}:${t.password}`).toString('base64')}`;
  for (const s of steps) {
    const headers: Record<string, string> = { authorization: auth, 'ocs-apirequest': 'true', ...Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k.toLowerCase(), fill(v.replace('{base}', t.base), vars)])) };
    const res = await f(`${t.base}${fill(s.path, vars)}`, { method: s.method, headers, ...(s.body !== undefined ? { body: fill(s.body, vars) } : {}), redirect: 'manual' });
    const text = await res.text();
    for (const [name, where] of Object.entries(s.capture ?? {})) {
      const v = where.startsWith('header:') ? (res.headers.get(where.slice(7)) ?? undefined) : (() => {
        try {
          return pick(JSON.parse(text), where);
        } catch {
          return undefined;
        }
      })();
      if (v !== undefined) vars[name] = v;
    }
    out.push(normalise(res.status, res.headers, text, rules));
  }
  return out;
}

export interface Corpus {
  readonly schema: 'zthr-oracle/1';
  readonly reference: string;
  readonly recorded: string;
  readonly steps: readonly Step[];
  readonly answers: readonly Answer[];
}

export async function record(steps: readonly Step[], reference: Target, rules: Rules, name: string, now = new Date()): Promise<Corpus> {
  return { schema: 'zthr-oracle/1', reference: name, recorded: now.toISOString(), steps, answers: await play(steps, reference, rules) };
}

/** The candidate against a recorded corpus, or against a live reference when one is given. */
export async function compare(steps: readonly Step[], candidate: Target, rules: Rules, reference: Target | Corpus): Promise<{ steps: number; differences: Difference[] }> {
  const ref = 'schema' in reference ? reference.answers : await play(steps, reference, rules);
  const got = await play(steps, candidate, rules);
  return { steps: steps.length, differences: steps.flatMap((s, i) => differences(s.name, ref[i]!, got[i]!)) };
}

/** The masks that fit Nextcloud's file and sharing protocols. */
export const NEXTCLOUD_RULES: Rules = {
  maskProps: ['{DAV:}getetag', '{DAV:}getlastmodified', '{DAV:}creationdate', '{http://owncloud.org/ns}fileid', '{http://owncloud.org/ns}id', '{http://nextcloud.org/ns}creation_time', '{http://nextcloud.org/ns}upload_time', '{http://owncloud.org/ns}checksums', '{DAV:}quota-available-bytes', '{http://nextcloud.org/ns}data-fingerprint', '{http://nextcloud.org/ns}lock-time', '{http://nextcloud.org/ns}lock-token'],
  maskJson: ['id', 'token', 'url', 'stime', 'expiration', 'file_source', 'item_source', 'file_parent', 'storage', 'storage_id', 'parent', 'mail_send', 'uid_file_owner', 'displayname_file_owner', 'uid_owner', 'displayname_owner', 'version', 'versionstring', 'edition', 'productname', 'extendedSupport', 'installed', 'maintenance', 'needsDbUpgrade'],
  maskHeaders: ['etag', 'oc-etag', 'oc-fileid', 'last-modified', 'x-request-id', 'date'],
  headers: ['content-type', 'dav'],
};
