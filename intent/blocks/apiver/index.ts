/**
 * API versions by date, the way long-lived APIs keep old clients working. A client pins a version (by header, or
 * by its account's default); a request is answered at the latest version and then walked back through each change
 * newer than the pinned one, so every old shape is produced by a small, tested transform rather than by old code
 * kept alive. Deprecated versions answer with Deprecation and Sunset headers (RFC 9745, RFC 8594) and a link to the
 * notes (a version with only a sunset date gets the Sunset header); past sunset they are refused with a clear problem
 * response.
 */

export interface Change {
  /** The version that introduced it (YYYY-MM-DD). */
  readonly version: string;
  readonly description: string;
  /** Turns a response from this version's shape into the previous version's. */
  readonly down: (body: unknown, path: string) => unknown;
  readonly paths?: RegExp;
}

export interface Lifecycle {
  readonly version: string;
  readonly deprecated?: string;
  readonly sunset?: string;
}

export class Versions {
  readonly changes: readonly Change[];
  readonly latest: string;
  readonly known: readonly string[];
  private readonly life: Map<string, Lifecycle>;
  readonly notes: string;

  constructor(first: string, changes: readonly Change[], o: { lifecycle?: readonly Lifecycle[]; notes: string }) {
    this.changes = [...changes].sort((a, b) => a.version.localeCompare(b.version));
    this.known = [first, ...this.changes.map((c) => c.version)];
    if (new Set(this.known).size !== this.known.length) throw new Error('two changes share a version');
    this.latest = this.known.at(-1)!;
    const isDate = (d: string) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
    };
    for (const l of o.lifecycle ?? []) {
      if (!this.known.includes(l.version)) throw new Error(`${l.version} in the lifecycle is not a version`);
      for (const d of [l.deprecated, l.sunset]) if (d !== undefined && !isDate(d)) throw new Error(`${d} is not a date (YYYY-MM-DD)`);
    }
    this.life = new Map((o.lifecycle ?? []).map((l) => [l.version, l]));
    this.notes = o.notes;
  }

  /** The version to answer at: the header if given and known, else the account default, else the latest. */
  pick(header: string | undefined, accountDefault?: string): { version: string } | { problem: { status: 400; title: string; detail: string } } {
    const v = header?.trim() || accountDefault || this.latest;
    if (!this.known.includes(v)) return { problem: { status: 400, title: 'Unknown API version', detail: `${v} is not a version; known versions are ${this.known.join(', ')}` } };
    return { version: v };
  }

  /** Walks a latest-shape response back to the pinned version. */
  render(body: unknown, path: string, version: string): unknown {
    let b = body;
    for (const c of [...this.changes].reverse()) {
      if (c.version <= version) break;
      if (!c.paths || c.paths.test(path)) b = c.down(b, path);
    }
    return b;
  }

  /** Headers for an answer at this version, or a problem if it is past its sunset. */
  headers(version: string, today: string): { headers: Record<string, string> } | { problem: { status: 410; title: string; detail: string } } {
    const l = this.life.get(version);
    const h: Record<string, string> = { 'api-version': version };
    if (!l?.deprecated && !l?.sunset) return { headers: h };
    if (l.sunset && today >= l.sunset) return { problem: { status: 410, title: 'API version retired', detail: `${version} was retired on ${l.sunset}; move to ${this.latest} (${this.notes})` } };
    if (l.deprecated) h.deprecation = `@${Math.floor(Date.parse(`${l.deprecated}T00:00:00Z`) / 1000)}`;
    if (l.sunset) h.sunset = new Date(`${l.sunset}T00:00:00Z`).toUTCString();
    h.link = `<${this.notes}>; rel="${l.deprecated ? 'deprecation' : 'sunset'}"; type="text/html"`;
    return { headers: h };
  }

  /** Who still calls deprecated versions, from request counts: the list to contact before a sunset. */
  stragglers(calls: readonly { account: string; version: string }[]): Record<string, string[]> {
    const out: Record<string, Set<string>> = {};
    for (const c of calls) if (this.life.get(c.version)?.deprecated) (out[c.version] ??= new Set()).add(c.account);
    return Object.fromEntries(Object.entries(out).map(([v, s]) => [v, [...s].sort()]));
  }
}
