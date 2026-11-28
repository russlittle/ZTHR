/**
 * Reads what metrology's calibration runs and the night shift have recorded in this repository into one snapshot,
 * for the docs' figures and for the metrology and maintenance pages (the site build writes it to
 * /maintenance/night.json). Nothing is inferred: a file that is not in a form read here is listed as unread.
 *
 *   eval/mutation/<block>.json               a calibration certificate: mutants, killed, survived, score, survivors
 *   eval/mutation/equivalent/<block>.json    equivalence rulings, each with its argument, claimant and judge
 *   eval/mutation/loop.log.jsonl             the loop's own log of rounds and attempts
 *   factory/queue/<station>/*.json           work orders; a surviving mutant's order is also its tag
 *   factory/queue/<station>/done/*.json      work orders accepted through the gates
 *   factory/shifts/*.json                    one shift log a night
 *   factory/runner.json                      { "live": true } once the crew's runner serves
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS } from '../src/console/crew.ts';
import type { BlockScore, Night, Ruling, ShiftLog, Tag, Task } from '../src/console/night.ts';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

const files = (dir: string): string[] => {
  const full = join(HERE, dir);
  if (!existsSync(full) || !statSync(full).isDirectory()) return [];
  return readdirSync(full, { recursive: true })
    .map(String)
    .filter((f) => /\.jsonl?$/.test(f))
    .sort()
    .map((f) => join(dir, f));
};

const records = (path: string): unknown[] | null => {
  try {
    const text = readFileSync(join(HERE, path), 'utf8');
    if (path.endsWith('.jsonl')) return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    const d = JSON.parse(text) as unknown;
    return Array.isArray(d) ? d : [d];
  } catch {
    return null;
  }
};

type R = Record<string, unknown>;
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isKind = (k: unknown) => KINDS.some((x) => x.key === k);

const STATION_OF_FOLDER: Record<string, Tag['station']> = { mutation: 'gauges', gauges: 'gauges', wear: 'wear', restore: 'restore', scrap: 'scrap', suspicion: 'suspicion' };

export function readNight(): Night {
  const unread: string[] = [];
  const tags: Tag[] = [];
  const tasks: Task[] = [];
  const shifts: ShiftLog[] = [];
  const rulings: Ruling[] = [];
  const latest = new Map<string, BlockScore>();

  // Rulings first: a block's recorded equivalents are the rulings a judge of another family accepted.
  for (const f of files('eval/mutation/equivalent')) {
    const d = records(f)?.[0] as R | undefined;
    const rs = d && Array.isArray(d['rulings']) ? (d['rulings'] as R[]) : null;
    if (!rs) {
      unread.push(f);
      continue;
    }
    for (const r of rs) {
      const m = (r['mutant'] ?? {}) as R;
      if (!str(r['block']) || !str(r['judge'])) continue;
      rulings.push({ id: `${r['block']}-${String(m['id'] ?? '')}`, block: r['block'], mutant: `${String(m['mutator'] ?? '')}: ${String(m['original'] ?? '')} → ${String(m['replacement'] ?? '')}`, claimant: str(r['by']) ? r['by'] : 'not recorded', judge: r['judge'], verdict: r['status'] === 'equivalent' ? 'equivalent' : 'not equivalent', reasoning: str(r['argument']) ? r['argument'] : '', at: str(r['at']) ? r['at'] : '' });
    }
  }

  for (const f of files('eval/mutation').filter((x) => !/[\\/](equivalent|\.incremental)[\\/]/.test(x))) {
    if (f.endsWith('loop.log.jsonl')) continue;
    const r = records(f)?.[0] as R | undefined;
    const block = r?.['block'];
    if (!r || !str(block) || num(r['score']) === null) {
      unread.push(f);
      continue;
    }
    const s: BlockScore = { block, at: str(r['ranAt']) ? r['ranAt'] : str(r['at']) ? r['at'] : '', score: num(r['score']), killed: (num(r['killed']) ?? 0) + (num(r['timeout']) ?? 0), survived: num(r['survived']) ?? (Array.isArray(r['survivors']) ? r['survivors'].length : 0), equivalent: rulings.filter((x) => x.block === block && x.verdict === 'equivalent').length, floor: num(r['floor']) };
    if (!latest.has(block) || latest.get(block)!.at <= s.at) latest.set(block, s);
  }

  for (const f of files('factory/queue')) {
    const r = records(f)?.[0] as R | undefined;
    const parts = relative('factory/queue', f).split(/[\\/]/);
    const station = STATION_OF_FOLDER[parts[0] ?? ''];
    const done = parts.includes('done');
    const id = (parts.at(-1) ?? f).replace(/\.jsonl?$/, '');
    const k = r?.['kind'];
    if (!r || !station || !isKind(k)) {
      unread.push(f);
      continue;
    }
    const m = (r['mutant'] ?? null) as R | null;
    const block = str(r['block']) ? r['block'] : '';
    const tagId = m ? `${block}-${String(m['id'])}` : str(r['tag']) ? r['tag'] : id;
    tasks.push({ id, tag: tagId, kind: k as Task['kind'], state: done ? 'accepted' : (['queued', 'in work', 'accepted', 'rejected', 'escalated', 'held'] as const).find((x) => x === r['state']) ?? 'queued', ...(str(r['model']) ? { model: r['model'] } : {}), ...(num(r['usd']) !== null ? { usd: num(r['usd'])! } : {}) });
    if (!tags.some((t) => t.id === tagId))
      tags.push({
        id: tagId,
        raisedBy: m ? 'metrology: calibration run' : str(r['raisedBy']) ? r['raisedBy'] : 'not recorded',
        station,
        where: m ? `intent/blocks/${block}/index.ts:${String(m['line'])}` : str(r['where']) ? r['where'] : '',
        what: m ? `${block}: ${String(m['mutator'])} survives (${String(m['original'])} → ${String(m['replacement'])})` : str(r['what']) ? r['what'] : id,
        evidence: m ? `intent/eval/mutation/${block}.json` : str(r['evidence']) ? r['evidence'] : '',
        proof: str(r['acceptance']) ? r['acceptance'] : str(r['proof']) ? r['proof'] : '',
        state: done ? 'fixed' : 'open',
        raisedAt: str(r['createdAt']) ? r['createdAt'] : '',
      });
  }

  for (const f of files('factory/shifts')) {
    const rs = records(f);
    const good = rs?.filter((r) => str((r as R)['id']) && str((r as R)['startedAt'])) as R[] | undefined;
    if (!rs || !good || good.length !== rs.length) {
      unread.push(f);
      continue;
    }
    for (const r of good) shifts.push({ id: r['id'] as string, startedAt: r['startedAt'] as string, endedAt: str(r['endedAt']) ? r['endedAt'] : null, budgetUSD: num(r['budgetUSD']) ?? 0, spentUSD: num(r['spentUSD']) ?? 0, fixed: Array.isArray(r['fixed']) ? (r['fixed'] as ShiftLog['fixed']) : [], escalated: Array.isArray(r['escalated']) ? (r['escalated'] as ShiftLog['escalated']) : [], raised: Array.isArray(r['raised']) ? (r['raised'] as string[]) : [] });
  }

  const runner = (() => {
    const r = records('factory/runner.json');
    return r && (r[0] as R)['live'] === true ? ('live' as const) : ('not live yet' as const);
  })();

  return { schema: 'zthr-night/1', tags, tasks, shifts, rulings, scores: [...latest.values()].sort((a, b) => a.block.localeCompare(b.block)), unread, runner };
}
