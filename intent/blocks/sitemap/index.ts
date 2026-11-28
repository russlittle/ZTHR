/**
 * Public pages that search engines and link previews read correctly: one page description renders the title,
 * description, canonical URL, Open Graph and Twitter card tags, and JSON-LD, all escaped; a check reports missing
 * or overlong titles and descriptions, duplicate titles, and relative canonical URLs. The sitemap lists only pages
 * marked public and indexable, splits past 50,000 URLs or 50 MB into an index, and robots.txt points at it. A
 * path that would send the canonical URL or a sitemap entry to another site is refused.
 */

export interface Page {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly image?: string;
  readonly updated?: string;
  readonly public: boolean;
  readonly noindex?: boolean;
  readonly jsonLd?: Readonly<Record<string, unknown>>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const xesc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The page's absolute URL; a path such as "//other.example/x" that would leave the origin is refused. */
function pageUrl(path: string, origin: string): string {
  const base = new URL(origin);
  const u = new URL(path, base);
  if (u.origin !== base.origin || !path.startsWith('/') || path.startsWith('//')) throw new Error(`${path} would point at another site`);
  return u.href;
}

/** W3C Datetime, as the sitemap protocol requires for lastmod: YYYY, YYYY-MM, YYYY-MM-DD, or a full timestamp. */
const W3C_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?)?)?$/;

/** The protocol's limits for one sitemap file: 50,000 URLs and 50 MB uncompressed. */
const MAX_BYTES = 50 * 1024 * 1024;

export function head(p: Page, origin: string, site: string): string {
  const url = pageUrl(p.path, origin);
  const tags = [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    p.noindex || !p.public ? '<meta name="robots" content="noindex">' : '',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(site)}">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    p.image ? `<meta property="og:image" content="${esc(new URL(p.image, origin).href)}">` : '',
    `<meta name="twitter:card" content="${p.image ? 'summary_large_image' : 'summary'}">`,
    p.jsonLd ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...p.jsonLd }).replace(/</g, '\\u003c')}</script>` : '',
  ];
  return tags.filter(Boolean).join('\n');
}

export function check(pages: readonly Page[]): string[] {
  const out: string[] = [];
  const titles = new Map<string, string>();
  for (const p of pages.filter((x) => x.public && !x.noindex)) {
    if (!p.path.startsWith('/') || p.path.startsWith('//')) out.push(`${p.path}: the path must start with a single / and stay on this site`);
    if (p.updated !== undefined && !W3C_DATE.test(p.updated)) out.push(`${p.path}: updated is not a W3C date (YYYY-MM-DD or a full timestamp)`);
    if (!p.title.trim()) out.push(`${p.path}: no title`);
    else if (p.title.length > 60) out.push(`${p.path}: the title is ${p.title.length} characters; search results cut it near 60`);
    if (!p.description.trim()) out.push(`${p.path}: no description`);
    else if (p.description.length > 160) out.push(`${p.path}: the description is ${p.description.length} characters; keep it under 160`);
    const seen = titles.get(p.title);
    if (seen) out.push(`${p.path}: same title as ${seen}`);
    else titles.set(p.title, p.path);
  }
  return out;
}

/**
 * One sitemap, or an index of several when there are more than `per` URLs or one file would pass 50 MB. A lastmod
 * that is not a W3C date is left out (check reports it). Paths sort by code unit, so output is the same everywhere.
 */
export function sitemaps(pages: readonly Page[], origin: string, per = 50_000): { path: string; xml: string }[] {
  if (!(per >= 1)) throw new Error('a sitemap must hold at least one URL');
  const urls = pages.filter((p) => p.public && !p.noindex).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries = urls.map((p) => `<url><loc>${xesc(pageUrl(p.path, origin))}</loc>${p.updated && W3C_DATE.test(p.updated) ? `<lastmod>${p.updated}</lastmod>` : ''}</url>`);
  const top = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  const tail = '\n</urlset>\n';
  const groups: string[][] = [[]];
  let bytes = Buffer.byteLength(top + tail);
  for (const e of entries) {
    const n = Buffer.byteLength(e) + 1;
    const g = groups.at(-1)!;
    if (g.length && (g.length >= per || bytes + n > MAX_BYTES)) {
      groups.push([e]);
      bytes = Buffer.byteLength(top + tail) + n;
    } else {
      g.push(e);
      bytes += n;
    }
  }
  const body = (list: readonly string[]) => `${top}${list.join('\n')}${tail}`;
  if (groups.length === 1) return [{ path: '/sitemap.xml', xml: body(groups[0]!) }];
  const parts = groups.map((g, i) => ({ path: `/sitemap-${i + 1}.xml`, xml: body(g) }));
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.map((p) => `<sitemap><loc>${xesc(new URL(p.path, origin).href)}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;
  return [{ path: '/sitemap.xml', xml: index }, ...parts];
}

export const robots = (origin: string, disallow: readonly string[] = []) => `User-agent: *\n${disallow.map((d) => `Disallow: ${d}`).join('\n')}${disallow.length ? '\n' : ''}Sitemap: ${new URL('/sitemap.xml', origin).href}\n`;
