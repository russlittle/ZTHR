/**
 * User-agent reading for analytics and logs: browser and engine, operating system, device class, and whether the
 * client is a bot (with its name and kind), from an ordered rule table that is data, not code, and carries a
 * version so a result can say which table read it. Client hints (Sec-CH-UA, Sec-CH-UA-Platform, -Platform-Version,
 * -Mobile, -Model and -Full-Version-List, which are RFC 8941 structured fields) are parsed and, when present,
 * outrank the user-agent string, because the string is frozen or reduced by modern browsers (Windows always says
 * "10.0"; Windows 11 is told only by a platform version of 13 or more).
 *
 * Safe by construction: input is cut at 2048 characters before any rule runs, every rule is a plain regular
 * expression without nested repetition, and nothing here executes or evaluates the string. The result never
 * claims what it could not read: unknown is "unknown", not a guess.
 *
 * Out of scope: bot verification by reverse DNS or published IP ranges (a user-agent is only a claim), and
 * device databases beyond the model strings the agent itself carries.
 */

export const RULES_VERSION = '2026.11';
export const MAX_UA_LENGTH = 2048;

export type DeviceType = 'desktop' | 'mobile' | 'tablet' | 'tv' | 'console' | 'wearable' | 'bot' | 'unknown';
export type BotKind = 'search' | 'social' | 'ai' | 'seo' | 'monitor' | 'headless' | 'library' | 'crawler';

export interface Browser {
  readonly name: string;
  readonly version: string | null;
  readonly major: number | null;
  readonly engine: string | null;
}

export interface Os {
  readonly name: string;
  readonly version: string | null;
}

export interface Device {
  readonly type: DeviceType;
  readonly vendor: string | null;
  readonly model: string | null;
}

export interface BotInfo {
  readonly name: string;
  readonly kind: BotKind;
}

export interface Parsed {
  readonly browser: Browser;
  readonly os: Os;
  readonly device: Device;
  readonly bot: BotInfo | null;
  readonly truncated: boolean;
  readonly rules: string;
  /** Which of the three answers came from client hints. */
  readonly fromHints: readonly ('browser' | 'os' | 'device')[];
}

// ---------------------------------------------------------------- the rule table

interface Rule {
  readonly name: string;
  readonly re: RegExp;
  readonly engine?: string;
}

/** Order matters: the first rule that matches wins, so the specific browsers come before the ones they pretend to be. */
export const BROWSERS: readonly Rule[] = [
  { name: 'Edge', re: /\b(?:Edg|EdgA|EdgiOS)\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Edge', re: /\bEdge\/(\d+(?:\.\d+)*)/, engine: 'EdgeHTML' },
  { name: 'Opera', re: /\b(?:OPR|OPiOS)\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Opera Mini', re: /\bOpera Mini\/(\d+(?:\.\d+)*)/, engine: 'Presto' },
  { name: 'Samsung Internet', re: /\bSamsungBrowser\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Vivaldi', re: /\bVivaldi\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Yandex Browser', re: /\bYaBrowser\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'UC Browser', re: /\bUCBrowser\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'DuckDuckGo', re: /\bDuckDuckGo\/(\d+(?:\.\d+)*)/ },
  { name: 'Firefox', re: /\b(?:Firefox|FxiOS)\/(\d+(?:\.\d+)*)/, engine: 'Gecko' },
  { name: 'Facebook App', re: /\bFBAV\/(\d+(?:\.\d+)*)/ },
  { name: 'Instagram', re: /\bInstagram (\d+(?:\.\d+)*)/ },
  { name: 'Android WebView', re: /; wv\)[^]*?\bChrome\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Chrome', re: /\b(?:Chrome|CriOS)\/(\d+(?:\.\d+)*)/, engine: 'Blink' },
  { name: 'Safari', re: /\bVersion\/(\d+(?:\.\d+)*)[^]*?\bSafari\//, engine: 'WebKit' },
  { name: 'Internet Explorer', re: /\bMSIE (\d+(?:\.\d+)*)/, engine: 'Trident' },
  { name: 'Internet Explorer', re: /\bTrident\/[\d.]+[^]*?\brv:(\d+(?:\.\d+)*)/, engine: 'Trident' },
];

interface OsRule {
  readonly name: string;
  readonly re: RegExp;
  readonly version?: (m: RegExpExecArray) => string | null;
}

const dots = (s: string | undefined) => (s ? s.replace(/_/g, '.') : null);
const WINDOWS: Readonly<Record<string, string>> = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.2': 'XP', '5.1': 'XP', '5.0': '2000' };

export const SYSTEMS: readonly OsRule[] = [
  { name: 'Windows Phone', re: /\bWindows Phone (?:OS )?(\d+(?:\.\d+)*)/, version: (m) => m[1] ?? null },
  { name: 'Windows', re: /\bWindows NT (\d+\.\d+)/, version: (m) => (Object.hasOwn(WINDOWS, m[1]!) ? WINDOWS[m[1]!]! : m[1]!) },
  { name: 'iOS', re: /\b(?:iPhone|iPad|iPod)\b[^)]*?\bOS (\d+(?:_\d+)*)/, version: (m) => dots(m[1]) },
  { name: 'iOS', re: /\bCPU OS (\d+(?:_\d+)*) like Mac OS X/, version: (m) => dots(m[1]) },
  { name: 'Android', re: /\bAndroid[ /](\d+(?:\.\d+)*)/, version: (m) => m[1] ?? null },
  { name: 'Android', re: /\bAndroid\b/ },
  { name: 'ChromeOS', re: /\bCrOS [^ ]+ (\d+(?:\.\d+)*)/, version: (m) => m[1] ?? null },
  { name: 'macOS', re: /\bMac OS X (\d+(?:[._]\d+)*)/, version: (m) => dots(m[1]) },
  { name: 'Tizen', re: /\bTizen[ /](\d+(?:\.\d+)*)/, version: (m) => m[1] ?? null },
  { name: 'KaiOS', re: /\bKaiOS\/(\d+(?:\.\d+)*)/, version: (m) => m[1] ?? null },
  { name: 'webOS', re: /\b(?:Web0S|webOS)[;/ ]/ },
  { name: 'PlayStation', re: /\bPlayStation[ ;]/ },
  { name: 'Xbox', re: /\bXbox\b/ },
  { name: 'Linux', re: /\b(?:Linux|X11|Ubuntu|Fedora|Debian)\b/ },
];

interface BotRule {
  readonly name: string;
  readonly kind: BotKind;
  readonly re: RegExp;
}

/** Declared crawlers, tools and libraries. Matching is on the token the operator publishes for its robot. */
export const BOTS: readonly BotRule[] = [
  { name: 'Googlebot', kind: 'search', re: /\bGooglebot(?:-\w+)?\b/ },
  { name: 'Google-InspectionTool', kind: 'search', re: /\bGoogle-InspectionTool\b/ },
  { name: 'AdsBot-Google', kind: 'search', re: /\bAdsBot-Google/ },
  { name: 'bingbot', kind: 'search', re: /\b(?:bingbot|BingPreview)\b/i },
  { name: 'Yahoo Slurp', kind: 'search', re: /\bSlurp\b/ },
  { name: 'DuckDuckBot', kind: 'search', re: /\bDuckDuckBot\b/ },
  { name: 'Baiduspider', kind: 'search', re: /\bBaiduspider\b/ },
  { name: 'YandexBot', kind: 'search', re: /\bYandex(?:Bot|Images|Metrika)\b/ },
  { name: 'Applebot', kind: 'search', re: /\bApplebot\b/ },
  { name: 'GPTBot', kind: 'ai', re: /\b(?:GPTBot|OAI-SearchBot|ChatGPT-User)\b/ },
  { name: 'ClaudeBot', kind: 'ai', re: /\b(?:ClaudeBot|Claude-Web|anthropic-ai)\b/ },
  { name: 'PerplexityBot', kind: 'ai', re: /\bPerplexity(?:Bot|-User)\b/ },
  { name: 'CCBot', kind: 'ai', re: /\bCCBot\b/ },
  { name: 'Bytespider', kind: 'ai', re: /\bBytespider\b/ },
  { name: 'Google-Extended', kind: 'ai', re: /\bGoogle-Extended\b/ },
  { name: 'facebookexternalhit', kind: 'social', re: /\b(?:facebookexternalhit|Facebot)\b/ },
  { name: 'Twitterbot', kind: 'social', re: /\bTwitterbot\b/ },
  { name: 'LinkedInBot', kind: 'social', re: /\bLinkedInBot\b/ },
  { name: 'Slackbot', kind: 'social', re: /\bSlack(?:bot|-ImgProxy)\b/ },
  { name: 'Discordbot', kind: 'social', re: /\bDiscordbot\b/ },
  { name: 'WhatsApp', kind: 'social', re: /^WhatsApp\// },
  { name: 'TelegramBot', kind: 'social', re: /\bTelegramBot\b/ },
  { name: 'AhrefsBot', kind: 'seo', re: /\bAhrefs(?:Bot|SiteAudit)\b/ },
  { name: 'SemrushBot', kind: 'seo', re: /\bSemrushBot\b/ },
  { name: 'MJ12bot', kind: 'seo', re: /\bMJ12bot\b/ },
  { name: 'DotBot', kind: 'seo', re: /\bDotBot\b/ },
  { name: 'Screaming Frog', kind: 'seo', re: /\bScreaming Frog SEO Spider\b/ },
  { name: 'UptimeRobot', kind: 'monitor', re: /\bUptimeRobot\b/ },
  { name: 'Pingdom', kind: 'monitor', re: /\bPingdom\b/ },
  { name: 'Uptime Kuma', kind: 'monitor', re: /\bUptime-Kuma\b/ },
  { name: 'Lighthouse', kind: 'monitor', re: /\bChrome-Lighthouse\b/ },
  { name: 'HeadlessChrome', kind: 'headless', re: /\bHeadlessChrome\b/ },
  { name: 'PhantomJS', kind: 'headless', re: /\bPhantomJS\b/ },
  { name: 'Puppeteer', kind: 'headless', re: /\bPuppeteer\b/ },
  { name: 'curl', kind: 'library', re: /^curl\// },
  { name: 'Wget', kind: 'library', re: /^Wget\// },
  { name: 'python-requests', kind: 'library', re: /^python-requests\// },
  { name: 'python-urllib', kind: 'library', re: /^Python-urllib\// },
  { name: 'aiohttp', kind: 'library', re: /^Python\/[\d.]+ aiohttp\// },
  { name: 'Go-http-client', kind: 'library', re: /^Go-http-client\// },
  { name: 'okhttp', kind: 'library', re: /^okhttp\// },
  { name: 'Java', kind: 'library', re: /^Java\/\d/ },
  { name: 'Apache-HttpClient', kind: 'library', re: /^Apache-HttpClient\// },
  { name: 'node-fetch', kind: 'library', re: /^(?:node-fetch|undici|axios)\b/ },
  { name: 'libwww-perl', kind: 'library', re: /^libwww-perl\// },
  { name: 'Scrapy', kind: 'library', re: /\bScrapy\// },
];

const GENERIC_CRAWLER = /\b(?:bot|crawl(?:er)?|spider|scraper|fetcher)\b/i;

// ---------------------------------------------------------------- user-agent reading

const major = (v: string | null): number | null => {
  const n = v === null ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

export function detectBot(ua: string): BotInfo | null {
  for (const b of BOTS) if (b.re.test(ua)) return { name: b.name, kind: b.kind };
  if (GENERIC_CRAWLER.test(ua)) return { name: 'unidentified crawler', kind: 'crawler' };
  return null;
}

function readBrowser(ua: string): Browser {
  for (const r of BROWSERS) {
    const m = r.re.exec(ua);
    if (m) return { name: r.name, version: m[1] ?? null, major: major(m[1] ?? null), engine: r.engine ?? null };
  }
  if (/\bAppleWebKit\//.test(ua) && /\b(?:iPhone|iPad|iPod)\b/.test(ua) && !/\bSafari\//.test(ua)) return { name: 'WebKit WebView', version: null, major: null, engine: 'WebKit' };
  const gecko = /\bGecko\/\d/.test(ua) && /\brv:(\d+(?:\.\d+)*)/.exec(ua);
  if (gecko) return { name: 'Gecko browser', version: gecko[1] ?? null, major: major(gecko[1] ?? null), engine: 'Gecko' };
  return { name: 'unknown', version: null, major: null, engine: null };
}

function readOs(ua: string): Os {
  // iPadOS 13 and later says "Macintosh" with a touch-capable Safari; the string alone cannot tell, so it stays macOS here
  // and client hints or the caller's touch-point count decide (see `withTouch`).
  for (const r of SYSTEMS) {
    const m = r.re.exec(ua);
    if (m) return { name: r.name, version: r.version ? r.version(m) : null };
  }
  return { name: 'unknown', version: null };
}

const KNOWN_VENDORS: readonly [RegExp, string][] = [
  [/^(?:SAMSUNG |SM-|GT-)/i, 'Samsung'],
  [/^Pixel\b/, 'Google'],
  [/^(?:Redmi|Mi |M\d{4}|POCO|2\d{6}[A-Z]+)/i, 'Xiaomi'],
  [/^(?:HUAWEI|HONOR|[A-Z]{3}-L\d\d)/i, 'Huawei'],
  [/^(?:moto|XT\d{4})/i, 'Motorola'],
  [/^(?:OnePlus|[A-Z]{2}\d{4}$)/, 'OnePlus'],
  [/^(?:CPH|RMX)\d+/, 'OPPO'],
  [/^(?:Kindle|KF[A-Z]{2,4}|AFT[A-Z]*)\b/, 'Amazon'],
];

function readDevice(ua: string, os: Os): Device {
  let vendor: string | null = null;
  let model: string | null = null;
  const apple = /\b(iPhone|iPad|iPod)\b/.exec(ua);
  if (apple) {
    vendor = 'Apple';
    model = apple[1]!;
  } else if (/\bMacintosh\b/.test(ua)) vendor = 'Apple';
  else if (os.name === 'Android') {
    const m = /\bAndroid [\d.]+;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/.exec(ua);
    const raw = m?.[1]?.trim() ?? '';
    if (raw && raw !== 'K' && raw !== 'Mobile' && !/^wv$/i.test(raw)) {
      const hit = KNOWN_VENDORS.find(([re]) => re.test(raw));
      vendor = hit ? hit[1] : null;
      model = raw.replace(/^SAMSUNG /i, '');
    }
  }
  const type = ((): DeviceType => {
    if (/\b(?:PlayStation|Xbox|Nintendo)\b/.test(ua)) return 'console';
    if (/\b(?:SMART-?TV|SmartTV|HbbTV|Web0S|webOS|AppleTV|Roku|CrKey|GoogleTV|Android TV|BRAVIA|AFT[A-Z]*)\b/i.test(ua) || /\bTizen\b[^)]*\bTV\b|\bTV\b[^)]*Safari/.test(ua)) return 'tv';
    if (/\b(?:Watch|Wear OS|SM-R\d{3})\b/.test(ua)) return 'wearable';
    if (/\b(?:iPad|Tablet|Kindle|Silk|PlayBook)\b/.test(ua)) return 'tablet';
    if (/\bAndroid\b/.test(ua)) return /\bMobile\b/.test(ua) ? 'mobile' : 'tablet';
    if (/\b(?:iPhone|iPod|Windows Phone|KaiOS|Opera Mini|IEMobile)\b/.test(ua) || /\bMobile\b/.test(ua)) return 'mobile';
    if (os.name === 'unknown') return 'unknown';
    return 'desktop';
  })();
  return { type, vendor, model };
}

/** Reads a user-agent string alone. */
export function parseUserAgent(input: string): Parsed {
  const truncated = input.length > MAX_UA_LENGTH;
  const ua = truncated ? input.slice(0, MAX_UA_LENGTH) : input;
  const bot = detectBot(ua);
  const browser = readBrowser(ua);
  const os = readOs(ua);
  const device = bot ? { type: 'bot' as const, vendor: null, model: null } : readDevice(ua, os);
  return { browser, os, device, bot, truncated, rules: RULES_VERSION, fromHints: [] };
}

// ---------------------------------------------------------------- client hints

export interface Brand {
  readonly brand: string;
  readonly version: string;
}

/** The request headers a browser sends when the server asks, as received (names lower case, values as sent). */
export interface Hints {
  readonly 'sec-ch-ua'?: string;
  readonly 'sec-ch-ua-full-version-list'?: string;
  readonly 'sec-ch-ua-mobile'?: string;
  readonly 'sec-ch-ua-platform'?: string;
  readonly 'sec-ch-ua-platform-version'?: string;
  readonly 'sec-ch-ua-model'?: string;
}

/** What to send in Accept-CH so the browser will send the high-entropy hints this block uses. */
export const ACCEPT_CH = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model';

/** An RFC 8941 string item: `"text"`, with `\"` and `\\` escapes. Returns the text and the rest after it, or null. */
function readString(s: string, from: number): { value: string; end: number } | null {
  if (s[from] !== '"') return null;
  let out = '';
  for (let i = from + 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[i + 1];
      if (n !== '"' && n !== '\\') return null;
      out += n;
      i++;
    } else if (c === '"') return { value: out, end: i + 1 };
    else out += c;
  }
  return null;
}

/** A structured-field string (`"Chrome"` or `?1`) as plain text; null if it is not one. */
export function sfString(v: string | undefined): string | null {
  if (v === undefined) return null;
  const s = v.trim();
  const r = readString(s, 0);
  return r && r.end === s.length ? r.value : null;
}

export function sfBoolean(v: string | undefined): boolean | null {
  const s = v?.trim();
  return s === '?1' ? true : s === '?0' ? false : null;
}

/** `"Chromium";v="124", "Not-A.Brand";v="99"` as brands. Malformed members are dropped, never guessed at. */
export function parseBrands(header: string | undefined): Brand[] {
  if (!header || header.length > 1024) return [];
  const out: Brand[] = [];
  let i = 0;
  while (i < header.length) {
    while (header[i] === ' ' || header[i] === ',') i++;
    const name = readString(header, i);
    if (!name) {
      const next = header.indexOf(',', i);
      if (next < 0) break;
      i = next + 1;
      continue;
    }
    i = name.end;
    while (header[i] === ' ') i++;
    if (i < header.length && header[i] !== ',' && header[i] !== ';') {
      const next = header.indexOf(',', i);
      if (next < 0) break;
      i = next + 1;
      continue;
    }
    let version = '';
    while (i < header.length && header[i] !== ',') {
      if (header[i] === ';') {
        const m = /^;\s*v=/.exec(header.slice(i));
        if (m) {
          const v = readString(header, i + m[0].length);
          if (v) {
            version = v.value;
            i = v.end;
            continue;
          }
        }
      }
      i++;
    }
    out.push({ brand: name.value, version });
  }
  return out;
}

const GREASE = /not[^a-z]*a[^a-z]*brand|^not[;)(]|^\s*$/i;
const BRAND_NAMES: Readonly<Record<string, string>> = { 'google chrome': 'Chrome', 'microsoft edge': 'Edge', opera: 'Opera', brave: 'Brave', 'samsung internet': 'Samsung Internet', vivaldi: 'Vivaldi', 'android webview': 'Android WebView', chromium: 'Chromium' };

/** The real brand among the brands a browser lists: not the GREASE entry, and a named browser before the engine "Chromium". */
export function pickBrand(brands: readonly Brand[]): Brand | null {
  const real = brands.filter((b) => !GREASE.test(b.brand));
  return real.find((b) => b.brand.toLowerCase() !== 'chromium') ?? real[0] ?? null;
}

const PLATFORMS: Readonly<Record<string, string>> = { windows: 'Windows', macos: 'macOS', android: 'Android', 'chrome os': 'ChromeOS', chromeos: 'ChromeOS', linux: 'Linux', ios: 'iOS' };

/** Reads a user-agent with the client hints that came with it; hints win where they say something. */
export function parse(userAgent: string, hints: Hints = {}): Parsed {
  const base = parseUserAgent(userAgent);
  const fromHints: ('browser' | 'os' | 'device')[] = [];
  let browser = base.browser;
  let os = base.os;
  let device = base.device;

  const list = parseBrands(hints['sec-ch-ua-full-version-list']);
  const pick = pickBrand(list.length ? list : parseBrands(hints['sec-ch-ua']));
  if (pick) {
    const name = BRAND_NAMES[pick.brand.toLowerCase()] ?? pick.brand;
    const keepName = name === 'Chromium' && base.browser.name !== 'unknown' && base.browser.engine === 'Blink';
    if (!keepName) {
      browser = { name, version: pick.version || null, major: major(pick.version || null), engine: base.browser.engine ?? 'Blink' };
      fromHints.push('browser');
    } else if (pick.version && base.browser.name === 'Chrome') {
      browser = { ...base.browser, version: pick.version, major: major(pick.version) };
    }
  }

  const platform = sfString(hints['sec-ch-ua-platform']);
  if (platform) {
    const name = PLATFORMS[platform.toLowerCase()] ?? platform;
    const v = sfString(hints['sec-ch-ua-platform-version']);
    let version: string | null = v && v.length <= 32 ? v : null;
    if (name === 'Windows' && version) version = (major(version) ?? 0) >= 13 ? '11' : '10';
    else if (name === 'Windows') version = base.os.name === 'Windows' ? base.os.version : null;
    os = { name, version };
    fromHints.push('os');
  }

  if (!base.bot) {
    const mobile = sfBoolean(hints['sec-ch-ua-mobile']);
    const model = sfString(hints['sec-ch-ua-model']);
    if (mobile !== null || model) {
      const type: DeviceType = mobile === true ? (device.type === 'tablet' ? 'tablet' : 'mobile') : mobile === false && device.type === 'mobile' ? 'desktop' : device.type;
      device = { type, vendor: device.vendor, model: model && model.length <= 64 ? model : device.model };
      fromHints.push('device');
    }
  }
  return { ...base, browser, os, device, fromHints };
}

/** An iPad that says "Macintosh": a touch screen on a Mac user-agent means iPadOS. The caller passes navigator.maxTouchPoints. */
export function withTouch(p: Parsed, maxTouchPoints: number): Parsed {
  if (p.os.name !== 'macOS' || p.browser.name !== 'Safari' || maxTouchPoints < 2) return p;
  return { ...p, os: { name: 'iPadOS', version: null }, device: { type: 'tablet', vendor: 'Apple', model: 'iPad' } };
}

/** A one-line label for reports: "Chrome 124 on Windows 11 (desktop)". */
export function describe(p: Parsed): string {
  if (p.bot) return `${p.bot.name} (${p.bot.kind} bot)`;
  const b = p.browser.name === 'unknown' ? 'Unknown browser' : `${p.browser.name}${p.browser.major !== null ? ` ${p.browser.major}` : ''}`;
  const o = p.os.name === 'unknown' ? 'unknown system' : `${p.os.name}${p.os.version ? ` ${p.os.version}` : ''}`;
  return `${b} on ${o} (${p.device.type})`;
}
