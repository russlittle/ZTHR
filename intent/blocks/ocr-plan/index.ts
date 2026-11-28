/**
 * OCR as a pipeline, not a library call. Page images go in; text with a position and a confidence for every word
 * comes out, behind a small provider interface so the engine (Tesseract, a cloud service, a model) can change
 * without the rest noticing, and a scripted twin stands in for it in tests. Engines answer in hOCR (the HTML
 * microformat Tesseract writes) or ALTO XML (libraries and archives); both are read into one page model, with
 * confidences on one 0 to 100 scale. Confidence thresholds sort each word into accepted, to-review or dropped,
 * and judge each page, so a person is asked to look only at pages and words that need it. The result merges into
 * a PDF plan: an invisible text layer (text render mode 3) placed over the scanned image in points, each word
 * stretched to its box using Helvetica's widths, ready for a PDF writer to lay down.
 *
 * Follows the hOCR 1.2 specification (bbox, x_wconf, ocr_page, ocr_line, ocrx_word) and ALTO 4 (Page, TextBlock,
 * TextLine, String with HPOS, VPOS, WIDTH, HEIGHT, WC; MeasurementUnit pixel, mm10 and inch1200).
 *
 * Both readers refuse entity declarations and (for ALTO) any DOCTYPE, and inputs over a size limit, so a hostile
 * engine output cannot expand into memory. Out of scope: running an engine process (`tesseractArgs` only builds
 * its argument list), image preprocessing, writing the PDF itself, and right-to-left line reordering.
 */

export class OcrInputRefused extends Error {
  constructor(why: string) {
    super(`OCR output refused: ${why}`);
    this.name = 'OcrInputRefused';
  }
}
export class OcrFailed extends Error {
  readonly page: string;
  constructor(page: string, why: string) {
    super(`OCR failed on ${page}: ${why}`);
    this.name = 'OcrFailed';
    this.page = page;
  }
}

export interface Word {
  readonly text: string;
  /** Left, top, right, bottom in the page's own unit. */
  readonly box: readonly [number, number, number, number];
  /** 0 to 100. */
  readonly conf: number;
}
export interface Line {
  readonly words: readonly Word[];
}
export type Unit = 'pixel' | 'mm10' | 'inch1200';
export interface OcrPage {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly unit: Unit;
  /** Pixels per inch, for unit pixel. */
  readonly dpi: number;
  readonly lines: readonly Line[];
}

const MAX_BYTES = 20_000_000;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
    }
    return ENTITIES[e] ?? m;
  });
}

interface Tag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly close: boolean;
  readonly selfClosing: boolean;
}
type Tok = { readonly t: 'tag'; readonly tag: Tag } | { readonly t: 'text'; readonly s: string };

/** A small markup tokenizer for the two formats: tags, attributes, text. Comments are skipped; nothing is fetched or expanded. */
function tokenize(src: string, xml: boolean): Tok[] {
  if (src.length > MAX_BYTES) throw new OcrInputRefused('too large');
  if (/<!ENTITY/i.test(src)) throw new OcrInputRefused('entity declarations are not accepted');
  if (xml && /<!DOCTYPE/i.test(src)) throw new OcrInputRefused('a DOCTYPE is not accepted');
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      out.push({ t: 'text', s: src.slice(i) });
      break;
    }
    if (lt > i) out.push({ t: 'text', s: src.slice(i, lt) });
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end < 0) throw new OcrInputRefused('unterminated CDATA');
      out.push({ t: 'text', s: src.slice(lt + 9, end).replace(/[&<]/g, (c) => (c === '&' ? '&amp;' : '&lt;')) });
      i = end + 3;
      continue;
    }
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    let j = lt + 1;
    let quote = '';
    while (j < src.length && (quote || src[j] !== '>')) {
      if (quote) {
        if (src[j] === quote) quote = '';
      } else if (src[j] === '"' || src[j] === "'") quote = src[j]!;
      j++;
    }
    if (j >= src.length) throw new OcrInputRefused('unterminated tag');
    const body = src.slice(lt + 1, j);
    const m = /^(\/)?\s*([A-Za-z_][\w:.-]*)([\s\S]*?)(\/)?$/.exec(body);
    if (!m) throw new OcrInputRefused('malformed tag');
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[xml ? a[1]! : a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    out.push({ t: 'tag', tag: { name: xml ? m[2]!.replace(/^.*:/, '') : m[2]!.toLowerCase(), attrs, close: m[1] === '/', selfClosing: m[4] === '/' } });
    i = j + 1;
  }
  return out;
}

const VOID = new Set(['meta', 'br', 'img', 'link', 'hr', 'input']);
const num = (s: string | undefined): number | undefined => (s !== undefined && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Read hOCR into pages. Words without a box are kept with an empty box and confidence zero rather than guessed. */
export function parseHocr(html: string, opts: { dpi?: number; id?: string } = {}): OcrPage[] {
  const toks = tokenize(html, false);
  const pages: { id: string; width: number; height: number; dpi: number; lines: Line[] }[] = [];
  let page: (typeof pages)[number] | undefined;
  let lineWords: Word[] | undefined;
  let word: { box: [number, number, number, number]; conf: number; text: string } | undefined;
  const stack: { name: string; kind: 'page' | 'line' | 'word' | '' }[] = [];
  for (const k of toks) {
    if (k.t === 'text') {
      if (word) word.text += decode(k.s);
      continue;
    }
    const { tag } = k;
    if (tag.close) {
      for (let n = stack.length - 1; n >= 0; n--) {
        if (stack[n]!.name !== tag.name) continue;
        for (const done of stack.splice(n)) {
          if (done.kind === 'word' && word && lineWords) {
            const text = word.text.replace(/\s+/g, ' ').trim();
            if (text) lineWords.push({ text, box: word.box, conf: word.conf });
            word = undefined;
          } else if (done.kind === 'line' && lineWords && page) {
            if (lineWords.length) page.lines.push({ words: lineWords });
            lineWords = undefined;
          }
        }
        break;
      }
      continue;
    }
    const cls = (tag.attrs.class ?? '').split(/\s+/);
    const title = tag.attrs.title ?? '';
    const bb = /\bbbox\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(title);
    const box: [number, number, number, number] = bb ? [Number(bb[1]), Number(bb[2]), Number(bb[3]), Number(bb[4])] : [0, 0, 0, 0];
    let kind: 'page' | 'line' | 'word' | '' = '';
    if (cls.includes('ocr_page')) {
      kind = 'page';
      const res = /\bscan_res\s+(\d+)/.exec(title);
      page = { id: opts.id ?? `page-${pages.length + 1}`, width: box[2], height: box[3], dpi: res ? Number(res[1]) : (opts.dpi ?? 300), lines: [] };
      pages.push(page);
    } else if (cls.includes('ocr_line') || cls.includes('ocr_textfloat') || cls.includes('ocr_header') || cls.includes('ocr_caption')) {
      kind = 'line';
      if (!page) throw new OcrInputRefused('a line outside any page');
      lineWords = [];
    } else if (cls.includes('ocrx_word') || cls.includes('ocr_word')) {
      kind = 'word';
      if (!lineWords) {
        if (!page) throw new OcrInputRefused('a word outside any page');
        lineWords = [];
      }
      const wc = /\bx_wconf\s+(-?\d+(?:\.\d+)?)/.exec(title);
      word = { box, conf: wc ? clamp(Number(wc[1]), 0, 100) : 0, text: '' };
    }
    if (!tag.selfClosing && !VOID.has(tag.name)) stack.push({ name: tag.name, kind });
  }
  if (!pages.length) throw new OcrInputRefused('no ocr_page found');
  return pages.map((p) => ({ ...p, unit: 'pixel' as const }));
}

/** Read ALTO XML into pages; confidences (WC, 0 to 1) become 0 to 100. */
export function parseAlto(xml: string, opts: { dpi?: number } = {}): OcrPage[] {
  const toks = tokenize(xml, true);
  let unit: Unit = 'pixel';
  let inUnit = false;
  const pages: { id: string; width: number; height: number; unit: Unit; dpi: number; lines: Line[] }[] = [];
  let page: (typeof pages)[number] | undefined;
  let line: Word[] | undefined;
  let pending: string[] = [];
  for (const k of toks) {
    if (k.t === 'text') {
      if (inUnit) pending.push(k.s.trim());
      continue;
    }
    const { tag } = k;
    if (tag.name === 'MeasurementUnit') {
      if (tag.close) {
        const u = pending.join('');
        if (u === 'pixel' || u === 'mm10' || u === 'inch1200') unit = u;
        else throw new OcrInputRefused(`unknown MeasurementUnit ${u}`);
        inUnit = false;
        pending = [];
      } else inUnit = true;
    } else if (tag.name === 'Page' && !tag.close) {
      const w = num(tag.attrs.WIDTH);
      const h = num(tag.attrs.HEIGHT);
      if (w === undefined || h === undefined) throw new OcrInputRefused('a Page without WIDTH and HEIGHT');
      page = { id: tag.attrs.ID ?? `page-${pages.length + 1}`, width: w, height: h, unit, dpi: opts.dpi ?? 300, lines: [] };
      pages.push(page);
    } else if (tag.name === 'TextLine') {
      if (tag.close) {
        if (line?.length && page) page.lines.push({ words: line });
        line = undefined;
      } else line = [];
    } else if (tag.name === 'String' && !tag.close) {
      if (!line) throw new OcrInputRefused('a String outside a TextLine');
      const [x, y, w, h] = [num(tag.attrs.HPOS), num(tag.attrs.VPOS), num(tag.attrs.WIDTH), num(tag.attrs.HEIGHT)];
      const text = (tag.attrs.CONTENT ?? '').trim();
      if (x === undefined || y === undefined || w === undefined || h === undefined) throw new OcrInputRefused('a String without a box');
      const wc = num(tag.attrs.WC);
      if (text) line.push({ text, box: [x, y, x + w, y + h], conf: wc === undefined ? 0 : clamp(wc * 100, 0, 100) });
    }
  }
  if (!pages.length) throw new OcrInputRefused('no Page found');
  return pages;
}

// ---------------------------------------------------------------------------------------------------- confidence

export interface Thresholds {
  /** At or above: kept as is. */
  readonly accept: number;
  /** At or above (and below accept): kept but marked for review. Below: dropped from the text layer. */
  readonly review: number;
  /** A page whose character-weighted mean confidence is below this goes to a person. */
  readonly pageMin: number;
  /** A page where more than this fraction of words is below accept goes to a person. */
  readonly maxLowFraction: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { accept: 80, review: 60, pageMin: 75, maxLowFraction: 0.25 };

export type WordGrade = 'accepted' | 'review' | 'dropped';
export const gradeWord = (w: Word, t: Thresholds = DEFAULT_THRESHOLDS): WordGrade => (w.conf >= t.accept ? 'accepted' : w.conf >= t.review ? 'review' : 'dropped');

export interface PageVerdict {
  readonly id: string;
  readonly words: number;
  readonly accepted: number;
  readonly review: number;
  readonly dropped: number;
  readonly meanConf: number;
  readonly needsPerson: boolean;
  readonly reasons: readonly string[];
}

export function judgePage(p: OcrPage, t: Thresholds = DEFAULT_THRESHOLDS): PageVerdict {
  const ws = p.lines.flatMap((l) => l.words);
  const g = { accepted: 0, review: 0, dropped: 0 };
  let weight = 0;
  let acc = 0;
  for (const w of ws) {
    g[gradeWord(w, t)]++;
    weight += w.text.length;
    acc += w.conf * w.text.length;
  }
  const mean = weight ? Math.round((acc / weight) * 100) / 100 : 0;
  const reasons: string[] = [];
  if (!ws.length) reasons.push('no text was found');
  else {
    if (mean < t.pageMin) reasons.push(`mean confidence ${mean} is below ${t.pageMin}`);
    const low = (g.review + g.dropped) / ws.length;
    if (low > t.maxLowFraction) reasons.push(`${Math.round(low * 100)}% of words are below ${t.accept}`);
  }
  return { id: p.id, words: ws.length, ...g, meanConf: mean, needsPerson: reasons.length > 0, reasons };
}

/** The page's text, one line per line, with dropped words omitted unless asked for. */
export const pageText = (p: OcrPage, t: Thresholds = DEFAULT_THRESHOLDS, keepDropped = false): string =>
  p.lines
    .map((l) => l.words.filter((w) => keepDropped || gradeWord(w, t) !== 'dropped').map((w) => w.text).join(' '))
    .filter((s) => s.length)
    .join('\n');

// ---------------------------------------------------------------------------------------------------- providers

export interface PageImage {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly dpi?: number;
}
export interface Recognised {
  readonly format: 'hocr' | 'alto';
  readonly body: string;
}
export interface OcrProvider {
  recognize(image: PageImage, o: { lang: string }): Promise<Recognised>;
}

/** The argument list for the tesseract command line, reading an image on stdin and writing hOCR on stdout. */
export function tesseractArgs(lang: string, dpi?: number): string[] {
  if (!/^[a-z]{3}(?:_[A-Za-z]+)?(?:\+[a-z]{3}(?:_[A-Za-z]+)?)*$/.test(lang)) throw new RangeError(`not a tesseract language list: ${lang}`);
  return ['stdin', 'stdout', '-l', lang, ...(dpi ? ['--dpi', String(Math.round(dpi))] : []), 'hocr'];
}

/** A scripted engine: each image id has an answer; it can fail a set number of times first. The same interface as a real engine. */
export class TwinOcr implements OcrProvider {
  readonly calls: { id: string; lang: string }[] = [];
  private readonly script: ReadonlyMap<string, Recognised>;
  private readonly failures: Map<string, number>;
  constructor(script: Readonly<Record<string, Recognised>>, failFirst: Readonly<Record<string, number>> = {}) {
    this.script = new Map(Object.entries(script));
    this.failures = new Map(Object.entries(failFirst));
  }
  async recognize(image: PageImage, o: { lang: string }): Promise<Recognised> {
    this.calls.push({ id: image.id, lang: o.lang });
    const left = this.failures.get(image.id) ?? 0;
    if (left > 0) {
      this.failures.set(image.id, left - 1);
      throw new Error('engine busy');
    }
    const r = this.script.get(image.id);
    if (!r) throw new Error(`no scripted answer for ${image.id}`);
    return r;
  }
}

export interface RunOptions {
  readonly lang?: string;
  readonly retries?: number;
  readonly thresholds?: Thresholds;
}
export interface PageResult {
  readonly id: string;
  readonly ok: boolean;
  readonly attempts: number;
  readonly page?: OcrPage;
  readonly verdict?: PageVerdict;
  readonly error?: string;
}
export interface RunResult {
  readonly pages: readonly PageResult[];
  readonly needingPerson: readonly string[];
  readonly failed: readonly string[];
}

/** Run every page through the provider, in order, retrying a failing page up to `retries` times; one bad page never stops the rest. */
export async function runOcr(provider: OcrProvider, images: readonly PageImage[], o: RunOptions = {}): Promise<RunResult> {
  const retries = o.retries ?? 2;
  const out: PageResult[] = [];
  for (const img of images) {
    let attempts = 0;
    let lastError = '';
    let done: PageResult | undefined;
    while (attempts <= retries && !done) {
      attempts++;
      try {
        const r = await provider.recognize(img, { lang: o.lang ?? 'eng' });
        const pages = r.format === 'hocr' ? parseHocr(r.body, { ...(img.dpi ? { dpi: img.dpi } : {}), id: img.id }) : parseAlto(r.body, img.dpi ? { dpi: img.dpi } : {});
        const page = { ...pages[0]!, id: img.id };
        done = { id: img.id, ok: true, attempts, page, verdict: judgePage(page, o.thresholds) };
      } catch (e) {
        lastError = (e as Error).message;
        if (e instanceof OcrInputRefused) break;
      }
    }
    out.push(done ?? { id: img.id, ok: false, attempts, error: lastError });
  }
  return { pages: out, needingPerson: out.filter((p) => p.ok && p.verdict!.needsPerson).map((p) => p.id), failed: out.filter((p) => !p.ok).map((p) => p.id) };
}

// ---------------------------------------------------------------------------------------------------- PDF plan

/** Helvetica advance widths for ASCII 32 to 126, in 1/1000 em (Adobe core font metrics). */
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Width of text in Helvetica at a size, in points; characters outside ASCII count as an average one. */
export function helveticaWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    w += c >= 32 && c <= 126 ? HELV[c - 32]! : 556;
  }
  return (w * size) / 1000;
}

const pointsPer = (p: OcrPage): number => (p.unit === 'pixel' ? 72 / p.dpi : p.unit === 'mm10' ? 72 / 254 : 72 / 1200);

export interface LayerWord {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /** Horizontal scaling in percent (Tz) that stretches the word to its box. */
  readonly scale: number;
  readonly review: boolean;
}
export interface LayerPage {
  readonly id: string;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly words: readonly LayerWord[];
  readonly skipped: number;
}
export interface PdfTextPlan {
  readonly font: 'Helvetica';
  readonly pages: readonly LayerPage[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Where each word goes on a PDF page, in points, origin bottom left. The font size is the box height over 0.95 so
 * ascenders and descenders fit; the baseline sits 20% of the height above the box bottom; scaling makes the word's
 * Helvetica width equal its box width. Dropped words are left out and counted.
 */
export function planTextLayer(pages: readonly OcrPage[], t: Thresholds = DEFAULT_THRESHOLDS): PdfTextPlan {
  return {
    font: 'Helvetica',
    pages: pages.map((p) => {
      const k = pointsPer(p);
      const H = p.height * k;
      let skipped = 0;
      const words: LayerWord[] = [];
      for (const l of p.lines)
        for (const w of l.words) {
          const g = gradeWord(w, t);
          const boxW = (w.box[2] - w.box[0]) * k;
          const boxH = (w.box[3] - w.box[1]) * k;
          if (g === 'dropped' || boxW <= 0 || boxH <= 0) {
            skipped++;
            continue;
          }
          const size = boxH / 0.95;
          const natural = helveticaWidth(w.text, size);
          words.push({ text: w.text, x: r2(w.box[0] * k), y: r2(H - w.box[3] * k + 0.2 * boxH), fontSize: r2(size), scale: natural > 0 ? r2(clamp((boxW / natural) * 100, 10, 400)) : 100, review: g === 'review' });
        }
      return { id: p.id, widthPt: r2(p.width * k), heightPt: r2(H), words, skipped };
    }),
  };
}

/** A PDF string literal in WinAnsi: parentheses and backslash escaped, other bytes octal, characters it cannot hold become "?". */
export function pdfString(s: string): { literal: string; lossy: boolean } {
  let lossy = false;
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 0xa0 && c <= 0xff) out += `\\${c.toString(8).padStart(3, '0')}`;
    else {
      out += '?';
      lossy = true;
    }
  }
  return { literal: `(${out})`, lossy };
}

/** The content stream that draws a page's invisible text layer (render mode 3) over its image. */
export function contentStream(p: LayerPage, fontName = 'F1'): string {
  const out = ['BT', '3 Tr'];
  for (const w of p.words) out.push(`/${fontName} ${w.fontSize} Tf`, `${w.scale} Tz`, `1 0 0 1 ${w.x} ${w.y} Tm`, `${pdfString(w.text).literal} Tj`);
  out.push('ET');
  return out.join('\n');
}
