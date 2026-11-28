/**
 * An allow-list HTML sanitiser: markup from people or from other systems is read by a tolerant tokenizer
 * (HTML5 rules for tags, attributes, comments, raw text and unfinished input) and written again from scratch, so
 * what comes out is built only from what the policy names and cannot be re-read by a browser as anything else.
 * Tags not on the list are unwrapped (their text stays); dangerous containers (script, style, iframe, object,
 * embed, template, svg, math, noscript, form controls and the like) are removed with everything inside. Attributes
 * are kept only when listed for their tag; event handlers, srcdoc, formaction, srcset, id and name (DOM
 * clobbering) are never kept. URL attributes are decoded and cleaned the way a browser would before the scheme is
 * checked (entities, tabs, newlines, control characters, backslashes), then must use an allowed scheme or be a
 * plain relative address; protocol-relative addresses are refused unless allowed; data: URLs are limited to small
 * base64 PNG, JPEG, GIF and WebP images on img. Links get rel="noopener noreferrer" (and nofollow, by choice) and
 * target is limited to _blank; images get no-referrer and lazy loading. Inline style is dropped, or filtered by an
 * allow-list of properties with strict values (no url(), expression(), escapes, comments or @rules). Output is
 * balanced, depth-limited and size-limited. Text extraction turns HTML into plain text with line breaks where
 * blocks end. Presets: PLAIN (text only), BASIC (comments and chat), RICH (articles and email). Not here: CSS
 * sanitising of whole style sheets, SVG or MathML (removed), and rewriting of external image URLs to a proxy.
 */

export class TooLarge extends Error {}

export interface Policy {
  /** Allowed tags with the attributes each may keep. */
  readonly tags: Readonly<Record<string, readonly string[]>>;
  /** Attributes any allowed tag may keep. */
  readonly globalAttrs?: readonly string[];
  /** Schemes by URL attribute: href, src, cite. */
  readonly schemes?: Readonly<Record<string, readonly string[]>>;
  /** Plain relative addresses (/path, ./x, ?q, #top) are allowed. Default true. */
  readonly allowRelative?: boolean;
  /** //host addresses are allowed. Default false. */
  readonly allowProtocolRelative?: boolean;
  /** Small base64 images in img src. Default false. */
  readonly allowDataImages?: boolean;
  readonly maxDataImageBytes?: number;
  /** Add rel="nofollow" to links. */
  readonly nofollow?: boolean;
  /** Let target="_blank" stand (with noopener); otherwise target is removed. */
  readonly allowBlank?: boolean;
  /** Properties allowed in style attributes; none (the default) drops style altogether. */
  readonly styleProperties?: readonly string[];
  /** Class names allowed (exact or prefix*); none means class is dropped. */
  readonly classes?: readonly string[];
  readonly maxInput?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

const COMMON = ['title', 'lang', 'dir'];

export const PLAIN: Policy = { tags: {} };

export const BASIC: Policy = {
  tags: { a: ['href', 'title'], b: [], strong: [], i: [], em: [], u: [], s: [], del: [], code: [], pre: [], p: [], br: [], blockquote: ['cite'], ul: [], ol: ['start'], li: [] },
  globalAttrs: [],
  schemes: { href: ['http', 'https', 'mailto'], cite: ['http', 'https'] },
  nofollow: true,
};

export const RICH: Policy = {
  tags: {
    a: ['href', 'title', 'target'], img: ['src', 'alt', 'title', 'width', 'height'], b: [], strong: [], i: [], em: [], u: [], s: [], del: [], ins: [], mark: [], sub: [], sup: [], small: [], abbr: ['title'], code: [], pre: [], kbd: [], samp: [], var: [],
    p: [], br: [], hr: [], div: [], span: [], blockquote: ['cite'], q: ['cite'], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ['start', 'reversed', 'type'], li: ['value'], dl: [], dt: [], dd: [],
    table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan', 'scope'], td: ['colspan', 'rowspan'], figure: [], figcaption: [], details: ['open'], summary: [], time: ['datetime'], cite: [],
  },
  globalAttrs: COMMON,
  schemes: { href: ['http', 'https', 'mailto', 'tel'], src: ['http', 'https'], cite: ['http', 'https'] },
  allowBlank: true,
  nofollow: false,
};

const VOID = new Set(['br', 'hr', 'img', 'wbr']);
/** Elements with no content or end tag, whether or not they are allowed. */
const NO_CONTENT = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Containers removed with all their content, in any policy. */
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'svg', 'math', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'textarea', 'title', 'select', 'option', 'head', 'audio', 'video', 'canvas', 'button', 'input', 'form', 'fieldset', 'datalist', 'dialog', 'portal', 'meta', 'link', 'base']);
/** Content of these is raw text up to the matching end tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const BLOCK = new Set(['p', 'div', 'br', 'hr', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tr', 'caption', 'figure', 'figcaption', 'details', 'summary', 'section', 'article', 'header', 'footer', 'nav', 'aside']);
const NEVER_ATTR = /^(on|xmlns|formaction$|srcdoc$|srcset$|ping$|id$|name$|style$|class$|http-equiv$|data-|xlink:|autofocus$|contenteditable$|draggable$|accesskey$|tabindex$|is$|slot$|popover|nonce$)/;
const URL_ATTRS = new Set(['href', 'src', 'cite']);

// ---------------------------------------------------------------- entities

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', laquo: '\u00ab', raquo: '\u00bb', sect: '\u00a7', para: '\u00b6', colon: ':', Tab: '\t', NewLine: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\', num: '#', excl: '!', quest: '?', semi: ';', comma: ',', period: '.', equals: '=', percnt: '%', lbrack: '[', rbrack: ']', lowbar: '_', grave: '`', commat: '@', dollar: '$', ast: '*', plus: '+', hyphen: '-',
};

/** Decodes character references: decimal, hex, and the common named ones. Unknown names stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(cp);
    }
    if (name !== undefined && Object.hasOwn(NAMED, name) && (m.endsWith(';') || ['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'].includes(name))) return NAMED[name]!;
    return m;
  });
}

export const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');

// ---------------------------------------------------------------- URLs and styles

/**
 * Whether a URL may be used where `schemes` apply: its scheme (after the cleaning a browser does) is listed, or
 * it is a plain relative address. Returns the cleaned URL to output, or null.
 */
export function cleanUrl(raw: string, o: { schemes: readonly string[]; allowRelative?: boolean; allowProtocolRelative?: boolean; dataImages?: boolean; maxDataBytes?: number }): string | null {
  // Browsers drop tabs and newlines anywhere in a URL, trim control characters and spaces at both ends, and read \ as /.
  // eslint-disable-next-line no-control-regex
  const TRIM = new RegExp('^[\\u0000-\\u0020\\u007f-\\u009f\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+|[\\u0000-\\u0020\\u007f-\\u009f\\u00a0\\u1680\\u2000-\\u200f\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+$', 'g');
  let u = decodeEntities(raw).replace(/[\t\n\r]/g, '').replace(TRIM, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(u) || u.length > 8192) return null;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(u);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (scheme === 'data') {
      const d = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(u);
      if (!o.dataImages || !d) return null;
      if (Math.floor((d[2]!.length * 3) / 4) > (o.maxDataBytes ?? 100_000)) return null;
      return u;
    }
    if (!o.schemes.includes(scheme)) return null;
    if ((scheme === 'http' || scheme === 'https') && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\\?#\s]+/.test(u.replace(/\\/g, '/'))) return null;
    return u;
  }
  const norm = u.replace(/\\/g, '/');
  if (norm.startsWith('//')) return o.allowProtocolRelative ? u : null;
  if (o.allowRelative === false) return null;
  // A first path segment with a colon would read as a scheme ("a:b"); that was handled above, so only odd cases remain.
  if (/^[^/?#]*:/.test(norm)) return null;
  return u;
}

const STYLE_VALUE = /^[A-Za-z0-9#%.,()+\- "']*$/;
const STYLE_BAD = /url\s*\(|expression|javascript|vbscript|behaviou?r|binding|@import|\\|\/\*|!\s*important/i;

/** Keeps only the listed properties, with plain values; returns the cleaned declarations or null when none remain. */
export function cleanStyle(raw: string, allowed: readonly string[]): string | null {
  const out: string[] = [];
  for (const decl of decodeEntities(raw).split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!allowed.includes(prop) || !val || val.length > 100 || STYLE_BAD.test(val) || !STYLE_VALUE.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.length ? out.join('; ') : null;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'start'; readonly name: string; readonly attrs: readonly (readonly [string, string])[]; readonly selfClosing: boolean }
  | { readonly t: 'end'; readonly name: string };

const WS = /[\t\n\f\r ]/;

function* tokenize(src: string): Generator<Token> {
  let i = 0;
  const n = src.length;
  let text = '';
  function* flush(): Generator<Token> {
    if (text) {
      yield { t: 'text', v: text };
      text = '';
    }
  }
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      text += src.slice(i);
      break;
    }
    text += src.slice(i, lt);
    i = lt;
    const c = src[i + 1] ?? '';
    if (c === '!' || c === '?') {
      // Comment, doctype, CDATA, processing instruction: all dropped. A comment ends at --> (or --!>); the others at >.
      if (src.startsWith('<!--', i)) {
        let e = src.indexOf('-->', i + 4);
        const e2 = src.indexOf('--!>', i + 4);
        let len = 3;
        if (e2 >= 0 && (e < 0 || e2 < e)) {
          e = e2;
          len = 4;
        }
        if (src.startsWith('<!-->', i)) {
          i += 5;
          continue;
        }
        if (src.startsWith('<!--->', i)) {
          i += 6;
          continue;
        }
        i = e < 0 ? n : e + len;
      } else {
        const e = src.indexOf('>', i + 2);
        i = e < 0 ? n : e + 1;
      }
      continue;
    }
    if (c === '/') {
      if (!/[A-Za-z]/.test(src[i + 2] ?? '')) {
        // "</" then something that is not a name is a bogus comment.
        const e = src.indexOf('>', i + 2);
        i = e < 0 ? n : e + 1;
        continue;
      }
      let j = i + 2;
      while (j < n && !WS.test(src[j]!) && src[j] !== '/' && src[j] !== '>') j++;
      const name = src.slice(i + 2, j).toLowerCase();
      // Attributes on an end tag are read and ignored.
      const r = readAttrs(src, j);
      yield* flush();
      if (r.eof) {
        i = n;
        break;
      }
      yield { t: 'end', name };
      i = r.end;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && !WS.test(src[j]!) && src[j] !== '/' && src[j] !== '>') j++;
      const name = src.slice(i + 1, j).toLowerCase();
      const r = readAttrs(src, j);
      yield* flush();
      if (r.eof) {
        // An unfinished tag at the end of input is discarded, never emitted.
        i = n;
        break;
      }
      yield { t: 'start', name, attrs: r.attrs, selfClosing: r.selfClosing };
      i = r.end;
      if (RAW_TEXT.has(name)) {
        if (name === 'plaintext') {
          i = n;
          break;
        }
        const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'i');
        const m = re.exec(src.slice(i));
        if (!m) {
          i = n;
          break;
        }
        i += m.index;
      }
      continue;
    }
    // A "<" that starts nothing is just a less-than sign.
    text += '<';
    i++;
  }
  yield* flush();
}

function readAttrs(src: string, from: number): { attrs: [string, string][]; end: number; selfClosing: boolean; eof: boolean } {
  const attrs: [string, string][] = [];
  const seen = new Set<string>();
  let i = from;
  const n = src.length;
  let selfClosing = false;
  for (;;) {
    while (i < n && (WS.test(src[i]!) || src[i] === '/')) {
      if (src[i] === '/' && src[i + 1] === '>') selfClosing = true;
      i++;
    }
    if (i >= n) return { attrs, end: n, selfClosing, eof: true };
    if (src[i] === '>') return { attrs, end: i + 1, selfClosing, eof: false };
    let j = i;
    // The first character of a name may be "=" (a quirk); after that a name ends at space, "/", ">" or "=".
    j++;
    while (j < n && !WS.test(src[j]!) && src[j] !== '/' && src[j] !== '>' && src[j] !== '=') j++;
    const name = src.slice(i, j).toLowerCase();
    i = j;
    while (i < n && WS.test(src[i]!)) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < n && WS.test(src[i]!)) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const e = src.indexOf(q, i + 1);
        if (e < 0) return { attrs, end: n, selfClosing, eof: true };
        value = src.slice(i + 1, e);
        i = e + 1;
      } else {
        let k = i;
        while (k < n && !WS.test(src[k]!) && src[k] !== '>') k++;
        value = src.slice(i, k);
        i = k;
      }
    }
    // The first of two equal attribute names wins, as in a browser.
    if (!seen.has(name)) {
      seen.add(name);
      attrs.push([name, decodeEntities(value)]);
    }
  }
}

// ---------------------------------------------------------------- the sanitiser

/** Cleans markup under a policy. The result is safe to place in an HTML element's content. */
export function sanitize(html: string, policy: Policy = BASIC): string {
  const maxInput = policy.maxInput ?? 1_000_000;
  if (html.length > maxInput) throw new TooLarge(`the input is ${html.length} characters; the limit is ${maxInput}`);
  const maxDepth = policy.maxDepth ?? 32;
  const maxNodes = policy.maxNodes ?? 20_000;
  // eslint-disable-next-line no-control-regex
  const src = html.replace(/\u0000/g, '\ufffd').replace(/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/g, '');
  const out: string[] = [];
  const stack: string[] = [];
  let skipping: string | null = null;
  let skipDepth = 0;
  let nodes = 0;
  const allowedTag = (n: string) => Object.hasOwn(policy.tags, n) && !DROP_CONTENT.has(n);
  const closeTo = (name: string) => {
    while (stack.length) {
      const top = stack.pop()!;
      if (!VOID.has(top)) out.push(`</${top}>`);
      if (top === name) break;
    }
  };
  for (const tok of tokenize(src)) {
    if (skipping) {
      // Inside a removed container: count same-named nesting until its end tag.
      if (tok.t === 'start' && tok.name === skipping && !tok.selfClosing && !RAW_TEXT.has(skipping)) skipDepth++;
      else if (tok.t === 'end' && tok.name === skipping && --skipDepth === 0) skipping = null;
      continue;
    }
    if (tok.t === 'text') {
      if (++nodes > maxNodes) throw new TooLarge(`more than ${maxNodes} nodes`);
      out.push(escapeText(decodeEntities(tok.v)));
      continue;
    }
    if (tok.t === 'start') {
      if (DROP_CONTENT.has(tok.name)) {
        if (!NO_CONTENT.has(tok.name) && !tok.selfClosing) {
          skipping = tok.name;
          skipDepth = 1;
        }
        continue;
      }
      if (!allowedTag(tok.name)) continue;
      if (++nodes > maxNodes) throw new TooLarge(`more than ${maxNodes} nodes`);
      if (stack.length >= maxDepth && !VOID.has(tok.name)) continue;
      const allowed = new Set([...(policy.tags[tok.name] ?? []), ...(policy.globalAttrs ?? [])]);
      const kept: string[] = [];
      let href: string | undefined;
      let blank = false;
      let hasSrc = false;
      for (const [k, v] of tok.attrs) {
        if (!/^[a-z][a-z0-9:_-]*$/.test(k)) continue;
        if (k === 'class' && policy.classes) {
          const ok = v.split(/\s+/).filter((c) => /^[A-Za-z0-9_-]+$/.test(c) && policy.classes!.some((p) => (p.endsWith('*') ? c.startsWith(p.slice(0, -1)) : c === p)));
          if (ok.length) kept.push(`class="${escapeAttr(ok.join(' '))}"`);
          continue;
        }
        if (k === 'style' && policy.styleProperties && allowed.has('style')) {
          const s = cleanStyle(v, policy.styleProperties);
          if (s) kept.push(`style="${escapeAttr(s)}"`);
          continue;
        }
        if (NEVER_ATTR.test(k) || !allowed.has(k)) continue;
        if (URL_ATTRS.has(k)) {
          const u = cleanUrl(v, { schemes: policy.schemes?.[k] ?? [], allowRelative: policy.allowRelative ?? true, allowProtocolRelative: policy.allowProtocolRelative ?? false, dataImages: k === 'src' && tok.name === 'img' && !!policy.allowDataImages, ...(policy.maxDataImageBytes ? { maxDataBytes: policy.maxDataImageBytes } : {}) });
          if (u === null) continue;
          if (k === 'href') href = u;
          if (k === 'src') hasSrc = true;
          kept.push(`${k}="${escapeAttr(u)}"`);
          continue;
        }
        if (k === 'target') {
          if (v.toLowerCase() === '_blank' && policy.allowBlank) blank = true;
          continue;
        }
        if (k === 'width' || k === 'height' || k === 'colspan' || k === 'rowspan' || k === 'start' || k === 'value') {
          if (/^\d{1,5}$/.test(v.trim())) kept.push(`${k}="${v.trim()}"`);
          continue;
        }
        if (k === 'dir') {
          if (/^(ltr|rtl|auto)$/i.test(v)) kept.push(`dir="${v.toLowerCase()}"`);
          continue;
        }
        if (k === 'open' || k === 'reversed') {
          kept.push(k);
          continue;
        }
        if (k === 'type' || k === 'scope') {
          if (/^[A-Za-z0-9]{1,10}$/.test(v)) kept.push(`${k}="${v}"`);
          continue;
        }
        kept.push(`${k}="${escapeAttr(v.slice(0, 2000))}"`);
      }
      if (tok.name === 'img' && !hasSrc) continue;
      if (tok.name === 'a') {
        if (href !== undefined || kept.some((a) => a.startsWith('href='))) {
          const rel = ['noopener', 'noreferrer', ...(policy.nofollow ? ['nofollow'] : [])].join(' ');
          kept.push(`rel="${rel}"`);
          if (blank) kept.push('target="_blank"');
        }
      }
      if (tok.name === 'img') kept.push('loading="lazy"', 'referrerpolicy="no-referrer"');
      out.push(`<${tok.name}${kept.length ? ' ' + kept.join(' ') : ''}>`);
      if (!VOID.has(tok.name)) stack.push(tok.name);
      continue;
    }
    // An end tag closes the matching open element and anything left open inside it; a stray one is ignored.
    if (allowedTag(tok.name) && !VOID.has(tok.name) && stack.includes(tok.name)) closeTo(tok.name);
  }
  closeTo('');
  return out.join('');
}

// ---------------------------------------------------------------- text

/** Plain text from HTML: scripts and styles dropped, entities decoded, a line break where a block ends. */
export function toText(html: string, o: { maxLength?: number; links?: boolean } = {}): string {
  const maxInput = 1_000_000;
  if (html.length > maxInput) throw new TooLarge(`the input is ${html.length} characters; the limit is ${maxInput}`);
  // eslint-disable-next-line no-control-regex
  const src = html.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/g, '');
  let out = '';
  let skipping: string | null = null;
  let skipDepth = 0;
  const hrefs: (string | null)[] = [];
  const brk = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  for (const tok of tokenize(src)) {
    if (skipping) {
      if (tok.t === 'start' && tok.name === skipping && !RAW_TEXT.has(skipping)) skipDepth++;
      else if (tok.t === 'end' && tok.name === skipping && --skipDepth === 0) skipping = null;
      continue;
    }
    if (tok.t === 'text') out += decodeEntities(tok.v).replace(/[ \t\r\n\f]+/g, ' ');
    else if (tok.t === 'start') {
      if (DROP_CONTENT.has(tok.name) && !['meta', 'link', 'base', 'input', 'button', 'form', 'select', 'option', 'fieldset', 'datalist', 'dialog', 'audio', 'video', 'canvas'].includes(tok.name)) {
        skipping = tok.name;
        skipDepth = 1;
        continue;
      }
      if (BLOCK.has(tok.name)) brk();
      if (tok.name === 'li') out += '- ';
      if (tok.name === 'a' && o.links) {
        const h = tok.attrs.find(([k]) => k === 'href')?.[1];
        hrefs.push(h !== undefined ? cleanUrl(h, { schemes: ['http', 'https', 'mailto', 'tel'] }) : null);
      } else if (tok.name === 'a') hrefs.push(null);
    } else {
      if (BLOCK.has(tok.name)) brk();
      if (tok.name === 'a') {
        const h = hrefs.pop();
        if (h && o.links) out += ` (${h})`;
      }
    }
  }
  const text = out
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const max = o.maxLength;
  return max !== undefined && text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026` : text;
}
