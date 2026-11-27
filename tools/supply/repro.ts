/**
 * Proves the Files app's shipped artefact is reproducible. Files has no build step and no npm dependencies: its
 * image is node:22-slim plus the files files/Dockerfile copies into /app, with the block tests deleted. That file
 * set is the artefact. This tool reads the Dockerfile to decide the set, packs it as a tar.gz whose bytes depend only
 * on the files' paths, contents and executable bits (sorted by path bytes, mtime 0, uid and gid 0, fixed modes, a
 * gzip header with no time, name or OS), does it twice from two clean copies made differently, and compares SHA-256
 * digests.
 *
 *   node tools/supply/repro.ts [--out <dir>]            build twice, compare, write the artefact and its digests
 *   node tools/supply/repro.ts --compare <dir>          check an extracted image's /app holds exactly the artefact
 *
 * A Dockerfile instruction this tool does not understand fails the run: the artefact is never guessed.
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { REPO_ROOT, cmp } from './sbom.ts';

export interface Entry {
  /** Path inside the image's WORKDIR, POSIX separators, no leading slash. */
  readonly path: string;
  readonly data: Buffer;
  readonly executable: boolean;
}

/** What the Dockerfile ships: COPY sources into WORKDIR, then the files its RUN deletes. */
export interface Plan {
  readonly workdir: string;
  readonly copies: readonly { from: string; to: string; dir: boolean }[];
  /** Directory (relative to WORKDIR) and file-name glob of each `find <dir> -name <glob> -delete`. */
  readonly deletes: readonly { dir: string; glob: string }[];
}

const unquote = (s: string): string => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

/** Reads the Dockerfile. Only instructions whose effect on /app is known are accepted. */
export function planFromDockerfile(text: string): Plan {
  let workdir = '/';
  const copies: { from: string; to: string; dir: boolean }[] = [];
  const deletes: { dir: string; glob: string }[] = [];
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const [op = '', ...rest] = line.split(/\s+/);
    const args = rest.join(' ');
    switch (op.toUpperCase()) {
      case 'FROM': case 'ENV': case 'USER': case 'EXPOSE': case 'CMD': case 'ENTRYPOINT': case 'LABEL': case 'ARG':
        break; // no effect on the files under WORKDIR
      case 'WORKDIR':
        workdir = posix.resolve(workdir, args);
        break;
      case 'COPY': {
        const parts = args.split(/\s+/);
        if (parts.some((p) => p.startsWith('--')) || args.startsWith('[')) throw new Error(`COPY form not understood: ${line}`);
        const to = parts.pop() as string;
        if (parts.length > 1 && !to.endsWith('/')) throw new Error(`COPY of several sources needs a directory destination: ${line}`);
        const dest = posix.relative(workdir, posix.resolve(workdir, to));
        if (dest.startsWith('..')) throw new Error(`COPY outside WORKDIR is not part of the artefact: ${line}`);
        for (const from of parts) {
          if (/[*?[]/.test(from)) throw new Error(`COPY with a wildcard is not understood: ${line}`);
          const dir = from.endsWith('/');
          copies.push({ from: from.replace(/\/+$/, ''), to: to.endsWith('/') && !dir ? posix.join(dest, posix.basename(from)) : dest, dir });
        }
        break;
      }
      case 'RUN': {
        for (const cmd of args.split('&&').map((c) => c.trim())) {
          const find = /^find\s+(\S+)\s+-name\s+(\S+)\s+-delete$/.exec(cmd);
          if (find) {
            deletes.push({ dir: posix.relative(workdir, posix.resolve(workdir, unquote(find[1] as string))), glob: unquote(find[2] as string) });
            continue;
          }
          if (/^chown\s+(-R\s+)?\S+\s+\S+$/.test(cmd)) continue; // ownership, which the artefact normalises
          throw new Error(`RUN step not understood, so the artefact cannot be derived: ${cmd}`);
        }
        break;
      }
      default:
        throw new Error(`Dockerfile instruction not understood: ${line}`);
    }
  }
  return { workdir, copies, deletes };
}

/** A shell glob of the kind `find -name` takes, as a regular expression over a file name. */
function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error(`${rel}: symbolic links are not part of the artefact`);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) walk(root, rel ? join(rel, name) : name, out);
  } else if (st.isFile()) out.push(rel);
  else throw new Error(`${rel}: not a regular file`);
}

/** The artefact's entries, read from a source tree laid out like the repository. */
export function collect(sourceRoot: string, plan: Plan): Entry[] {
  const byPath = new Map<string, Entry>();
  for (const c of plan.copies) {
    const src = join(sourceRoot, c.from);
    if (!existsSync(src)) throw new Error(`${c.from}: copied by the Dockerfile but missing`);
    const files: string[] = [];
    if (statSync(src).isDirectory()) walk(src, '', files);
    else files.push('');
    for (const f of files) {
      const abs = f ? join(src, f) : src;
      const path = f ? posix.join(c.to, f.split(sep).join('/')) : c.to;
      byPath.set(path, { path, data: readFileSync(abs), executable: (statSync(abs).mode & 0o100) !== 0 });
    }
  }
  for (const d of plan.deletes) {
    const re = globToRe(d.glob);
    for (const path of [...byPath.keys()]) {
      if ((d.dir === '' || path.startsWith(`${d.dir}/`)) && re.test(posix.basename(path))) byPath.delete(path);
    }
  }
  return [...byPath.values()].sort((a, b) => cmp(a.path, b.path));
}

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, mode: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, 'utf8');
  let prefix = Buffer.alloc(0);
  let base = nameBytes;
  if (nameBytes.length > 100) {
    // ustar splits a long path at a slash: up to 155 bytes of prefix and 100 of name.
    let cut = -1;
    for (let i = nameBytes.length - 1; i >= 0; i--) {
      if (nameBytes[i] === 0x2f && i <= 155 && nameBytes.length - i - 1 <= 100) { cut = i; break; }
    }
    if (cut < 0) return Buffer.alloc(0);
    prefix = nameBytes.subarray(0, cut);
    base = nameBytes.subarray(cut + 1);
  }
  base.copy(h, 0);
  h.write(octal(mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  prefix.copy(h, 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

function pad(n: number): Buffer {
  return Buffer.alloc((512 - (n % 512)) % 512, 0);
}

/** A PAX extended header carrying a path too long for ustar. */
function paxPath(name: string): Buffer[] {
  const field = (len: number): string => `${len} path=${name}\n`;
  let len = Buffer.byteLength(field(0));
  while (Buffer.byteLength(field(len)) !== len) len = Buffer.byteLength(field(len));
  const body = Buffer.from(field(len), 'utf8');
  return [header('PaxHeader', body.length, 0o644, 'x'), body, pad(body.length)];
}

/** An uncompressed tar of the entries: sorted by path bytes, mtime 0, owner 0:0, mode 0644 or 0755. */
export function tar(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => cmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) if ((sorted[i] as Entry).path === (sorted[i - 1] as Entry).path) throw new Error(`duplicate path ${(sorted[i] as Entry).path}`);
  for (const e of sorted) {
    const mode = e.executable ? 0o755 : 0o644;
    let h = header(e.path, e.data.length, mode, '0');
    if (h.length === 0) {
      parts.push(...paxPath(e.path));
      h = header(e.path.slice(-100).replace(/^[^/]*\//, ''), e.data.length, mode, '0');
    }
    parts.push(h, e.data, pad(e.data.length));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

/** Gzip with a fixed header: no mtime, no file name, OS "unknown", so only the compressor's output varies it. */
export function gzip(data: Buffer): Buffer {
  const head = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(data) >>> 0, 0);
  tail.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([head, deflateRawSync(data, { level: 9, memLevel: 9, strategy: 0 }), tail]);
}

/** The artefact: tar and tar.gz of the entries. */
export function pack(entries: readonly Entry[]): { tar: Buffer; tgz: Buffer } {
  const t = tar(entries);
  return { tar: t, tgz: gzip(t) };
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** `sha256  path` lines for every entry, in artefact order. */
export function manifest(entries: readonly Entry[]): string {
  return entries.map((e) => `${sha256(e.data)}  ${e.path}`).join('\n') + '\n';
}

/**
 * Copies the Dockerfile's sources from the repository into a fresh directory. `variant` 1 copies in reverse order
 * with fresh mtimes, a different umask-style mode on each file and a later clock, so anything the packing took from
 * the filesystem other than path, bytes and executable bit would change the digest.
 */
export function cleanCopy(repoRoot: string, plan: Plan, variant: 0 | 1): string {
  const dir = mkdtempSync(join(tmpdir(), `zthr-repro-${variant}-`));
  const copies = variant ? [...plan.copies].reverse() : plan.copies;
  for (const c of copies) {
    const src = join(repoRoot, c.from);
    const dst = join(dir, c.from);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, preserveTimestamps: variant === 0 });
  }
  if (variant === 1) {
    const files: string[] = [];
    walk(dir, '', files);
    const t = new Date(Date.UTC(2031, 0, 2, 3, 4, 5));
    files.reverse().forEach((f, i) => {
      const abs = join(dir, f);
      const exec = (statSync(abs).mode & 0o100) !== 0;
      chmodSync(abs, (exec ? 0o700 : 0o600) | (i % 2 ? 0o060 : 0o004));
      utimesSync(abs, t, new Date(t.getTime() + i * 1000));
    });
  }
  return dir;
}

export interface Build { readonly tarSha256: string; readonly tgzSha256: string; readonly files: number; readonly bytes: number; readonly entries: Entry[]; readonly tgz: Buffer }

export function buildFrom(sourceRoot: string, plan: Plan): Build {
  const entries = collect(sourceRoot, plan);
  const { tar: t, tgz } = pack(entries);
  return { tarSha256: sha256(t), tgzSha256: sha256(tgz), files: entries.length, bytes: entries.reduce((n, e) => n + e.data.length, 0), entries, tgz };
}

/** Differences between an extracted directory and the artefact: missing, extra and changed files. */
export function compareDir(dir: string, entries: readonly Entry[]): string[] {
  const files: string[] = [];
  walk(dir, '', files);
  const have = new Map(files.map((f) => [f.split(sep).join('/'), readFileSync(join(dir, f))]));
  const problems: string[] = [];
  for (const e of entries) {
    const got = have.get(e.path);
    if (!got) problems.push(`missing in image: ${e.path}`);
    else if (!got.equals(e.data)) problems.push(`differs from source: ${e.path}`);
    have.delete(e.path);
  }
  for (const extra of [...have.keys()].sort(cmp)) problems.push(`in image but not in artefact: ${extra}`);
  return problems;
}

const DOCKERFILE = 'files/Dockerfile';
export const ARTEFACT_NAME = 'files-app.tar.gz';

function main(argv: string[]): number {
  let out = join(REPO_ROOT, 'tools', 'supply', 'out');
  let compare: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] ?? '');
    else if (argv[i] === '--compare') compare = resolve(argv[++i] ?? '');
    else { console.error(`unknown argument ${argv[i]}`); return 2; }
  }
  const plan = planFromDockerfile(readFileSync(join(REPO_ROOT, DOCKERFILE), 'utf8'));
  if (compare) {
    const entries = collect(REPO_ROOT, plan);
    const problems = compareDir(compare, entries);
    for (const p of problems) console.error(p);
    console.log(problems.length ? `${problems.length} differences between the image's ${plan.workdir} and the artefact` : `The image's ${plan.workdir} holds exactly the artefact's ${entries.length} files, byte for byte.`);
    return problems.length ? 1 : 0;
  }
  const dirs = [cleanCopy(REPO_ROOT, plan, 0), cleanCopy(REPO_ROOT, plan, 1)];
  try {
    const [a, b] = dirs.map((d) => buildFrom(d, plan)) as [Build, Build];
    console.log(`Artefact: the ${a.files} files (${a.bytes} bytes) ${DOCKERFILE} puts in ${plan.workdir}`);
    console.log(`build 1  tar sha256:${a.tarSha256}  tar.gz sha256:${a.tgzSha256}`);
    console.log(`build 2  tar sha256:${b.tarSha256}  tar.gz sha256:${b.tgzSha256}`);
    if (a.tarSha256 !== b.tarSha256 || a.tgzSha256 !== b.tgzSha256) {
      console.error('NOT REPRODUCIBLE: two builds from the same source gave different bytes.');
      return 1;
    }
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, ARTEFACT_NAME), a.tgz);
    writeFileSync(join(out, 'files-app.manifest.txt'), manifest(a.entries));
    writeFileSync(join(out, 'files-app.sha256'), `${a.tgzSha256}  ${ARTEFACT_NAME}\n`);
    writeFileSync(join(out, 'files-app.digests.json'), `${JSON.stringify({ artefact: ARTEFACT_NAME, dockerfile: DOCKERFILE, workdir: plan.workdir, files: a.files, bytes: a.bytes, tarSha256: a.tarSha256, tgzSha256: a.tgzSha256, node: process.versions.node, zlib: process.versions.zlib }, null, 2)}\n`);
    console.log(`Reproducible. sha256:${a.tgzSha256}  ${relative(process.cwd(), join(out, ARTEFACT_NAME)) || ARTEFACT_NAME}`);
    return 0;
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
