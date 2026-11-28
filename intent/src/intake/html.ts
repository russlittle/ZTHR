/**
 * HTML into markdown, so a page (a Claude artifact, an exported doc, a wiki page) is read by the same parsers
 * as everything else. Deterministic and dependency-free: headings, lists, paragraphs, code and tables carry
 * over; scripts, styles and navigation chrome are dropped; nothing is inferred.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', middot: '·', copy: '©' };

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const isHtml = (path: string, text: string): boolean => /\.x?html?$/i.test(path) || /^\s*(<!doctype html|<html[\s>])/i.test(text);

/** Inline markup to markdown marks, tags removed. */
function inline(s: string): string {
  return decode(
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/\r\n?/g, '\n');
  const out: string[] = [];
  const push = (line = '') => out.push(line);

  // Code blocks and tables first, held aside so nothing inside them is reflowed or treated as markup.
  const codes: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => {
    const lang = /class="[^"]*language-([\w-]+)/i.exec(body)?.[1] ?? '';
    codes.push(`\n\`\`\`${lang}\n${decode(body.replace(/<[^>]+>/g, '')).replace(/^\n|\n$/g, '')}\n\`\`\`\n`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Tables: each row a pipe row.
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, body: string) => {
    const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...(r[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1] ?? '').replace(/\|/g, '\\|')));
    if (!rows.length) return '';
    const head = rows[0]!;
    const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)];
    codes.push(`\n${lines.join('\n')}\n`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Block elements become lines; list items keep their kind and depth.
  const depth: ('ul' | 'ol')[] = [];
  const counters: number[] = [];
  const tokens = s.split(/(<\/?(?:h[1-6]|p|div|section|article|header|main|li|ul|ol|blockquote|tr|br|hr)\b[^>]*>)/i);
  let buf = '';
  let pending: string | null = null;
  const flush = () => {
    const t = inline(buf);
    buf = '';
    if (!t && pending === null) return;
    if (pending !== null) {
      if (t) push(`${pending}${t}`);
      pending = null;
    } else if (t) {
      push(t);
      push();
    }
  };
  for (const tok of tokens) {
    const m = /^<(\/?)(h[1-6]|p|div|section|article|header|main|li|ul|ol|blockquote|tr|br|hr)\b/i.exec(tok);
    if (!m) {
      buf += tok;
      continue;
    }
    const close = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      flush();
      if (close) {
        depth.pop();
        counters.pop();
        if (!depth.length) push();
      } else {
        depth.push(tag);
        counters.push(0);
      }
    } else if (tag === 'li') {
      flush();
      if (!close) {
        const k = depth.length - 1;
        const indent = '  '.repeat(Math.max(0, k));
        if (depth[k] === 'ol') counters[k] = (counters[k] ?? 0) + 1;
        pending = `${indent}${depth[k] === 'ol' ? `${counters[k]}. ` : '- '}`;
      }
    } else if (/^h[1-6]$/.test(tag)) {
      flush();
      if (!close) pending = `${'#'.repeat(Number(tag[1]))} `;
      else push();
    } else flush();
  }
  flush();
  return out
    .join('\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}
