import type { Resource } from '../catalog/types.js';
import { BARRIER } from './taxonomy.js';
import { active, remindable, type BarrierBook } from './barriers.js';
import { packageFor } from './packages.js';
import { helpScore, type Record_ } from './feedback.js';

/**
 * From everything to a few signals (docs/flows/resource-guide.md). Each open, remindable barrier yields at most one
 * signal: the best next resource for it. Signals are ordered by urgency, then by what has a deadline, then by fit,
 * reach and record, and at most MAX are shown, so the guide never becomes another list of demands.
 */
export const MAX = 3;

export interface Signal {
  need: Resource['categories'][number];
  urgency: 'tonight' | 'soon' | 'someday';
  title: string;
  why: string;
  resource?: Resource;
  packageId?: string;
  /** The barrier has no current resource that serves this student; the gap is counted and 2-1-1 offered. */
  gap?: boolean;
}

export interface SignalInputs {
  book: BarrierBook;
  today: string;
  /** Resources that serve this student and are current, per need, in the navigator's order. */
  optionsFor: (need: Resource['categories'][number]) => Resource[];
  record: (resourceId: string) => Record_;
}

const URG = { tonight: 0, soon: 1, someday: 2 } as const;

function bestFor(o: SignalInputs, need: Resource['categories'][number]): Resource | undefined {
  const opts = o.optionsFor(need);
  if (!opts.length) return undefined;
  const pkg = packageFor(need);
  const order = (r: Resource) => {
    const i = pkg ? pkg.entries.indexOf(r.id) : -1;
    return i < 0 ? 99 : i;
  };
  const deadline = (r: Resource) => (r.availability?.some((f) => f.fact === 'applications-open') ? 0 : 1);
  return [...opts].sort((a, b) => deadline(a) - deadline(b) || order(a) - order(b) || helpScore(o.record(b.id)) - helpScore(o.record(a.id)))[0];
}

export function signals(o: SignalInputs): Signal[] {
  const out: Signal[] = [];
  for (const b of active(o.book)) {
    if (!remindable(b, o.today)) continue;
    const def = BARRIER[b.need];
    const r = bestFor(o, b.need);
    const pkg = packageFor(b.need);
    out.push(
      r
        ? { need: b.need, urgency: b.urgency, title: b.urgency === 'tonight' ? `Tonight: ${r.name}` : r.name, why: `For ${def?.label.toLowerCase() ?? b.need}: ${r.description}`, resource: r, packageId: pkg?.id }
        : { need: b.need, urgency: b.urgency, title: `${def?.label ?? b.need}: call 2-1-1`, why: 'I have no checked resource near you for this yet. 2-1-1 can help any time, and I have counted the gap.', gap: true },
    );
  }
  return out.sort((a, b) => URG[a.urgency] - URG[b.urgency]).slice(0, MAX);
}
