/**
 * Sealing a completed document so anyone can later check it. A seal holds a manifest (the document's SHA-256 and
 * size, who signed and when, the hash of each signer's evidence bundle from the signature-capture block, and the
 * completion time), the hash of that manifest, an HMAC over it made with the server's seal key (so a record
 * cannot be forged by someone who only knows the algorithm), an optional RFC 3161 timestamp over the manifest
 * hash (trusted-timestamp block), and a verification link whose key is derived from the seal, so ids cannot be
 * walked. A certificate of completion is produced as HTML (escaped) and as a small stand-alone PDF. Verification
 * returns a report of separate checks (document, manifest, seal, timestamp, evidence) in plain words, and, when
 * the archived original is at hand, where the presented copy first differs: a tamper report.
 * Out of scope: appending the certificate page into the signed PDF itself and PDF signature dictionaries
 * (PAdES, which needs a PDF writer and CMS signing of byte ranges; a separate block), QR codes for the link,
 * and certificate revocation checking.
 */
import { createHash, createHmac } from 'node:crypto';
import { equal } from '../crypto/index.ts';
import { makeRequest, verifyResponse } from '../trusted-timestamp/index.ts';
import type { Verified } from '../trusted-timestamp/index.ts';

export class SealRefused extends Error {
  constructor(why: string) {
    super(why);
  }
}

export interface SignerEntry {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly method: 'drawn' | 'typed' | 'uploaded';
  readonly signedAt: string;
  /** The bundleSha256 of the signer's evidence record. */
  readonly evidenceSha256: string;
  readonly ip?: string;
}

export interface Manifest {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly documentSha256: string;
  readonly documentBytes: number;
  readonly signers: readonly SignerEntry[];
  readonly completedAt: string;
}

export interface TimestampInfo {
  /** The TimeStampResp, base64. */
  readonly response: string;
  readonly nonce: string;
  readonly genTime: string;
  readonly tsa: string;
  readonly serial: string;
}

export interface SealRecord {
  readonly manifest: Manifest;
  readonly manifestSha256: string;
  readonly mac: string;
  readonly link: string;
  readonly timestamp?: TimestampInfo;
}

const canon = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v) ? `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}` : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v));
const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export interface SealerOptions {
  /** Server key for the seal and the link key; at least 16 characters, supplied at run time. */
  readonly sealKey: string;
  /** Where the verify page lives, https only (http allowed for localhost). */
  readonly baseUrl: string;
  readonly now: () => Date;
  /** Sends a TimeStampReq to an authority and returns the TimeStampResp. */
  readonly timestamp?: (request: Buffer) => Promise<Uint8Array>;
  readonly trustedRoots?: readonly (Uint8Array | string)[];
  /** A fresh 64-bit nonce for each request. */
  readonly nonce?: () => bigint;
}

export interface SealInput {
  readonly id: string;
  readonly title: string;
  readonly document: Uint8Array;
  readonly signers: readonly SignerEntry[];
  readonly completedAt: Date;
}

export interface Check {
  readonly name: 'document' | 'manifest' | 'seal' | 'timestamp' | 'evidence';
  readonly ok: boolean;
  readonly detail: string;
  /** A check that does not make the whole report fail when it is not ok (a seal without a timestamp). */
  readonly optional?: boolean;
}

export interface Report {
  /** Every required check passed. */
  readonly ok: boolean;
  /** An independent authority vouches for the date. */
  readonly dated: boolean;
  readonly checks: readonly Check[];
  /** Where the presented copy first differs from the archived original, if the original was supplied. */
  readonly tamper?: { readonly firstDifference: number | null; readonly presentedBytes: number; readonly originalBytes: number };
  readonly timestamp?: Verified;
}

export class Sealer {
  private readonly o: SealerOptions;
  constructor(o: SealerOptions) {
    if (o.sealKey.length < 16) throw new SealRefused('the seal key is too short');
    const u = new URL(o.baseUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new SealRefused('the verification link must be https');
    if (u.search || u.hash) throw new SealRefused('the base address has no query or fragment');
    this.o = o;
  }

  private mac(manifestSha256: string): string {
    return createHmac('sha256', this.o.sealKey).update(`seal|${manifestSha256}`).digest('base64url');
  }

  private linkFor(id: string, manifestSha256: string): string {
    const k = createHmac('sha256', this.o.sealKey).update(`link|${id}|${manifestSha256}`).digest().subarray(0, 16).toString('base64url');
    return `${this.o.baseUrl.replace(/\/$/, '')}/verify/${encodeURIComponent(id)}?k=${k}`;
  }

  async seal(i: SealInput): Promise<SealRecord> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(i.id)) throw new SealRefused('a seal id is 1 to 64 letters, digits, - or _');
    if (!i.title.trim() || i.title.length > 200) throw new SealRefused('the title is missing or longer than 200 characters');
    if (!i.signers.length) throw new SealRefused('a document with no signers is not sealed');
    if (i.document.length === 0) throw new SealRefused('the document is empty');
    const ids = new Set<string>();
    for (const s of i.signers) {
      if (ids.has(s.id)) throw new SealRefused(`signer ${s.id} appears twice`);
      ids.add(s.id);
      if (!/^[0-9a-f]{64}$/.test(s.evidenceSha256)) throw new SealRefused(`signer ${s.id} has no evidence hash`);
      if (Number.isNaN(Date.parse(s.signedAt))) throw new SealRefused(`signer ${s.id} has no valid signing time`);
      if (Date.parse(s.signedAt) > i.completedAt.getTime()) throw new SealRefused(`signer ${s.id} signed after the document was completed`);
    }
    const manifest: Manifest = { version: 1, id: i.id, title: i.title.trim(), documentSha256: sha256hex(i.document), documentBytes: i.document.length, signers: [...i.signers].sort((a, b) => a.signedAt.localeCompare(b.signedAt) || a.id.localeCompare(b.id)), completedAt: i.completedAt.toISOString() };
    const manifestSha256 = sha256hex(canon(manifest));
    let timestamp: TimestampInfo | undefined;
    if (this.o.timestamp) {
      const nonce = this.o.nonce?.() ?? BigInt(`0x${createHash('sha256').update(`${i.id}|${this.o.now().toISOString()}`).digest('hex').slice(0, 15)}`);
      const request = makeRequest({ imprint: Buffer.from(manifestSha256, 'hex'), nonce, certReq: true });
      const response = await this.o.timestamp(request);
      const v = verifyResponse(response, { request, trustedRoots: this.o.trustedRoots ?? [], now: this.o.now() });
      if (v.genTime < i.completedAt) throw new SealRefused('the authority dated the timestamp before the document was completed');
      timestamp = { response: Buffer.from(response).toString('base64'), nonce: nonce.toString(), genTime: v.genTime.toISOString(), tsa: v.tsa, serial: v.serial };
    }
    return { manifest, manifestSha256, mac: this.mac(manifestSha256), link: this.linkFor(i.id, manifestSha256), ...(timestamp ? { timestamp } : {}) };
  }

  /**
   * Checks a presented document against a seal record. Every check is reported, not just the first failure.
   * `evidence` verifies each signer's evidence record by its hash (the signature-capture block's verify).
   */
  verify(presented: Uint8Array, r: SealRecord, o: { original?: Uint8Array; evidence?: Readonly<Record<string, { bundleSha256: string; ok: boolean }>> } = {}): Report {
    const checks: Check[] = [];
    const m = r.manifest;
    const docHash = sha256hex(presented);
    const docOk = docHash === m.documentSha256 && presented.length === m.documentBytes;
    checks.push({ name: 'document', ok: docOk, detail: docOk ? 'the document is exactly the one that was sealed' : presented.length !== m.documentBytes ? `the document has ${presented.length} bytes; ${m.documentBytes} were sealed` : 'the document has changed since it was sealed (its hash differs)' });
    const mh = sha256hex(canon(m));
    const manOk = mh === r.manifestSha256;
    checks.push({ name: 'manifest', ok: manOk, detail: manOk ? 'the list of signers and times is as sealed' : 'the signers, times or title in the record have been changed' });
    const sealOk = manOk && equal(this.mac(r.manifestSha256), r.mac) && equal(this.linkFor(m.id, r.manifestSha256), r.link);
    checks.push({ name: 'seal', ok: sealOk, detail: sealOk ? 'the seal and link were made by this service' : 'the seal does not match: the record was not made by this service, or was altered' });
    let ts: Verified | undefined;
    if (r.timestamp) {
      try {
        const request = makeRequest({ imprint: Buffer.from(r.manifestSha256, 'hex'), nonce: BigInt(r.timestamp.nonce), certReq: true });
        ts = verifyResponse(Buffer.from(r.timestamp.response, 'base64'), { request, trustedRoots: this.o.trustedRoots ?? [], now: this.o.now() });
        const early = ts.genTime < new Date(m.completedAt);
        checks.push({ name: 'timestamp', ok: !early, detail: early ? 'the timestamp is dated before the document was completed' : `timestamped ${ts.genTime.toISOString()} by ${ts.tsa}` });
      } catch (e) {
        checks.push({ name: 'timestamp', ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    } else checks.push({ name: 'timestamp', ok: false, optional: true, detail: 'this seal has no independent timestamp, so its date rests on this service alone' });
    if (o.evidence) {
      const bad = m.signers.filter((s) => { const e = o.evidence![s.id]; return !e || e.bundleSha256 !== s.evidenceSha256 || !e.ok; });
      checks.push({ name: 'evidence', ok: bad.length === 0, detail: bad.length ? `evidence is missing or altered for: ${bad.map((s) => s.name).join(', ')}` : 'every signer\'s evidence record is intact' });
    }
    const report: Report = { ok: checks.every((c) => c.ok || c.optional), dated: checks.some((c) => c.name === 'timestamp' && c.ok), checks, ...(ts ? { timestamp: ts } : {}) };
    if (o.original) {
      let at: number | null = null;
      const n = Math.min(presented.length, o.original.length);
      for (let k = 0; k < n; k++) if (presented[k] !== o.original[k]) { at = k; break; }
      if (at === null && presented.length !== o.original.length) at = n;
      return { ...report, tamper: { firstDifference: at, presentedBytes: presented.length, originalBytes: o.original.length } };
    }
    return report;
  }

  /** Whether a verification link's key belongs to the seal record it names. */
  linkMatches(url: string, r: SealRecord): boolean {
    return equal(url, r.link) && equal(this.linkFor(r.manifest.id, r.manifestSha256), url);
  }
}

// ---------------------------------------------------------------- certificate of completion

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The certificate as text lines (also the content of the PDF). */
export function certificateLines(r: SealRecord): string[] {
  const m = r.manifest;
  const lines = ['CERTIFICATE OF COMPLETION', '', `Document: ${m.title}`, `Seal id: ${m.id}`, `Completed: ${m.completedAt}`, `Size: ${m.documentBytes} bytes`, `SHA-256: ${m.documentSha256}`, '', 'Signers'];
  for (const s of m.signers) lines.push(`  ${s.name}${s.email ? ` <${s.email}>` : ''}`, `    signed ${s.signedAt} (${s.method})${s.ip ? ` from ${s.ip}` : ''}`, `    evidence ${s.evidenceSha256}`);
  lines.push('', `Seal: ${r.manifestSha256}`);
  if (r.timestamp) lines.push(`Timestamp: ${r.timestamp.genTime} by ${r.timestamp.tsa}, serial ${r.timestamp.serial}`);
  else lines.push('Timestamp: none (the date rests on this service alone)');
  lines.push('', 'Verify this document:', r.link);
  return lines;
}

/** The certificate as an HTML fragment; everything from the record is escaped. */
export function certificateHtml(r: SealRecord): string {
  const m = r.manifest;
  const rows = m.signers.map((s) => `<tr><td>${esc(s.name)}${s.email ? ` &lt;${esc(s.email)}&gt;` : ''}</td><td>${esc(s.signedAt)}</td><td>${esc(s.method)}</td><td><code>${esc(s.evidenceSha256)}</code></td></tr>`).join('');
  return `<section class="certificate"><h1>Certificate of completion</h1><dl><dt>Document</dt><dd>${esc(m.title)}</dd><dt>Completed</dt><dd>${esc(m.completedAt)}</dd><dt>SHA-256</dt><dd><code>${esc(m.documentSha256)}</code></dd><dt>Seal</dt><dd><code>${esc(r.manifestSha256)}</code></dd><dt>Timestamp</dt><dd>${r.timestamp ? `${esc(r.timestamp.genTime)} by ${esc(r.timestamp.tsa)}` : 'none'}</dd></dl><table><thead><tr><th>Signer</th><th>Signed</th><th>Method</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table><p><a href="${esc(r.link)}">Verify this document</a></p></section>`;
}

/** The verify page's body: each check with its outcome, in plain words. */
export function verifyHtml(rep: Report): string {
  return `<section class="verification"><h1>${rep.ok ? 'This document is intact' : 'This document could not be verified'}</h1><ul>${rep.checks.map((c) => `<li class="${c.ok ? 'pass' : c.optional ? 'note' : 'fail'}"><strong>${c.ok ? 'Passed' : c.optional ? 'Note' : 'Failed'}: ${esc(c.name)}</strong> ${esc(c.detail)}</li>`).join('')}</ul>${rep.tamper ? `<p>${rep.tamper.firstDifference === null ? 'The presented copy is identical to the archived original.' : `The presented copy first differs from the archived original at byte ${rep.tamper.firstDifference}.`}</p>` : ''}</section>`;
}

const pdfEsc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

/** A stand-alone PDF of the certificate: Helvetica text, long lines wrapped, as many pages as needed. */
export function certificatePdf(r: SealRecord): Buffer {
  const wrapped: string[] = [];
  for (const l of certificateLines(r)) {
    const text = l.replace(/[^\x20-\x7e]/g, '?');
    if (text.length <= 92) wrapped.push(text);
    else for (let i = 0; i < text.length; i += 92) wrapped.push((i ? '    ' : '') + text.slice(i, i + 92));
  }
  const perPage = 52;
  const pages = Array.from({ length: Math.max(1, Math.ceil(wrapped.length / perPage)) }, (_, p) => wrapped.slice(p * perPage, (p + 1) * perPage));
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((x) => `${x} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((ls, i) => {
    const content = `BT /F1 ${i === 0 ? 10 : 10} Tf 12 TL 48 800 Td ${ls.map((l, k) => `${k ? 'T* ' : ''}(${pdfEsc(l)}) Tj`).join(' ')} ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Reads the seal id from a verification link. */
export function sealIdFromLink(link: string): string {
  const u = new URL(link);
  const m = /\/verify\/([^/]+)$/.exec(u.pathname);
  if (!m || !u.searchParams.get('k')) throw new SealRefused('that is not a verification link');
  return decodeURIComponent(m[1]!);
}
