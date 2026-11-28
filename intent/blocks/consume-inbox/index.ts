/**
 * Documents coming in. Intake sources (a watched folder, which also serves a network scanner that drops files
 * there, and mail attachments) list what is waiting; a file is taken only when it has stopped growing, is a real
 * file (not a link), is not a temporary or hidden name, and is of a kind the inbox accepts, judged from its first
 * bytes and not its name. Each item is checksummed (SHA-256) and a repeat is turned away with a pointer to the
 * first copy. A scan of several documents is split at separator sheets, found from barcodes already read from
 * the pages ("PATCHT" by default), and an archive serial number barcode ("ASN123") names a document and can start
 * one. Each document goes through the doc-classify block for its type, correspondent, tags and storage path, is
 * stored through an injected store, and is acknowledged at its source (deleted or moved aside; a failure moves it
 * to an errors folder). Hooks run before and after: argument lists, never a shell line, with a time limit, a
 * sanitised environment, and a choice of whether a failure stops the document. The jobs block runs it all with
 * retries, one job per item.
 * Out of scope: reading barcodes from images, cutting PDF pages apart, and OCR. Those are injected as functions.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Classifier, Decision, Document } from '../doc-classify/index.ts';
import type { Queue } from '../jobs/index.ts';

export class Rejected extends Error {
  constructor(why: string) {
    super(why);
  }
}

// ---------------------------------------------------------------- what a file is

export type FileKind = 'pdf' | 'png' | 'jpeg' | 'tiff' | 'text' | 'zip';

/** The kind of a file from its first bytes. Text must be valid UTF-8 with no NUL bytes. */
export function sniff(b: Uint8Array): FileKind | undefined {
  const buf = Buffer.from(b.subarray(0, 4096));
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a))) return 'tiff';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4) return 'zip';
  if (buf.length > 0 && !buf.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length > 4090 ? 4090 : buf.length));
      return 'text';
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- sources

export interface Item {
  readonly source: string;
  readonly name: string;
  readonly size: number;
  readonly modified: number;
  read(): Promise<Uint8Array>;
}

export type Outcome = 'consumed' | 'duplicate' | 'failed' | 'rejected';

export interface Source {
  readonly name: string;
  list(): Promise<Item[]>;
  /** Told what happened so it can delete, move aside or leave the item. */
  done(item: Item, outcome: Outcome, why?: string): Promise<void>;
}

export interface FolderOptions {
  readonly name: string;
  readonly dir: string;
  readonly now: () => number;
  /** A file changed more recently than this is still being written; default 2000 ms. */
  readonly settleMs?: number;
  /** After success: delete the file, or move it to `processed`. Default delete. */
  readonly keep?: boolean;
  readonly maxBytes?: number;
}

const TEMP = /(\.(tmp|part|crdownload|partial|swp|lock)|~)$/i;

export class FolderSource implements Source {
  readonly name: string;
  private readonly o: FolderOptions;
  constructor(o: FolderOptions) {
    this.name = o.name;
    this.o = o;
  }

  async list(): Promise<Item[]> {
    const out: Item[] = [];
    for (const n of (await readdir(this.o.dir)).sort()) {
      if (n.startsWith('.') || TEMP.test(n) || n.startsWith('~$')) continue;
      const p = join(this.o.dir, n);
      const st = await lstat(p);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (st.size === 0 || st.size > (this.o.maxBytes ?? 100_000_000)) continue;
      if (this.o.now() - st.mtimeMs < (this.o.settleMs ?? 2000)) continue;
      out.push({ source: this.name, name: n, size: st.size, modified: Math.floor(st.mtimeMs), read: async () => new Uint8Array(await readFile(p)) });
    }
    return out;
  }

  async done(item: Item, outcome: Outcome, _why?: string): Promise<void> {
    const from = join(this.o.dir, item.name);
    const to = outcome === 'consumed' || outcome === 'duplicate' ? (this.o.keep ? 'processed' : undefined) : 'errors';
    if (!to) {
      await unlink(from);
      return;
    }
    const dir = join(this.o.dir, '.consume', to);
    await mkdir(dir, { recursive: true });
    let target = join(dir, item.name);
    for (let i = 1; await lstat(target).then(() => true, () => false); i++) target = join(dir, `${i}-${item.name}`);
    await rename(from, target);
  }
}

export interface MailAttachment {
  readonly filename: string;
  readonly bytes: Uint8Array;
}
export interface MailMessage {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly attachments: readonly MailAttachment[];
}

/** Attachments of waiting messages; small images (logos, signatures) are skipped. */
export class MailSource implements Source {
  readonly name: string;
  private readonly fetch: () => Promise<readonly MailMessage[]>;
  private readonly minImageBytes: number;
  readonly handled: string[] = [];
  constructor(o: { name: string; fetch: () => Promise<readonly MailMessage[]>; minImageBytes?: number }) {
    this.name = o.name;
    this.fetch = o.fetch;
    this.minImageBytes = o.minImageBytes ?? 5000;
  }

  async list(): Promise<Item[]> {
    const out: Item[] = [];
    for (const m of await this.fetch()) {
      m.attachments.forEach((a, i) => {
        const kind = sniff(a.bytes);
        if ((kind === 'png' || kind === 'jpeg') && a.bytes.length < this.minImageBytes) return;
        const safe = a.filename.replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || `attachment-${i + 1}`;
        out.push({ source: this.name, name: `${m.id}-${i + 1}-${safe}`, size: a.bytes.length, modified: 0, read: async () => a.bytes });
      });
    }
    return out;
  }

  async done(item: Item, outcome: Outcome): Promise<void> {
    if (outcome === 'consumed' || outcome === 'duplicate') this.handled.push(item.name);
  }
}

// ---------------------------------------------------------------- splitting

export interface PageInfo {
  readonly barcodes: readonly string[];
  readonly blank?: boolean;
}

export interface Segment {
  /** Zero-based page numbers in the original scan. */
  readonly pages: readonly number[];
  readonly asn?: number;
}

export interface SplitOptions {
  /** A barcode that means "new document starts after this sheet"; default PATCHT. */
  readonly separator?: string;
  /** Treat a blank page as a separator too. */
  readonly blankSeparates?: boolean;
  /** Barcodes starting with this and then digits are archive serial numbers; default ASN. */
  readonly asnPrefix?: string;
  /** A page with a serial number barcode starts a new document. */
  readonly asnStartsDocument?: boolean;
}

export interface SplitResult {
  readonly segments: readonly Segment[];
  readonly separators: readonly number[];
  readonly problems: readonly string[];
}

export function splitPages(pages: readonly PageInfo[], o: SplitOptions = {}): SplitResult {
  const sep = o.separator ?? 'PATCHT';
  const prefix = o.asnPrefix ?? 'ASN';
  const asnRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{1,9})$`);
  const segments: { pages: number[]; asn?: number }[] = [];
  const separators: number[] = [];
  const problems: string[] = [];
  let cur: { pages: number[]; asn?: number } = { pages: [] };
  const close = () => {
    if (cur.pages.length) segments.push(cur);
    cur = { pages: [] };
  };
  pages.forEach((p, i) => {
    if (p.barcodes.includes(sep) || (o.blankSeparates && p.blank)) {
      separators.push(i);
      close();
      return;
    }
    const asns = p.barcodes.map((b) => asnRe.exec(b)).filter((x): x is RegExpExecArray => !!x).map((x) => Number(x[1]));
    if (asns.length) {
      if (o.asnStartsDocument && cur.pages.length && cur.asn !== undefined) close();
      if (cur.asn !== undefined && cur.asn !== asns[0]) problems.push(`page ${i + 1} has serial number ${asns[0]} but its document already has ${cur.asn}`);
      else cur.asn = asns[0]!;
      if (new Set(asns).size > 1) problems.push(`page ${i + 1} has more than one serial number`);
    }
    cur.pages.push(i);
  });
  close();
  const seen = new Map<number, number>();
  segments.forEach((s, i) => {
    if (s.asn === undefined) return;
    if (seen.has(s.asn)) problems.push(`serial number ${s.asn} is on documents ${seen.get(s.asn)! + 1} and ${i + 1}`);
    else seen.set(s.asn, i);
  });
  return { segments, separators, problems };
}

// ---------------------------------------------------------------- hooks

export interface Hook {
  readonly name: string;
  readonly stage: 'pre' | 'post';
  /** Program and arguments. Never a shell line. */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** abort: a failure stops the document (pre) or is reported (post); continue: it is only noted. */
  readonly onFailure: 'abort' | 'continue';
}

export interface HookRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type Runner = (argv: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number) => Promise<HookRun>;

export interface HookResult {
  readonly hook: string;
  readonly ok: boolean;
  readonly why?: string;
}

/** A runner that starts a program without a shell and kills it at the time limit. */
export const nodeRunner: Runner = (argv, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(argv[0]!, argv.slice(1), { env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: timeoutMs, maxBuffer: 1_000_000, shell: false }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : (err as { killed?: boolean }).killed ? 124 : 1) : 0;
      resolve({ code, stdout: String(stdout).slice(0, 4000), stderr: String(stderr).slice(0, 4000) });
    });
  });

const clean = (v: string) => v.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').slice(0, 1000);

export function hookEnv(facts: Readonly<Record<string, string | number | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(facts)) {
    if (v === undefined) continue;
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(k)) throw new Rejected(`${k} is not an allowed environment name`);
    out[`DOCUMENT_${k}`] = clean(String(v));
  }
  return out;
}

export function checkHook(h: Hook): void {
  if (!Array.isArray(h.argv) || h.argv.length === 0 || h.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) throw new Rejected(`hook ${h.name}: a command is a list of arguments`);
  if (!(h.timeoutMs > 0 && h.timeoutMs <= 600_000)) throw new Rejected(`hook ${h.name}: the time limit is up to 10 minutes`);
  if (/\s/.test(h.argv[0]!)) throw new Rejected(`hook ${h.name}: the program name has spaces; give the arguments as separate items`);
}

export async function runHooks(hooks: readonly Hook[], stage: 'pre' | 'post', run: Runner, env: Readonly<Record<string, string>>): Promise<{ results: HookResult[]; stop: boolean }> {
  const results: HookResult[] = [];
  let stop = false;
  for (const h of hooks.filter((x) => x.stage === stage)) {
    checkHook(h);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([run(h.argv, env, h.timeoutMs), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`took longer than ${h.timeoutMs} ms`)), h.timeoutMs + 50)))]);
      if (r.code === 0) results.push({ hook: h.name, ok: true });
      else {
        results.push({ hook: h.name, ok: false, why: `exited with ${r.code}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}` });
        if (h.onFailure === 'abort') stop = true;
      }
    } catch (e) {
      results.push({ hook: h.name, ok: false, why: e instanceof Error ? e.message : String(e) });
      if (h.onFailure === 'abort') stop = true;
    } finally {
      clearTimeout(timer);
    }
    if (stop) break;
  }
  return { results, stop };
}

// ---------------------------------------------------------------- the inbox

export interface Seen {
  get(checksum: string): string | undefined;
  set(checksum: string, id: string): void;
}
export const memorySeen = (): Seen => {
  const m = new Map<string, string>();
  return { get: (c) => m.get(c), set: (c, id) => void m.set(c, id) };
};

export interface Stored {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly kind: FileKind;
  readonly bytes: Uint8Array;
  readonly decision: Decision;
  readonly path: string;
  readonly asn?: number;
  readonly source: string;
  readonly text: string;
}

export interface InboxOptions {
  readonly classifier: Classifier;
  readonly seen: Seen;
  readonly store: (d: Stored) => Promise<void>;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly extractText?: (bytes: Uint8Array, kind: FileKind) => Promise<string>;
  /** Barcodes and blank pages of a scan; with `cut`, enables splitting. */
  readonly pageInfo?: (bytes: Uint8Array, kind: FileKind) => Promise<readonly PageInfo[]>;
  readonly cut?: (bytes: Uint8Array, pages: readonly number[]) => Promise<Uint8Array>;
  readonly split?: SplitOptions;
  readonly allowed?: readonly FileKind[];
  readonly maxBytes?: number;
  readonly hooks?: readonly Hook[];
  readonly run?: Runner;
}

export interface Report {
  readonly status: Outcome;
  readonly why?: string;
  readonly of?: string;
  readonly documents: readonly { id: string; name: string; asn?: number; path: string }[];
  readonly hooks: readonly HookResult[];
  readonly problems: readonly string[];
}

export class Inbox {
  private readonly o: InboxOptions;
  private readonly sources = new Map<string, Source>();
  private readonly waiting = new Map<string, Item>();
  constructor(o: InboxOptions, sources: readonly Source[]) {
    for (const h of o.hooks ?? []) checkHook(h);
    this.o = o;
    for (const s of sources) this.sources.set(s.name, s);
  }

  async consume(item: Item): Promise<Report> {
    const src = this.sources.get(item.source);
    if (!src) throw new Rejected(`no source ${item.source}`);
    const finish = async (r: Report): Promise<Report> => {
      await src.done(item, r.status, r.why);
      return r;
    };
    const fail = (status: Outcome, why: string, hooks: readonly HookResult[] = [], problems: readonly string[] = []): Report => ({ status, why, documents: [], hooks, problems });
    let bytes: Uint8Array;
    try {
      bytes = await item.read();
    } catch (e) {
      return finish(fail('failed', `could not read it: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (bytes.length === 0) return finish(fail('rejected', 'it is empty'));
    if (bytes.length > (this.o.maxBytes ?? 100_000_000)) return finish(fail('rejected', 'it is larger than the limit'));
    const kind = sniff(bytes);
    const allowed = this.o.allowed ?? ['pdf', 'png', 'jpeg', 'tiff', 'text'];
    if (!kind || !allowed.includes(kind)) return finish(fail('rejected', kind ? `${kind} files are not accepted` : 'it is not a kind of file the inbox accepts'));
    const checksum = sha256(bytes);
    const first = this.o.seen.get(checksum);
    if (first) return finish({ ...fail('duplicate', `the same content was filed as ${first}`), of: first });
    const facts = { FILE_NAME: item.name, SOURCE: item.source, CHECKSUM: checksum, KIND: kind, RECEIVED: this.o.now().toISOString() };
    const hooks: HookResult[] = [];
    if (this.o.hooks?.length) {
      const pre = await runHooks(this.o.hooks, 'pre', this.o.run ?? nodeRunner, hookEnv(facts));
      hooks.push(...pre.results);
      if (pre.stop) return finish(fail('failed', 'a pre-consume hook stopped it', hooks));
    }
    let parts: { bytes: Uint8Array; asn?: number; name: string }[] = [{ bytes, name: item.name }];
    let problems: readonly string[] = [];
    if (this.o.pageInfo && this.o.cut) {
      const pages = await this.o.pageInfo(bytes, kind);
      const sp = splitPages(pages, this.o.split);
      problems = sp.problems;
      if (sp.problems.length) return finish(fail('failed', `the scan could not be split: ${sp.problems[0]}`, hooks, sp.problems));
      if (!sp.segments.length) return finish(fail('rejected', 'every page was a separator', hooks));
      if (sp.segments.length > 1 || sp.separators.length) {
        parts = [];
        for (const [i, s] of sp.segments.entries()) parts.push({ bytes: await this.o.cut(bytes, s.pages), ...(s.asn !== undefined ? { asn: s.asn } : {}), name: item.name.replace(/(\.[^.]*)?$/, `-${i + 1}$1`) });
      }
    }
    const docs: { id: string; name: string; asn?: number; path: string }[] = [];
    try {
      for (const p of parts) {
        const text = this.o.extractText ? await this.o.extractText(p.bytes, kind) : kind === 'text' ? Buffer.from(p.bytes).toString('utf8') : '';
        const doc: Document = { title: p.name.replace(/\.[^.]+$/, ''), content: text, filename: p.name, created: this.o.now().toISOString(), added: this.o.now().toISOString(), ...(p.asn !== undefined ? { asn: p.asn } : {}) };
        const decision = this.o.classifier.classify(doc);
        const path = this.o.classifier.pathFor(doc, decision);
        const id = this.o.newId();
        const own = parts.length === 1 ? checksum : sha256(p.bytes);
        await this.o.store({ id, name: p.name, checksum: own, kind, bytes: p.bytes, decision, path, ...(p.asn !== undefined ? { asn: p.asn } : {}), source: item.source, text });
        this.o.seen.set(own, id);
        docs.push({ id, name: p.name, ...(p.asn !== undefined ? { asn: p.asn } : {}), path });
      }
      if (parts.length > 1) this.o.seen.set(checksum, docs[0]!.id);
    } catch (e) {
      return finish({ ...fail('failed', `storing failed: ${e instanceof Error ? e.message : String(e)}`, hooks, problems), documents: docs });
    }
    if (this.o.hooks?.length) {
      const post = await runHooks(this.o.hooks, 'post', this.o.run ?? nodeRunner, hookEnv({ ...facts, ID: docs.map((d) => d.id).join(','), COUNT: docs.length }));
      hooks.push(...post.results);
    }
    return finish({ status: 'consumed', documents: docs, hooks, problems });
  }

  /** Lists every source and queues one job per new item (the same item is never queued twice while waiting). */
  async poll(queue: Queue): Promise<number> {
    let n = 0;
    for (const s of this.sources.values())
      for (const item of await s.list()) {
        const key = `${item.source}|${item.name}|${item.modified}|${item.size}`;
        if (this.waiting.has(key)) continue;
        this.waiting.set(key, item);
        queue.enqueue('consume', { key }, { key, maxAttempts: 3 });
        n++;
      }
    return n;
  }

  /** Teaches the queue how to run consume jobs. */
  attach(queue: Queue): void {
    queue.handle('consume', async (payload) => {
      const key = (payload as { key: string }).key;
      const item = this.waiting.get(key);
      if (!item) throw new Rejected('that item is no longer waiting');
      const r = await this.consume(item);
      if (r.status === 'failed') throw new Error(r.why ?? 'failed');
      this.waiting.delete(key);
      return r;
    });
  }
}
