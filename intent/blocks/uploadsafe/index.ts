/**
 * Upload safety: what a file may be called and how large it may be, checked before any bytes are kept, and what
 * it really is, read from its first bytes. A name that would break a client on another system (a reserved
 * Windows name, a trailing dot, a character a file system forbids) or that the server must never hold (a
 * temporary upload name, a server configuration file) is refused with the reason. A type that does not match
 * the name is reported, so the caller decides whether to refuse it or only to serve it as a download.
 */

export interface Policy {
  /** Names refused whatever the case ("htaccess" refuses ".htaccess" and ".HTACCESS"). */
  readonly names: readonly string[];
  /** Endings refused (".part" is a client's unfinished upload). */
  readonly endings: readonly string[];
  /** Characters refused anywhere in a name. */
  readonly characters: string;
  /** Refuse names Windows cannot hold: CON, PRN, AUX, NUL, COM1 to COM9, LPT1 to LPT9, with any extension. */
  readonly windowsReserved: boolean;
  /** Refuse names ending in a dot or a space, which Windows silently strips. */
  readonly windowsTrailing: boolean;
  /** Bytes a single file may have; undefined is no limit. */
  readonly maxBytes?: number;
}

/** What Nextcloud's own clients expect a server to refuse. */
export const NEXTCLOUD: Policy = { names: ['.htaccess'], endings: ['.part', '.filepart'], characters: '\\/\0', windowsReserved: true, windowsTrailing: true };

export class Unsafe extends Error {
  readonly why: string;
  constructor(why: string) {
    super(why);
    this.why = why;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Throws Unsafe with the reason when a name breaks the policy. */
export function checkName(name: string, p: Policy = NEXTCLOUD): void {
  const lower = name.toLowerCase();
  if (p.names.some((n) => n.toLowerCase() === lower)) throw new Unsafe(`"${name}" is a name this server does not keep`);
  const end = p.endings.find((e) => lower.endsWith(e.toLowerCase()));
  if (end) throw new Unsafe(`names ending in "${end}" are kept for unfinished uploads`);
  const bad = [...name].find((c) => p.characters.includes(c) || c.charCodeAt(0) < 32);
  if (bad !== undefined) throw new Unsafe(`"${name}" contains a character a file system cannot hold`);
  if (p.windowsReserved && RESERVED.test(name)) throw new Unsafe(`"${name}" is a name Windows reserves`);
  if (p.windowsTrailing && /[. ]$/.test(name)) throw new Unsafe(`"${name}" ends in a dot or a space, which Windows removes`);
}

export function checkSize(bytes: number, p: Policy = NEXTCLOUD): void {
  if (p.maxBytes !== undefined && bytes > p.maxBytes) throw new Unsafe(`${bytes} bytes is over the limit of ${p.maxBytes} for one file`);
}

/** Magic numbers for the types people store most, and the extensions each is honestly called. */
const SIGNATURES: readonly { type: string; bytes: readonly (number | null)[]; offset?: number; ext: readonly string[] }[] = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], ext: ['pdf'] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ext: ['png'] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff], ext: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38], ext: ['gif'] },
  { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50], ext: ['webp'] },
  { type: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04], ext: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'jar', 'apk'] },
  { type: 'application/gzip', bytes: [0x1f, 0x8b], ext: ['gz', 'tgz'] },
  { type: 'video/mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, ext: ['mp4', 'm4a', 'm4v', 'mov', 'heic', 'heif', '3gp'] },
  { type: 'application/x-msdownload', bytes: [0x4d, 0x5a], ext: ['exe', 'dll', 'msi', 'scr', 'sys', 'com'] },
  { type: 'application/x-executable', bytes: [0x7f, 0x45, 0x4c, 0x46], ext: ['', 'so', 'bin', 'elf', 'o'] },
];

/** What the first bytes say a file is, or null when they match nothing known. */
export function sniff(head: Uint8Array): string | null {
  for (const s of SIGNATURES) {
    const o = s.offset ?? 0;
    if (head.length < o + s.bytes.length) continue;
    if (s.bytes.every((b, i) => b === null || head[o + i] === b)) return s.type;
  }
  return null;
}

export interface Finding {
  /** What the bytes are, when known. */
  readonly actual: string | null;
  /** The name's extension says something else the bytes are not. */
  readonly mismatch: boolean;
  /** The bytes are a program, whatever the name says. */
  readonly executable: boolean;
}

/** What a file's first bytes say, against its name. Unknown bytes are never a mismatch. */
export function inspect(name: string, head: Uint8Array): Finding {
  const actual = sniff(head);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const sig = SIGNATURES.find((s) => s.type === actual);
  const executable = actual === 'application/x-msdownload' || actual === 'application/x-executable';
  return { actual, mismatch: !!sig && !sig.ext.includes(ext), executable };
}
