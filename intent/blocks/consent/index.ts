/**
 * Terms and consent, by version. Each document (terms of service, privacy notice, a marketing permission) has
 * versions; a person's agreement is recorded against one version, with when and how it was given, and never
 * overwritten: withdrawing is a new record. A new version marked as needing agreement makes everyone on an older
 * one due to agree again; an optional consent (marketing) defaults to no and can be withdrawn as easily as given.
 */

export interface DocVersion {
  readonly doc: string;
  readonly version: number;
  readonly effective: string;
  /** Whether people on older versions must agree again before carrying on. */
  readonly requiresAgreement: boolean;
  readonly required: boolean;
  readonly summary: string;
}

export interface Record_ {
  readonly who: string;
  readonly doc: string;
  readonly version: number;
  readonly given: boolean;
  readonly at: string;
  /** Where it was given: "sign-up form", "settings", "banner". */
  readonly how: string;
}

export class Consent {
  private readonly versions: DocVersion[] = [];
  private readonly records: Record_[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  publish(v: DocVersion): void {
    const last = this.latest(v.doc);
    if (last && v.version <= last.version) throw new Error(`${v.doc} is already at version ${last.version}`);
    this.versions.push(v);
  }

  latest(doc: string): DocVersion | undefined {
    const today = this.now().toISOString().slice(0, 10);
    return this.versions.filter((v) => v.doc === doc && v.effective <= today).sort((a, b) => b.version - a.version)[0];
  }

  private record(who: string, doc: string, given: boolean, how: string): Record_ {
    const v = this.latest(doc);
    if (!v) throw new Error(`no version of ${doc} is in effect`);
    if (!given && v.required) throw new Error(`${doc} is required to use the service; closing the account is the way to withdraw`);
    const r: Record_ = { who, doc, version: v.version, given, at: this.now().toISOString(), how };
    this.records.push(r);
    return r;
  }

  agree(who: string, doc: string, how: string): Record_ {
    return this.record(who, doc, true, how);
  }

  withdraw(who: string, doc: string, how: string): Record_ {
    return this.record(who, doc, false, how);
  }

  /** Where the person stands on a document: the last thing they said, and whether it is still current. */
  standing(who: string, doc: string): { given: boolean; version?: number; current: boolean } {
    const last = this.records.filter((r) => r.who === who && r.doc === doc).at(-1);
    if (!last || !last.given) return { given: false, ...(last ? { version: last.version } : {}), current: false };
    const newer = this.versions.filter((v) => v.doc === doc && v.version > last.version && v.requiresAgreement && v.effective <= this.now().toISOString().slice(0, 10));
    return { given: true, version: last.version, current: newer.length === 0 };
  }

  allowed(who: string, doc: string): boolean {
    const s = this.standing(who, doc);
    return s.given && s.current;
  }

  /** The documents this person must agree to before carrying on. */
  due(who: string): DocVersion[] {
    const docs = new Set(this.versions.map((v) => v.doc));
    return [...docs].map((d) => this.latest(d)).filter((v): v is DocVersion => !!v && v.required && !this.allowed(who, v.doc));
  }

  history(who: string): readonly Record_[] {
    return this.records.filter((r) => r.who === who);
  }
}
