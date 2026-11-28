/**
 * PDF documents without a dependency: headings, paragraphs that wrap, tables with a repeated header row, and page
 * numbers, laid out on A4 or Letter in the standard Helvetica fonts (so no font is embedded), with real text a
 * reader can search and copy. Each page and object is written by hand to PDF 1.7 with a correct cross-reference
 * table; text is escaped and limited to WinAnsi, so a stray character cannot break the file.
 */

/** A heading, a paragraph, a table, or vertical space in points (zero or more: a negative space is refused). */
export type Block = { readonly h: string } | { readonly p: string } | { readonly table: readonly (readonly string[])[]; readonly widths?: readonly number[] } | { readonly space: number };

export interface PdfOptions {
  readonly title: string;
  readonly author?: string;
  readonly size?: 'A4' | 'Letter';
  readonly footer?: (page: number, pages: number) => string;
}

/** Helvetica advance widths (per 1000 em) for printable ASCII 32..126. */
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Text width in points; bold is approximated as 6% wider. */
export function width(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? W[c - 32]! : 556;
  }
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

/** Keeps characters Helvetica can show (WinAnsi Latin-1); others become "?". */
export const winAnsi = (s: string) => s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^ -~ -ÿ]/g, '?');

const esc = (s: string) => winAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`);

export function wrap(text: string, size: number, max: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (width(tryLine, size, bold) <= max) line = tryLine;
      else {
        if (line) out.push(line);
        let w = word;
        while (width(w, size, bold) > max) {
          let i = w.length;
          while (i > 1 && width(w.slice(0, i), size, bold) > max) i--;
          out.push(w.slice(0, i));
          w = w.slice(i);
        }
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export function pdf(blocks: readonly Block[], o: PdfOptions): Buffer {
  const [pw, ph] = o.size === 'Letter' ? [612, 792] : [595.28, 841.89];
  const margin = 56;
  const usable = pw - margin * 2;
  const pages: string[][] = [[]];
  let y = ph - margin;
  const page = () => pages.at(-1)!;
  const newPage = () => {
    pages.push([]);
    y = ph - margin;
  };
  const need = (h: number) => {
    if (y - h < margin + 24) newPage();
  };
  const text = (s: string, x: number, size: number, bold = false) => page().push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  for (const b of blocks) {
    if ('space' in b) {
      if (!(b.space >= 0) || !Number.isFinite(b.space)) throw new Error(`a space block must be zero or more points, not ${b.space}`);
      y -= b.space;
    } else if ('h' in b) {
      // A heading starts on a fresh page rather than split; one taller than a page continues line by line.
      const lines = wrap(b.h, 16, usable, true);
      need(lines.length * 20 + 8);
      y -= 4;
      for (const l of lines) {
        need(18);
        y -= 18;
        text(l, margin, 16, true);
      }
      y -= 8;
    } else if ('p' in b) {
      for (const l of wrap(b.p, 11, usable)) {
        need(15);
        y -= 15;
        text(l, margin, 11);
      }
      y -= 6;
    } else {
      if (!b.table.length) continue;
      const cols = b.table.reduce((m, r) => Math.max(m, r.length), 0);
      const ws = b.widths ?? Array(cols).fill(1);
      const sum = ws.reduce((a, c) => a + c, 0);
      const cw = ws.map((w) => (w / sum) * usable);
      const floor = margin + 24;
      const [head, ...rows] = b.table;
      const lineCount = (r: readonly string[], bold: boolean) => cw.reduce((m, w, i) => Math.max(m, wrap(r[i] ?? '', 10, w - 8, bold).length), 1);
      // The header repeats on each new page unless it would take most of the page itself.
      const repeatHead = !!head && lineCount(head, true) * 13 + 6 < (ph - margin - floor) / 3;
      const drawRow = (r: readonly string[], bold: boolean, isHead: boolean) => {
        const cells = cw.map((w, i) => wrap(r[i] ?? '', 10, w - 8, bold));
        const lines = cells.reduce((m, c) => Math.max(m, c.length), 1);
        // A row taller than the room left continues on the next page, below the repeated header.
        for (let from = 0; from < lines; ) {
          const room = Math.floor((y - 6 - floor) / 13);
          if (room < 1) {
            newPage();
            if (!isHead && repeatHead) drawRow(head!, true, true);
            continue;
          }
          const n = Math.min(room, lines - from);
          const top = y;
          let x = margin;
          cells.forEach((c, i) => {
            y = top - 3;
            for (const l of c.slice(from, from + n)) {
              y -= 13;
              text(l, x + 4, 10, bold);
            }
            x += cw[i]!;
          });
          y = top - n * 13 - 6;
          page().push(`0.6 w ${margin} ${y.toFixed(2)} m ${(margin + usable).toFixed(2)} ${y.toFixed(2)} l S`);
          from += n;
        }
      };
      need(40);
      if (head) drawRow(head, true, true);
      for (const r of rows) {
        const est = lineCount(r, false) * 13 + 6;
        // Start a row that fits on a page on a fresh page rather than splitting it.
        if (y - est < floor && est <= ph - margin - floor - 40) {
          newPage();
          if (repeatHead) drawRow(head!, true, true);
        }
        drawRow(r, false, false);
      }
      y -= 10;
    }
  }
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((ops, i) => {
    const foot = o.footer ? o.footer(i + 1, pages.length) : `${i + 1} of ${pages.length}`;
    const all = [...ops, `BT /F1 9 Tf ${(pw / 2 - width(foot, 9) / 2).toFixed(2)} ${(margin / 2).toFixed(2)} Td (${esc(foot)}) Tj ET`].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(all, 'latin1')} >>\nstream\n${all}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Lang (en) >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(o.title)})${o.author ? ` /Author (${esc(o.author)})` : ''} /Producer (zthr pdf) >>`);
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
