/**
 * The pure parts of the sync journey: reading a WebDAV listing, recognising the desktop client's conflict copies,
 * and reading the request log of the recording proxy (to show a large file went up in chunks and a rename went up
 * as a MOVE, not as a fresh upload).
 */

export interface Entry {
  readonly href: string;
  readonly collection: boolean;
  readonly size: number | null;
}

/** The entries of a multistatus, whatever namespace prefixes the server chose. */
export function listing(xml: string): Entry[] {
  const out: Entry[] = [];
  for (const m of xml.matchAll(/<([A-Za-z0-9]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/\1?response>/g)) {
    const body = m[2]!;
    const href = /<(?:[A-Za-z0-9]+:)?href>([^<]*)<\/(?:[A-Za-z0-9]+:)?href>/.exec(body)?.[1] ?? '';
    const collection = /<(?:[A-Za-z0-9]+:)?collection\s*\/>/.test(body);
    const len = /<(?:[A-Za-z0-9]+:)?getcontentlength>(\d+)<\//.exec(body)?.[1];
    out.push({ href: decodeURIComponent(href.replace(/&amp;/g, '&')), collection, size: len === undefined ? null : Number(len) });
  }
  return out;
}

/** The children of a listing (everything but the listed folder itself), by name. */
export function children(xml: string, folderHref: string): Map<string, Entry> {
  const norm = (h: string) => h.replace(/\/+$/, '');
  const self = norm(decodeURIComponent(folderHref));
  const out = new Map<string, Entry>();
  for (const e of listing(xml)) {
    const h = norm(e.href.replace(/^https?:\/\/[^/]+/, ''));
    if (h === self) continue;
    out.set(h.slice(h.lastIndexOf('/') + 1), e);
  }
  return out;
}

/** The desktop client's name for the local side of a conflict: "name (conflicted copy <who> <when>).ext". */
export function isConflictCopy(name: string, original: string): boolean {
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : '';
  return name !== original && name.startsWith(`${stem} (conflicted copy`) && name.endsWith(`)${ext}`);
}

export interface Logged {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export function chunkedUpload(log: readonly Logged[]): { started: boolean; chunks: number; assembled: boolean } {
  const up = log.filter((l) => /\/remote\.php\/dav\/uploads\//.test(l.path));
  return {
    started: up.some((l) => l.method === 'MKCOL' && l.status < 300),
    chunks: up.filter((l) => l.method === 'PUT' && l.status < 300).length,
    assembled: up.some((l) => l.method === 'MOVE' && /\/\.file$/.test(decodeURIComponent(l.path).split('?')[0]!) && l.status < 300),
  };
}

export function counts(log: readonly Logged[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of log) out[l.method] = (out[l.method] ?? 0) + 1;
  return out;
}

/** Requests that move file contents (uploads and downloads of files, not listings). */
export function transfers(log: readonly Logged[]): number {
  return log.filter((l) => ((l.method === 'PUT' || l.method === 'GET') && /\/remote\.php\/(?:dav|webdav)\//.test(l.path)) || (l.method === 'POST' && /\/remote\.php\/dav\/bulk/.test(l.path))).length;
}
