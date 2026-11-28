/**
 * A person's whole record, and leaving with it. Every part of the system that holds personal data registers a
 * source: how to export one person's data, how to erase it, and whether some must be kept (invoices for tax, an
 * audit trail) and for how long. An export gathers every source into one archive with a manifest a person can read
 * and machines can parse; an erasure runs every source and reports, source by source, what was removed and what was
 * kept and why, so nothing is quietly left behind and nothing is claimed that was not done.
 */
import { zip } from '../tabular/index.ts';

export interface Source {
  readonly name: string;
  readonly description: string;
  export(person: string): Promise<readonly Record<string, unknown>[]>;
  erase(person: string): Promise<{ removed: number; kept?: { count: number; why: string; until?: string } }>;
}

export interface Manifest {
  readonly person: string;
  readonly made: string;
  readonly sources: readonly { name: string; description: string; file: string; records: number; error?: string }[];
}

export interface Erasure {
  readonly person: string;
  readonly done: string;
  readonly complete: boolean;
  readonly sources: readonly { name: string; removed: number; kept?: { count: number; why: string; until?: string }; error?: string }[];
}

export class Privacy {
  private readonly sources = new Map<string, Source>();
  private readonly now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  register(s: Source): void {
    if (this.sources.has(s.name)) throw new Error(`${s.name} is already registered`);
    this.sources.set(s.name, s);
  }

  list(): { name: string; description: string }[] {
    return [...this.sources.values()].map((s) => ({ name: s.name, description: s.description }));
  }

  /** Everything about a person, as an archive: one JSON file per source (each its own name), a manifest, and a readable summary. */
  async export(person: string): Promise<{ archive: Buffer; manifest: Manifest }> {
    const files: { name: string; data: string }[] = [];
    const sources: Manifest['sources'][number][] = [];
    const used = new Set(['manifest.json', 'readme.txt']);
    for (const s of this.sources.values()) {
      const stem = s.name.replace(/[^a-z0-9-]+/gi, '-') || 'source';
      let file = `${stem}.json`;
      for (let n = 2; used.has(file.toLowerCase()); n++) file = `${stem}-${n}.json`;
      used.add(file.toLowerCase());
      try {
        const rows = await s.export(person);
        files.push({ name: file, data: JSON.stringify(rows, null, 2) });
        sources.push({ name: s.name, description: s.description, file, records: rows.length });
      } catch (e) {
        sources.push({ name: s.name, description: s.description, file, records: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const manifest: Manifest = { person, made: this.now().toISOString(), sources };
    const readme = [`Your data, exported ${manifest.made.slice(0, 10)}`, '', ...sources.map((s) => `- ${s.description}: ${s.error ? `could not be exported (${s.error}); ask us again and we will fix it` : `${s.records} record${s.records === 1 ? '' : 's'} in ${s.file}`}`), ''].join('\n');
    files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, { name: 'README.txt', data: readme });
    return { archive: zip(files), manifest };
  }

  /** Erases a person from every source; `complete` is true only when every source succeeded. */
  async erase(person: string): Promise<Erasure> {
    const sources: Erasure['sources'][number][] = [];
    for (const s of this.sources.values()) {
      try {
        const r = await s.erase(person);
        sources.push({ name: s.name, removed: r.removed, ...(r.kept ? { kept: r.kept } : {}) });
      } catch (e) {
        sources.push({ name: s.name, removed: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { person, done: this.now().toISOString(), complete: sources.every((s) => !s.error), sources };
  }
}

/** A source over an in-memory table, for tests and simple stores. */
export function tableSource(name: string, description: string, rows: Record<string, unknown>[], owner: string, keep?: { when: (r: Record<string, unknown>) => boolean; why: string; until?: string }): Source {
  return {
    name,
    description,
    async export(person) {
      return rows.filter((r) => r[owner] === person).map((r) => ({ ...r }));
    },
    async erase(person) {
      let removed = 0;
      let kept = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        if (r[owner] !== person) continue;
        if (keep?.when(r)) kept++;
        else rows.splice(i, 1), removed++;
      }
      return { removed, ...(kept && keep ? { kept: { count: kept, why: keep.why, ...(keep.until ? { until: keep.until } : {}) } } : {}) };
    },
  };
}
